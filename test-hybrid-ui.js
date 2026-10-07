const assert = require("assert");
const { client } = require("./test-fixes");

const plain = (value) => JSON.parse(JSON.stringify(value));

async function run() {
  let count = 0;
  const failed = [];
  async function check(name, fn) {
    try {
      await fn();
      count++;
      console.log(`hybrid UI ok - ${name}`);
    } catch (error) {
      failed.push(name);
      console.error(`hybrid UI FAIL - ${name}: ${error.message}`);
    }
  }

  await check("generated suggestions are accepted without a source URL and stay source-free", () => {
    const c = client();
    const meal = {
      title: "AI <created> eggs", provenanceType: "generated", timeMin: 18, timeIsEstimate: true,
      source: "Untrusted Publisher", sourceRecipe: "Fake Source", sourceUrl: "https://example.test/recipe",
      equip: ["microwave"], usesPantry: ["eggs"], needs: ["bread"], steps: ["Toast the bread.", "Cook the eggs."]
    };
    const safe = plain(c.run(`safeSuggestionMeal(${JSON.stringify(meal)})`));
    assert.strictEqual(safe.provenanceType, "generated");
    assert.strictEqual(safe.sourceUrl, "");
    assert.strictEqual(safe.source, "");
    assert.strictEqual(safe.sourceRecipe, "");
    assert.strictEqual(safe.sourceUnavailable, false);
    assert.strictEqual(safe.timeIsEstimate, true);
    assert.deepStrictEqual(safe.steps, meal.steps);
  });

  await check("recipe batches keep their chat position across followups, rerenders, reload, and stale clicks", () => {
    const c = client();
    const first = {
      title: "First batch bean potato", provenanceType: "generated", timeMin: 15, timeIsEstimate: true,
      equip: ["microwave"], usesPantry: ["potatoes"], needs: ["canned beans"],
      steps: ["Microwave the potato until tender.", "Top it with warmed canned beans."]
    };
    const second = {
      title: "Second batch spinach rice", provenanceType: "generated", timeMin: 15, timeIsEstimate: true,
      equip: ["microwave"], usesPantry: ["spinach"], needs: ["ready-to-heat rice"],
      steps: ["Heat ready-to-heat rice until steaming.", "Serve with warmed spinach."]
    };
    const secondAlternative = { ...second, title: "Second batch tomato rice" };
    const configure = (meals) => c.run(`state.constraints = { budget: 20, dinners: 3, maxTimeMin: 20, equipment: ["microwave"], diet: "" }; state.suggestions = ${JSON.stringify(meals)}; state.suggestionConstraints = JSON.parse(JSON.stringify(state.constraints)); state.suggestionPantry = []; state.suggestionOffLimitsPantry = []; state.suggestionSwap = null;`);
    configure([first]);
    c.context.addAssistantMessage("The first recipes are ready.", "", { suggestions: [first] });
    c.context.renderRecipeSuggestions();
    c.context.addUserMessage("I'm not feeling these ones. Give me another one.");
    c.context.renderPantry();
    c.context.renderProfile();
    c.context.renderPlan();
    configure([second, secondAlternative]);
    c.context.addAssistantMessage("Here is another recipe set.", "", { suggestions: [second, secondAlternative] });
    c.context.renderRecipeSuggestions();

    const host = c.node("messages");
    const messageMarkup = () => host.children.map((child) => String(child.innerHTML || ""));
    const orderedMarkup = messageMarkup();
    const firstIntroIndex = orderedMarkup.findIndex((markup) => markup.includes("The first recipes are ready."));
    const firstCardIndex = orderedMarkup.findIndex((markup) => markup.includes(first.title));
    const followupIndex = orderedMarkup.findIndex((markup) => markup.includes("not feeling these ones."));
    const secondResponseIndex = orderedMarkup.findIndex((markup) => markup.includes("Here is another recipe set."));
    const secondCardIndex = orderedMarkup.findIndex((markup) => markup.includes(second.title));
    const secondAlternativeIndex = orderedMarkup.findIndex((markup) => markup.includes(secondAlternative.title));
    assert(firstIntroIndex >= 0 && firstCardIndex === firstIntroIndex);
    assert(followupIndex > firstCardIndex);
    assert(secondResponseIndex > followupIndex && secondCardIndex === secondResponseIndex);
    assert(secondAlternativeIndex === secondCardIndex);
    assert.strictEqual((orderedMarkup.join("\n").match(/id="recipeSuggestions"/g) || []).length, 0);
    assert.strictEqual(new Set(c.run("state.messages.map((message) => message.id)")).size, c.run("state.messages.length"));
    assert(orderedMarkup[firstIntroIndex].includes("disabled"));
    assert(!orderedMarkup[secondCardIndex].includes("disabled"));

    const firstBatchId = c.run("state.messages.find((message) => message.text === 'The first recipes are ready.').id");
    const secondBatchId = c.run("state.messages.find((message) => message.text === 'Here is another recipe set.').id");
    const clickSuggestion = (batchId, index) => host.handlers.click({ target: {
      disabled: false,
      dataset: { index: String(index), suggestionMessage: batchId },
      closest(selector) { return selector === "[data-suggestion-action]" ? this : null; }
    } });
    clickSuggestion(firstBatchId, 0);
    assert.strictEqual(c.run("state.plan"), null);
    clickSuggestion(secondBatchId, 0);
    assert.strictEqual(c.run("state.plan.dinners[0].title"), second.title);
    clickSuggestion(secondBatchId, 1);
    assert.strictEqual(c.run("state.plan.dinners[1].title"), secondAlternative.title);

    const replacement = { ...first, title: "Replacement bean potato" };
    c.run(`state.plan = { ...state.plan, dinners: [{ title: "Original dinner", sourceRecipe: "Original dinner", source: "Example", sourceUrl: "https://example.org/original", timeMin: 10, equip: ["microwave"], needs: ["rice"], steps: ["Warm rice."] }] }; state.suggestionSwap = { index: 0, originalRecipe: recipeKey(state.plan.dinners[0]) }; state.suggestions = [${JSON.stringify(replacement)}];`);
    c.context.addAssistantMessage("Here is a replacement option.", "", { suggestions: [replacement] });
    const replaceBatchId = c.run("state.messages.at(-1).id");
    const latestPanel = messageMarkup().at(-1);
    assert(latestPanel.includes('data-suggestion-action="replace"') && !latestPanel.includes("disabled"));
    clickSuggestion(replaceBatchId, 0);
    assert.strictEqual(c.run("state.plan.dinners[0].title"), replacement.title);

    const stored = c.context.localStorage.getItem("fridgefuse-state-v2");
    const restored = client(stored);
    const restoredMarkup = restored.node("messages").children.map((child) => String(child.innerHTML || ""));
    const restoredFollowup = restoredMarkup.findIndex((markup) => markup.includes("not feeling these ones."));
    const restoredFirst = restoredMarkup.findIndex((markup) => markup.includes(first.title));
    const restoredSecond = restoredMarkup.findIndex((markup) => markup.includes(second.title));
    const restoredReplacement = restoredMarkup.findIndex((markup) => markup.includes(replacement.title));
    assert(restoredFirst < restoredFollowup && restoredSecond > restoredFollowup && restoredReplacement > restoredFollowup);

    const legacyStorage = JSON.stringify({
      profile: { onboarded: true }, constraints: { budget: 20, dinners: 1, maxTimeMin: 20, equipment: ["microwave"], diet: "" },
      suggestions: [first],
      messages: [
        { role: "assistant", text: "Here are 3 dinner suggestions.", supportingText: "Add the dinners you want to Plan." },
        { role: "user", text: "I'm not feeling these ones. Give me another one." },
        { role: "assistant", text: "AI recipe response rejected", tone: "error" }
      ]
    });
    const migratedClient = client(legacyStorage);
    const migrated = migratedClient.node("messages").children.map((child) => String(child.innerHTML || ""));
    const migratedCards = migrated.findIndex((markup) => markup.includes(first.title));
    const migratedFollowup = migrated.findIndex((markup) => markup.includes("not feeling these ones."));
    const migratedError = migrated.findIndex((markup) => markup.includes("AI recipe response rejected"));
    assert(migratedCards < migratedFollowup && migratedFollowup < migratedError);
    assert(!migrated[migratedError].includes(first.title));
    assert.strictEqual(migratedClient.run("state.messages.length"), 3);
    assert.strictEqual(migratedClient.run("state.suggestions[0].title"), first.title);
  });

  await check("three distinct generated suggestions can be added, saved, and normalized", async () => {
    const c = client();
    const meals = [
      { title: "Egg toast", provenanceType: "generated", timeMin: 18, equip: ["microwave"], usesPantry: ["eggs"], needs: ["bread"], steps: ["Warm the bread.", "Cook the eggs."] },
      { title: "Lentil soup", provenanceType: "generated", timeMin: 20, equip: ["stove"], usesPantry: ["lentils"], needs: ["onions"], steps: ["Simmer the lentils and onions."] },
      { title: "Ketchup rice bowl", provenanceType: "generated", timeMin: 15, equip: ["microwave"], usesPantry: ["rice"], needs: ["eggs"], steps: ["Warm the rice.", "Top with eggs and ketchup."] }
    ];
    c.run(`state.constraints = { budget: 20, dinners: 3, maxTimeMin: 20, equipment: ["microwave", "stove"], diet: "" }; state.suggestions = ${JSON.stringify(meals)}; state.suggestionConstraints = JSON.parse(JSON.stringify(state.constraints)); state.suggestionPantry = []; state.suggestionOffLimitsPantry = []; state.suggestionSwap = null;`);
    assert.strictEqual(c.context.addSuggestedDinnerToPlan(0), true);
    assert.strictEqual(c.context.addSuggestedDinnerToPlan(1), true);
    assert.strictEqual(c.context.addSuggestedDinnerToPlan(2), true);
    assert.strictEqual(c.run("state.plan.dinners.length"), 3);
    c.run("toggleSavedRecipe(state.plan.dinners[0])");
    const restored = plain(c.run("normaliseState(JSON.parse(localStorage.getItem('fridgefuse-state-v2')))"));
    assert.strictEqual(restored.plan.dinners.length, 3);
    assert.strictEqual(restored.plan.dinners[0].provenanceType, "generated");
    assert.strictEqual(restored.plan.dinners[0].timeIsEstimate, true);
    assert.deepStrictEqual(restored.plan.dinners[0].steps, meals[0].steps);
    assert.strictEqual(restored.savedRecipes[0].provenanceType, "generated");
    assert.deepStrictEqual(restored.savedRecipes[0].needs, meals[0].needs);

    let exportedText = "";
    c.context.Blob = class { constructor(parts) { exportedText = parts[0]; } };
    c.context.URL = { createObjectURL: () => "blob:hybrid-test", revokeObjectURL() {} };
    c.context.exportKitchen();
    const exported = JSON.parse(exportedText);
    assert.strictEqual(exported.format, "fridgefuse.kitchen");
    assert.strictEqual(exported.state.savedRecipes[0].provenanceType, "generated");
    assert.deepStrictEqual(exported.state.savedRecipes[0].steps, meals[0].steps);
    await c.context.importKitchen({ size: exportedText.length, text: async () => exportedText });
    const imported = JSON.parse(c.context.localStorage.getItem("fridgefuse-state-v2"));
    assert.strictEqual(imported.plan.dinners[0].provenanceType, "generated");
    assert.strictEqual(imported.savedRecipes[0].timeIsEstimate, true);
    assert.deepStrictEqual(imported.savedRecipes[0].steps, meals[0].steps);
  });

  await check("swapping a generated dinner keeps its provenance, estimate, ingredients, and directions", () => {
    const c = client();
    const oldMeal = { title: "Old sourced dinner", sourceRecipe: "Old recipe", source: "Example", sourceUrl: "https://example.org/old", timeMin: 10, equip: ["microwave"], usesPantry: [], needs: ["rice"], steps: ["Warm rice."] };
    const replacement = { title: "AI lentil bowl", provenanceType: "generated", timeMin: 19, equip: [], usesPantry: ["lentils"], needs: ["onions"], steps: ["Add lentils and onions.", "Heat until soft."] };
    c.run(`state.constraints = { budget: 20, dinners: 1, maxTimeMin: 20, equipment: ["microwave"], diet: "" }; state.plan = { dinners: [${JSON.stringify(oldMeal)}], constraints: JSON.parse(JSON.stringify(state.constraints)), shoppingList: [] }; state.suggestions = [safeSuggestionMeal(${JSON.stringify(replacement)})]; state.suggestionConstraints = JSON.parse(JSON.stringify(state.constraints)); state.suggestionPantry = []; state.suggestionOffLimitsPantry = []; state.suggestionSwap = { index: 0, originalRecipe: recipeKey(state.plan.dinners[0]) };`);
    assert.strictEqual(c.context.addSuggestedDinnerToPlan(0), true);
    const swapped = plain(c.run("state.plan.dinners[0]"));
    assert.strictEqual(swapped.provenanceType, "generated");
    assert.strictEqual(swapped.timeIsEstimate, true);
    assert.deepStrictEqual(swapped.needs, replacement.needs);
    assert.deepStrictEqual(swapped.steps, replacement.steps);
    assert.strictEqual(swapped.sourceUrl, "");
    c.context.renderPlan();
    assert(c.node("mealList").innerHTML.includes("no cooking equipment"));
  });

  await check("recipe identity survives pantry reconciliation and distinguishes adaptations", () => {
    const c = client();
    const generatedA = { title: "Egg toast", provenanceType: "generated", usesPantry: ["eggs"], needs: ["bread"], steps: ["Toast bread."] };
    const generatedB = { ...generatedA, usesPantry: ["bread"], needs: ["eggs"] };
    const adaptedA = { title: "Pantry lentil bowl", provenanceType: "adapted", sourceUrl: "https://example.org/lentils", needs: ["lentils"], steps: ["Simmer lentils."] };
    const adaptedB = { ...adaptedA, title: "Quick lentil soup", steps: ["Simmer lentils with water."] };
    c.context.identityFixtures = { generatedA, generatedB, adaptedA, adaptedB };
    assert.strictEqual(c.run("recipeKey(identityFixtures.generatedA)"), c.run("recipeKey(identityFixtures.generatedB)"));
    assert.notStrictEqual(c.run("recipeKey(identityFixtures.adaptedA)"), c.run("recipeKey(identityFixtures.adaptedB)"));
  });

  await check("adapted source credit, attribution, directions, and estimate survive saved-recipe cooking", async () => {
    const c = client();
    const adapted = {
      title: "Adapted lentil skillet", provenanceType: "adapted", timeMin: 19, timeIsEstimate: true,
      sourceRecipe: "Original lentil bowl", source: "Example Kitchen", sourceUrl: "https://example.org/lentils",
      sourceUsageMode: "publisher-directions-with-link-credit", sourceRightsStatus: "review-pending",
      sourceCredit: "Adapted from Example Kitchen's lentil bowl", sourceAttribution: "Required source credit", sourceLicense: "Source license notice",
      adaptationNote: "AI adapted the method for a microwave.", equip: ["microwave"], usesPantry: ["lentils"], needs: ["onions"],
      steps: ["Add lentils and water to a microwave-safe bowl.", "Heat until tender."]
    };
    c.run(`state.plan = { dinners: [${JSON.stringify(adapted)}], constraints: { budget: 20, dinners: 1, maxTimeMin: 20, equipment: ["microwave"], diet: "" }, shoppingList: [] }; state.savedRecipes = [${JSON.stringify(adapted)}]; renderPlan(); renderSavedRecipes();`);
    const planHtml = c.node("mealList").innerHTML;
    const savedHtml = c.node("savedRecipeList").innerHTML;
    assert(planHtml.includes("AI adapted recipe"));
    assert(planHtml.includes('href="https://example.org/lentils"'));
    assert(planHtml.includes("Required source credit"));
    assert(planHtml.includes("Adapted from Example Kitchen&#039;s lentil bowl"));
    assert(planHtml.includes("AI-authored directions adapt this linked source recipe."));
    assert(!planHtml.includes("Publisher directions are shown"));
    assert(planHtml.includes("19 min · estimated"));
    assert(savedHtml.includes("AI adapted recipe"));
    assert(savedHtml.includes("AI adapted the method for a microwave."));
    assert(savedHtml.includes("Heat until tender."));

    let sentBody;
    let signalRequest;
    const requestStarted = new Promise((resolve) => { signalRequest = resolve; });
    c.context.fetch = async (url, init) => {
      if (url === "/api/plan") {
        sentBody = JSON.parse(init.body);
        signalRequest();
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, dinners: [adapted], shoppingList: [] }) };
    };
    const button = { dataset: { savedAction: "cook", index: "0" } };
    c.node("savedRecipeList").handlers.click({ target: { closest: () => button } });
    await requestStarted;
    assert.strictEqual(sentBody.includeMeal.provenanceType, "adapted");
    assert.strictEqual(sentBody.includeMeal.sourceRecipe, adapted.sourceRecipe);
    assert.strictEqual(sentBody.includeMeal.sourceUrl, adapted.sourceUrl);
    assert.deepStrictEqual(sentBody.includeMeal.steps, adapted.steps);
    assert.deepStrictEqual(sentBody.includeMeal.needs, adapted.needs);
    assert.strictEqual(sentBody.includeMeal.adaptationNote, adapted.adaptationNote);
    assert.strictEqual(sentBody.includeRecipe, adapted.sourceRecipe);
  });

  await check("cooking a saved generated recipe sends its full meal without a source citation", async () => {
    const c = client();
    const generated = {
      title: "Saved egg rice", provenanceType: "generated", timeMin: 18, timeIsEstimate: true,
      equip: ["microwave"], usesPantry: ["eggs"], needs: ["rice"], steps: ["Warm rice.", "Add cooked eggs."]
    };
    c.run(`state.savedRecipes = [${JSON.stringify(generated)}];`);
    let sentBody;
    let signalRequest;
    const requestStarted = new Promise((resolve) => { signalRequest = resolve; });
    c.context.fetch = async (url, init) => {
      if (url === "/api/plan") {
        sentBody = JSON.parse(init.body);
        signalRequest();
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, dinners: [generated], shoppingList: [] }) };
    };
    const button = { dataset: { savedAction: "cook", index: "0" } };
    c.node("savedRecipeList").handlers.click({ target: { closest: () => button } });
    await requestStarted;
    assert.strictEqual(sentBody.includeMeal.provenanceType, "generated");
    assert.strictEqual(sentBody.includeMeal.title, generated.title);
    assert.deepStrictEqual(sentBody.includeMeal.steps, generated.steps);
    assert.deepStrictEqual(sentBody.includeMeal.usesPantry, generated.usesPantry);
    assert.strictEqual(sentBody.includeMeal.timeIsEstimate, true);
    assert.strictEqual(sentBody.includeRecipe, undefined);
  });

  await check("generated recipe labels are escaped and never render a supplied source link", () => {
    const c = client();
    const generated = {
      title: "<script>alert(1)</script>", provenanceType: "generated", timeMin: 17,
      source: "Unsafe", sourceRecipe: "Unsafe", sourceUrl: "https://unsafe.example/recipe",
      equip: ["microwave"], usesPantry: ["rice"], needs: [], steps: ["Warm <rice> safely."]
    };
    const safe = plain(c.run(`safeSuggestionMeal(${JSON.stringify(generated)})`));
    c.run(`state.suggestions = [${JSON.stringify(safe)}]; state.suggestionConstraints = state.constraints; state.suggestionPantry = [];`);
    c.context.addAssistantMessage("Here is a generated recipe.", "", { suggestions: [safe] });
    const html = c.node("messages").children.map((child) => String(child.innerHTML || "")).join("\n");
    assert(html.includes("AI-created recipe"));
    assert(html.includes("17 minutes · estimated"));
    assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert(!html.includes('href="https://unsafe.example/recipe"'));
    assert(html.includes("Warm &lt;rice&gt; safely."));
  });

  if (failed.length) throw new Error(`${failed.length} hybrid UI checks failed: ${failed.join("; ")}`);
  return count;
}

module.exports = run;
if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
