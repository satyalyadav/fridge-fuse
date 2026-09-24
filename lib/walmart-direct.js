"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Walmart search pages embed their whole result set in the __NEXT_DATA__
// script tag, so the parser reads that JSON instead of scraping DOM nodes.
// Walmart serves a CAPTCHA to plain server fetches (and its internal GraphQL
// answers 418). Passing needs both a browser TLS fingerprint and a profile
// recent enough for the WAF: the same chrome131 request passes from a
// residential IP but is challenged from Vercel's AWS IP, while chrome142 and
// ios18 pass from both. impit carries the fingerprints and ships prebuilt
// per-platform binaries.
const WALMART_SEARCH_URL = "https://www.walmart.com/search";
const WALMART_BROWSER = "chrome151";
// Curated fallback, used when impit's shipped profile list cannot be read. The
// live list comes from resolveDefaultBrowsers() below, so an impit upgrade
// modernizes the fingerprints without editing this array.
const DEFAULT_BROWSERS = ["chrome151", "chrome142", "ios18"];
const MAX_DEFAULT_BROWSERS = 5;
const WALMART_SEARCH_TIMEOUT_MS = 15000;
const WALMART_MAX_RESULTS = 60;
const NEXT_DATA_PATTERN = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/;

// The header set must match the emulated browser version, or Walmart answers
// with the "Robot or human?" page: chrome131 headers under a chrome142
// fingerprint get challenged, and version-matched headers pass. Each profile
// therefore derives its own User-Agent and client hints. The measured matrix:
// chrome151, chrome142, and ios18 pass from Vercel's AWS IP; chrome131 and
// chrome136 are challenged there; chrome124, chrome125, chrome110, and
// firefox135 fail everywhere. All the others pass only from a residential IP.
function chromeHeaders(version) {
  const v = String(version);
  return {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Ch-Ua": `"Chromium";v="${v}", "Not_A Brand";v="24"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "\"Linux\"",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
  };
}

const IOS_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

function headersForBrowser(browser) {
  const chrome = /^chrome(\d+)$/.exec(String(browser));
  if (chrome) return chromeHeaders(chrome[1]);
  if (browser === "ios18") return { ...IOS_HEADERS };
  return chromeHeaders(142);
}

const WALMART_HEADERS = chromeHeaders(142);

// impit ships the fingerprints it supports in its type declarations, so the
// resolver reads that list instead of requiring a hand-edited one. An impit
// upgrade therefore modernizes the profiles with no code change: take the
// newest Chrome profiles and the newest iOS profile, then the curated
// entries impit still supports, newest first.
function supportedBrowsersFromTypings(typings) {
  const text = String(typings || "");
  const collect = (pattern) => [...new Set([...text.matchAll(pattern)].map((match) => Number(match[1])))].sort((a, b) => b - a);
  return {
    chrome: collect(/'chrome(\d+)'/g).map((version) => `chrome${version}`),
    ios: collect(/'ios(\d+)'/g).map((version) => `ios${version}`),
  };
}

function resolveDefaultBrowsers() {
  try {
    const entry = require.resolve("impit");
    const typings = fs.readFileSync(path.join(path.dirname(entry), "index.d.ts"), "utf8");
    const supported = supportedBrowsersFromTypings(typings);
    const newestChrome = supported.chrome.slice(0, 2);
    const newestIos = supported.ios.slice(0, 1);
    const extras = DEFAULT_BROWSERS.filter((browser) => !newestChrome.includes(browser)
      && !newestIos.includes(browser)
      && (supported.chrome.includes(browser) || supported.ios.includes(browser)));
    const resolved = [...newestChrome, ...newestIos, ...extras].slice(0, MAX_DEFAULT_BROWSERS);
    return resolved.length ? resolved : [...DEFAULT_BROWSERS];
  } catch {
    return [...DEFAULT_BROWSERS];
  }
}

function nextDataFromHtml(html) {
  const match = NEXT_DATA_PATTERN.exec(String(html || ""));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function priceLinesOf(item) {
  const lines = item?.priceInfo?.priceDetails?.priceLines;
  return Array.isArray(lines) ? lines : [];
}

function priceLineValue(item, lineType) {
  for (const line of priceLinesOf(item)) {
    if (line?.lineType !== lineType) continue;
    for (const value of Array.isArray(line.values) ? line.values : []) {
      if (typeof value?.value === "string" && value.value) return value.value;
    }
  }
  return "";
}

// Walmart's unit line reads "74.0 ¢/lb" or "15.4 ¢/oz". The app labels prices
// in dollars, so convert cent units and pass dollar units through.
function formatUnitPrice(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const cents = /^([0-9]+(?:\.[0-9]+)?)\s*¢\s*(?:\/\s*)?(.+)$/.exec(text);
  if (cents) {
    const dollars = Number(cents[1]) / 100;
    return `$${dollars.toFixed(2)}/${cents[2].trim()}`;
  }
  const dollars = /^\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*)?(.+)$/.exec(text);
  if (dollars) return `$${Number(dollars[1]).toFixed(2)}/${dollars[2].trim()}`;
  return text;
}

