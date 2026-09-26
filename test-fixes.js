const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const server = require("./server");

// Exercise the shipped frontend without a browser or network requests.
function client() {
  const nodes = new Map();
  const node = (id = "") => {
    if (nodes.has(id)) return nodes.get(id);
    const el = { id, value: "", textContent: "", innerHTML: "", hidden: false, dataset: {}, style: {}, children: [], handlers: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(event, fn) { this.handlers[event] = fn; },
      append(child) { this.children.push(child); }, appendChild(child) { this.append(child); },
      remove() {}, focus() {}, setAttribute() {}, removeAttribute() {}, scrollTo() {},
      insertAdjacentHTML(_, html) { this.innerHTML += html; },
      click() { return this.handlers.click?.({ target: this }); },
      querySelector() { return node("child"); }, querySelectorAll() { return []; }, closest() { return this; }
    };
    nodes.set(id, el);
    return el;
  };
  // The shell nav is registered at load from [data-view], so the mock must
  // expose the four buttons or the view switch can never be exercised.
  const navButtons = ["chat", "plan", "grocery", "pantry"].map((view) => {
    const el = node(`nav-${view}`);
    el.dataset.view = view;
    return el;
  });
  const storage = { value: JSON.stringify({ profile: { onboarded: true } }) };
  const context = { console, URL, Intl, AbortController, structuredClone,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: (fn) => fn(),
    document: {
      getElementById: node,
      querySelector: () => node("query"),
      querySelectorAll: (selector) => String(selector).includes("[data-view]") || String(selector).includes(".nav-item") ? navButtons : [],
      createElement: () => node(`new-${nodes.size}`),
      addEventListener() {}, body: node("body")
    },
    window: { matchMedia: () => ({ matches: false }), confirm: () => true, location: { reload() {} }, setTimeout: () => 0 },
    localStorage: { getItem: () => storage.value, setItem: (_, value) => { storage.value = value; } },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => url === "/api/preferences" ? { ok: true, diets: dietOptions(), equipment: server.EQUIPMENT_OPTIONS, limits: { budget: { min: 5, max: 100 } } } : { ok: true } })
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("public/app.js", "utf8"), context);
  return { context, node, run: (code) => vm.runInContext(code, context) };
}
// The server maps its diet rules into the form payload the client consumes.
const dietOptions = () => server.DIET_RULES.map(({ id, label, group, note, aliases, forbids }) => ({
  id, label, group, note, aliases, restricts: forbids.length
}));
// Deterministic request-scoped candidates for the in-process route checks. The
// production service starts from curated URL leads and verifies live Recipe JSON-LD;
// this fixture only replaces that network boundary.
const LIVE_CANDIDATES = [
  { title: "Microwave Potato", source: "Food Network", sourceUrl: "https://www.foodnetwork.com/recipes/food-network-kitchen/microwave-potato-10076489", timeMin: 10, equipment: ["microwave"], ingredients: ["potatoes", "olive oil", "butter"], method: "Pierce and oil the potato, microwave until tender, then split and season it.", rawIngredients: ["potatoes", "olive oil", "butter"], rawInstructions: ["Pierce and oil the potato, microwave until tender, then split and season it."] },
  { title: "Spinach Rice Breakfast Bowls", source: "Budget Bytes", sourceUrl: "https://www.budgetbytes.com/snap-challenge-spinach-rice-breakfast-bowls/", timeMin: 10, equipment: ["stove", "microwave"], ingredients: ["rice", "spinach", "eggs", "butter"], method: "Warm rice with spinach, cook an egg until set, and serve it over the rice.", rawIngredients: ["rice", "spinach", "eggs", "butter"], rawInstructions: ["Warm rice with spinach, cook an egg until set, and serve it over the rice."] },
  { title: "Peanut Butter Banana Quesadillas", source: "Budget Bytes", sourceUrl: "https://www.budgetbytes.com/peanut-butter-banana-quesadillas/", timeMin: 10, equipment: ["stove"], ingredients: ["tortillas", "peanut butter", "banana"], method: "Fill a tortilla with peanut butter and sliced banana, fold it, and toast it in a pan.", rawIngredients: ["tortillas", "peanut butter", "banana"], rawInstructions: ["Fill a tortilla with peanut butter and sliced banana, fold it, and toast it in a pan."] },
  { title: "Peanut Butter Banana Smoothie", source: "Budget Bytes", sourceUrl: "https://www.budgetbytes.com/peanut-butter-banana-smoothie/", timeMin: 5, equipment: ["blender"], ingredients: ["banana", "peanut butter", "milk"], method: "Blend the banana, peanut butter, and milk until smooth.", rawIngredients: ["banana", "peanut butter", "almond milk"], rawInstructions: ["Blend banana, peanut butter, and almond milk until smooth."] },
];
function dinner(title = "Microwave Potato") {
  const r = LIVE_CANDIDATES.find((entry) => entry.title === title);
  return { title, sourceRecipe: r.title, source: r.source, sourceUrl: r.sourceUrl, timeMin: r.timeMin,
    usesPantry: [], needs: [...r.ingredients], steps: [r.method] };
}
const envelope = (dinners) => ({ ok: true, data: { choices: [{ message: { content: JSON.stringify({ dinners }) } }] } });
async function plan(body, dinners, liveRecipeService = { findRecipes: async () => ({ ok: true, candidates: LIVE_CANDIDATES }) }) {
  let output;
  const res = { code: 200, status(n) { this.code = n; return this; }, json(payload) { output = { status: this.code, payload }; } };
  await server.handlePlanRequest({ body: { pantry: [], dinners: dinners.length, maxTimeMin: 30, equipment: ["microwave"], ...body } }, res, { chat: async () => envelope(dinners), liveRecipeService });
  return output;
}

