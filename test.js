// In-process verification (this sandbox blocks localhost TCP, so no live HTTP test).
// Run: node test.js
const assert = require("assert");
const path = require("path");
const vm = require("vm");
const {
  cheapestPack, findPrice, extractJson, PRICES,
  DEFAULT_AIR_MODEL, AIR_MODEL, AIR_VISION_MODEL, AIR_VISION_VERIFY_MODEL,
  resolveDataPath, RECIPE_SOURCES, APPROVED_RECIPES, isApprovedRecipeCitation, buildPlanSystemPrompt,
  handlePlanRequest, handleVisionRequest, normalizeVisionResult, handleGeoPostal,
  haversineMiles, isValidCoordinate, resolveCatalogItem, optimizeCart,
  describeLocation, handleGeoDescribe,
  STORE_DATA, BRANCHES, DEFAULT_ORIGIN, ITEM_ALIASES,
  DIET_RULES, resolveDietRules, findForbiddenTerm, findDietViolations,
  pantryDietConflicts, dietRulesContext, catalogTagsFor, findIngredientConflict,
  DIET_OPTIONS, EQUIPMENT_OPTIONS, parseDietSelections, blockedIngredientsForDiet,
  unitInfo, toBaseAmount, packSizeOf, normalizeRequirement, groundShoppingPlan
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
ok(DEFAULT_AIR_MODEL === "llama4-scout-17b", "tracked text-model default uses the verified fast model");
ok(AIR_VISION_MODEL !== AIR_MODEL, "text and photo requests do not silently share a model");
ok(AIR_VISION_VERIFY_MODEL === AIR_MODEL, "photo verification uses the tested fast multimodal model");

const eggs = cheapestPack("eggs");
ok(eggs && eggs.store === "aldi" && eggs.packPrice === 2.99, `cheapest eggs = aldi 2.99 (${JSON.stringify(eggs)})`);
ok(findPrice("EGGS").name === "eggs", "price lookup case-insensitive");
ok(findPrice("xyz-nope") === null, "unknown item returns null");
ok(cheapestPack("spinach") && cheapestPack("spinach").packPrice > 0, "spinach is in the mock catalog");

ok(extractJson('```json\n{"a":1}\n```').a === 1, "fenced JSON parsed");
ok(extractJson('{"a":2}').a === 2, "raw JSON parsed");

// Approved recipes: the AI planner prompt is grounded to exact recipe pages.
ok(Array.isArray(RECIPE_SOURCES.sources) && RECIPE_SOURCES.sources.length >= 3, `approved sources DB has ${RECIPE_SOURCES.sources.length} sources`);
ok(RECIPE_SOURCES.sources.every((s) => s.name && /^https?:\/\//.test(s.url)), "every approved source has a name and URL");
ok(Array.isArray(APPROVED_RECIPES) && APPROVED_RECIPES.length >= 10, `approved recipe DB has ${APPROVED_RECIPES.length} exact recipes`);
ok(
  APPROVED_RECIPES.every((recipe) =>
    recipe.title && /^https?:\/\//.test(recipe.url) && Number(recipe.timeMin) > 0 &&
    recipe.equipment.length && recipe.ingredients.length && recipe.method
  ),
  "every approved recipe has an exact title, page URL, and verified facts"
);
const priceIngredientNames = new Set(PRICES.items.map((item) => item.name));
ok(
  APPROVED_RECIPES.every((recipe) => recipe.ingredients.every((ingredient) => priceIngredientNames.has(ingredient))),
  "every curated recipe ingredient can be fulfilled by the price catalog"
);
ok(new Set(APPROVED_RECIPES.map((recipe) => recipe.url)).size === APPROVED_RECIPES.length, "approved recipe page URLs are unique");
ok(
  APPROVED_RECIPES.every((recipe) => !RECIPE_SOURCES.sources.some((source) => recipe.url.replace(/\/$/, "") === source.url.replace(/\/$/, ""))),
  "publisher homepages are not accepted as recipe pages"
);
const planPrompt = buildPlanSystemPrompt("(price context)");
ok(planPrompt.includes("NEVER") && planPrompt.includes("curated recipe records"), "plan prompt restricts generation to curated recipes");
ok(planPrompt.includes('"sourceRecipe"') && planPrompt.includes('"source"') && planPrompt.includes('"sourceUrl"'), "plan prompt requires the exact recipe citation triple");
ok(!planPrompt.includes('"leftovers":[{'), "plan prompt no longer asks the model to estimate leftovers");
ok(/Do NOT return shoppingList, leftovers, or totalCost/.test(planPrompt), "plan prompt tells the model the server does the package arithmetic");
ok(planPrompt.includes('{"item","amount","unit"}') && /how much that dinner actually uses/.test(planPrompt), "plan prompt asks for a quantity per ingredient, not a package");
ok(/Never answer a weight item in cups/.test(planPrompt), "plan prompt pins each amount to the catalog's unit family");
ok(planPrompt.includes("adaptationNote") && planPrompt.includes("choose the closest record"), "plan prompt chooses the closest curated recipe with an adaptation note");
ok(planPrompt.includes("NEVER invent a source recipe"), "plan prompt forbids invented recipe citations");
for (const recipe of APPROVED_RECIPES) {
  ok(
    planPrompt.includes(recipe.title) && planPrompt.includes(recipe.source) && planPrompt.includes(recipe.url) && planPrompt.includes(recipe.method),
    `plan prompt includes verified recipe facts: ${recipe.source} / ${recipe.title}`
  );
}
ok(!isApprovedRecipeCitation("Budget Bytes", "Invented Recipe", "https://www.budgetbytes.com"), "a publisher homepage cannot validate an invented recipe");
ok(
  typeof resolveDataPath === "function" &&
    toSlashes(resolveDataPath("/var/task/netlify/functions", "/var/task", (candidate) => toSlashes(candidate) === "/var/task/data/recipe-sources.json", "recipe-sources.json")) === "/var/task/data/recipe-sources.json",
  "recipe sources resolve from the Netlify task root"
);

// ---------- recipes as typed requirements: quantities, packages, leftovers ----------
const unsized = PRICES.items.filter((item) => !packSizeOf(item)).map((item) => item.name);
ok(unsized.length === 0, `every catalog item has a usable pack size${unsized.length ? ` (missing: ${unsized.join(", ")})` : ""}`);
ok(toBaseAmount(1, "lb").base === 16 && toBaseAmount(1, "dozen").base === 12 && toBaseAmount(1, "cup").base === 8, "units convert to their family base");
ok(toBaseAmount(2, "tbsp").family === "volume" && toBaseAmount(2, "oz").family === "mass" && toBaseAmount(2, "each").family === "count", "units are grouped into count, mass, and volume");
ok(unitInfo("nonsense") === null, "an unknown unit is rejected rather than assumed");

// A quantity we cannot read falls back to one whole package and says so; only
// an ingredient the catalog cannot price is fatal, because pricing it would
// mean inventing a price.
const cupOfRice = normalizeRequirement({ item: "rice", amount: 1, unit: "cup" });
ok(cupOfRice.assumed && cupOfRice.base === packSizeOf(findPrice("rice")).base, "a volume amount for a weight item buys one package instead of guessing a density");
ok(normalizeRequirement({ item: "eggs", amount: 0, unit: "each" }).assumed, "a need with no positive amount falls back to one package");
ok(normalizeRequirement("eggs").assumed, "a bare ingredient name falls back to one package");
ok(normalizeRequirement({ item: "eggs", amount: 3, unit: "each" }).assumed === false, "a well-formed quantity is used as given");
assert.throws(() => normalizeRequirement({ item: "unobtainium", amount: 1, unit: "each" }), /outside the price catalog/);
n++; console.log(`ok ${n} - an ingredient the catalog cannot price is still fatal`);
ok(normalizeRequirement({ item: "EGGS", amount: 2, unit: "Each" }).base === 2, "requirements are case-insensitive in both name and unit");
ok(normalizeRequirement({ item: "chicken breast", amount: 8, unit: "oz" }).base === 8, "a weight amount stays in ounces");

// Packages are indivisible: this is the arithmetic the model used to guess.
const twoDinners = groundShoppingPlan({
  dinners: [
    { title: "A", needs: [{ item: "eggs", amount: 3, unit: "each" }, { item: "spinach", amount: 2, unit: "oz" }] },
    { title: "B", needs: [{ item: "eggs", amount: 11, unit: "each" }] }
  ]
});
const eggLine = twoDinners.shoppingList.find((entry) => entry.item === "eggs");
ok(eggLine.qty === 2, `14 eggs buys 2 dozen, not 1 (qty=${eggLine.qty})`);
ok(eggLine.sharedBy.length === 2, "demand is summed across every dinner that uses the ingredient");
ok(twoDinners.totalCost === +(eggLine.packPrice * 2 + cheapestPack("spinach").packPrice).toFixed(2), "the total pays for every package bought, not one of each");
const eggLeftover = twoDinners.leftovers.find((entry) => entry.item === "eggs");
ok(eggLeftover.remaining === 10, `leftovers are computed: 2 dozen minus 14 leaves ${eggLeftover.remaining}`);
ok(twoDinners.leftovers.find((entry) => entry.item === "spinach").remaining === 3, "a partly used package reports the remainder in its own unit");

const exact = groundShoppingPlan({ dinners: [{ title: "A", needs: [{ item: "eggs", amount: 12, unit: "each" }] }] });
ok(exact.shoppingList[0].qty === 1 && exact.leftovers.length === 0, "a plan that uses a package exactly reports no leftovers");
const lbs = groundShoppingPlan({ dinners: [{ title: "A", needs: [{ item: "chicken breast", amount: 20, unit: "oz" }] }] });
ok(lbs.shoppingList[0].qty === 2, "a weight requirement crossing a pack boundary buys two packs");

// ---------- gluten-free catalog + diet tags ----------
const untagged = PRICES.items.filter((item) => !Array.isArray(item.tags)).map((item) => item.name);
ok(untagged.length === 0, `every catalog item declares a tags array${untagged.length ? ` (missing: ${untagged.join(", ")})` : ""}`);
for (const glutenFree of ["gluten free bread", "gluten free pasta", "corn tortillas", "tamari"]) {
  const pack = cheapestPack(glutenFree);
  ok(pack && pack.item === glutenFree && pack.packPrice > 0, `catalog prices ${glutenFree} (${pack ? `$${pack.packPrice} @ ${pack.store}` : "missing"})`);
}
// The reason the lookup had to change: "gluten free pasta" contains "pasta", and
// pricing a celiac's dinner as wheat pasta is the one outcome to rule out.
ok(findPrice("gluten free pasta").name === "gluten free pasta", "a gluten-free item never resolves to its wheat namesake");
ok(findPrice("corn tortillas").name === "corn tortillas" && findPrice("tortillas").name === "tortillas", "corn and flour tortillas stay distinct");
ok(findPrice("pasta").name === "pasta" && findPrice("bread").name === "bread", "the plain catalog names still resolve to themselves");
ok(findPrice("gf pasta").name === "gluten free pasta" && findPrice("gluten-free soy sauce").name === "tamari", "gluten-free aliases resolve to the substitute, not the original");
ok(cheapestPack("tamari").store === "traderjoes", "a chain that does not stock an item is skipped rather than guessed at");

ok(catalogTagsFor("pasta").includes("gluten") && catalogTagsFor("gluten free pasta").length === 0, "catalog tags separate wheat pasta from its substitute");
ok(catalogTagsFor("cheese").includes("dairy"), "an alias inherits the catalog item's tags");
ok(catalogTagsFor("a splash of almond milk") === null, "prose does not resolve to a catalog item");

// ---------- dietary restrictions (enforced server-side, not just prompted) ----------
ok(Array.isArray(DIET_RULES) && DIET_RULES.length >= 5, `diet rules DB has ${DIET_RULES.length} rules`);
ok(
  DIET_RULES.every((rule) => rule.id && rule.label && rule.aliases.length && rule.forbids.length),
  "every diet rule has an id, label, aliases, and forbidden ingredients"
);
const dietIds = DIET_RULES.map((rule) => rule.id);
for (const required of DIET_OPTIONS.map((option) => option.id)) {
  ok(dietIds.includes(required), `every profile option is an enforceable rule: ${required}`);
}
ok(dietIds.length === DIET_OPTIONS.length, "the profile catalog and the enforcement rules are the same list");
ok(resolveDietRules("peanut allergy").map((r) => r.id).join(",") === "peanut allergy", "a peanut allergy resolves to the peanut rule");
ok(resolveDietRules("vegan, no peanuts").map((r) => r.id).sort().join(",") === "peanut allergy,vegan", "a combined diet string resolves to every matching rule");
ok(resolveDietRules("").length === 0 && resolveDietRules("   ").length === 0, "an empty diet string enforces nothing");

const veganRule = DIET_RULES.find((rule) => rule.id === "vegan");
const dairyRule = DIET_RULES.find((rule) => rule.id === "dairy-free");
const glutenRule = DIET_RULES.find((rule) => rule.id === "gluten-free");
const peanutRule = DIET_RULES.find((rule) => rule.id === "peanut allergy");
ok(findForbiddenTerm("Brush the pan with butter", dairyRule) === "butter", "a forbidden ingredient hidden in a cooking step is caught");
ok(findForbiddenTerm("eggs", veganRule) === "egg", "plural catalog names match their singular forbidden term");
ok(findForbiddenTerm("chicken breast", veganRule) && findForbiddenTerm("cheddar", veganRule), "vegan plans reject meat and dairy from the catalog");
ok(findForbiddenTerm("soy sauce", glutenRule) === "soy sauce" && findForbiddenTerm("tortillas", glutenRule), "gluten-free rejects the catalog's wheat items");
ok(findForbiddenTerm("peanut butter", peanutRule), "the peanut rule catches peanut butter");
ok(findForbiddenTerm("peanut butter", dairyRule) === null, "peanut butter does not trip the dairy-free rule's butter");
ok(findForbiddenTerm("almond milk", veganRule) === null && findForbiddenTerm("coconut milk", dairyRule) === null, "plant milks do not trip the milk rules");
ok(findForbiddenTerm("eggplant curry", veganRule) === null, "word-boundary matching does not read eggplant as egg");
ok(findForbiddenTerm("corn tortillas", glutenRule) === null && findForbiddenTerm("gluten free pasta", glutenRule) === null, "gluten-free substitutes are not flagged as gluten");
ok(findForbiddenTerm("almond butter", peanutRule) === null, "a non-peanut nut butter is allowed under the peanut rule");
ok(findForbiddenTerm("spinach rice bowl", veganRule) === null, "a compliant dinner passes cleanly");

ok(
  pantryDietConflicts(["spinach", "cheddar", "rice"], [veganRule]).join(",") === "cheddar",
  "pantry conflicts are identified without discarding the rest of the pantry"
);
ok(pantryDietConflicts(["spinach", "cheddar"], []).length === 0, "no restrictions means no pantry conflicts");

const dietPrompt = buildPlanSystemPrompt("(price context)", dietRulesContext([veganRule, peanutRule]));
ok(dietPrompt.includes("Dietary restrictions (STRICT"), "the plan prompt states the restrictions as strict");
ok(dietPrompt.includes("peanut") && dietPrompt.includes("honey"), "the plan prompt lists the forbidden ingredients");
ok(/pantry/i.test(dietPrompt) && dietPrompt.includes("stays forbidden"), "the plan prompt forbids cooking a restricted pantry item");
ok(!buildPlanSystemPrompt("(price context)").includes("Dietary restrictions"), "an unrestricted plan prompt carries no diet section");

// The catalog's tags and the word net must agree about every item the catalog
// knows — a disagreement means a mis-tagged item or a missing allows phrase.
const tagDisagreements = [];
for (const item of PRICES.items) {
  for (const rule of DIET_RULES) {
    const byTag = (item.tags || []).some((tag) => rule.excludesTags.includes(tag));
    const byWord = findForbiddenTerm(item.name, rule) !== null;
    if (byTag !== byWord) tagDisagreements.push(`${item.name}/${rule.label} (tag:${byTag} word:${byWord})`);
  }
}
ok(
  tagDisagreements.length === 0,
  `catalog tags and word matching agree on all ${PRICES.items.length} items${tagDisagreements.length ? ` — ${tagDisagreements.join(", ")}` : ""}`
);
ok(findIngredientConflict("gf pasta", glutenRule) === null, "a known-safe alias is not failed for containing a forbidden word");
ok(/gluten/.test(findIngredientConflict("pasta", glutenRule) || ""), "a known ingredient is rejected by its tag, naming the tag");
ok(findIngredientConflict("unobtainium chicken", veganRule) === "chicken", "an ingredient the catalog does not know still falls to the word net");
ok(DIET_RULES.every((rule) => rule.excludesTags.length > 0), "every diet rule excludes at least one catalog tag");

const violatingPlanShape = {
  dinners: [{ title: "Cheesy rice", usesPantry: ["rice"], needs: [{ item: "cheddar", amount: 4, unit: "oz" }], steps: ["Melt the cheddar."] }],
  shoppingList: [{ item: "cheddar" }],
  leftovers: [{ item: "cheddar", amount: "half" }]
};
const shapeViolations = findDietViolations(violatingPlanShape, [veganRule]);
ok(shapeViolations.length >= 4, `violations are found in every plan field (${shapeViolations.length} found)`);
ok(shapeViolations.some((v) => /cooking steps/.test(v.where)), "cooking steps are scanned, not just the shopping list");
ok(findDietViolations(violatingPlanShape, []).length === 0, "a plan with no restrictions reports no violations");

// Frontend files exist and wire up.
const fs = require("fs");
for (const f of ["public/index.html", "public/app.js", "public/styles.css", "data/prices.json", "data/recipe-sources.json", ".env.example"]) {
  ok(fs.existsSync(f), `${f} exists`);
}
const vercelConfig = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const vercelServer = require("./server.js");
const vercelFunction = vercelConfig.functions?.["server.js"] || {};
ok(vercelConfig.framework === "express", "Vercel uses the Express framework preset");
ok(vercelConfig.buildCommand === "npm test", "Vercel runs the contract checks during builds");
ok(
  vercelFunction.includeFiles === "data/*.json",
  "Vercel bundles the catalog JSON files with the API"
);
ok(/geolocation=\(self\)/.test(JSON.stringify(vercelConfig)), "Vercel allows browser geolocation");
ok(typeof vercelServer === "function" && vercelServer === vercelServer.app, "Vercel receives the Express app export");
const netlifyConfig = fs.readFileSync("netlify.toml", "utf8");
for (const dataFile of ["prices.json", "stores.json", "recipe-sources.json", "diet-rules.json"]) {
  ok(netlifyConfig.includes(`data/${dataFile}`), `Netlify bundles data/${dataFile} with the function`);
}
const html = fs.readFileSync("public/index.html", "utf8");
ok(html.includes("app.js") && html.includes("api/plan") === false, "index.html loads app.js");
const appJs = fs.readFileSync("public/app.js", "utf8");
const serverSrc = fs.readFileSync("server.js", "utf8");
const recipeSourcesJson = fs.readFileSync("data/recipe-sources.json", "utf8");

async function exerciseFrontendMessage(message, parsed, pantryAfter) {
  const normalizedAppJs = appJs.replaceAll("\r\n", "\n");
  const handlerSource = normalizedAppJs.match(/async function handleMessage\(message\) \{[\s\S]*?\n\}\n\nasync function buildPlan/)?.[0]
    ?.replace(/\n\nasync function buildPlan$/, "") || "";
  const intentSource = normalizedAppJs.match(/function isPantryOnlyRequest\(message\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert(handlerSource, "could not extract handleMessage from public/app.js");

  const assistantMessages = [];
  let buildPlanCalls = 0;
  const context = {
    state: { pantry: [], plan: null },
    addUserMessage() {},
    addExclusion() {},
    addAssistantMessage(...args) { assistantMessages.push(args); },
    buildPlan: async () => { buildPlanCalls++; },
    capitalize(value) { return value ? value[0].toUpperCase() + value.slice(1) : value; },
    mentionIndex(lower, ingredient) { return lower.indexOf(ingredient); },
    parseMessage() {
      context.state.pantry = pantryAfter;
      return parsed;
    },
    loadPreferences: async () => {},
    setMobileView() {},
    $() { return { hidden: false }; }
  };
  vm.createContext(context);
  if (intentSource) vm.runInContext(intentSource, context);
  else context.isPantryOnlyRequest = () => false;
  vm.runInContext(handlerSource, context);
  await vm.runInContext(`handleMessage(${JSON.stringify(message)})`, context);
  return { assistantMessages, buildPlanCalls };
}
ok(appJs.includes("/api/plan"), "app.js calls /api/plan");
ok(!/catalogOnly\s*:\s*true/.test(appJs), "frontend planning requests do not bypass the text model");
ok(!/\b(?:localPlan|RECIPES|catalogOnly|FALLBACK_PACK_PRICE|FALLBACK_STORE|estimatedLeftover)\b/.test(serverSrc), "server has no local recipe planner or demo price fallback");
ok(!recipeSourcesJson.includes("FridgeFuse Demo Catalog"), "approved sources contain no demo catalog entry");
ok(!recipeSourcesJson.toLowerCase().includes("github.com"), "approved recipe sources do not link to GitHub");
ok(/VOYAGER_KEY[\s\S]*required/i.test(fs.readFileSync(".env.example", "utf8")), "environment guidance requires the Voyager key");
const mealSequenceLabelSource = appJs.match(/function mealSequenceLabel\(index\) \{[\s\S]*?\n\}/)?.[0] || "";
const mealSequenceLabel = mealSequenceLabelSource
  ? Function(`return (${mealSequenceLabelSource})`)()
  : () => "";
ok(mealSequenceLabel(0) === "TONIGHT", "the first dinner is labeled TONIGHT");
ok(
  [1, 2, 3, 4, 5, 6].every((index) => mealSequenceLabel(index) === `NIGHT ${index + 1}`),
  "later dinners are labeled NIGHT 2 through NIGHT 7"
);
ok(
  !appJs.includes('const dayLabels = ["TONIGHT", "NEXT", "THEN", "LATER", "LAST"]') &&
    !appJs.includes("`DAY ${index + 1}`"),
  "the mixed sequence labels and DAY fallback are removed"
);
ok(
  html.includes("Your dinner plan") &&
    html.includes("After your final dinner") &&
    !html.includes("Your next few nights") &&
    !html.includes("After dinner three"),
  "plan and leftovers headings work for every dinner count"
);
ok(
  appJs.includes('plan.dinners.length === 1 ? "dinner" : "dinners"'),
  "the plan title uses singular dinner for a one-meal plan"
);
const buildPlanSource = appJs.replaceAll("\r\n", "\n").match(/async function buildPlan[\s\S]*?\n}\n\nfunction formatMoney/)?.[0] || "";
const planAssignment = buildPlanSource.indexOf("state.plan =");
const groceryRefresh = buildPlanSource.indexOf("renderGroceryList();");
ok(
  planAssignment !== -1 && groceryRefresh > planAssignment,
  "building a plan refreshes the Shop meal-plan button after assigning the plan"
);
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
ok(
  appJs.includes("meal.sourceRecipe") && appJs.includes("meal.sourceUrl") && appJs.includes("meal.source"),
  "meal cards expose the exact approved recipe citation"
);
const recipeSourceHandling = appJs.match(/function isLegacyRecipeCitation[\s\S]*?function recordMessage/)?.[0] || "";
ok(
  /function isLegacyRecipeCitation/.test(recipeSourceHandling) &&
    /function sanitizeStoredPlan/.test(recipeSourceHandling) &&
    /plan:\s*sanitizeStoredPlan\(stored\.plan/.test(appJs) &&
    /sourceUnavailable/.test(recipeSourceHandling),
  "legacy saved recipe citations are removed instead of linking to the project repository"
);

const grocerySummaryBlock = appJs.match(/const best = options\[0\];[\s\S]*?const cards =/)?.[0] || "";
ok(
  /const completeOptions/.test(grocerySummaryBlock) &&
    /const priciest/.test(grocerySummaryBlock) &&
    /priciest\.distanceMi/.test(grocerySummaryBlock),
  "grocery savings summary uses the priciest complete store's distance"
);
const locationFailureBlock = appJs.match(/function requestLocation\([\s\S]*?async function compareStores/)?.[0] || "";
ok(
  /const hadPreviousLocation = Boolean\(state\.location\)/.test(locationFailureBlock) &&
    /const reportLocationFailure/.test(locationFailureBlock) &&
    /reportLocationFailure\("This browser has no location support\."\)/.test(locationFailureBlock) &&
    /reportLocationFailure\("Location needs HTTPS or localhost\."\)/.test(locationFailureBlock) &&
    /Keeping your previous location/.test(locationFailureBlock),
  "failed location refreshes distinguish a retained location from the fallback origin"
);
const postalLookupBlock = appJs.match(/async function resolveProfileZip[\s\S]*?function requestLocation/)?.[0] || "";
ok(
  /state\.allowPlaceLookup === false/.test(postalLookupBlock) &&
    /pendingZipLookup = null/.test(postalLookupBlock),
  "declined place lookup consent is respected for later ZIP searches"
);
ok(
  html.includes('id="resetDemoButton"') &&
    html.includes('id="resetMobileButton"') &&
    !html.includes('id="resetProfileButton"'),
  "reset is available from the desktop navigation and mobile header"
);
ok(
  appJs.includes('$("resetDemoButton").addEventListener("click", resetDemo)') &&
    appJs.includes('$("resetMobileButton").addEventListener("click", resetDemo)') &&
    appJs.includes("Reset the demo? This clears your profile, pantry, meal plan, chat history, Shop list, and saved location."),
  "desktop and mobile reset controls share the full-data confirmation handler"
);
const resetSource = appJs.match(/function resetDemo\(\) \{[\s\S]*?\n\}/)?.[0] || "";
ok(
  resetSource.indexOf("window.confirm") !== -1 &&
  resetSource.indexOf("window.confirm") < resetSource.indexOf("state = clone(DEFAULT_STATE)"),
  "reset cancellation is checked before saved state changes"
);

// ---------- grocery optimizer ----------
ok(fs.existsSync("data/stores.json"), "data/stores.json exists");
ok(
  resolveDataPath("/var/task/netlify/functions", "/var/task", (c) => c === "/var/task/data/stores.json", "stores.json") === "/var/task/data/stores.json",
  "store data resolves from the Netlify task root"
);
ok(fs.readFileSync("netlify.toml", "utf8").includes("data/stores.json"), "netlify bundles the store data with the function");
ok(
  (fs.readFileSync("netlify.toml", "utf8").match(/^\s*included_files\s*=/gm) || []).length === 1 &&
    fs.readFileSync("netlify.toml", "utf8").includes("data/recipe-sources.json"),
  "netlify bundles all catalog data in one included_files setting"
);
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

// ---------- preference catalogs + onboarding ----------
const catalogNames = new Set(PRICES.items.map((item) => item.name));

ok(DIET_OPTIONS.length >= 15, `diet catalog offers ${DIET_OPTIONS.length} options`);
ok(EQUIPMENT_OPTIONS.length >= 10, `equipment catalog offers ${EQUIPMENT_OPTIONS.length} options`);
ok(new Set(DIET_OPTIONS.map((d) => d.id)).size === DIET_OPTIONS.length, "diet ids are unique");
ok(new Set(EQUIPMENT_OPTIONS.map((e) => e.id)).size === EQUIPMENT_OPTIONS.length, "equipment ids are unique");
ok(DIET_OPTIONS.every((d) => d.id && d.label && d.group && Array.isArray(d.blocks)), "every diet option is fully formed");
ok(EQUIPMENT_OPTIONS.every((e) => e.id && e.label), "every equipment option is fully formed");
// A restriction that names an ingredient the catalog does not have would silently do nothing.
const strayBlocks = [...new Set(DIET_OPTIONS.flatMap((d) => d.blocks).filter((item) => !catalogNames.has(item)))];
ok(strayBlocks.length === 0, `every diet block names a real catalog item${strayBlocks.length ? ` (stray: ${strayBlocks})` : ""}`);
// An option that blocks nothing must say why, so it never looks broken.
ok(DIET_OPTIONS.every((d) => d.blocks.length > 0 || d.note), "diet options that restrict nothing explain why");
const dietGroups = new Set(DIET_OPTIONS.map((d) => d.group));
ok(dietGroups.has("Diet") && dietGroups.has("Allergy") && dietGroups.has("Avoid"), "diet options are grouped for the form");
for (const required of ["halal", "kosher", "pescatarian", "egg allergy", "soy allergy", "shellfish allergy", "no beef"]) {
  ok(DIET_OPTIONS.some((d) => d.id === required), `catalog covers "${required}"`);
}

// Every equipment option has a short "vibe" phrase — the client's live note
// describes cooking style from this text with no server round trip.
ok(EQUIPMENT_OPTIONS.every((e) => typeof e.vibe === "string" && e.vibe.length > 0), "every equipment option has a vibe description for the live note");
ok(
  EQUIPMENT_OPTIONS.find((option) => option.id === "pressure cooker")?.aliases?.includes("instant pot") &&
    EQUIPMENT_OPTIONS.find((option) => option.id === "stove")?.aliases?.includes("hot plate"),
  "equipment options expose common chat aliases"
);

const preferenceMentionSource = appJs.replaceAll("\r\n", "\n")
  .match(/function preferenceMentions\(message, options\) \{[\s\S]*?\n\}\n\nfunction parseMessage/)?.[0]
  ?.replace(/\n\nfunction parseMessage$/, "") || "";
ok(Boolean(preferenceMentionSource), "the chat parser reads preference mentions from the shared catalog");
if (preferenceMentionSource) {
  const preferenceContext = {};
  vm.createContext(preferenceContext);
  vm.runInContext(preferenceMentionSource, preferenceContext);
  const equipmentMentions = preferenceContext.preferenceMentions(
    "I only have an Instant Pot and rice cooker",
    EQUIPMENT_OPTIONS
  );
  const dietMentions = preferenceContext.preferenceMentions(
    "Please make it halal and gluten free",
    DIET_OPTIONS
  );
  ok(
    equipmentMentions.map((mention) => mention.id).sort().join(",") === "pressure cooker,rice cooker",
    "chat recognizes expanded equipment ids and aliases"
  );
  ok(
    dietMentions.map((mention) => mention.id).sort().join(",") === "gluten-free,halal",
    "chat recognizes expanded diet ids and aliases"
  );
}

// Saved profiles predate the id scheme, so old spellings must still resolve.
ok(parseDietSelections("no peanuts")[0]?.id === "peanut allergy", "legacy \"no peanuts\" still maps to the peanut option");
ok(parseDietSelections("gluten free")[0]?.id === "gluten-free", "unhyphenated \"gluten free\" resolves");
ok(parseDietSelections("Vegetarian")[0]?.id === "vegetarian", "diet matching ignores case");
ok(parseDietSelections("lactose intolerant")[0]?.id === "dairy-free", "an alias resolves to its option");
ok(parseDietSelections("vegan, gluten-free").length === 2, "multiple selections all resolve");
ok(parseDietSelections("").length === 0 && parseDietSelections(null).length === 0, "empty diet input resolves to nothing");
ok(blockedIngredientsForDiet("vegan").has("eggs") && !blockedIngredientsForDiet("vegetarian").has("eggs"), "vegan restricts more than vegetarian");
ok(blockedIngredientsForDiet("egg allergy").has("eggs"), "an allergy blocks its ingredient");

// Onboarding wiring: a one-time wizard, not a recurring login screen.
ok(html.includes('id="welcomeScreen"'), "the welcome screen exists");
ok(html.includes('data-step="identity"') && html.includes('data-step="kitchen"') && html.includes('data-step="food"'), "the wizard has its three steps");
ok(/onboarded:\s*false/.test(appJs), "onboarding defaults to not-yet-done");
ok(appJs.includes("if (needsOnboarding()) openWelcome();"), "the wizard only opens once — never on a return visit");
ok(
  appJs.includes('welcomeSteps = ["identity", "kitchen", "food"];') &&
    !/\["kitchen",\s*"food"\]/.test(appJs),
  "the wizard always has all three steps; there is no shortened returning-visit mode"
);
ok(appJs.includes("/api/preferences"), "the form renders from the server catalog");
// Dinners and minutes-per-meal change per request, so the chat parses them
// (already true before this feature) and the profile must not duplicate them.
ok(!html.includes('id="welcomeDinners"') && !html.includes('id="welcomeMaxTime"'), "the wizard does not ask for dinners or minutes per meal");
ok(!html.includes('id="profileDinners"') && !html.includes('id="profileMaxTime"'), "the profile drawer does not ask for dinners or minutes per meal");
ok(/if\s*\(dinners\)\s*state\.constraints\.dinners/.test(appJs) && /if\s*\(time\)\s*state\.constraints\.maxTimeMin/.test(appJs), "the chat parser still sets dinners and minutes per meal per request");
// The live note is qualitative text derived from PREFERENCES, not a fabricated count.
ok(appJs.includes("equipmentVibeText") && appJs.includes("dietVibeText"), "the live note describes cooking style instead of a recipe count");
ok(!/\bmatching\/total\b|dinners fit/i.test(appJs), "no leftover copy claims a specific recipe match count");

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

const PROFILE_EXTRA_DIET_TERMS_SOURCE = (appJs.match(/const PROFILE_EXTRA_DIET_TERMS = \[([^\]]*)\]/)?.[1] || "")
  .split(",")
  .map((term) => term.replace(/["']/g, "").trim())
  .filter(Boolean);
const profileDietValues = [...html.matchAll(/name="diet" value="([^"]+)"/g)].map((m) => m[1]);
ok(profileDietValues.length >= 5, `profile drawer offers ${profileDietValues.length} diet checkboxes`);
for (const value of profileDietValues) {
  ok(resolveDietRules(value).length > 0, `profile diet option "${value}" resolves to an enforceable rule`);
}
ok(PROFILE_EXTRA_DIET_TERMS_SOURCE.length > 0, "the chat can set diet terms beyond the checkboxes");
for (const term of PROFILE_EXTRA_DIET_TERMS_SOURCE) {
  ok(resolveDietRules(term).length > 0, `chat-only diet term "${term}" resolves to an enforceable rule`);
}
ok(/Kept \$\{dietSummary\}/.test(appJs), "the plan header names the restrictions it was held to");
ok(/offLimitsPantry/.test(appJs) && /I left \$\{offLimits\.join/.test(appJs), "the planner tells the student which pantry items it left out");
ok(/off-limits/.test(appJs) && /does not fit/.test(appJs), "the pantry marks an item the current diet rules out");
ok(fs.readFileSync("public/styles.css", "utf8").includes(".pantry-item.off-limits"), "an off-limits pantry item is styled as excluded");
ok(/failure\?\.message/.test(buildPlanSource), "the planner surfaces the server's refusal reason, not just a status code");

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
    needs: [{ item: "butter", amount: 2, unit: "oz" }],
    steps: ["Microwave the spinach, rice, and eggs until the eggs are fully set."],
    sourceRecipe: "Spinach Rice Breakfast Bowls",
    source: "Budget Bytes",
    sourceUrl: "https://www.budgetbytes.com/snap-challenge-spinach-rice-breakfast-bowls/",
    adaptationNote: ""
  }],
  shoppingList: [],
  notes: ""
};

async function runRouteChecks() {
  const pantryOnly = await exerciseFrontendMessage(
    "can you add rice and potatoes to my pantry",
    { ingredients: ["potatoes", "rice"], pantryChanged: true, removal: false, urgency: false },
    [{ name: "potatoes" }, { name: "rice" }]
  );
  ok(
    pantryOnly.buildPlanCalls === 0 &&
      pantryOnly.assistantMessages[0]?.[0] === "Added rice and potatoes to your pantry.",
    "a pantry-only chat command confirms the update without requesting a meal plan"
  );

  const shorthandPantryAdd = await exerciseFrontendMessage(
    "add milk",
    { ingredients: ["milk"], pantryChanged: true, removal: false, urgency: false },
    [{ name: "milk" }]
  );
  ok(
    shorthandPantryAdd.buildPlanCalls === 0 &&
      shorthandPantryAdd.assistantMessages[0]?.[0] === "Added milk to your pantry.",
    "a shorthand add command confirms the pantry update without requesting a meal plan"
  );

  const pantryAndPlan = await exerciseFrontendMessage(
    "add rice to my pantry and build a dinner plan",
    { ingredients: ["rice"], pantryChanged: true, removal: false, urgency: false },
    [{ name: "rice" }]
  );
  ok(
    pantryAndPlan.buildPlanCalls === 1 && pantryAndPlan.assistantMessages.length === 0,
    "a combined pantry and planning request still requests a meal plan"
  );

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
  ok(liveCalls === 1 && !live.payload.mock && !live.payload.fallback, "a plan request calls the text model exactly once");
  ok(live.payload.shoppingList.length === 1 && live.payload.shoppingList[0].item === "butter", "AI shopping needs are grounded against the price catalog");
  ok(
    live.payload.dinners[0].sourceRecipe === validAiPlan.dinners[0].sourceRecipe &&
      live.payload.dinners[0].source === validAiPlan.dinners[0].source &&
      live.payload.dinners[0].sourceUrl === validAiPlan.dinners[0].sourceUrl,
    "AI plans preserve approved recipe citations"
  );

  const fabricatedCitationPlan = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      sourceRecipe: "Invented spinach rice surprise",
      sourceUrl: "https://www.budgetbytes.com"
    }))
  };
  let fabricatedCitationCalls = 0;
  const fabricatedCitation = await callPlan(request, async () => {
    fabricatedCitationCalls++;
    return aiEnvelope(fabricatedCitationPlan);
  });
  ok(
    fabricatedCitationCalls === 2 &&
      fabricatedCitation.statusCode === 502 &&
      fabricatedCitation.payload.ok === false &&
      /recipe/i.test(fabricatedCitation.payload.failure?.message || ""),
    "a publisher homepage cannot validate an invented recipe title"
  );

  const unapprovedAiPlan = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      source: "Unapproved Recipe Blog",
      sourceUrl: "https://example.com/recipe"
    }))
  };
  let unapprovedCalls = 0;
  const unapproved = await callPlan(request, async () => {
    unapprovedCalls++;
    return aiEnvelope(unapprovedAiPlan);
  });
  ok(
    unapprovedCalls === 2 && unapproved.statusCode === 502 && unapproved.payload.ok === false && /approved recipe catalog/.test(unapproved.payload.failure?.message || ""),
    "unapproved AI recipe citations are rejected after repair"
  );

  let unavailableCalls = 0;
  const unavailable = await callPlan(request, async () => {
    unavailableCalls++;
    return { ok: false, failure: { status: "no-key", message: "VOYAGER_KEY is required for AI planning." } };
  });
  ok(
    unavailableCalls === 1 && unavailable.statusCode === 503 && unavailable.payload.ok === false && !unavailable.payload.dinners,
    "AI planning failure returns an error instead of a local plan"
  );

  const unpricedAiPlan = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: [{ item: "unobtainium", amount: 1, unit: "each" }] }))
  };
  let unpricedCalls = 0;
  const unpriced = await callPlan(request, async () => {
    unpricedCalls++;
    return aiEnvelope(unpricedAiPlan);
  });
  ok(
    unpricedCalls === 2 && unpriced.statusCode === 502 && unpriced.payload.ok === false && /price catalog/.test(unpriced.payload.failure?.message || ""),
    "AI plans with unpriced ingredients fail instead of using an estimated price"
  );

  // The model's own shoppingList/leftovers/totalCost are ignored: the server owns
  // the package arithmetic, so an invented number cannot reach the student.
  const inventedNumbers = await callPlan({ ...request, dinners: 1 }, async () => aiEnvelope({
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      needs: [{ item: "eggs", amount: 18, unit: "each" }]
    })),
    shoppingList: [{ item: "eggs", pack: "free eggs", packPrice: 0.01, store: "nowhere", qty: 1 }],
    leftovers: [{ item: "eggs", amount: "a whole lot, trust me" }],
    totalCost: 0.01
  }));
  ok(inventedNumbers.statusCode === 200 && inventedNumbers.payload.ok, "a plan with typed quantities is accepted");
  ok(
    inventedNumbers.payload.shoppingList[0].qty === 2 && inventedNumbers.payload.shoppingList[0].store !== "nowhere",
    "the server prices from its own catalog and buys the packages the amounts require"
  );
  ok(
    inventedNumbers.payload.totalCost === +(cheapestPack("eggs").packPrice * 2).toFixed(2),
    "the total is computed, not taken from the model"
  );
  ok(
    inventedNumbers.payload.leftovers[0].remaining === 6 && !/trust me/.test(JSON.stringify(inventedNumbers.payload.leftovers)),
    "leftovers are computed from the requirements, replacing the model's estimate"
  );

  // A model that phrases an amount badly costs the student a rougher leftover
  // estimate, not their dinner plan. This is the difference between guessing a
  // quantity (recoverable, and labelled) and guessing a price (never).
  let legacyCalls = 0;
  const legacyNeeds = await callPlan(request, async () => {
    legacyCalls++;
    return aiEnvelope({
      ...validAiPlan,
      dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: ["soy sauce"] }))
    });
  });
  ok(
    legacyCalls === 1 && legacyNeeds.statusCode === 200 && legacyNeeds.payload.ok,
    "a bare ingredient name still produces a plan instead of a 502"
  );
  ok(
    legacyNeeds.payload.shoppingList[0].assumedWholePackage === true &&
      /amount not given/.test(legacyNeeds.payload.shoppingList[0].requiredLabel),
    "the receipt says the amount was assumed rather than stating a false one"
  );
  ok(legacyNeeds.payload.leftovers.length === 0, "no leftover is claimed for an amount nobody stated");

  const wrongFamily = await callPlan(request, async () => aiEnvelope({
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: [{ item: "rice", amount: 1, unit: "cup" }] }))
  }));
  ok(
    wrongFamily.statusCode === 200 && wrongFamily.payload.shoppingList[0].assumedWholePackage === true,
    "a cup of a weight item buys the package rather than converting through a guessed density"
  );

  // ---------- dietary restrictions on the live plan route ----------
  const veganRequest = { ...request, pantry: ["spinach", "rice", "eggs"], useSoon: ["spinach"], diet: "vegan, no peanuts" };
  let dietPromptText = "";
  const dietAware = await callPlan(veganRequest, async (messages) => {
    dietPromptText = messages.map((message) => String(message.content)).join("\n");
    return aiEnvelope({
      ...validAiPlan,
      dinners: validAiPlan.dinners.map((dinner) => ({
        ...dinner,
        title: "Spinach rice bowl",
        usesPantry: ["spinach", "rice"],
        needs: [{ item: "black beans", amount: 15, unit: "oz" }],
        steps: ["Microwave the spinach and rice, then stir in the black beans."]
      }))
    });
  });
  ok(/Dietary restrictions \(STRICT/.test(dietPromptText), "a restricted plan request sends the strict diet section");
  ok(/never use, buy, or mention/.test(dietPromptText) && /peanut/.test(dietPromptText), "the request names the forbidden ingredients");
  ok(
    /must NOT cook with/.test(dietPromptText) && /eggs/.test(dietPromptText.split("Pantry items you must NOT cook with")[1] || ""),
    "a restricted pantry item is declared off-limits instead of offered as food"
  );
  ok(!/Pantry: [^.]*eggs/.test(dietPromptText), "a restricted pantry item is not offered in the cookable pantry list");
  ok(
    dietAware.statusCode === 200 && dietAware.payload.ok && dietAware.payload.dietRules.join(",") === "vegan,peanut allergy",
    "a compliant plan is returned and reports which restrictions were enforced"
  );

  // A celiac must be able to get a plan at all: the substitutes have to price.
  const celiacRequest = { ...request, pantry: ["rice", "spinach"], useSoon: [], diet: "celiac" };
  const glutenFreePlan = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      title: "Gluten-free pasta bowl",
      usesPantry: ["spinach"],
      needs: [{ item: "gluten free pasta", amount: 8, unit: "oz" }, { item: "marinara", amount: 12, unit: "oz" }],
      steps: ["Boil the gluten free pasta, then stir in the marinara and spinach."]
    }))
  };
  const celiac = await callPlan(celiacRequest, async () => aiEnvelope(glutenFreePlan));
  ok(
    celiac.statusCode === 200 && celiac.payload.ok && celiac.payload.shoppingList.length === 2,
    "a celiac plan built from gluten-free substitutes is accepted and priced"
  );
  ok(
    celiac.payload.shoppingList.some((entry) => entry.item === "gluten free pasta" && entry.packPrice > 0),
    "the gluten-free substitute is priced as itself, not as wheat pasta"
  );

  const wheatForCeliac = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      usesPantry: ["spinach"],
      needs: [{ item: "pasta", amount: 8, unit: "oz" }],
      steps: ["Boil the pasta."]
    }))
  };
  const celiacBlocked = await callPlan(celiacRequest, async () => aiEnvelope(wheatForCeliac));
  ok(
    celiacBlocked.statusCode === 502 && /gluten/.test(celiacBlocked.payload.failure?.message || ""),
    "wheat pasta in a celiac plan is rejected by the catalog tag, naming gluten"
  );

  // A celiac who says "I have pasta" must be told their pasta was left out,
  // not left to wonder whether the planner noticed it at all.
  const celiacPantry = { ...request, pantry: ["pasta", "eggs", "rice"], useSoon: [], diet: "celiac" };
  const celiacSafe = await callPlan(celiacPantry, async () => aiEnvelope({
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      usesPantry: ["rice", "eggs"],
      needs: [{ item: "marinara", amount: 8, unit: "oz" }],
      steps: ["Microwave the rice and eggs, then warm the marinara over them."]
    }))
  }));
  ok(celiacSafe.statusCode === 200 && celiacSafe.payload.ok, "a celiac plan built around the safe pantry items succeeds");
  ok(
    celiacSafe.payload.offLimitsPantry.join(",") === "pasta",
    `the plan names the pantry item it could not cook with (${JSON.stringify(celiacSafe.payload.offLimitsPantry)})`
  );
  ok(
    !celiacSafe.payload.dinners.some((dinner) => dinner.usesPantry.includes("pasta")),
    "wheat pasta in a celiac's pantry is never cooked"
  );

  const dairyInNeeds = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: [{ item: "cheddar", amount: 4, unit: "oz" }] }))
  };
  let dairyCalls = 0;
  const dairy = await callPlan(veganRequest, async () => {
    dairyCalls++;
    return aiEnvelope(dairyInNeeds);
  });
  ok(
    dairyCalls === 2 && dairy.statusCode === 502 && dairy.payload.ok === false && /dietary restrictions/i.test(dairy.payload.failure?.message || ""),
    "a plan that buys a forbidden ingredient is repaired once and then rejected"
  );
  ok(!dairy.payload.dinners, "a rejected plan returns no dinners at all");

  // The shopping list can be clean while a cooking step still breaks the diet.
  const butterInSteps = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      usesPantry: ["spinach", "rice"],
      needs: [],
      steps: ["Microwave the rice.", "Brush the pan with butter before serving."]
    }))
  };
  const hiddenStep = await callPlan(veganRequest, async () => aiEnvelope(butterInSteps));
  ok(
    hiddenStep.statusCode === 502 && /butter/.test(hiddenStep.payload.failure?.message || ""),
    "a forbidden ingredient in a cooking step is rejected even when the shopping list is clean"
  );

  let peanutCalls = 0;
  const peanut = await callPlan({ ...request, diet: "peanut allergy" }, async () => {
    peanutCalls++;
    return aiEnvelope({
      ...validAiPlan,
      dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: [{ item: "peanut butter", amount: 4, unit: "oz" }] }))
    });
  });
  ok(
    peanutCalls === 2 && peanut.statusCode === 502 && /peanut/.test(peanut.payload.failure?.message || ""),
    "an allergy violation is never served, even after a repair attempt"
  );

  // A repair that fixes the violation is accepted — enforcement is not a dead end.
  let dietRepairCalls = 0;
  const dietRepaired = await callPlan(veganRequest, async (messages) => {
    dietRepairCalls++;
    if (dietRepairCalls === 1) return aiEnvelope(dairyInNeeds);
    assert(/Dietary restrictions \(absolute\)/.test(messages.map((m) => String(m.content)).join("\n")));
    return aiEnvelope({
      ...validAiPlan,
      dinners: validAiPlan.dinners.map((dinner) => ({
        ...dinner,
        usesPantry: ["spinach", "rice"],
        needs: [{ item: "black beans", amount: 15, unit: "oz" }],
        steps: ["Microwave the spinach and rice, then stir in the black beans."]
      }))
    });
  });
  ok(
    dietRepairCalls === 2 && dietRepaired.statusCode === 200 && dietRepaired.payload.repaired === true,
    "the repair prompt carries the restrictions and a corrected plan is accepted"
  );

  const unrestricted = await callPlan(request, async () => aiEnvelope(dairyInNeeds));
  ok(unrestricted.statusCode === 200 && unrestricted.payload.ok, "a user with no restrictions is not blocked by the diet rules");

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
  ok(failedRepair.statusCode === 502 && failedRepair.payload.ok === false && !failedRepair.payload.dinners, "failed AI repair returns an error instead of a local plan");

  let visionUnavailableCalls = 0;
  const visionUnavailable = await callVision({ imageDataUrl: "data:image/jpeg;base64,dGVzdA==" }, async () => {
    visionUnavailableCalls++;
    return { ok: false, failure: { status: "no-key", message: "VOYAGER_KEY is required for AI vision." } };
  });
  ok(
    visionUnavailableCalls === 1 && visionUnavailable.statusCode === 503 && visionUnavailable.payload.ok === false && !visionUnavailable.payload.confirmed,
    "AI photo failure returns an error instead of demo groceries"
  );

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

  // With planning fully AI-driven and no local recipe filter, a diet
  // restriction only means something if it reaches the model as a concrete
  // ingredient list rather than a word the model might not parse correctly.
  const veganSafePlan = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      title: "Vegetable stir fry with rice",
      sourceRecipe: "Easy Vegetable Stir Fry",
      sourceUrl: "https://www.budgetbytes.com/easy-vegetable-stir-fry/",
      adaptationNote: "Added pantry spinach and served the stir fry over pantry rice.",
      timeMin: 25,
      usesPantry: ["spinach", "rice"],
      needs: [{ item: "soy sauce", amount: 2, unit: "tbsp" }],
      steps: ["Microwave the spinach and rice, then season with soy sauce."]
    }))
  };
  let dietPrompt = "";
  const dietPlan = await callPlan({ ...request, diet: "vegan, halal" }, async (messages) => {
    dietPrompt = messages.map((m) => String(m.content)).join(" ");
    return aiEnvelope(veganSafePlan);
  });
  ok(dietPlan.payload.ok, "a plan request with diet restrictions still succeeds");
  ok(/Hard exclusions/.test(dietPrompt), "the prompt states hard exclusions for an active diet");
  for (const item of blockedIngredientsForDiet("vegan")) {
    ok(dietPrompt.includes(item), `the exclusion list names "${item}" for a vegan request`);
  }
  ok(dietPrompt.includes("No pork or alcohol"), "an advisory-only restriction's note reaches the prompt");

  let unsafeDietCalls = 0;
  const unsafeDietPlan = await callPlan({ ...request, diet: "vegan" }, async () => {
    unsafeDietCalls++;
    return aiEnvelope(validAiPlan);
  });
  ok(
    unsafeDietCalls === 2 &&
      unsafeDietPlan.statusCode === 502 &&
      unsafeDietPlan.payload.ok === false &&
      /diet/i.test(unsafeDietPlan.payload.failure?.message || ""),
    "a plan using a diet-blocked ingredient is rejected after one repair attempt"
  );

  let noDietPrompt = "";
  await callPlan({ ...request, diet: "" }, async (messages) => {
    noDietPrompt = messages.map((m) => String(m.content)).join(" ");
    return aiEnvelope(validAiPlan);
  });
  ok(!/Hard exclusions/.test(noDietPrompt), "no diet means no fabricated exclusion list");

  console.log(`\nALL ${n} CHECKS PASSED`);
}

runRouteChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
