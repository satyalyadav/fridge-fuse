// In-process verification (this sandbox blocks localhost TCP, so no live HTTP test).
// Run: node test.js
const assert = require("assert");
const {
  localPlan, cheapestPack, findPrice, extractJson, PRICES,
  DEFAULT_AIR_MODEL, AIR_MODEL, AIR_VISION_MODEL, AIR_VISION_VERIFY_MODEL, resolveDataPath,
  handlePlanRequest, handleVisionRequest, normalizeVisionResult
} = require("./server.js");

let n = 0;
const ok = (cond, msg) => { n++; assert(cond, msg); console.log(`ok ${n} - ${msg}`); };

ok(PRICES.zip === "85281", "prices scoped to 85281");
ok(PRICES.items.length >= 20, `price DB has ${PRICES.items.length} items`);
ok(Object.keys(PRICES.stores).length === 4, "4 stores");
ok(
  typeof resolveDataPath === "function" &&
    resolveDataPath("/var/task/netlify/functions", "/var/task", (candidate) => candidate === "/var/task/data/prices.json") === "/var/task/data/prices.json",
  "price data resolves from the Netlify task root"
);
ok(AIR_VISION_MODEL === "qwen3-vl-32b-instruct", "photo requests use the dedicated vision model");
ok(DEFAULT_AIR_MODEL === "llama4-scout-17b", "tracked text-model default uses the verified fast model");
ok(AIR_VISION_MODEL !== AIR_MODEL, "text and photo requests do not silently share a model");
ok(AIR_VISION_VERIFY_MODEL === AIR_MODEL, "photo verification uses the tested fast multimodal model");

const eggs = cheapestPack("eggs");
ok(eggs && eggs.store === "aldi" && eggs.packPrice === 2.99, `cheapest eggs = aldi 2.99 (${JSON.stringify(eggs)})`);
ok(findPrice("EGGS").name === "eggs", "price lookup case-insensitive");
ok(findPrice("xyz-nope") === null, "unknown item returns null");

const plan = localPlan({ pantry: ["eggs", "rice", "onion"], dinners: 3, maxTimeMin: 30, equipment: ["stove", "microwave"], diet: "" });
ok(plan.dinners.length === 3, "3 dinners planned");
ok(plan.shoppingList.length > 0, "shopping list non-empty");
// No double-counting: each need appears once even if shared.
const names = plan.shoppingList.map((i) => i.item);
ok(new Set(names).size === names.length, "no duplicate list items");
ok(plan.shoppingList.every((i) => i.pack && i.packPrice > 0 && i.store && i.qty === 1), "full packages with price+store");
const sum = +plan.shoppingList.reduce((t, i) => t + i.packPrice * i.qty, 0).toFixed(2);
ok(Math.abs(sum - plan.totalCost) < 0.01, `total $${plan.totalCost} matches sum`);
// Shared-ingredient merging: tortillas/cheddar-heavy pantry should share packs.
const plan2 = localPlan({ pantry: ["tortillas", "cheddar", "salsa"], dinners: 3, maxTimeMin: 30, equipment: ["microwave", "stove"], diet: "" });
const shared = plan2.shoppingList.filter((i) => i.sharedBy.length > 1);
ok(shared.length >= 1, `shared packs merged (${shared.map((s) => s.item).join(", ")})`);

const veg = localPlan({ pantry: [], dinners: 2, maxTimeMin: 30, equipment: ["stove"], diet: "vegetarian" });
ok(veg.dinners.every((d) => !d.needs.includes("chicken breast")), "vegetarian filter respected");

const micro = localPlan({ pantry: [], dinners: 2, maxTimeMin: 10, equipment: ["microwave", "stove"], diet: "" });
ok(micro.dinners.length === 2 && micro.dinners.every((d) => d.timeMin <= 10), "time filter respected (max 10 min)");
ok(require("./server.js").RECIPES.some((r) => r.timeMin > 10), "bank contains slower recipes so the time test is meaningful");
ok(cheapestPack("spinach") && cheapestPack("spinach").packPrice > 0, "spinach is in the mock catalog");

