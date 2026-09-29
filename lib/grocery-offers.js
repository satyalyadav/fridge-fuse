"use strict";

// Live grocery offers are the only price source in Shop. Plan grounding and
// dietary decisions never read those search results.

const DEFAULT_AREA = "Tempe, AZ 85281";
const MAX_OFFER_ITEMS = 5;
const MAX_ITEM_NAME_LENGTH = 80;
const MAX_AREA_LENGTH = 120;
const MAX_CACHE_ENTRIES = 200;
const OFFER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 12000;
const NON_PRODUCT_QUERY_WORDS = new Set([
  "x", "of", "and", "the", "a", "an", "some", "can", "cans", "tin", "tins",
  "g", "kg", "mg", "ml", "l", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "gram", "grams",
]);

// Fry's uses the official Kroger API. ALDI joins when the route enables it.
const SEARCH_CHAINS = [
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
const MAX_KROGER_ERROR_BODY_BYTES = 4096;

// ALDI's storefront GraphQL is the same operation its web app calls: names,
// sizes, and prices come back as JSON. The persisted-query hashes and guest
// session are the app's public values.
const ALDI_SEARCH_URL = "https://www.aldi.us/store/aldi/s?k=aldi";
const ALDI_GRAPHQL_URL = "https://www.aldi.us/graphql";
const ALDI_SEARCH_HASH = "406e5b9dfc9dc9b209b2c72012622de595fb4040d17f68efa4d4e104657273ee";
const ALDI_ITEMS_HASH = "388f200246a7fcc0f10ed9c1bb97952f9046e69c1be3b14ebae5855822cec831";
const ALDI_BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_RAW_CANDIDATES = 12;
const MAX_AI_MATCH_DURATION_MS = 3200;
const MAX_AI_TOTAL_DURATION_MS = 4500;
const {
  fallbackSearchQuery,
  pairKey,
  passesHardCandidateGates,
} = require("./grocery-matcher");

function boundedText(value, max) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function normalizeName(value) {
  return boundedText(value, MAX_ITEM_NAME_LENGTH).replace(/\s+/g, " ").toLowerCase();
}

function normalizeArea(value) {
  return boundedText(value, MAX_AREA_LENGTH).replace(/\s+/g, " ");
}

function retailerSearchQuery(item) {
  return normalizeName(item).replace(/\bcoriander\s+(?:leaf|leaves)\b/g, "cilantro");
}

function isCilantroHerbProduct(productEvidence) {
  const title = String(productEvidence || "").toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\b(?:rice|dressing|sauce|spice|seasoning|powder|ground|seeds?|dip|salsa|pesto|paste|soup|salad|oil|extract|flavou?red|blend|chicken|lime)\b/i.test(title)) return false;
  if (/\bcoriander\s+(?:leaf|leaves)\b/i.test(title)) return true;

  const words = title.split(/[^a-z0-9]+/).filter(Boolean);
  const cilantroIndex = words.indexOf("cilantro");
  if (cilantroIndex < 0) return false;
  const packagingWords = new Set([
    "fresh", "organic", "bunch", "bunches", "leaf", "leaves", "each", "count", "pack", "package", "produce",
    "oz", "ounce", "ounces", "g", "gram", "grams", "lb", "lbs",
  ]);
  return words.slice(cilantroIndex + 1).every((word) => packagingWords.has(word) || /^\d+(?:oz|g|lb|lbs)?$/.test(word));
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

async function readBoundedJsonError(response) {
  const declaredLength = response?.headers?.get?.("content-length");
  if (declaredLength && Number(declaredLength) > MAX_KROGER_ERROR_BODY_BYTES) {
    try { await response.body?.cancel?.(); } catch {}
    return null;
  }
  const chunks = [];
  let byteLength = 0;
  try {
    if (typeof response?.body?.getReader === "function") {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value?.byteLength || 0;
        if (byteLength > MAX_KROGER_ERROR_BODY_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }

    let text = "";
    if (typeof response?.text === "function") {
      text = await response.text();
    } else if (typeof response?.json === "function") {
      const value = await response.json();
      text = JSON.stringify(value);
    }
    if (Buffer.byteLength(text, "utf8") > MAX_KROGER_ERROR_BODY_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
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
// and matching only one word from a compound need can price the wrong food
// ("canned tomatoes" matching canned beans). Require every meaningful item
// word as a whole word, tolerating a plural on either side.
function productMatchesRequestedItem(itemName, productEvidence) {
  if (!looksLikeProductName(productEvidence)) return false;
  const words = normalizeName(itemName).normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/)
    .filter((word) => word && !NON_PRODUCT_QUERY_WORDS.has(word) && !/^\d+(?:g|kg|mg|ml|l|oz|lb|lbs)?$/.test(word));
  if (!words.length) return false;
  const haystack = productEvidence.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const wantsMicrowaveRice = words.includes("microwave") && words.includes("rice");
  const wantsTomatoPuree = words.includes("tomato") && words.includes("puree");
  // The shopping list can carry the singular typo "leave" ("baby spinach
  // leave"); treat it like "leaf" so the need still matches store titles
  // that omit or pluralize the word.
  const wantsBabySpinachLeaf = words.includes("baby") && words.includes("spinach") && words.some((word) => word === "leaf" || word === "leaves" || word === "leave");
  const wantsCorianderLeaf = words.includes("coriander") && words.some((word) => word === "leaf" || word === "leaves" || word === "leave");
  const requiredWords = words.filter((word) =>
    !(wantsMicrowaveRice && word === "microwave") &&
    !(wantsBabySpinachLeaf && (word === "leaf" || word === "leaves" || word === "leave")) &&
    !(wantsCorianderLeaf && (word === "coriander" || word === "leaf" || word === "leaves" || word === "leave"))
  );
  if (wantsMicrowaveRice) {
    const readyRice = /\bready\s+rice\b|\bready[- ]to[- ]heat\b.{0,48}\brice\b|\b(?:pre[- ]?cooked|heat\s+and\s+serve)\s+rice\b/i.test(haystack);
    const microwaveableRice = /\b(?:microwave|microwaveable|microwavable)\b.{0,24}\brice\b|\brice\b.{0,24}\b(?:microwave|microwaveable|microwavable)\b/i.test(haystack);
    if (/\b(?:dry|instant|uncooked)\b/i.test(haystack) || (!readyRice && !microwaveableRice) || /\b(?:fried|pilaf|seasoned|flavou?red|spanish|cajun|garlic)\b/i.test(haystack)) return false;
  }
  if (wantsBabySpinachLeaf && /\b(?:salad|dip|pizza|quiche|wrap|tortellini|stuffed|powder|seasoning)\b/i.test(haystack)) return false;
  if (wantsCorianderLeaf && !isCilantroHerbProduct(haystack)) return false;
  if (wantsTomatoPuree && /\bbaby\s+food\b/i.test(haystack)) return false;
  // A bare onion need is for the vegetable, not a spice product that happens
  // to contain the word (retailer searches can rank onion powder first).
  if (words.length === 1 && words[0] === "onion" && /\b(?:onion\s+(?:powder|seasoning|salt|flakes?|granulated|granules?|rings?|dip)|(?:granulated|minced|powdered|dried|dehydrated)\s+onions?|(?:green|spring)\s+onions?|scallions?)\b/i.test(haystack)) return false;
  // Singular and plural needs get the same verdict ("diced tomato" and
  // "diced tomatoes" are the same food, so a chili variant is rejected for
  // both instead of becoming the cheapest line for one spelling).
  if (words.length === 2 && words[0] === "diced" && (words[1] === "tomato" || words[1] === "tomatoes") && /\b(?:hot|habanero|chil(?:i|e)(?:es|s)?)\b/i.test(haystack)) return false;
  if (words.length === 1 && words[0] === "corn" && /\b(?:creamed|cream[\s-]+style|cream\s+corn)\b/i.test(haystack)) return false;
  return requiredWords.every((word) => {
    if (word === "gf") return /(?:^|[^a-z0-9])(?:gf|gluten[\s-]+free)(?:$|[^a-z0-9])/i.test(haystack);
    if (word === "leaf" || word === "leaves" || word === "leave") return /(?:^|[^a-z0-9])leaves?(?:$|[^a-z0-9])/i.test(haystack);
    const stem = word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word;
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(stem)}(?:s|es)?(?:$|[^a-z0-9])`, "i").test(haystack);
  });
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
  // Keep the cheapest offer per chain before filling the remaining slots.
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

  function fetchSearch(item, area, context, chain, searchQuery = item) {
    if (chain.adapter === "kroger-api") return fetchKrogerSearch(item, area, context, searchQuery);
    if (chain.adapter === "aldi-page") return fetchAldiSearch(item, area, context, searchQuery);
    return { ok: false, kind: "error", failure: failure("adapter", { status: "missing-adapter", message: `${chain.label} has no live price source in this build.` }) };
  }

  function krogerConfigured(context) {
    return Boolean(context.kroger?.clientId && context.kroger?.clientSecret);
  }

  async function krogerRequest(path, context) {
    const token = await krogerAccessToken(context);
    if (!token) return { ok: false, kind: "auth" };
    // Kroger throttles with 503 and has briefly returned PRODUCT-4109-400 for
    // valid product searches. One short retry covers those transient responses.
    const attempt = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        const response = await context.fetchImpl(`${KROGER_API_BASE}${path}`, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        if (!response?.ok) {
          const errorBody = response?.status === 400 && path.startsWith("/products?")
            ? await readBoundedJsonError(response)
            : null;
          return {
            ok: false,
            kind: "upstream",
            status: response?.status,
            errorCode: errorBody?.errors?.code,
            errorReason: errorBody?.errors?.reason,
          };
        }
        const data = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
        return { ok: true, data };
      } catch {
        return { ok: false, kind: "network" };
      } finally {
        clearTimeout(timer);
      }
    };
    let result = await attempt();
    const transientProduct400 = path.startsWith("/products?") && Number(result.status) === 400 &&
      result.errorCode === "PRODUCT-4109-400" && result.errorReason === "Invalid parameters";
    if (!result.ok && (result.kind === "network" || (Number(result.status) >= 500 && Number(result.status) <= 599) || transientProduct400)) {
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

  async function fetchKrogerSearch(item, area, context, searchQuery = item) {
    if (!krogerConfigured(context)) {
      return { ok: false, kind: "error", failure: failure("kroger-config", { status: "not-configured", message: "Fry's prices need the free Kroger API credentials." }) };
    }
    const location = await krogerLocation(area, context);
    if (!location) {
      return { ok: false, kind: "upstream", failure: failure("kroger-location", { status: "no-location", message: "No Fry's location was found for this search area." }) };
    }
    const result = await krogerRequest(`/products?filter.term=${encodeURIComponent(retailerSearchQuery(searchQuery))}&filter.locationId=${encodeURIComponent(location.locationId)}&filter.limit=10`, context);
    if (!result.ok) {
      return { ok: false, kind: result.kind === "auth" ? "error" : "upstream", failure: failure("kroger-products", { status: result.status || "kroger-error", message: `Kroger product search failed${result.status ? ` (HTTP ${result.status})` : ""}.` }) };
    }
    const sources = (result.data?.data || []).map((product) => {
      const firstItem = Array.isArray(product.items) ? product.items[0] : null;
      const price = Number(firstItem?.price?.promo ?? firstItem?.price?.regular);
      const name = boundedText(product.description || "", 200);
      if (!name || !Number.isFinite(price) || price <= 0 || price > 10000) return null;
      if (!passesHardCandidateGates(item, name)) return null;
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
    }).filter(Boolean).sort((a, b) => a.price - b.price).slice(0, MAX_RAW_CANDIDATES);
    return {
      ok: true,
      candidates: sources,
      sources: sources.filter((source) => productMatchesRequestedItem(item, source.product)).slice(0, MAX_KROGER_SOURCES),
      checkedAt: new Date(nowFor(context)).toISOString(),
    };
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
      if (Array.isArray(data?.errors) && data.errors.length) return null;
      return data?.data || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchAldiGraphql(item, area, context, searchQuery = item) {
    const session = await aldiEnsureSession(context);
    if (!session) return null;
    const postalCode = parseSearchArea(area).zip || "";
    const search = await aldiGraphql("SearchResultsPlacements", {
      action: null,
      query: retailerSearchQuery(searchQuery),
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
    const placements = search?.searchResultsPlacements?.placements;
    if (!Array.isArray(placements)) return null;
    const ids = [];
    for (const placement of placements) {
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
    if (!Array.isArray(items?.items)) return null;
    const candidates = items.items
      .map(aldiItemSource)
      .filter(Boolean)
      .filter((source) => passesHardCandidateGates(item, source.product))
      .sort((a, b) => a.price - b.price)
      .slice(0, MAX_RAW_CANDIDATES);
    return candidates;
  }

  async function fetchAldiSearch(item, area, context, searchQuery = item) {
    const candidates = await fetchAldiGraphql(item, area, context, searchQuery);
    if (candidates === null) {
      const details = { status: "unavailable", message: "ALDI's storefront search is unavailable right now.", item };
      failure("aldi", details);
      return { ok: false, kind: "error", failure: details };
    }
    return {
      ok: true,
      candidates,
      sources: candidates.filter((source) => productMatchesRequestedItem(item, source.product)).slice(0, MAX_API_SOURCES),
      checkedAt: new Date(nowFor(context)).toISOString(),
    };
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
        const value = {
          name: item,
          chain: chain.key,
          sources: result.sources || [],
          candidates: result.candidates || result.sources || [],
          checkedAt: result.checkedAt,
        };
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
    let rewriteStarted = false;
    let rewritePromise = null;
    let aiElapsedMs = 0;
    const outcomes = await Promise.all(searches.map(({ name, chain }) => searchItem(name, normalized.area, context, chain).then((outcome) => {
      if (outcome.ok && !rewriteStarted && !outcome.value.sources.length &&
        typeof context.matcher?.rewriteQueries === "function") {
        rewriteStarted = true;
        // Start the one request-scoped rewrite while the remaining retailers
        // are still searching. It is ignored unless a chain needs broadening.
        const rewriteStartedAt = Date.now();
        rewritePromise = Promise.resolve()
          .then(() => context.matcher.rewriteQueries(freshNames, { maxDurationMs: 1300 }))
          .then((result) => {
            aiElapsedMs += Date.now() - rewriteStartedAt;
            return result;
          });
      }
      return outcome;
    })));
    const merged = new Map(freshNames.map((name) => [name, { name, sources: [], checkedAt: null, failed: false, cacheable: true, candidatesByChain: new Map() }]));
    // A failed search is not retried with a broader query; only genuine empty
    // results can use the bounded alternate query.
    const failedSearchKeys = new Set();
    const fallbackCheckedItems = new Set();
    for (let index = 0; index < searches.length; index += 1) {
      const { name, chain } = searches[index];
      const outcome = outcomes[index];
      const entry = merged.get(name);
      if (!outcome.ok) {
        entry.failed = true;
        failedSearchKeys.add(`${name.toLocaleLowerCase()}\u0000${chain.key}`);
        failures.push({ item: `${name} at ${chain.label}`, message: outcome.failure?.message || "This item could not be searched." });
        itemInFlight.delete(`${itemCacheKey(name, normalized.area)}\u0003${chain.key}`);
        continue;
      }
      if (outcome.kind === "cached") cacheHits += 1;
      entry.sources.push(...outcome.value.sources);
      entry.candidatesByChain.set(chain.key, outcome.value.candidates || []);
      entry.checkedAt = entry.checkedAt || outcome.value.checkedAt;
    }

    // One model rewrite may recover a retailer vocabulary miss. The rewritten
    // phrase is retrieval text only; every result still passes the original
    // item and diet/form gates in the adapters and candidate matcher.
    // Retries skip chains whose first search failed.
    const needsRetry = [];
    for (const name of freshNames) {
      const entry = merged.get(name);
      for (const chain of chains) {
        if (entry.sources.some((source) => source.chain === chain.key)) continue;
        if (failedSearchKeys.has(`${name.toLocaleLowerCase()}\u0000${chain.key}`)) continue;
        const query = fallbackSearchQuery(retailerSearchQuery(name));
        needsRetry.push({ name, chain, query });
      }
    }
    if (needsRetry.length && typeof context.matcher?.rewriteQueries === "function") {
      if (!rewritePromise) {
        const rewriteStartedAt = Date.now();
        rewritePromise = Promise.resolve()
          .then(() => context.matcher.rewriteQueries(freshNames, { maxDurationMs: 1300 }))
          .then((result) => {
            aiElapsedMs += Date.now() - rewriteStartedAt;
            return result;
          });
      }
      let rewriteResult;
      try {
        rewriteResult = await rewritePromise;
      } catch {
        rewriteResult = { ok: false, failure: { status: "network-error", message: "The grocery search query could not be rewritten." } };
      }
      let retryCount = 0;
      const retriedItems = new Set();
      // One retry per item at most, so a 21-item cart can recover several
      // genuine misses instead of stopping after three retries total.
      const maxRetries = Math.max(chains.length, freshNames.length);
      for (const need of needsRetry) {
        if (retryCount >= maxRetries || retriedItems.has(need.name)) continue;
        const rewritten = rewriteResult?.ok ? rewriteResult.queries?.get(need.name.toLocaleLowerCase()) : "";
        const query = rewritten || need.query;
        if (!query || normalizeName(query) === normalizeName(retailerSearchQuery(need.name))) continue;
        retryCount += 1;
        retriedItems.add(need.name);
        need.searchQuery = query;
      }
      const runnableRetries = needsRetry.filter((need) => need.searchQuery);
      const retryResults = await Promise.all(runnableRetries.map(async (need) => {
        try {
          return { need, result: await fetchSearch(need.name, normalized.area, context, need.chain, need.searchQuery) };
        } catch {
          return { need, result: { ok: false, failure: { status: "network-error", message: `${need.chain.label} could not retry the search.` } } };
        }
      }));
      for (const { need, result } of retryResults) {
        const entry = merged.get(need.name);
        if (!result?.ok) {
          entry.failed = true;
          failures.push({ item: `${need.name} at ${need.chain.label}`, message: result?.failure?.message || "The alternate retailer search failed." });
          continue;
        }
        fallbackCheckedItems.add(need.name);
        entry.sources.push(...(result.sources || []));
        const prior = entry.candidatesByChain.get(need.chain.key) || [];
        const seen = new Set(prior.map((candidate) => `${candidate.chain}\u0000${candidate.url}\u0000${candidate.title}`));
        const additions = (result.candidates || []).filter((candidate) => {
          const key = `${candidate.chain}\u0000${candidate.url}\u0000${candidate.title}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        entry.candidatesByChain.set(need.chain.key, [...prior, ...additions]);
        entry.checkedAt = entry.checkedAt || result.checkedAt;
      }
      if (!rewriteResult?.ok) {
        // A failed rewrite must not poison items the fallback query just
        // priced. Only report items that still have no sources.
        const reportedItems = new Set(needsRetry.map((need) => need.name));
        for (const name of reportedItems) {
          const entry = merged.get(name);
          if (entry.sources.length || fallbackCheckedItems.has(name)) continue;
          entry.failed = true;
          failures.push({ item: name, message: "The alternate search could not be checked; no product was substituted." });
        }
      }
    }

    const matcher = typeof context.matcher === "function" ? context.matcher : context.matcher?.match?.bind(context.matcher);
    const unresolvedPairs = [];
    if (matcher) {
      for (const name of freshNames) {
        const entry = merged.get(name);
        for (const chain of chains) {
          if (entry.sources.some((source) => source.chain === chain.key)) continue;
          const candidates = entry.candidatesByChain.get(chain.key) || [];
          if (candidates.length) unresolvedPairs.push({ item: name, chain: chain.key, candidates });
        }
      }
    }
    if (unresolvedPairs.length && matcher) {
      const remainingModelBudget = Math.max(0, MAX_AI_TOTAL_DURATION_MS - aiElapsedMs);
      const matchingStartedAt = Date.now();
      let matchResult;
      if (remainingModelBudget > 0) {
        try {
          matchResult = await matcher(unresolvedPairs, { maxDurationMs: Math.min(MAX_AI_MATCH_DURATION_MS, remainingModelBudget) });
        } catch {
          matchResult = { ok: false, failure: { status: "network-error", message: "Grocery candidates could not be verified." } };
        }
      } else {
        matchResult = { ok: false, failure: { status: "timeout", message: "The grocery matching request exceeded its shared deadline." } };
      }
      aiElapsedMs += Date.now() - matchingStartedAt;
      const skippedKeys = new Set((matchResult?.skippedPairs || []).map((pair) => pairKey(pair.item, pair.chain)));
      const failedByKey = new Map((matchResult?.failedPairs || []).map((pair) => [pairKey(pair.item, pair.chain), pair.failure]));
      for (const skipped of matchResult?.skippedPairs || []) {
        const entry = merged.get(skipped.item);
        if (!entry) continue;
        entry.failed = true;
        entry.cacheable = false;
        failures.push({ item: `${skipped.item} at ${skipped.chain}`, message: "The bounded matching pass left this store unpriced for review." });
      }
      for (const pair of unresolvedPairs) {
        const entry = merged.get(pair.item);
        const key = pairKey(pair.item, pair.chain);
        if (skippedKeys.has(key)) continue;
        if (!matchResult?.ok) {
          entry.failed = true;
          entry.cacheable = false;
          failures.push({ item: `${pair.item} at ${pair.chain}`, message: matchResult?.failure?.message || "The candidate could not be verified." });
          continue;
        }
        const approved = matchResult.selected?.get(key) || [];
        if (approved.length) {
          entry.sources.push(...approved);
          continue;
        }
        const failure = failedByKey.get(key);
        if (failure) {
          entry.failed = true;
          entry.cacheable = false;
          failures.push({ item: `${pair.item} at ${pair.chain}`, message: failure.message || "The candidate could not be verified." });
        }
      }
    }
    for (const [name, entry] of merged) {
      const item = finalItem(name, entry.sources, entry.checkedAt || new Date(nowFor(context)).toISOString());
      if (!entry.sources.length) {
        item.status = entry.failed ? "error" : "no-local-price";
        item.priceText = "Price unavailable";
      }
      // A chain error is transient; caching the assembled item would freeze
      // that store's missing line for the full six-hour offer cache window.
      if (!entry.failed && entry.cacheable) setCached(itemCacheKey(name, normalized.area), item, nowFor(context));
      for (const chain of chains) itemInFlight.delete(`${itemCacheKey(name, normalized.area)}\u0003${chain.key}`);
      items.push(item);
    }
    // Preserve the user's selected item order when fresh and cached results
    // finish at different times.
    const byName = new Map(items.map((item) => [item.name, item]));
    const ordered = normalized.items.map((name) => byName.get(name)).filter(Boolean);
    const uniqueFailures = [];
    const seenFailures = new Set();
    for (const entry of failures) {
      const key = `${entry.item || ""}\u0000${entry.message || ""}`;
      if (seenFailures.has(key)) continue;
      seenFailures.add(key);
      uniqueFailures.push(entry);
    }
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
      partial: uniqueFailures.length > 0,
      failures: uniqueFailures,
      note: "Live store prices. Pickup availability and final checkout totals unverified.",
    };
  }

  async function handle(req, res, options = {}) {
    const normalized = normalizeRequest(req?.body);
    if (!normalized.ok) return res.status(normalized.status).json({ ok: false, failure: { message: normalized.message } });
    const context = {
      fetchImpl: options.fetchImpl || globalThis.fetch,
      aldiPages: options.aldiPages === true,
      kroger: options.kroger || null,
      matcher: options.matcher || null,
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
        note: "Live store prices. Pickup availability and final checkout totals unverified.",
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
