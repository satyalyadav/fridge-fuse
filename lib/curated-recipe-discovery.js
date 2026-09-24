"use strict";

const { performance } = require("node:perf_hooks");

// A small, manually reviewed URL list replaces discovery only in this isolated
// prototype. URLs and tags rank leads; fresh page JSON-LD supplies every fact.
const {
  isPublicRecipeUrl,
  normalizeWords,
  recipeFitsEquipment,
  recipeViolatesDiet,
} = require("./live-recipes");
const DEFAULT_INDEX = require("../data/curated-recipe-leads.json");

const MAX_PAGE_FETCHES = 20;
const HOST_PACING_MARGIN_MS = 10;
const DEFAULT_PAGE_FETCHES = 8;
const DEFAULT_PAGE_CHECKS = 12;
const DEFAULT_CANDIDATES = 12;
const DINNER_REQUEST_MAX = 7;
const ALLOWED_LEAD_TAGS = new Set([
  "dinner", "microwave", "stove", "oven", "toaster-oven", "air-fryer", "rice-cooker",
  "kettle", "slow-cooker", "pressure-cooker", "blender", "sandwich-press",
  "vegetarian", "vegan", "dairy-free", "gluten-free",
]);
const DURATION_PATTERN = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/gi;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const OVERNIGHT_PATTERN = /\b(?:overnight|over\s+night|all\s+day|until\s+(?:the\s+)?next\s+day|the\s+next\s+day)\b/i;

function exactLeadUrl(value, policy) {
  if (!isPublicRecipeUrl(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = String(policy?.host || "").toLowerCase();
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== host || url.username || url.password ||
      (url.port && url.port !== "443") || url.search || url.hash || !url.pathname.startsWith(String(policy?.pathPrefix || "/"))) return null;
  return url;
}

function validateCuratedIndex(index = DEFAULT_INDEX) {
  const errors = [];
  const policies = Array.isArray(index?.sourcePolicies) ? index.sourcePolicies : [];
  const leads = Array.isArray(index?.leads) ? index.leads : [];
  const policyById = new Map();
  for (const [position, policy] of policies.entries()) {
    const id = String(policy?.id || "");
    const host = String(policy?.host || "").toLowerCase();
    if (!id || policyById.has(id)) errors.push({ status: "duplicate-or-missing-source-id", position });
    if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) errors.push({ status: "unsafe-source-host", sourceId: id || null });
    if (!String(policy?.rightsStatus || "").startsWith("prototype-only")) errors.push({ status: "source-must-be-explicitly-prototype-only", sourceId: id || null });
    if (!Number.isFinite(Number(policy?.minimumRequestGapMs)) || Number(policy.minimumRequestGapMs) < 1000) {
      errors.push({ status: "source-pacing-below-one-second", sourceId: id || null });
    }
    if (id) policyById.set(id, policy);
  }
  const seen = new Set();
  for (const [position, lead] of leads.entries()) {
    const allowedFields = new Set(["url", "sourceId", "leadTags"]);
    for (const field of Object.keys(lead || {})) {
      if (!allowedFields.has(field)) errors.push({ status: "lead-stores-non-url-metadata", position, field });
    }
    const policy = policyById.get(String(lead?.sourceId || ""));
    if (!policy) {
      errors.push({ status: "unknown-source", position });
      continue;
    }
    const url = exactLeadUrl(lead.url, policy);
    if (!url) {
      errors.push({ status: "unsafe-or-out-of-scope-url", position });
      continue;
    }
    if (seen.has(url.href)) errors.push({ status: "duplicate-url", position });
    seen.add(url.href);
    const tags = Array.isArray(lead.leadTags) ? lead.leadTags : [];
    if (!tags.length || tags.length > 8 || tags.some((tag) => !ALLOWED_LEAD_TAGS.has(String(tag).toLowerCase()))) {
      errors.push({ status: "invalid-ranking-hints", position });
    }
  }
  if (index?.schemaVersion !== 1) errors.push({ status: "unsupported-schema-version" });
  if (!leads.length) errors.push({ status: "empty-index" });
  return { ok: errors.length === 0, errors, leadCount: leads.length, sourceCount: policyById.size, policyById };
}

function numberValue(value) {
  const text = String(value || "").toLowerCase();
  return Number.isFinite(Number(text)) ? Number(text) : NUMBER_WORDS[text] || 0;
}

