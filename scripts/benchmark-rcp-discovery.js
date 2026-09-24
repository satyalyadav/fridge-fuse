"use strict";

const { createLiveRecipeService } = require("../lib/live-recipes");
const { createRcpRecipeDiscovery } = require("../lib/rcp-recipe-discovery");
const { evaluateRecipeTimeInference, balancedKnownTimeSample } = require("./evaluate-recipe-inference");
const dietRules = require("../data/diet-rules.json").rules;

const ORIGIN = "https://recipecontextprotocol.com";
const TOTAL_REQUEST_CAP = 20;
const API_REQUEST_CAP = 5;
const PAGE_GET_CAP = 15;
const REQUEST_GAP_MS = 1100;
const INFERENCE_SOURCE_REQUEST_CAP = 8;
const INFERENCE_API_CAP = 3;
const INFERENCE_PAGE_CAP = 5;
const INFERENCE_CALL_CAP = 8;
const EQUIPMENT = ["stove", "microwave", "oven", "toaster oven", "air fryer", "rice cooker", "kettle", "slow cooker", "pressure cooker", "blender", "sandwich press"];

const FIXTURES = [
  { slug: "lentil-stew", title: "Weeknight Lentil Stew", time: 25, equipment: "stove", categories: ["Main course"], ingredients: ["lentils", "vegetable broth", "onion"], instructions: ["Cook the onion in a pot on the stove until soft.", "Add lentils and vegetable broth, then simmer until tender."] },
  { slug: "microwave-tofu-rice", title: "Microwave Tofu Rice Bowl", time: 12, equipment: "microwave", categories: ["Main course"], ingredients: ["tofu", "rice", "soy sauce"], instructions: ["Put the tofu and rice in a microwave-safe bowl.", "Microwave until hot and stir in soy sauce."] },
  { slug: "chicken-skillet", title: "Chicken Rice Skillet", time: 40, equipment: "stove", categories: ["Main course"], ingredients: ["chicken", "rice", "onion"], instructions: ["Brown the chicken and onion in a skillet on the stove.", "Add rice and cook until the chicken is done."] },
  { slug: "cheese-casserole", title: "Cheesy Bean Casserole", time: 45, equipment: "oven", categories: ["Main course"], ingredients: ["beans", "cheese", "tomatoes"], instructions: ["Mix beans, cheese, and tomatoes in an oven-safe dish.", "Bake in the oven until bubbling."] },
  { slug: "lentil-soup", title: "Quick Lentil Soup", time: 30, equipment: "stove", categories: ["Main course", "Soup"], ingredients: ["lentils", "carrots", "vegetable broth"], instructions: ["Bring lentils and vegetable broth to a boil on the stove.", "Simmer until tender."] },
  { slug: "microwave-broccoli-rice", title: "Microwave Broccoli Rice", time: 15, equipment: "microwave", categories: ["Main course"], ingredients: ["broccoli", "rice", "olive oil"], instructions: ["Place broccoli and rice in a microwave-safe bowl.", "Microwave until tender and stir in olive oil."] },
  { slug: "pasta-skillet", title: "Tomato Pasta Skillet", time: 35, equipment: "stove", categories: ["Main course"], ingredients: ["pasta", "tomatoes", "garlic"], instructions: ["Boil pasta in a pot on the stove.", "Add tomatoes and garlic and cook until soft."] },
  { slug: "apple-cake", title: "Apple Cake", time: 40, equipment: "oven", categories: ["Dessert"], ingredients: ["apple", "flour", "sugar"], instructions: ["Mix the ingredients and pour into a cake pan.", "Bake in the oven until set."] },
];

function okResponse(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] || headers[name] || (String(name).toLowerCase() === "content-length" ? String(Buffer.byteLength(text)) : null) },
    text: async () => text,
  };
}

