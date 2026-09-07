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
      remove() {}, focus() {}, setAttribute() {}, scrollTo() {}, click() { return this.handlers.click?.({ target: this }); },
      querySelector() { return node("child"); }, querySelectorAll() { return []; }, closest() { return this; }
    };
    nodes.set(id, el);
    return el;
  };
  const storage = { value: JSON.stringify({ profile: { onboarded: true } }) };
  const context = { console, URL, Intl, AbortController, structuredClone,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: (fn) => fn(),
    document: { getElementById: node, querySelector: () => node("query"), querySelectorAll: () => [], createElement: () => node(`new-${nodes.size}`), addEventListener() {}, body: node("body") },
    window: { matchMedia: () => ({ matches: false }), confirm: () => true, location: { reload() {} }, setTimeout: () => 0 },
    localStorage: { getItem: () => storage.value, setItem: (_, value) => { storage.value = value; } },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => url === "/api/preferences" ? { ok: true, diets: server.DIET_OPTIONS, equipment: server.EQUIPMENT_OPTIONS, limits: { budget: { min: 5, max: 100 } } } : { ok: true } })
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("public/app.js", "utf8"), context);
  return { context, node, run: (code) => vm.runInContext(code, context) };
}
function dinner(title = "Microwave Potato") {
  const r = server.APPROVED_RECIPES.find((entry) => entry.title === title);
  return { title, sourceRecipe: r.title, source: r.source, sourceUrl: r.url, timeMin: r.timeMin,
    usesPantry: [], needs: [...r.ingredients], steps: [r.method] };
}
const envelope = (dinners) => ({ ok: true, data: { choices: [{ message: { content: JSON.stringify({ dinners }) } }] } });
async function plan(body, dinners) {
  let output;
  const res = { code: 200, status(n) { this.code = n; return this; }, json(payload) { output = { status: this.code, payload }; } };
  await server.handlePlanRequest({ body: { pantry: [], dinners: dinners.length, maxTimeMin: 30, equipment: ["microwave"], ...body } }, res, { chat: async () => envelope(dinners) });
  return output;
}

async function run() {
  let count = 0;
  const failed = [];
  async function check(name, fn) {
    try { await fn(); count++; console.log(`fix ok - ${name}`); }
    catch (error) { failed.push(name); console.error(`fix FAIL - ${name}: ${error.message}`); }
  }
  await check("pricing never substitutes dairy milk for almond milk", () => assert.strictEqual(server.findPrice("almond milk"), null));
  await check("equipment mismatch is rejected", async () => {
    const result = await plan({}, [dinner("Peanut Butter Banana Quesadillas")]);
    assert.strictEqual(result.payload.ok, false);
  });
  await check("known recipe IDs supply exact citations", async () => {
    const d = dinner(); d.recipeId = `recipe-${server.APPROVED_RECIPES.findIndex((r) => r.url === d.sourceUrl) + 1}`;
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
  await check("unknown items prevent whole-list claims", () => {
    assert(server.optimizeCart({ items: ["eggs", "dragonfruit"] }).options.every((o) => !o.complete && o.missing.includes("dragonfruit")));
  });
  await check("checkout uses one store's prices", () => {
    const p = server.groundShoppingPlan({ dinners: [{ title: "Test", needs: ["eggs", "tamari"] }] });
    assert.strictEqual(new Set(p.shoppingList.map((i) => i.store)).size, 1);
    assert.strictEqual(p.totalCost, 6.78);
  });
  await check("vegan outputs never price a dairy substitute as milk", async () => {
    const d = dinner("Peanut Butter Banana Smoothie");
    d.needs = ["banana", "peanut butter", "almond milk"];
    d.steps = ["Blend banana, peanut butter and almond milk."];
    const result = await plan({ diet: "vegan", equipment: ["blender"] }, [d]);
    assert.strictEqual(result.payload.ok, false);
    assert(!result.payload.shoppingList);
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
    c.context.restoreDiets = server.DIET_OPTIONS;
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
  await check("plan without leftovers renders, package counts sum quantities", () => {
    c.run('state=clone(DEFAULT_STATE);state.plan={dinners:[{title:"Test",steps:[]}],shoppingList:[{item:"eggs",qty:2,packPrice:3}],leftovers:[],totalCost:6};renderPlan();');
    assert(!c.node("shoppingList").innerHTML.includes("uses "));
    assert(c.node("tripLabel").textContent.startsWith("2 packages"));
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
  await check("chat pantry updates store names, never amounts", () => {
    c.run('state.pantry=[]; applyChatActions([{type:"pantry_set",name:"eggs",qty:1,soon:false},{type:"pantry_set",name:"spinach",qty:1,soon:true}]);');
    assert.strictEqual(c.run('state.pantry[0].name'), "eggs");
    assert.strictEqual(c.run('state.pantry[0].amount'), undefined);
    assert.strictEqual(c.run('state.pantry[1].soon'), true);
  });
  await check("newest plan wins, with its own captured constraints", async () => {
    c.run('state=clone(DEFAULT_STATE);');
    const pending = [];
    c.context.fetch = (_, options) => new Promise((resolve) => pending.push({ resolve, body: JSON.parse(options.body) }));
    const first = c.context.buildPlan("old"); c.run('state.constraints.diet="vegan"'); const second = c.context.buildPlan("new");
    const response = (title) => ({ ok: true, status: 200, json: async () => ({ ok: true, dinners: [{title,steps:[]}], shoppingList: [], leftovers: [], totalCost: 0 }) });
    pending[1].resolve(response("new")); await second; pending[0].resolve(response("old")); await first;
    assert.strictEqual(c.run("state.plan.dinners[0].title"), "new");
    assert.strictEqual(c.run("state.plan.constraints.diet"), "vegan");
  });
  await check("plan succeeds without structuredClone support", async () => {
    c.context.structuredClone = undefined;
    c.context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, dinners: [{ title: "legacy browser", steps: [] }], shoppingList: [], leftovers: [], totalCost: 0 }) });
    await c.context.buildPlan();
    assert.strictEqual(c.run("state.plan.dinners[0].title"), "legacy browser");
  });
  if (failed.length) throw new Error(`${failed.length} regression checks failed: ${failed.join("; ")}`);
  return count;
}
module.exports = run;
if (require.main === module) run().catch((e) => { console.error(e.message); process.exitCode = 1; });

module.exports.client = client;
