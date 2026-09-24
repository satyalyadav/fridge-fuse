"use strict";

const assert = require("node:assert/strict");
const {
  createRcpRecipeDiscovery,
  categoryScore,
  normalizeMetadataItem,
  retryAfterMs,
  safeRecipeUrl,
  selectMetadataPages,
} = require("./lib/rcp-recipe-discovery");
const { isPublicRecipeUrl, recipeViolatesDiet } = require("./lib/live-recipes");
const {
  balancedKnownTimeSample,
  evaluateRecipeTimeInference,
  maskRecipeForInference,
} = require("./scripts/evaluate-recipe-inference");

const ORIGIN = "https://recipecontextprotocol.com";
const HOST = "recipecontextprotocol.com";
const safeAddress = [{ address: "93.184.216.34", family: 4 }];
let checks = 0;
const check = (condition, message) => {
  checks++;
  assert(condition, message);
};

function response(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const responseHeaders = { "content-length": String(Buffer.byteLength(text, "utf8")), ...headers };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => responseHeaders[String(name).toLowerCase()] || responseHeaders[name] || null },
    text: async () => text,
  };
}

function item(slug, options = {}) {
  return {
    slug,
    title: options.title || slug.split("-").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" "),
    description: options.description || "A simple dinner recipe.",
    categories: options.categories || ["Main course"],
    total_time_minutes: options.time ?? 20,
    source_name: options.sourceName || "Wikibooks Cookbook",
    license: options.license ?? "CC BY-SA 4.0",
    notice: options.notice ?? `Adapted from Wikibooks Cookbook, licensed CC BY-SA 4.0.`,
    url: options.url || `${ORIGIN}/recipes/${slug}`,
    ...options.raw,
  };
}

function candidate(slug, options = {}) {
  const url = `${ORIGIN}/recipes/${slug}`;
  return {
    title: item(slug).title,
    source: "Wikibooks Cookbook",
    publisher: "Wikibooks Cookbook",
    sourceUrl: url,
    finalUrl: url,
    timeMin: 20,
    equipment: ["stove"],
    ingredients: ["beans", "rice", "salt"],
    rawIngredients: ["beans", "rice", "salt"],
    instructions: ["Heat the beans and rice on the stove until hot."],
    rawInstructions: ["Heat the beans and rice on the stove until hot."],
    method: "Heat the beans and rice on the stove until hot.",
    license: "CC BY-SA 4.0",
    attribution: "Adapted from Wikibooks Cookbook, licensed CC BY-SA 4.0.",
    ...options,
  };
}

function createFixture({
  items = [item("bean-rice-skillet")],
  pageData = null,
  total = items.length,
  recipes = new Map(items.map((entry) => [entry.url, candidate(entry.slug, { title: entry.title })])),
  apiStatus = 200,
  apiHeaders = {},
  bodyCap = 512 * 1024,
  hostDelayMs = 1100,
  now = () => 1000,
  sleep = async () => {},
  verifyOverride = null,
  validateOverride = null,
} = {}) {
  const apiCalls = [];
  const apiStarts = [];
  const pageStarts = [];
  const verifiedUrls = [];
  const fakeValidate = async (value) => {
    if (validateOverride) return validateOverride(value);
    if (!isPublicRecipeUrl(value)) return { ok: false, failure: { status: "unsafe-url", message: "bad scheme" } };
    const url = new URL(value);
    if (url.hostname !== HOST) return { ok: false, failure: { status: "unsafe-url", message: "foreign host" } };
    return { ok: true, url };
  };
  const fetchImpl = async (value) => {
    const url = new URL(value);
    apiCalls.push(url);
    apiStarts.push(now());
    if (apiStatus !== 200) return response(apiStatus, { error: "fixture" }, apiHeaders);
    const page = Number(url.searchParams.get("page") || 1);
    const perPage = Number(url.searchParams.get("per_page") || 60);
    const entries = pageData ? pageData[page] || [] : page === 1 ? items : [];
    return response(200, { items: entries.slice(0, perPage), total, page, per_page: perPage }, { "content-type": "application/json" });
  };
  const verifyUrl = async (value, verifyOptions = {}) => {
    verifiedUrls.push(value);
    if (verifyOverride) return verifyOverride(value, verifyOptions, pageStarts);
    await verifyOptions.beforeFetch(value, 0);
    pageStarts.push(now());
    return { ok: true, recipe: recipes.get(value) || candidate(new URL(value).pathname.split("/").pop()) };
  };
  const service = createRcpRecipeDiscovery({
    sources: ["wikibooks"],
    fetchImpl,
    verifyUrl,
    validatePublicUrl: fakeValidate,
    maxApiBytes: bodyCap,
    hostDelayMs,
    now,
    sleep,
  });
  return { service, apiCalls, apiStarts, pageStarts, verifiedUrls, fakeValidate };
}