function recipeHtml(fixture) {
  const structured = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: fixture.title,
    url: `${ORIGIN}/recipes/${fixture.slug}`,
    recipeIngredient: fixture.ingredients,
    recipeInstructions: fixture.instructions.map((text) => ({ "@type": "HowToStep", text })),
    totalTime: `PT${fixture.time}M`,
    publisher: { "@type": "Organization", name: "Wikibooks Cookbook" },
    license: "https://creativecommons.org/licenses/by-sa/4.0/",
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(structured)}</script></head><body><p>Adapted from Wikibooks Cookbook, licensed CC BY-SA 4.0.</p></body></html>`;
}

function metadata(fixture) {
  return {
    slug: fixture.slug,
    title: fixture.title,
    description: "A simple dinner recipe.",
    categories: fixture.categories,
    total_time_minutes: fixture.time,
    source_name: "Wikibooks Cookbook",
    license: "CC BY-SA 4.0",
    url: `${ORIGIN}/recipes/${fixture.slug}`,
  };
}

function scenarios() {
  const buckets = ["stove", "microwave", "mixed", "tight_time", "vegan", "dairy_free", "exclude", "include", "large_plan", "source_failure"];
  return buckets.flatMap((bucket) => Array.from({ length: 10 }, (_, index) => {
    const vegan = dietRules.find((rule) => rule.id === "vegan");
    const dairyFree = dietRules.find((rule) => rule.id === "dairy-free");
    return {
      bucket,
      dinners: bucket === "large_plan" ? 7 : index % 3 + 1,
      maxTimeMin: bucket === "tight_time" ? 20 : bucket === "large_plan" ? 60 : 45,
      equipment: bucket === "stove" ? ["stove"] : bucket === "microwave" ? ["microwave"] : bucket === "mixed" ? ["stove", "microwave"] : ["stove", "microwave", "oven"],
      dietRules: bucket === "vegan" ? [vegan] : bucket === "dairy_free" ? [dairyFree] : [],
      exclude: bucket === "exclude" ? ["Weeknight Lentil Stew"] : [],
      includeRecipe: bucket === "include" ? "Weeknight Lentil Stew" : "",
      apiFailure: bucket === "source_failure",
      index,
    };
  }));
}

function aggregate(rows) {
  const groups = {};
  for (const row of rows) {
    const group = groups[row.bucket] || (groups[row.bucket] = { scenarios: 0, discoverySuccess: 0, verifiedCandidateObservations: 0, candidates: new Set(), apiRequestCount: 0, pageFetchCount: 0, latency: [] });
    group.scenarios++;
    if (row.ok) group.discoverySuccess++;
    group.verifiedCandidateObservations += row.candidates.length;
    for (const candidate of row.candidates) group.candidates.add(candidate.finalUrl || candidate.sourceUrl || candidate.title);
    group.apiRequestCount += row.apiRequestCount;
    group.pageFetchCount += row.pageFetchCount;
    group.latency.push(row.latencyMs);
  }
  return Object.fromEntries(Object.entries(groups).map(([bucket, group]) => [bucket, {
    scenarios: group.scenarios,
    discoverySuccess: group.discoverySuccess,
    verifiedCandidateObservations: group.verifiedCandidateObservations,
    distinctVerifiedCandidates: group.candidates.size,
    apiRequestCount: group.apiRequestCount,
    pageFetchCount: group.pageFetchCount,
    meanDiscoveryLatencyMs: Number((group.latency.reduce((sum, value) => sum + value, 0) / group.latency.length).toFixed(2)),
  }]));
}

async function runOfflineBenchmark() {
  const rows = [];
  for (const scenario of scenarios()) {
    let clock = scenario.index * 1000;
    let apiRequestCount = 0;
    let pageFetchCount = 0;
    const pageTransport = async (url) => {
      pageFetchCount++;
      const slug = new URL(url).pathname.split("/").pop();
      const found = FIXTURES.find((fixture) => fixture.slug === slug);
      return found ? okResponse(200, recipeHtml(found), { "content-type": "text/html" }) : okResponse(404, "not found");
    };
    const liveRecipeService = createLiveRecipeService({
      tavilyKey: "offline-fixture-only",
      fetchImpl: pageTransport,
      recipeFetch: pageTransport,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      maxCandidates: 12,
    });
    const rcpFetch = async (url) => {
      apiRequestCount++;
      if (scenario.apiFailure) return okResponse(503, { error: "fixture source failure" });
      const max = Number(new URL(url).searchParams.get("max_total_time") || 30);
      const selected = FIXTURES.filter((fixture) => fixture.time <= max).map(metadata);
      return okResponse(200, { items: selected, total: selected.length, page: 1, per_page: 100 }, { "content-type": "application/json" });
    };
    const discovery = createRcpRecipeDiscovery({
      fetchImpl: rcpFetch,
      liveRecipeService,
      perPage: 100,
      maxApiPages: 1,
      pagesPerDiscovery: 1,
      maxPageChecks: 12,
      hostDelayMs: 1100,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    const started = Date.now();
    const result = await discovery.findRecipes(scenario);
    rows.push({
      bucket: scenario.bucket,
      ok: result.ok,
      candidates: result.candidates || [],
      apiRequestCount,
      pageFetchCount,
      latencyMs: Date.now() - started,
    });
  }
  const uniqueCandidates = new Set(rows.flatMap((row) => row.candidates.map((candidate) => candidate.finalUrl || candidate.sourceUrl || candidate.title)));
  return {
    mode: "offline-fixtures",
    scenarios: rows.length,
    note: "Fixture contract benchmark only. It makes no RCP, Tavily, or Voyager network calls and does not estimate live reliability or plan success.",
    total: {
      discoverySuccess: rows.filter((row) => row.ok).length,
      verifiedCandidateObservations: rows.reduce((sum, row) => sum + row.candidates.length, 0),
      distinctVerifiedCandidates: uniqueCandidates.size,
      apiRequestCount: rows.reduce((sum, row) => sum + row.apiRequestCount, 0),
      pageFetchCount: rows.reduce((sum, row) => sum + row.pageFetchCount, 0),
      meanDiscoveryLatencyMs: Number((rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length).toFixed(2)),
    },
    buckets: aggregate(rows),
  };
}

function countStatuses(failures = []) {
  return failures.reduce((counts, failure) => {
    const key = String(failure.status || "unknown");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

async function runLiveSmoke() {
  const requests = [];
  const counts = { smoke: { api: 0, pages: 0 }, inferenceSample: { api: 0, pages: 0 } };
  let phase = "smoke";
  let blockedStatus = null;
  let lastGlobalStart = null;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const isApi = parsed.hostname === "recipecontextprotocol.com" && parsed.pathname.replace(/\/$/, "") === "/recipes";
    const bucket = counts[phase];
    const phaseCap = phase === "smoke" ? TOTAL_REQUEST_CAP : INFERENCE_SOURCE_REQUEST_CAP;
    const phaseTotal = bucket.api + bucket.pages;
    if (phaseTotal >= phaseCap || isApi && bucket.api >= (phase === "smoke" ? API_REQUEST_CAP : INFERENCE_API_CAP) || !isApi && bucket.pages >= (phase === "smoke" ? PAGE_GET_CAP : INFERENCE_PAGE_CAP)) {
      throw Object.assign(new Error("Configured live request cap reached."), { code: "smoke-cap" });
    }
    if (lastGlobalStart !== null) {
      const delay = REQUEST_GAP_MS - (Date.now() - lastGlobalStart);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const at = Date.now();
    lastGlobalStart = at;
    if (isApi) bucket.api++;
    else bucket.pages++;
    let response;
    try { response = await fetch(parsed.href, init); } catch (error) {
      requests.push({ at, api: isApi, status: "network-error" });
      throw error;
    }
    const status = Number(response?.status || 0);
    requests.push({ at, api: isApi, status });
    if (status === 403 || status === 429) blockedStatus = status;
    return response;
  };
  const liveRecipeService = createLiveRecipeService({ fetchImpl, recipeFetch: fetchImpl });
  const discovery = createRcpRecipeDiscovery({
    fetchImpl,
    liveRecipeService,
    perPage: 100,
    maxApiPages: 1,
    pagesPerDiscovery: 1,
    maxPageChecks: 3,
    maxCandidates: 12,
    hostDelayMs: REQUEST_GAP_MS,
  });
  const vegan = dietRules.find((rule) => rule.id === "vegan");
  const dairyFree = dietRules.find((rule) => rule.id === "dairy-free");
  const liveScenarios = [
    { id: "stove-30", dinners: 1, maxTimeMin: 30, equipment: ["stove"], dietRules: [] },
    { id: "microwave-vegan-30", dinners: 1, maxTimeMin: 30, equipment: ["microwave"], dietRules: [vegan] },
    { id: "mixed-45", dinners: 3, maxTimeMin: 45, equipment: ["stove", "microwave"], dietRules: [] },
    { id: "dairy-free-60", dinners: 1, maxTimeMin: 60, equipment: ["stove", "oven"], dietRules: [dairyFree] },
    { id: "wide-time-120", dinners: 1, maxTimeMin: 120, equipment: EQUIPMENT, dietRules: [] },
  ];
  const verifiedPool = new Map();
  const scenarioResults = [];
  for (const scenario of liveScenarios) {
    if (blockedStatus) break;
    const beforeApi = counts.smoke.api;
    const beforePages = counts.smoke.pages;
    const started = Date.now();
    let result;
    try { result = await discovery.findRecipes(scenario); } catch (error) {
      result = { ok: false, candidates: [], failure: { status: error.code || "error", message: error.message }, metrics: {} };
    }
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    for (const candidate of candidates) verifiedPool.set(candidate.finalUrl || candidate.sourceUrl, candidate);
    scenarioResults.push({
      scenario: scenario.id,
      ok: result.ok,
      candidates: candidates.map((candidate) => ({ title: candidate.title, timeMin: candidate.timeMin, equipment: candidate.equipment, license: candidate.license, hasAttribution: Boolean(candidate.attribution) })),
      apiRequests: counts.smoke.api - beforeApi,
      recipePageGets: counts.smoke.pages - beforePages,
      verifiedCandidateCount: Number(result.metrics?.verifiedCandidates || candidates.length),
      pageVerifications: Number(result.metrics?.pageVerifications || 0),
      rejected: result.rejected || result.failure?.rejected || null,
      sourceFailureStatuses: countStatuses(result.sourceFailures || result.failure?.sourceFailures || []),
      failureStatus: result.failure?.status || null,
      latencyMs: Date.now() - started,
    });
  }
  const smokeResult = {
    scenarios: scenarioResults,
    caps: { scenarioCount: liveScenarios.length, maxTotalRequests: TOTAL_REQUEST_CAP, maxApiRequests: API_REQUEST_CAP, maxRecipePageGets: PAGE_GET_CAP, maxPageChecksPerScenario: 3 },
    actual: { apiRequests: counts.smoke.api, recipePageGets: counts.smoke.pages, totalRequests: counts.smoke.api + counts.smoke.pages },
    distinctVerifiedCandidates: verifiedPool.size,
    minimumRequestGapMs: requests.length > 1 ? Math.min(...requests.slice(1).map((entry, index) => entry.at - requests[index].at)) : null,
    blockedStatus,
  };
  let inference = { status: "skipped", reason: "VOYAGER_KEY is not configured", calls: 0 };
  const server = require("../server");
  if (process.env.VOYAGER_KEY && !blockedStatus) {
    let candidatePool = [...verifiedPool.values()];
    let available = balancedKnownTimeSample(candidatePool, { maxCalls: INFERENCE_CALL_CAP });
    let sampleSource = "smoke candidates";
    if (available.balancedPerSide < 2) {
      phase = "inferenceSample";
      const shortSampling = createRcpRecipeDiscovery({
        fetchImpl,
        liveRecipeService,
        perPage: 100,
        maxApiPages: 1,
        pagesPerDiscovery: 1,
        maxPageChecks: 2,
        maxCandidates: 12,
        hostDelayMs: REQUEST_GAP_MS,
      });
      try {
        const shortSample = await shortSampling.findRecipes({ dinners: 1, maxTimeMin: 30, equipment: EQUIPMENT, dietRules: [] });
        for (const candidate of shortSample.candidates || []) verifiedPool.set(candidate.finalUrl || candidate.sourceUrl, candidate);
      } catch { /* The aggregate below records insufficient source evidence. */ }
      if (!blockedStatus) {
        const longSampling = createRcpRecipeDiscovery({
          fetchImpl,
          liveRecipeService,
          perPage: 100,
          maxApiPages: 2,
          pagesPerDiscovery: 2,
          maxPageChecks: 3,
          maxCandidates: 12,
          hostDelayMs: REQUEST_GAP_MS,
        });
        try {
          const longSample = await longSampling.findRecipes({
            dinners: 1,
            maxTimeMin: 120,
            minTimeMin: 31,
            preferTimeOverMin: 30,
            equipment: EQUIPMENT,
            dietRules: [],
          });
          for (const candidate of longSample.candidates || []) verifiedPool.set(candidate.finalUrl || candidate.sourceUrl, candidate);
        } catch { /* The aggregate below records insufficient source evidence. */ }
      }
      candidatePool = [...verifiedPool.values()];
      available = balancedKnownTimeSample(candidatePool, { maxCalls: INFERENCE_CALL_CAP });
      sampleSource = "smoke plus bounded inference sample";
    }
    inference = blockedStatus
      ? { status: "source-blocked", blockedStatus, calls: 0, sampleSource, rcpRequests: { api: counts.inferenceSample.api, recipePageGets: counts.inferenceSample.pages, cap: INFERENCE_SOURCE_REQUEST_CAP } }
      : {
          ...(await evaluateRecipeTimeInference(candidatePool, {
            maxCalls: INFERENCE_CALL_CAP,
            model: server.AIR_MODEL,
            airChat: server.airChat,
          })),
          sampleSource,
          rcpRequests: { api: counts.inferenceSample.api, recipePageGets: counts.inferenceSample.pages, cap: INFERENCE_SOURCE_REQUEST_CAP },
        };
  }
  return {
    mode: "live-rcp-smoke",
    note: "One bounded live source probe, not a reliability or production-plan benchmark. Most scenarios request one dinner, one requests three; each has at most three page checks. Metadata selects URLs; page JSON-LD remains the accepted source for time, ingredients, instructions, and equipment.",
    smoke: smokeResult,
    totalLiveRequests: counts.smoke.api + counts.smoke.pages + counts.inferenceSample.api + counts.inferenceSample.pages,
    globalMinRequestGapMs: requests.length > 1 ? Math.min(...requests.slice(1).map((entry, index) => entry.at - requests[index].at)) : null,
    inference,
  };
}

async function main() {
  const output = process.argv.includes("--live") ? await runLiveSmoke() : await runOfflineBenchmark();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: "error", message: String(error?.message || error).slice(0, 200) })}\n`);
  process.exitCode = 1;
});

module.exports = { runLiveSmoke, runOfflineBenchmark, scenarios };
