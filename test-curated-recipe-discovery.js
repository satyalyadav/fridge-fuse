"use strict";

const assert = require("node:assert/strict");
const curatedIndex = require("./data/curated-recipe-leads.json");
const { createLiveRecipeService, isPublicRecipeUrl } = require("./lib/live-recipes");
const { minGapByHost } = require("./scripts/audit-curated-recipes");
const {
  createCuratedRecipeDiscovery,
  exactLeadUrl,
  instructionTimeConflict,
  rankCuratedLeads,
  validateCuratedIndex,
} = require("./lib/curated-recipe-discovery");

let checks = 0;
const check = (condition, message) => {
  checks++;
  assert.ok(condition, message);
};

function fixtureIndex(count = 4) {
  return {
    schemaVersion: 1,
    sourcePolicies: [{
      id: "fixture",
      host: "recipes.example.test",
      pathPrefix: "/recipes/",
      rightsStatus: "prototype-only-fixture",
      attributionRequired: true,
      licenseRequired: true,
      minimumRequestGapMs: 1000,
    }],
    leads: Array.from({ length: count }, (_, index) => ({
      url: `https://recipes.example.test/recipes/meal-${index + 1}`,
      sourceId: "fixture",
      leadTags: ["dinner", index % 2 ? "vegetarian" : "stove"],
    })),
  };
}

function recipeFor(url, patch = {}) {
  const title = new URL(url).pathname.split("/").pop().replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    title,
    sourceUrl: url,
    finalUrl: url,
    timeMin: 20,
    ingredients: ["rice", "beans", "water"],
    rawIngredients: ["rice", "beans", "water"],
    instructions: ["Heat the beans on a stove.", "Serve with rice."],
    rawInstructions: ["Heat the beans on a stove.", "Serve with rice."],
    equipment: ["stove"],
    license: "CC BY-SA 4.0",
    attribution: "Adapted from Wikibooks under CC BY-SA 4.0.",
    ...patch,
  };
}

function fakeVerifier({ onVerify, recipeFactory = recipeFor, failureFor } = {}) {
  return {
    async verifyUrl(url, options = {}) {
      onVerify?.(url, options);
      try {
        await options.beforeFetch?.(url, 0);
      } catch (error) {
        return { ok: false, failure: { status: error.code || "network-error" } };
      }
      const failure = failureFor?.(url);
      if (failure) return { ok: false, failure };
      return { ok: true, recipe: recipeFactory(url) };
    },
  };
}

function makeDiscovery(options = {}) {
  const index = options.index || fixtureIndex();
  return createCuratedRecipeDiscovery({
    index,
    liveRecipeService: options.liveRecipeService || fakeVerifier(options),
    now: options.now,
    sleep: options.sleep,
    hostDelayMs: options.hostDelayMs ?? 0,
    maxPageFetches: options.maxPageFetches ?? 8,
    maxPageChecks: options.maxPageChecks ?? 8,
  });
}

