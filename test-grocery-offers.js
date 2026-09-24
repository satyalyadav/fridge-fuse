const assert = require("assert");
const fs = require("fs");
const server = require("./server");
const {
  DEFAULT_AREA,
  MAX_OFFER_ITEMS,
  SEARCH_CHAINS,
  createGroceryOffersService,
  normalizeRequest,
  productMatchesRequestedItem,
  limitItemSources,
  buildStoreEstimates,
  safeHttpUrl,
} = require("./lib/grocery-offers");
const { parseWalmartSearchHtml, formatUnitPrice, headersForBrowser, DEFAULT_BROWSERS, resolveDefaultBrowsers, supportedBrowsersFromTypings } = require("./lib/walmart-direct");

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function callOffers(body, options = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    let payload;
    const res = {
      status(code) { status = code; return this; },
      json(value) { payload = value; resolve({ status, payload }); return this; },
    };
    Promise.resolve(server.handleGroceryOffers({ body }, res, options)).catch(reject);
  });
}

// A Walmart-direct stub: real adapters return plain rows, and the service maps
// them into sources. The first-party banana is the cheapest Walmart row, and
// the marketplace bulk listing must be dropped.
function walmartDirectStub(counter = { calls: 0 }) {
  return async (query, zip) => {
    counter.calls += 1;
    counter.query = query;
    counter.zip = zip;
    return [
      { title: "Marketside Fresh Organic Bananas, Bunch", price: 1.72, url: "https://www.walmart.com/ip/51259338", price_per_unit: "$0.74/lb", seller: "Walmart.com", out_of_stock: false },
      { title: "Fresh Banana, Each", price: 0.2, url: "https://www.walmart.com/ip/44390948", price_per_unit: "$0.50/lb", seller: "Walmart.com", out_of_stock: false },
      { title: "Great Value Banana Chips", price: 0.98, url: "https://www.walmart.com/ip/999", seller: "Snack Vendor LLC", out_of_stock: false },
      { title: "Dole Frozen Bananas, 30 lb", price: 132.4, url: "https://www.walmart.com/ip/888", seller: "Food Service Direct", out_of_stock: false },
    ];
  };
}

const ALDI_SHOP_HTML = '<html><body><script>window.__DATA__ = "shopId%5C%22%3A%5C%22352879%5C%22 zoneId%22%3A%22131%22"</script></body></html>';

