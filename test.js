// In-process verification (this sandbox blocks localhost TCP, so no live HTTP test).
// Run: node test.js
const assert = require("assert");
const path = require("path");
const vm = require("vm");
const {
  extractJson,
  DEFAULT_AIR_MODEL, AIR_MODEL, AIR_VISION_MODEL, AIR_VISION_VERIFY_MODEL,
  resolveDataPath, isApprovedRecipeCitation, buildPlanSystemPrompt, recipeSourcesContext,
  productionRecipeService, createProductionRecipeService,
  normalizeLiveRecipeCandidates,
  handlePlanRequest, handleVisionRequest, normalizeVisionResult,
  isValidCoordinate, normalizeIngredient,
  describeLocation, handleGeoDescribe,
  DIET_RULES, resolveDietRules, findForbiddenTerm, findDietViolations,
  pantryDietConflicts, dietRulesContext, findIngredientConflict,
  EQUIPMENT_OPTIONS,
  needName, groundShoppingPlan,
  findRepeatedExclusion
} = require("./server.js");

// Normalize OS-native path separators to forward slashes so assertions are
// cross-platform (path.join yields backslashes on Windows).
const toSlashes = (p) => p.split(path.sep).join("/");

let n = 0;
const ok = (cond, msg) => { n++; assert(cond, msg); console.log(`ok ${n} - ${msg}`); };

ok(AIR_VISION_MODEL === "qwen3-vl-32b-instruct", "photo requests use the dedicated vision model");
ok(DEFAULT_AIR_MODEL === "llama4-scout-17b", "tracked text-model default uses the verified fast model");
ok(AIR_VISION_MODEL !== AIR_MODEL, "text and photo requests do not silently share a model");
ok(AIR_VISION_VERIFY_MODEL === AIR_MODEL, "photo verification uses the tested fast multimodal model");


ok(extractJson('```json\n{"a":1}\n```').a === 1, "fenced JSON parsed");
ok(extractJson('{"a":2}').a === 2, "raw JSON parsed");

// Live recipe candidates are request-scoped. These fixtures exercise the same
// citation and grounding contract without recreating a production catalog.
const liveRecipeFixtures = [
  { title: "Hearty Black Bean Quesadillas", source: "Budget Bytes", sourceUrl: "https://www.budgetbytes.com/hearty-black-bean-quesadillas/", timeMin: 15, equipment: ["stove"], ingredients: ["black beans", "onion", "garlic", "cheddar", "tortillas"], method: "Mix the seasoned bean filling, fill folded tortillas, and toast both sides in a pan.", rawIngredients: ["black beans", "onion", "garlic", "cheddar", "tortillas"], rawInstructions: ["Mix the seasoned bean filling, fill folded tortillas, and toast both sides in a pan."] },
  { title: "Spinach Rice Breakfast Bowls", source: "Budget Bytes", sourceUrl: "https://www.budgetbytes.com/snap-challenge-spinach-rice-breakfast-bowls/", timeMin: 10, equipment: ["stove", "microwave"], ingredients: ["rice", "spinach", "eggs", "butter"], method: "Warm rice with spinach, cook an egg until set, and serve it over the rice.", rawIngredients: ["rice", "spinach", "eggs", "butter"], rawInstructions: ["Warm rice with spinach, cook an egg until set, and serve it over the rice."] },
  { title: "Microwave Potato", source: "Food Network", sourceUrl: "https://www.foodnetwork.com/recipes/food-network-kitchen/microwave-potato-10076489", timeMin: 10, equipment: ["microwave"], ingredients: ["potatoes", "olive oil", "butter"], method: "Pierce and oil the potato, microwave until tender, then split and season it.", rawIngredients: ["potatoes", "olive oil", "butter"], rawInstructions: ["Pierce and oil the potato, microwave until tender, then split and season it."] },
  { title: "Peanut Butter Banana Quesadillas", source: "Budget Bytes", sourceUrl: "https://www.budgetbytes.com/peanut-butter-banana-quesadillas/", timeMin: 10, equipment: ["stove"], ingredients: ["tortillas", "peanut butter", "banana"], method: "Fill a tortilla with peanut butter and sliced banana, fold it, and toast it in a pan.", rawIngredients: ["tortillas", "peanut butter", "banana"], rawInstructions: ["Fill a tortilla with peanut butter and sliced banana, fold it, and toast it in a pan."] },
  { title: "Easy Vegetable Stir Fry", source: "Budget Bytes", sourceUrl: "https://www.budgetbytes.com/easy-vegetable-stir-fry/", timeMin: 25, equipment: ["stove"], ingredients: ["soy sauce", "garlic", "carrots", "frozen peas", "onion", "olive oil"], method: "Mix the sauce, stir-fry vegetables in stages, then add the sauce in a pan.", rawIngredients: ["soy sauce", "garlic", "carrots", "frozen peas", "onion", "olive oil"], rawInstructions: ["Mix the sauce, stir-fry vegetables in stages, then add the sauce in a pan."] },
  { title: "Mexican Rice and Beans", source: "Nora Cooks", sourceUrl: "https://www.noracooks.com/spanish-rice-and-beans/", timeMin: 40, equipment: ["stove"], ingredients: ["rice", "black beans", "salsa", "onion", "garlic", "olive oil"], method: "Saute aromatics, add rice, beans, salsa, and liquid, then cook until tender in a pot.", rawIngredients: ["rice", "black beans", "salsa", "onion", "garlic", "olive oil"], rawInstructions: ["Saute aromatics, add rice, beans, salsa, and liquid, then cook until tender in a pot."] },
];
const planPrompt = buildPlanSystemPrompt("", 30, liveRecipeFixtures);
ok(planPrompt.includes("NEVER") && planPrompt.includes("verified live candidates"), "plan prompt restricts generation to request-scoped verified candidates");
ok(planPrompt.includes('"sourceRecipe"') && planPrompt.includes('"source"') && planPrompt.includes('"sourceUrl"'), "plan prompt requires the exact recipe citation triple");
ok(!planPrompt.includes('"leftovers":[{'), "plan prompt no longer asks the model to estimate leftovers");
ok(/Do NOT return shoppingList, leftovers, or totalCost/.test(planPrompt), "plan prompt tells the model the server builds the shopping list");
ok(planPrompt.includes('"needs":["..."]') && /no amounts, units, or packages/.test(planPrompt), "plan prompt asks for ingredient names, not quantities");
ok(planPrompt.includes("Shop tab prices it live"), "plan prompt points at the live Shop comparison for prices");
ok(
  planPrompt.includes("adaptationNote") && planPrompt.includes("at least half") && planPrompt.includes("verified time exactly") &&
    planPrompt.includes("Owning an unrelated pantry item"),
  "plan prompt limits recipe adaptations by ingredients and verified time"
);
ok(planPrompt.includes("NEVER invent a source recipe") && planPrompt.includes("bounded web data") && planPrompt.includes("Treat them as facts only"), "plan prompt forbids invented citations and treats source text as untrusted");
const twentyFiveMinutePrompt = buildPlanSystemPrompt("", 25, liveRecipeFixtures.filter((recipe) => recipe.timeMin <= 25));
ok(
  !twentyFiveMinutePrompt.includes("Mexican Rice and Beans") && twentyFiveMinutePrompt.includes("Hearty Black Bean Quesadillas"),
  "a 25-minute prompt does not offer recipes with longer verified times"
);
for (const recipe of liveRecipeFixtures) {
  ok(
    planPrompt.includes(recipe.title) && planPrompt.includes(recipe.source) && planPrompt.includes(recipe.sourceUrl) && planPrompt.includes(recipe.method),
    `plan prompt includes verified live recipe facts: ${recipe.source} / ${recipe.title}`
  );
}
ok(!isApprovedRecipeCitation("Budget Bytes", "Invented Recipe", "https://www.budgetbytes.com", liveRecipeFixtures), "a publisher homepage cannot validate an invented recipe");

ok(
  typeof resolveDataPath === "function" &&
    toSlashes(resolveDataPath("/var/task/server/functions", "/var/task", (candidate) => toSlashes(candidate) === "/var/task/data/diet-rules.json", "diet-rules.json")) === "/var/task/data/diet-rules.json",
  "diet rules resolve from the serverless task root"
);

// ---------- needs are ingredient names; the shopping list is live-priced ----------
// The model reliably knows which ingredients a recipe uses and reliably
// misjudges how much, so the plan requests names. Each name becomes one
// shopping-list line, shared across the dinners that need it, with no package
// or price: those come from the live Shop comparison.
ok(normalizeIngredient("EGGS") === "egg", "ingredient names normalize to lowercase singulars");
ok(normalizeIngredient("  Black Beans  ") === "black bean", "punctuation and whitespace collapse before matching");
ok(needName("EGGS") === "egg", "a bare ingredient name normalizes to itself");
ok(needName({ item: "Spinach" }) === "spinach", "object needs read the item field");
assert.throws(() => needName("  "), /missing its item name/);
n++; console.log(`ok ${n} - a need with no name is rejected rather than shopped`);
assert.throws(() => needName("x".repeat(90)), /unusable ingredient name/);
n++; console.log(`ok ${n} - an unusable ingredient name is rejected rather than shopped`);

const twoDinners = groundShoppingPlan({
  dinners: [
    { title: "A", needs: ["eggs", "spinach"] },
    { title: "B", needs: ["egg"] }
  ]
});
const eggLine = twoDinners.shoppingList.find((entry) => entry.item === "egg");
ok(eggLine && eggLine.qty === 2, `two dinners needing eggs share one line with qty 2 (qty=${eggLine?.qty})`);
ok(eggLine.sharedBy.length === 2, "sharedBy names every dinner that needs the ingredient");
ok(!("pack" in eggLine) && !("packPrice" in eggLine) && twoDinners.totalCost === undefined, "the shopping list carries no package or price");
ok(twoDinners.shoppingList.length === 2, "one shopping line per distinct ingredient");

