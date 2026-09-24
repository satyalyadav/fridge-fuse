"use strict";

// RCP's official recipe API is a URL and metadata index, not a trusted recipe
// cache. Every selected page still goes through live-recipes' fresh verifier.
const {
  isPublicRecipeUrl,
  normalizeWords,
  recipeFitsEquipment,
  recipeViolatesDiet,
} = require("./live-recipes");

const RCP_ORIGIN = "https://recipecontextprotocol.com";
const RCP_HOST = "recipecontextprotocol.com";
const USER_AGENT = "FridgeFuseRecipePrototype/0.1";
const DEFAULT_MAX_API_PAGES = 6;
const DEFAULT_PAGE_SAMPLES = 3;
const DEFAULT_PER_PAGE = 60;
const DEFAULT_MAX_PAGE_CHECKS = 12;
const DEFAULT_MAX_CANDIDATES = 12;
const DEFAULT_MAX_API_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_HOST_DELAY_MS = 1100;

function positiveInt(value, fallback, maximum) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(maximum, number) : fallback;
}

function responseHeader(response, name) {
  try { return response?.headers?.get?.(name) || ""; } catch { return ""; }
}

function retryAfterMs(value, now = Date.now()) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(24 * 60 * 60 * 1000, seconds * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.min(24 * 60 * 60 * 1000, Math.max(0, at - now)) : 0;
}

function parseCategories(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.flatMap((item) => {
    if (typeof item === "string") return [item.trim()].filter(Boolean);
    if (item && typeof item === "object") return [String(item.name || item.title || "").trim()].filter(Boolean);
    return [];
  }).slice(0, 30);
}

function safeRecipeUrl(value) {
  if (!isPublicRecipeUrl(value)) return null;
  let parsed;
  try { parsed = new URL(value, `${RCP_ORIGIN}/`); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase().replace(/\.$/, "") !== RCP_HOST ||
      parsed.username || parsed.password || parsed.port && parsed.port !== "443" || parsed.search ||
      !/^\/recipes\/[a-z0-9][a-z0-9._/-]*\/?$/i.test(parsed.pathname)) return null;
  parsed.hash = "";
  return parsed;
}

function normalizeMetadataItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const timeMin = Number(item.total_time_minutes);
  if (!Number.isFinite(timeMin) || timeMin <= 0) return null;
  const pageUrl = safeRecipeUrl(item.url || (item.slug ? `${RCP_ORIGIN}/recipes/${encodeURIComponent(String(item.slug))}` : ""));
  if (!pageUrl || typeof item.title !== "string" || !item.title.trim()) return null;
  const title = item.title.trim().slice(0, 240);
  const categories = parseCategories(item.categories);
  const description = String(item.description || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const sourceName = String(item.source_name || "").trim().slice(0, 160);
  const license = String(item.license || "").trim().slice(0, 240);
  const notice = String(item.notice || item.attribution || "").replace(/\s+/g, " ").trim().slice(0, 500);
  return {
    url: pageUrl.href,
    slug: String(item.slug || pageUrl.pathname.split("/").filter(Boolean).pop() || "").slice(0, 180),
    title,
    description,
    categories,
    metadataTimeMin: timeMin,
    sourceName,
    license,
    notice,
  };
}

function categoryScore(entry, intent = "dinner") {
  const categoryWords = normalizeWords((entry.categories || []).join(" "));
  const words = normalizeWords([entry.title, entry.description, ...(entry.categories || [])].join(" "));
  const clearlyMain = /(?:^| )(main course|main dish|entree|dinner|supper)(?: |$)/.test(categoryWords);
  let score = 0;
  const negative = /(?:^| )(dessert|cake|pie|cookie|brownie|candy|pudding|beverage|drink|tea|cocktail|smoothie|sauce|condiment|jam|snack|appetizer)(?: |$)/.test(words);
  if (negative && !clearlyMain) return -100;
  if (negative) score -= 100;
  if (/(?:^| )(main course|main dish|entree|dinner|supper)(?: |$)/.test(words)) score += 50;
  if (/(?:^| )(curry|stew|casserole|pasta|rice bowl|bean dish|soup|salad|tacos?|stir fry|risotto)(?: |$)/.test(words)) score += 12;
  if (intent === "lunch" && /(?:^| )(lunch|sandwich|wrap)(?: |$)/.test(words)) score += 20;
  return score;
}

