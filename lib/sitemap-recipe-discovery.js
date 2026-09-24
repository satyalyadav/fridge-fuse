"use strict";

// Isolated sitemap discovery experiment. The index stores only sitemap URL
// metadata; every accepted candidate is freshly fetched by live-recipes.
const {
  isPublicRecipeUrl,
  recipeFitsEquipment,
  recipeViolatesDiet,
  normalizeWords,
} = require("./live-recipes");
const net = require("node:net");

const USER_AGENT = "FridgeFuseRecipePrototype";
const DEFAULT_INDEX_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 1200 * 1024;
const DEFAULT_MAX_SITEMAPS = 4;
const DEFAULT_MAX_SITEMAP_DEPTH = 2;
const DEFAULT_MAX_URLS = 10000;
const DEFAULT_MAX_PAGE_CHECKS = 12;
const DEFAULT_MAX_CANDIDATES = 12;
const DEFAULT_HOST_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10000;

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => safeCodePoint(Number(decimal)));
}

function safeCodePoint(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "�";
}

function parseSitemapXml(xml, { baseUrl = "https://example.invalid/sitemap.xml", maxEntries = DEFAULT_MAX_URLS } = {}) {
  const text = String(xml || "");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) {
    return { ok: false, failure: { status: "unsafe-xml", message: "Sitemap DTD and entity declarations are not accepted." } };
  }
  const root = /<\s*(?:[\w.-]+:)?(urlset|sitemapindex)\b/i.exec(text)?.[1]?.toLowerCase();
  if (!root) return { ok: false, failure: { status: "bad-sitemap", message: "Sitemap XML has no urlset or sitemapindex root." } };
  const tag = root === "urlset" ? "url" : "sitemap";
  const entries = [];
  const seen = new Set();
  const expression = new RegExp(`<\\s*(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\s*\\/(?:[\\w.-]+:)?${tag}\\s*>`, "gi");
  for (const match of text.matchAll(expression)) {
    if (entries.length >= Math.max(1, maxEntries)) break;
    const loc = /<\s*(?:[\w.-]+:)?loc\b[^>]*>([\s\S]*?)<\s*\/(?:[\w.-]+:)?loc\s*>/i.exec(match[1])?.[1];
    if (!loc) continue;
    let url;
    try {
      url = new URL(decodeXml(loc.trim()), baseUrl);
      url.hash = "";
    } catch {
      continue;
    }
    const key = url.href;
    if (seen.has(key)) continue;
    seen.add(key);
    const rawLastmod = /<\s*(?:[\w.-]+:)?lastmod\b[^>]*>([\s\S]*?)<\s*\/(?:[\w.-]+:)?lastmod\s*>/i.exec(match[1])?.[1];
    const parsedDate = rawLastmod ? Date.parse(decodeXml(rawLastmod.trim())) : NaN;
    entries.push({ url: key, lastmod: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null });
  }
  return { ok: true, kind: root, entries, truncated: entries.length >= maxEntries };
}

function parseRobotsTxt(text, userAgent = USER_AGENT) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  for (const original of String(text || "").split(/\r?\n/)) {
    const line = original.split("#", 1)[0].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || current.hasDirective) {
        current = { agents: [], rules: [], crawlDelayMs: 0, hasDirective: false };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    current.hasDirective = true;
    if ((key === "allow" || key === "disallow") && value) current.rules.push({ allow: key === "allow", path: value });
    if (key === "crawl-delay" && Number.isFinite(Number(value)) && Number(value) >= 0) {
      current.crawlDelayMs = Math.max(current.crawlDelayMs, Number(value) * 1000);
    }
  }
  const agent = String(userAgent).toLowerCase();
  const scored = groups.map((group) => ({
    group,
    score: Math.max(-1, ...group.agents.map((name) => name === "*" ? 0 : agent.includes(name) ? name.length : -1)),
  })).filter((entry) => entry.score >= 0);
  const bestScore = Math.max(-1, ...scored.map((entry) => entry.score));
  const selected = scored.filter((entry) => entry.score === bestScore).map((entry) => entry.group);
  return {
    rules: selected.flatMap((group) => group.rules),
    crawlDelayMs: Math.max(0, ...selected.map((group) => group.crawlDelayMs)),
    sitemaps: [...new Set(sitemaps)],
  };
}

