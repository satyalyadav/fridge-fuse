// In-process verification (this sandbox blocks localhost TCP, so no live HTTP test).
// Run: node test.js
const assert = require("assert");
const {
  localPlan, cheapestPack, findPrice, extractJson, PRICES,
  DEFAULT_AIR_MODEL, AIR_MODEL, AIR_VISION_MODEL, AIR_VISION_VERIFY_MODEL, resolveDataPath,
  handlePlanRequest, handleVisionRequest, normalizeVisionResult, handleGeoPostal,
  haversineMiles, isValidCoordinate, resolveCatalogItem, optimizeCart,
  describeLocation, handleGeoDescribe,
  STORE_DATA, BRANCHES, DEFAULT_ORIGIN, ITEM_ALIASES
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
const photoInputTag = html.match(/<input[^>]*id="photoInput"[^>]*>/)?.[0] || "";
ok(
  photoInputTag.includes('accept="image/*"') && !photoInputTag.includes("capture"),
  "photo input lets the mobile OS offer camera, gallery, and file sources"
);
ok(
  appJs.includes('$("photoButton").addEventListener("click", () => $("photoInput").click())') &&
    appJs.includes('$("drawerPhotoButton").addEventListener("click", () => $("photoInput").click())'),
  "chat and pantry photo buttons open the native image picker directly"
);

// ---------- grocery optimizer ----------
ok(fs.existsSync("data/stores.json"), "data/stores.json exists");
ok(
  resolveDataPath("/var/task/netlify/functions", "/var/task", (c) => c === "/var/task/data/stores.json", "stores.json") === "/var/task/data/stores.json",
  "store data resolves from the Netlify task root"
);
ok(fs.readFileSync("netlify.toml", "utf8").includes("data/stores.json"), "netlify bundles the store data with the function");
// geolocation=() silently disables the browser location API — the Shop tab needs it.
ok(/geolocation=\(self\)/.test(fs.readFileSync("server.js", "utf8")), "server Permissions-Policy allows geolocation");
ok(/geolocation=\(self\)/.test(fs.readFileSync("netlify.toml", "utf8")), "netlify Permissions-Policy allows geolocation");

ok(BRANCHES.length >= 4, `store catalog has ${BRANCHES.length} branches`);
ok(BRANCHES.every((b) => PRICES.stores[b.chain]), "every branch maps to a chain with prices");
ok(new Set(BRANCHES.map((b) => b.id)).size === BRANCHES.length, "branch ids are unique");
ok(BRANCHES.every((b) => Math.abs(b.lat) <= 90 && Math.abs(b.lng) <= 180), "branch coordinates are in range");
ok(new Set(BRANCHES.map((b) => b.chain)).size === Object.keys(PRICES.stores).length, "every priced chain has at least one branch");
ok(Object.values(ITEM_ALIASES).every((target) => PRICES.items.some((i) => i.name === target)), "every alias points at a real catalog item");

// 1 degree of latitude is ~69 miles anywhere on the globe.
ok(Math.abs(haversineMiles(33, -111, 34, -111) - 69) < 0.5, `haversine 1deg lat = ${haversineMiles(33, -111, 34, -111).toFixed(2)} mi`);
ok(haversineMiles(33.42, -111.93, 33.42, -111.93) === 0, "distance to the same point is zero");
ok(haversineMiles(33, -111, 34, -111) === haversineMiles(34, -111, 33, -111), "distance is symmetric");
ok(!isValidCoordinate(0, 0) && !isValidCoordinate(NaN, 5) && !isValidCoordinate(91, 0), "null island and out-of-range coordinates are rejected");
ok(isValidCoordinate(33.42, -111.93), "a real coordinate is accepted");

ok(resolveCatalogItem("cheese").name === "cheddar", "alias resolves cheese to cheddar");
ok(resolveCatalogItem("  EGGS  ").name === "eggs", "lookup trims and ignores case");
ok(resolveCatalogItem("unobtainium") === null, "unknown item does not resolve");

const campus = { lat: 33.4242, lng: -111.9281 };
const basket = optimizeCart({ items: [{ name: "eggs", qty: 2 }, { name: "milk" }, { name: "cheese" }], ...campus });
ok(basket.options.length === BRANCHES.length, "every branch is priced");
ok(basket.options[0].best === true, "the winner is flagged");
ok(basket.options.every((o, i, all) => i === 0 || all[i - 1].subtotal <= o.subtotal), "options are ranked cheapest first");
// aldi: eggs 2.99*2 + milk 3.49 + cheddar 2.29
ok(basket.options[0].chain === "aldi" && basket.options[0].subtotal === 11.76, `cheapest basket is aldi at $${basket.options[0].subtotal}`);
ok(basket.options[0].distanceMi <= basket.options.find((o) => o.chain === "aldi" && o.storeId !== basket.options[0].storeId).distanceMi, "the nearer branch of the winning chain ranks first");
ok(basket.savingsVsWorst > 0, `savings vs the priciest store reported ($${basket.savingsVsWorst})`);
ok(basket.options.every((o) => o.complete), "all four chains stock the sample basket");
ok(basket.requested.every((r) => r.prices === undefined), "internal price tables are not leaked to the client");

const qtyOne = optimizeCart({ items: [{ name: "eggs", qty: 1 }], ...campus }).options[0].subtotal;
const qtyThree = optimizeCart({ items: [{ name: "eggs", qty: 3 }], ...campus }).options[0].subtotal;
ok(Math.abs(qtyThree - qtyOne * 3) < 0.01, "quantity multiplies the line total");
ok(optimizeCart({ items: ["eggs", { name: "egg", qty: 3 }, "EGGS"] }).requested.length === 1, "duplicate and aliased entries merge into one line");
ok(optimizeCart({ items: ["eggs", { name: "egg", qty: 3 }] }).requested[0].qty === 4, "merged duplicates sum their quantities");

const withJunk = optimizeCart({ items: ["eggs", "unobtainium"], ...campus });
ok(withJunk.unmatched.length === 1 && withJunk.options[0].lineItems.length === 1, "unmatched items are reported, never silently priced");
ok(/not in the catalog/i.test(withJunk.note), "the note names the unpriced items");

const nothing = optimizeCart({ items: ["unobtainium"] });
ok(nothing.options.length === 0, "an unpriceable list returns no stores instead of $0 ones");

const noFix = optimizeCart({ items: ["eggs"] });
ok(noFix.usedFallbackLocation && noFix.origin.lat === DEFAULT_ORIGIN.lat, "missing coordinates fall back to campus");
ok(!optimizeCart({ items: ["eggs"], ...campus }).usedFallbackLocation, "a real fix is used as-is");
ok(optimizeCart({ items: ["eggs"], lat: "abc", lng: null }).options.length > 0, "junk coordinates do not throw");
ok(optimizeCart({ items: [{ name: "eggs", qty: -5 }] }).requested[0].qty === 1, "negative quantity clamps to 1");
ok(optimizeCart({ items: [{ name: "eggs", qty: 1e9 }] }).requested[0].qty === 99, "absurd quantity is capped");
ok(optimizeCart({ items: [null, undefined, "", {}, { name: "eggs" }] }).requested.length === 1, "malformed entries are skipped");
ok(optimizeCart({ items: Array(80).fill("eggs") }).requested[0].qty === 50, "oversized lists are capped at 50 entries");
ok(optimizeCart().options.length === 0 && optimizeCart({ items: "nope" }).options.length === 0, "no-argument and non-array calls do not throw");

const tight = optimizeCart({ items: ["eggs"], ...campus, maxDistanceMi: 0.01 });
ok(tight.widenedSearch && tight.options.length > 0, "an over-tight radius widens instead of returning nothing");
const near = optimizeCart({ items: ["eggs"], ...campus, maxDistanceMi: 2 });
ok(near.options.length < BRANCHES.length && near.options.every((o) => o.distanceMi <= 2), "the distance filter excludes far branches");

// ---------- location description + third-party consent ----------
// The wording is derived from stores.json, never a hardcoded place string.
const onCampus = describeLocation(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng);
ok(onCampus.text === `At ${DEFAULT_ORIGIN.label}` && onCampus.distanceMi === 0, "a fix on the origin is described as being there");
const nearBranch = describeLocation(BRANCHES[1].lat, BRANCHES[1].lng);
ok(nearBranch.nearest === (BRANCHES[1].area || BRANCHES[1].name), "the nearest reference point comes from the store data");
ok(describeLocation(33.43, -111.95).text.includes("mi from"), "a fix between references is described by measured distance");
ok(/2\d{3} mi from/.test(describeLocation(40.7128, -74.006).text), "a far fix falls back to distance from the origin");
ok(describeLocation(NaN, 5) === null && describeLocation(0, 0) === null, "invalid coordinates produce no description");
// Every label the user can see must exist in the data file, not in the code.
const serverSrc = fs.readFileSync("server.js", "utf8");
const labels = [DEFAULT_ORIGIN.label, ...BRANCHES.map((b) => b.area)];
ok(labels.every((label) => !serverSrc.includes(`"${label}"`)), "no place label is hardcoded in server.js");

async function callGeo(body, geocode) {
  let payload = null;
  let status = 200;
  const res = {
    status(code) { status = code; return this; },
    json(value) { payload = value; return this; },
  };
  await handleGeoDescribe({ body }, res, geocode ? { geocode } : undefined);
  return { status, payload };
}

// Consent gating is the security-relevant part, so it gets its own checks.
async function runGeoConsentChecks() {
  let geocodeCalls = 0;
  const fakeGeocode = async () => { geocodeCalls++; return { ok: true, placeName: "Tempe, Arizona" }; };
  const at = { lat: 33.4242, lng: -111.9281 };

  const noConsent = await callGeo({ ...at }, fakeGeocode);
  ok(noConsent.payload.lookupUsed === false && geocodeCalls === 0, "without consent no coordinates are sent to the third party");
  ok(noConsent.payload.local.text.length > 0, "the local description is returned even without consent");

  for (const value of [false, "true", 1, null, undefined]) {
    await callGeo({ ...at, allowLookup: value }, fakeGeocode);
  }
  ok(geocodeCalls === 0, "only a literal true unlocks the lookup (truthy values do not)");

  const consented = await callGeo({ ...at, allowLookup: true }, fakeGeocode);
  ok(geocodeCalls === 1 && consented.payload.placeName === "Tempe, Arizona", "explicit consent performs the lookup");

  const lookupFailed = await callGeo({ ...at, allowLookup: true }, async () => ({ ok: false, failure: { message: "down" } }));
  ok(lookupFailed.payload.ok && lookupFailed.payload.placeName === null && lookupFailed.payload.local.text, "a failed lookup still returns the local description");

  ok((await callGeo({ lat: 999, lng: "x" }, fakeGeocode)).status === 400, "invalid coordinates are rejected with 400");
}

// The profile's saved ZIP is the non-geolocation way into the Shop tab.
async function runPostalCodeChecks() {
  async function callPostal(body, geocode) {
    let payload = null;
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(value) { payload = value; return this; },
    };
    await handleGeoPostal({ body }, res, geocode ? { geocode } : undefined);
    return { status, payload };
  }

  let postalCalls = 0;
  const fakePostal = async (zip) => {
    postalCalls++;
    return { ok: true, lat: 41.88, lng: -87.63, label: `ZIP ${zip}`, source: "nominatim", lookupUsed: true };
  };

  // The catalog's own ZIP must resolve with no third-party call at all.
  const local = await callPostal({ postalCode: STORE_DATA.zip }, fakePostal);
  ok(local.payload.resolved && local.payload.lat === DEFAULT_ORIGIN.lat, "the catalog ZIP resolves to the store-data origin");
  ok(postalCalls === 0, "the catalog ZIP never triggers a third-party lookup");
  ok(local.payload.source === "local-store-data" && local.payload.lookupUsed === false, "the catalog ZIP reports itself as locally resolved");

  const foreignNoConsent = await callPostal({ postalCode: "60601" }, fakePostal);
  ok(foreignNoConsent.payload.needsConsent === true && postalCalls === 0, "a ZIP outside the catalog asks for consent before any lookup");
  ok(foreignNoConsent.payload.resolved === false, "an unconsented ZIP is not silently resolved");

  for (const value of [false, "true", 1, null]) {
    await callPostal({ postalCode: "60601", allowLookup: value }, fakePostal);
  }
  ok(postalCalls === 0, "only a literal true unlocks the ZIP lookup");

  const consented = await callPostal({ postalCode: "60601", allowLookup: true }, fakePostal);
  ok(postalCalls === 1 && consented.payload.resolved === true, "explicit consent resolves a ZIP outside the catalog");

  for (const bad of ["", "abc", "1234", "123456", "8528a", null, undefined]) {
    ok((await callPostal({ postalCode: bad }, fakePostal)).status === 400, `malformed ZIP ${JSON.stringify(bad)} is rejected with 400`);
  }

  const failed = await callPostal({ postalCode: "60601", allowLookup: true }, async () => ({ ok: false, failure: { message: "down" } }));
  ok(failed.payload.ok === false && failed.payload.resolved === false, "a failed ZIP lookup reports rather than inventing a location");

  ok(/useProfileZipButton/.test(appJs) && html.includes('id="useProfileZipButton"'), "the Shop tab exposes the saved ZIP as a location source");
  ok(/allowLookup:\s*state\.allowPlaceLookup === true/.test(appJs), "the client never asserts consent it does not have");
}