function selectMetadataPages(total, perPage, limit) {
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / Math.max(1, perPage)));
  const count = Math.min(totalPages, limit);
  if (count <= 1) return [1];
  const pages = [];
  for (let index = 0; index < count; index++) {
    const page = 1 + Math.round(index * (totalPages - 1) / (count - 1));
    if (!pages.includes(page)) pages.push(page);
  }
  return pages;
}

async function readJsonBody(response, maxBytes) {
  const rawLength = responseHeader(response, "content-length");
  const length = String(rawLength).trim() ? Number(rawLength) : NaN;
  if (Number.isFinite(length) && length > maxBytes) {
    throw Object.assign(new Error("RCP metadata response exceeded its body cap."), { code: "body-too-large" });
  }
  const chunks = [];
  let size = 0;
  const append = (value) => {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("RCP metadata response exceeded its body cap."), { code: "body-too-large" });
    chunks.push(chunk);
  };
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        try { append(next.value); } catch (error) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw error;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* best effort */ }
    }
  } else if (response?.body?.[Symbol.asyncIterator]) {
    try {
      for await (const value of response.body) append(value);
    } catch (error) {
      if (error.code === "body-too-large") throw error;
      throw error;
    }
  } else {
    // Lightweight injected response objects may expose text() only. Require
    // Content-Length there so production callers never buffer an unknown body.
    if (!Number.isFinite(length) || length < 0) {
      throw Object.assign(new Error("RCP metadata response has no bounded body stream or Content-Length."), { code: "unbounded-body" });
    }
    append(await response.text());
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (error) {
    throw Object.assign(new Error(`RCP metadata response was not valid JSON: ${error.message}`), { code: "bad-json" });
  }
}