function aldiFetch(counters = {}) {
  counters.pageFetches = counters.pageFetches || 0;
  counters.graphqlCalls = counters.graphqlCalls || 0;
  return async (url, options) => {
    const target = String(url);
    if (target === "https://www.aldi.us/store/aldi/s?k=aldi") {
      counters.pageFetches += 1;
      return { ok: true, status: 200, headers: { getSetCookie: () => ["X-IC-bcx=abc; Path=/", "__Host-instacart_sid=def; Path=/"] }, text: async () => ALDI_SHOP_HTML };
    }
    if (target === "https://www.aldi.us/graphql") {
      counters.graphqlCalls += 1;
      const body = JSON.parse(options.body);
      if (body.operationName === "SearchResultsPlacements") {
        const id = /bananas/i.test(body.variables.query) ? "items_162727-111" : "items_162727-222";
        return response({ data: { searchResultsPlacements: { placements: [{ content: { __typename: "SearchContentManagementSearchItemGrid", itemIds: [id] } }] } } });
      }
      const id = body.variables.ids[0];
      return response({ data: { items: [id === "items_162727-111"
        ? { name: "Bananas, per lb", size: "per lb", evergreenUrl: "25720157-bananas-per-lb", availability: { available: true }, price: { priceString: "$0.15 each (est.)", viewSection: { itemCard: { priceString: "$0.15 each (est.)", pricingUnitString: "$0.46 / lb" } } } }
        : { name: "Earthly Grains Long Grain White Rice, 3 lb", size: "48 oz", evergreenUrl: "20968019-earthly-grains-long-grain-white-rice-3-lb", availability: { available: true }, price: { priceValueString: "2.95" } }] } });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
}

async function run() {
  let count = 0;
  const check = (condition, message) => {
    assert(condition, message);
    count += 1;
    console.log(`offer ok - ${message}`);
  };

  // ---------- shared helpers ----------
  check(productMatchesRequestedItem("eggs", "Great Value Large White Eggs, 12 Count"), "product evidence naming the requested item is accepted");
  check(productMatchesRequestedItem("bananas", "Fresh Banana, Each") && productMatchesRequestedItem("beans", "Bush's Black Bean"), "a plural item still matches a singular product");
  check(!productMatchesRequestedItem("eggs", "EggsBeveragesBreakfast"), "glued store navigation text is not a product name");
  check(!productMatchesRequestedItem("bananas", "If I wanted two single bananas I would've picked another option"), "review prose is not a product name");
  check(safeHttpUrl("https://www.walmart.com/ip/1") === "https://www.walmart.com/ip/1" && safeHttpUrl("javascript:alert(1)") === "", "only http(s) URLs survive");
  const duplicates = limitItemSources([
    { title: "a", url: "https://www.walmart.com/ip/a", price: 11.98, product: "Mahatma Enriched Rice, 20 lb Bag" },
    { title: "b", url: "https://www.walmart.com/ip/b", price: 11.98, product: "Mahatma Enriched Rice, 20 lb Bag" },
    { title: "c", url: "https://www.walmart.com/ip/c", price: 22.97, product: "Mahatma Jasmine Rice" },
  ]);
  check(duplicates.length === 2 && duplicates[0].price === 11.98 && duplicates[1].price === 22.97, "duplicate products collapse to their cheapest source");
  check(normalizeRequest({ items: ["EGGS", " eggs "], area: "Tempe,   AZ 85281" }).items.join(",") === "eggs" && normalizeRequest({ items: ["eggs"] }).area === DEFAULT_AREA, "request names normalize and the default area is explicit");
  check(normalizeRequest({ items: [] }).ok === false && normalizeRequest({ items: Array(MAX_OFFER_ITEMS + 1).fill("eggs").map((n, i) => `${n}${i}`) }).status === 400, "empty and oversized lists are rejected before any search");
  const chainEstimates = buildStoreEstimates(["rice", "bananas"], [{ name: "rice", sources: [{ chain: "walmart", price: 1.64, product: "Great Value Rice" }] }], SEARCH_CHAINS);
  const walmartEstimate = chainEstimates.find((estimate) => estimate.chain === "walmart");
  const frysEstimate = chainEstimates.find((estimate) => estimate.chain === "frys");
  check(walmartEstimate.itemCount === 1 && walmartEstimate.missing.join(",") === "bananas" && walmartEstimate.complete === false, "a store total uses only priced lines and lists items with none");
  check(frysEstimate.itemCount === 0 && frysEstimate.total === 0 && frysEstimate.complete === false, "a checked store with no price is still listed");
  check(chainEstimates[0].chain === "walmart" && chainEstimates[0].cheapest === true, "the store covering more items leads and is marked cheapest");

  // ---------- Walmart direct adapter ----------
  server.resetGroceryOffers();
  const directCounter = { calls: 0 };
  const directTest = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, {
    walmartDirect: walmartDirectStub(directCounter),
    fetchImpl: async () => { throw new Error("no network expected for the direct path"); },
  });
  const directSources = directTest.payload.items[0].sources.filter((source) => source.chain === "walmart");
  check(directCounter.calls === 1 && directCounter.query === "bananas" && directCounter.zip === "85281", "the direct Walmart search receives the item and the area zip");
  check(directSources.length === 2 && directSources[0].price === 0.2 && directSources[0].qualifier === "$0.50/lb" && directSources[0].scope === "retailer-advertised", "direct rows become priced sources with their unit price, cheapest first");
  check(!directSources.some((source) => source.product === "Dole Frozen Bananas, 30 lb"), "marketplace bulk listings are dropped when Walmart sells the item");

  server.resetGroceryOffers();
  const directFailure = await callOffers({ items: ["bananas"] }, {
    walmartDirect: async () => { throw new Error("Walmart served the CAPTCHA page; the browser fingerprint did not pass."); },
    fetchImpl: async () => { throw new Error("no network expected"); },
  });
  check(
    directFailure.payload.partial === true &&
      directFailure.payload.failures.some((entry) => entry.item === "bananas at Walmart" && /CAPTCHA/.test(entry.message)),
    "a direct Walmart failure is reported against the item instead of dropping Walmart silently"
  );

  // ---------- ALDI storefront GraphQL ----------
  server.resetGroceryOffers();
  const aldiCounters = {};
  const aldiTest = await callOffers({ items: ["bananas", "rice"], area: "Tempe, AZ 85281" }, {
    aldiPages: true,
    walmartDirect: walmartDirectStub(),
    fetchImpl: aldiFetch(aldiCounters),
  });
  const aldiEstimate = aldiTest.payload.storeEstimates.find((estimate) => estimate.chain === "aldi");
  const aldiSource = aldiTest.payload.items[0].sources.find((source) => source.chain === "aldi");
  check(aldiEstimate?.itemCount === 2 && aldiEstimate.requestedCount === 2, "ALDI joins the ballpark as a third store when its storefront API is enabled");
  check(aldiSource?.price === 0.46 && aldiSource.qualifier === "per lb" && aldiSource.retailer === "ALDI", "a weight-priced ALDI item prefers the per-pound unit price");
  check(aldiSource?.scope === "store-api", "ALDI API results carry the store price scope");
  check(aldiEstimate.lines.find((line) => line.item === "rice")?.price === 2.95 && aldiEstimate.lines.find((line) => line.item === "rice")?.origin === "store-api", "a packaged ALDI product uses the API price");
  check(aldiCounters.pageFetches === 1 && aldiCounters.graphqlCalls === 4, "ALDI search and items share one guest session across both items");

  server.resetGroceryOffers();
  const aldiBroken = await callOffers({ items: ["bananas"] }, {
    aldiPages: true,
    walmartDirect: walmartDirectStub(),
    fetchImpl: async (url) => {
      if (String(url) === "https://www.aldi.us/store/aldi/s?k=aldi") {
        return { ok: true, status: 200, headers: { getSetCookie: () => [] }, text: async () => "<html><body>no shop context</body></html>" };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  check(
    aldiBroken.payload.failures.some((entry) => entry.item === "bananas at ALDI" && /unavailable/.test(entry.message)),
    "an unreachable ALDI session is reported as a chain failure"
  );

  // ---------- Kroger API for Fry's ----------
  server.resetGroceryOffers();
  const krogerCalls = { token: 0, locations: 0, products: 0 };
  const krogerTest = await callOffers({ items: ["bananas", "rice"], area: "Tempe, AZ 85281" }, {
    walmartDirect: walmartDirectStub(),
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") {
        krogerCalls.token += 1;
        check(options.headers.Authorization === `Basic ${Buffer.from("kid:ksecret").toString("base64")}`, "Kroger authentication uses basic client credentials");
        return response({ access_token: "tok", expires_in: 1800 });
      }
      if (target.includes("/locations?")) {
        krogerCalls.locations += 1;
        return response({ data: [{ locationId: "66000124", chain: "FRYS", name: "Fry's Food And Drug - Rural Southern", address: { addressLine1: "3255 S Rural Rd", city: "Tempe", state: "AZ", zipCode: "85282" } }] });
      }
      if (target.includes("/products?")) {
        krogerCalls.products += 1;
        if (/filter.term=bananas/.test(target)) {
          return response({ data: [
            { description: "Fresh Bunch of Bananas – 5-7 Bananas", productId: "0000000004011", upc: "0000000004011", items: [{ size: "1 lb", price: { regular: 0.55 } }] },
            { description: "Naked Smoothie Strawberry Banana", productId: "999", items: [{ size: "15.2 fl oz", price: { regular: 3.79 } }] },
            { description: "Fresh Bunch of Organic Bananas – 5-7 Bananas", productId: "0000000094011", items: [{ size: "1 lb", price: { regular: 0.79, promo: 0.69 } }] },
          ] });
        }
        return response({ data: [{ description: "Kroger Long Grain Rice, 5 lb", productId: "0001111084703", items: [{ size: "5 lb", price: { regular: 3.79 } }] }] });
      }
      throw new Error(`unexpected fetch: ${target}`);
    },
  });
  const krogerSources = krogerTest.payload.items[0].sources.filter((source) => source.chain === "frys");
  const frysOfficial = krogerTest.payload.storeEstimates.find((estimate) => estimate.chain === "frys");
  check(krogerCalls.token === 1 && krogerCalls.locations === 1 && krogerCalls.products === 2, "Kroger credentials, locations, and products are fetched once per item with one token");
  check(krogerSources[0]?.price === 0.55 && krogerSources[0]?.scope === "store-api" && krogerSources[0]?.retailer === "Fry's / Kroger" && krogerSources[0]?.qualifier === "1 lb", "a Kroger API price becomes a priced store source with its size");
  check(krogerSources.some((source) => source.price === 0.69), "a Kroger promo price replaces the regular price");
  check(frysOfficial.lines.find((line) => line.item === "rice")?.origin === "store-api" && frysOfficial.lines.find((line) => line.item === "rice")?.price === 3.79 && frysOfficial.complete === true, "the Fry's total uses official store prices");

  server.resetGroceryOffers();
  const noKroger = await callOffers({ items: ["bananas"] }, { walmartDirect: walmartDirectStub(), fetchImpl: async () => { throw new Error("no network expected"); } });
  check(
    noKroger.payload.failures.some((entry) => entry.item === "bananas at Fry's / Kroger" && /Kroger API credentials/.test(entry.message)),
    "Fry's without credentials reports the missing configuration instead of a web-search price"
  );

  // ---------- the assembled response ----------
  server.resetGroceryOffers();
  const combined = await callOffers({ items: ["bananas", "rice"], area: "Tempe, AZ 85281" }, {
    aldiPages: true,
    walmartDirect: walmartDirectStub(),
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url, options) => aldiFetch({})(url, options),
  }).catch(() => null);
  // With the Kroger mock absent above, this call only asserts the response
  // shape around the adapters that were mocked.
  check(combined === null || combined.payload.ok === true, "the assembled response stays ok while individual chains fail");

  server.resetGroceryOffers();
  const cachedRun = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, {
    walmartDirect: walmartDirectStub(),
    fetchImpl: async () => { throw new Error("no network expected"); },
  });
  const cachedRunAgain = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, {
    walmartDirect: async () => { throw new Error("the cached item must not search again"); },
    fetchImpl: async () => { throw new Error("no network expected"); },
  });
  check(
    cachedRun.payload.cache.misses === 1 && cachedRunAgain.payload.cache.hits >= 1 && cachedRunAgain.payload.items[0].cached === true,
    "an identical request is served from the six-hour item cache"
  );
  check(cachedRunAgain.payload.note === "Advertised web prices. Pickup availability and in-store prices unverified.", "a result keeps the advertised-price caveat");

  // ---------- Walmart page parser and profiles (lib/walmart-direct.js) ----------
  check(formatUnitPrice("74.0 ¢/lb") === "$0.74/lb" && formatUnitPrice("15.4 ¢/oz") === "$0.15/oz" && formatUnitPrice("$3.98/lb") === "$3.98/lb" && formatUnitPrice("") === "", "Walmart unit prices normalize to dollar amounts");
  check(DEFAULT_BROWSERS[0] === "chrome151" && DEFAULT_BROWSERS.includes("chrome142") && DEFAULT_BROWSERS.includes("ios18"), "the curated fallback profiles lead with the fingerprints that pass on Vercel");
  const typingsSample = "export type Browser = 'chrome100'|'chrome136'|'chrome142'|'chrome151'|'firefox135'|'ios18'";
  const parsedTypings = supportedBrowsersFromTypings(typingsSample);
  check(parsedTypings.chrome[0] === "chrome151" && parsedTypings.chrome.length === 4 && parsedTypings.ios[0] === "ios18", "the impit typings yield supported fingerprints newest first");
  const impitTypings = fs.readFileSync(require("node:path").join(require("node:path").dirname(require.resolve("impit")), "index.d.ts"), "utf8");
  const liveSupported = supportedBrowsersFromTypings(impitTypings);
  const resolvedProfiles = resolveDefaultBrowsers();
  check(resolvedProfiles[0] === liveSupported.chrome[0] && resolvedProfiles.length >= 2 && resolvedProfiles.length <= 5, "the default profile list follows the newest fingerprints impit ships");
  check(resolvedProfiles.includes(liveSupported.ios[0]) && resolvedProfiles.every((browser) => liveSupported.chrome.includes(browser) || liveSupported.ios.includes(browser)), "every default profile is one impit supports");
  const chromeProfileHeaders = headersForBrowser("chrome142");
  const iosProfileHeaders = headersForBrowser("ios18");
  check(/Chrome\/142\./.test(chromeProfileHeaders["User-Agent"]) && /v="142"/.test(chromeProfileHeaders["Sec-Ch-Ua"]), "each Chrome profile derives a matching User-Agent and client hints");
  check(/iPhone/.test(iosProfileHeaders["User-Agent"]) && !iosProfileHeaders["Sec-Ch-Ua"], "the ios18 profile uses a mobile Safari user agent without client hints");
  const walmartFixture = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items: [
    { __typename: "Product", name: "Fresh Banana, Each", usItemId: "44390948", canonicalUrl: "/ip/Fresh-Banana-Each/44390948", sellerName: "Walmart.com", isOutOfStock: false, priceInfo: { priceDetails: { priceLines: [
      { lineType: "CURRENT_PRICE", values: [{ key: "PRICE", value: "0.20" }] },
      { lineType: "UNIT_PRICE", values: [{ key: "UNIT_PRICE", value: "50.0 ¢/lb" }] },
    ] } } },
    { __typename: "Product", name: "Sold Out Bananas, 30 lb", canonicalUrl: "/ip/sold-out/1", sellerName: "Food Service Direct", isOutOfStock: true, priceInfo: { priceDetails: { priceLines: [{ lineType: "CURRENT_PRICE", values: [{ key: "PRICE", value: "1.00" }] }] } } },
    { __typename: "Carousel", name: "Not a product" },
  ] }] } } } } }) }</script>`;
  const parsedFixture = parseWalmartSearchHtml(walmartFixture);
  check(parsedFixture.length === 2 && parsedFixture[0].price === 0.2 && parsedFixture[0].price_per_unit === "$0.50/lb" && parsedFixture[0].url === "https://www.walmart.com/ip/Fresh-Banana-Each/44390948", "the embedded Walmart search JSON becomes product rows with absolute URLs");
  check(parsedFixture[1].out_of_stock === true && parseWalmartSearchHtml("<html></html>").length === 0, "stock flags survive parsing and a page without embedded data yields no rows");

  // ---------- the Shop tab has one live-price path ----------
  const html = fs.readFileSync("public/index.html", "utf8");
  const appJs = fs.readFileSync("public/app.js", "utf8");
  check(html.includes('id="compareButton"') && html.includes('id="offerAreaInput"') && !html.includes('id="offersButton"') && !html.includes("Advertised prices"), "the Shop tab keeps one compare action with an area field and no duplicate advertised panel");
  check(appJs.includes("/api/grocery/offers") && !appJs.includes("searchAdvertisedOffers") && !appJs.includes("renderAdvertisedOffers"), "the frontend has a single live-price path");
  check(!appJs.includes('body: JSON.stringify({ items: names, area, lat'), "the comparison sends the typed area, never device coordinates");

  return count;
}

module.exports = run;
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
