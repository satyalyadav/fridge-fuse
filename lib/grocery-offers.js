"use strict";

// Advertised grocery offers are the only price source in the app. Search
// results are hints a student can open and inspect; plan grounding and dietary
// decisions never read them.

const DEFAULT_AREA = "Tempe, AZ 85281";
const MAX_OFFER_ITEMS = 5;
const MAX_ITEM_NAME_LENGTH = 80;
const MAX_AREA_LENGTH = 120;
const MAX_CACHE_ENTRIES = 200;
const OFFER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 12000;

// One adapter per chain: Walmart reads its public search page directly and
// Fry's uses the official Kroger API. ALDI joins when the route enables it.
const SEARCH_CHAINS = [
  { key: "walmart", label: "Walmart", adapter: "walmart-direct" },
  { key: "frys", label: "Fry's / Kroger", adapter: "kroger-api" },
];
const ALDI_CHAIN = { key: "aldi", label: "ALDI", adapter: "aldi-page" };
const MAX_API_SOURCES = 3;
// Priced sources kept per item. The cheapest per chain always survives.
const MAX_ITEM_SOURCES = 4;

// Kroger's public Products and Locations APIs are free for registered apps
// (10,000 product calls and 1,600 location calls per day). Client-credentials
// tokens last 30 minutes; prices are exact for the store in filter.locationId.
const KROGER_TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token";
const KROGER_API_BASE = "https://api.kroger.com/v1";
const KROGER_SCOPE = "product.compact";
const MAX_KROGER_SOURCES = 3;

// ALDI's storefront GraphQL is the same operation its web app calls: names,
// sizes, and prices come back as JSON. The persisted-query hashes and guest
// session are the app's public values.
const ALDI_SEARCH_URL = "https://www.aldi.us/store/aldi/s?k=aldi";
const ALDI_GRAPHQL_URL = "https://www.aldi.us/graphql";
const ALDI_SEARCH_HASH = "406e5b9dfc9dc9b209b2c72012622de595fb4040d17f68efa4d4e104657273ee";
const ALDI_ITEMS_HASH = "388f200246a7fcc0f10ed9c1bb97952f9046e69c1be3b14ebae5855822cec831";
const ALDI_BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function boundedText(value, max) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function normalizeName(value) {
  return boundedText(value, MAX_ITEM_NAME_LENGTH).replace(/\s+/g, " ").toLowerCase();
}

function normalizeArea(value) {
  return boundedText(value, MAX_AREA_LENGTH).replace(/\s+/g, " ");
}

function safeHttpUrl(value) {
  const candidate = boundedText(value, 2000);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, message: "Request body must be an object." };
  }
  if (!Array.isArray(body.items)) {
    return { ok: false, status: 400, message: "items must be an array of grocery names." };
  }
  if (body.items.length === 0) {
    return { ok: false, status: 400, message: "Choose at least one grocery item to search." };
  }
  const names = [];
  const seen = new Set();
  for (const raw of body.items) {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.name : raw;
    if (typeof value !== "string") {
      return { ok: false, status: 400, message: "Each item must be a grocery name string." };
    }
    const rawName = value.trim();
    if (/[\u0000-\u001f\u007f]/.test(rawName)) {
      return { ok: false, status: 400, message: "Items and search areas cannot contain control characters." };
    }
    const unboundedName = rawName.replace(/\s+/g, " ");
    if (unboundedName.length > MAX_ITEM_NAME_LENGTH) {
      return { ok: false, status: 400, message: `Grocery item names must be ${MAX_ITEM_NAME_LENGTH} characters or fewer.` };
    }
    const name = normalizeName(unboundedName);
    if (!name) return { ok: false, status: 400, message: "Each grocery item needs a name." };
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length > MAX_OFFER_ITEMS) {
    return {
      ok: false,
      status: 400,
      message: `Search up to ${MAX_OFFER_ITEMS} items at a time. Select another batch for the rest of your list.`,
    };
  }
  if (body.area !== undefined && typeof body.area !== "string") {
    return { ok: false, status: 400, message: "area must be a city or ZIP text value." };
  }
  if (body.area !== undefined && !body.area.trim()) {
    return { ok: false, status: 400, message: "Enter a city or ZIP search area." };
  }
  const rawArea = body.area === undefined ? DEFAULT_AREA : body.area;
  const rawAreaTrimmed = rawArea.trim();
  if (/[\u0000-\u001f\u007f]/.test(rawAreaTrimmed)) {
    return { ok: false, status: 400, message: "Items and search areas cannot contain control characters." };
  }
  const unboundedArea = rawAreaTrimmed.replace(/\s+/g, " ");
  if (unboundedArea.length > MAX_AREA_LENGTH) {
    return { ok: false, status: 400, message: `Search areas must be ${MAX_AREA_LENGTH} characters or fewer.` };
  }
  const area = normalizeArea(unboundedArea);
  if (!area) return { ok: false, status: 400, message: "Enter a city or ZIP search area." };
  return { ok: true, items: names, area };
}