// ---------- dietary restrictions (enforced server-side, not just prompted) ----------
ok(Array.isArray(DIET_RULES) && DIET_RULES.length >= 5, `diet rules DB has ${DIET_RULES.length} rules`);
ok(
  DIET_RULES.every((rule) => rule.id && rule.label && rule.aliases.length && rule.forbids.length),
  "every diet rule has an id, label, aliases, and forbidden ingredients"
);
ok(new Set(DIET_RULES.map((rule) => rule.id)).size === DIET_RULES.length, "diet rule ids are unique");
ok(DIET_RULES.every((rule) => rule.group && rule.aliases.length && rule.forbids.length), "every diet rule carries a group, aliases, and forbidden terms");
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
ok(findForbiddenTerm("butter beans", veganRule) === null, "vegan plans allow butter beans without allowing dairy butter");
ok(findForbiddenTerm("butter beans", dairyRule) === null, "dairy-free plans allow butter beans as a plant ingredient");
ok(findForbiddenTerm("unsalted butter", veganRule) === "butter" && findForbiddenTerm("unsalted butter", dairyRule) === "butter", "vegan and dairy-free plans still reject dairy butter");
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

const dietPrompt = buildPlanSystemPrompt(dietRulesContext([veganRule, peanutRule]));
ok(dietPrompt.includes("Dietary restrictions (STRICT"), "the plan prompt states the restrictions as strict");
ok(dietPrompt.includes("peanut") && dietPrompt.includes("honey"), "the plan prompt lists the forbidden ingredients");
ok(/pantry/i.test(dietPrompt) && dietPrompt.includes("stays forbidden"), "the plan prompt forbids cooking a restricted pantry item");
ok(!buildPlanSystemPrompt().includes("Dietary restrictions"), "an unrestricted plan prompt carries no diet section");

// Without the catalog, every ingredient goes through the same word net with
// the same allowed-substitute stripping.
ok(findIngredientConflict("gluten free pasta", glutenRule) === null, "the allowed-substitute list clears gluten-free pasta");
ok(findIngredientConflict("pasta", glutenRule) === "pasta", "plain wheat pasta is still caught by the word net");
ok(findIngredientConflict("unobtainium chicken", veganRule) === "chicken", "an unknown ingredient falls to the word net");
ok(DIET_RULES.every((rule) => rule.forbids.length > 0), "every diet rule forbids at least one term");

const violatingPlanShape = {
  dinners: [{ title: "Cheddar rice", usesPantry: ["rice"], needs: ["cheddar"], steps: ["Melt the cheddar."] }],
  shoppingList: [{ item: "cheddar" }]
};
const shapeViolations = findDietViolations(violatingPlanShape, [veganRule]);
ok(shapeViolations.length >= 4, `violations are found in every plan field (${shapeViolations.length} found)`);
ok(shapeViolations.some((v) => /cooking steps/.test(v.where)), "cooking steps are scanned, not just the shopping list");
ok(findDietViolations(violatingPlanShape, []).length === 0, "a plan with no restrictions reports no violations");

// Frontend files exist and wire up.
const fs = require("fs");
for (const f of ["public/index.html", "public/app.js", "public/styles.css", ".env.example"]) {
  ok(fs.existsSync(f), `${f} exists`);
}
ok(!fs.existsSync("public/designs.html"), "the obsolete designs.html prototype is removed");
const vercelConfig = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const vercelServer = require("./server.js");
const vercelFunction = vercelConfig.functions?.["server.js"] || {};
ok(vercelConfig.framework === "express", "Vercel uses the Express framework preset");
ok(vercelConfig.buildCommand === "npm test", "Vercel runs the contract checks during builds");
ok(
  vercelFunction.includeFiles === "data/*.json",
  "Vercel bundles the dietary rules JSON with the API"
);
ok(/geolocation=\(self\)/.test(JSON.stringify(vercelConfig)), "Vercel allows browser geolocation");
ok(typeof vercelServer === "function" && vercelServer === vercelServer.app, "Vercel receives the Express app export");
const html = fs.readFileSync("public/index.html", "utf8");
ok(html.includes("app.js") && html.includes("api/plan") === false, "index.html loads app.js");
const appJs = fs.readFileSync("public/app.js", "utf8");
const serverSrc = fs.readFileSync("server.js", "utf8");

ok(appJs.includes("/api/chat/interpret"), "chat uses server-side AI interpretation");
ok(!appJs.includes("KNOWN_INGREDIENTS"), "arbitrary foods do not depend on a frontend ingredient dictionary");

const planningFailureCopySource = appJs.replaceAll("\r\n", "\n")
  .match(/function planningFailureCopy\(context\) \{[\s\S]*?\n\}/)?.[0] || "";
ok(Boolean(planningFailureCopySource), "the frontend has persistent copy for distinct planning failure types");
if (planningFailureCopySource) {
  const failureContext = {};
  vm.createContext(failureContext);
  vm.runInContext(`${planningFailureCopySource}\nthis.testPlanningFailureCopy = planningFailureCopy;`, failureContext);
  const apiFailure = failureContext.testPlanningFailureCopy({
    responseReceived: true,
    httpStatus: 502,
    failure: { provider: "asu-air", operation: "chat", status: "timeout" }
  });
  const rejectedResponse = failureContext.testPlanningFailureCopy({
    responseReceived: true,
    httpStatus: 502,
    failure: { provider: "asu-air", operation: "plan-repair", status: "parse-error" }
  });
  const connectionFailure = failureContext.testPlanningFailureCopy({ responseReceived: false });
  const serverFailure = failureContext.testPlanningFailureCopy({ responseReceived: true, httpStatus: 500 });
  const displayFailure = failureContext.testPlanningFailureCopy({
    responseReceived: true,
    responseAccepted: true,
    httpStatus: 200
  });
  ok(
    apiFailure.title === "ASU AI API failure" && /timed out/i.test(apiFailure.detail),
    "an upstream timeout is labeled as an ASU AI API failure"
  );
  ok(
    rejectedResponse.title === "AI recipe response rejected" && /mismatched or unsafe recipe/i.test(rejectedResponse.detail),
    "an invalid model response is distinguished from an API failure"
  );
  ok(
    connectionFailure.title === "FridgeFuse connection failure" && /server/i.test(connectionFailure.detail),
    "a browser-to-app connection failure is labeled separately"
  );
  ok(
    serverFailure.title === "FridgeFuse server failure" && /HTTP 500/.test(serverFailure.detail),
    "an app server failure is labeled separately from ASU AI"
  );
  ok(
    displayFailure.title === "FridgeFuse display failure" && /plan arrived/i.test(displayFailure.detail),
    "a client rendering failure does not blame the API or app server"
  );
}

async function exerciseFrontendMessage(message, parsed, pantryAfter) {
  const { client } = require("./test-fixes");
  const c = client();
  let buildPlanCalls = 0;
  const assistantMessages = [];
  c.context.interpretMessage = async () => ({
    actions: pantryAfter.map(item => ({ type: "pantry_set", name: item.name, qty: 1, soon: false })),
    requestPlan: /build a dinner plan/.test(message), swapIndex: null, clarification: ""
  });
  c.context.buildPlan = async () => { buildPlanCalls++; };
  c.context.addAssistantMessage = (...args) => assistantMessages.push(args);
  await c.context.handleMessage(message);
  return { assistantMessages, buildPlanCalls };
}
// ---------- chat interpretation: the plan-to-shop command ----------
const { validateInterpretation } = require("./lib/chat-intents");
const shopIntent = validateInterpretation({ actions: [], requestPlan: false, planToShop: true, clarification: "", swapIndex: null }, "add the list to shop");
ok(shopIntent.planToShop === true && shopIntent.actions.length === 0 && shopIntent.requestPlan === false, "the plan-to-shop command is a validated intent, not a food action");
const notShopIntent = validateInterpretation({ actions: [], requestPlan: true, planToShop: false, clarification: "", swapIndex: null }, "what can I cook");
ok(notShopIntent.planToShop === false, "a cooking request does not trigger the plan-to-shop copy");
const clarifiedIntent = validateInterpretation({ actions: [], requestPlan: false, planToShop: true, clarification: "Which list?", swapIndex: null }, "add it");
ok(clarifiedIntent.planToShop === false && clarifiedIntent.clarification === "Which list?", "a clarification suppresses the plan-to-shop copy");
const chatIntentsSrc = fs.readFileSync("lib/chat-intents.js", "utf8");
ok(
  /never one merged name/.test(chatIntentsSrc) && chatIntentsSrc.includes("add salmon rice bean spinach to my fridge"),
  "the interpreter splits a run of foods and carries the example that used to merge"
);
ok(/ask one short clarification question/.test(chatIntentsSrc), "the interpreter may ask when one food or two is genuinely unclear");