function createRcpRecipeDiscovery(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const liveRecipeService = options.liveRecipeService || null;
  const verifyUrl = options.verifyUrl || liveRecipeService?.verifyUrl?.bind(liveRecipeService);
  const validatePublicUrl = options.validatePublicUrl || liveRecipeService?.validatePublicUrl?.bind(liveRecipeService);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 30000);
  const maxApiBytes = positiveInt(options.maxApiBytes, DEFAULT_MAX_API_BYTES, 2 * 1024 * 1024);
  const maxApiPages = positiveInt(options.maxApiPages, DEFAULT_MAX_API_PAGES, 6);
  const perPage = positiveInt(options.perPage, DEFAULT_PER_PAGE, 100);
  const maxPageChecks = positiveInt(options.maxPageChecks, DEFAULT_MAX_PAGE_CHECKS, 36);
  const maxCandidates = positiveInt(options.maxCandidates, DEFAULT_MAX_CANDIDATES, 24);
  const hostDelayMs = positiveInt(options.hostDelayMs, DEFAULT_HOST_DELAY_MS, 60000);
  const lastRequestAt = new Map();
  const hostTails = new Map();
  const cooldownUntil = new Map();
  const blockedHosts = new Set();

  async function waitForHost(host) {
    if (blockedHosts.has(host)) throw Object.assign(new Error("RCP requests are blocked after a publisher denial."), { code: "publisher-blocked" });
    const previous = hostTails.get(host) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    hostTails.set(host, previous.then(() => gate));
    await previous;
    try {
      if (blockedHosts.has(host)) throw Object.assign(new Error("RCP requests are blocked after a publisher denial."), { code: "publisher-blocked" });
      const last = lastRequestAt.get(host);
      const minimum = Math.max(hostDelayMs, cooldownUntil.get(host) - now() || 0);
      if (last !== undefined) {
        const remaining = Math.max(minimum - (now() - last), cooldownUntil.get(host) - now() || 0);
        if (remaining > 0) await sleep(remaining);
      } else {
        const cooldown = cooldownUntil.get(host) - now();
        if (cooldown > 0) await sleep(cooldown);
      }
      lastRequestAt.set(host, now());
    } finally {
      release();
    }
  }

  async function validatePublisherUrl(value, { api = false } = {}) {
    if (!isPublicRecipeUrl(value)) return { ok: false, failure: { status: "unsafe-url", message: "RCP URL is not a public HTTPS URL." } };
    let parsed;
    try { parsed = new URL(value); } catch { return { ok: false, failure: { status: "unsafe-url", message: "RCP URL is invalid." } }; }
    const safe = api
      ? parsed.hostname.toLowerCase() === RCP_HOST && parsed.pathname.replace(/\/$/, "") === "/recipes" && !parsed.username && !parsed.password && (!parsed.port || parsed.port === "443")
      : Boolean(safeRecipeUrl(parsed.href));
    if (!safe) return { ok: false, failure: { status: "unsafe-url", message: "RCP URL is outside the configured publisher endpoints." } };
    if (typeof validatePublicUrl !== "function") {
      return { ok: false, failure: { status: "unavailable", message: "A public URL validator is required before RCP network requests." } };
    }
    const result = await validatePublicUrl(parsed.href);
    if (!result?.ok) return result || { ok: false, failure: { status: "unsafe-url", message: "RCP URL failed public-address validation." } };
    return { ok: true, url: parsed };
  }

  async function requestApiPage(page, source, maxTimeMin, pageSize, metrics) {
    let current = new URL("/recipes", RCP_ORIGIN);
    current.searchParams.set("page", String(page));
    current.searchParams.set("per_page", String(pageSize));
    current.searchParams.set("max_total_time", String(maxTimeMin));
    if (source) current.searchParams.set("source", source);
    for (let hop = 0; hop <= 2; hop++) {
      const checked = await validatePublisherUrl(current.href, { api: true });
      if (!checked.ok) return checked;
      try { await waitForHost(RCP_HOST); } catch (error) {
        return { ok: false, blocked: true, failure: { status: error.code || "publisher-blocked", message: error.message } };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        metrics.apiRequests++;
        response = await fetchImpl(checked.url.href, {
          method: "GET",
          redirect: "manual",
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
      } catch (error) {
        return { ok: false, failure: { status: error.name === "AbortError" ? "timeout" : "network-error", message: `RCP metadata request failed: ${error.message}` } };
      } finally {
        clearTimeout(timer);
      }
      const status = Number(response?.status || 0);
      if (status === 429) {
        const delay = retryAfterMs(responseHeader(response, "retry-after"), now());
        cooldownUntil.set(RCP_HOST, now() + delay);
        return { ok: false, blocked: true, failure: { status, retryAfterMs: delay, message: "RCP returned HTTP 429. Discovery stopped without retrying." } };
      }
      if (status === 403) {
        blockedHosts.add(RCP_HOST);
        return { ok: false, blocked: true, failure: { status, message: "RCP returned HTTP 403. Discovery stopped." } };
      }
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (hop >= 2) return { ok: false, failure: { status: "too-many-redirects", message: "RCP API exceeded the redirect limit." } };
        const location = responseHeader(response, "location");
        if (!location) return { ok: false, failure: { status: "redirect-without-location", message: "RCP API redirect has no Location header." } };
        try { current = new URL(location, checked.url); } catch { return { ok: false, failure: { status: "unsafe-redirect", message: "RCP API redirect URL is invalid." } }; }
        continue;
      }
      if (!response?.ok) return { ok: false, failure: { status: status || "http-error", message: `RCP metadata request failed: HTTP ${status}.` } };
      try {
        const data = await readJsonBody(response, maxApiBytes);
        if (!data || !Array.isArray(data.items)) return { ok: false, failure: { status: "bad-response", message: "RCP metadata response has no items array." } };
        return { ok: true, data };
      } catch (error) {
        return { ok: false, failure: { status: error.code || "bad-response", message: error.message } };
      }
    }
    return { ok: false, failure: { status: "failed", message: "RCP metadata request failed." } };
  }

  async function findRecipes(input = {}) {
    const dinners = Math.min(7, Math.max(1, Math.floor(Number(input.dinners) || 1)));
    const maxTimeMin = Number(input.maxTimeMin) > 0 ? Math.min(1440, Number(input.maxTimeMin)) : 30;
    const minTimeMin = Number(input.minTimeMin) > 0 ? Math.min(maxTimeMin, Number(input.minTimeMin)) : 0;
    const equipment = Array.isArray(input.equipment) ? input.equipment.map(String) : [];
    const dietRules = Array.isArray(input.dietRules) ? input.dietRules : [];
    const exclude = new Set((Array.isArray(input.exclude) ? input.exclude : []).map(normalizeWords).filter(Boolean));
    const includeRecipe = normalizeWords(input.includeRecipe || "");
    const source = String(input.source || options.source || "wikibooks").trim();
    if (source && !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(source)) {
      return { ok: false, failure: { status: "unsafe-source", message: "RCP source filter contains unsupported characters." } };
    }
    const target = Math.min(maxCandidates, Math.max(dinners, dinners * 3));
    // A saved recipe may sit anywhere in the current 594-item Wikibooks set.
    // Use the largest documented page size and scan every page up to the cap.
    const requestedPageSize = includeRecipe ? 100 : perPage;
    const requestedPageLimit = includeRecipe ? maxApiPages : positiveInt(options.pagesPerDiscovery, Math.min(DEFAULT_PAGE_SAMPLES, maxApiPages), 6);
    const metrics = { apiRequests: 0, metadataItems: 0, knownTimeItems: 0, pageVerifications: 0, verifiedCandidates: 0 };
    const rejected = { metadata: 0, time: 0, category: 0, equipment: 0, diet: 0, excluded: 0, attribution: 0, unsafe: 0 };
    const failures = [];
    const found = [];
    const seen = new Set();
    if (typeof fetchImpl !== "function" || typeof verifyUrl !== "function" || typeof validatePublicUrl !== "function") {
      return { ok: false, failure: { status: "unavailable", message: "RCP discovery requires fetch, URL validation, and the live Recipe verifier." }, metrics };
    }
    if (blockedHosts.has(RCP_HOST)) {
      return { ok: false, failure: { status: "publisher-blocked", message: "RCP requests remain stopped after HTTP 403 or a page-level 429 without an exposed Retry-After header." }, metrics };
    }

    const first = await requestApiPage(1, source, maxTimeMin, requestedPageSize, metrics);
    if (!first.ok) return { ok: false, failure: first.failure, candidates: [], metrics, rejected };
    const firstPerPage = positiveInt(first.data.per_page, requestedPageSize, 100);
    const pages = selectMetadataPages(first.data.total, firstPerPage, requestedPageLimit);
    const responses = [first.data];
    for (const page of pages.slice(1)) {
      const next = await requestApiPage(page, source, maxTimeMin, requestedPageSize, metrics);
      if (!next.ok) {
        failures.push({ stage: "metadata", ...next.failure });
        if (next.blocked) break;
      } else responses.push(next.data);
    }
    const items = [];
    const seenUrls = new Set();
    for (const data of responses) {
      for (const raw of data.items.slice(0, requestedPageSize)) {
        metrics.metadataItems++;
        const entry = normalizeMetadataItem(raw);
        if (!entry) { rejected.metadata++; continue; }
        if (entry.metadataTimeMin > maxTimeMin) { rejected.time++; continue; }
        if (entry.metadataTimeMin < minTimeMin) { rejected.time++; continue; }
        metrics.knownTimeItems++;
        if (seenUrls.has(entry.url)) continue;
        seenUrls.add(entry.url);
        items.push(entry);
      }
    }
    const includeWords = new Set(includeRecipe.split(" ").filter(Boolean));
    const preferredLongerThan = Number(input.preferTimeOverMin) > 0 ? Number(input.preferTimeOverMin) : 0;
    const ranked = items.map((entry) => {
      let includeScore = 0;
      const words = new Set(normalizeWords(`${entry.title} ${entry.slug}`).split(" "));
      for (const word of includeWords) if (words.has(word)) includeScore++;
      const timePreference = preferredLongerThan && entry.metadataTimeMin > preferredLongerThan ? 1 : 0;
      return { entry, includeScore, timePreference, score: categoryScore(entry, input.mealType || "dinner") };
    }).sort((a, b) => b.includeScore - a.includeScore || b.timePreference - a.timePreference || b.score - a.score || a.entry.title.localeCompare(b.entry.title));
    const pageBudget = Math.min(maxPageChecks, Math.max(dinners, Number(input.maxPageChecks) || maxPageChecks));
    for (const { entry, score } of ranked) {
      if (found.length >= target || metrics.pageVerifications >= pageBudget) break;
      if (exclude.has(normalizeWords(entry.title)) || exclude.has(normalizeWords(entry.url))) { rejected.excluded++; continue; }
      if (score <= -100 && !input.allowNonMealCategories) { rejected.category++; continue; }
      const safeUrl = safeRecipeUrl(entry.url);
      if (!safeUrl) { rejected.unsafe++; continue; }
      const valid = await validatePublicUrl(safeUrl.href);
      if (!valid?.ok) {
        rejected.unsafe++;
        failures.push({ stage: "validate-page", url: safeUrl.href.slice(0, 300), ...(valid?.failure || { status: "unsafe-url", message: "RCP recipe URL failed validation." }) });
        continue;
      }
      metrics.pageVerifications++;
      let checked;
      try {
        checked = await verifyUrl(safeUrl.href, {
          fresh: true,
          allowedHosts: [RCP_HOST],
          beforeFetch: async (fetchUrl) => {
            const pageUrl = safeRecipeUrl(fetchUrl);
            if (!pageUrl) throw Object.assign(new Error("RCP recipe redirect left the official recipe path."), { code: "unsafe-redirect" });
            await waitForHost(RCP_HOST);
          },
        });
      } catch (error) {
        checked = { ok: false, failure: { status: error.code || "verify-error", message: error.message } };
      }
      if (!checked?.ok) {
        const failure = checked?.failure || { status: "verify-error", message: "RCP recipe verification failed." };
        failures.push({ stage: "recipe-page", url: safeUrl.href.slice(0, 300), ...failure });
        if (failure.status === 403 || failure.status === 429 || Number(failure.status) === 403 || Number(failure.status) === 429) {
          blockedHosts.add(RCP_HOST);
          break;
        }
        continue;
      }
      const candidate = checked.recipe;
      const finalUrl = safeRecipeUrl(candidate?.finalUrl || candidate?.sourceUrl || "");
      if (!finalUrl || !candidate?.title || !Number.isFinite(Number(candidate.timeMin))) { rejected.unsafe++; continue; }
      if (!candidate.timeMin || candidate.timeMin > maxTimeMin || candidate.timeMin < minTimeMin || candidate.timeMin > entry.metadataTimeMin) { rejected.time++; continue; }
      if (!candidate.equipment?.length || !recipeFitsEquipment(candidate, equipment)) { rejected.equipment++; continue; }
      if (recipeViolatesDiet(candidate, dietRules)) { rejected.diet++; continue; }
      if (exclude.has(normalizeWords(candidate.title)) || exclude.has(normalizeWords(finalUrl.href))) { rejected.excluded++; continue; }
      const attribution = String(candidate.attribution || entry.notice || "").trim();
      const license = String(candidate.license || entry.license || "").trim();
      if (!attribution || !license) { rejected.attribution++; continue; }
      const key = normalizeWords(finalUrl.href);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        ...candidate,
        finalUrl: finalUrl.href,
        sourceUrl: finalUrl.href,
        license,
        attribution,
        sourceName: entry.sourceName,
        attributionNotice: entry.notice || attribution,
        rcpMetadata: {
          slug: entry.slug,
          categories: entry.categories,
          sourceName: entry.sourceName,
          license,
          notice: entry.notice || attribution,
          metadataTimeMin: entry.metadataTimeMin,
        },
      });
    }
    metrics.verifiedCandidates = found.length;
    if (includeRecipe && !found.some((candidate) => normalizeWords(candidate.title) === includeRecipe)) {
      failures.push({ stage: "include", status: "not-found", message: "Requested recipe was not among the live verified RCP candidates." });
    }
    const includeSatisfied = !includeRecipe || found.some((candidate) => normalizeWords(candidate.title) === includeRecipe);
    if (found.length >= dinners && includeSatisfied) {
      return { ok: true, candidates: found.slice(0, maxCandidates), metrics, rejected, sourceFailures: failures.slice(0, 20) };
    }
    return {
      ok: false,
      candidates: found,
      metrics,
      rejected,
      sourceFailures: failures.slice(0, 20),
      failure: {
        status: failures.find((item) => item.status === 403 || item.status === 429)?.status || (found.length ? "insufficient-candidates" : "no-safe-recipes"),
        verified: found.length,
        attemptedUrls: metrics.pageVerifications,
        message: "RCP metadata leads did not produce enough live verified recipes for this request.",
      },
    };
  }

  return {
    findRecipes,
    metrics: { lastRequestAt, cooldownUntil, blockedHosts },
    limits: { maxApiPages, perPage, maxPageChecks, maxCandidates, hostDelayMs },
  };
}

module.exports = {
  createRcpRecipeDiscovery,
  categoryScore,
  normalizeMetadataItem,
  retryAfterMs,
  safeRecipeUrl,
  selectMetadataPages,
};
