const assert = require("assert");
const fs = require("fs");
const server = require("./server");
const { createGroceryMatcher, pairKey } = require("./lib/grocery-matcher");
const {
  DEFAULT_AREA,
  MAX_OFFER_ITEMS,
  SEARCH_CHAINS,
  normalizeRequest,
  productMatchesRequestedItem,
  limitItemSources,
  buildStoreEstimates,
  safeHttpUrl,
} = require("./lib/grocery-offers");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => typeof payload === "string" ? payload : JSON.stringify(payload),
  };
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

function matcherEnvelope(decisions) {
  return { ok: true, data: { choices: [{ message: { content: JSON.stringify({ decisions }) } }] } };
}

function krogerFetch(productsForTerm, counters = {}) {
  return async (url) => {
    const target = String(url);
    if (target === "https://api.kroger.com/v1/connect/oauth2/token") {
      counters.tokens = (counters.tokens || 0) + 1;
      return response({ access_token: "tok", expires_in: 1800 });
    }
    if (target.includes("/locations?")) {
      counters.locations = (counters.locations || 0) + 1;
      return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
    }
    if (target.includes("/products?")) {
      counters.products = (counters.products || 0) + 1;
      const term = new URL(target).searchParams.get("filter.term") || "";
      counters.terms = [...(counters.terms || []), term];
      const rows = typeof productsForTerm === "function" ? productsForTerm(term) : productsForTerm[term] || [];
      return response({ data: rows.map((row, index) => ({
        description: row.description,
        productId: row.productId || `test-${index}`,
        items: [{ size: row.size || "15 oz", price: { regular: row.price, ...(row.promo ? { promo: row.promo } : {}) } }],
      })) });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
}

const ALDI_SHOP_HTML = '<html><body><script>window.__DATA__ = "shopId%5C%22%3A%5C%22352879%5C%22 zoneId%22%3A%22131%22"</script></body></html>';

function aldiFetch(counters = {}, payloadOverrides = {}) {
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
        if (Object.prototype.hasOwnProperty.call(payloadOverrides, "search")) return response(payloadOverrides.search);
        const id = /bananas/i.test(body.variables.query) ? "items_162727-111" : "items_162727-222";
        return response({ data: { searchResultsPlacements: { placements: [{ content: { __typename: "SearchContentManagementSearchItemGrid", itemIds: [id] } }] } } });
      }
      if (Object.prototype.hasOwnProperty.call(payloadOverrides, "items")) return response(payloadOverrides.items);
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
  check(
    productMatchesRequestedItem("long grain microwave rice", "Ben's Original Ready Rice Long Grain White") &&
      productMatchesRequestedItem("long grain microwave rice", "Great Value Ready-to-Heat 90-Second Long Grain White Rice Pouch") &&
      productMatchesRequestedItem("long grain microwave rice", "Great Value Long Grain Microwaveable Rice") &&
      !productMatchesRequestedItem("long grain microwave rice", "Great Value Long Grain White Rice, 5 lb") &&
      !productMatchesRequestedItem("long grain microwave rice", "Great Value Instant Long Grain Rice") &&
      !productMatchesRequestedItem("long grain microwave rice", "Great Value Ready-to-Heat Instant Long Grain Rice Pouch") &&
      !productMatchesRequestedItem("long grain microwave rice", "Great Value Ready-to-Heat 90-Second Spanish Style Long Grain Rice Pouch"),
    "microwave rice accepts ready-to-heat long-grain pouches but rejects dry, instant, and flavored rice"
  );
  check(
    productMatchesRequestedItem("baby spinach leaf", "Marketside Baby Spinach") &&
      productMatchesRequestedItem("baby spinach leaf", "Marketside Baby Spinach Leaves") &&
      productMatchesRequestedItem("baby spinach leave", "Marketside Baby Spinach") &&
      productMatchesRequestedItem("baby spinach leave", "Marketside Baby Spinach Leaves"),
    "baby spinach leaf needs match store titles that omit or pluralize leaf"
  );
  check(
    productMatchesRequestedItem("coriander leaf", "Fresh Cilantro Bunch") &&
      productMatchesRequestedItem("coriander leaf", "Simple Truth Organic Cilantro") &&
      !productMatchesRequestedItem("coriander leaf", "McCormick Coriander Seeds") &&
      !productMatchesRequestedItem("coriander leaf", "Cilantro Lime Rice") &&
      !productMatchesRequestedItem("coriander leaf", "Cilantro Dressing") &&
      !productMatchesRequestedItem("coriander leaf", "Cilantro Sauce") &&
      !productMatchesRequestedItem("coriander leaf", "Cilantro Lime Seasoning"),
    "coriander leaf accepts fresh or herb-only cilantro products without prepared foods or spices"
  );
  check(
      productMatchesRequestedItem("tomato puree", "Great Value Tomato Puree, 10.75 oz") &&
      productMatchesRequestedItem("tomato puree", "Great Value Tomato Purée, 10.75 oz") &&
      !productMatchesRequestedItem("tomato puree", "Gerber Stage 2 Baby Food Sweet Potato Carrot Beef & Tomato Baby Food Pouches Puree") &&
      productMatchesRequestedItem("turmeric paste", "Ginger Turmeric Paste") &&
      !productMatchesRequestedItem("turmeric paste", "Great Value Ground Turmeric"),
    "tomato puree matches accented titles, and turmeric paste does not match a powder"
  );
  check(productMatchesRequestedItem("canned tomatoes", "Great Value Canned Diced Tomatoes") && !productMatchesRequestedItem("canned tomatoes", "Canned Dark Red Kidney Beans"), "compound grocery terms require the product to match both meaningful words");
  check(
    ["Great Value Onion Powder", "McCormick Onion Seasoning", "Great Value Minced Onion, 2.35 oz", "Fresh Green Onions", "Spring Onion Bunch", "Scallions", "Great Value Onion Rings", "Dean's French Onion Dip"]
      .every((product) => !productMatchesRequestedItem("onion", product)),
    "bare onion searches reject spice, scallion, ring, and dip products"
  );
  check(
    ["Jumbo Yellow Onions", "White Onion", "Red Onion"].every((product) => productMatchesRequestedItem("onion", product)),
    "bare onion searches accept normal bulb onion colors"
  );
  check(
    !productMatchesRequestedItem("diced tomatoes", "Great Value Hot Diced Tomatoes with Green Chilies and Habanero Puree") &&
      !productMatchesRequestedItem("diced tomato", "Casa Mamita Canned Diced Tomatoes with Green Chilies") &&
      productMatchesRequestedItem("diced tomato", "Happy Harvest Diced Tomatoes") &&
      productMatchesRequestedItem("diced tomatoes", "Great Value Diced Tomatoes in Tomato Juice"),
    "plain diced tomato searches reject spicy variants but accept plain canned diced tomatoes"
  );
  check(
    !productMatchesRequestedItem("corn", "Happy Harvest Cream Style Sweet Corn") &&
      !productMatchesRequestedItem("corn", "Del Monte Creamed Corn") &&
      productMatchesRequestedItem("corn", "Great Value Golden Sweet Whole Kernel Corn") &&
      productMatchesRequestedItem("corn", "Fresh Sweet Corn on the Cob"),
    "plain corn searches reject creamed corn while accepting kernels and fresh corn"
  );
  check(!productMatchesRequestedItem("sour cream guacamole", "Friendly Farms Sour Cream") && !productMatchesRequestedItem("sour cream guacamole", "Guacamole Salsa"), "one half of a malformed compound cannot price the whole item");
  check(productMatchesRequestedItem("gf pasta", "Great Value Gluten Free Penne Pasta") && !productMatchesRequestedItem("gf pasta", "Barilla Penne Pasta"), "short gluten-free qualifiers remain meaningful during product matching");
  check(!productMatchesRequestedItem("eggs", "EggsBeveragesBreakfast"), "glued store navigation text is not a product name");
  check(!productMatchesRequestedItem("bananas", "If I wanted two single bananas I would've picked another option"), "review prose is not a product name");
  check(safeHttpUrl("https://www.frysfood.com/p/1") === "https://www.frysfood.com/p/1" && safeHttpUrl("javascript:alert(1)") === "", "only http(s) URLs survive");
  const duplicates = limitItemSources([
    { title: "a", url: "https://www.frysfood.com/p/a", price: 11.98, product: "Mahatma Enriched Rice, 20 lb Bag" },
    { title: "b", url: "https://www.frysfood.com/p/b", price: 11.98, product: "Mahatma Enriched Rice, 20 lb Bag" },
    { title: "c", url: "https://www.aldi.us/p/c", price: 22.97, product: "Mahatma Jasmine Rice" },
  ]);
  check(duplicates.length === 2 && duplicates[0].price === 11.98 && duplicates[1].price === 22.97, "duplicate products collapse to their cheapest source");
  check(normalizeRequest({ items: ["EGGS", " eggs "], area: "Tempe,   AZ 85281" }).items.join(",") === "eggs" && normalizeRequest({ items: ["eggs"] }).area === DEFAULT_AREA, "request names normalize and the default area is explicit");
  check(normalizeRequest({ items: [] }).ok === false && normalizeRequest({ items: Array(MAX_OFFER_ITEMS + 1).fill("eggs").map((n, i) => `${n}${i}`) }).status === 400, "empty and oversized lists are rejected before any search");
  const chainEstimates = buildStoreEstimates(["rice", "bananas"], [{ name: "rice", sources: [{ chain: "frys", price: 1.64, product: "Kroger Rice" }] }], SEARCH_CHAINS);
  const frysEstimate = chainEstimates.find((estimate) => estimate.chain === "frys");
  check(SEARCH_CHAINS.map((chain) => chain.key).join(",") === "frys", "Fry's is the only always-on live chain");
  check(frysEstimate.itemCount === 1 && frysEstimate.missing.join(",") === "bananas" && frysEstimate.complete === false, "a store total uses only priced lines and lists items with none");
  check(chainEstimates[0].chain === "frys" && chainEstimates[0].cheapest === true, "the store covering more items leads and is marked cheapest");
  const enabledChains = [...SEARCH_CHAINS, { key: "aldi", label: "ALDI" }];
  check(buildStoreEstimates(["rice"], [], enabledChains).length === 2, "enabling ALDI leaves exactly two live store estimates");

  // ---------- live Kroger search and bounded matching ----------
  server.resetGroceryOffers();
  let corianderQuery = "";
  const corianderTest = await callOffers({ items: ["coriander leaf"], area: "Tempe, AZ 85281" }, {
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: krogerFetch((term) => {
      corianderQuery = term;
      return [{ description: "Fresh Cilantro Bunch", price: 0.88 }];
    }),
  });
  check(
    corianderQuery === "cilantro" && corianderTest.payload.items[0].sources.some((source) => source.chain === "frys" && source.product === "Fresh Cilantro Bunch"),
    "the Fry's search uses the cilantro synonym and retains its live product"
  );

  server.resetGroceryOffers();
  const retailerQueries = [];
  const rewrittenMatcher = createGroceryMatcher({
    chat: async (messages) => {
      const payload = JSON.parse(messages[1].content);
      if (Array.isArray(payload.needs)) {
        return { ok: true, data: { choices: [{ message: { content: JSON.stringify({ items: payload.needs.map(() => "chickpeas") }) } }] } };
      }
      const decisions = payload.chains.map((pair) => ({
        chain: pair.chain,
        candidateIds: pair.candidates.filter((candidate) => /chickpeas/i.test(candidate.title)).map((candidate) => candidate.id),
      })).map((decision) => ({ ...decision, candidateIds: decision.candidateIds.length ? decision.candidateIds : null }));
      return matcherEnvelope(decisions);
    },
  });
  const rewriteRecovery = await callOffers({ items: ["garbanzo beans"], area: "Tempe, AZ 11111" }, {
    matcher: rewrittenMatcher,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: krogerFetch((term) => {
      retailerQueries.push(term);
      if (term === "garbanzo beans") return [{ description: "Black Bean Soup", price: 1.1 }];
      if (term === "chickpeas") return [{ description: "Great Value Chickpeas, 15 oz", price: 1.24 }];
      throw new Error(`unexpected rewritten query: ${term}`);
    }),
  });
  const rewrittenSource = rewriteRecovery.payload.items[0].sources.find((source) => source.chain === "frys");
  check(
    retailerQueries.includes("garbanzo beans") && retailerQueries.includes("chickpeas") &&
      rewrittenSource?.product === "Great Value Chickpeas, 15 oz" && rewrittenSource.price === 1.24 &&
      rewrittenSource.url.startsWith("https://www.frysfood.com/p/"),
    "a bounded query rewrite recovers a live synonym while retaining the original need's safety checks"
  );

  server.resetGroceryOffers();
  const failedSearchQueries = [];
  const failedSearch = await callOffers({ items: ["turmeric paste"], area: "Tempe, AZ 11114" }, {
    matcher: { rewriteQueries: async () => ({ ok: true, queries: new Map([["turmeric paste", "turmeric"]]) }) },
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") return response({ access_token: "tok", expires_in: 1800 });
      if (target.includes("/locations?")) return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
      if (target.includes("/products?")) {
        failedSearchQueries.push(new URL(target).searchParams.get("filter.term"));
        throw new Error("temporary product search outage");
      }
      throw new Error(`unexpected fetch: ${target}`);
    },
  });
  check(
    failedSearchQueries.length >= 1 && failedSearchQueries.every((term) => term === "turmeric paste") && failedSearch.payload.partial === true &&
      failedSearch.payload.failures.some((entry) => entry.item === "turmeric paste at Fry's / Kroger"),
    "a failed live retailer request is surfaced and is not retried as a broader search"
  );

  server.resetGroceryOffers();
  let transient400Attempts = 0;
  const transient400Recovery = await callOffers({ items: ["garam masala"], area: "Tempe, AZ 11115" }, {
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    matcher: { rewriteQueries: async () => ({ ok: true, queries: new Map() }) },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") return response({ access_token: "tok", expires_in: 1800 });
      if (target.includes("/locations?")) return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
      if (target.includes("/products?")) {
        transient400Attempts += 1;
        if (transient400Attempts === 1) return response({ errors: { code: "PRODUCT-4109-400", reason: "Invalid parameters" } }, 400);
        return response({ data: [{
          description: "Spice Islands Garam Masala Seasoning",
          productId: "garam-masala-test",
          items: [{ size: "1.8 oz", price: { regular: 4.29 } }],
        }] });
      }
      throw new Error(`unexpected fetch: ${target}`);
    },
  });
  check(
    transient400Attempts === 2 && transient400Recovery.payload.items[0].status === "offers" &&
      transient400Recovery.payload.items[0].sources.some((source) => source.product === "Spice Islands Garam Masala Seasoning") &&
      transient400Recovery.payload.failures.length === 0,
    "Kroger's transient invalid-parameters response gets one same-query retry before reporting failure"
  );

  server.resetGroceryOffers();
  let unrelated400Attempts = 0;
  const unrelated400 = await callOffers({ items: ["garam masala"], area: "Tempe, AZ 11116" }, {
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") return response({ access_token: "tok", expires_in: 1800 });
      if (target.includes("/locations?")) return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
      if (target.includes("/products?")) {
        unrelated400Attempts += 1;
        return response({ errors: { code: "PRODUCT-4108-400", reason: "Invalid parameters" } }, 400);
      }
      throw new Error(`unexpected fetch: ${target}`);
    },
  });
  check(
    unrelated400Attempts === 1 && unrelated400.payload.items[0].status === "error" && unrelated400.payload.failures.length === 1,
    "other Kroger 400 responses remain terminal without exposing the provider body"
  );

  server.resetGroceryOffers();
  let oversized400Attempts = 0;
  const oversized400 = await callOffers({ items: ["garam masala"], area: "Tempe, AZ 11118" }, {
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") return response({ access_token: "tok", expires_in: 1800 });
      if (target.includes("/locations?")) return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
      if (target.includes("/products?")) {
        oversized400Attempts += 1;
        return response({ errors: { code: "PRODUCT-4109-400", reason: "Invalid parameters", details: "x".repeat(5000) } }, 400);
      }
      throw new Error(`unexpected fetch: ${target}`);
    },
  });
  check(
    oversized400Attempts === 1 && oversized400.payload.items[0].status === "error" && oversized400.payload.failures.length === 1,
    "an oversized Kroger error body is ignored and cannot trigger the transient retry"
  );

  server.resetGroceryOffers();
  const failingRewriteMatcher = {
    rewriteQueries: async () => ({ ok: false, failure: { status: "network-error", message: "rewrite down" } }),
  };
  const fallbackQueries = [];
  const fallbackRecovery = await callOffers({ items: ["baby spinach leave"], area: "Tempe, AZ 11117" }, {
    matcher: failingRewriteMatcher,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: krogerFetch((term) => {
      fallbackQueries.push(term);
      return term === "spinach leave" ? [{ description: "Marketside Baby Spinach", price: 2.99 }] : [];
    }),
  });
  check(
    fallbackQueries.includes("spinach leave") && fallbackRecovery.payload.items[0].sources.some((source) => source.product === "Marketside Baby Spinach") &&
      !fallbackRecovery.payload.failures.some((entry) => /alternate search could not be checked/.test(entry.message || "")),
    "a failed model rewrite still allows the generic fallback query to return a verified live source"
  );

  server.resetGroceryOffers();
  const turmericFallbackQueries = [];
  let turmericFallbackMatchCalls = 0;
  const turmericFallback = await callOffers({ items: ["turmeric paste"], area: "Tempe, AZ 11118" }, {
    aldiPages: false,
    matcher: {
      rewriteQueries: async () => ({ ok: false, failure: { status: "timeout", message: "rewrite timed out" } }),
      match: async () => { turmericFallbackMatchCalls += 1; return { ok: true, selected: new Map() }; },
    },
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: krogerFetch((term) => {
      turmericFallbackQueries.push(term);
      if (term === "paste") return [
        { description: "Kroger Tomato Paste", price: 0.99 },
        { description: "Boudreaux's Butt Paste Max Strength Diaper Rash Cream Ointment", price: 6.99 },
      ];
      if (term === "turmeric") return [
        { description: "Kroger Ground Turmeric Shaker", price: 1.19 },
        { description: "Gourmet Garden Ginger Stir-In Paste", price: 2.99 },
      ];
      return [];
    }),
  });
  check(
    turmericFallbackQueries.join(",") === "turmeric paste,turmeric" && turmericFallbackMatchCalls === 0 &&
      turmericFallback.payload.items[0].status === "no-local-price" && turmericFallback.payload.items[0].sources.length === 0 &&
      turmericFallback.payload.failures.length === 0,
    "a failed rewrite falls back with the ingredient intact and reports no price when only separate turmeric and paste products exist"
  );

  server.resetGroceryOffers();
  const acceptableBrandMatcher = {
    match: async (pairs) => ({ ok: true, selected: new Map(pairs.map((pair) => [pairKey(pair.item, pair.chain), pair.candidates])) }),
  };
  const multipleAccepted = await callOffers({ items: ["chickpeas"], area: "Tempe, AZ 11116" }, {
    matcher: acceptableBrandMatcher,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: krogerFetch(() => [
      { description: "Goya Garbanzo Beans, 15 oz", price: 1.59 },
      { description: "Great Value Garbanzo Beans, 15 oz", price: 1.19 },
    ]),
  });
  check(
    multipleAccepted.payload.items[0].sources.filter((source) => source.chain === "frys").length === 2 &&
      multipleAccepted.payload.storeEstimates.find((estimate) => estimate.chain === "frys")?.lines[0].price === 1.19,
    "verified live candidates can retain multiple brands and total the cheapest accepted store price"
  );

  server.resetGroceryOffers();
  let delayedMatcherCalls = 0;
  const delayedMatcher = {
    rewriteQueries: async (items) => ({ ok: true, queries: new Map(items.map((item) => [item, "chickpeas"])) }),
    match: async (pairs, limits) => {
      delayedMatcherCalls += 1;
      assert(limits.maxDurationMs > 0, "retailer waiting time does not consume the separate AI-call budget");
      return { ok: true, selected: new Map(pairs.map((pair) => [pairKey(pair.item, pair.chain), pair.candidates])) };
    },
  };
  const delayedStartedAt = Date.now();
  const delayedRetailerResult = await callOffers({ items: ["garbanzo beans"], area: "Tempe, AZ 11115" }, {
    aldiPages: true,
    matcher: delayedMatcher,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url, options) => {
      if (String(url) === "https://www.aldi.us/store/aldi/s?k=aldi") {
        await new Promise((resolve) => setTimeout(resolve, 4700));
        return { ok: true, status: 200, headers: { getSetCookie: () => [] }, text: async () => ALDI_SHOP_HTML };
      }
      if (String(url) === "https://www.aldi.us/graphql") {
        const request = JSON.parse(options.body);
        if (request.operationName === "SearchResultsPlacements") return response({ data: { searchResultsPlacements: { placements: [] } } });
      }
      const target = String(url);
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") return response({ access_token: "tok", expires_in: 1800 });
      if (target.includes("/locations?")) return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
      if (target.includes("/products?")) return response({ data: [{
        description: "Great Value Chickpeas, 15 oz", productId: "delayed-chickpeas",
        items: [{ size: "15 oz", price: { regular: 1.24 } }],
      }] });
      throw new Error(`unexpected fetch: ${target}`);
    },
  });
  check(
    Date.now() - delayedStartedAt >= 4500 && delayedMatcherCalls === 1 && delayedRetailerResult.payload.items[0].sources.some((source) => source.chain === "frys"),
    "a slow ALDI response does not exhaust model time for an unresolved Fry's candidate"
  );

  // ---------- ALDI storefront GraphQL ----------
  server.resetGroceryOffers();
  const aldiCounters = {};
  const aldiTest = await callOffers({ items: ["bananas", "rice"], area: "Tempe, AZ 85281" }, {
    aldiPages: true,
    fetchImpl: aldiFetch(aldiCounters),
  });
  const aldiEstimate = aldiTest.payload.storeEstimates.find((estimate) => estimate.chain === "aldi");
  const aldiSource = aldiTest.payload.items[0].sources.find((source) => source.chain === "aldi");
  check(aldiEstimate?.itemCount === 2 && aldiEstimate.requestedCount === 2, "ALDI joins Fry's in the ballpark when its storefront API is enabled");
  check(aldiSource?.price === 0.46 && aldiSource.qualifier === "per lb" && aldiSource.retailer === "ALDI", "a weight-priced ALDI item prefers the per-pound unit price");
  check(aldiSource?.scope === "store-api", "ALDI API results carry the store price scope");
  check(aldiEstimate.lines.find((line) => line.item === "rice")?.price === 2.95 && aldiEstimate.lines.find((line) => line.item === "rice")?.origin === "store-api", "a packaged ALDI product uses the API price");
  check(aldiCounters.pageFetches === 1 && aldiCounters.graphqlCalls === 4, "ALDI search and items share one guest session across both items");

  server.resetGroceryOffers();
  const aldiBroken = await callOffers({ items: ["bananas"] }, {
    aldiPages: true,
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

  for (const [label, payloadOverrides] of [
    ["GraphQL errors", { search: { errors: [{ message: "mock GraphQL failure" }] } }],
    ["missing search data", { search: {} }],
    ["missing item data", { items: {} }],
  ]) {
    server.resetGroceryOffers();
    const aldiGraphqlBroken = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, {
      aldiPages: true,
      fetchImpl: aldiFetch({}, payloadOverrides),
    });
    check(
      aldiGraphqlBroken.payload.failures.some((entry) => entry.item === "bananas at ALDI" && /unavailable/.test(entry.message)),
      `an ALDI ${label} response is reported as a chain failure`
    );
  }

  server.resetGroceryOffers();
  const emptyAldiCalls = {};
  const emptyAldiFetch = aldiFetch(emptyAldiCalls, {
    search: { data: { searchResultsPlacements: { placements: [] } } },
  });
  const emptyAldi = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, {
    aldiPages: true,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") return response({ access_token: "tok", expires_in: 1800 });
      if (target.includes("/locations?")) return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
      if (target.includes("/products?")) return response({ data: [] });
      return emptyAldiFetch(url, options);
    },
  });
  check(
    emptyAldi.payload.partial === false && emptyAldi.payload.failures.length === 0 &&
      emptyAldi.payload.items[0].status === "no-local-price" &&
      emptyAldi.payload.storeEstimates.find((estimate) => estimate.chain === "aldi")?.missing.includes("bananas") &&
      emptyAldiCalls.graphqlCalls === 1,
    "an ALDI search with a valid empty placements array remains a genuine no-result response"
  );

  // ---------- Kroger API for Fry's ----------
  server.resetGroceryOffers();
  const krogerCalls = { token: 0, locations: 0, products: 0 };
  const krogerTest = await callOffers({ items: ["bananas", "rice"], area: "Tempe, AZ 85281" }, {
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
  let matcherCalls = 0;
  let matcherPairCount = 0;
  let matcherNeedCount = 0;
  const fiveNeedMatcher = {
    match: async (pairs) => {
      matcherCalls += 1;
      matcherPairCount = pairs.length;
      matcherNeedCount = new Set(pairs.map((pair) => pair.item)).size;
      const selected = new Map(pairs.map((pair) => [`${pair.item}\u0000${pair.chain}`, pair.candidates]));
      return { ok: true, selected };
    },
  };
  const fiveNeeds = ["item alpha", "item bravo", "item charlie", "item delta", "item echo"];
  const fiveNeedResult = await callOffers({ items: fiveNeeds, area: "Tempe, AZ 11112" }, {
    matcher: fiveNeedMatcher,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: krogerFetch(() => [{ description: "Retail Product Mystery", price: 1.25 }]),
  });
  check(
    matcherCalls === 1 && matcherPairCount === 5 && matcherNeedCount === 5 &&
      fiveNeedResult.payload.items.every((item) => item.sources.some((source) => source.chain === "frys")),
    "all unresolved pairs for five needs reach one matcher call for bounded internal waves"
  );

  server.resetGroceryOffers();
  const noKroger = await callOffers({ items: ["bananas"] }, { fetchImpl: async () => { throw new Error("no network expected"); } });
  check(
    noKroger.payload.failures.some((entry) => entry.item === "bananas at Fry's / Kroger" && /Kroger API credentials/.test(entry.message)),
    "Fry's without credentials reports the missing configuration instead of a web-search price"
  );

  // ---------- the assembled response ----------
  server.resetGroceryOffers();
  const combined = await callOffers({ items: ["bananas", "rice"], area: "Tempe, AZ 85281" }, {
    aldiPages: true,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url, options) => aldiFetch({})(url, options),
  });
  // With the Kroger mock absent above, this call only asserts the response
  // shape around the adapters that were mocked.
  check(combined.payload.ok === true, "the assembled response stays ok while individual chains fail");

  server.resetGroceryOffers();
  const cacheOptions = {
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") return response({ access_token: "tok", expires_in: 1800 });
      if (target.includes("/locations?")) return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
      if (target.includes("/products?")) return response({ data: [{ description: "Fresh Banana, Each", productId: "0001", items: [{ size: "1 lb", price: { regular: 0.55 } }] }] });
      throw new Error(`unexpected fetch: ${target}`);
    },
  };
  const cachedRun = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, {
    ...cacheOptions,
  });
  const cachedRunAgain = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, {
    ...cacheOptions,
    fetchImpl: async () => { throw new Error("no network expected"); },
  });
  check(
    cachedRun.payload.partial === false && cachedRun.payload.cache.misses === 1 && cachedRunAgain.payload.cache.hits >= 1 && cachedRunAgain.payload.items[0].cached === true,
    "an identical request is served from the six-hour item cache"
  );
  check(cachedRunAgain.payload.note === "Live store prices. Pickup availability and final checkout totals unverified.", "a result keeps the live-price caveat");

  server.resetGroceryOffers();
  let transientAldiCalls = 0;
  const transientKrogerCalls = { products: 0 };
  const transientOptions = {
    aldiPages: true,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target === "https://www.aldi.us/store/aldi/s?k=aldi") {
        transientAldiCalls++;
        if (transientAldiCalls === 1) throw new Error("temporary ALDI outage");
        return { ok: true, status: 200, headers: { getSetCookie: () => [] }, text: async () => ALDI_SHOP_HTML };
      }
      if (target === "https://www.aldi.us/graphql") {
        const request = JSON.parse(options.body);
        if (request.operationName === "SearchResultsPlacements") return response({ data: { searchResultsPlacements: { placements: [] } } });
      }
      if (target === "https://api.kroger.com/v1/connect/oauth2/token") return response({ access_token: "tok", expires_in: 1800 });
      if (target.includes("/locations?")) return response({ data: [{ locationId: "66000124", chain: "FRYS" }] });
      if (target.includes("/products?")) {
        transientKrogerCalls.products++;
        return response({ data: [{ description: "Fresh Banana", productId: "0001", items: [{ size: "1 lb", price: { regular: 0.55 } }] }] });
      }
      throw new Error(`unexpected fetch: ${target}`);
    },
  };
  const transientFailure = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, transientOptions);
  const transientRetry = await callOffers({ items: ["bananas"], area: "Tempe, AZ 85281" }, transientOptions);
  check(
    transientFailure.payload.partial === true && transientRetry.payload.partial === false &&
      transientAldiCalls === 2 && transientKrogerCalls.products === 2 && transientRetry.payload.items[0].cached !== true,
    "an item with one adapter failure is searched again instead of freezing the partial result for six hours"
  );

  server.resetGroceryOffers();
  let aiFailureAttempts = 0;
  const aiRetryCalls = { products: 0 };
  const aiRetryMatcher = {
    match: async (pairs) => {
      aiFailureAttempts += 1;
      if (aiFailureAttempts === 1) return { ok: false, failure: { status: 429, message: "Grocery model rate limited." } };
      return { ok: true, selected: new Map(pairs.map((pair) => [pairKey(pair.item, pair.chain), pair.candidates])) };
    },
  };
  const aiRetryOptions = {
    matcher: aiRetryMatcher,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: krogerFetch(() => [{ description: "Garbanzo Beans, 15 oz", price: 1.55 }], aiRetryCalls),
  };
  const aiTransientFailure = await callOffers({ items: ["chickpeas"], area: "Tempe, AZ 11113" }, aiRetryOptions);
  const aiTransientRetry = await callOffers({ items: ["chickpeas"], area: "Tempe, AZ 11113" }, aiRetryOptions);
  check(
    aiTransientFailure.payload.partial === true && aiTransientRetry.payload.partial === false &&
      aiFailureAttempts === 2 && aiRetryCalls.products === 2 && aiTransientRetry.payload.items[0].cached !== true,
    "a transient AI 429 is reported and does not freeze an empty six-hour offer cache"
  );

  server.resetGroceryOffers();
  let abstentionCalls = 0;
  const abstentionRetailerCalls = { products: 0 };
  const abstainingMatcher = {
    match: async () => { abstentionCalls += 1; return { ok: true, selected: new Map() }; },
  };
  const abstentionOptions = {
    matcher: abstainingMatcher,
    kroger: { clientId: "kid", clientSecret: "ksecret" },
    fetchImpl: krogerFetch(() => [{ description: "Garbanzo Beans, 15 oz", price: 1.55 }], abstentionRetailerCalls),
  };
  const abstentionFirst = await callOffers({ items: ["chickpeas"], area: "Tempe, AZ 11114" }, abstentionOptions);
  const abstentionSecond = await callOffers({ items: ["chickpeas"], area: "Tempe, AZ 11114" }, abstentionOptions);
  check(
    abstentionFirst.payload.items[0].status === "no-local-price" && abstentionFirst.payload.items[0].sources.length === 0 &&
      abstentionFirst.payload.failures.length === 0 && abstentionSecond.payload.cache.hits === 1 &&
      abstentionSecond.payload.items[0].cached === true && abstentionCalls === 1 && abstentionRetailerCalls.products === 1,
    "a valid model abstention stays unpriced without a failure and is cached for the offer window"
  );

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