async function runCuratedDiscoveryChecks() {
  const checkedIndex = validateCuratedIndex(curatedIndex);
  check(checkedIndex.ok && checkedIndex.leadCount === 36 && checkedIndex.sourceCount === 6, "the expanded curated index has 36 unique URLs across six prototype-only source policies");
  check(curatedIndex.leads.every((lead) => Object.keys(lead).sort().join(",") === "leadTags,sourceId,url"), "curated leads store URLs and ranking hints, not recipe titles, times, ingredients, or steps");
  check(curatedIndex.sourcePolicies.every((policy) => policy.rightsStatus.startsWith("prototype-only")), "every source has an explicit prototype-only rights status");
  check(curatedIndex.leads.every((lead) => !/dessert|cake|cookie|side-dish|smoothie|drink/i.test(lead.url)), "the curated index excludes obvious dessert and side URL slugs");
  check(curatedIndex.leads.filter((lead) => lead.leadTags.includes("microwave")).length === 7, "microwave dinner leads are ranked from seven URL-only entries");
  check(rankCuratedLeads(curatedIndex.leads, { equipment: ["microwave"] }).slice(0, 7).every((lead) => lead.leadTags.includes("microwave")), "microwave requests rank microwave leads first without accepting their tags as facts");
  const veganStoveLeads = rankCuratedLeads(curatedIndex.leads, { equipment: ["stove"], dietRules: [{ id: "vegan", label: "Vegan" }] });
  check(veganStoveLeads.slice(0, 4).every((lead) => ["bbc-good-food", "budget-bytes", "vegan-richa", "nora-cooks"].includes(lead.sourceId)), "new live-verified vegan stove publishers rank ahead of older RCP leads with source diversity");
  check(curatedIndex.leads.filter((lead) => ["bbc-good-food", "budget-bytes", "vegan-richa", "nora-cooks"].includes(lead.sourceId) && lead.leadTags.includes("vegan") && lead.leadTags.includes("stove")).length === 8, "eight added vegan stove URL hints are present without storing recipe facts");
  check(veganStoveLeads[0].leadTags.includes("stove"), "stove and diet signals affect deterministic lead ranking");
  const measuredGap = minGapByHost([
    { host: "publisher.example.test", startedAt: 25.5 },
    { host: "other.example.test", startedAt: 50.25 },
    { host: "publisher.example.test", startedAt: 1225.75 },
  ]);
  check(Math.abs(measuredGap["publisher.example.test"] - 1200.25) < 0.001, "audit host pacing gaps preserve monotonic sub-millisecond timestamps");

  const fixture = fixtureIndex();
  check(validateCuratedIndex(fixture).ok, "a small source-scoped fixture index validates");
  check(!exactLeadUrl("https://evil.example.test/recipes/pasta", fixture.sourcePolicies[0]), "a lead cannot escape its exact publisher host");
  check(!exactLeadUrl("https://recipes.example.test/recipes/pasta?next=https://evil.example", fixture.sourcePolicies[0]), "query-bearing lead URLs are rejected");
  const poisoned = fixtureIndex();
  poisoned.leads[0].url = "https://127.0.0.1/recipes/private";
  check(!validateCuratedIndex(poisoned).ok && !isPublicRecipeUrl(poisoned.leads[0].url), "private and loopback lead URLs fail closed at index validation");
  const factPoison = fixtureIndex();
  factPoison.leads[0].timeMin = 5;
  check(validateCuratedIndex(factPoison).errors.some((error) => error.status === "lead-stores-non-url-metadata"), "index validation rejects persisted recipe facts");

  let verifyCalls = 0;
  const gated = makeDiscovery({ onVerify: () => { verifyCalls++; } });
  const gatedResult = await gated.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"] });
  check(!gatedResult.ok && gatedResult.failure.status === "prototype-only-index" && verifyCalls === 0, "prototype-only sources are not fetched unless the caller explicitly enables the audit mode");
  check(gatedResult.metrics.pageFetches === 0, "the rights gate runs before page requests");

  const requests = [];
  const freshDiscovery = makeDiscovery({ onVerify: (url, options) => requests.push({ url, options }) });
  const freshOne = await freshDiscovery.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1, maxPageChecks: 1 });
  const freshTwo = await freshDiscovery.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1, maxPageChecks: 1 });
  check(requests.length === 2 && requests.every((entry) => entry.options.fresh === true), "each request freshly verifies its URL instead of trusting a prior cached candidate");
  check(requests.every((entry) => entry.options.allowedHosts.includes("recipes.example.test")), "each verifier call is constrained to the lead publisher host");
  check(freshOne.candidates[0].productionEligible === false && freshOne.candidates[0].prototypeOnly === true, "verified prototype candidates remain explicitly ineligible for production");
  check(freshTwo.candidates[0].title === freshOne.candidates[0].title, "repeat discovery uses the same URL list while still re-verifying the page");

  const capDiscovery = makeDiscovery({ maxPageFetches: 2, maxPageChecks: 5 });
  const capResult = await capDiscovery.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 2, maxPageChecks: 5 });
  check(capResult.metrics.pageFetches === 2 && capResult.metrics.pageChecks === 2, "the per-request cap counts actual verifier fetch starts");

  const makeSingle = (recipePatch) => makeDiscovery({
    index: fixtureIndex(1),
    recipeFactory: (url) => recipeFor(url, recipePatch),
  });
  const tooSlow = await makeSingle({ timeMin: 45 }).findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1 });
  check(!tooSlow.ok && tooSlow.rejected.time === 1, "a live JSON-LD time above the request limit is rejected");
  check(instructionTimeConflict(recipeFor("https://recipes.example.test/recipes/overnight", { timeMin: 12, rawInstructions: ["Soak the beans overnight before cooking."], instructions: ["Soak the beans overnight before cooking."] }), 30).status === "overnight-step", "an overnight instruction invalidates a misleading short JSON-LD time");
  const overnight = await makeSingle({ timeMin: 12, rawInstructions: ["Soak beans overnight, then cook on a stove."], instructions: ["Soak beans overnight, then cook on a stove."] }).findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1 });
  check(!overnight.ok && overnight.rejectionReasons[0].status === "overnight-step", "the discovery path rejects overnight steps despite short page time");
  const inconsistent = await makeSingle({ timeMin: 15, rawInstructions: ["Simmer on the stove for one hour."], instructions: ["Simmer on the stove for one hour."] }).findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1 });
  check(inconsistent.rejectionReasons[0].status === "instruction-exceeds-jsonld-time", "a single step longer than the published total time is rejected");
  const noTool = await makeSingle({ equipment: ["oven"] }).findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1 });
  check(!noTool.ok && noTool.rejected.equipment === 1, "the existing equipment filter rejects a candidate requiring unavailable equipment");
  const vegan = { id: "vegan", label: "Vegan", forbids: ["milk", "egg", "meat"], allows: [] };
  const dietFail = await makeSingle({ rawIngredients: ["beans", "milk"], ingredients: ["beans", "milk"] }).findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], dietRules: [vegan], allowPrototypeOnly: true, maxPageFetches: 1 });
  check(!dietFail.ok && dietFail.rejected.diet === 1, "the existing diet word-net rejects source ingredients that violate the requested rule");

  const missingAttribution = await makeSingle({ attribution: "" }).findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1 });
  check(!missingAttribution.ok && missingAttribution.rejected.attribution === 1, "a source missing required attribution is rejected");
  const missingLicense = await makeSingle({ license: null }).findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1 });
  check(!missingLicense.ok && missingLicense.rejected.license === 1, "a source policy requiring a license rejects a page without one");
  const linkOnlyIndex = fixtureIndex(1);
  linkOnlyIndex.sourcePolicies[0].attributionRequired = false;
  linkOnlyIndex.sourcePolicies[0].linkAttributionRequired = true;
  linkOnlyIndex.sourcePolicies[0].licenseRequired = false;
  const linkOnly = await makeDiscovery({
    index: linkOnlyIndex,
    recipeFactory: (url) => recipeFor(url, { publisher: "Example Publisher", attribution: "", license: null }),
  }).findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1 });
  check(linkOnly.ok && !linkOnly.candidates[0].license && !linkOnly.candidates[0].attribution, "link-only prototype sources do not imply a reuse license or explicit source adaptation credit");
  check(linkOnly.candidates[0].linkAttribution.includes("Example Publisher") && linkOnly.candidates[0].linkAttribution.includes("https://recipes.example.test/recipes/meal-1"), "a verified publisher, title, and URL form the link attribution for unlicensed lead sources");

  const include = await makeDiscovery().findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], includeRecipe: "Meal 3", allowPrototypeOnly: true, maxPageFetches: 4, maxPageChecks: 4 });
  check(include.candidates.some((candidate) => candidate.title === "Meal 3") && include.candidates.length > 1, "an included recipe is required but safe alternatives are retained");

  let blockedVerifyCalls = 0;
  const blocked = makeDiscovery({ onVerify: () => { blockedVerifyCalls++; }, failureFor: () => ({ status: 429, message: "throttled" }) });
  const blockedResult = await blocked.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 4, maxPageChecks: 4 });
  const blockedAgain = await blocked.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 4, maxPageChecks: 4 });
  check(blockedResult.failure.status === "publisher-blocked" && blockedAgain.failure.status === "publisher-blocked" && blockedVerifyCalls === 1, "a page-level 429 blocks later requests without retrying the publisher");

  const crossHostIndex = {
    schemaVersion: 1,
    sourcePolicies: [
      fixtureIndex(1).sourcePolicies[0],
      { id: "alternate", host: "alternate.example.test", pathPrefix: "/recipes/", rightsStatus: "prototype-only-fixture", attributionRequired: true, licenseRequired: true, minimumRequestGapMs: 1000 },
    ],
    leads: [
      { url: "https://recipes.example.test/recipes/blocked-first", sourceId: "fixture", leadTags: ["dinner", "stove"] },
      { url: "https://alternate.example.test/recipes/available-second", sourceId: "alternate", leadTags: ["dinner", "stove"] },
    ],
  };
  let crossHostCalls = 0;
  const crossHost = makeDiscovery({
    index: crossHostIndex,
    onVerify: () => { crossHostCalls++; },
    failureFor: (url) => new URL(url).hostname === "recipes.example.test" ? ({ status: 429 }) : null,
  });
  const crossHostResult = await crossHost.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 3, maxPageChecks: 3 });
  check(crossHostResult.ok && crossHostResult.candidates[0].sourcePolicyId === "alternate" && crossHostCalls === 2, "a 429 blocks only that publisher and discovery can continue to a different indexed host");

  let virtualNow = 1000;
  const actualStartTimes = [];
  const concurrentIndex = fixtureIndex(2);
  const delayedVerifier = {
    async verifyUrl(url, verifyOptions) {
      await new Promise((resolve) => setTimeout(resolve, 4)); // Model DNS finishing before the paced page fetch.
      await verifyOptions.beforeFetch(url, 0);
      actualStartTimes.push(virtualNow);
      return { ok: true, recipe: recipeFor(url) };
    },
  };
  const concurrent = makeDiscovery({
    index: concurrentIndex,
    liveRecipeService: delayedVerifier,
    now: () => virtualNow,
    sleep: async (ms) => { virtualNow += ms; },
    hostDelayMs: 0,
  });
  await Promise.all([
    concurrent.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxCandidates: 1, maxPageFetches: 1 }),
    concurrent.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxCandidates: 1, maxPageFetches: 1 }),
  ]);
  check(actualStartTimes.length === 2 && Math.abs(actualStartTimes[1] - actualStartTimes[0]) >= 1010, "concurrent page checks preserve the publisher gap plus a fetch-start timing margin after delayed DNS");

  const publicAddress = [{ address: "93.184.216.34", family: 4 }];
  const htmlFor = (name, totalTime = "PT20M", instruction = "Heat the beans in a skillet on a stove.") => `<!doctype html><html><body><p>Adapted from Wikibooks under CC BY-SA 4.0.</p><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Recipe",
    name,
    totalTime,
    recipeIngredient: ["1 cup beans", "1 cup rice"],
    recipeInstructions: [{ "@type": "HowToStep", text: instruction }],
    license: "https://creativecommons.org/licenses/by-sa/4.0/",
    author: { "@type": "Person", name: "Wikibooks contributors" },
  })}</script></body></html>`;
  const liveIndex = {
    schemaVersion: 1,
    sourcePolicies: [{ id: "fixture", host: "recipes.example.test", pathPrefix: "/recipes/", rightsStatus: "prototype-only-fixture", attributionRequired: true, licenseRequired: true, minimumRequestGapMs: 1000 }],
    leads: [{ url: "https://recipes.example.test/recipes/live-bean-rice", sourceId: "fixture", leadTags: ["dinner", "stove"] }],
  };
  let searchFetches = 0;
  let pageFetches = 0;
  const html = htmlFor("Live Bean Rice");
  const liveVerifier = createLiveRecipeService({
    dnsLookup: async () => publicAddress,
    fetchImpl: async () => {
      searchFetches++;
      return { status: 200, ok: true, headers: { get: (name) => name.toLowerCase() === "content-type" ? "text/html" : null }, text: async () => html };
    },
    recipeFetch: async () => {
      pageFetches++;
      return { status: 200, ok: true, headers: { get: (name) => name.toLowerCase() === "content-type" ? "text/html" : null }, text: async () => html };
    },
  });
  const parsedLive = await createCuratedRecipeDiscovery({ index: liveIndex, liveRecipeService: liveVerifier, hostDelayMs: 0, now: () => 1000, sleep: async () => {} })
    .findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1, maxPageChecks: 1 });
  check(parsedLive.ok && parsedLive.candidates[0].title === "Live Bean Rice" && pageFetches === 1 && searchFetches === 0, "the curated adapter parses one fresh Recipe JSON-LD page through the existing verifier without a Tavily request");
  check(parsedLive.candidates[0].license.includes("creativecommons") && parsedLive.candidates[0].attribution.includes("CC BY-SA"), "live license and source attribution survive verification on the candidate");

  const redirectService = createLiveRecipeService({
    dnsLookup: async () => publicAddress,
    fetchImpl: async () => ({ status: 302, ok: false, headers: { get: (name) => name.toLowerCase() === "location" ? "https://evil.example.test/recipes/steal" : null } }),
    recipeFetch: async () => ({ status: 302, ok: false, headers: { get: (name) => name.toLowerCase() === "location" ? "https://evil.example.test/recipes/steal" : null } }),
  });
  const redirectResult = await createCuratedRecipeDiscovery({ index: liveIndex, liveRecipeService: redirectService, hostDelayMs: 0, now: () => 1000, sleep: async () => {} })
    .findRecipes({ dinners: 1, maxTimeMin: 30, equipment: ["stove"], allowPrototypeOnly: true, maxPageFetches: 1, maxPageChecks: 1 });
  check(!redirectResult.ok && redirectResult.sourceFailures[0].status === "unsafe-redirect", "the existing verifier blocks redirects outside the publisher host");

  return checks;
}

module.exports = runCuratedDiscoveryChecks;

if (require.main === module) runCuratedDiscoveryChecks().then((count) => {
  console.log(`curated recipe discovery focused checks passed (${count})`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
