// In-process verification (this sandbox blocks localhost TCP, so no live HTTP test).
// Run: node test.js
const assert = require("assert");
const path = require("path");
const {
  localPlan, cheapestPack, findPrice, extractJson, PRICES,
  AIR_MODEL, AIR_VISION_MODEL, resolveDataPath, RECIPE_SOURCES, buildPlanSystemPrompt
} = require("./server.js");

// Normalize OS-native path separators to forward slashes so assertions are
// cross-platform (path.join yields backslashes on Windows).
const toSlashes = (p) => p.split(path.sep).join("/");

let n = 0;
const ok = (cond, msg) => { n++; assert(cond, msg); console.log(`ok ${n} - ${msg}`); };

ok(PRICES.zip === "85281", "prices scoped to 85281");
ok(PRICES.items.length >= 20, `price DB has ${PRICES.items.length} items`);
ok(Object.keys(PRICES.stores).length === 4, "4 stores");
ok(
  typeof resolveDataPath === "function" &&
    toSlashes(resolveDataPath("/var/task/netlify/functions", "/var/task", (candidate) => toSlashes(candidate) === "/var/task/data/prices.json")) === "/var/task/data/prices.json",
  "price data resolves from the Netlify task root"
);
ok(AIR_VISION_MODEL === "qwen3-vl-32b-instruct", "photo requests use the dedicated vision model");
ok(AIR_VISION_MODEL !== AIR_MODEL, "text and photo requests do not silently share a model");

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

// Fallback planner dinners must cite the demo catalog entry from the approved sources DB.
const demoSource = RECIPE_SOURCES.sources.find((s) => s.name === "FridgeFuse Demo Catalog");
ok(
  demoSource && [plan, swapped].every((p) => p.dinners.every((d) => d.source === demoSource.name && d.sourceUrl === demoSource.url)),
  "fallback dinners carry source/sourceUrl from the demo catalog entry"
);

ok(extractJson('```json\n{"a":1}\n```').a === 1, "fenced JSON parsed");
ok(extractJson('{"a":2}').a === 2, "raw JSON parsed");

// Approved recipe sources: the AI planner prompt is grounded to this DB.
ok(Array.isArray(RECIPE_SOURCES.sources) && RECIPE_SOURCES.sources.length >= 3, `approved sources DB has ${RECIPE_SOURCES.sources.length} sources`);
ok(RECIPE_SOURCES.sources.every((s) => s.name && /^https?:\/\//.test(s.url)), "every approved source has a name and URL");
const planPrompt = buildPlanSystemPrompt("(price context)");
ok(planPrompt.includes("ONLY") && planPrompt.includes("approved sources"), "plan prompt restricts recipes to approved sources");
ok(planPrompt.includes('"source"') && planPrompt.includes('"sourceUrl"'), "plan prompt requires source name/URL in dinner data");
ok(planPrompt.includes("adaptationNote") && planPrompt.includes("CLOSEST matching approved recipe"), "plan prompt falls back to closest approved recipe with an adaptation note");
ok(planPrompt.includes("NEVER invent a new recipe from scratch"), "plan prompt forbids inventing recipes");
for (const s of RECIPE_SOURCES.sources) {
  ok(planPrompt.includes(s.name) && planPrompt.includes(s.url), `plan prompt lists approved source: ${s.name}`);
}
ok(
  typeof resolveDataPath === "function" &&
    toSlashes(resolveDataPath("/var/task/netlify/functions", "/var/task", (candidate) => toSlashes(candidate) === "/var/task/data/recipe-sources.json", "recipe-sources.json")) === "/var/task/data/recipe-sources.json",
  "recipe sources resolve from the Netlify task root"
);

// Frontend files exist and wire up.
const fs = require("fs");
for (const f of ["public/index.html", "public/app.js", "public/styles.css", "data/prices.json", ".env.example"]) {
  ok(fs.existsSync(f), `${f} exists`);
}
const html = fs.readFileSync("public/index.html", "utf8");
ok(html.includes("app.js") && html.includes("api/plan") === false, "index.html loads app.js");
ok(fs.readFileSync("public/app.js", "utf8").includes("/api/plan"), "app.js calls /api/plan");

console.log(`\nALL ${n} CHECKS PASSED`);