const vegan = localPlan({ pantry: [], dinners: 2, maxTimeMin: 30, equipment: ["microwave"], diet: "vegan" });
ok(vegan.dinners.length === 2, "vegan microwave plan is non-empty");
ok(vegan.dinners.every((d) => !d.needs.concat(d.usesPantry || []).some((x) => ["eggs", "milk", "cheddar"].includes(x))), "vegan filter respected");

const dairyFree = localPlan({ pantry: [], dinners: 2, maxTimeMin: 30, equipment: ["microwave", "stove"], diet: "dairy-free" });
ok(dairyFree.dinners.every((d) => !d.needs.concat(d.usesPantry || []).some((x) => ["milk", "cheddar"].includes(x))), "dairy-free filter respected");

const glutenFree = localPlan({ pantry: [], dinners: 2, maxTimeMin: 30, equipment: ["microwave", "stove"], diet: "gluten-free" });
ok(glutenFree.dinners.every((d) => !d.needs.concat(d.usesPantry || []).some((x) => ["bread", "pasta", "tortillas"].includes(x))), "gluten-free filter respected");

ok(localPlan({ pantry: [], dinners: 2.5, maxTimeMin: 30, equipment: ["microwave", "stove"], diet: "" }).dinners.length >= 1, "fractional dinners do not crash");
ok(localPlan({ pantry: null, dinners: 2, maxTimeMin: 30, equipment: null, diet: "" }).dinners.length >= 0, "null pantry/equipment do not throw");

const dorm = localPlan({
  pantry: ["eggs", "spinach", "rice", "tortillas", "cheddar", "salsa"],
  useSoon: ["spinach", "eggs"],
  dinners: 3,
  budget: 18,
  maxTimeMin: 20,
  equipment: ["microwave"],
});
ok(dorm.dinners.length === 3 && dorm.dinners[0].usesPantry.includes("spinach"), "use-soon food is scheduled first");
ok(dorm.totalCost <= 18, "dorm plan stays under budget ($" + dorm.totalCost + ")");
ok(dorm.shoppingList.length === 2, "dorm plan minimizes unique package purchases");
ok(dorm.leftovers.length === dorm.shoppingList.length, "purchased-package leftovers are reported");

const swapped = localPlan({
  pantry: ["eggs", "spinach", "rice", "tortillas", "cheddar", "salsa"],
  dinners: 3,
  budget: 18,
  maxTimeMin: 20,
  equipment: ["microwave"],
  exclude: ["Spinach egg rice bowl"],
});
ok(swapped.dinners.every((d) => d.title !== "Spinach egg rice bowl"), "meal exclusion supports conversational swaps");

ok(extractJson('```json\n{"a":1}\n```').a === 1, "fenced JSON parsed");
ok(extractJson('{"a":2}').a === 2, "raw JSON parsed");

// Frontend files exist and wire up.
const fs = require("fs");
for (const f of ["public/index.html", "public/app.js", "public/styles.css", "data/prices.json", ".env.example"]) {
  ok(fs.existsSync(f), `${f} exists`);
}
const html = fs.readFileSync("public/index.html", "utf8");
ok(html.includes("app.js") && html.includes("api/plan") === false, "index.html loads app.js");
const appJs = fs.readFileSync("public/app.js", "utf8");
ok(appJs.includes("/api/plan"), "app.js calls /api/plan");
ok(!/catalogOnly\s*:\s*true/.test(appJs), "frontend planning requests do not bypass the text model");

function aiEnvelope(plan) {
  return {
    ok: true,
    data: { choices: [{ message: { content: JSON.stringify(plan) } }] }
  };
}

function callPlan(body, chat) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = { body };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode, payload });
      }
    };
    Promise.resolve(handlePlanRequest(req, res, { chat })).catch(reject);
  });
}

function callVision(body, chat) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = { body };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode, payload });
      }
    };
    Promise.resolve(handleVisionRequest(req, res, { chat })).catch(reject);
  });
}