function robotsAllows(policy, value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  const path = `${url.pathname}${url.search}`;
  const matches = (policy?.rules || []).filter((rule) => {
    const anchored = rule.path.endsWith("$");
    const raw = anchored ? rule.path.slice(0, -1) : rule.path;
    const pattern = raw.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    try { return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path); } catch { return false; }
  }).sort((a, b) => b.path.replace(/[\*$]/g, "").length - a.path.replace(/[\*$]/g, "").length || Number(b.allow) - Number(a.allow));
  return !matches.length || matches[0].allow;
}

function normalizeSource(raw) {
  let origin;
  try { origin = new URL(raw?.origin || `https://${raw?.host || ""}`); } catch { return null; }
  const hostname = origin.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicRecipeUrl(origin.href) || net.isIP(hostname) || origin.username || origin.password || origin.port && origin.port !== "443") return null;
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  const allowedHosts = new Set([hostname]);
  for (const entry of Array.isArray(raw?.allowedHosts) ? raw.allowedHosts : []) {
    const host = String(entry).toLowerCase().replace(/\.$/, "");
    if (host && /^[a-z0-9.-]+$/i.test(host) && !host.startsWith(".") && !host.includes("..")) allowedHosts.add(host);
  }
  return {
    id: String(raw?.id || hostname).slice(0, 80),
    origin,
    hostname,
    allowedHosts,
    sitemapUrls: Array.isArray(raw?.sitemapUrls) ? raw.sitemapUrls.slice(0, DEFAULT_MAX_SITEMAPS).map(String) : [],
  };
}

function allowedUrl(value, hosts) {
  if (!isPublicRecipeUrl(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hosts.has(hostname) || net.isIP(hostname) || url.port && url.port !== "443") return null;
  if (url.search) return null;
  url.hash = "";
  return url;
}

async function readCappedBody(response, maxBytes) {
  const length = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw Object.assign(new Error("Response exceeded the configured body limit."), { code: "body-too-large" });
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        size += chunk.length;
        if (size > maxBytes) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw Object.assign(new Error("Response exceeded the configured body limit."), { code: "body-too-large" });
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* best effort */ }
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (response?.body?.[Symbol.asyncIterator]) {
    const chunks = [];
    let size = 0;
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) throw Object.assign(new Error("Response exceeded the configured body limit."), { code: "body-too-large" });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw Object.assign(new Error("Response exceeded the configured body limit."), { code: "body-too-large" });
  return text;
}

function slugTokens(url) {
  try { return new Set(normalizeWords(new URL(url).pathname.split("/").filter(Boolean).pop() || "").split(" ").filter(Boolean)); } catch { return new Set(); }
}

function rankEntries(entries, input) {
  const requested = new Set(normalizeWords(input.includeRecipe || "").split(" ").filter(Boolean));
  const score = (entry) => {
    const slug = slugTokens(entry.url);
    let overlap = 0;
    for (const word of requested) if (slug.has(word)) overlap++;
    return overlap;
  };
  return [...entries].sort((a, b) => score(b) - score(a) || Date.parse(b.lastmod || "") - Date.parse(a.lastmod || "") || a.url.localeCompare(b.url));
}

function selectPageEntries(entries, input, budget) {
  const limit = Math.max(0, Math.floor(Number(budget) || 0));
  if (entries.length <= limit) return entries;
  if (!limit) return [];
  const includeWords = new Set(normalizeWords(input.includeRecipe || "").split(" ").filter(Boolean));
  const slug = entries[0] ? slugTokens(entries[0].url) : new Set();
  const includeLead = includeWords.size && [...includeWords].some((word) => slug.has(word)) ? entries[0] : null;
  const selected = includeLead ? [includeLead] : [];
  const remaining = entries.filter((entry) => entry !== includeLead);
  const slots = limit - selected.length;
  for (let slot = 0; slot < slots; slot++) {
    const index = Math.min(remaining.length - 1, Math.floor((slot + 0.5) * remaining.length / slots));
    if (index >= 0) selected.push(remaining[index]);
  }
  return selected;
}