ok(/allowPlaceLookup:\s*null/.test(appJs), "the client defaults to never sending coordinates");
ok(html.includes('id="lookupConsent"'), "the consent disclaimer exists in the markup");
ok(/nominatim/i.test(serverSrc) && !/nominatim/i.test(appJs), "the third-party call is proxied by the server, not the browser");

// app.js wires listeners at module scope, so one missing id throws on load and
// takes the whole page with it. thinkingMessage is created at runtime.
const RUNTIME_IDS = new Set(["thinkingMessage"]);
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const missingIds = [...new Set([...appJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))]
  .filter((id) => !htmlIds.has(id) && !RUNTIME_IDS.has(id));
ok(missingIds.length === 0, `every element app.js touches exists in the HTML${missingIds.length ? ` (missing: ${missingIds.join(", ")})` : ""}`);

ok(html.includes('id="groceryView"'), "index.html has the grocery panel");
ok(html.includes('data-view="grocery"'), "index.html has the grocery nav entry");
ok(appJs.includes("/api/grocery/optimize"), "app.js calls the optimizer");
ok(appJs.includes("navigator.geolocation"), "app.js asks the browser for a location");
ok(fs.readFileSync("public/styles.css", "utf8").includes("repeat(4, 1fr)"), "mobile nav has room for the fourth tab");

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

  await runGeoConsentChecks();
  await runPostalCodeChecks();

  console.log(`\nALL ${n} CHECKS PASSED`);
}

runRouteChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
