const assert = require("assert");
const { client } = require("./test-fixes");

async function run() {
  let count = 0;
  const check = (condition, message) => {
    assert(condition, message);
    count += 1;
    console.log(`compare ui ok - ${message}`);
  };

  const frontend = client();
  const render = (estimates, failures = []) => {
    frontend.context.renderLiveComparison({ area: "Tempe, AZ 85281", estimates, failures });
    return frontend.node("groceryResults").innerHTML;
  };
  const walmartLine = (overrides = {}) => ({
    item: "rice",
    price: 3.99,
    product: "Great Value Rice, 2 lb",
    origin: "advertised",
    scope: "retailer-advertised",
    ...overrides,
  });

  let html = render([
    {
      chain: "walmart",
      label: "Walmart",
      total: 5.19,
      advertisedCount: 2,
      itemCount: 2,
      requestedCount: 2,
      missing: [],
      complete: true,
      cheapest: true,
      lines: [
        walmartLine(),
        { item: "bananas", price: 1.2, product: "Marketside Bananas, Bunch", origin: "weekly-ad", scope: "weekly-ad", validTo: "2026-09-15T23:59:59-04:00" },
      ],
    },
    {
      chain: "frys",
      label: "Fry's / Kroger",
      total: 4.45,
      advertisedCount: 1,
      itemCount: 1,
      requestedCount: 2,
      missing: ["beans"],
      complete: false,
      lines: [{ item: "rice", price: 4.45, product: "Kroger Long Grain Rice", origin: "store-api", scope: "store-api" }],
    },
  ]);
  check(html.includes("Where to buy this list") && html.includes("CHEAPEST LIVE BALLPARK") && html.includes("$5.19") && html.includes("$4.45"), "the compare lists ranked stores with their live ballpark totals");
  check(html.includes("Great Value Rice, 2 lb") && html.includes("advertised web price") && html.includes("weekly ad through") && html.includes("store price"), "breakdown lines name their price origin and weekly-ad window");
  check(html.includes("No live price found: beans"), "a partial store names every item it could not price");

  html = render([
    { chain: "aldi", label: "ALDI", total: 8, advertisedCount: 2, itemCount: 2, requestedCount: 3, missing: ["beans"], complete: false, cheapest: true, lines: [walmartLine({ price: 4 }), walmartLine({ item: "bananas", price: 4 })] },
    { chain: "kroger", label: "Fry's / Kroger", total: 0.5, advertisedCount: 1, itemCount: 1, requestedCount: 3, missing: ["bananas", "beans"], complete: false, lines: [walmartLine({ price: 0.5 })] },
  ]);
  check(html.includes("BEST LIVE BALLPARK SO FAR") && html.indexOf("$8.00") < html.indexOf("$0.50"), "a partial winner is labeled best so far and outranks a cheaper single-item partial");

  frontend.run("state.constraints.budget = 10;");
  const complete = [{ chain: "walmart", label: "Walmart", total: 8.5, advertisedCount: 1, itemCount: 1, requestedCount: 1, missing: [], complete: true, cheapest: true, lines: [walmartLine({ price: 8.5 })] }];
  html = render(complete);
  check(html.includes("$1.50") && html.includes("under your") && html.includes("$10.00 budget at Walmart"), "the budget compares against the cheapest complete live ballpark");
  frontend.run("state.constraints.budget = 5;");
  html = render(complete);
  check(html.includes("$3.50") && html.includes("over your $5.00 budget"), "an over-budget ballpark is stated plainly");
  frontend.run("state.constraints.budget = 20;");

  html = render([{ chain: "evil", label: "<img src=x onerror=alert(1)>", total: 1, advertisedCount: 1, itemCount: 1, requestedCount: 1, missing: [], complete: true, cheapest: true, lines: [walmartLine({ item: "<script>alert(1)</script>", product: "<img src=x>" })] }]);
  check(!html.includes("<img") && !html.includes("<script"), "store and line text is escaped");

  html = render(complete, [{ item: "bananas", message: "No live price was found." }]);
  check(html.includes("Bananas: No live price was found."), "chain failures are listed under the results");

  const mergedEstimates = frontend.context.mergeStoreEstimates([
    { storeEstimates: [{ chain: "walmart", label: "Walmart", lines: [{ item: "rice", price: 3.99, product: "Rice" }], missing: ["beans"], branch: null }] },
    { storeEstimates: [{ chain: "walmart", label: "Walmart", lines: [{ item: "beans", price: 0.99, product: "Beans" }], missing: [], branch: null }] },
  ], ["rice", "beans"]);
  check(mergedEstimates.length === 1 && mergedEstimates[0].total === 4.98 && mergedEstimates[0].complete === true && mergedEstimates[0].itemCount === 2, "batched store estimates merge into one complete total");

  frontend.run('state = clone(DEFAULT_STATE); state.groceryList = [{name:"eggs",qty:1}]; renderGroceryList();');
  frontend.node("offerAreaInput").value = "Tempe, AZ 85281";
  let compareRequest;
  frontend.context.fetch = (url, options) => {
    compareRequest = { url, body: JSON.parse(options.body) };
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, area: "Tempe, AZ 85281", failures: [], storeEstimates: [{ chain: "walmart", label: "Walmart", total: 1.64, advertisedCount: 1, itemCount: 1, requestedCount: 1, missing: [], complete: true, lines: [walmartLine({ item: "eggs", price: 1.64, product: "Great Value Large White Eggs, 12 Count" })] }] }) });
  };
  await frontend.context.compareStores();
  check(compareRequest.url === "/api/grocery/offers" && compareRequest.body.items.join(",") === "eggs" && compareRequest.body.area === "Tempe, AZ 85281" && !Object.prototype.hasOwnProperty.call(compareRequest.body, "lat"), "the compare runs live store searches with the typed area and no device coordinates");
  check(frontend.node("groceryResults").innerHTML.includes("CHEAPEST LIVE BALLPARK") && frontend.node("groceryResults").innerHTML.includes("$1.64"), "the compare renders the live store ballpark");

  let release;
  frontend.context.fetch = () => new Promise((resolve) => { release = resolve; });
  const stale = frontend.context.compareStores();
  frontend.node("groceryList").handlers.click({ target: { closest: () => ({ dataset: { index: "0", groceryAction: "more" } }) } });
  const staleMessage = frontend.node("groceryResults").innerHTML;
  release({ ok: true, status: 200, json: async () => ({ ok: true, area: "Tempe, AZ 85281", failures: [], storeEstimates: [{ chain: "walmart", label: "Walmart", total: 9.99, advertisedCount: 1, itemCount: 1, requestedCount: 1, missing: [], complete: true, lines: [walmartLine({ price: 9.99 })] }] }) });
  await stale;
  check(frontend.node("groceryResults").innerHTML === staleMessage && !frontend.node("groceryResults").innerHTML.includes("$9.99"), "a comparison for an edited list cannot replace the current results");

  frontend.node("offerAreaInput").value = "Phoenix, AZ 85004";
  frontend.node("offerAreaInput").handlers.input({});
  check(frontend.node("groceryResults").innerHTML.includes("Search area changed"), "changing the search area clears stale comparison results");

  return count;
}

module.exports = run;
if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