async function run() {
  check(safeRecipeUrl(`${ORIGIN}/recipes/a-b`)?.href === `${ORIGIN}/recipes/a-b`, "RCP recipe URLs must use the official HTTPS recipe path");
  check(!safeRecipeUrl("http://recipecontextprotocol.com/recipes/a") && !safeRecipeUrl("https://user:pass@recipecontextprotocol.com/recipes/a"), "HTTP and credential-bearing RCP URLs are rejected");
  check(!safeRecipeUrl("https://attacker.example/recipes/a") && !safeRecipeUrl(`${ORIGIN}/search?q=recipe`), "foreign hosts and non-recipe paths are rejected");
  check(normalizeMetadataItem(item("no-time", { raw: { total_time_minutes: null } })) === null, "metadata with unknown time cannot enter known-time selection");
  check(selectMetadataPages(594, 100, 3).join(",") === "1,4,6" && selectMetadataPages(594, 100, 6).join(",") === "1,2,3,4,5,6", "metadata sampling spreads across the index and can scan all six capped pages for a saved recipe");
  check(categoryScore(item("chocolate-cake", { categories: ["Dessert"] })) < categoryScore(item("bean-stew", { categories: ["Main course"] })), "meal categories rank above dessert leads");
  check(retryAfterMs("2", 1000) === 2000 && retryAfterMs(new Date(5000).toUTCString(), 1000) === 4000, "Retry-After seconds and date forms are parsed");

  const missingKnownTime = [
    item("null-time", { raw: { total_time_minutes: null } }),
    item("over-time", { time: 60 }),
    item("dessert-cake", { categories: ["Dessert"] }),
    item("valid-bean-stew", { title: "Weeknight Bean Stew", time: 24, categories: ["Main course"] }),
  ];
  const validMap = new Map([[missingKnownTime[3].url, candidate("valid-bean-stew", { title: "Weeknight Bean Stew", timeMin: 24 })]]);
  const known = createFixture({ items: missingKnownTime, total: missingKnownTime.length, recipes: validMap });
  const knownResult = await known.service.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"] });
  check(knownResult.ok && knownResult.candidates.length === 1, `known-time RCP metadata selects a recipe and fresh verification accepts it (${JSON.stringify(knownResult)})`);
  check(knownResult.metrics.apiRequests === 1 && knownResult.metrics.metadataItems === 4 && knownResult.metrics.knownTimeItems === 2, "metadata and known-time counts exclude unknown and over-limit items");
  check(known.verifiedUrls.length === 1 && known.verifiedUrls[0] === missingKnownTime[3].url, "unknown-time, too-slow, and dessert metadata are not fetched as dinner pages");
  check(knownResult.candidates[0].attribution.includes("Wikibooks") && knownResult.candidates[0].license === "CC BY-SA 4.0", "accepted candidates retain RCP attribution and license");

  const pageData = {
    1: [item("dish-a", { title: "Dish A" })],
    2: [item("dish-b", { title: "Dish B" })],
    3: [item("dish-c", { title: "Dish C" })],
    4: [item("dish-d", { title: "Dish D" })],
    5: [item("dish-e", { title: "Dish E" })],
    6: [item("requested-saved-recipe", { title: "Requested Saved Recipe" })],
  };
  const allUrls = new Map(Object.values(pageData).flat().map((entry) => [entry.url, candidate(entry.slug, { title: entry.title })]));
  const included = createFixture({ pageData, total: 594, recipes: allUrls });
  const includeResult = await included.service.findRecipes({
    dinners: 1,
    maxTimeMin: 30,
    equipment: ["stove"],
    includeRecipe: "Requested Saved Recipe",
  });
  check(includeResult.ok && includeResult.candidates.some((entry) => entry.title === "Requested Saved Recipe"), "saved title is searched across the bounded six-page metadata sample");
  check(included.apiCalls.length === 6 && included.apiCalls.every((url) => url.searchParams.get("per_page") === "100"), "saved-title discovery uses at most six official list calls at the maximum page size");

  const excludedPages = [
    item("dessert-a", { title: "Apple Cake", categories: ["Dessert"] }),
    item("dessert-b", { title: "Chocolate Pie", categories: ["Dessert"] }),
    item("excluded-a", { title: "No Thanks Stew" }),
    item("safe-a", { title: "Safe Bean Stew" }),
  ];
  const excluded = createFixture({
    items: excludedPages,
    recipes: new Map([[excludedPages[3].url, candidate("safe-a", { title: "Safe Bean Stew" })]]),
  });
  const excludeResult = await excluded.service.findRecipes({ dinners: 1, equipment: ["stove"], exclude: ["No Thanks Stew"] });
  check(excludeResult.ok && excluded.verifiedUrls.length === 1 && excluded.verifiedUrls[0] === excludedPages[3].url, "category and explicit exclusion skips do not consume the live page-fetch budget");

  const dietItem = item("milk-stew", { title: "Milk Bean Stew" });
  const dietFixture = createFixture({ items: [dietItem], recipes: new Map([[dietItem.url, candidate("milk-stew", { title: "Milk Bean Stew", rawIngredients: ["milk"], ingredients: ["milk"] })]]) });
  const dietResult = await dietFixture.service.findRecipes({ dinners: 1, equipment: ["stove"], dietRules: [{ id: "dairy-free", forbids: ["milk"], allows: [] }] });
  check(!dietResult.ok && dietResult.rejected.diet === 1, `live-verified diet violations are rejected after metadata selection (${JSON.stringify(dietResult)})`);
  check(recipeViolatesDiet(candidate("milk-stew", { ingredients: ["milk"] }), [{ forbids: ["milk"], allows: [] }]) === "milk", "shared diet safety filter identifies forbidden terms");

  const wrongEquipmentItem = item("oven-roast");
  const wrongEquipment = createFixture({ items: [wrongEquipmentItem], recipes: new Map([[wrongEquipmentItem.url, candidate("oven-roast", { equipment: ["oven"] })]]) });
  const equipmentResult = await wrongEquipment.service.findRecipes({ dinners: 1, equipment: ["microwave"] });
  check(!equipmentResult.ok && equipmentResult.rejected.equipment === 1, "page-derived equipment requirements are hard-filtered");

  const mismatchItem = item("metadata-fast-page-slow", { time: 20 });
  const mismatch = createFixture({ items: [mismatchItem], recipes: new Map([[mismatchItem.url, candidate("metadata-fast-page-slow", { timeMin: 45 })]]) });
  const mismatchResult = await mismatch.service.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"] });
  check(!mismatchResult.ok && mismatchResult.rejected.time === 1, "page truth overrides shorter metadata time and cannot be rescued by an inference");

  const noAttributionItem = item("no-attribution", { license: "", notice: "" });
  const noAttribution = createFixture({
    items: [noAttributionItem],
    recipes: new Map([[noAttributionItem.url, candidate("no-attribution", { attribution: "", license: "" })]]),
  });
  const attributionResult = await noAttribution.service.findRecipes({ dinners: 1, equipment: ["stove"] });
  check(!attributionResult.ok && attributionResult.rejected.attribution === 1, "candidates without a usable attribution line or license are withheld");

  const unsafeItem = item("foreign-recipe", { raw: { url: "https://attacker.example/recipes/steal" } });
  const unsafe = createFixture({ items: [unsafeItem], total: 1 });
  const unsafeResult = await unsafe.service.findRecipes({ dinners: 1, equipment: ["stove"] });
  check(!unsafeResult.ok && unsafe.verifiedUrls.length === 0 && unsafeResult.rejected.metadata === 1, "poisoned metadata URLs are discarded before verifier calls");

  let fakeNow = 1000;
  const delayed = createFixture({
    items: [item("slow-dns-a"), item("slow-dns-b")],
    total: 2,
    recipes: new Map([
      [`${ORIGIN}/recipes/slow-dns-a`, candidate("slow-dns-a", { title: "Slow DNS A" })],
      [`${ORIGIN}/recipes/slow-dns-b`, candidate("slow-dns-b", { title: "Slow DNS B" })],
    ]),
    hostDelayMs: 1100,
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    verifyOverride: async (value, verifyOptions, starts) => {
      fakeNow += 600;
      await verifyOptions.beforeFetch(value, 0);
      starts.push(fakeNow);
      return { ok: true, recipe: candidate(new URL(value).pathname.split("/").pop(), { title: `Verified ${value}` }) };
    },
  });
  const delayedResult = await delayed.service.findRecipes({ dinners: 1, equipment: ["stove"] });
  const allStarts = [...delayed.apiCalls.map(() => 1000), ...delayed.pageStarts].sort((a, b) => a - b);
  check(delayedResult.ok && delayed.pageStarts.every((time, index) => index === 0 || time - delayed.pageStarts[index - 1] >= 1100), "page requests remain paced after delayed DNS validation");
  check(delayed.pageStarts[0] - 1000 >= 1100 && allStarts.length >= 2, "the first verifier GET also waits after its DNS delay");

  let throttleNow = 10000;
  const throttled = createFixture({
    apiStatus: 429,
    apiHeaders: { "retry-after": "3" },
    now: () => throttleNow,
    sleep: async (ms) => { throttleNow += ms; },
  });
  const throttledResult = await throttled.service.findRecipes({ dinners: 1, equipment: ["stove"] });
  check(!throttledResult.ok && throttledResult.failure.retryAfterMs === 3000 && throttled.apiCalls.length === 1, "API 429 stops immediately and records Retry-After without a retry");
  const afterThrottle = await throttled.service.findRecipes({ dinners: 1, equipment: ["stove"] });
  check(throttled.apiCalls.length === 2 && throttled.apiStarts[1] - throttled.apiStarts[0] >= 3000 && !afterThrottle.ok, "a later request waits for the retained Retry-After cooldown");

  const page429 = createFixture({
    verifyOverride: async (_value, verifyOptions) => {
      await verifyOptions.beforeFetch(`${ORIGIN}/recipes/page-429`, 0);
      return { ok: false, failure: { status: 429, message: "HTTP 429" } };
    },
  });
  const page429First = await page429.service.findRecipes({ dinners: 1, equipment: ["stove"] });
  const pageCallsAtBlock = page429.apiCalls.length;
  const page429Again = await page429.service.findRecipes({ dinners: 1, equipment: ["stove"] });
  check(!page429First.ok && pageCallsAtBlock === 1 && !page429Again.ok && page429.apiCalls.length === 1, "page-level 429 stops the call and later calls stay blocked when verifier hides Retry-After");

  const badRedirect = createFixture({
    verifyOverride: async (_value, verifyOptions) => {
      await verifyOptions.beforeFetch(`${ORIGIN}/recipes/safe`, 0);
      await verifyOptions.beforeFetch("https://attacker.example/recipes/redirect", 1);
      return { ok: true, recipe: candidate("safe") };
    },
  });
  const redirectResult = await badRedirect.service.findRecipes({ dinners: 1, equipment: ["stove"] });
  check(!redirectResult.ok && badRedirect.pageStarts.length === 0, "foreign verifier redirects are rejected before the redirected page GET");

  let oversizedCancelled = false;
  const streamingService = createRcpRecipeDiscovery({
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: Buffer.alloc(64) }),
          cancel: async () => { oversizedCancelled = true; },
          releaseLock() {},
        }),
      },
    }),
    verifyUrl: async () => ({ ok: true, recipe: candidate("never") }),
    validatePublicUrl: async (value) => ({ ok: true, url: new URL(value) }),
    maxApiBytes: 32,
    now: () => 1000,
    sleep: async () => {},
  });
  const oversized = await streamingService.findRecipes({ dinners: 1, equipment: ["stove"] });
  check(!oversized.ok && oversized.failure.status === "body-too-large" && oversizedCancelled, "oversized streamed metadata is canceled at the byte cap");

  check(streamingService.limits.maxApiPages <= 6 && streamingService.limits.maxPageChecks <= 36, "provider API and page verification caps remain bounded");

  const inferenceRecipes = [10, 25, 40, 60].map((timeMin, index) => ({
    title: `Masked Title ${index}`,
    finalUrl: `${ORIGIN}/recipes/inference-${index}`,
    timeMin,
    ingredients: ["rice", "beans"],
    instructions: [`Cook the beans for ${timeMin} minutes, then rest overnight.`],
  }));
  const masked = maskRecipeForInference(inferenceRecipes[2]);
  check(!JSON.stringify(masked).includes("Masked Title") && !JSON.stringify(masked).includes("40 minutes") && !JSON.stringify(masked).includes("overnight"), "inference input omits title and masks explicit duration text");
  check(balancedKnownTimeSample([...inferenceRecipes, inferenceRecipes[0]], { maxCalls: 4 }).candidates.length === 4, "inference sample is deduplicated and balanced across the 30-minute truth threshold");
  const prompts = [];
  let modelCall = 0;
  const evaluation = await evaluateRecipeTimeInference(inferenceRecipes, {
    maxCalls: 20,
    airChat: async (messages) => {
      prompts.push(messages);
      const outputs = [
        { estimateMin: 10, lowerBoundMin: 8, upperBoundMin: 15, confidence: "high" },
        { estimateMin: 25, lowerBoundMin: 20, upperBoundMin: 30, confidence: "medium" },
        { estimateMin: 25, lowerBoundMin: 20, upperBoundMin: 30, confidence: "high" },
        { estimateMin: 50, lowerBoundMin: 40, upperBoundMin: 60, confidence: "high" },
      ];
      const content = JSON.stringify(outputs[modelCall++]);
      return { ok: true, data: { choices: [{ message: { content } }] } };
    },
  });
  check(evaluation.calls === 4 && evaluation.maxCalls === 20 && evaluation.falseSafeCount === 1 && evaluation.falseSafeDenominator === 2 && evaluation.falseSafeRate === 0.5, "inference evaluation caps calls and reports false-safe count and denominator");
  check(!JSON.stringify(prompts).includes("Masked Title") && !JSON.stringify(prompts).includes("40 minutes"), "the actual model prompt cannot see source title or published duration");
  check(evaluation.note.includes("never enter discovery filtering") && !("timeMin" in evaluation), "inferred estimates remain evaluation-only and cannot overwrite source truth");
  let partialCall = 0;
  const partialEvaluation = await evaluateRecipeTimeInference(inferenceRecipes, {
    maxCalls: 4,
    airChat: async () => partialCall++ === 0
      ? { ok: true, data: { choices: [{ message: { content: JSON.stringify({ estimateMin: 10, lowerBoundMin: 5, upperBoundMin: 15, confidence: "high" }) } }] } }
      : { ok: false, failure: { status: "fixture-error" } },
  });
  check(partialEvaluation.status === "model-error" && partialEvaluation.falseSafeDenominator === 0 && partialEvaluation.falseSafeRate === null, "partial model failure cannot report a misleading zero false-safe rate");
  return checks;
}

if (require.main === module) {
  run().then((count) => process.stdout.write(`RCP recipe discovery focused checks passed (${count})\n`)).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = run;