function walmartItemToResult(item) {
  if (!item || item.__typename !== "Product") return null;
  const title = typeof item.name === "string" ? item.name.trim() : "";
  const path = typeof item.canonicalUrl === "string" ? item.canonicalUrl.trim() : "";
  if (!title || !path) return null;
  const priceText = priceLineValue(item, "CURRENT_PRICE") || item.priceInfo?.itemPrice || "";
  const price = Number.parseFloat(String(priceText).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(price) || price <= 0) return null;
  const url = path.startsWith("http") ? path : `https://www.walmart.com${path.startsWith("/") ? "" : "/"}${path}`;
  return {
    title,
    url,
    price,
    seller: typeof item.sellerName === "string" ? item.sellerName : "",
    out_of_stock: item.isOutOfStock === true || item.availabilityStatus === "OUT_OF_STOCK",
    price_per_unit: formatUnitPrice(priceLineValue(item, "UNIT_PRICE")),
  };
}

function parseWalmartSearchHtml(html) {
  const data = nextDataFromHtml(html);
  const stacks = data?.props?.pageProps?.initialData?.searchResult?.itemStacks;
  if (!Array.isArray(stacks)) return [];
  const results = [];
  for (const stack of stacks) {
    for (const item of Array.isArray(stack?.items) ? stack.items : []) {
      const result = walmartItemToResult(item);
      if (result) results.push(result);
      if (results.length >= WALMART_MAX_RESULTS) return results;
    }
  }
  return results;
}

// Returns a search function that yields plain result rows (title, url, price,
// seller, out_of_stock, price_per_unit) for the offer pipeline. fetchImpl is
// an injection point for tests; production uses impit clients, created on
// first use so a missing native binary cannot break server startup. With
// several browsers configured, each attempt's outcome is collected so a block
// says which fingerprints were tried.
function createWalmartDirectSearch(options = {}) {
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
  const browsers = Array.isArray(options.browsers) && options.browsers.length
    ? options.browsers.map(String)
    : resolveDefaultBrowsers();
  const warmUp = options.warmUp === true;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : WALMART_SEARCH_TIMEOUT_MS;
  const clients = new Map();
  const getClient = (browser) => {
    if (clients.has(browser)) return clients.get(browser);
    const { Impit } = require("impit");
    const client = new Impit({ browser, timeout: timeoutMs });
    clients.set(browser, client);
    return client;
  };
  const search = async function searchWalmartDirect(query, zip) {
    const url = new URL(WALMART_SEARCH_URL);
    url.searchParams.set("q", String(query || ""));
    // The compare only wants the cheapest advertised price, and the default
    // best-match order can bury the cheapest staples (Cut Green Beans, Brown
    // Rice) below sponsored and pricier placements.
    url.searchParams.set("sort", "price_low");
    if (zip) url.searchParams.set("zip", String(zip));
    const attempts = [];
    for (const browser of browsers) {
      const headers = headersForBrowser(browser);
      try {
        let html = "";
        if (fetchImpl) {
          const response = await fetchImpl(url.href, { headers: { ...headers } });
          if (!response?.ok) {
            attempts.push(`${browser} HTTP ${response?.status ?? "?"}`);
            continue;
          }
          html = await response.text();
        } else {
          const client = getClient(browser);
          // A first visit to the homepage is a warm-up for the session
          // cookies, and the follow-up search then looks same-origin.
          if (warmUp) await client.fetch("https://www.walmart.com/", { headers: { ...headers } });
          const response = await client.fetch(url.href, {
            headers: warmUp
              ? { ...headers, Referer: "https://www.walmart.com/", "Sec-Fetch-Site": "same-origin" }
              : headers,
          });
          if (!response || response.status < 200 || response.status >= 300) {
            attempts.push(`${browser} HTTP ${response?.status ?? "?"}`);
            continue;
          }
          html = await response.text();
        }
        // Distinguish a block from a query that genuinely has no products, so
        // the pipeline can report the real reason.
        if (/Robot or human\?/i.test(html)) {
          attempts.push(`${browser} CAPTCHA`);
          continue;
        }
        if (!html.includes("__NEXT_DATA__")) {
          attempts.push(`${browser} no product data`);
          continue;
        }
        return parseWalmartSearchHtml(html);
      } catch (error) {
        attempts.push(`${browser} ${String(error?.message || error).slice(0, 60)}`);
      }
    }
    throw new Error(`Walmart search returned no products (${attempts.join("; ")})`);
  };
  // The canary and /api/health read the resolved list off the search function.
  search.browsers = [...browsers];
  return search;
}

module.exports = {
  createWalmartDirectSearch,
  resolveDefaultBrowsers,
  supportedBrowsersFromTypings,
  parseWalmartSearchHtml,
  formatUnitPrice,
  headersForBrowser,
  DEFAULT_BROWSERS,
  WALMART_BROWSER,
  WALMART_HEADERS,
  WALMART_SEARCH_URL,
};