ok(appJs.includes("/api/plan"), "app.js calls /api/plan");
ok(!/catalogOnly\s*:\s*true/.test(appJs), "frontend planning requests do not bypass the text model");
ok(!/\b(?:localPlan|RECIPES|catalogOnly|FALLBACK_PACK_PRICE|FALLBACK_STORE|estimatedLeftover|APPROVED_RECIPES|RECIPE_SOURCES)\b/.test(serverSrc), "server has no local recipe planner or static recipe catalog");
ok(!fs.existsSync("data/recipe-sources.json"), "the static recipe catalog is removed");
ok(!/TAVILY_API_KEY/.test(fs.readFileSync(".env.example", "utf8")), "meal planning does not require a Tavily search key");
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
    !html.includes("Your next few nights") &&
    !html.includes("After dinner three"),
  "plan headings work for every dinner count"
);
ok(
  appJs.includes('plan.dinners.length === 1 ? "dinner" : "dinners"'),
  "the plan title uses singular dinner for a one-meal plan"
);
ok(
  appJs.includes('"Add the dinners you want to Plan. Leave the rest here in Chat."'),
  "the chat invites deliberate selection without implying every suggestion was added"
);
const buildPlanSource = appJs.replaceAll("\r\n", "\n").match(/async function buildPlan[\s\S]*?\n}\n\nfunction formatMoney/)?.[0] || "";
ok(
  !/state\.plan\s*=/.test(buildPlanSource) &&
    /state\.suggestions/.test(buildPlanSource) &&
    !/setView\("plan"\)/.test(buildPlanSource),
  "building recipes keeps Plan and Shop untouched and leaves choices in Chat"
);
ok(
  /function addSuggestedDinnerToPlan\(/.test(appJs) && /function removeDinnerFromPlan\(/.test(appJs) && /swapping \? "replace" : "add"/.test(appJs),
  "chat recipe choices can be added to and removed from the plan"
);
ok(
  /planningFailureCopy\(\{[\s\S]*failure:\s*serverFailure[\s\S]*responseReceived[\s\S]*httpStatus/.test(buildPlanSource),
  "the plan request passes response evidence into the persistent failure message"
);
ok(
  appJs.includes('addAssistantMessage(copy.title, copy.detail, { tone: "error" })') &&
    appJs.includes('tone === "error" ? " error-message" : ""') &&
    appJs.includes('tone: entry.tone'),
  "planning failures render and remain visibly marked as errors"
);
ok(
  fs.readFileSync("public/styles.css", "utf8").includes(".error-message .message-copy"),
  "persistent planning failures have a distinct visual treatment"
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
ok(
  appJs.includes("Credit: ${escapeHtml(meal.sourceRecipe)} by ${escapeHtml(meal.source)}") &&
    appJs.includes("Required attribution:") && appJs.includes("License: ${escapeHtml(meal.sourceLicense)}") &&
    appJs.includes("sourceAttribution: safeText(meal.sourceAttribution)") &&
    appJs.includes("Reuse permission has not been verified; credit is not permission.") &&
    appJs.includes("Verified directions are unavailable. Regenerate this plan"),
  "meal cards preserve publisher credit and source-specific notices without implying permission or inventing fallback directions"
);
const suggestionCitationSource = appJs.match(/function renderSuggestionCitation[\s\S]*?function addSuggestedDinnerToPlan/)?.[0] || "";
ok(
  suggestionCitationSource.includes("Required attribution:") && suggestionCitationSource.includes("License:") &&
    suggestionCitationSource.includes("Reuse permission has not been verified; credit is not permission.") &&
    /<ol>\$\{meal\.steps\.map\(\(step\) => `<li>\$\{escapeHtml\(step\)\}<\/li>`\)/.test(suggestionCitationSource) &&
    suggestionCitationSource.includes("href=\"${escapeHtml(meal.sourceUrl)}\""),
  "Chat suggestions show escaped ordered directions with the publisher link, credit, and rights notices"
);
const recipeSourceHandling = appJs.match(/function isLegacyRecipeCitation[\s\S]*?function recordMessage/)?.[0] || "";
ok(
  /function isLegacyRecipeCitation/.test(recipeSourceHandling) &&
    /function sanitizeStoredPlan/.test(recipeSourceHandling) &&
    /plan:\s*sanitizeStoredPlan\(stored\.plan/.test(appJs) &&
    /sourceUnavailable/.test(recipeSourceHandling),
  "legacy saved recipe citations are removed instead of linking to the project repository"
);

ok(
  /function mergeStoreEstimates/.test(appJs) &&
    /function renderLiveComparison/.test(appJs) &&
    /renderStoreEstimates\(estimates, area\)/.test(appJs) &&
    !/function renderGroceryResults/.test(appJs),
  "the compare view renders merged live store estimates instead of static optimizer totals"
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
ok(
  html.includes('id="resetDemoButton"') &&
    html.includes('id="resetMobileButton"') &&
    !html.includes('id="resetProfileButton"'),
  "reset is available from the desktop navigation and mobile header"
);
ok(
  appJs.includes('$("resetDemoButton").addEventListener("click", resetDemo)') &&
    appJs.includes('$("resetMobileButton").addEventListener("click", resetDemo)') &&
    appJs.includes("Reset the demo? This clears your kitchen, including your profile, pantry, plan, chat history, Shop list, and saved location."),
  "desktop and mobile reset controls share the full-data confirmation handler"
);
const resetSource = appJs.match(/function resetDemo\(\) \{[\s\S]*?\n\}/)?.[0] || "";
ok(
  resetSource.indexOf("window.confirm") !== -1 &&
  resetSource.indexOf("window.confirm") < resetSource.indexOf("state = clone(DEFAULT_STATE)"),
  "reset cancellation is checked before saved state changes"
);

// ---------- store geometry ----------
// geolocation=() silently disables the browser location API — the Shop tab needs it.
ok(/geolocation=\(self\)/.test(fs.readFileSync("server.js", "utf8")), "server Permissions-Policy allows geolocation");

ok(!isValidCoordinate(0, 0) && !isValidCoordinate(NaN, 5) && !isValidCoordinate(91, 0), "null island and out-of-range coordinates are rejected");
ok(isValidCoordinate(33.42, -111.93), "a real coordinate is accepted");

// ---------- preference catalogs + onboarding ----------
ok(DIET_RULES.length >= 15, `diet catalog offers ${DIET_RULES.length} options`);
ok(EQUIPMENT_OPTIONS.length >= 10, `equipment catalog offers ${EQUIPMENT_OPTIONS.length} options`);
ok(new Set(DIET_RULES.map((d) => d.id)).size === DIET_RULES.length, "diet ids are unique");
ok(new Set(EQUIPMENT_OPTIONS.map((e) => e.id)).size === EQUIPMENT_OPTIONS.length, "equipment ids are unique");
ok(DIET_RULES.every((d) => d.id && d.label && d.group && d.forbids.length), "every diet option is fully formed");
ok(EQUIPMENT_OPTIONS.every((e) => e.id && e.label), "every equipment option is fully formed");
const dietGroups = new Set(DIET_RULES.map((d) => d.group));
ok(dietGroups.has("Diet") && dietGroups.has("Allergy") && dietGroups.has("Avoid"), "diet options are grouped for the form");
for (const required of ["halal", "kosher", "pescatarian", "egg allergy", "soy allergy", "shellfish allergy", "no beef"]) {
  ok(DIET_RULES.some((d) => d.id === required), `catalog covers "${required}"`);
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
    DIET_RULES
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
ok(resolveDietRules("no peanuts")[0]?.id === "peanut allergy", "legacy \"no peanuts\" still maps to the peanut rule");
ok(resolveDietRules("gluten free")[0]?.id === "gluten-free", "unhyphenated \"gluten free\" resolves");
ok(resolveDietRules("Vegetarian")[0]?.id === "vegetarian", "diet matching ignores case");
ok(resolveDietRules("lactose intolerant")[0]?.id === "dairy-free", "an alias resolves to its rule");
ok(resolveDietRules("vegan, gluten-free").length === 2, "multiple selections all resolve");
ok(resolveDietRules("").length === 0 && resolveDietRules(null).length === 0, "empty diet input resolves to nothing");

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

// ---------- location description + third-party lookup gate ----------
// With no branch catalog, the local description is the coordinate pair; the
// Nominatim lookup is what supplies a place name.
const described = describeLocation(33.4242, -111.9281);
ok(described.text === "Your location" && described.coords === "33.4242, -111.9281" && described.source === "coordinates", "a fix is labeled as the user's location with its coordinates alongside");
ok(describeLocation(NaN, 5) === null && describeLocation(0, 0) === null, "invalid coordinates produce no description");

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

// The allowLookup gate is the security-relevant part, so it gets its own
// checks. app.js sends a literal true when the user shares a location.
async function runGeoLookupChecks() {
  let geocodeCalls = 0;
  const fakeGeocode = async () => { geocodeCalls++; return { ok: true, placeName: "Tempe, Arizona" }; };
  const at = { lat: 33.4242, lng: -111.9281 };

  const noFlag = await callGeo({ ...at }, fakeGeocode);
  ok(noFlag.payload.lookupUsed === false && geocodeCalls === 0, "without the allowLookup flag no coordinates are sent to the third party");
  ok(noFlag.payload.local.text.length > 0, "the local description is returned even without the lookup");

  for (const value of [false, "true", 1, null, undefined]) {
    await callGeo({ ...at, allowLookup: value }, fakeGeocode);
  }
  ok(geocodeCalls === 0, "only a literal true unlocks the lookup (truthy values do not)");

  const consented = await callGeo({ ...at, allowLookup: true }, fakeGeocode);
  ok(geocodeCalls === 1 && consented.payload.placeName === "Tempe, Arizona", "an explicit allowLookup performs the lookup");

  const lookupFailed = await callGeo({ ...at, allowLookup: true }, async () => ({ ok: false, failure: { message: "down" } }));
  ok(lookupFailed.payload.ok && lookupFailed.payload.placeName === null && lookupFailed.payload.local.text, "a failed lookup still returns the local description");

  ok((await callGeo({ lat: 999, lng: "x" }, fakeGeocode)).status === 400, "invalid coordinates are rejected with 400");
}

// FridgeFuse is for ASU students in the Phoenix metro, so there is no ZIP to
// ask for: distances run from the catalog origin unless a live fix is shared.
ok(!/postalCode|welcomeZip|profilePostalCode|useProfileZipButton/.test(appJs), "the client asks for no ZIP code");
ok(!/ZIP code/i.test(html), "the profile and onboarding forms have no ZIP field");
ok(!/geo\/postal/.test(appJs) && !/geo\/postal/.test(serverSrc), "the postal lookup endpoint is gone with its only caller");
ok(!/allowPlaceLookup|lookupConsent/.test(appJs) && !html.includes("lookupConsent"), "sharing a location is the consent; there is no separate card left");
ok(appJs.includes("allowLookup: true"), "sharing a location asks the server for the place name");
ok(!appJs.includes("Place name from OpenStreetMap") && html.includes("OpenStreetMap"), "the location label is name-only; the OpenStreetMap credit stays in the Shop fine print");
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
ok(html.includes('id="planShopButton"') && appJs.includes('$("planShopButton")'), "the meal plan's shopping list has its own add-to-shop button");
ok(appJs.includes("/api/grocery/offers") && !appJs.includes("/api/grocery/optimize"), "the compare button uses live advertised prices, not the static optimizer");
ok(appJs.includes("navigator.geolocation"), "app.js asks the browser for a location");
ok(fs.readFileSync("public/styles.css", "utf8").includes("repeat(4, 1fr)"), "mobile nav has room for the fourth tab");

// ---------- chat-first shell: one pane at every width ----------
{
  const styles = fs.readFileSync("public/styles.css", "utf8");
  ok(
    /body\[data-view="chat"\] \.conversation-panel/.test(styles) &&
      /body\[data-view="plan"\] \.plan-panel/.test(styles) &&
      /body\[data-view="grocery"\] \.grocery-panel/.test(styles),
    "the workspace shows one pane at a time at every width"
  );
  ok(!/mobile-active/.test(appJs) && !/mobile-active/.test(styles), "the mobile-only view switch is gone");
  ok(!/max-width: 980px/.test(appJs), "a nav click changes the pane instead of only moving focus");
  ok(/let activeView = "chat"/.test(appJs), "chat is the home view");
  ok(html.indexOf('id="useFirstStrip"') > html.indexOf('id="pantryDrawer"'), "the use-first strip lives in the pantry drawer");
}
// Wide screens use the spare space: a centered chat column and a pantry panel.
{
  const styles = fs.readFileSync("public/styles.css", "utf8");
  const desktopNav = html.match(/<nav class="desktop-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  const mobileNav = html.match(/<nav class="mobile-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  ok(!desktopNav.includes('data-view="pantry"'), "the desktop rail drops the pantry tab because the panel is always there");
  ok(mobileNav.includes('data-view="pantry"'), "mobile keeps its pantry tab");
  ok(
    !desktopNav.includes("<svg") && desktopNav.includes("nav-index") && desktopNav.includes('id="groceryNavCount"') &&
      /\.nav-item\.active\s*\{[^}]*border-left-color/.test(styles),
    "the desktop rail uses numbered editorial labels with a flat active rule and visible Shop count"
  );
  const wideShellCss = styles.match(/@media \(min-width: 981px\) \{[\s\S]*?\n\}/)?.[0] || "";
  ok(
    /grid-template-columns: 88px minmax\(0, 1fr\) minmax\(270px, 320px\)/.test(wideShellCss) &&
      /\.pantry-drawer:not\(\.profile-drawer\) \.drawer-scrim \{ display: none/.test(wideShellCss) &&
      /\.pantry-drawer:not\(\.profile-drawer\) \.drawer-sheet \{[\s\S]{0,120}transform: none/.test(wideShellCss),
    "wide screens show the pantry as a static side column, not a drawer"
  );
  ok(!/\.pantry-drawer \.drawer-sheet/.test(wideShellCss), "the shared drawer class does not drag the profile overlay into the column");
  ok(/\.conversation-heading,[\s\S]{0,120}max-width: 760px/.test(styles), "the chat column is capped and centered");
  ok(/\.conversation-panel\.is-empty \.messages/.test(styles) && /updateChatEmptyState/.test(appJs), "an empty chat centers its greeting and prompts");
  ok(/function openPantry\(\) \{\s*\n\s*if \(isWideShell\(\)\) return;/.test(appJs), "the drawer only opens where the pantry is not a panel");
}
// Fridge, pantry, and kitchen each keep one job in visible copy.
ok(!/mini-fridge/.test(appJs) && !/mini-fridge/.test(html), "the food list is never called a mini-fridge");
ok(
  html.includes("Add from a fridge photo") && html.includes('id="pantryTitle">Your pantry') && html.includes("Your kitchen data"),
  "fridge is the appliance, pantry is the list, kitchen is the saved bundle"
);
// Labels stay fixed; counts and states move to a count or a disabled state.
ok(
  appJs.includes('$("fromPlanButton").textContent = "Add plan items"') &&
    appJs.includes('$("planShopButton").textContent = "Add to shop"') &&
    !/No meal plan yet|meal-plan item/.test(appJs),
  "the add-to-shop buttons keep fixed labels"
);

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
ok(/addExclusion\(meal\.sourceRecipe \|\| meal\.title\)/.test(appJs), "a swap excludes the recipe identity, not just the display title");
ok(/swapUnavailable/.test(appJs), "the client tells the student when no other recipe fits");
ok(/offLimitsPantry/.test(appJs) && /I left \$\{offLimits\.join/.test(appJs), "the planner tells the student which pantry items it left out");
ok(/off-limits/.test(appJs) && /does not fit/.test(appJs), "the inventory marks an item the current diet rules out");
ok(fs.readFileSync("public/styles.css", "utf8").includes(".pantry-item.off-limits"), "an off-limits pantry item is styled as excluded");

// Faults visible in a real screenshot, so they stay fixed.
{
  const styles = fs.readFileSync("public/styles.css", "utf8");
  ok(/\.composer textarea[\s\S]{0,160}min-height: 44px/.test(styles), "the composer is tall enough for its own placeholder");
  ok(/\.starter-prompts[\s\S]{0,120}flex-wrap: wrap/.test(styles), "the starter chips wrap instead of running off the edge");
  ok(/h1 \{[^}]*clamp\(26px/.test(styles), "the heading no longer takes a third of the column");
  ok(/\.use-first-strip\.is-empty/.test(styles) && /classList\.toggle\("is-empty"/.test(appJs), "the gold band stays quiet when nothing is marked");
}

// ---------- written for someone in a hurry ----------
// A first visit should show what you can act on, not headings over empty boxes.
ok(/id="savedRecipes"[^>]*hidden/.test(html), "the saved-meals section stays out of the way until something is saved");
ok(/\$\("savedRecipes"\)\.hidden = state\.savedRecipes\.length === 0/.test(appJs), "and appears the moment something is");
// A count with the wrong singular form reads as broken software to someone skimming.
ok(/suggestions\.length === 1 \? "is" : "are"/.test(appJs) && /suggestions\.length === 1 \? " suggestion" : " suggestions"/.test(appJs), "the recipe message agrees with its own count");
ok(/state\.constraints\.diet \|\| "your food restrictions"/.test(appJs), "a sentence about a diet still reads when no diet is named");

// An inventory row is a thing you scan, not a form: the row itself marks what to
// use first, and one × removes it, instead of two labelled buttons per line.
ok(/class="pantry-toggle"[\s\S]{0,200}data-pantry-action="soon"/.test(appJs), "tapping the row marks what to use first");
ok(/class="pantry-remove"[\s\S]{0,120}&times;/.test(appJs), "removing an item is a single ×");
ok(!/>Use soon<|>Unmark</.test(appJs), "the row no longer carries two labelled buttons");


// ---------- running it without a terminal ----------
// Not every teammate works in a shell; the launchers are the supported path, so
// they have to keep working.
for (const launcher of ["start.command", "start.bat", ".vscode/tasks.json"]) {
  ok(fs.existsSync(launcher), `${launcher} exists for teammates who do not use a terminal`);
}
ok((fs.statSync("start.command").mode & 0o111) !== 0, "start.command is executable, so double-clicking it runs it");
const unixLauncher = fs.readFileSync("start.command", "utf8");
const winLauncher = fs.readFileSync("start.bat", "utf8");
for (const [name, text] of [["start.command", unixLauncher], ["start.bat", winLauncher]]) {
  ok(/nodejs\.org/.test(text), `${name} says where to get Node when it is missing`);
  ok(/npm install/.test(text) && /npm start/.test(text), `${name} installs before it starts`);
  ok(/\.env/.test(text), `${name} sets up .env on first run`);
}
ok(!/\r\n/.test(unixLauncher), "start.command has Unix line endings, or the shell refuses to run it");
ok(JSON.parse(fs.readFileSync(".vscode/tasks.json", "utf8")).tasks.some((task) => task.label === "Run FridgeFuse"), "VS Code offers a Run FridgeFuse task");

// ---------- export and restore ----------
ok(html.includes('id="exportKitchenButton"') && html.includes('id="importKitchenButton"'), "the profile offers download and restore");
ok(/accept="application\/json,\.json"/.test(html), "restore only offers JSON files");
ok(/function normaliseState\(/.test(appJs) && /return normaliseState\(stored\);/.test(appJs), "one validator guards both the stored state and a restored file");
ok(/format: EXPORT_FORMAT/.test(appJs) && /payload\?\.format === EXPORT_FORMAT/.test(appJs), "the file carries a format marker that restore checks");
ok(/window\.confirm\(`Restore this kitchen\?/.test(appJs), "restoring asks before replacing what is on the device");
ok(/Number\(payload\.version\) > EXPORT_VERSION/.test(appJs), "a file from a newer version is refused rather than half-read");

// ---------- saved recipes ----------
// A dinner used to vanish the moment it was swapped or the plan rebuilt.
ok(html.includes('id="savedRecipes"') && html.includes('id="savedRecipeList"'), "the rail has a saved-recipes section");
ok(/data-action="save"/.test(appJs), "each dinner can be saved from its card");
ok(/data-saved-action="cook"/.test(appJs) && /data-saved-action="remove"/.test(appJs), "a saved recipe can be cooked again or removed");
// Saving keeps the citation, which is what the server matches on, not just a
// title the model is free to reword.
ok(/sourceRecipe: meal\.sourceRecipe/.test(appJs), "a saved recipe keeps its curated citation");
ok(/recipe\.sourceRecipe \|\| recipe\.title/.test(appJs), "cooking it again asks for it by citation");
ok(/savedRecipes: \[\]/.test(appJs) && /MAX_SAVED_RECIPES/.test(appJs), "saved recipes are persisted and bounded");

// ---------- logo assets ----------
for (const asset of ["logo-source.jpg", "logo-mark.png", "logo-mark-gold.png",
                     "logo-lockup.png", "logo-lockup-light.png", "favicon-32.png", "apple-touch-icon.png"]) {
  ok(fs.existsSync(`public/${asset}`), `public/${asset} is served with the app`);
}
// The gold mark sits on the maroon bar and the cream lockup on the maroon hero:
// using either the wrong way round would put maroon on maroon.
ok(/<img class="brand-mark" src="\/logo-mark-gold\.png"/.test(html), "the top bar carries the gold mark");
ok(/<img class="welcome-logo" src="\/logo-lockup-light\.png"/.test(html), "the maroon hero carries the cream lockup");
ok(/rel="icon"[^>]*favicon-32\.png/.test(html) && /apple-touch-icon\.png/.test(html), "the tab and home-screen icons are declared");
ok(/theme-color" content="#8c1d40"/i.test(html), "the browser chrome matches the maroon bar");
// Every derived asset comes from one drawing, so they cannot drift apart.
ok(fs.existsSync("scripts/build-logo-assets.py"), "the assets are reproducible from the source artwork");
const logoBytes = ["logo-mark-gold.png", "logo-lockup-light.png"].map((f) => fs.statSync(`public/${f}`).size);
ok(logoBytes.every((size) => size < 60 * 1024), `logo assets stay small (${logoBytes.map((b) => `${Math.round(b / 1024)}KB`).join(", ")})`);

// ---------- ASU palette ----------
const css = fs.readFileSync("public/styles.css", "utf8");
ok(/--maroon:\s*#8c1d40/i.test(css) && /--gold:\s*#ffc627/i.test(css), "the palette is built on ASU maroon and gold");
ok(!/--spinach|--tape\b|--cold-blue|--tomato/.test(css), "the old food-themed colour tokens are gone");
// Contrast is the reason gold is never text on white and maroon is never text on maroon.
const relLum = (hex) => {
  const parts = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
};
const contrast = (a, b) => {
  const [x, y] = [relLum(a), relLum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
for (const [fg, bg, what] of [
  ["#ffffff", "#8c1d40", "white on the maroon bar"],
  ["#ffc627", "#8c1d40", "gold on the maroon bar"],
  ["#191919", "#ffc627", "ink on a gold band"],
  ["#8c1d40", "#ffffff", "maroon on white"],
]) {
  ok(contrast(fg, bg) >= 4.5, `${what} meets AA contrast (${contrast(fg, bg).toFixed(2)}:1)`);
}
const strayHues = [...css.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase())
  .filter((hex) => {
    const r = parseInt(hex.substr(1, 2), 16), g = parseInt(hex.substr(3, 2), 16), b = parseInt(hex.substr(5, 2), 16);
    // A green cast — more green than both red and blue — is what the old palette
    // was built on and what should no longer appear anywhere.
    return g > r + 8 && g > b + 8;
  });
ok(strayHues.length === 0, `no colour keeps the old green cast${strayHues.length ? ` (${[...new Set(strayHues)].join(", ")})` : ""}`);
ok(/failure\?\.message/.test(buildPlanSource), "the planner surfaces the server's refusal reason, not just a status code");

// ---------- the client actually runs ----------
// Source-matching cannot catch a use-before-declaration: buildPlan's own
// try/catch turns one into "I could not build the plan" and the chat looks
// dead. So app.js is executed against a stub DOM and driven once, end to end.
function runClient({ planPayload }) {
  const stubEl = () => new Proxy(function () {}, {
    get(target, key) {
      if (key === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (key === "dataset") return {};
      if (key === "style") return {};
      if (key === "value" || key === "textContent" || key === "innerHTML") return "";
      if (key === "hidden" || key === "disabled" || key === "checked") return false;
      if (key === "files") return [];
      if (key === "length") return 0;
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "querySelectorAll" || key === "getElementsByTagName") return () => [];
      return stubEl();
    },
    set: () => true,
    apply: () => stubEl(),
  });
  const said = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: new Proxy({}, { get(target, key) {
      if (key === "getElementById" || key === "querySelector" || key === "createElement") return () => stubEl();
      if (key === "querySelectorAll") return () => [];
      if (key === "addEventListener") return () => {};
      return stubEl();
    }}),
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, location: { protocol: "https:" } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { geolocation: { getCurrentPosition() {} } },
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(), Intl, URL,
    Image: function () {}, FileReader: function () {},
    fetch: async () => ({ ok: true, json: async () => planPayload }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox, { filename: "app.js" });
  sandbox.addAssistantMessage = (text) => said.push(String(text));
  sandbox.toast = (text) => said.push(`TOAST:${text}`);
  return sandbox.buildPlan("build me a plan").then(() => ({ said, sandbox }));
}

const clientSaid = [];
const clientSandbox = [];
runClient({
  planPayload: {
    ok: true,
    dinners: [
      { title: "T", usesPantry: ["spinach"], needs: ["carrots", "eggs"], steps: ["step one"], equip: ["microwave"], timeMin: 10, source: "s", sourceUrl: "https://example.com/one", sourceRecipe: "r1" },
      { title: "U", usesPantry: ["rice"], needs: ["beans", "eggs"], steps: ["step two"], equip: ["microwave"], timeMin: 12, source: "s", sourceUrl: "https://example.com/two", sourceRecipe: "r2" },
    ],
    shoppingList: [{ item: "eggs", qty: 1, sharedBy: ["Night 1: T"] }, { item: "beans", qty: 1, sharedBy: ["Night 2: U"] }],
    leftovers: [], totalCost: 3, offLimitsPantry: ["pasta"], dietRules: ["gluten-free"],
  },
}).then(({ said, sandbox }) => { clientSaid.push(...said); clientSandbox.push(sandbox); });

function aiEnvelope(plan) {
  return {
    ok: true,
    data: { choices: [{ message: { content: JSON.stringify(plan) } }] }
  };
}

// In-process route checks inject a deterministic live-service boundary. The
// production service performs the Tavily/page/JSON-LD work; this fixture keeps
// those tests focused on citation, diet, swap, and shopping behavior.
const testLiveRecipeService = {
  async findRecipes() {
    return {
      ok: true,
      candidates: liveRecipeFixtures.map((recipe) => ({
        ...recipe,
        // The fixture service represents candidates already filtered by the
        // live source verifier; keep raw facts neutral so each route test can
        // exercise the model's post-generation diet check independently.
        rawIngredients: ["rice", "spinach", "beans"],
        rawInstructions: ["Cook the verified ingredients in the listed equipment."],
      }))
    };
  }
};

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
    Promise.resolve(handlePlanRequest(req, res, { chat, liveRecipeService: testLiveRecipeService })).catch(reject);
  });
}

function callDefaultPlan(body, chat) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = { body };
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { resolve({ statusCode, payload }); }
    };
    Promise.resolve(handlePlanRequest(req, res, { chat })).catch(reject);
  });
}

function productionCandidate(index, title, ingredients, instruction) {
  const source = `Example Publisher ${index}`;
  const sourceUrl = `https://publisher${index}.example.test/recipes/${title.toLowerCase().replace(/\s+/g, "-")}`;
  return {
    title, source, publisher: source, sourceUrl, finalUrl: sourceUrl, timeMin: 20,
    equipment: ["stove"], ingredients, rawIngredients: ingredients,
    rawInstructions: [instruction], instructions: [instruction], method: instruction,
    usageMode: "publisher-directions-with-link-credit", sourceRightsStatus: "no-reuse-license-found",
    linkAttribution: `${source} | ${title} | ${sourceUrl}`,
    productionEligible: true, prototypeOnly: false, attribution: "", license: null,
  };
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
    needs: ["butter"],
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
  let forwardedProductionRequest = null;
  const productionBoundary = createProductionRecipeService({
    async findRecipes(input) {
      forwardedProductionRequest = input;
      return { ok: false, failure: { status: "prototype-only-index" } };
    },
    async verifyUrl() { return { ok: false }; },
  });
  const prototypeAttempt = await productionBoundary.findRecipes({ dinners: 1, allowPrototypeOnly: true });
  ok(!Object.hasOwn(forwardedProductionRequest, "allowPrototypeOnly") && prototypeAttempt.failure.status === "prototype-only-index", "the production discovery boundary strips the prototype audit override");

  const originalProductionFind = productionRecipeService.findRecipes;
  const originalProductionVerify = productionRecipeService.verifyUrl;
  try {
    let defaultPlanFinds = 0;
    let defaultVoyagerCalls = 0;
    productionRecipeService.findRecipes = async (input) => {
      defaultPlanFinds++;
      ok(input.dinners === 3 && input.maxTimeMin === 30 && input.equipment.includes("stove"), "the default Plan route sends time and equipment constraints to curated discovery");
      return { ok: false, failure: { status: "no-safe-recipes", message: "Not enough verified recipes." } };
    };
    const insufficient = await callDefaultPlan({ dinners: 3, maxTimeMin: 30, equipment: ["stove"] }, async () => {
      defaultVoyagerCalls++;
      return aiEnvelope({ dinners: [] });
    });
    ok(insufficient.statusCode === 422 && defaultPlanFinds === 1 && defaultVoyagerCalls === 0, "the default Plan route fails closed before Voyager when curated discovery is insufficient");

    const productionCandidates = [
      productionCandidate(1, "Beans and Rice", ["beans", "rice"], "Heat beans and rice for 5 minutes."),
      productionCandidate(2, "Onion Rice", ["onion", "rice"], "Cook onion with rice for 8 minutes."),
      productionCandidate(3, "Bean Tomato Stew", ["beans", "tomatoes"], "Simmer beans with tomatoes for 10 minutes."),
    ];
    const selectorHallucination = (recipeId) => ({
      recipeId, title: "Invented model title", timeMin: 99, equip: ["oven"],
      usesPantry: ["milk"], needs: ["garlic", "oil"],
      steps: ["Bake garlic with oil in the oven for 99 minutes."],
    });
    productionRecipeService.findRecipes = async () => ({ ok: true, candidates: [{ ...productionCandidates[0], productionEligible: false, prototypeOnly: true }] });
    let prototypeVoyagerCalls = 0;
    const prototypeDenied = await callDefaultPlan({ dinners: 1, maxTimeMin: 30, equipment: ["stove"] }, async () => {
      prototypeVoyagerCalls++;
      return aiEnvelope({ dinners: [selectorHallucination("recipe-1")] });
    });
    ok(prototypeDenied.statusCode === 503 && prototypeVoyagerCalls === 0, "the default Plan path fails closed before Voyager for any prototype-only candidate");

    productionRecipeService.findRecipes = async () => ({ ok: true, candidates: productionCandidates });
    let observedPrompt = "";
    const productionPlan = await callDefaultPlan({ dinners: 3, maxTimeMin: 30, equipment: ["stove"] }, async (messages) => {
      observedPrompt = String(messages[0].content);
      return aiEnvelope({ dinners: [
        selectorHallucination("recipe-1"),
        selectorHallucination("recipe-2"),
        selectorHallucination("recipe-3"),
      ], notes: "Use garlic and oil." });
    });
    ok(productionPlan.statusCode === 200 && productionPlan.payload.dinners.length === 3, "a three-dinner default Plan fixture passes through discovery, grounding, and finalize");
    ok(productionPlan.payload.dinners.every((dinner, index) => dinner.sourceUsageMode === "publisher-directions-with-link-credit" && dinner.sourceCredit.includes(dinner.source) && dinner.steps.join("\n") === productionCandidates[index].rawInstructions.join("\n")), "the selector's hallucinated directions are replaced with exact verified publisher steps and visible credit");
    ok(productionPlan.payload.dinners.every((dinner, index) => dinner.timeMin === productionCandidates[index].timeMin && JSON.stringify(dinner.equip) === JSON.stringify(productionCandidates[index].equipment) && [...dinner.usesPantry, ...dinner.needs].sort().join("|") === [...productionCandidates[index].ingredients].sort().join("|")), "the default route canonicalizes exact ingredients, time, and equipment instead of model claims");
    ok(productionPlan.payload.notes === "" && !JSON.stringify(productionPlan.payload).includes("garlic"), "selector notes and hallucinated food terms do not enter the canonical plan");
    ok(observedPrompt.includes("recipeId") && !observedPrompt.includes("bounded source directions") && !observedPrompt.includes("Heat beans and rice for 5 minutes."), "Voyager receives recipe choices but no publisher directions to rewrite");

    const veganPlan = await callDefaultPlan({ dinners: 3, maxTimeMin: 30, equipment: ["stove"], diet: "vegan", pantry: [] }, async () =>
      aiEnvelope({ dinners: [selectorHallucination("recipe-1"), selectorHallucination("recipe-2"), selectorHallucination("recipe-3")] }));
    ok(veganPlan.statusCode === 200 && veganPlan.payload.dinners.length === 3 && veganPlan.payload.dietRules.includes("vegan"), "a diet-constrained selector request canonicalizes a full plan from verified candidates");
    ok(veganPlan.payload.dinners.every((dinner, index) => dinner.steps.join("\n") === productionCandidates[index].rawInstructions.join("\n") && [...dinner.usesPantry, ...dinner.needs].sort().join("|") === [...productionCandidates[index].ingredients].sort().join("|")) && !JSON.stringify(veganPlan.payload).includes("garlic"), "diet plans discard hallucinated dairy, ingredients, and steps in favor of the filtered source recipe");

    const retained = productionPlan.payload.dinners[1];
    const replaced = productionPlan.payload.dinners[0];
    const replacementCandidate = productionCandidates[2];
    let retainedVerifications = 0;
    productionRecipeService.findRecipes = async () => ({ ok: true, candidates: [replacementCandidate] });
    productionRecipeService.verifyUrl = async (url) => {
      retainedVerifications++;
      return url === retained.sourceUrl ? { ok: true, recipe: productionCandidates[1] } : { ok: false };
    };
    const swapped = await callDefaultPlan({
      dinners: 1, maxTimeMin: 30, equipment: ["stove"], exclude: [replaced.sourceRecipe],
      swapIndex: 0, previousDinners: [replaced, retained],
    }, async () => aiEnvelope({ dinners: [selectorHallucination("recipe-1")] }));
    ok(swapped.statusCode === 200 && retainedVerifications === 1 && swapped.payload.dinners[1].sourceRecipe === retained.sourceRecipe, "a retained swap source is re-verified through the default service before canonicalizing retained and replacement dinners");
    ok(swapped.payload.dinners.every((dinner) => dinner.steps.join("\n") === (dinner.sourceRecipe === replacementCandidate.title ? replacementCandidate.rawInstructions.join("\n") : productionCandidates[1].rawInstructions.join("\n"))), "a swap returns verified source directions for both the new and retained dinners");
  } finally {
    productionRecipeService.findRecipes = originalProductionFind;
    productionRecipeService.verifyUrl = originalProductionVerify;
  }

  const pantryOnly = await exerciseFrontendMessage(
    "can you add rice and potatoes to my pantry",
    { ingredients: ["potatoes", "rice"], pantryChanged: true, removal: false, urgency: false },
    [{ name: "potatoes" }, { name: "rice" }]
  );
  ok(
    pantryOnly.buildPlanCalls === 0 &&
      pantryOnly.assistantMessages[0]?.[0] === "Pantry updated: potatoes. Pantry updated: rice.",
    "a pantry-only chat command confirms the update without requesting a meal plan"
  );

  const shorthandPantryAdd = await exerciseFrontendMessage(
    "add milk",
    { ingredients: ["milk"], pantryChanged: true, removal: false, urgency: false },
    [{ name: "milk" }]
  );
  ok(
    shorthandPantryAdd.buildPlanCalls === 0 &&
      shorthandPantryAdd.assistantMessages[0]?.[0] === "Pantry updated: milk.",
    "a shorthand add command confirms the pantry update without requesting a meal plan"
  );

  const tomatoPantryAdd = await exerciseFrontendMessage(
    "add tomatoes",
    { ingredients: ["tomatoes"], pantryChanged: true, removal: false, urgency: false },
    [{ name: "tomatoes" }]
  );
  ok(
    tomatoPantryAdd.buildPlanCalls === 0 &&
      tomatoPantryAdd.assistantMessages[0]?.[0] === "Pantry updated: tomatoes.",
    '"add tomatoes" updates the pantry without starting a plan or showing a pricing error'
  );

  const pantryAndPlan = await exerciseFrontendMessage(
    "add rice to my pantry and build a dinner plan",
    { ingredients: ["rice"], pantryChanged: true, removal: false, urgency: false },
    [{ name: "rice" }]
  );
  ok(
    pantryAndPlan.buildPlanCalls === 1 && pantryAndPlan.assistantMessages[0]?.[0] === "Pantry updated: rice.",
    "a combined pantry and planning request still requests a meal plan"
  );

  const request = {
    pantry: ["spinach", "rice", "eggs"],
    useSoon: ["spinach"],
    budget: 18,
    dinners: 1,
    maxTimeMin: 20,
    equipment: ["stove", "microwave"],
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
  ok(
    live.payload.dinners[0].equip.join(",") === "stove,microwave",
    "dinner cards use the cited recipe's verified equipment"
  );

  const falsePantryOwnership = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      usesPantry: [...dinner.usesPantry, "butter"],
      needs: []
    }))
  };
  const pantryOwnedByUser = await callPlan(request, async () => aiEnvelope(falsePantryOwnership));
  ok(
    pantryOwnedByUser.statusCode === 200 && pantryOwnedByUser.payload.ok &&
      pantryOwnedByUser.payload.dinners[0].usesPantry.join(",") === "spinach,rice,eggs" &&
      pantryOwnedByUser.payload.dinners[0].needs.map((need) => typeof need === "string" ? need : need.item).join(",") === "butter" &&
      pantryOwnedByUser.payload.shoppingList.map((need) => need.item).join(",") === "butter",
    "the server moves a missing ingredient out of usesPantry and into the shopping needs"
  );

  const unrelatedPotatoAdaptation = {
    dinners: [{
      title: "Microwave Scrambled Eggs with Rice",
      sourceRecipe: "Microwave Potato",
      source: "Food Network",
      sourceUrl: "https://www.foodnetwork.com/recipes/food-network-kitchen/microwave-potato-10076489",
      adaptationNote: "use eggs instead of potato, add rice",
      timeMin: 3,
      usesPantry: ["eggs", "rice"],
      needs: [],
      steps: ["Microwave the eggs until set and serve them with rice."]
    }],
    notes: ""
  };
  let groundingCalls = 0;
  const grounded = await callPlan(request, async () => {
    groundingCalls++;
    return aiEnvelope(groundingCalls === 1 ? unrelatedPotatoAdaptation : validAiPlan);
  });
  ok(
    groundingCalls === 1 && grounded.payload.ok && grounded.payload.repaired === undefined &&
      grounded.payload.dinners[0].sourceRecipe === "Microwave Potato" &&
      grounded.payload.dinners[0].timeMin === 10 &&
      grounded.payload.dinners[0].needs.join(",") === "potatoes,olive oil,butter" &&
      grounded.payload.dinners[0].steps.join(" ") === "Cook the verified ingredients in the listed equipment." &&
      !JSON.stringify(grounded.payload.dinners[0]).includes("eggs"),
    "contradictory model fields are discarded in favor of the cited Microwave Potato facts"
  );

  const unrelatedPantryQuesadilla = {
    dinners: [{
      title: "Everything-in-the-pantry quesadilla",
      sourceRecipe: "Peanut Butter Banana Quesadillas",
      source: "Budget Bytes",
      sourceUrl: "https://www.budgetbytes.com/peanut-butter-banana-quesadillas/",
      adaptationNote: "Use the available pantry ingredients.",
      timeMin: 10,
      usesPantry: ["rice", "black beans", "potatoes", "butter", "cheddar"],
      needs: ["tortillas"],
      steps: ["Put the pantry ingredients in a tortilla and toast it."],
    }],
    notes: ""
  };
  let cleanRepairCalls = 0;
  let cleanRepairPrompt = "";
  const cleanRepair = await callPlan(request, async (messages) => {
    cleanRepairCalls++;
    if (cleanRepairCalls === 2) cleanRepairPrompt = messages.map((message) => String(message.content)).join("\n");
    return aiEnvelope(cleanRepairCalls === 1 ? unrelatedPantryQuesadilla : validAiPlan);
  });
  ok(
    cleanRepairCalls === 1 && cleanRepair.payload.ok && cleanRepair.payload.repaired === undefined &&
      cleanRepair.payload.dinners[0].sourceRecipe === "Peanut Butter Banana Quesadillas" &&
      cleanRepair.payload.dinners[0].needs.join(",") === "tortillas,peanut butter,banana" &&
      cleanRepair.payload.dinners[0].steps.join(" ") === "Cook the verified ingredients in the listed equipment." &&
      cleanRepairPrompt === "",
    "contradictory pantry fields are discarded in favor of the cited quesadilla facts"
  );

  const duplicatePantryNeed = {
    dinners: [{
      title: "Microwave Potato",
      sourceRecipe: "Microwave Potato",
      source: "Food Network",
      sourceUrl: "https://www.foodnetwork.com/recipes/food-network-kitchen/microwave-potato-10076489",
      adaptationNote: "",
      timeMin: 10,
      usesPantry: ["potatoes"],
      needs: [
        "potatoes",
        "olive oil",
        "butter"
      ],
      steps: ["Pierce and oil the potato, microwave until tender, then split and add butter."]
    }],
    notes: ""
  };
  let duplicateNeedCalls = 0;
  const duplicateNeedRepair = await callPlan({ ...request, pantry: ["potatoes", "butter"] }, async () => {
    duplicateNeedCalls++;
    return aiEnvelope(duplicatePantryNeed);
  });
  ok(
    duplicateNeedCalls === 1 && duplicateNeedRepair.payload.ok && duplicateNeedRepair.payload.repaired === undefined &&
      duplicateNeedRepair.payload.dinners[0].usesPantry.join(",") === "potatoes,butter" &&
      duplicateNeedRepair.payload.dinners[0].needs.map((need) => typeof need === "string" ? need : need.item).join(",") === "olive oil" &&
      duplicateNeedRepair.payload.shoppingList.map((need) => need.item).join(",") === "olive oil",
    "repair reconciles pantry and shopping fields to the cited recipe without duplicates"
  );

  const implausiblyFastPotato = {
    dinners: [{
      title: "Microwave Potato",
      sourceRecipe: "Microwave Potato",
      source: "Food Network",
      sourceUrl: "https://www.foodnetwork.com/recipes/food-network-kitchen/microwave-potato-10076489",
      adaptationNote: "",
      timeMin: 7,
      usesPantry: ["potatoes"],
      needs: [
        "olive oil",
        "butter"
      ],
      steps: ["Pierce and oil the potato, microwave until tender, then split and add butter."]
    }],
    notes: ""
  };
  let timeValidationCalls = 0;
  const timeRejected = await callPlan(request, async () => {
    timeValidationCalls++;
    return aiEnvelope(implausiblyFastPotato);
  });
  ok(
    timeValidationCalls === 1 && timeRejected.statusCode === 200 && timeRejected.payload.repaired === undefined &&
      timeRejected.payload.dinners[0].timeMin === 10,
    "a cited recipe's implausible time is canonicalized to its verified time"
  );

  const tooSlowForRequest = {
    dinners: [{
      title: "Mexican Rice and Beans",
      sourceRecipe: "Mexican Rice and Beans",
      source: "Nora Cooks",
      sourceUrl: "https://www.noracooks.com/spanish-rice-and-beans/",
      adaptationNote: "",
      timeMin: 40,
      usesPantry: ["rice", "black beans", "salsa", "onion", "garlic", "olive oil"],
      needs: [],
      steps: ["Saute the aromatics, add rice, beans, salsa, and liquid, then cook until the rice is tender."]
    }],
    notes: ""
  };
  let maxTimeCalls = 0;
  const maxTimeRequest = await callPlan(
    { ...request, maxTimeMin: 25, pantry: ["rice", "black beans", "salsa", "onion", "garlic", "olive oil"] },
    async () => {
      maxTimeCalls++;
      return aiEnvelope(maxTimeCalls === 1 ? tooSlowForRequest : validAiPlan);
    }
  );
  ok(
    maxTimeCalls === 2 && maxTimeRequest.statusCode === 200 && maxTimeRequest.payload.repaired === true,
    "a recipe longer than the requested per-dinner limit is repaired instead of being served"
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
    unapprovedCalls === 2 && unapproved.statusCode === 502 && unapproved.payload.ok === false && /verified live recipe candidates/.test(unapproved.payload.failure?.message || ""),
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
    dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: ["unobtainium"] }))
  };
  let unpricedCalls = 0;
  const unpriced = await callPlan(request, async () => {
    unpricedCalls++;
    return aiEnvelope(unpricedAiPlan);
  });
  ok(
    unpricedCalls === 1 && unpriced.statusCode === 200 && unpriced.payload.repaired === undefined &&
      !unpriced.payload.shoppingList.some((item) => item.item === "unobtainium"),
    "canonical grounding removes an unpriced ingredient that is not part of the cited recipe"
  );

  // The model's own shoppingList/leftovers/totalCost are ignored: the server owns
  // the package arithmetic, so an invented number cannot reach the student.
  const inventedNumbers = await callPlan({
    ...request,
    dinners: 1,
    pantry: request.pantry.filter((item) => item !== "eggs")
  }, async () => aiEnvelope({
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      usesPantry: dinner.usesPantry.filter((item) => item !== "eggs"),
      needs: ["eggs"]
    })),
    shoppingList: [{ item: "eggs", pack: "free eggs", packPrice: 0.01, store: "nowhere", qty: 1 }],
    leftovers: [{ item: "eggs", amount: "a whole lot, trust me" }],
    totalCost: 0.01
  }));
  ok(inventedNumbers.statusCode === 200 && inventedNumbers.payload.ok, "a plan with named needs is accepted");
  ok(
    inventedNumbers.payload.shoppingList.every((entry) => entry.qty === 1 && !("store" in entry) && !("packPrice" in entry)),
    "the server builds one shopping line per dinner from the model's names, with no model prices"
  );
  ok(inventedNumbers.payload.totalCost === undefined, "no plan total is invented from model numbers");
  ok(
    Array.isArray(inventedNumbers.payload.leftovers) && inventedNumbers.payload.leftovers.length === 0 &&
      !/trust me/.test(JSON.stringify(inventedNumbers.payload)),
    "the model's leftover estimate never reaches the student"
  );

  // A need shaped like the old typed requirement still resolves by name: the
  // server never shopped by model-supplied amounts, so nothing is lost.
  const legacyNeeds = await callPlan(request, async () => aiEnvelope({
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: [{ item: "butter" }] }))
  }));
  ok(
    legacyNeeds.statusCode === 200 && legacyNeeds.payload.ok &&
      legacyNeeds.payload.shoppingList.some((entry) => entry.item === "butter"),
    "an object-shaped need is resolved by its name, not rejected"
  );

  // An unknown unit on a need object changes nothing: names are all the server reads.
  const cookingUnits = await callPlan({
    ...request,
    pantry: request.pantry.filter((item) => item !== "rice")
  }, async () => aiEnvelope({
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      usesPantry: dinner.usesPantry.filter((item) => item !== "rice"),
      needs: [{ item: "rice", amount: 1, unit: "cup" }]
    }))
  }));
  ok(
    cookingUnits.statusCode === 200 && cookingUnits.payload.shoppingList.some((entry) => entry.item === "rice"),
    "extra fields on a need are ignored while its name is shopped"
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
        needs: ["black beans"],
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
  const celiacRequest = { ...request, pantry: ["rice", "spinach"], useSoon: [], equipment: ["stove", "skillet"], diet: "celiac" };
  const glutenFreePlan = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      title: "Gluten-free black bean quesadilla",
      sourceRecipe: "Hearty Black Bean Quesadillas",
      sourceUrl: "https://www.budgetbytes.com/hearty-black-bean-quesadillas/",
      adaptationNote: "Use corn tortillas instead of flour tortillas.",
      timeMin: 15,
      usesPantry: [],
      needs: [
        "black beans",
        "onion",
        "garlic",
        "cheddar",
        "corn tortillas"
      ],
      steps: ["Mix the bean filling, fill the corn tortillas, and toast both sides in a skillet."]
    }))
  };
  const celiac = await callPlan(celiacRequest, async () => aiEnvelope(glutenFreePlan));
  ok(
    celiac.statusCode === 200 && celiac.payload.ok && celiac.payload.shoppingList.length === 5,
    "a celiac plan built from gluten-free substitutes is accepted and priced"
  );
  ok(
    celiac.payload.shoppingList.some((entry) => entry.item === "corn tortilla"),
    "the gluten-free substitute keeps its own name on the live shopping list"
  );

  const wheatForCeliac = {
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      title: "Black bean quesadilla",
      sourceRecipe: "Hearty Black Bean Quesadillas",
      sourceUrl: "https://www.budgetbytes.com/hearty-black-bean-quesadillas/",
      timeMin: 15,
      usesPantry: [],
      needs: [
        "black beans",
        "onion",
        "garlic",
        "cheddar",
        "tortillas"
      ],
      steps: ["Fill the flour tortillas with the bean mixture and toast both sides."]
    }))
  };
  const celiacBlocked = await callPlan(celiacRequest, async () => aiEnvelope(wheatForCeliac));
  ok(
    celiacBlocked.statusCode === 502 && /gluten/i.test(celiacBlocked.payload.failure?.message || ""),
    "flour tortillas in a celiac plan are rejected by the word net, naming the gluten rule"
  );

  // Swapping a dinner: the exclusion is on the recipe, not the display title,
  // because the prompt lets a title describe the adapted result.
  const swapRequest = { ...request, exclude: [validAiPlan.dinners[0].sourceRecipe] };
  let swapCalls = 0;
  const swapped = await callPlan(swapRequest, async (messages) => {
    swapCalls++;
    if (swapCalls === 1) {
      // Same curated recipe, new title — what a silent swap failure looks like.
      return aiEnvelope({
        ...validAiPlan,
        dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, title: "A totally different sounding bowl" }))
      });
    }
    assert(/Do NOT use these recipes again/.test(messages.map((m) => String(m.content)).join(" ")));
    return aiEnvelope({
      ...validAiPlan,
      dinners: validAiPlan.dinners.map((dinner) => ({
        ...dinner,
        title: "Microwave potato with butter",
        sourceRecipe: "Microwave Potato",
        source: "Food Network",
        sourceUrl: "https://www.foodnetwork.com/recipes/food-network-kitchen/microwave-potato-10076489",
        adaptationNote: "",
        timeMin: 10,
        usesPantry: ["potatoes"],
        needs: [
          "olive oil",
          "butter"
        ],
        steps: ["Pierce and oil the potato, microwave it until tender, then split it and add butter."]
      }))
    });
  });
  ok(swapCalls === 2, "a repeated recipe under a new title is sent back rather than accepted");
  ok(
    swapped.statusCode === 200 && swapped.payload.dinners[0].sourceRecipe === "Microwave Potato" && !swapped.payload.swapUnavailable,
    "the swap returns a different curated recipe"
  );

  const swapImpossible = await callPlan(swapRequest, async () => aiEnvelope(validAiPlan));
  ok(
    swapImpossible.statusCode === 200 && swapImpossible.payload.swapUnavailable === true,
    "a swap the small catalog cannot satisfy says so instead of silently repeating"
  );
  ok(
    findRepeatedExclusion({ dinners: [{ title: "x", sourceRecipe: "Microwave Potato" }] }, ["microwave potato"]) !== null,
    "exclusion matching ignores case and punctuation"
  );
  ok(findRepeatedExclusion({ dinners: [{ title: "x", sourceRecipe: "y" }] }, []) === null, "nothing is excluded when nothing was swapped");

  // A celiac who says "I have pasta" must be told their pasta was left out,
  // not left to wonder whether the planner noticed it at all.
  const celiacPantry = { ...request, pantry: ["pasta", "eggs", "rice"], useSoon: [], diet: "celiac" };
  const celiacSafe = await callPlan(celiacPantry, async () => aiEnvelope({
    ...validAiPlan,
    dinners: validAiPlan.dinners.map((dinner) => ({
      ...dinner,
      usesPantry: ["rice", "eggs"],
      needs: ["marinara"],
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
    dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: ["cheddar"] }))
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
      dinners: validAiPlan.dinners.map((dinner) => ({ ...dinner, needs: ["peanut butter"] }))
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
        needs: ["black beans"],
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
  ok(repairCalls === 2 && repaired.payload.ok && repaired.payload.dinners[0].title === validAiPlan.dinners[0].sourceRecipe, "malformed AI output gets one successful grounded repair attempt");
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

  ok(clientSaid.length > 0, "public/app.js runs end to end against a stub DOM");
  ok(
    clientSaid.some((line) => /Here are 2 dinner suggestions/.test(line)),
    `a successful plan reaches the chat (said: ${JSON.stringify(clientSaid)})`
  );
  ok(
    !clientSaid.some((line) => /could not build the plan|TOAST:.*before initialization/.test(line)),
    "no runtime error is swallowed into a generic failure message"
  );
  ok(
    clientSaid.some((line) => /I left pasta out of the cooking/.test(line)),
    "the off-limits explanation is produced by the real code path, not just present in the source"
  );
  const recipeClient = clientSandbox[0];
  const recipeState = vm.runInContext("state", recipeClient);
  ok(recipeState.plan === null, "recipe generation does not add unchosen dinners to Plan");
  ok(
    Array.isArray(recipeState.suggestions) && recipeState.suggestions.length === 2,
    "the generated dinners remain available as Chat suggestions"
  );
  ok(vm.runInContext("activeView", recipeClient) === "chat", "a completed recipe request stays in Chat");
  vm.runInContext('state.constraints.diet = "vegan"', recipeClient);
  recipeClient.addSuggestedDinnerToPlan(1);
  ok(vm.runInContext("state.plan", recipeClient) === null, "a stale suggestion cannot be added after diet constraints change");
  vm.runInContext('state.constraints.diet = ""', recipeClient);
  recipeClient.addSuggestedDinnerToPlan(1);
  const chosenPlan = vm.runInContext("state.plan", recipeClient);
  ok(
    chosenPlan?.dinners?.length === 1 && chosenPlan.dinners[0].title === "U" &&
      chosenPlan.shoppingList.map((item) => item.item).sort().join(",") === "bean,egg",
    "adding one suggestion puts only that dinner and its needs in Plan"
  );
  recipeClient.addSuggestedDinnerToPlan(0);
  const twoChosenPlan = vm.runInContext("state.plan", recipeClient);
  ok(
    twoChosenPlan.dinners.length === 2 && twoChosenPlan.shoppingList.map((item) => item.item).sort().join(",") === "bean,carrot,egg" &&
      twoChosenPlan.shoppingList.find((item) => item.item === "egg").qty === 2 &&
      twoChosenPlan.shoppingList.find((item) => item.item === "egg").sharedBy.length === 2,
    "adding a second suggestion appends it and grounds only the chosen dinners' needs"
  );
  recipeClient.removeDinnerFromPlan(0);
  const reducedPlan = vm.runInContext("state.plan", recipeClient);
  ok(reducedPlan.dinners.length === 1 && reducedPlan.shoppingList.map((item) => item.item).sort().join(",") === "carrot,egg" &&
    reducedPlan.shoppingList.find((item) => item.item === "egg").qty === 1 &&
    reducedPlan.shoppingList.find((item) => item.item === "egg").sharedBy.length === 1,
  "removing a dinner also removes its unshared shopping needs and resets shared counts");
  recipeClient.removeDinnerFromPlan(0);
  ok(vm.runInContext("state.plan", recipeClient) === null, "removing the final dinner leaves no empty plan behind");
  const retainedState = vm.runInContext("state", recipeClient);
  retainedState.plan = {
    dinners: [{
      title: "Existing dinner", sourceRecipe: "Existing recipe", source: "Budget Bytes",
      sourceUrl: "https://www.budgetbytes.com/existing-recipe/", timeMin: 10,
      equip: ["microwave"], usesPantry: [], needs: ["rice"], steps: ["Warm the rice."]
    }],
    constraints: JSON.parse(JSON.stringify(retainedState.constraints)),
    shoppingList: [{ item: "rice", qty: 1, sharedBy: ["Night 1: Existing dinner"] }],
    offLimitsPantry: []
  };
  retainedState.groceryList = [{ name: "tea", qty: 2 }];
  const oldPlan = JSON.stringify(retainedState.plan);
  const oldShop = JSON.stringify(retainedState.groceryList);
  await recipeClient.buildPlan("another set of choices");
  ok(
    JSON.stringify(retainedState.plan) === oldPlan && JSON.stringify(retainedState.groceryList) === oldShop,
    "generating more recipes leaves an existing Plan and Shop list unchanged"
  );
  recipeClient.addSuggestedDinnerToPlan(1);
  ok(
    retainedState.plan.dinners.length === 2 && retainedState.plan.dinners[0].title === "Existing dinner" && retainedState.plan.dinners[1].title === "U",
    "adding to a compatible existing Plan appends the chosen dinner"
  );

  // ---------- export and restore ----------
  // The validator that guards what the browser stored also guards a restored
  // file, so it is worth running the real one against files nobody would write
  // on purpose.
  const client = clientSandbox[0];
  ok(typeof client.normaliseState === "function", "the state validator is reachable as one shared function");
  for (const [label, input] of [
    ["null", null],
    ["a string", "not a kitchen"],
    ["an array", [1, 2, 3]],
    ["wrong types throughout", { pantry: "eggs", messages: 7, savedRecipes: { a: 1 }, constraints: null, plan: "yesterday" }],
  ]) {
    const restored = client.normaliseState(input);
    ok(
      Array.isArray(restored.pantry) && Array.isArray(restored.savedRecipes) &&
        Array.isArray(restored.messages) && restored.constraints && typeof restored.constraints === "object",
      `restoring ${label} yields a usable state instead of a broken screen`
    );
  }
  const bounded = client.normaliseState({
    savedRecipes: Array.from({ length: 500 }, (_, i) => ({ title: `r${i}` })),
    messages: Array.from({ length: 500 }, () => ({ role: "user", text: "hi" })),
  });
  ok(bounded.savedRecipes.length <= 40 && bounded.messages.length <= 30, "a restored file cannot grow the stored state without limit");
  const hostileSuggestion = {
    ...recipeState.suggestions[0], title: "<img src=x onerror=alert(1)>", steps: ["<script>bad()</script>"]
  };
  const restoredSuggestion = client.normaliseState({
    suggestions: [hostileSuggestion], suggestionConstraints: recipeState.constraints, suggestionPantry: []
  });
  const unsafeSuggestion = client.normaliseState({
    suggestions: [{ ...hostileSuggestion, sourceUrl: "javascript:alert(1)" }], suggestionConstraints: recipeState.constraints
  });
  ok(
    restoredSuggestion.suggestions.length === 1 && client.escapeHtml(restoredSuggestion.suggestions[0].title).startsWith("&lt;img") &&
      client.escapeHtml(restoredSuggestion.suggestions[0].steps[0]).startsWith("&lt;script") && unsafeSuggestion.suggestions.length === 0,
    "restored suggestions escape publisher text and discard non-HTTPS source links"
  );
  ok(client.normaliseState({ location: { lat: "x", lng: 4 } }).location === null, "a restored location with no usable coordinates is dropped");

  await runGeoLookupChecks();

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
      needs: [
        "soy sauce",
        "garlic",
        "carrots",
        "onion"
      ],
      steps: ["Stir-fry the garlic, carrots, onion, and spinach, add the soy sauce, and serve over rice."]
    }))
  };
  let dietPrompt = "";
  const dietPlan = await callPlan({ ...request, maxTimeMin: 25, diet: "vegan, halal" }, async (messages) => {
    dietPrompt = messages.map((m) => String(m.content)).join(" ");
    return aiEnvelope(veganSafePlan);
  });
  ok(dietPlan.payload.ok, "a plan request with diet restrictions still succeeds");
  ok(/never use, buy, or mention/.test(dietPrompt), "the prompt states the forbidden terms as strict exclusions");
  for (const term of veganRule.forbids) {
    ok(dietPrompt.includes(term), `the exclusion list names "${term}" for a vegan request`);
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

  n += await require("./test-fixes")();
  n += await require("./test-grocery-offers")();
  n += await require("./test-sitemap-recipe-discovery")();
  n += await require("./test-rcp-recipe-discovery")();
  n += await require("./test-curated-recipe-discovery")();
  n += await require("./test-local-offer-ui")();
  console.log(`\nALL ${n} CHECKS PASSED`);
}

runRouteChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
