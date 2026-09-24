"use strict";

// Bounded link-only audit. It reports titles and verification outcomes, never
// copies recipe ingredients or instructions into the audit output.
const { createLiveRecipeService } = require("../lib/live-recipes");
const { createCuratedRecipeDiscovery } = require("../lib/curated-recipe-discovery");
const curatedIndex = require("../data/curated-recipe-leads.json");
const dietRules = require("../data/diet-rules.json").rules;

const GLOBAL_PAGE_GET_CAP = 20;
const PER_CASE_PAGE_GET_CAP = 4;
const PER_CASE_LEAD_CHECK_CAP = 6;
const REQUEST_GAP_MS = 1200;

function summarizeStatuses(events) {
  return events.reduce((counts, event) => {
    const status = String(event.status || "network-error");
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function minGapByHost(events) {
  const gaps = new Map();
  const last = new Map();
  for (const event of events) {
    const prior = last.get(event.host);
    if (prior != null) gaps.set(event.host, Math.min(gaps.get(event.host) ?? Infinity, event.startedAt - prior));
    last.set(event.host, event.startedAt);
  }
  return Object.fromEntries(gaps);
}

async function runAudit(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const globalCap = Math.max(1, Math.min(GLOBAL_PAGE_GET_CAP, Math.floor(Number(options.globalPageGetCap) || GLOBAL_PAGE_GET_CAP)));
  const gapMs = Math.max(REQUEST_GAP_MS, Math.floor(Number(options.requestGapMs) || REQUEST_GAP_MS));
  const events = [];
  const verificationCalls = [];
  let activeCase = "starting";
  let globalCapHit = false;

  const countedFetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (events.length >= globalCap) {
      globalCapHit = true;
      const error = new Error("Curated live audit page-fetch cap reached.");
      error.code = "audit-global-page-cap";
      throw error;
    }
    const at = Date.now();
    let response;
    try {
      response = await fetchImpl(url.href, { ...init, redirect: "manual" });
    } catch (error) {
      events.push({ caseId: activeCase, host: url.hostname, url: url.href, startedAt: at, status: error.code || "network-error" });
      throw error;
    }
    events.push({ caseId: activeCase, host: url.hostname, url: url.href, startedAt: at, status: Number(response?.status || 0) });
    return response;
  };

  const verifiedRecipes = createLiveRecipeService({ fetchImpl: countedFetch, recipeFetch: countedFetch });
  const liveRecipeService = {
    async verifyUrl(url, verifyOptions) {
      verificationCalls.push({ caseId: activeCase, url });
      return verifiedRecipes.verifyUrl(url, verifyOptions);
    },
  };
  const discovery = createCuratedRecipeDiscovery({
    index: curatedIndex,
    liveRecipeService,
    maxPageFetches: PER_CASE_PAGE_GET_CAP,
    maxPageChecks: PER_CASE_LEAD_CHECK_CAP,
    hostDelayMs: gapMs,
  });

  const getDiet = (id) => dietRules.find((rule) => rule.id === id);
  const scenarios = [
    { id: "microwave-dinner-30", input: { dinners: 1, maxTimeMin: 30, equipment: ["microwave"], dietRules: [] } },
    { id: "stove-dinner-45", input: { dinners: 1, maxTimeMin: 45, equipment: ["stove"], dietRules: [] } },
    { id: "vegetarian-stove-60", input: { dinners: 1, maxTimeMin: 60, equipment: ["stove"], dietRules: [getDiet("vegetarian")] } },
    { id: "vegan-stove-60", input: { dinners: 1, maxTimeMin: 60, equipment: ["stove"], dietRules: [getDiet("vegan")] } },
    { id: "dairy-free-stove-60", input: { dinners: 1, maxTimeMin: 60, equipment: ["stove"], dietRules: [getDiet("dairy-free")] } },
  ];
  const distinctCandidates = new Map();
  const caseResults = [];

  for (const scenario of scenarios) {
    if (globalCapHit || events.length >= globalCap) break;
    activeCase = scenario.id;
    const eventStart = events.length;
    const verifyStart = verificationCalls.length;
    const startedAt = Date.now();
    const result = await discovery.findRecipes({
      ...scenario.input,
      allowPrototypeOnly: true,
      maxPageFetches: PER_CASE_PAGE_GET_CAP,
      maxPageChecks: PER_CASE_LEAD_CHECK_CAP,
      maxCandidates: 3,
    });
    const verifiedUrls = verificationCalls.slice(verifyStart).map((entry) => entry.url);
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    for (const candidate of candidates) distinctCandidates.set(candidate.finalUrl || candidate.sourceUrl, candidate);
    const caseEvents = events.slice(eventStart);
    caseResults.push({
      caseId: scenario.id,
      discoverySuccess: result.ok,
      verifiedCandidateCount: candidates.length,
      distinctVerifiedCandidatesInCase: new Set(candidates.map((candidate) => candidate.finalUrl || candidate.sourceUrl)).size,
      candidates: candidates.map((candidate) => ({
        title: candidate.title,
        url: candidate.finalUrl || candidate.sourceUrl,
        timeMin: candidate.timeMin,
        equipment: candidate.equipment,
        sourcePolicyId: candidate.sourcePolicyId,
        rightsStatus: candidate.sourceRightsStatus,
        productionEligible: candidate.productionEligible,
        hasLicense: Boolean(candidate.license),
        hasSourceAttribution: Boolean(candidate.attribution),
        linkAttribution: candidate.linkAttribution,
      })),
      pageGetCount: caseEvents.length,
      leadChecks: verifiedUrls.length,
      statusCounts: summarizeStatuses(caseEvents),
      rejected: result.rejected,
      failureReasons: result.rejectionReasons,
      sourceFailures: result.sourceFailures,
      failureStatus: result.failure?.status || null,
      latencyMs: Date.now() - startedAt,
    });
  }

  activeCase = "complete";
  return {
    mode: "live-curated-link-audit",
    note: "URL-only index audit. A verified recipe here is still prototype-only and not production-cleared. Recipe instructions and ingredients are neither saved nor printed. Coverage reflects this small, manually curated batch, not publisher-wide availability.",
    policy: {
      sourcePolicies: curatedIndex.sourcePolicies.map(({ id, host, robotsStatus, robotsChecked, rightsStatus }) => ({ id, host, robotsStatus, robotsChecked, rightsStatus })),
      rightsNote: "Public page access, link attribution, and permission to republish full recipe text are separate questions. No source in this prototype is marked production-cleared.",
    },
    caps: {
      maxCases: scenarios.length,
      perCasePageGetCap: PER_CASE_PAGE_GET_CAP,
      perCaseLeadCheckCap: PER_CASE_LEAD_CHECK_CAP,
      globalPageGetCap: globalCap,
      minimumPerHostGapMs: gapMs,
    },
    actual: {
      casesRun: caseResults.length,
      pageGets: events.length,
      verifiedLeadChecks: verificationCalls.length,
      distinctVerifiedCandidates: distinctCandidates.size,
      statusCounts: summarizeStatuses(events),
      minGapByHostMs: minGapByHost(events),
      globalCapHit,
    },
    cases: caseResults,
  };
}

if (require.main === module) {
  runAudit().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: "audit-error", code: error.code || "error", message: String(error?.message || error).slice(0, 180) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runAudit, minGapByHost, summarizeStatuses };