function instructionTimeConflict(recipe, maxTimeMin) {
  const declared = Number(recipe?.timeMin);
  const instructions = (Array.isArray(recipe?.rawInstructions) ? recipe.rawInstructions : recipe?.instructions || []).join(" ");
  if (OVERNIGHT_PATTERN.test(instructions)) return { status: "overnight-step" };
  for (const match of instructions.matchAll(DURATION_PATTERN)) {
    const amount = numberValue(match[1]);
    const unit = String(match[2]).toLowerCase();
    const minutes = /^(?:day|days)$/.test(unit) ? amount * 1440 : /^(?:hour|hours|hr|hrs)$/.test(unit) ? amount * 60 : /^(?:second|seconds|sec|secs)$/.test(unit) ? amount / 60 : amount;
    if (minutes > declared) return { status: "instruction-exceeds-jsonld-time", durationMin: Math.ceil(minutes) };
    if (minutes > maxTimeMin) return { status: "instruction-exceeds-request-time", durationMin: Math.ceil(minutes) };
  }
  return null;
}

function canonicalTag(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
}

function requestSignals(input) {
  const signals = new Set();
  for (const equipment of Array.isArray(input.equipment) ? input.equipment : []) signals.add(canonicalTag(equipment));
  for (const rule of Array.isArray(input.dietRules) ? input.dietRules : []) {
    for (const value of [rule?.id, rule?.label, ...(Array.isArray(rule?.aliases) ? rule.aliases : [])]) {
      const tag = canonicalTag(value);
      if (tag) signals.add(tag);
    }
    // Vegan recipes are useful leads for dairy-free requests, but the page's
    // ingredient text still decides whether they pass the hard exclusion net.
    if (canonicalTag(rule?.id) === "dairy-free") signals.add("vegan");
  }
  return signals;
}