function cacheKey(item, area) {
  return `${normalizeName(item)}\u0000${normalizeArea(area).toLowerCase()}`;
}


function normalizeLocalityText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseSearchArea(area) {
  const raw = String(area || "").trim();
  const zipMatch = raw.match(/\b(\d{5})(?:-\d{4})?\b/);
  const zip = zipMatch ? zipMatch[1] : "";
  const stateMatch = raw.match(/(?:^|[,\s])([a-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/i);
  const state = stateMatch ? stateMatch[1].toLowerCase() : "";
  let city = raw.replace(/\b\d{5}(?:-\d{4})?\b/g, " ").trim();
  if (city.includes(",")) city = city.split(",")[0];
  else if (state) city = city.replace(new RegExp(`(?:^|\\s)${state}\\s*$`, "i"), "");
  return { city: normalizeLocalityText(city), state, zip };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Store navigation text and review prose can sit next to a price. A real
// product line is a short noun phrase, not a sentence.
function looksLikeProductName(value) {
  if (value.length < 3 || value.length > 90) return false;
  if (/[?!]/.test(value)) return false;
  if (/\b(?:i|we|you|my|our|they|could|would|wanted|ordered)\b/i.test(value)) return false;
  return true;
}

// Store navigation text glues words together ("EggsBeveragesBreakfast"),
// so substring matching lets a category label pass as a product name. Require
// the product evidence to name something from the requested item, matched as a
// whole word, tolerating a plural on either side ("bananas" vs "Banana").
function productMatchesRequestedItem(itemName, productEvidence) {
  if (!looksLikeProductName(productEvidence)) return false;
  const words = normalizeName(itemName).split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  if (!words.length) return false;
  const haystack = productEvidence.toLocaleLowerCase();
  return words.some((word) => {
    const stem = word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word;
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(stem)}(?:s|es)?(?:$|[^a-z0-9])`, "i").test(haystack);
  });
}

function walmartUnitLabel(value) {
  if (typeof value === "string") return boundedText(value, 40);
  const unit = typeof value?.unit === "string" ? value.unit : "";
  if (unit === "each_weight") return "sold by weight";
  if (unit && unit !== "each") return boundedText(unit.replace(/_/g, " "), 40);
  return "";
}

// Priced rows first, cheapest first; unpriced links keep their order at the end.
function sortPricedSources(sources) {
  return [...(Array.isArray(sources) ? sources : [])].sort((a, b) => {
    const aPriced = Number.isFinite(a?.price) ? 0 : 1;
    const bPriced = Number.isFinite(b?.price) ? 0 : 1;
    if (aPriced !== bPriced) return aPriced - bPriced;
    return aPriced === 0 ? a.price - b.price : 0;
  });
}

function limitItemSources(sources) {
  // A basic search can return ten results, and the same product often appears
  // on several URLs. Keep one entry per product, lowest price first.
  const sorted = sortPricedSources(sources);
  const seenProducts = new Set();
  const unique = [];
  for (const source of sorted) {
    const key = Number.isFinite(source.price) ? normalizeName(source.product || "") : "";
    if (key) {
      if (seenProducts.has(key)) continue;
      seenProducts.add(key);
    }
    unique.push(source);
  }
  const priced = unique.filter((source) => Number.isFinite(source.price));
  const unpriced = unique.filter((source) => !Number.isFinite(source.price));
  // Keep the cheapest offer per chain before filling the remaining slots. Four
  // cheap Walmart prices must not push Fry's out of the store ballpark.
  const cheapestPerChain = new Map();
  for (const source of priced) {
    const chain = source.chain || "";
    if (!cheapestPerChain.has(chain)) cheapestPerChain.set(chain, source);
  }
  const kept = [...cheapestPerChain.values()];
  for (const source of priced) {
    if (kept.length >= MAX_ITEM_SOURCES) break;
    if (!kept.includes(source)) kept.push(source);
  }
  return [...kept.slice(0, MAX_ITEM_SOURCES), ...unpriced.slice(0, 3)];
}

// A per-store ballpark for the whole list: the cheapest advertised price when
// a search found one, otherwise the catalog's development estimate. Every line
// records which of the two it is, and a store only earns the cheapest label
// when every requested item has a line.
// The storefront page carries the guest session's shop and zone ids, which the
// GraphQL calls need to return store-localized prices.
function aldiShopContextFromHtml(html) {
  const source = String(html || "");
  const zoneId = source.match(/zoneId%22%3A%22([A-Za-z0-9-]+)%22/)?.[1]
    || source.match(/"zoneId":"?([A-Za-z0-9-]+)"?/)?.[1]
    || "";
  const shopId = source.match(/shopId%5C%22%3A%5C%22(\d+)%5C%22/)?.[1]
    || source.match(/shopId%22%3A%22(\d+)%22/)?.[1]
    || source.match(/"shopId":"?(\d+)"?/)?.[1]
    || "";
  return shopId && zoneId ? { shopId, zoneId } : null;
}

function aldiItemSource(item) {
  const name = boundedText(item?.name || "", 200);
  const size = boundedText(item?.size || "", 40);
  const card = item?.price?.viewSection?.itemCard || {};
  const details = item?.price?.viewSection?.itemDetails || {};
  const priceString = String(card.priceString || item?.price?.priceString || "");
  const unitString = String(card.pricingUnitString || details.pricingUnitString || "");
  let price = Number(item?.price?.priceValueString);
  if (!Number.isFinite(price)) {
    const parsed = priceString.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/);
    if (parsed) price = Number(parsed[1]);
  }
  if (!name || !Number.isFinite(price) || price <= 0 || price > 10000) return null;
  if (item?.availability?.available === false) return null;
  let priceText = `$${price.toFixed(2)}`;
  let qualifier = size;
  // Weight-priced produce reports an estimated per-item price plus the real
  // per-pound price ("$0.15 each (est.)" with "$0.46 / lb"). The per-pound
  // price is the one the shelf shows, so prefer it.
  const unitMatch = unitString.match(/\$\s?(\d{1,4}(?:\.\d{2})?)\s*\/\s*(lb|oz)\b/i);
  const estimated = /est/i.test(priceString) || /^per\s+(lb|oz)\b/i.test(size);
  if (estimated && unitMatch) {
    price = Number(unitMatch[1]);
    priceText = `$${price.toFixed(2)}/${unitMatch[2].toLowerCase()}`;
    qualifier = `per ${unitMatch[2].toLowerCase()}`;
  }
  if (!Number.isFinite(price) || price <= 0 || price > 10000) return null;
  const slug = boundedText(item?.evergreenUrl || "", 160);
  return {
    title: name,
    content: `${name} ${size ? `${size} ` : ""}${priceText}`,
    url: slug ? `https://www.aldi.us/store/aldi/products/${slug}` : ALDI_SEARCH_URL,
    retailer: "ALDI",
    chain: "aldi",
    scope: "store-api",
    price,
    priceText,
    product: name,
    qualifier,
    evidence: `${name} · ${size ? `${size} · ` : ""}${priceText}`,
  };
}

// A per-store ballpark for the whole list, built only from prices the adapters
// returned. A store is always listed, even with zero priced items, so the user
// can see it was checked, and no invented price enters the total.
function buildStoreEstimates(requested, items, chains = []) {
  const byName = new Map(items.map((item) => [item.name, item]));
  const estimates = chains.map((chain) => {
    const lines = [];
    const missing = [];
    for (const name of requested) {
      const best = (byName.get(name)?.sources || [])
        .filter((source) => source.chain === chain.key && Number.isFinite(source.price))
        .sort((a, b) => a.price - b.price)[0];
      if (best) {
        lines.push({
          item: name,
          price: best.price,
          product: best.product || "",
          origin: best.scope === "store-api" ? "store-api" : "advertised",
          scope: best.scope,
          url: best.url,
        });
      } else {
        missing.push(name);
      }
    }
    return {
      chain: chain.key,
      label: chain.label,
      total: +lines.reduce((sum, line) => sum + line.price, 0).toFixed(2),
      advertisedCount: lines.length,
      itemCount: lines.length,
      requestedCount: requested.length,
      missing,
      complete: requested.length > 0 && missing.length === 0,
      lines,
    };
  });
  estimates.sort((a, b) =>
    Number(b.complete) - Number(a.complete) ||
    b.itemCount - a.itemCount ||
    a.total - b.total ||
    a.label.localeCompare(b.label)
  );
  // A store can still lead when one list item has no price anywhere; the UI
  // says how many items the total covers instead of hiding the ranking.
  if (estimates.length && estimates[0].itemCount > 0) estimates[0].cheapest = true;
  return estimates;
}

function finalItem(name, sources, checkedAt, cached = false) {
  return {
    name,
    status: sources.some((source) => Number.isFinite(source.price)) ? "offers" : "no-local-price",
    sources: limitItemSources(sources),
    checkedAt,
    cached,
  };
}

// Retailer list pages render product and price in one line ("Overall pick
// Great Value Eggs, 12 Count $1.64 Was $1.67"). The model finds these most of
// the time, but a deterministic scan catches the ones it misses. Everything
// extracted here still goes through the same verbatim checks as model output.
const LINE_OFFER_PATTERN = /([A-Z0-9][^$]{2,140}?)\s+(\$\s?\d{1,4}(?:,\d{3})?(?:\.\d{2})?)(?=\s|$)/;

function createGroceryOffersService({ reportFailure = () => ({}), } = {}) {
  const cache = new Map();
  const itemInFlight = new Map();
  const requestInFlight = new Map();
  let krogerToken = null;
  let krogerTokenInFlight = null;
  const krogerLocations = new Map();
  const krogerLocationInFlight = new Map();
  let aldiSessionCache = null;
  let aldiSessionInFlight = null;

  function failure(operation, details) {
    return reportFailure("offers", operation, details);
  }

  function nowFor(context) {
    const value = Number(context.now?.());
    return Number.isFinite(value) ? value : Date.now();
  }

  function trimCache() {
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }

  function getCached(key, now) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      cache.delete(key);
      return null;
    }
    return clone(hit.value);
  }

  function setCached(key, value, now) {
    cache.delete(key);
    cache.set(key, { expiresAt: now + OFFER_CACHE_TTL_MS, value: clone(value) });
    trimCache();
  }

  function itemCacheKey(item, area) {
    return cacheKey(item, area);
  }

  function fetchSearch(item, area, context, chain) {
    if (chain.adapter === "kroger-api") return fetchKrogerSearch(item, area, context);
    if (chain.adapter === "walmart-direct") return fetchWalmartDirect(item, area, context);
    if (chain.adapter === "aldi-page") return fetchAldiSearch(item, area, context);
    return { ok: false, kind: "error", failure: failure("adapter", { status: "missing-adapter", message: `${chain.label} has no live price source in this build.` }) };
  }

  function krogerConfigured(context) {
    return Boolean(context.kroger?.clientId && context.kroger?.clientSecret);
  }

  // Both Walmart adapters return the same result shape (title, url, price,
  // seller, out_of_stock, price_per_unit), so they share this mapping.
  function walmartSourcesFromResults(results, item) {
    const mapped = (Array.isArray(results) ? results : []).map((result) => {
      const name = boundedText(result?.title || "", 200);
      const price = Number(result?.price);
      const href = safeHttpUrl(result?.url);
      if (!name || !href || !Number.isFinite(price) || price <= 0 || price > 10000) return null;
      if (result?.out_of_stock === true) return null;
      if (!productMatchesRequestedItem(item, name)) return null;
      const unit = walmartUnitLabel(result?.price_per_unit ?? result?.price_unit ?? result?.unit);
      const priceText = `$${price.toFixed(2)}`;
      return {
        firstParty: /walmart\.com/i.test(String(result?.seller || "")),
        source: {
          title: name,
          content: `${name} ${unit ? `${unit} ` : ""}${priceText}`,
          url: href,
          retailer: "Walmart",
          chain: "walmart",
          scope: "retailer-advertised",
          price,
          priceText,
          product: name,
          qualifier: unit,
          evidence: `${name} · ${priceText}`,
        },
      };
    }).filter(Boolean);
    // Prefer items sold by Walmart itself; marketplace bulk listings otherwise
    // dominate the cheap end with food-service packs.
    const firstParty = mapped.filter((entry) => entry.firstParty);
    return (firstParty.length ? firstParty : mapped)
      .map((entry) => entry.source)
      .sort((a, b) => a.price - b.price)
      .slice(0, MAX_API_SOURCES);
  }

  // The direct page read is the only Walmart adapter: it returns Walmart's own
  // advertised web prices with no key and no credits. A failure is reported so
  // the compare can say why Walmart is missing instead of dropping it quietly.
  async function fetchWalmartDirect(item, area, context) {
    if (typeof context.walmartDirect !== "function") {
      return { ok: false, kind: "error", failure: failure("walmart-direct", { status: "unavailable", message: "The direct Walmart search is unavailable in this deployment.", item }) };
    }
    let results = [];
    try {
      const zip = parseSearchArea(area).zip;
      results = await context.walmartDirect(normalizeName(item), zip);
    } catch (error) {
      const details = { status: "unavailable", message: boundedText(error?.message || "", 200) || "The direct Walmart search failed.", item };
      failure("walmart-direct", details);
      return { ok: false, kind: "error", failure: details };
    }
    return { ok: true, sources: walmartSourcesFromResults(results, item), checkedAt: new Date(nowFor(context)).toISOString() };
  }

  async function krogerRequest(path, context) {
    const token = await krogerAccessToken(context);
    if (!token) return { ok: false, kind: "auth" };
    // Kroger answers 503 when it throttles an origin. One short retry turns a
    // transient throttle into a priced item instead of an empty Fry's column.
    const attempt = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        const response = await context.fetchImpl(`${KROGER_API_BASE}${path}`, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        if (!response?.ok) return { ok: false, kind: "upstream", status: response?.status };
        const data = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
        return { ok: true, data };
      } catch {
        return { ok: false, kind: "network" };
      } finally {
        clearTimeout(timer);
      }
    };
    let result = await attempt();
    if (!result.ok && (result.kind === "network" || (Number(result.status) >= 500 && Number(result.status) <= 599))) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      result = await attempt();
    }
    return result;
  }

  async function krogerAccessToken(context) {
    if (!krogerConfigured(context)) return "";
    const now = nowFor(context);
    if (krogerToken && krogerToken.expiresAt > now + 30 * 1000) return krogerToken.value;
    if (krogerTokenInFlight) return krogerTokenInFlight;
    krogerTokenInFlight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        const basic = Buffer.from(`${context.kroger.clientId}:${context.kroger.clientSecret}`).toString("base64");
        const response = await context.fetchImpl(KROGER_TOKEN_URL, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
          body: new URLSearchParams({ grant_type: "client_credentials", scope: KROGER_SCOPE }).toString(),
        });
        if (!response?.ok) {
          failure("kroger-auth", { status: response?.status || "auth-failed", message: "Kroger sign-in failed; Fry's prices are unavailable." });
          return "";
        }
        const data = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
        if (!data?.access_token) return "";
        krogerToken = { value: data.access_token, expiresAt: now + (Number(data.expires_in) || 1800) * 1000 };
        return krogerToken.value;
      } catch {
        return "";
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await krogerTokenInFlight;
    } finally {
      krogerTokenInFlight = null;
    }
  }

  async function krogerLocation(area, context) {
    const zip = parseSearchArea(area).zip;
    if (!zip) return null;
    if (krogerLocations.has(zip)) return krogerLocations.get(zip);
    if (krogerLocationInFlight.has(zip)) return krogerLocationInFlight.get(zip);
    const pending = (async () => {
      const result = await krogerRequest(`/locations?filter.zipCode.near=${encodeURIComponent(zip)}&filter.radiusInMiles=20&filter.limit=20`, context);
      if (!result.ok) return null;
      const location = (result.data?.data || []).find((entry) => /fry/i.test(entry.chain || ""));
      if (location) krogerLocations.set(zip, location);
      return location || null;
    })();
    krogerLocationInFlight.set(zip, pending);
    try {
      return await pending;
    } finally {
      krogerLocationInFlight.delete(zip);
    }
  }

  async function fetchKrogerSearch(item, area, context) {
    if (!krogerConfigured(context)) {
      return { ok: false, kind: "error", failure: failure("kroger-config", { status: "not-configured", message: "Fry's prices need the free Kroger API credentials." }) };
    }
    const location = await krogerLocation(area, context);
    if (!location) {
      return { ok: false, kind: "upstream", failure: failure("kroger-location", { status: "no-location", message: "No Fry's location was found for this search area." }) };
    }
    const result = await krogerRequest(`/products?filter.term=${encodeURIComponent(item)}&filter.locationId=${encodeURIComponent(location.locationId)}&filter.limit=10`, context);
    if (!result.ok) {
      return { ok: false, kind: result.kind === "auth" ? "error" : "upstream", failure: failure("kroger-products", { status: result.status || "kroger-error", message: `Kroger product search failed${result.status ? ` (HTTP ${result.status})` : ""}.` }) };
    }
    const sources = (result.data?.data || []).map((product) => {
      const firstItem = Array.isArray(product.items) ? product.items[0] : null;
      const price = Number(firstItem?.price?.promo ?? firstItem?.price?.regular);
      const name = boundedText(product.description || "", 200);
      if (!name || !Number.isFinite(price) || price <= 0 || price > 10000) return null;
      if (!productMatchesRequestedItem(item, name)) return null;
      const size = boundedText(firstItem?.size || "", 40);
      const priceText = `$${price.toFixed(2)}`;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      return {
        title: name,
        content: `${name} ${size ? `${size} ` : ""}${priceText}`,
        url: `https://www.frysfood.com/p/${slug}/${encodeURIComponent(product.productId || product.upc || "")}`,
        retailer: "Fry's / Kroger",
        chain: "frys",
        scope: "store-api",
        price,
        priceText,
        product: name,
        qualifier: size,
        evidence: `${name} · ${size ? `${size} · ` : ""}${priceText}`,
      };
    }).filter(Boolean).sort((a, b) => a.price - b.price).slice(0, MAX_KROGER_SOURCES);
    return { ok: true, sources, checkedAt: new Date(nowFor(context)).toISOString() };
  }

  async function aldiEnsureSession(context) {
    const now = nowFor(context);
    if (aldiSessionCache && now - aldiSessionCache.fetchedAt < 30 * 60 * 1000) return aldiSessionCache;
    if (aldiSessionInFlight) return aldiSessionInFlight;
    aldiSessionInFlight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        const response = await context.fetchImpl(ALDI_SEARCH_URL, {
          signal: controller.signal,
          headers: { "User-Agent": ALDI_BROWSER_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
        });
        if (!response?.ok || typeof response.text !== "function") return null;
        const html = await response.text();
        const shopContext = aldiShopContextFromHtml(html);
        if (!shopContext) return null;
        const cookies = new Map();
        for (const cookie of (response.headers?.getSetCookie ? response.headers.getSetCookie() : [])) {
          const pair = String(cookie).split(";")[0];
          const index = pair.indexOf("=");
          if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
        }
        aldiSessionCache = { ...shopContext, cookies, fetchedAt: now };
        return aldiSessionCache;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await aldiSessionInFlight;
    } finally {
      aldiSessionInFlight = null;
    }
  }

  async function aldiGraphql(operationName, variables, hash, context) {
    const session = await aldiEnsureSession(context);
    if (!session) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const cookieHeader = [...session.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      const response = await context.fetchImpl(ALDI_GRAPHQL_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": ALDI_BROWSER_UA,
          Origin: "https://www.aldi.us",
          Referer: "https://www.aldi.us/",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify({ operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      });
      if (response?.status === 401 || response?.status === 403) {
        // The guest session expired; the next call rebuilds it.
        aldiSessionCache = null;
        return null;
      }
      if (!response?.ok) return null;
      const data = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
      return data?.data || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchAldiGraphql(item, area, context) {
    const session = await aldiEnsureSession(context);
    if (!session) return null;
    const postalCode = parseSearchArea(area).zip || "";
    const search = await aldiGraphql("SearchResultsPlacements", {
      action: null,
      query: item,
      pageViewId: "00000000-0000-4000-8000-000000000000",
      elevatedProductId: null,
      searchSource: "search",
      filters: [],
      disableReformulation: false,
      disableLlm: false,
      forceInspiration: false,
      orderBy: "bestMatch",
      clusterId: null,
      includeDebugInfo: false,
      clusteringStrategy: null,
      contentManagementSearchParams: { itemGridColumnCount: 3 },
      shopId: session.shopId,
      postalCode,
      zoneId: session.zoneId,
      first: 9,
    }, ALDI_SEARCH_HASH, context);
    const ids = [];
    for (const placement of search?.searchResultsPlacements?.placements || []) {
      for (const id of placement?.content?.itemIds || []) {
        if (typeof id === "string" && !ids.includes(id)) ids.push(id);
      }
    }
    if (!ids.length) return [];
    const items = await aldiGraphql("Items", {
      ids: ids.slice(0, 12),
      shopId: session.shopId,
      zoneId: session.zoneId,
      postalCode,
    }, ALDI_ITEMS_HASH, context);
    return (items?.items || [])
      .map(aldiItemSource)
      .filter(Boolean)
      .filter((source) => productMatchesRequestedItem(item, source.product))
      .sort((a, b) => a.price - b.price)
      .slice(0, MAX_API_SOURCES);
  }

  async function fetchAldiSearch(item, area, context) {
    const sources = await fetchAldiGraphql(item, area, context);
    if (sources === null) {
      const details = { status: "unavailable", message: "ALDI's storefront search is unavailable right now.", item };
      failure("aldi", details);
      return { ok: false, kind: "error", failure: details };
    }
    return { ok: true, sources, checkedAt: new Date(nowFor(context)).toISOString() };
  }

  function searchItem(item, area, context, chain) {
    const key = `${itemCacheKey(item, area)}\u0003${chain.key}`;
    const cached = getCached(key, nowFor(context));
    if (cached) return Promise.resolve({ ok: true, kind: "cached", value: cached });
    if (itemInFlight.has(key)) {
      return itemInFlight.get(key).then((result) => result.ok
        ? { ok: true, kind: "fresh", value: clone(result.value) }
        : result);
    }
    const pending = Promise.resolve()
      .then(() => fetchSearch(item, area, context, chain))
      .catch(() => ({ ok: false, kind: "error", failure: failure("adapter", { status: "network-error", message: `${chain.label} could not be reached.` }) }))
      .then((result) => {
        if (!result.ok) return result;
        const value = { name: item, chain: chain.key, sources: result.sources, checkedAt: result.checkedAt };
        return { ok: true, value };
      });
    itemInFlight.set(key, pending);
    return pending.then((result) => {
      if (!result.ok) return result;
      return { ok: true, kind: "fresh", value: clone(result.value) };
    });
  }

  async function build(normalized, context) {
    const chains = [...SEARCH_CHAINS, ...(context.aldiPages ? [ALDI_CHAIN] : [])];
    const failures = [];
    const items = [];
    const freshNames = [];
    let cacheHits = 0;
    // The assembled item is cached whole; a hit skips all of its chain
    // searches for the six-hour window.
    for (const name of normalized.items) {
      const cached = getCached(itemCacheKey(name, normalized.area), nowFor(context));
      if (cached) {
        cacheHits += 1;
        const value = clone(cached);
        value.cached = true;
        items.push(value);
      } else {
        freshNames.push(name);
      }
    }
    const searches = freshNames.flatMap((name) => chains.map((chain) => ({ name, chain })));
    const outcomes = await Promise.all(searches.map(({ name, chain }) => searchItem(name, normalized.area, context, chain)));
    const merged = new Map(freshNames.map((name) => [name, { name, sources: [], checkedAt: null, failed: false }]));
    for (let index = 0; index < searches.length; index += 1) {
      const { name, chain } = searches[index];
      const outcome = outcomes[index];
      const entry = merged.get(name);
      if (!outcome.ok) {
        entry.failed = true;
        failures.push({ item: `${name} at ${chain.label}`, message: outcome.failure?.message || "This item could not be searched." });
        itemInFlight.delete(`${itemCacheKey(name, normalized.area)}\u0003${chain.key}`);
        continue;
      }
      if (outcome.kind === "cached") cacheHits += 1;
      entry.sources.push(...outcome.value.sources);
      entry.checkedAt = entry.checkedAt || outcome.value.checkedAt;
    }
    for (const [name, entry] of merged) {
      const item = finalItem(name, entry.sources, entry.checkedAt || new Date(nowFor(context)).toISOString());
      if (!entry.sources.length) {
        item.status = entry.failed ? "error" : "no-local-price";
        item.priceText = "Price unavailable";
      }
      setCached(itemCacheKey(name, normalized.area), item, nowFor(context));
      for (const chain of chains) itemInFlight.delete(`${itemCacheKey(name, normalized.area)}\u0003${chain.key}`);
      items.push(item);
    }
    // Preserve the user's selected item order when fresh and cached results
    // finish at different times.
    const byName = new Map(items.map((item) => [item.name, item]));
    const ordered = normalized.items.map((name) => byName.get(name)).filter(Boolean);
    return {
      ok: true,
      area: normalized.area,
      requested: normalized.items,
      items: ordered,
      offers: ordered,
      storeEstimates: buildStoreEstimates(normalized.items, ordered, chains),
      checkedAt: new Date(nowFor(context)).toISOString(),
      cache: {
        hits: cacheHits,
        misses: freshNames.length,
        ttlHours: OFFER_CACHE_TTL_MS / (60 * 60 * 1000),
        indication: cacheHits ? "Some results came from this server process's six-hour cache." : "Results are cached in this server process for six hours.",
      },
      partial: failures.length > 0,
      failures,
      note: "Advertised web prices. Pickup availability and in-store prices unverified.",
    };
  }

  async function handle(req, res, options = {}) {
    const normalized = normalizeRequest(req?.body);
    if (!normalized.ok) return res.status(normalized.status).json({ ok: false, failure: { message: normalized.message } });
    const context = {
      fetchImpl: options.fetchImpl || globalThis.fetch,
      aldiPages: options.aldiPages === true,
      kroger: options.kroger || null,
      walmartDirect: typeof options.walmartDirect === "function" ? options.walmartDirect : null,
      now: typeof options.now === "function" ? options.now : Date.now,
    };
    if (typeof context.fetchImpl !== "function") {
      const reported = failure("setup", { status: "no-fetch", message: "This server cannot make retailer requests." });
      return res.status(503).json({ ok: false, failure: reported });
    }
    const requestKey = `${normalized.area.toLowerCase()}\u0000${normalized.items.slice().sort().join("\u0001")}`;
    if (requestInFlight.has(requestKey)) {
      const shared = await requestInFlight.get(requestKey);
      return res.json(clone(shared));
    }
    const pending = build(normalized, context).catch(() => {
      const checkedAt = new Date(nowFor(context)).toISOString();
      const items = normalized.items.map((name) => ({ name, status: "error", sources: [], checkedAt, cached: false }));
      return {
        ok: true,
        area: normalized.area,
        requested: normalized.items,
        items,
        offers: items,
        storeEstimates: [],
        checkedAt,
        cache: { hits: 0, misses: 0, ttlHours: OFFER_CACHE_TTL_MS / (60 * 60 * 1000), indication: "No results were cached." },
        partial: true,
        failures: [{ item: "offer search", message: "Advertised-offer search failed before results could be assembled." }],
        note: "Advertised web prices. Pickup availability and in-store prices unverified.",
      };
    });
    requestInFlight.set(requestKey, pending);
    try {
      return res.json(clone(await pending));
    } finally {
      requestInFlight.delete(requestKey);
    }
  }

  function reset() {
    cache.clear();
    itemInFlight.clear();
    requestInFlight.clear();
    krogerToken = null;
    krogerTokenInFlight = null;
    krogerLocations.clear();
    krogerLocationInFlight.clear();
    aldiSessionCache = null;
    aldiSessionInFlight = null;
  }

  return {
    handle,
    reset,
    getStats: () => ({ cacheSize: cache.size, inFlight: itemInFlight.size, requestInFlight: requestInFlight.size }),
  };
}

module.exports = {
  createGroceryOffersService,
  DEFAULT_AREA,
  MAX_OFFER_ITEMS,
  OFFER_CACHE_TTL_MS,
  SEARCH_CHAINS,
  normalizeRequest,
  productMatchesRequestedItem,
  limitItemSources,
  buildStoreEstimates,
  safeHttpUrl,
};
