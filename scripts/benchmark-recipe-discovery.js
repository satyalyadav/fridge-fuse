"use strict";

// Bounded, fully offline comparison. The Tavily adapter below is a local HTTP
// fixture; it never reaches Tavily or reads TAVILY_API_KEY from the environment.
const { performance } = require("node:perf_hooks");
const { createLiveRecipeService, normalizeWords } = require("../lib/live-recipes");
const { createSitemapRecipeDiscovery } = require("../lib/sitemap-recipe-discovery");
const server = require("../server");

const ORIGIN = "https://recipes.fixture.test";
const SAFE_DNS = async () => [{ address: "93.184.216.34", family: 4 }];
const CORPUS = [
  { slug: "quick-chickpea-skillet", title: "Quick Chickpea Skillet", timeMin: 12, equipment: "stove", ingredients: ["chickpeas", "tomatoes", "rice"], instructions: ["Heat oil in a pan.", "Stir in chickpeas, tomatoes, and rice and cook over medium heat."] },
  { slug: "microwave-bean-rice-bowl", title: "Microwave Bean Rice Bowl", timeMin: 10, equipment: "microwave", ingredients: ["black beans", "rice", "salsa"], instructions: ["Place black beans, rice, and salsa in a microwave-safe bowl.", "Microwave until hot and stir."] },
  { slug: "black-bean-quesadilla", title: "Black Bean Quesadilla", timeMin: 15, equipment: "stove", ingredients: ["black beans", "tortillas", "salsa"], instructions: ["Fill tortillas with black beans and salsa.", "Toast both sides in a pan over medium heat."] },
  { slug: "spinach-egg-rice-bowl", title: "Spinach Egg Rice Bowl", timeMin: 12, equipment: "stove", ingredients: ["spinach", "eggs", "rice"], instructions: ["Warm spinach and rice in a pan.", "Cook the eggs until set over medium heat."] },
  { slug: "tomato-chickpea-skillet", title: "Tomato Chickpea Skillet", timeMin: 25, equipment: "stove", ingredients: ["chickpeas", "tomatoes", "onion"], instructions: ["Cook onion in oil in a pan.", "Add chickpeas and tomatoes and simmer over medium heat."] },
  { slug: "slow-lentil-stew", title: "Slow Lentil Stew", timeMin: 45, equipment: "slow cooker", ingredients: ["lentils", "carrots", "onion"], instructions: ["Add the lentils, carrots, and onion to a slow cooker.", "Cook until tender."] },
  { slug: "microwave-baked-potato", title: "Microwave Baked Potato", timeMin: 11, equipment: "microwave", ingredients: ["potatoes", "olive oil", "salt"], instructions: ["Pierce and oil the potato.", "Microwave until tender."] },
  { slug: "cheesy-pasta-skillet", title: "Cheesy Pasta Skillet", timeMin: 20, equipment: "stove", ingredients: ["pasta", "cheddar", "tomatoes"], instructions: ["Boil pasta in a pot.", "Stir cheddar and tomatoes together in a pan over medium heat."] },
];

function pageHtml(row) {
  return `<html><body><p>Source: Fixture Kitchen, public domain.</p><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: row.title,
    publisher: { "@type": "Organization", name: "Fixture Kitchen" },
    license: "public domain",
    recipeIngredient: row.ingredients,
    recipeInstructions: row.instructions,
    totalTime: `PT${row.timeMin}M`,
  })}</script></body></html>`;
}