function rankCuratedLeads(leads, input = {}) {
  const signals = requestSignals(input);
  const excludeUrls = new Set((Array.isArray(input.excludeUrls) ? input.excludeUrls : []).map((url) => String(url).trim()));
  const excluded = new Set((Array.isArray(input.exclude) ? input.exclude : []).map(normalizeWords).filter(Boolean));
  const include = normalizeWords(input.includeRecipe || "");
  const scored = leads.map((lead, index) => ({
    lead,
    index,
    score: lead.leadTags.reduce((score, rawTag) => score + (signals.has(canonicalTag(rawTag)) ? 25 : 0), 0) +
      (include && normalizeWords(new URL(lead.url).pathname.split("/").pop().replace(/-/g, " ")).includes(include) ? 1000 : 0),
  })).filter(({ lead }) => {
    const url = lead.url;
    const slug = normalizeWords(new URL(url).pathname.split("/").pop().replace(/-/g, " "));
    return !excludeUrls.has(url) && !excluded.has(slug);
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const diversified = [];
  for (let start = 0; start < scored.length;) {
    let end = start + 1;
    while (end < scored.length && scored[end].score === scored[start].score) end++;
    const group = scored.slice(start, end);
    const sourceOrder = [...new Set(group.map((entry) => entry.lead.sourceId))];
    while (group.length) {
      for (const sourceId of sourceOrder) {
        const position = group.findIndex((entry) => entry.lead.sourceId === sourceId);
        if (position >= 0) diversified.push(group.splice(position, 1)[0].lead);
      }
    }
    start = end;
  }
  return diversified;
}

function createHostPacer({ now, sleep, requestedDelayMs = 0 } = {}) {
  const clock = typeof now === "function" ? now : () => performance.now();
  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextStart = new Map();
  const queues = new Map();
  return async (host, policy) => {
    const prior = queues.get(host) || Promise.resolve();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const queued = prior.then(() => held);
    queues.set(host, queued);
    await prior;
    try {
      const policyDelay = Number(policy?.minimumRequestGapMs) || 0;
      const delay = Math.max(policyDelay, Number(requestedDelayMs) || 0);
      const waitMs = Math.max(0, (nextStart.get(host) || 0) - clock());
      if (waitMs) await pause(waitMs);
      const startedAt = clock();
      // The paced callback runs just before fetch starts. A small margin keeps
      // the observed request-to-request gap above the publisher minimum despite
      // that handoff and timer precision.
      nextStart.set(host, startedAt + delay + HOST_PACING_MARGIN_MS);
      return startedAt;
    } finally {
      release();
    }
  };
}

function countLimit(value, fallback, maximum) {
  if (value == null) return fallback;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(maximum, number));
}

function createCuratedRecipeDiscovery(options = {}) {
  const index = options.index || DEFAULT_INDEX;
  const validation = validateCuratedIndex(index);
  if (!validation.ok) {
    const error = new Error(`Curated recipe index is invalid (${validation.errors.map((entry) => entry.status).join(", ")}).`);
    error.code = "invalid-curated-index";
    error.validation = validation.errors;
    throw error;
  }
  const verifyUrl = options.liveRecipeService?.verifyUrl;
  if (typeof verifyUrl !== "function") throw new TypeError("A live recipe verifier with verifyUrl() is required.");
  const leads = index.leads;
  const policyById = validation.policyById;
  const hostBlocked = new Set();
  const pace = createHostPacer({ now: options.now, sleep: options.sleep, requestedDelayMs: options.hostDelayMs });
  const defaultPageCap = countLimit(options.maxPageFetches, DEFAULT_PAGE_FETCHES, MAX_PAGE_FETCHES);
  const defaultCheckCap = countLimit(options.maxPageChecks, DEFAULT_PAGE_CHECKS, MAX_PAGE_FETCHES);
  const maxCandidates = countLimit(options.maxCandidates, DEFAULT_CANDIDATES, DEFAULT_CANDIDATES) || DEFAULT_CANDIDATES;

  async function findRecipes(input = {}) {
    const startedAt = Date.now();
    const requested = Math.max(1, Math.min(DINNER_REQUEST_MAX, Math.floor(Number(input.dinners) || 1)));
    const maxTimeMin = Number(input.maxTimeMin) > 0 ? Number(input.maxTimeMin) : 30;
    const requestPageCap = countLimit(input.maxPageFetches, defaultPageCap, MAX_PAGE_FETCHES);
    const requestCheckCap = countLimit(input.maxPageChecks, defaultCheckCap, MAX_PAGE_FETCHES);
    const targetCandidates = Math.min(maxCandidates, countLimit(input.maxCandidates, Math.max(requested, requested * 3), maxCandidates));
    const equipment = Array.isArray(input.equipment) ? input.equipment.map(String) : [];
    const dietRules = Array.isArray(input.dietRules) ? input.dietRules : [];
    const ranked = rankCuratedLeads(leads, input);
    const candidates = [];
    const sourceFailures = [];
    const rejectionReasons = [];
    const rejected = { prototypeOnly: 0, publisherBlocked: 0, pageFetch: 0, pageParse: 0, time: 0, equipment: 0, diet: 0, excluded: 0, attribution: 0, license: 0, duplicate: 0 };
    const seenTitles = new Set();
    let pageChecks = 0;
    let pageFetches = 0;
    let verifiedPages = 0;
    let stoppedAtCap = false;
    let stoppedBySource = false;

    for (const lead of ranked) {
      if (candidates.length >= targetCandidates || pageChecks >= requestCheckCap || pageFetches >= requestPageCap) break;
      const policy = policyById.get(lead.sourceId);
      if (!policy) continue;
      if (hostBlocked.has(policy.host)) {
        rejected.publisherBlocked++;
        stoppedBySource = [...new Set([...policyById.values()].map((entry) => entry.host))].every((host) => hostBlocked.has(host));
        continue;
      }
      if (String(policy.rightsStatus).startsWith("prototype-only") && input.allowPrototypeOnly !== true) {
        rejected.prototypeOnly++;
        rejectionReasons.push({ url: lead.url, status: "prototype-only-source" });
        continue;
      }

      pageChecks++;
      let capHit = false;
      const result = await verifyUrl(lead.url, {
        fresh: true,
        allowedHosts: [policy.host],
        beforeFetch: async (currentUrl) => {
          if (pageFetches >= requestPageCap) {
            capHit = true;
            stoppedAtCap = true;
            const error = new Error("Curated recipe page-fetch cap reached.");
            error.code = "curated-page-fetch-cap";
            throw error;
          }
          const host = new URL(currentUrl).hostname.toLowerCase();
          await pace(host, policy);
          pageFetches++;
        },
      });
      if (!result?.ok || !result.recipe) {
        const status = capHit ? "page-fetch-cap" : String(result?.failure?.status || "verify-failed");
        sourceFailures.push({ url: lead.url, status });
        if (status === "page-fetch-cap") {
          rejected.pageFetch++;
          rejectionReasons.push({ url: lead.url, status });
          break;
        }
        if (["403", "429"].includes(status)) {
          hostBlocked.add(policy.host);
          rejected.publisherBlocked++;
          rejectionReasons.push({ url: lead.url, status: "publisher-blocked", httpStatus: Number(status) });
          stoppedBySource = [...new Set([...policyById.values()].map((entry) => entry.host))].every((host) => hostBlocked.has(host));
          continue;
        }
        rejected.pageParse++;
        rejectionReasons.push({ url: lead.url, status });
        continue;
      }

      verifiedPages++;
      const recipe = result.recipe;
      const time = Number(recipe.timeMin);
      if (!Number.isFinite(time) || time <= 0 || time > maxTimeMin) {
        rejected.time++;
        rejectionReasons.push({ url: lead.url, status: "time" });
        continue;
      }
      const contradictoryTime = instructionTimeConflict(recipe, maxTimeMin);
      if (contradictoryTime) {
        rejected.time++;
        rejectionReasons.push({ url: lead.url, status: contradictoryTime.status, durationMin: contradictoryTime.durationMin || null });
        continue;
      }
      if (!recipeFitsEquipment(recipe, equipment)) {
        rejected.equipment++;
        rejectionReasons.push({ url: lead.url, status: "equipment" });
        continue;
      }
      const dietViolation = recipeViolatesDiet(recipe, dietRules);
      if (dietViolation) {
        rejected.diet++;
        rejectionReasons.push({ url: lead.url, status: "diet", term: String(dietViolation).slice(0, 60) });
        continue;
      }
      const titleKey = normalizeWords(recipe.title);
      if (!titleKey || seenTitles.has(titleKey)) {
        rejected.duplicate++;
        rejectionReasons.push({ url: lead.url, status: "duplicate-title" });
        continue;
      }
      if (policy.attributionRequired && !String(recipe.attribution || "").trim()) {
        rejected.attribution++;
        rejectionReasons.push({ url: lead.url, status: "missing-attribution" });
        continue;
      }
      const linkAttribution = [String(recipe.publisher || "").trim(), String(recipe.title || "").trim(), String(recipe.finalUrl || recipe.sourceUrl || lead.url).trim()]
        .filter(Boolean).join(" | ");
      if (policy.linkAttributionRequired && !linkAttribution) {
        rejected.attribution++;
        rejectionReasons.push({ url: lead.url, status: "missing-link-attribution" });
        continue;
      }
      if (policy.licenseRequired && !String(recipe.license || "").trim()) {
        rejected.license++;
        rejectionReasons.push({ url: lead.url, status: "missing-license" });
        continue;
      }

      seenTitles.add(titleKey);
      candidates.push({
        ...recipe,
        leadUrl: lead.url,
        leadTags: [...lead.leadTags],
        sourcePolicyId: policy.id,
        sourceRightsStatus: policy.rightsStatus,
        linkAttribution,
        prototypeOnly: String(policy.rightsStatus).startsWith("prototype-only"),
        productionEligible: false,
      });
    }

    const include = normalizeWords(input.includeRecipe || "");
    const includeFound = !include || candidates.some((candidate) => normalizeWords(candidate.title) === include);
    const ok = candidates.length >= requested && includeFound;
    const metrics = {
      leadCount: leads.length,
      rankedLeads: ranked.length,
      pageChecks,
      pageFetches,
      verifiedPages,
      verifiedCandidates: candidates.length,
      requestedDinners: requested,
      targetCandidates,
      maxPageFetches: requestPageCap,
      maxPageChecks: requestCheckCap,
      latencyMs: Date.now() - startedAt,
      stoppedAtCap,
      stoppedBySource,
      blockedPublisherCount: hostBlocked.size,
    };
    const failureStatus = include && !includeFound
      ? "include-not-found"
      : candidates.length
        ? "insufficient-candidates"
        : stoppedBySource
          ? "publisher-blocked"
          : rejected.prototypeOnly && pageChecks === 0
            ? "prototype-only-index"
            : "no-safe-recipes";
    const failure = ok ? null : {
      status: failureStatus,
      message: include && !includeFound ? "The requested included recipe was not among the freshly verified curated leads." : "The curated URL index did not yield enough freshly verified safe candidates.",
      sourceFailures,
      rejected,
      rejectionReasons,
      metrics,
    };
    return { ok, candidates: candidates.slice(0, maxCandidates), failure, sourceFailures, rejected, rejectionReasons, metrics };
  }

  return { findRecipes, indexStats: { leadCount: leads.length, sourceCount: validation.sourceCount }, validateIndex: () => validation };
}

module.exports = {
  createCuratedRecipeDiscovery,
  validateCuratedIndex,
  exactLeadUrl,
  instructionTimeConflict,
  rankCuratedLeads,
};