async function run() {
  let count = 0;
  const failed = [];
  async function check(name, fn) {
    try { await fn(); count++; console.log(`fix ok - ${name}`); }
    catch (error) { failed.push(name); console.error(`fix FAIL - ${name}: ${error.message}`); }
  }
  await check("almond milk never trips the dairy-free rule", () => {
    const dairyFree = server.DIET_RULES.find((rule) => rule.id === "dairy-free");
    assert.strictEqual(server.findForbiddenTerm("almond milk", dairyFree), null);
    assert.strictEqual(server.findForbiddenTerm("milk", dairyFree), "milk");
  });
  await check("equipment mismatch is rejected", async () => {
    const result = await plan({}, [dinner("Peanut Butter Banana Quesadillas")]);
    assert.strictEqual(result.payload.ok, false);
  });
  await check("known recipe IDs supply exact citations", async () => {
    const d = dinner(); d.recipeId = `recipe-${LIVE_CANDIDATES.findIndex((r) => r.sourceUrl === d.sourceUrl) + 1}`;
    delete d.source; delete d.sourceRecipe; delete d.sourceUrl;
    const result = await plan({}, [d]);
    assert.strictEqual(result.payload.ok, true);
    assert.strictEqual(result.payload.dinners[0].source, "Food Network");
  });
  await check("pantry-owned ingredients are cooked, not shopped", async () => {
    const d = dinner("Spinach Rice Breakfast Bowls");
    const result = await plan({ equipment: ["stove", "microwave"], pantry: ["eggs", "rice"] }, [d, d]);
    assert.strictEqual(result.payload.ok, true);
    assert.deepStrictEqual(result.payload.dinners[0].usesPantry.sort(), ["eggs", "rice"]);
    assert(!result.payload.shoppingList.some((i) => i.item === "eggs" || i.item === "rice"));
    assert(result.payload.shoppingList.some((i) => i.item === "spinach" && i.qty === 2));
  });
  await check("pantry items no recipe wants stay out of the shopping list", async () => {
    const result = await plan({ pantry: ["potatoes"] }, [dinner()]);
    assert(result.payload.shoppingList.some((i) => i.item === "olive oil"));
    assert(!result.payload.shoppingList.some((i) => i.item === "potatoes"));
  });
  await check("the shopping list carries no catalog prices", () => {
    const p = server.groundShoppingPlan({ dinners: [{ title: "Test", needs: ["eggs", "tamari"] }] });
    assert.strictEqual(p.shoppingList.length, 2);
    assert(p.shoppingList.every((i) => !("store" in i) && !("packPrice" in i)));
    assert.strictEqual(p.totalCost, undefined);
  });
  await check("vegan allows plant milk and rejects dairy milk", async () => {
    const d = dinner("Peanut Butter Banana Smoothie");
    d.needs = ["banana", "peanut butter", "almond milk"];
    d.steps = ["Blend banana, peanut butter and almond milk."];
    const plant = await plan({ diet: "vegan", equipment: ["blender"] }, [d]);
    assert.strictEqual(plant.payload.ok, true);
    assert(plant.payload.shoppingList.some((i) => i.item === "almond milk"));
    const dairy = { ...d, needs: ["banana", "peanut butter", "milk"], steps: ["Blend banana, peanut butter and milk."] };
    const rejected = await plan({ diet: "vegan", equipment: ["blender"] }, [dairy]);
    assert.strictEqual(rejected.payload.ok, false);
  });
  await check("swap preserves other dinners, even when their recipe matches the exclusion", async () => {
    const previous = [dinner(), dinner(), dinner()];
    const replacement = dinner("Peanut Butter Banana Quesadillas");
    replacement.needs = ["tortillas", "peanut butter", "banana"];
    const result = await plan({ equipment: ["stove", "microwave"], swapIndex: 1, previousDinners: previous, exclude: ["Microwave Potato"] }, [replacement]);
    assert.strictEqual(result.payload.ok, true);
    assert.strictEqual(result.payload.dinners.length, 3);
    assert.strictEqual(result.payload.dinners[0].title, previous[0].title);
    assert.strictEqual(result.payload.dinners[2].title, previous[2].title);
    assert.deepStrictEqual(result.payload.dinners[0].steps, previous[0].steps);
    assert.strictEqual(result.payload.dinners[1].sourceRecipe, replacement.sourceRecipe);
  });
  await check("unavailable swap returns no replacement plan", async () => {
    const previous = [dinner()];
    const result = await plan({ swapIndex: 0, previousDinners: previous, exclude: ["Microwave Potato"] }, [dinner()]);
    assert.strictEqual(result.status, 422);
    assert(!result.payload.dinners);
  });
  await check("cook again requires the requested recipe", async () => {
    const result = await plan({ includeRecipe: "Peanut Butter Banana Quesadillas" }, [dinner()]);
    assert.strictEqual(result.payload.ok, false);
  });
  await check("cook again with three dinners keeps enough verified choices", async () => {
    let searchRequest;
    const service = {
      findRecipes: async (request) => {
        searchRequest = request;
        return { ok: true, candidates: LIVE_CANDIDATES };
      }
    };
    const result = await plan({ includeRecipe: "Peanut Butter Banana Quesadillas", equipment: ["stove", "microwave", "blender"] }, [
      dinner("Peanut Butter Banana Quesadillas"),
      dinner("Microwave Potato"),
      dinner("Peanut Butter Banana Smoothie")
    ], service);
    assert.strictEqual(searchRequest.dinners, 3);
    assert.strictEqual(result.payload.ok, true);
    assert.strictEqual(result.payload.dinners.length, 3);
    assert(result.payload.dinners.some((entry) => entry.sourceRecipe === "Peanut Butter Banana Quesadillas"));
  });
  await check("swap re-verifies retained dinners and excludes the replaced recipe", async () => {
    const replaced = dinner("Microwave Potato");
    const retained = dinner("Spinach Rice Breakfast Bowls");
    const replacement = dinner("Peanut Butter Banana Quesadillas");
    const verifiedUrls = [];
    let searchRequest;
    const service = {
      findRecipes: async (request) => {
        searchRequest = request;
        return { ok: true, candidates: [LIVE_CANDIDATES.find((entry) => entry.title === replacement.sourceRecipe)] };
      },
      verifyUrl: async (url) => {
        verifiedUrls.push(url);
        return { ok: true, recipe: LIVE_CANDIDATES.find((entry) => entry.sourceUrl === url) };
      }
    };
    const result = await plan({
      equipment: ["stove", "microwave"],
      swapIndex: 0,
      previousDinners: [replaced, retained],
      exclude: [replaced.sourceRecipe]
    }, [replacement], service);
    assert.deepStrictEqual(verifiedUrls, [retained.sourceUrl]);
    assert.deepStrictEqual(searchRequest.exclude, [replaced.sourceRecipe]);
    assert.strictEqual(result.payload.ok, true);
    assert.strictEqual(result.payload.dinners.length, 2);
    assert.strictEqual(result.payload.dinners[0].sourceRecipe, replacement.sourceRecipe);
    assert.strictEqual(result.payload.dinners[1].sourceRecipe, retained.sourceRecipe);
    assert(!result.payload.dinners.some((entry) => entry.sourceRecipe === replaced.sourceRecipe));
  });
  const c = client();
  await c.context.loadPreferences();
  await check("adding a diet retains an existing allergy", () => {
    c.run('state.constraints.diet = "peanut allergy"; parseMessage("I am vegetarian");');
    assert(c.run('state.constraints.diet.includes("peanut allergy")'));
  });
  await check("clearing ordinary diets retains allergies", () => {
    c.run('state.constraints.diet = "peanut allergy, vegetarian"; parseMessage("not vegetarian anymore");');
    assert.strictEqual(c.run("state.constraints.diet"), "peanut allergy");
  });
  await check("a preferences outage cannot erase stored allergies", () => {
    c.run('PREFERENCES.diets=[];state.constraints.diet="peanut allergy";parseMessage("clear my diet");');
    assert.strictEqual(c.run("state.constraints.diet"), "peanut allergy");
    c.context.restoreDiets = dietOptions();
    c.run("PREFERENCES.diets=restoreDiets");
  });
  await check("sample pantry preserves dietary restrictions", () => {
    const build = c.context.buildPlan; c.context.buildPlan = async () => {};
    c.run('state.pantry = []; state.constraints.diet = "peanut allergy"; loadSamplePantry();');
    c.context.buildPlan = build;
    assert.strictEqual(c.run("state.constraints.diet"), "peanut allergy");
  });
  await check("removing the only appliance does not invent another", () => {
    c.run('state.constraints.equipment = ["microwave"]; parseMessage("I do not have a microwave");');
    assert.strictEqual(c.run("state.constraints.equipment.length"), 0);
  });
  await check("malformed imported records cannot crash renderers", () => {
    c.run('state = normaliseState({pantry:[null,{name:7}], savedRecipes:[null,{title:"x",timeMin:"<img src=x onerror=alert(1)>"}]}); renderPantry(); renderSavedRecipes();');
    assert(!c.node("savedRecipeList").innerHTML.includes("<img"));
  });
  await check("non-HTTP recipe links are discarded", () => {
    c.run('state = normaliseState({savedRecipes:[{title:"x",sourceRecipe:"x",source:"x",sourceUrl:"javascript:alert(1)"}]});');
    assert(!c.run('JSON.stringify(state.savedRecipes)').includes("javascript:"));
  });
  await check("plan without leftovers renders, item counts sum quantities", () => {
    c.run('state=clone(DEFAULT_STATE);state.plan={dinners:[{title:"Test",steps:[]}],shoppingList:[{item:"eggs",qty:2}],leftovers:[]};renderPlan();');
    assert(!c.node("shoppingList").innerHTML.includes("uses "));
    assert(!c.node("shoppingList").innerHTML.includes("packPrice"));
    assert(c.node("tripLabel").textContent.startsWith("2 items"));
  });
  await check("use-first text only claims actual pantry use", () => {
    c.run('state.pantry=[{name:"rice",soon:true}];renderPlan();');
    assert(!c.node("planLogic").textContent.includes("used first"));
  });
  await check("importing plan groceries twice is idempotent", () => {
    c.run('state.groceryList=[];renderGroceryList();');
    c.node("fromPlanButton").click(); c.node("fromPlanButton").click();
    assert.strictEqual(c.run("state.groceryList[0].qty"), 2);
  });
  await check("the plan panel's add-to-shop button fills the same list", () => {
    c.run('state=clone(DEFAULT_STATE);state.plan={dinners:[{title:"T",steps:[]}],shoppingList:[{item:"eggs",qty:2,sharedBy:[]},{item:"rice",qty:1,sharedBy:[]}]};state.groceryList=[];renderGroceryList();');
    assert.strictEqual(c.node("planShopButton").disabled, false);
    c.node("planShopButton").click();
    assert.strictEqual(c.run("state.groceryList.map(i => i.name + ':' + i.qty).join(',')"), "eggs:2,rice:1");
    c.run('state.plan=null;renderGroceryList();');
    assert.strictEqual(c.node("planShopButton").disabled, true);
  });
  await check("nav buttons switch the visible pane", () => {
    c.node("nav-plan").click();
    assert.strictEqual(c.run("document.body.dataset.view"), "plan");
    c.node("nav-grocery").click();
    assert.strictEqual(c.run("document.body.dataset.view"), "grocery");
    c.node("nav-chat").click();
    assert.strictEqual(c.run("document.body.dataset.view"), "chat");
  });
  await check("nav clicks switch the visible pane", () => {
    c.node("nav-plan").click();
    assert.strictEqual(c.run("document.body.dataset.view"), "plan");
    c.node("nav-grocery").click();
    assert.strictEqual(c.run("document.body.dataset.view"), "grocery");
    c.node("nav-chat").click();
    assert.strictEqual(c.run("document.body.dataset.view"), "chat");
  });
  await check("editing groceries invalidates old comparison", () => {
    c.node("groceryResults").innerHTML = "old price";
    c.node("groceryList").handlers.click({ target: { closest: () => ({ dataset: { index: "0", groceryAction: "more" } }) } });
    assert(!c.node("groceryResults").innerHTML.includes("old price"));
  });
  await check("cook again removes the chosen recipe from exclusions", () => {
    c.run('state.savedRecipes=[{title:"Microwave Potato",sourceRecipe:"Microwave Potato"}];state.excludedTitles=["Microwave Potato"];');
    const build = c.context.buildPlan;
    c.context.buildPlan = async () => {};
    c.node("savedRecipeList").handlers.click({ target: { closest: () => ({ dataset: { index: "0", savedAction: "cook" } }) } });
    assert.strictEqual(c.run("state.excludedTitles.length"), 0);
    assert.strictEqual(c.run("planningOptions.includeRecipe"), "Microwave Potato");
    c.run("planningOptions={}"); c.context.buildPlan = build;
  });
  await check("comparison replies arriving after an edit are discarded", async () => {
    let finish;
    c.context.fetch = () => new Promise((resolve) => { finish = resolve; });
    const request = c.context.compareStores();
    c.node("groceryList").handlers.click({ target: { closest: () => ({ dataset: { index: "0", groceryAction: "more" } }) } });
    const message = c.node("groceryResults").innerHTML;
    finish({ ok: true, json: async () => ({ ok: true, options: [], note: "stale response" }) });
    await request;
    assert.strictEqual(c.node("groceryResults").innerHTML, message);
  });
  await check("the chat can send the meal plan list to Shop", async () => {
    c.run('state=clone(DEFAULT_STATE);state.plan={dinners:[{title:"T",steps:[]}],shoppingList:[{item:"black beans",qty:2,sharedBy:[]},{item:"rice",qty:1,sharedBy:[]}],leftovers:[]};state.groceryList=[];');
    const originalInterpret = c.context.interpretMessage;
    c.context.interpretMessage = async () => ({ actions: [], requestPlan: false, planToShop: true, clarification: "", swapIndex: null });
    await c.context.handleMessage("add the list to shop");
    c.context.interpretMessage = originalInterpret;
    assert.strictEqual(c.run("state.groceryList.map(i => i.name + ':' + i.qty).join(',')"), "black beans:2,rice:1");
  });
  await check("chat pantry updates store names, never amounts", () => {
    c.run('state.pantry=[]; applyChatActions([{type:"pantry_set",name:"eggs",qty:1,soon:false},{type:"pantry_set",name:"spinach",qty:1,soon:true}]);');
    assert.strictEqual(c.run('state.pantry[0].name'), "eggs");
    assert.strictEqual(c.run('state.pantry[0].amount'), undefined);
    assert.strictEqual(c.run('state.pantry[1].soon'), true);
  });
  await check("newest suggestions win, with their own captured constraints", async () => {
    c.run('state=clone(DEFAULT_STATE);');
    const pending = [];
    c.context.fetch = (_, options) => new Promise((resolve) => pending.push({ resolve, body: JSON.parse(options.body) }));
    const first = c.context.buildPlan("old"); c.run('state.constraints.diet="vegan"'); const second = c.context.buildPlan("new");
    const response = (title) => ({ ok: true, status: 200, json: async () => ({ ok: true, dinners: [{
      title,
      sourceRecipe: title,
      source: "Budget Bytes",
      sourceUrl: `https://www.budgetbytes.com/${title.toLowerCase().replaceAll(" ", "-")}/`,
      timeMin: 10,
      equip: ["microwave"],
      usesPantry: [],
      needs: ["rice"],
      steps: ["Warm the rice in a microwave-safe bowl."]
    }], shoppingList: [], leftovers: [], totalCost: 0 }) });
    pending[1].resolve(response("new")); await second; pending[0].resolve(response("old")); await first;
    assert.strictEqual(c.run("state.plan"), null);
    assert.strictEqual(c.run("state.suggestions[0].title"), "new");
    assert.strictEqual(c.run("state.suggestionConstraints.diet"), "vegan");
  });
  await check("verified recipe suggestions render as escaped, credited chat cards", async () => {
    c.run('state=clone(DEFAULT_STATE);');
    c.node("messages").innerHTML = "";
    c.context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, dinners: [{
      title: "Choice <one>",
      sourceRecipe: "Published <Recipe>",
      source: "Budget Bytes",
      sourceUrl: "https://www.budgetbytes.com/published-recipe/",
      timeMin: 10,
      equip: ["microwave"],
      usesPantry: ["rice"],
      needs: ["spinach"],
      steps: ["<script>first()</script>", "Serve & enjoy"]
    }], shoppingList: [], leftovers: [], totalCost: 0 }) });
    await c.context.buildPlan();
    const markup = c.node("messages").innerHTML;
    assert(markup.includes('<article class="suggestion-card">'));
    assert(markup.includes('data-suggestion-action="add"') && markup.includes("Add to Plan"));
    assert(markup.includes('href="https://www.budgetbytes.com/published-recipe/"') && markup.includes("Credit: Published &lt;Recipe&gt; by Budget Bytes."));
    const firstStep = markup.indexOf("&lt;script&gt;first()&lt;/script&gt;");
    const secondStep = markup.indexOf("Serve &amp; enjoy");
    assert(firstStep >= 0 && secondStep > firstStep && !markup.includes("<script>first()</script>"));
  });
  await check("recipe suggestions work without structuredClone support", async () => {
    c.context.structuredClone = undefined;
    c.context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, dinners: [{
      title: "legacy browser",
      sourceRecipe: "Legacy Browser Recipe",
      source: "Budget Bytes",
      sourceUrl: "https://www.budgetbytes.com/legacy-browser-recipe/",
      timeMin: 10,
      equip: ["microwave"],
      usesPantry: [],
      needs: ["rice"],
      steps: ["Warm the rice in a microwave-safe bowl."]
    }], shoppingList: [], leftovers: [], totalCost: 0 }) });
    await c.context.buildPlan();
    assert.strictEqual(c.run("state.plan"), null);
    assert.strictEqual(c.run("state.suggestions[0].title"), "legacy browser");
    assert.strictEqual(c.context.addSuggestedDinnerToPlan(0), true);
    assert.strictEqual(c.run("state.plan.dinners[0].title"), "legacy browser");
    assert.strictEqual(c.run("state.plan.shoppingList[0].item"), "rice");
  });
  if (failed.length) throw new Error(`${failed.length} regression checks failed: ${failed.join("; ")}`);
  return count;
}
module.exports = run;
if (require.main === module) run().catch((e) => { console.error(e.message); process.exitCode = 1; });

module.exports.client = client;