const recipeUrls = CORPUS.map((row) => `${ORIGIN}/recipes/${row.slug}`);
const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${recipeUrls.map((url) => `<url><loc>${url}</loc><lastmod>2025-01-01</lastmod></url>`).join("")}</urlset>`;
const xmlResponse = (body, status = 200, contentType = "application/xml") => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
  text: async () => body,
});

function createProvider(provider, bucket) {
  let recipePageGets = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.tavily.com") {
      if (bucket === "source_failure") return xmlResponse("fixture failure", 503, "text/plain");
      return xmlResponse(JSON.stringify({ results: recipeUrls.map((value) => ({ url: value })) }), 200, "application/json");
    }
    if (parsed.pathname === "/robots.txt") return xmlResponse("User-agent: *\nAllow: /\nSitemap: https://recipes.fixture.test/sitemap.xml", 200, "text/plain");
    if (parsed.pathname === "/sitemap.xml") {
      return bucket === "source_failure" ? xmlResponse("fixture failure", 503, "text/plain") : xmlResponse(sitemap);
    }
    if (parsed.pathname.startsWith("/recipes/")) {
      recipePageGets++;
      const row = CORPUS.find((entry) => `${ORIGIN}/recipes/${entry.slug}` === parsed.href);
      return row ? xmlResponse(pageHtml(row), 200, "text/html; charset=utf-8") : xmlResponse("missing", 404, "text/plain");
    }
    return xmlResponse("missing", 404, "text/plain");
  };
  const verifier = createLiveRecipeService({
    tavilyKey: "offline-fixture-only",
    fetchImpl,
    dnsLookup: SAFE_DNS,
    maxSearchAttempts: 1,
    maxCandidates: 12,
    verifiedTtlMs: 1000,
  });
  const discovery = provider === "tavily"
    ? verifier
    : createSitemapRecipeDiscovery({
      sources: [{ id: "fixture-publisher", origin: ORIGIN }],
      fetchImpl,
      liveRecipeService: verifier,
      hostDelayMs: 0,
      maxCandidates: 12,
      maxPageChecks: 12,
    });
  return { discovery, verifier, pageFetchCount: () => recipePageGets };
}

function makeScenarios() {
  const scenarios = [];
  const buckets = ["stove", "microwave", "tight_time", "vegan", "dairy_free", "exclude", "include", "swap", "large_plan", "source_failure"];
  const pantrySets = [[], ["rice", "black beans"], ["chickpeas", "tomatoes"], ["spinach", "rice"], ["potatoes", "olive oil"]];
  for (const bucket of buckets) {
    for (let index = 0; index < 18; index++) {
      const offset = index % 3;
      let body = { pantry: [], useSoon: [], dinners: 1, maxTimeMin: 30, equipment: ["stove"], diet: "", exclude: [], includeRecipe: "" };
      if (bucket === "stove") body = { ...body, dinners: 1 + offset, maxTimeMin: 22 + offset * 4 };
      if (bucket === "microwave") body = { ...body, dinners: 1 + (index % 2), maxTimeMin: 15 + offset * 5, equipment: ["microwave"] };
      if (bucket === "tight_time") body = { ...body, maxTimeMin: 9 + offset * 3, equipment: index % 2 ? ["microwave"] : ["stove"] };
      if (bucket === "vegan") body = { ...body, dinners: 1 + (index % 2), maxTimeMin: 30, equipment: index % 2 ? ["microwave", "stove"] : ["stove"], diet: "vegan" };
      if (bucket === "dairy_free") body = { ...body, dinners: 1 + (index % 2), maxTimeMin: 30, equipment: ["stove", "microwave"], diet: "dairy-free" };
      if (bucket === "exclude") body = { ...body, exclude: [index % 2 ? "Quick Chickpea Skillet" : "Black Bean Quesadilla"] };
      if (bucket === "include") body = { ...body, includeRecipe: index % 2 ? "Black Bean Quesadilla" : "Quick Chickpea Skillet" };
      if (bucket === "swap") {
        const dinnerFrom = (row) => ({
          title: row.title,
          sourceRecipe: row.title,
          source: "Fixture Kitchen",
          sourceUrl: `${ORIGIN}/recipes/${row.slug}`,
          timeMin: row.timeMin,
          equip: [row.equipment],
          usesPantry: [],
          needs: [...row.ingredients],
          steps: [...row.instructions],
        });
        body = {
          ...body,
          dinners: 2,
          maxTimeMin: 30,
          equipment: ["stove", "microwave"],
          swapIndex: 0,
          previousDinners: [dinnerFrom(CORPUS[0]), dinnerFrom(CORPUS[1])],
          exclude: [CORPUS[0].title],
        };
      }
      if (bucket === "large_plan") body = { ...body, dinners: 7, maxTimeMin: 30, equipment: ["stove", "microwave"] };
      body = { ...body, pantry: pantrySets[index % pantrySets.length] };
      scenarios.push({ id: `${bucket}-${String(index + 1).padStart(2, "0")}`, bucket, body });
    }
  }
  return scenarios;
}

function makePlanChat(candidates, count, includeRecipe) {
  return async () => {
    const requestedRecipe = normalizeWords(includeRecipe || "");
    const ordered = [...candidates].sort((a, b) => Number(normalizeWords(b.title).includes(requestedRecipe)) - Number(normalizeWords(a.title).includes(requestedRecipe)));
    const dinners = ordered.slice(0, count).map((candidate) => ({
      title: candidate.title,
      timeMin: candidate.timeMin,
      equip: [...candidate.equipment],
      usesPantry: [],
      needs: [...candidate.ingredients],
      steps: [...candidate.rawInstructions],
      sourceRecipe: candidate.title,
      source: candidate.source,
      sourceUrl: candidate.sourceUrl,
      adaptationNote: "",
    }));
    return { ok: true, data: { choices: [{ message: { content: JSON.stringify({ dinners, notes: "Fixture selection" }) } }] } };
  };
}

async function runPlan(body, discovery, verifier) {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  const candidates = discovery?.candidates || [];
  const generatedDinners = Number.isInteger(body.swapIndex) && Array.isArray(body.previousDinners) ? 1 : body.dinners;
  await server.handlePlanRequest({ body }, res, {
    chat: makePlanChat(candidates, generatedDinners, body.includeRecipe),
    liveRecipeService: verifier,
    findRecipes: async () => discovery,
  });
  return { statusCode, payload };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))].toFixed(2));
}

async function benchmarkProvider(provider, scenarios) {
  const summary = { provider, total: { scenarios: scenarios.length, discoverySuccess: 0, fullPlanSuccess: 0, pageFetchCount: 0, verifiedCandidateObservations: 0, distinct: new Set(), discoveryMs: [], fullPlanMs: [] }, buckets: {} };
  for (const scenario of scenarios) {
    const fixture = createProvider(provider, scenario.bucket);
    const rules = server.resolveDietRules(scenario.body.diet);
    const input = {
      dinners: Number.isInteger(scenario.body.swapIndex) && Array.isArray(scenario.body.previousDinners) ? 1 : scenario.body.dinners,
      maxTimeMin: scenario.body.maxTimeMin,
      equipment: scenario.body.equipment,
      dietRules: rules,
      exclude: scenario.body.exclude,
      includeRecipe: scenario.body.includeRecipe,
    };
    const bucket = summary.buckets[scenario.bucket] ||= {
      scenarios: 0, discoverySuccess: 0, fullPlanSuccess: 0, pageFetchCount: 0,
      verifiedCandidateObservations: 0, distinct: new Set(), discoveryMs: [], fullPlanMs: [],
    };
    bucket.scenarios++;
    const start = performance.now();
    const discovery = await fixture.discovery.findRecipes(input);
    const discoveredAt = performance.now();
    const candidates = discovery?.candidates || [];
    const candidateUrls = new Set(candidates.map((candidate) => candidate.sourceUrl || candidate.finalUrl).filter(Boolean));
    if (discovery?.ok) { bucket.discoverySuccess++; summary.total.discoverySuccess++; }
    bucket.verifiedCandidateObservations += candidateUrls.size;
    summary.total.verifiedCandidateObservations += candidateUrls.size;
    for (const url of candidateUrls) { bucket.distinct.add(url); summary.total.distinct.add(url); }
    bucket.discoveryMs.push(discoveredAt - start);
    summary.total.discoveryMs.push(discoveredAt - start);
    const fullStart = performance.now();
    const plan = await runPlan(scenario.body, discovery, fixture.verifier);
    const fullEnd = performance.now();
    const planOk = plan.statusCode === 200 && plan.payload?.ok === true;
    if (planOk) { bucket.fullPlanSuccess++; summary.total.fullPlanSuccess++; }
    bucket.fullPlanMs.push(fullEnd - fullStart);
    summary.total.fullPlanMs.push(fullEnd - fullStart);
    const fetched = fixture.pageFetchCount();
    bucket.pageFetchCount += fetched;
    summary.total.pageFetchCount += fetched;
  }
  const finalize = (entry) => ({
    scenarios: entry.scenarios,
    discoverySuccess: entry.discoverySuccess,
    fullPlanSuccess: entry.fullPlanSuccess,
    verifiedCandidateObservations: entry.verifiedCandidateObservations,
    distinctVerifiedCandidates: entry.distinct.size,
    pageFetchCount: entry.pageFetchCount,
    meanDiscoveryLatencyMs: Number((entry.discoveryMs.reduce((a, b) => a + b, 0) / Math.max(1, entry.discoveryMs.length)).toFixed(2)),
    p95DiscoveryLatencyMs: percentile(entry.discoveryMs, 0.95),
    meanFullPlanLatencyMs: Number((entry.fullPlanMs.reduce((a, b) => a + b, 0) / Math.max(1, entry.fullPlanMs.length)).toFixed(2)),
    p95FullPlanLatencyMs: percentile(entry.fullPlanMs, 0.95),
  });
  return { provider, total: finalize(summary.total), buckets: Object.fromEntries(Object.entries(summary.buckets).map(([name, entry]) => [name, finalize(entry)])) };
}

async function main() {
  const scenarios = makeScenarios();
  const results = [];
  for (const provider of ["tavily", "sitemap"]) results.push(await benchmarkProvider(provider, scenarios));
  console.log(JSON.stringify({
    mode: "offline-deterministic-fixtures",
    scenarios: scenarios.length,
    matrixNote: "This is a fixture contract/parity matrix over eight canned recipes, with varied pantry, diet, swap, and dinner-count requests. It does not estimate live source reliability.",
    providerRuns: results.map((entry) => entry.total.scenarios),
    planNote: "Full-plan success uses the real handlePlanRequest validation path with a deterministic fixture chat response; it is not a Voyager or live-uptime measurement.",
    tavilyNote: "The Tavily comparison uses an injected local fixture response and makes no Tavily network request or credit spend.",
    results,
  }, null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { CORPUS, makeScenarios };