const validAiPlan = {
  dinners: [{
    title: "AI spinach rice bowl",
    timeMin: 10,
    protein: 18,
    carbs: 45,
    fiber: 5,
    equip: ["microwave"],
    usesPantry: ["spinach", "rice", "eggs"],
    needs: ["soy sauce"],
    steps: ["Microwave the spinach, rice, and eggs until the eggs are fully set."]
  }],
  shoppingList: [],
  totalCost: 0,
  notes: ""
};

async function runRouteChecks() {
  const request = {
    pantry: ["spinach", "rice", "eggs"],
    useSoon: ["spinach"],
    budget: 18,
    dinners: 1,
    maxTimeMin: 20,
    equipment: ["microwave"],
    diet: "",
    request: "Use the spinach first",
    exclude: []
  };

  let liveCalls = 0;
  const live = await callPlan(request, async (messages, options) => {
    liveCalls++;
    assert(messages.some((message) => String(message.content).includes("Use the spinach first")));
    assert.strictEqual(options.maxTokens, 1800);
    return aiEnvelope(validAiPlan);
  });
  ok(live.statusCode === 200 && live.payload.ok && live.payload.model === AIR_MODEL, "plan route returns the configured text model response");
  ok(liveCalls === 1 && !live.payload.mock && !live.payload.fallback, "omitting catalogOnly calls the text model exactly once");
  ok(live.payload.shoppingList.length === 1 && live.payload.shoppingList[0].item === "soy sauce", "AI shopping needs are grounded against the price catalog");

  const catalog = await callPlan({ ...request, catalogOnly: true }, async () => {
    throw new Error("catalog-only request must not call the text model");
  });
  ok(catalog.payload.ok && catalog.payload.model === "grounded-catalog", "explicit catalogOnly requests still use the local planner");

  let repairCalls = 0;
  const repaired = await callPlan(request, async (messages) => {
    repairCalls++;
    if (repairCalls === 1) {
      return { ok: true, data: { choices: [{ message: { content: "not valid JSON" } }] } };
    }
    assert(messages.some((message) => String(message.content).includes("Use the spinach first")));
    return aiEnvelope(validAiPlan);
  });
  ok(repairCalls === 2 && repaired.payload.ok && repaired.payload.dinners[0].title === validAiPlan.dinners[0].title, "malformed AI output gets one successful repair attempt");
  ok(!repaired.payload.mock && !repaired.payload.fallback, "a repaired AI plan does not silently become a local plan");

  const failedRepair = await callPlan(request, async () => ({
    ok: true,
    data: { choices: [{ message: { content: "still not valid JSON" } }] }
  }));
  ok(failedRepair.payload.ok === false && !failedRepair.payload.dinners, "failed AI repair returns an error instead of a local plan");

  const classified = normalizeVisionResult({
    confirmed: [
      { name: "eggs", confidence: 0.98, fullyVisible: true, bbox: [0.1, 0.1, 0.3, 0.3], evidence: "whole carton and readable egg label" },
      { name: "milk", confidence: 0.7, fullyVisible: true, bbox: [0.1, 0.1, 0.4, 0.8] },
      { name: "yogurt", confidence: 0.99, fullyVisible: false, bbox: [0.5, 0.2, 0.9, 0.7] }
    ],
    uncertain: [
      { guess: "jar", confidence: 0.45, bbox: [0.2, 0.3, 0.5, 0.9], reason: "label is hidden" }
    ]
  });
  ok(classified.confirmed.length === 1 && classified.confirmed[0].name === "eggs", "vision only confirms fully visible items at high confidence");
  ok(classified.uncertain.map((item) => item.guess).sort().join(",") === "jar,milk,yogurt", "partial and low-confidence objects require user confirmation");
  ok(classified.uncertain.every((item) => item.bbox.length === 4), "uncertain vision items include crop coordinates");

  const unsafeBoxes = normalizeVisionResult({ confirmed: [
    { name: "invented jar", confidence: 0.99, fullyVisible: true, evidence: "looks like a jar" },
    { name: "cropped bottle", confidence: 0.99, fullyVisible: true, bbox: [0, 0.1, 0.2, 0.8], evidence: "bottle shape" },
    { name: "bottled beverage (green glass)", confidence: 0.99, fullyVisible: true, bbox: [0.2, 0.1, 0.4, 0.8], evidence: "whole green bottle" },
    { name: "bottled water", confidence: 0.99, fullyVisible: true, bbox: [0.3, 0.1, 0.5, 0.8], evidence: "green color and bottle shape" },
    { name: "green glass bottles", confidence: 0.99, fullyVisible: true, bbox: [0.3, 0.1, 0.6, 0.8], evidence: "whole green bottles" }
  ] });
  ok(unsafeBoxes.confirmed.length === 0 && unsafeBoxes.uncertain.length === 5, "missing, edge-cropped, and unsupported container contents can never auto-confirm");

  const scaledBox = normalizeVisionResult({ uncertain: [
    { guess: "carton", confidence: 0.6, bbox: [100, 200, 500, 800], reason: "label hidden" }
  ] });
  ok(scaledBox.uncertain[0].bbox.join(",") === "0.1,0.2,0.5,0.8", "common 0-to-1000 vision coordinates produce a useful crop");

  const compactVision = normalizeVisionResult({ items: [
    { n: "tomatoes", c: 0.98, v: true, b: [100, 100, 400, 400], why: "whole tomatoes clearly visible", alt: [] },
    { n: "green glass bottles", c: 0.99, v: true, b: [450, 100, 700, 800], why: "whole green bottles", alt: [] },
    { n: "carrots", c: 0.8, v: false, b: [0, 500, 250, 900], why: "partly outside frame", alt: ["sweet potato"] }
  ] });
  ok(compactVision.confirmed.map((item) => item.name).join(",") === "tomatoes", "compact vision output preserves safe automatic additions");
  ok(compactVision.uncertain.map((item) => item.guess).sort().join(",") === "carrots,green glass bottles", "compact vision output keeps generic and partial objects in review");

  let visionPrompt = "";
  let visionCalls = 0;
  const vision = await callVision({ imageDataUrl: "data:image/jpeg;base64,dGVzdA==" }, async (messages, options) => {
    visionCalls++;
    visionPrompt += ` ${messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join(" ")}`;
    assert.strictEqual(options.model, visionCalls === 1 ? AIR_VISION_MODEL : AIR_VISION_VERIFY_MODEL);
    if (visionCalls === 1) return aiEnvelope({
      confirmed: [
        { name: "banana", confidence: 0.97, fullyVisible: true, bbox: [0.1, 0.2, 0.3, 0.8], evidence: "whole yellow banana" },
        { name: "milk", confidence: 0.98, fullyVisible: true, bbox: [0.4, 0.1, 0.7, 0.8], evidence: "carton" }
      ],
      uncertain: [{ guess: "apple", confidence: 0.6, bbox: [0.7, 0.2, 0.9, 0.6], reason: "partly hidden" }]
    });
    return aiEnvelope({ verified: [
      { name: "banana", confirmed: true, confidence: 0.98, fullyVisible: true, evidence: "outline is complete and fruit is unmistakable" },
      { name: "milk", confirmed: false, confidence: 0.5, fullyVisible: false, reason: "label is not readable" }
    ] });
  });
  ok(visionCalls === 2, "vision route independently verifies proposed automatic additions");
  ok(vision.payload.ok && vision.payload.confirmed.map((item) => item.name).join(",") === "banana" && vision.payload.uncertain.map((item) => item.guess).sort().join(",") === "apple,milk", "failed verification becomes user review instead of an automatic addition");
  ok(/partially visible/i.test(visionPrompt) && /uncertain/i.test(visionPrompt), "vision prompt sends partial objects to user review instead of guessing");

  const updatedHtml = fs.readFileSync("public/index.html", "utf8");
  const updatedAppJs = fs.readFileSync("public/app.js", "utf8");
  ok(updatedHtml.includes("visionReviewList") && updatedAppJs.includes("data-vision-action"), "frontend includes an uncertain-item confirmation interface");
  ok(/MAX_VISION_IMAGE_EDGE\s*=\s*1024/.test(updatedAppJs) && /resizeImageForVision\(file\)/.test(updatedAppJs), "frontend caps large vision uploads at the tested 1024-pixel edge");

  console.log(`\nALL ${n} CHECKS PASSED`);
}

runRouteChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