function createSitemapRecipeDiscovery(options = {}) {
  const sources = (Array.isArray(options.sources) ? options.sources : []).map(normalizeSource).filter(Boolean).slice(0, 8);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const liveRecipeService = options.liveRecipeService || null;
  const verifyUrl = options.verifyUrl || liveRecipeService?.verifyUrl?.bind(liveRecipeService);
  const validatePublicUrl = options.validatePublicUrl || liveRecipeService?.validatePublicUrl?.bind(liveRecipeService);
  const reportFailure = typeof options.reportFailure === "function" ? options.reportFailure : () => null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const indexTtlMs = Number(options.indexTtlMs) > 0 ? Number(options.indexTtlMs) : DEFAULT_INDEX_TTL_MS;
  const maxBodyBytes = Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;
  const maxSitemaps = Number.isInteger(options.maxSitemaps) && options.maxSitemaps > 0 ? options.maxSitemaps : DEFAULT_MAX_SITEMAPS;
  const maxSitemapDepth = Number.isInteger(options.maxSitemapDepth) && options.maxSitemapDepth >= 0 ? options.maxSitemapDepth : DEFAULT_MAX_SITEMAP_DEPTH;
  const maxUrlsPerSource = Number.isInteger(options.maxUrlsPerSource) && options.maxUrlsPerSource > 0 ? options.maxUrlsPerSource : DEFAULT_MAX_URLS;
  const maxPageChecks = Number.isInteger(options.maxPageChecks) && options.maxPageChecks > 0 ? options.maxPageChecks : DEFAULT_MAX_PAGE_CHECKS;
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0 ? options.maxCandidates : DEFAULT_MAX_CANDIDATES;
  const hostDelayMs = Number.isFinite(Number(options.hostDelayMs)) && Number(options.hostDelayMs) >= 0 ? Number(options.hostDelayMs) : DEFAULT_HOST_DELAY_MS;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const indexCache = new Map();
  const lastRequestAt = new Map();
  const hostTails = new Map();
  const hostDelays = new Map();

  async function waitForHost(host) {
    const previous = hostTails.get(host) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    hostTails.set(host, previous.then(() => gate));
    await previous;
    try {
      const last = lastRequestAt.get(host);
      const minimum = Math.max(hostDelayMs, hostDelays.get(host) || 0);
      if (last !== undefined) {
        const remaining = minimum - (now() - last);
        if (remaining > 0) await sleep(remaining);
      }
      lastRequestAt.set(host, now());
    } finally {
      release();
    }
  }

  async function validate(url, source) {
    const safe = allowedUrl(url, source.allowedHosts);
    if (!safe) return { ok: false, failure: { status: "unsafe-url", message: "Sitemap URL is not a safe HTTPS URL on the configured publisher host." } };
    if (typeof validatePublicUrl !== "function") return { ok: false, failure: { status: "unavailable", message: "A public URL validator is required for sitemap discovery." } };
    const checked = await validatePublicUrl(safe.href);
    if (!checked?.ok) return checked || { ok: false, failure: { status: "unsafe-url", message: "Publisher URL failed public-address validation." } };
    return { ok: true, url: safe };
  }

  async function fetchText(value, source, { policy = null, allowNotFound = false, accept = "text/plain,application/xml,text/xml,text/html" } = {}) {
    let current = value;
    for (let hop = 0; hop <= 2; hop++) {
      const checked = await validate(current, source);
      if (!checked.ok) return checked;
      if (policy && !robotsAllows(policy, checked.url.href)) return { ok: false, failure: { status: "robots-disallowed", message: "Publisher robots.txt disallows this URL." } };
      await waitForHost(checked.url.hostname);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(checked.url.href, {
          redirect: "manual",
          headers: { Accept: accept, "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
      } catch (error) {
        return { ok: false, failure: { status: error.name === "AbortError" ? "timeout" : "network-error", message: `Publisher request failed: ${error.message}` } };
      } finally {
        clearTimeout(timer);
      }
      const status = Number(response?.status || 0);
      if (status === 403 || status === 429) return { ok: false, blocked: true, failure: { status, message: `Publisher returned HTTP ${status}; discovery stopped.` } };
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (hop >= 2) return { ok: false, failure: { status: "too-many-redirects", message: "Publisher resource exceeded the redirect limit." } };
        const location = response?.headers?.get?.("location");
        if (!location) return { ok: false, failure: { status: "redirect-without-location", message: "Publisher redirect has no Location header." } };
        try { current = new URL(location, checked.url).href; } catch {
          return { ok: false, failure: { status: "unsafe-redirect", message: "Publisher redirect URL is invalid." } };
        }
        continue;
      }
      if (allowNotFound && status === 404) return { ok: true, status, text: "", url: checked.url.href };
      if (!response?.ok) return { ok: false, failure: { status: status || "http-error", message: `Publisher request failed: HTTP ${status}.` } };
      try {
        const text = await readCappedBody(response, maxBodyBytes);
        return { ok: true, status, text, url: checked.url.href };
      } catch (error) {
        return { ok: false, failure: { status: error.code || "body-error", message: error.message } };
      }
    }
    return { ok: false, failure: { status: "failed", message: "Publisher request failed." } };
  }

  async function refreshSource(source) {
    const robotsUrl = new URL("/robots.txt", source.origin).href;
    const robots = await fetchText(robotsUrl, source, { allowNotFound: true });
    if (!robots.ok) return robots;
    const policy = parseRobotsTxt(robots.text);
    hostDelays.set(source.hostname, Math.max(hostDelayMs, policy.crawlDelayMs));
    const sitemapUrls = source.sitemapUrls.length ? source.sitemapUrls : policy.sitemaps;
    if (!sitemapUrls.length) return { ok: false, failure: { status: "no-sitemap", message: "Publisher robots.txt did not list a sitemap." } };
    const queue = sitemapUrls.slice(0, maxSitemaps).map((url) => ({ url, depth: 0 }));
    const visitedSitemaps = new Set();
    const entries = [];
    const seen = new Set();
    while (queue.length && visitedSitemaps.size < maxSitemaps && entries.length < maxUrlsPerSource) {
      const next = queue.shift();
      const safe = allowedUrl(next.url, source.allowedHosts);
      if (!safe) continue;
      if (visitedSitemaps.has(safe.href)) continue;
      if (!robotsAllows(policy, safe.href)) return { ok: false, failure: { status: "robots-disallowed", message: "Publisher robots.txt disallows its sitemap URL." } };
      visitedSitemaps.add(safe.href);
      const fetched = await fetchText(safe.href, source, { policy });
      if (!fetched.ok) return fetched;
      const parsed = parseSitemapXml(fetched.text, { baseUrl: fetched.url, maxEntries: maxUrlsPerSource });
      if (!parsed.ok) return parsed;
      if (parsed.kind === "sitemapindex") {
        if (next.depth >= maxSitemapDepth) continue;
        for (const entry of parsed.entries) {
          if (queue.length + visitedSitemaps.size >= maxSitemaps) break;
          queue.push({ url: entry.url, depth: next.depth + 1 });
        }
        continue;
      }
      for (const entry of parsed.entries) {
        if (entries.length >= maxUrlsPerSource) break;
        const url = allowedUrl(entry.url, source.allowedHosts);
        if (!url || !robotsAllows(policy, url.href) || seen.has(url.href)) continue;
        seen.add(url.href);
        entries.push({ url: url.href, lastmod: entry.lastmod, sourceId: source.id, sourceHost: source.hostname });
      }
    }
    const snapshot = { entries, policy, expiresAt: now() + indexTtlMs };
    indexCache.set(source.id, snapshot);
    return { ok: true, snapshot };
  }

  async function getIndex(source) {
    const cached = indexCache.get(source.id);
    if (cached && cached.expiresAt > now()) return { ok: true, snapshot: cached, cached: true };
    indexCache.delete(source.id);
    const refreshed = await refreshSource(source);
    return refreshed.ok ? { ...refreshed, cached: false } : refreshed;
  }

  async function findRecipes(input = {}) {
    const requested = Math.min(7, Math.max(1, Math.floor(Number(input.dinners) || 1)));
    const maxTimeMin = Number(input.maxTimeMin) > 0 ? Number(input.maxTimeMin) : 30;
    const equipment = Array.isArray(input.equipment) ? input.equipment.map(String) : [];
    const dietRules = Array.isArray(input.dietRules) ? input.dietRules : [];
    const exclude = new Set((Array.isArray(input.exclude) ? input.exclude : []).map(normalizeWords).filter(Boolean));
    const includeRecipe = normalizeWords(input.includeRecipe || "");
    const target = Math.min(maxCandidates, Math.max(requested, requested * 3));
    const failures = [];
    const rejected = { time: 0, equipment: 0, diet: 0, excluded: 0, robots: 0, unsafe: 0 };
    const found = [];
    const seenCandidates = new Set();
    const metrics = { cachedIndexes: 0, refreshedIndexes: 0, sitemapUrls: 0, pageVerifications: 0, verifiedCandidates: 0 };
    let stopped = false;
    let lastFailure = null;
    if (typeof verifyUrl !== "function") return { ok: false, failure: { status: "unavailable", message: "A live recipe verifier is required for sitemap discovery." }, metrics };
    for (const source of sources) {
      if (stopped || found.length >= target) break;
      const indexed = await getIndex(source);
      if (!indexed.ok) {
        lastFailure = indexed.failure;
        failures.push({ source: source.id, ...indexed.failure });
        if (indexed.blocked) stopped = true;
        if (indexed.failure?.status === "robots-disallowed") rejected.robots++;
        continue;
      }
      metrics[indexed.cached ? "cachedIndexes" : "refreshedIndexes"]++;
      const ranked = rankEntries(indexed.snapshot.entries, input);
      metrics.sitemapUrls += ranked.length;
      const queue = selectPageEntries(ranked, input, maxPageChecks - metrics.pageVerifications);
      for (const entry of queue) {
        if (stopped || found.length >= maxCandidates || metrics.pageVerifications >= maxPageChecks) break;
        if (exclude.has(normalizeWords(entry.url))) { rejected.excluded++; continue; }
        const pageUrl = allowedUrl(entry.url, source.allowedHosts);
        if (!pageUrl) { rejected.unsafe++; continue; }
        if (!robotsAllows(indexed.snapshot.policy, pageUrl.href)) { rejected.robots++; continue; }
        metrics.pageVerifications++;
        let checked;
        try {
          checked = await verifyUrl(pageUrl.href, {
            fresh: true,
            allowedHosts: [...source.allowedHosts],
            beforeFetch: async (fetchUrl) => {
              // The verifier resolves DNS before this hook. Pace here, beside
              // the actual fetch, so a slow DNS lookup cannot eat the delay.
              const safeFetchUrl = allowedUrl(fetchUrl, source.allowedHosts);
              if (!safeFetchUrl || !robotsAllows(indexed.snapshot.policy, safeFetchUrl.href)) {
                throw Object.assign(new Error("Publisher robots.txt disallows the recipe redirect."), { code: "robots-disallowed" });
              }
              await waitForHost(safeFetchUrl.hostname);
            },
          });
        } catch (error) {
          checked = { ok: false, failure: { status: error.code || "verify-error", message: error.message } };
        }
        if (!checked?.ok) {
          lastFailure = checked?.failure || { status: "verify-error", message: "Recipe page verification failed." };
          failures.push({ source: source.id, url: pageUrl.href.slice(0, 400), ...lastFailure });
          if (Number(lastFailure.status) === 403 || Number(lastFailure.status) === 429 || lastFailure.status === 403 || lastFailure.status === 429) stopped = true;
          continue;
        }
        const candidate = checked.recipe;
        const finalUrl = String(candidate?.finalUrl || candidate?.sourceUrl || "");
        const finalParsed = allowedUrl(finalUrl, source.allowedHosts);
        if (!finalParsed || !Number.isFinite(Number(candidate.timeMin)) || !candidate.title) { rejected.unsafe++; continue; }
        const titleKey = normalizeWords(candidate.title);
        if (!candidate.timeMin || candidate.timeMin > maxTimeMin) { rejected.time++; continue; }
        if (!candidate.equipment?.length || !recipeFitsEquipment(candidate, equipment)) { rejected.equipment++; continue; }
        if (exclude.has(titleKey) || exclude.has(normalizeWords(finalUrl))) { rejected.excluded++; continue; }
        if (recipeViolatesDiet(candidate, dietRules)) { rejected.diet++; continue; }
        const key = normalizeWords(finalUrl || candidate.title);
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        found.push(candidate);
      }
    }
    metrics.verifiedCandidates = found.length;
    if (includeRecipe && !found.some((candidate) => normalizeWords(candidate.title) === includeRecipe)) {
      lastFailure = { status: "no-safe-recipes", message: `Requested recipe "${String(input.includeRecipe).slice(0, 120)}" was not found among verified sitemap candidates.` };
    }
    if (found.length >= requested && (!includeRecipe || found.some((candidate) => normalizeWords(candidate.title) === includeRecipe))) {
      return { ok: true, candidates: found.slice(0, maxCandidates), metrics, sourceFailures: failures.slice(0, 20), rejected };
    }
    const details = {
      status: lastFailure?.status || "no-safe-recipes",
      message: lastFailure?.message || "Sitemap discovery found no safe recipes matching this request.",
      verified: found.length,
      attemptedUrls: metrics.pageVerifications,
      sourceFailures: failures.slice(0, 20),
      sourceFailureCount: failures.length,
      rejected,
    };
    try { reportFailure("sitemap-recipes", "find", details); } catch { /* failure reporting must not break discovery */ }
    return { ok: false, failure: details, candidates: found, metrics };
  }

  return { findRecipes, parseSitemapXml, parseRobotsTxt, caches: { index: indexCache }, metrics: { lastRequestAt, hostDelays } };
}

module.exports = { createSitemapRecipeDiscovery, parseSitemapXml, parseRobotsTxt, robotsAllows };
