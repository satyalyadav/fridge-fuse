// FridgeFuse v0 — hackathon prototype backend.
// Mobile web frontend (public/) + backend proxy that holds VOYAGER_KEY,
// calls ASU AIR Voyager (OpenAI-compatible) and serves Tempe 85281 mock prices.
// Every external call failure is logged AND surfaced to the client.

try {
  require("dotenv").config();
} catch {
  // dotenv is optional — without it, env vars must be exported manually.
}

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const AIR_BASE = (process.env.ASU_AIR_BASE_URL || "https://openai.rc.asu.edu/v1").replace(/\/$/, "");
const AIR_KEY = process.env.VOYAGER_KEY || "";
const DEFAULT_AIR_MODEL = "llama4-scout-17b";
const AIR_MODEL = process.env.ASU_AIR_MODEL || DEFAULT_AIR_MODEL;
const AIR_VISION_MODEL = process.env.ASU_AIR_VISION_MODEL || "qwen3-vl-32b-instruct";
const AIR_VISION_VERIFY_MODEL = process.env.ASU_AIR_VISION_VERIFY_MODEL || AIR_MODEL;

// Fallback pack price for items outside the mock catalog (e.g. free-form AI
// output). Named so a made-up price is easy to find and replace with live data.
const FALLBACK_PACK_PRICE = 3.99;
const FALLBACK_STORE = "walmart";

function asStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

function asDinners(value, fallback = 3) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, n), 7);
}

function asPositiveNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "12mb" }));

// Body-parser failures default to an HTML error page, which every fetch() in
// the UI would then choke on while parsing. Answer in JSON like every route.
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, failure: { message: "Request body must be valid JSON." } });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ ok: false, failure: { message: "Request body is too large (12mb limit)." } });
  }
  return next(err);
});

// Basic hygiene headers (no extra dependency). Skips CSP on purpose: the UI
// loads Google Fonts, and a strict policy would break them on stage.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  // geolocation=(self): the Groceries tab needs the browser location API to
  // rank nearby stores. Anything stricter disables it with no console error.
  res.setHeader("Permissions-Policy", "microphone=(), geolocation=(self)");
  next();
});

// ---------- failure reporting (user requirement: report API failures) ----------
const failures = [];
// Local file backup so history survives restarts. Best-effort on purpose:
// serverless functions have an ephemeral filesystem, so a failed write just
// falls back to the in-memory list + console.error (captured in provider logs).
const FAILURE_LOG_PATH = path.join(__dirname, "failures.log");
function appendFailureLog(entry) {
  try {
    if (fs.existsSync(FAILURE_LOG_PATH) && fs.statSync(FAILURE_LOG_PATH).size > 512 * 1024) {
      const lines = fs.readFileSync(FAILURE_LOG_PATH, "utf8").split("\n").slice(-200);
      fs.writeFileSync(FAILURE_LOG_PATH, lines.join("\n"));
    }
    fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Ephemeral/read-only FS (e.g. Netlify) — memory + console carry it.
  }
}
function reportFailure(provider, operation, details) {
  const entry = {
    time: new Date().toISOString(),
    provider,
    operation,
    ...details,
  };
  failures.push(entry);
  if (failures.length > 100) failures.shift();
  appendFailureLog(entry);
  console.error(`[FAIL] ${entry.time} ${provider}/${operation}:`, JSON.stringify(details));
  return entry;
}

async function airChat(messages, { maxTokens = 1200, wantJson = true, model = AIR_MODEL } = {}) {
  // Returns { ok:true, data } or { ok:false, failure }
  if (!AIR_KEY) {
    const f = reportFailure("asu-air", "chat", {
      status: "no-key",
      message: "VOYAGER_KEY not set — running in MOCK mode.",
      model,
      hint: "export VOYAGER_KEY=... to go live.",
    });
    return { ok: false, failure: f, mock: true };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const body = { model, messages, max_tokens: maxTokens };
    if (wantJson) body.response_format = { type: "json_object" };
    const r = await fetch(`${AIR_BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AIR_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      const f = reportFailure("asu-air", "chat", {
        status: r.status,
        message: `AIR chat failed: HTTP ${r.status}`,
        model,
        responseSnippet: text.slice(0, 500),
        hint: "Check key, model id, and https://docs.rc.asu.edu status.",
      });
      return { ok: false, failure: f };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const f = reportFailure("asu-air", "chat", {
        status: "bad-json-envelope",
        message: `AIR returned non-JSON envelope: ${e.message}`,
        responseSnippet: text.slice(0, 500),
      });
      return { ok: false, failure: f };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    const f = reportFailure("asu-air", "chat", {
      status: e.name === "AbortError" ? "timeout" : "network-error",
      message: `AIR request failed: ${e.message} (note: AIR output tok/sec can be slow)`,
      model,
    });
    return { ok: false, failure: f };
  } finally {
    clearTimeout(t);
  }
}

function extractJson(content) {
  // Model sometimes wraps JSON in fences — be liberal.
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : content).trim();
  return JSON.parse(raw);
}

// ---------- data files (work both locally and from the Netlify task root) ----------
function resolveDataPath(runtimeDir = __dirname, taskRoot = process.env.LAMBDA_TASK_ROOT, exists = fs.existsSync, filename = "prices.json") {
  const candidates = [path.join(runtimeDir, "data", filename)];
  if (taskRoot) candidates.push(path.join(taskRoot, "data", filename));
  return candidates.find((candidate) => exists(candidate)) || candidates[0];
}

const PRICES = JSON.parse(fs.readFileSync(resolveDataPath(), "utf8"));

// ---------- approved recipe sources (grounds AI meal generation) ----------
// The /api/plan system prompt is built from this list: the model may only
// pull, adapt, or cite recipes from these sources.
const RECIPE_SOURCES = JSON.parse(fs.readFileSync(resolveDataPath(__dirname, process.env.LAMBDA_TASK_ROOT, fs.existsSync, "recipe-sources.json"), "utf8"));
if (!Array.isArray(RECIPE_SOURCES.sources) || RECIPE_SOURCES.sources.length === 0) {
  throw new Error("data/recipe-sources.json must contain a non-empty sources array");
}
for (const source of RECIPE_SOURCES.sources) {
  if (!source || typeof source.name !== "string" || !source.name.trim() || typeof source.url !== "string" || !/^https?:\/\//.test(source.url)) {
    throw new Error("every approved recipe source needs a name and http(s) URL");
  }
}

function recipeSourcesContext() {
  return RECIPE_SOURCES.sources
    .map((source) => `- ${source.name} — ${source.url} (${source.focus || "approved recipe source"})`)
    .join("\n");
}

function isApprovedRecipeCitation(source, sourceUrl) {
  return RECIPE_SOURCES.sources.some((approved) => approved.name === source && approved.url === sourceUrl);
}

const FALLBACK_RECIPE_SOURCE = RECIPE_SOURCES.sources.find(
  (source) => source.name === "FridgeFuse Demo Catalog" && source.url === "https://github.com/satyalyadav/fridge-fuse"
);
if (!FALLBACK_RECIPE_SOURCE) {
  throw new Error("data/recipe-sources.json must include the FridgeFuse Demo Catalog fallback source");
}
const STORES = Object.keys(PRICES.stores);
// Typed words a student uses -> catalog item ("cheese" -> "cheddar"). Lives in
// the data file so the UI can fetch it instead of keeping a second copy.
const ITEM_ALIASES = PRICES.aliases || {};

// ---------- store branch locations (approximate dev mock, Tempe 85281) ----------
const STORE_DATA = JSON.parse(
  fs.readFileSync(resolveDataPath(__dirname, process.env.LAMBDA_TASK_ROOT, fs.existsSync, "stores.json"), "utf8")
);
// Only branches whose chain has a price list are usable — a typo in the data
// would otherwise surface as a store with no prices instead of a loud failure.
const BRANCHES = (STORE_DATA.branches || []).filter(
  (branch) => branch && PRICES.stores[branch.chain] && Number.isFinite(branch.lat) && Number.isFinite(branch.lng)
);
if (BRANCHES.length !== (STORE_DATA.branches || []).length) {
  console.error(`[WARN] stores.json: ${(STORE_DATA.branches || []).length - BRANCHES.length} branch(es) dropped (unknown chain or bad coordinates)`);
}
// Where distances are measured from when the browser gives us nothing usable.
// Taken from stores.json; if that has no origin, it is derived from the mean of
// the loaded branches so no place name or coordinate is baked into this file.
const DEFAULT_ORIGIN = (() => {
  const origin = STORE_DATA.origin || {};
  const lat = Number(origin.lat);
  const lng = Number(origin.lng);
  if (isValidCoordinate(lat, lng)) {
    return { lat, lng, label: origin.label || `the ${STORE_DATA.zip || "local"} area` };
  }
  if (!BRANCHES.length) return { lat: 0, lng: 0, label: "the store area" };
  const mean = (pick) => BRANCHES.reduce((total, branch) => total + branch[pick], 0) / BRANCHES.length;
  return { lat: mean("lat"), lng: mean("lng"), label: `the ${STORE_DATA.zip || "local"} store area` };
})();

function findPrice(itemName) {
  const q = itemName.toLowerCase();
  const hit = PRICES.items.find(
    (it) => it.name.toLowerCase() === q || it.name.toLowerCase().includes(q) || q.includes(it.name.toLowerCase())
  );
  return hit || null;
}
function cheapestPack(itemName) {
  const hit = findPrice(itemName);
  if (!hit) return null;
  let best = null;
  for (const [store, pack] of Object.entries(hit.prices)) {
    if (!best || pack.price < best.packPrice) {
      best = { item: hit.name, unit: hit.unit, store, pack: pack.pack, packPrice: pack.price };
    }
  }
  return best;
}

// ---------- grocery cart optimizer (deterministic, offline, no API key) ----------
const EARTH_RADIUS_MI = 3958.7613;
const MAX_CART_ITEMS = 50;
const MAX_ITEM_QTY = 99;
const DEFAULT_MAX_DISTANCE_MI = 15;

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  // asin clamped: floating point can push a past 1 for antipodal points.
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0); // null island means "no fix", not the Atlantic
}

// Exact name -> alias table -> the looser substring match findPrice already does.
function resolveCatalogItem(name) {
  const q = String(name ?? "").trim().toLowerCase();
  if (!q) return null;
  const exact = PRICES.items.find((item) => item.name.toLowerCase() === q);
  if (exact) return exact;
  const aliased = ITEM_ALIASES[q];
  if (aliased) {
    const hit = PRICES.items.find((item) => item.name.toLowerCase() === String(aliased).toLowerCase());
    if (hit) return hit;
  }
  return findPrice(q);
}

// Accepts ["eggs"] or [{name, qty}]. Merges duplicates, clamps quantities, and
// keeps anything the catalog does not know in `unmatched` rather than guessing
// a price for it.
function normalizeCartItems(rawItems) {
  const merged = new Map();
  const unmatched = [];
  for (const raw of rawItems.slice(0, MAX_CART_ITEMS)) {
    const isObject = raw !== null && typeof raw === "object";
    const label = String((isObject ? raw.name : raw) ?? "").trim();
    if (!label) continue;
    const qty = Math.min(
      Math.max(1, Math.floor(asPositiveNumber(isObject ? raw.qty : 1, 1)) || 1),
      MAX_ITEM_QTY
    );
    const match = resolveCatalogItem(label);
    if (!match) {
      if (!unmatched.includes(label)) unmatched.push(label);
      continue;
    }
    const existing = merged.get(match.name);
    if (existing) existing.qty = Math.min(existing.qty + qty, MAX_ITEM_QTY);
    else merged.set(match.name, {
      item: match.name,
      unit: match.unit,
      qty,
      requestedAs: label,
      prices: match.prices,
    });
  }
  return { resolved: [...merged.values()], unmatched };
}

// Describes where a coordinate is using only data we already ship: the branch
// list and the origin in stores.json. Nothing here is a hardcoded place string,
// so editing stores.json changes what users are told.
function describeLocation(lat, lng) {
  if (!isValidCoordinate(Number(lat), Number(lng))) return null;
  const references = [
    ...BRANCHES.map((branch) => ({ label: branch.area || branch.name, lat: branch.lat, lng: branch.lng })),
    { label: DEFAULT_ORIGIN.label, lat: DEFAULT_ORIGIN.lat, lng: DEFAULT_ORIGIN.lng },
  ];
  let nearest = null;
  for (const reference of references) {
    const distanceMi = haversineMiles(Number(lat), Number(lng), reference.lat, reference.lng);
    if (!nearest || distanceMi < nearest.distanceMi) nearest = { ...reference, distanceMi };
  }
  if (!nearest) return null;
  const miles = +nearest.distanceMi.toFixed(2);
  // Wording tracks the measured distance rather than a fixed phrase.
  const text = miles <= 0.3
    ? `At ${nearest.label}`
    : miles <= 3
      ? `${miles} mi from ${nearest.label}`
      : `${Math.round(miles)} mi from ${DEFAULT_ORIGIN.label}`;
  return { text, nearest: nearest.label, distanceMi: miles, source: "local-store-data" };
}

// Reverse geocoding through OpenStreetMap Nominatim. Kept server-side so the
// User-Agent follows their usage policy and the browser never hits CORS. Only
// ever called when the client passes explicit consent.
const NOMINATIM_MIN_INTERVAL_MS = 1100; // their policy allows ~1 request/second
let lastNominatimAt = 0;

// Shared plumbing for every Nominatim call: the policy throttle, the required
// User-Agent, a timeout, and the same failure reporting as other externals.
async function nominatimRequest(operation, query) {
  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/${query}`, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FridgeFuse/0.1 (ASU AIR Spark Challenge student prototype)",
        "Accept-Language": "en",
        Accept: "application/json",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, failure: reportFailure("nominatim", operation, {
        status: response.status, message: `Nominatim ${operation} failed: HTTP ${response.status}`,
        responseSnippet: text.slice(0, 200),
      }) };
    }
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, failure: reportFailure("nominatim", operation, {
      status: e.name === "AbortError" ? "timeout" : "network-error",
      message: `Nominatim ${operation} failed: ${e.message}`,
    }) };
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(lat, lng) {
  // 3 decimals is ~110m: enough for a neighbourhood name, coarser than the fix.
  const roundedLat = Number(lat).toFixed(3);
  const roundedLng = Number(lng).toFixed(3);
  const result = await nominatimRequest("reverse", `reverse?format=jsonv2&zoom=14&lat=${roundedLat}&lon=${roundedLng}`);
  if (!result.ok) return result;
  try {
    const data = result.data;
    const a = data.address || {};
    const locality = a.neighbourhood || a.suburb || a.city || a.town || a.village || a.hamlet || a.county;
    const parts = [locality, a.state_code || a.state, a.postcode].filter(Boolean);
    const placeName = parts.length ? parts.join(", ") : (data.display_name || "").split(",").slice(0, 2).join(",").trim();
    if (!placeName) {
      return { ok: false, failure: reportFailure("nominatim", "reverse", {
        status: "no-name", message: "Reverse geocode returned no usable place name.",
      }) };
    }
    return { ok: true, placeName, precisionNote: "rounded to ~110 m before lookup" };
  } catch (e) {
    return { ok: false, failure: reportFailure("nominatim", "reverse", {
      status: "parse-error", message: `Reverse geocode returned unusable JSON: ${e.message}`,
    }) };
  }
}

// The postal-code counterpart: turns a ZIP into a point to measure from, for a
// user who would rather type five digits than share a live GPS fix. This is the
// network path only — the catalog's own ZIP is short-circuited by the route
// before it ever gets here.
async function geocodePostalCode(postalCode) {
  const zip = String(postalCode ?? "").trim();
  if (!/^\d{5}$/.test(zip)) {
    return { ok: false, failure: { message: "Enter a five-digit ZIP code." } };
  }
  const result = await nominatimRequest("postalcode", `search?format=jsonv2&country=us&limit=1&postalcode=${zip}`);
  if (!result.ok) return result;
  const hit = Array.isArray(result.data) ? result.data[0] : null;
  const lat = Number(hit?.lat);
  const lng = Number(hit?.lon);
  if (!isValidCoordinate(lat, lng)) {
    return { ok: false, failure: reportFailure("nominatim", "postalcode", {
      status: "not-found", message: `No US location found for ZIP ${zip}.`,
    }) };
  }
  return {
    ok: true, lat, lng, source: "nominatim", lookupUsed: true,
    label: (hit.display_name || `ZIP ${zip}`).split(",").slice(0, 2).join(",").trim(),
  };
}

function optimizeCart({ items = [], lat, lng, maxDistanceMi } = {}) {
  const { resolved, unmatched } = normalizeCartItems(Array.isArray(items) ? items : []);
  const userLat = Number(lat);
  const userLng = Number(lng);
  const usedFallbackLocation = !isValidCoordinate(userLat, userLng);
  const origin = usedFallbackLocation
    ? { lat: DEFAULT_ORIGIN.lat, lng: DEFAULT_ORIGIN.lng, label: DEFAULT_ORIGIN.label }
    : { lat: userLat, lng: userLng, label: "your location" };
  const radius = asPositiveNumber(maxDistanceMi, DEFAULT_MAX_DISTANCE_MI) || DEFAULT_MAX_DISTANCE_MI;

  const byDistance = BRANCHES
    .map((branch) => ({ branch, distanceMi: +haversineMiles(origin.lat, origin.lng, branch.lat, branch.lng).toFixed(2) }))
    .sort((a, b) => a.distanceMi - b.distanceMi);

  // An empty result is worse than a slightly-too-far one: widen rather than
  // hand the user a blank screen.
  let inRange = byDistance.filter((entry) => entry.distanceMi <= radius);
  const widenedSearch = inRange.length === 0 && byDistance.length > 0;
  if (widenedSearch) inRange = byDistance.slice(0, 3);

  // Nothing priceable: ranking stores by a $0 basket would be meaningless, so
  // return no options and let `note` explain why.
  const options = (resolved.length === 0 ? [] : inRange).map(({ branch, distanceMi }) => {
    const lineItems = [];
    const missing = [];
    let subtotal = 0;
    for (const entry of resolved) {
      const pack = entry.prices[branch.chain];
      const price = Number(pack?.price);
      if (!pack || !Number.isFinite(price)) {
        missing.push(entry.item); // chain does not stock it
        continue;
      }
      const lineTotal = +(price * entry.qty).toFixed(2);
      subtotal += lineTotal;
      lineItems.push({
        item: entry.item,
        requestedAs: entry.requestedAs,
        qty: entry.qty,
        unit: entry.unit,
        pack: pack.pack,
        packPrice: price,
        lineTotal,
      });
    }
    return {
      storeId: branch.id,
      chain: branch.chain,
      name: branch.name,
      chainLabel: PRICES.stores[branch.chain],
      area: branch.area,
      lat: branch.lat,
      lng: branch.lng,
      approximateLocation: branch.approximate !== false,
      distanceMi,
      missing,
      complete: resolved.length > 0 && missing.length === 0,
      itemCount: lineItems.length,
      subtotal: +subtotal.toFixed(2),
      lineItems,
    };
  });

  // Stores that cover the whole list win; then price; then distance. The id
  // tie-break keeps the order stable for identical branches.
  options.sort((a, b) =>
    Number(b.complete) - Number(a.complete) ||
    a.subtotal - b.subtotal ||
    a.distanceMi - b.distanceMi ||
    a.storeId.localeCompare(b.storeId)
  );
  if (options.length) options[0].best = true;

  const covering = options.filter((option) => option.complete);
  const savingsVsWorst = covering.length > 1
    ? +(covering[covering.length - 1].subtotal - covering[0].subtotal).toFixed(2)
    : 0;

  const notes = [];
  if (!resolved.length && !unmatched.length) notes.push("Add at least one item to compare stores.");
  else if (!resolved.length) notes.push(`None of those items are in the Tempe 85281 mock catalog yet, so there is nothing to price: ${unmatched.join(", ")}.`);
  else if (unmatched.length) notes.push(`Not priced (not in the catalog): ${unmatched.join(", ")}.`);
  if (options.length && widenedSearch) notes.push(`No store within ${radius} miles — showing the ${inRange.length} closest instead.`);
  if (usedFallbackLocation) notes.push(`Distances are measured from ${DEFAULT_ORIGIN.label} because no location was shared.`);

  return {
    origin,
    usedFallbackLocation,
    maxDistanceMi: radius,
    widenedSearch,
    requested: resolved.map(({ prices, ...rest }) => rest),
    unmatched,
    options,
    cheapestStoreId: options[0]?.storeId || null,
    savingsVsWorst,
    zip: PRICES.zip,
    locationNote: STORE_DATA.note,
    priceNote: PRICES.note,
    note: notes.join(" "),
  };
}

// ---------- small, grounded recipe bank for the stable demo planner ----------
const RECIPES = [
  {
    title: "Spinach egg rice bowl",
    needs: ["spinach", "eggs", "rice", "soy sauce"],
    timeMin: 12, protein: 18, carbs: 49, fiber: 5, equip: ["microwave"],
    steps: [
      "Put a handful of spinach in a microwave-safe bowl. Cover loosely and heat for 45 seconds.",
      "Crack in 2 eggs, beat with a fork, and microwave in 30-second bursts. Stir after each burst until the eggs are set.",
      "Add cooked rice and a small splash of soy sauce. Heat for 60 to 90 seconds and stir."
    ]
  },
  {
    title: "Black bean quesadillas",
    needs: ["tortillas", "black beans", "cheddar", "salsa"],
    timeMin: 8, protein: 19, carbs: 47, fiber: 10, equip: ["microwave"],
    steps: [
      "Drain and rinse half the can of beans. Mash them lightly with a fork.",
      "Spread beans and cheddar over 2 tortillas, fold them, and place on a microwave-safe plate.",
      "Heat for 45 seconds at a time until the cheese melts. Let them stand for 1 minute, then add salsa."
    ]
  },
  {
    title: "Loaded potato bowl",
    needs: ["potatoes", "black beans", "cheddar", "salsa"],
    timeMin: 14, protein: 17, carbs: 58, fiber: 11, equip: ["microwave"],
    steps: [
      "Pierce a potato all over with a fork. Microwave for 4 minutes, turn it, then cook 3 to 5 minutes more until soft.",
      "Split the potato carefully. Add the remaining beans and cheddar.",
      "Heat for 45 seconds, then finish with salsa."
    ]
  },
  {
    title: "Peanut butter banana oats",
    needs: ["oats", "peanut butter", "milk", "banana"],
    timeMin: 6, protein: 16, carbs: 58, fiber: 8, equip: ["microwave"],
    steps: [
      "Mix oats and milk in a large microwave-safe bowl.",
      "Microwave for 90 seconds, stir, then heat in 30-second bursts until thick.",
      "Stir in peanut butter and top with sliced banana."
    ]
  },
  {
    title: "Microwave egg and cheese toast",
    needs: ["bread", "eggs", "cheddar"],
    timeMin: 7, protein: 20, carbs: 31, fiber: 3, equip: ["microwave"],
    steps: [
      "Beat 2 eggs in a mug and microwave in 30-second bursts, stirring each time, until set.",
      "Put the eggs and cheddar between 2 slices of bread.",
      "Microwave for 20 seconds to melt the cheese. Let it stand for 1 minute before eating."
    ]
  },
  {
    title: "Cheesy marinara pasta cup",
    needs: ["pasta", "marinara", "cheddar"],
    timeMin: 15, protein: 17, carbs: 61, fiber: 6, equip: ["microwave"],
    steps: [
      "Put pasta in a large microwave-safe bowl and cover it with water by 1 inch.",
      "Microwave in 2-minute bursts, stirring each time, until tender. Drain carefully.",
      "Stir in marinara and cheddar, then heat for 45 seconds."
    ]
  },
  {
    title: "Microwave veggie fried rice",
    needs: ["rice", "eggs", "soy sauce", "frozen peas"],
    timeMin: 12, protein: 15, carbs: 52, fiber: 5, equip: ["microwave"],
    steps: [
      "Heat peas and cooked rice in a large microwave-safe bowl for 90 seconds.",
      "Push the rice aside, add a beaten egg, and microwave for 30 seconds. Stir and repeat until the egg is set.",
      "Mix everything with a small splash of soy sauce."
    ]
  },
  {
    title: "Bean and cheese rice bowl",
    needs: ["rice", "black beans", "cheddar", "salsa"],
    timeMin: 9, protein: 20, carbs: 63, fiber: 12, equip: ["microwave"],
    steps: [
      "Combine cooked rice and drained beans in a microwave-safe bowl.",
      "Microwave for 90 seconds, stir, and check that it is hot throughout.",
      "Add cheddar, heat for 30 seconds, then spoon salsa over the top."
    ]
  },
  {
    title: "Black bean salsa rice bowl",
    needs: ["rice", "black beans", "salsa", "onion"],
    timeMin: 10, protein: 12, carbs: 62, fiber: 13, equip: ["microwave"],
    steps: [
      "Combine cooked rice and drained beans in a microwave-safe bowl.",
      "Microwave for 90 seconds, stir, and heat until steaming.",
      "Top with salsa and diced onion."
    ]
  },
  {
    title: "Marinara veggie pasta cup",
    needs: ["pasta", "marinara", "onion"],
    timeMin: 15, protein: 10, carbs: 64, fiber: 7, equip: ["microwave"],
    steps: [
      "Put pasta in a large microwave-safe bowl and cover it with water by 1 inch.",
      "Microwave in 2-minute bursts, stirring each time, until tender. Drain carefully.",
      "Stir in marinara and diced onion, then heat for 60 seconds."
    ]
  },
  {
    title: "Chicken fried rice",
    needs: ["chicken breast", "rice", "eggs", "soy sauce", "frozen peas", "onion"],
    timeMin: 25, protein: 32, carbs: 48, fiber: 4, equip: ["stove"],
    steps: ["Dice the chicken and onion.", "Cook the chicken fully, then add onion and peas.", "Add rice, egg, and soy sauce. Stir until the egg is set."]
  },
  {
    title: "Chicken tacos",
    needs: ["chicken breast", "tortillas", "onion", "cheddar", "salsa"],
    timeMin: 20, protein: 30, carbs: 40, fiber: 6, equip: ["stove"],
    steps: ["Dice and cook the chicken until no pink remains.", "Warm the tortillas in the same pan.", "Fill with chicken, onion, cheddar, and salsa."]
  }
];

function pantryHas(have, ingredient) {
  return [...have].some((item) => ingredient.includes(item) || item.includes(ingredient));
}

function combinations(items, size, start = 0, picked = [], result = []) {
  if (picked.length === size) {
    result.push([...picked]);
    return result;
  }
  for (let i = start; i <= items.length - (size - picked.length); i++) {
    picked.push(items[i]);
    combinations(items, size, i + 1, picked, result);
    picked.pop();
  }
  return result;
}

function estimatedLeftover(item, uses) {
  const known = {
    "black beans": uses > 1 ? "can used across the plan" : "about half a can",
    bread: "most of the loaf",
    cheddar: uses > 2 ? "about 2 oz" : "about half the block",
    eggs: uses > 2 ? "about 6 eggs" : "most of the dozen",
    "frozen peas": "most of the bag",
    marinara: "about half the jar",
    milk: "most of the gallon",
    oats: "most of the canister",
    pasta: "about half the box",
    "peanut butter": "most of the jar",
    potatoes: "most of the bag",
    rice: "most of the bag",
    salsa: uses > 2 ? "a few spoonfuls" : "about half the jar",
    "soy sauce": "most of the bottle",
    tortillas: uses > 1 ? "about 4 tortillas" : "about 8 tortillas"
  };
  return known[item] || (uses > 1 ? "a little left" : "most of the package");
}

function localPlan({
  pantry = [], dinners = 3, maxTimeMin = 30, equipment = ["stove"], diet = "",
  budget = 30, useSoon = [], exclude = []
}) {
  const pantryList = asStringArray(pantry, []);
  const useSoonList = asStringArray(useSoon, []);
  const excludeList = asStringArray(exclude, []);
  const equipmentList = asStringArray(equipment, []).map((item) => item.toLowerCase());
  const safeEquipment = equipmentList.length ? equipmentList : ["stove"];
  const safeDinners = asDinners(dinners, 3);
  const safeMaxTime = asPositiveNumber(maxTimeMin, 30) || 30;
  const safeBudget = asPositiveNumber(budget, 30);
  const dietStr = typeof diet === "string" ? diet : "";

  const have = new Set(pantryList.map((item) => item.toLowerCase()));
  const urgent = new Set(useSoonList.map((item) => item.toLowerCase()));
  const excluded = new Set(excludeList.map((title) => title.toLowerCase()));
  const dietQ = dietStr.toLowerCase();
  const blockedForVegetarian = new Set(["chicken breast", "ground beef"]);
  const blockedForVegan = new Set([...blockedForVegetarian, "eggs", "milk", "cheddar", "butter", "yogurt"]);
  const blockedForDairyFree = new Set(["milk", "cheddar", "butter", "yogurt"]);
  const blockedForGlutenFree = new Set(["bread", "pasta", "tortillas"]);

  const candidates = RECIPES
    .filter((recipe) => recipe.timeMin <= safeMaxTime)
    .filter((recipe) => recipe.equip.every((item) => safeEquipment.includes(item)))
    .filter((recipe) => !excluded.has(recipe.title.toLowerCase()))
    .filter((recipe) => {
      if (dietQ.includes("vegan") && recipe.needs.some((item) => blockedForVegan.has(item))) return false;
      if (dietQ.includes("vegetarian") && recipe.needs.some((item) => blockedForVegetarian.has(item))) return false;
      if (dietQ.includes("dairy-free") && recipe.needs.some((item) => blockedForDairyFree.has(item))) return false;
      if ((dietQ.includes("gluten-free") || dietQ.includes("gluten free")) && recipe.needs.some((item) => blockedForGlutenFree.has(item))) return false;
      if (dietQ.includes("peanut") && recipe.needs.includes("peanut butter")) return false;
      return true;
    })
    .map((recipe) => ({
      recipe,
      missing: recipe.needs.filter((item) => !pantryHas(have, item)),
      urgentUsed: recipe.needs.filter((item) => urgent.has(item))
    }));

  const planSize = Math.min(safeDinners, candidates.length);
  if (candidates.length === 0 || planSize === 0) {
    return {
      dinners: [],
      shoppingList: [],
      leftovers: [],
      totalCost: 0,
      note: "No recipes match that combination of equipment, time, and diet. Try more time, more equipment, or fewer restrictions.",
    };
  }
  const possiblePlans = combinations(candidates, planSize);
  const evaluated = possiblePlans.map((group) => {
    const missingReferences = group.flatMap((item) => item.missing);
    const uniqueMissing = [...new Set(missingReferences)];
    const cost = uniqueMissing.reduce((total, item) => total + (cheapestPack(item)?.packPrice ?? FALLBACK_PACK_PRICE), 0);
    const urgentCovered = new Set(group.flatMap((item) => item.urgentUsed)).size;
    const sharedUses = missingReferences.length - uniqueMissing.length;
    const pantryUses = group.reduce((total, item) => total + item.recipe.needs.length - item.missing.length, 0);
    const overBudget = Math.max(0, cost - safeBudget);
    const score = overBudget * 1000 + uniqueMissing.length * 18 + cost - urgentCovered * 60 - sharedUses * 12 - pantryUses * 4;
    return { group, cost, score };
  }).sort((a, b) => a.score - b.score);

  const picked = (evaluated[0]?.group || candidates.slice(0, planSize))
    .sort((a, b) => b.urgentUsed.length - a.urgentUsed.length);

  const listMap = {};
  for (const selection of picked) {
    for (const missing of selection.missing) {
      if (!listMap[missing]) {
        const pack = cheapestPack(missing) || { item: missing, store: FALLBACK_STORE, pack: "1 package", packPrice: FALLBACK_PACK_PRICE, estimated: true };
        listMap[missing] = { ...pack, qty: 1, sharedBy: [] };
      }
      if (!listMap[missing].sharedBy.includes(selection.recipe.title)) {
        listMap[missing].sharedBy.push(selection.recipe.title);
      }
    }
  }

  const shoppingList = Object.values(listMap);
  const totalCost = +shoppingList.reduce((total, item) => total + item.packPrice * item.qty, 0).toFixed(2);
  const leftovers = shoppingList.map((item) => ({
    item: item.item,
    amount: estimatedLeftover(item.item, item.sharedBy.length)
  }));

  return {
    dinners: picked.map((selection) => ({
      title: selection.recipe.title,
      timeMin: selection.recipe.timeMin,
      protein: selection.recipe.protein,
      carbs: selection.recipe.carbs,
      fiber: selection.recipe.fiber,
      equip: selection.recipe.equip,
      usesPantry: selection.recipe.needs.filter((item) => !selection.missing.includes(item)),
      needs: selection.missing,
      steps: selection.recipe.steps,
      source: FALLBACK_RECIPE_SOURCE.name,
      sourceUrl: FALLBACK_RECIPE_SOURCE.url
    })),
    shoppingList,
    leftovers,
    totalCost
  };
}

function groundShoppingPlan(plan) {
  const listMap = {};
  for (const dinner of plan.dinners || []) {
    for (const item of dinner.needs || []) {
      const name = String(item).toLowerCase();
      if (!listMap[name]) {
        const pack = cheapestPack(name) || { item: name, store: FALLBACK_STORE, pack: "1 package", packPrice: FALLBACK_PACK_PRICE, estimated: true };
        listMap[name] = { ...pack, qty: 1, sharedBy: [] };
      }
      if (!listMap[name].sharedBy.includes(dinner.title)) listMap[name].sharedBy.push(dinner.title);
    }
  }
  const shoppingList = Object.values(listMap);
  return {
    ...plan,
    shoppingList,
    leftovers: shoppingList.map((item) => ({
      item: item.item,
      amount: estimatedLeftover(item.item, item.sharedBy.length)
    })),
    totalCost: +shoppingList.reduce((total, item) => total + item.packPrice * item.qty, 0).toFixed(2)
  };
}

function parseAiPlan(content, expectedDinners) {
  const plan = extractJson(String(content || ""));
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.dinners)) {
    throw new Error("AI plan must contain a dinners array");
  }
  if (plan.dinners.length !== expectedDinners) {
    throw new Error(`AI plan returned ${plan.dinners.length} dinners; expected ${expectedDinners}`);
  }
  for (const [index, dinner] of plan.dinners.entries()) {
    if (!dinner || typeof dinner !== "object") throw new Error(`Dinner ${index + 1} must be an object`);
    if (typeof dinner.title !== "string" || !dinner.title.trim()) throw new Error(`Dinner ${index + 1} needs a title`);
    if (!Number.isFinite(Number(dinner.timeMin))) throw new Error(`Dinner ${index + 1} needs a numeric timeMin`);
    if (!isApprovedRecipeCitation(dinner.source, dinner.sourceUrl)) {
      throw new Error(`Dinner ${index + 1} needs a source/sourceUrl pair from the approved recipe list`);
    }
    if (dinner.adaptationNote !== undefined && typeof dinner.adaptationNote !== "string") {
      throw new Error(`Dinner ${index + 1} adaptationNote must be a string when present`);
    }
    for (const field of ["usesPantry", "needs", "steps"]) {
      if (!Array.isArray(dinner[field])) throw new Error(`Dinner ${index + 1} needs a ${field} array`);
    }
    if (dinner.steps.length === 0) throw new Error(`Dinner ${index + 1} needs at least one cooking step`);
  }
  return plan;
}

async function repairAiPlan(chat, content, expectedDinners, initialError, requirements) {
  return chat([
    {
      role: "system",
      content: `Repair a malformed FridgeFuse meal-plan response. Reply ONLY with valid JSON containing exactly ${expectedDinners} dinners. Each dinner must have a non-empty title, numeric timeMin, arrays named usesPantry, needs, and steps, and a source/sourceUrl pair matching one of these approved sources:\n${recipeSourcesContext()}\nPreserve the original meal ideas when possible. Do not add commentary or Markdown fences.`
    },
    {
      role: "user",
      content: `Original requirements:\n${requirements}\n\nValidation problem: ${initialError.message}\n\nMalformed response:\n${String(content || "").slice(0, 12000)}`
    }
  ], { maxTokens: 1800 });
}

// ---------- routes ----------
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    airConfigured: !!AIR_KEY,
    airBase: AIR_BASE,
    airModel: AIR_MODEL,
    airVisionModel: AIR_VISION_MODEL,
    airVisionVerifyModel: AIR_VISION_VERIFY_MODEL,
    stores: STORES,
    priceItems: PRICES.items.length,
    storeBranches: BRANCHES.length,
    zip: PRICES.zip,
    failures: failures.length,
  });
});

app.get("/api/models", async (req, res) => {
  if (!AIR_KEY) {
    return res.json({ ok: false, mock: true, failure: reportFailure("asu-air", "models", {
      status: "no-key", message: "VOYAGER_KEY not set.", hint: "export VOYAGER_KEY=...",
    })});
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(`${AIR_BASE}/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${AIR_KEY}` },
    });
    clearTimeout(t);
    const text = await r.text();
    if (!r.ok) {
      return res.json({ ok: false, failure: reportFailure("asu-air", "models", {
        status: r.status, message: `GET /models failed: HTTP ${r.status}`, responseSnippet: text.slice(0, 500),
      })});
    }
    res.json({ ok: true, data: JSON.parse(text) });
  } catch (e) {
    res.json({ ok: false, failure: reportFailure("asu-air", "models", {
      status: e.name === "AbortError" ? "timeout" : "network-error", message: e.message,
    })});
  }
});

function normalizeVisionBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return [0, 0, 1, 1];
  let coords = value.map(Number);
  if (!coords.every(Number.isFinite)) return [0, 0, 1, 1];
  // Qwen-family vision models commonly return coordinates on a 0..1000 grid.
  if (Math.max(...coords.map(Math.abs)) > 1 && Math.max(...coords.map(Math.abs)) <= 1000) {
    coords = coords.map((coord) => coord / 1000);
  }
  const [x1, y1, x2, y2] = coords.map((coord) => Math.min(1, Math.max(0, coord)));
  if (x2 <= x1 || y2 <= y1) return [0, 0, 1, 1];
  return [x1, y1, x2, y2];
}

function isAutoConfirmableVisionBbox(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.map(Number).every(Number.isFinite)) return false;
  const [x1, y1, x2, y2] = normalizeVisionBbox(value);
  // Touching the frame is strong evidence that part of the object may be cropped.
  return x1 > 0.005 && y1 > 0.005 && x2 < 0.995 && y2 < 0.995 && x2 - x1 >= 0.01 && y2 - y1 >= 0.01;
}

function isSpecificVisionName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || /\b(unknown|unidentified|mystery|beverage|packaged item|jarred (?:item|food)|canned goods)\b/.test(name)) return false;
  return !/^(?:[a-z -]+ )?(?:bottles?|containers?|jars?|packages?|cartons?|cans?|bags?)(?: \([^)]*\))?$/.test(name);
}

function hasSpecificVisionEvidence(name, evidence) {
  const packagedFood = /\b(water|soda|juice|milk|cream|sauce|dressing|condiment|yogurt|cheese|butter|mayonnaise|mustard|ketchup|oil|vinegar)\b/i.test(name);
  if (!packagedFood) return true;
  return /\b(label|brand|printed|text|reads|logo)\b/i.test(evidence);
}

function normalizeVisionResult(payload) {
  const confirmed = [];
  const uncertain = [];
  const confirmedNames = new Set();
  const reviewNames = new Set();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const isCompactItem = (item) => item && ("n" in item || "b" in item || "v" in item || "c" in item);
  const expandCompactItem = (item) => ({
    name: item?.n,
    guess: item?.n,
    confidence: item?.c,
    fullyVisible: item?.v,
    bbox: item?.b,
    evidence: item?.why,
    reason: item?.why,
    alternatives: item?.alt,
  });
  const compactItems = items.filter(isCompactItem).map(expandCompactItem);
  const confirmedInput = [
    ...(Array.isArray(payload?.confirmed) ? payload.confirmed : []),
    ...compactItems.filter((item) => item.fullyVisible === true),
  ];
  const uncertainInput = [
    ...(Array.isArray(payload?.uncertain) ? payload.uncertain : []),
    ...compactItems.filter((item) => item.fullyVisible !== true),
  ];

  const addUncertain = (item, fallbackReason) => {
    const guess = String(item?.guess || item?.name || "unknown item").trim().slice(0, 80) || "unknown item";
    const key = guess.toLowerCase();
    if (confirmedNames.has(key) || reviewNames.has(key) || confirmed.length + uncertain.length >= 25) return;
    reviewNames.add(key);
    uncertain.push({
      guess,
      confidence: Math.min(1, Math.max(0, Number(item?.confidence) || 0)),
      bbox: normalizeVisionBbox(item?.bbox),
      reason: String(item?.reason || fallbackReason || "The item is not fully clear.").trim().slice(0, 160),
      alternatives: asStringArray(item?.alternatives, []).slice(0, 3),
    });
  };

  for (const item of confirmedInput) {
    const name = String(item?.name || "").trim().slice(0, 80);
    const confidence = Math.min(1, Math.max(0, Number(item?.confidence) || 0));
    const evidence = String(item?.evidence || "").trim().slice(0, 160);
    if (!name) continue;
    if (item?.fullyVisible === true && confidence >= 0.95 && evidence && isSpecificVisionName(name) && hasSpecificVisionEvidence(name, evidence) && isAutoConfirmableVisionBbox(item?.bbox) && confirmed.length + uncertain.length < 25) {
      const key = name.toLowerCase();
      if (!confirmedNames.has(key)) {
        confirmedNames.add(key);
        confirmed.push({ name, confidence, bbox: normalizeVisionBbox(item.bbox), evidence });
      }
    } else {
      addUncertain(item, item?.fullyVisible === true
        ? "The item lacked reliable visual evidence or a safe crop."
        : "The item is partly hidden or cropped.");
    }
  }

  for (const item of uncertainInput) {
    addUncertain(item);
  }
  // Old or malformed model responses never get auto-added. They require review.
  for (const item of items.filter((item) => !isCompactItem(item))) {
    addUncertain(item, "The model used the old response format, so confirmation is required.");
  }

  return { confirmed, uncertain };
}

async function handleVisionRequest(req, res, { chat = airChat } = {}) {
  const { imageDataUrl } = req.body || {};
  if (!imageDataUrl) return res.status(400).json({ ok: false, failure: { message: "imageDataUrl required" } });
  const out = await chat([
    { role: "system", content: `Identify groceries in this fridge or pantry photo. Be conservative and never guess. Return ONLY compact JSON:
{"items":[{"n":"specific grocery or unknown item","c":0.0,"v":true,"b":[0,0,1,1],"why":"visible proof or doubt","alt":[]}]}
Rules: v=true only when the entire object is inside the frame, unobstructed, unmistakable, and c>=0.95. Packaged food or drink needs a readable label; container color or shape is insufficient. Use v=false for anything partially visible, edge-cropped, occluded, blurry, label-hidden, generic, inferred, or doubtful. b is a tight normalized [left,top,right,bottom] crop. why is under 8 words. Return the 8 most useful objects at most.` },
    { role: "user", content: [
      { type: "text", text: "Identify only fully visible, unmistakable groceries as confirmed. Put partially visible or uncertain objects in uncertain so the user can review a crop." },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ]},
  ], { maxTokens: 650, model: AIR_VISION_MODEL });
  if (!out.ok) {
    if (out.mock) {
      return res.json({ ok: true, mock: true,
        confirmed: [{ name: "eggs", confidence: 0.98 }, { name: "milk", confidence: 0.97 }],
        uncertain: [],
        note: "MOCK — set VOYAGER_KEY for live vision." });
    }
    return res.json({ ok: false, failure: out.failure });
  }
  try {
    const content = out.data.choices[0].message.content;
    const proposed = normalizeVisionResult(extractJson(content));
    if (!proposed.confirmed.length) {
      return res.json({ ok: true, ...proposed, model: AIR_VISION_MODEL });
    }

    const candidates = proposed.confirmed.map(({ name, bbox, evidence }) => ({ name, bbox, evidence }));
    const verification = await chat([
      { role: "system", content: `Act as a skeptical verifier, independent of the first detector. Check only the supplied candidates against the image. Reply ONLY with compact JSON:
{"verified":[{"name":"exact supplied name","confirmed":false,"confidence":0.0,"fullyVisible":false,"evidence":"visible proof or rejection reason"}]}
Set confirmed true only when the named grocery is visibly present, its entire physical outline is inside the image, it is not blocked by another object, and its identity is unmistakable. A container whose contents or label cannot be identified is not confirmed. Reject hallucinated, inferred, partly hidden, frame-cropped, or ambiguous candidates. Include every supplied candidate exactly once and add no new candidates.` },
      { role: "user", content: [
        { type: "text", text: `Verify these proposed automatic additions: ${JSON.stringify(candidates)}` },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]},
    ], { maxTokens: 900, model: AIR_VISION_VERIFY_MODEL });

    let verified = [];
    let verificationWarning = null;
    if (verification.ok) {
      try {
        verified = Array.isArray(extractJson(verification.data.choices[0].message.content)?.verified)
          ? extractJson(verification.data.choices[0].message.content).verified : [];
      } catch (error) {
        verificationWarning = `Verification response was invalid: ${error.message}`;
      }
    } else {
      verificationWarning = verification.failure?.message || "Verification request failed.";
    }

    const verdicts = new Map(verified.map((item) => [String(item?.name || "").trim().toLowerCase(), item]));
    const confirmed = [];
    const rejected = [];
    for (const candidate of proposed.confirmed) {
      const verdict = verdicts.get(candidate.name.toLowerCase());
      const verifierConfidence = Math.min(1, Math.max(0, Number(verdict?.confidence) || 0));
      const verifierEvidence = String(verdict?.evidence || "").trim();
      if (verdict?.confirmed === true && verdict?.fullyVisible === true && verifierConfidence >= 0.95 && verifierEvidence && hasSpecificVisionEvidence(candidate.name, verifierEvidence)) {
        confirmed.push({ name: candidate.name, confidence: Math.min(candidate.confidence, verifierConfidence) });
      } else {
        rejected.push({
          guess: candidate.name,
          confidence: Math.min(candidate.confidence, verifierConfidence),
          bbox: candidate.bbox,
          reason: String(verdict?.evidence || verificationWarning || "A second visual check could not confirm this item."),
        });
      }
    }
    const review = normalizeVisionResult({ uncertain: [...proposed.uncertain, ...rejected] }).uncertain;
    return res.json({ ok: true, confirmed, uncertain: review, model: AIR_VISION_MODEL,
      ...(verificationWarning ? { verificationWarning } : {}) });
  } catch (e) {
    res.json({ ok: false, failure: reportFailure("asu-air", "vision-parse", {
      status: "parse-error", message: `Could not parse vision JSON: ${e.message}`,
    })});
  }
}

app.post("/api/vision", handleVisionRequest);

// System prompt for AI meal generation. Grounded to data/recipe-sources.json:
// the model may only pull, adapt, or cite recipes from the approved sources,
// must cite the source name/URL in every dinner, and must fall back to the
// closest approved recipe (with an adaptation note) instead of inventing one.
function buildPlanSystemPrompt(priceCtx) {
  const sourcesCtx = recipeSourcesContext();
  return `You are FridgeFuse, a student meal planner for Tempe AZ 85281. Reply ONLY with JSON:
{"dinners":[{"title":"...","source":"...","sourceUrl":"...","adaptationNote":"","timeMin":20,"protein":25,"carbs":50,"fiber":6,"usesPantry":["..."],"needs":["..."],"steps":["..."]}],
"shoppingList":[{"item":"...","pack":"...","packPrice":0.0,"store":"...","qty":1,"sharedBy":["..."]}],
"totalCost":0.0,"notes":"..."}
Rules: plan EXACTLY the requested number of dinners. The user is a freshman cook, so give concrete beginner-safe steps and only use the listed equipment. First use food marked use-soon, then minimize unique purchases, stay within budget, and keep cooking easy. Prefer purchases shared across dinners. Put only missing ingredients in needs; pantry items cost $0. The server will ground final prices against its catalog. Respect time, equipment, and dietary restrictions. Price context: ${priceCtx}.
Recipe grounding (STRICT):
- Pull, adapt, or cite recipes ONLY from the approved sources listed below. NEVER invent a new recipe from scratch and NEVER use a recipe from an unlisted source, even if the user asks for one.
- Ground every dinner in a real recipe from one of these sources: base its ingredients and steps on that recipe, adjusting only for the user's pantry, budget, equipment, time, and diet.
- For every dinner, set "source" to the source's exact name and "sourceUrl" to its exact URL from the list below. Both fields are required and must match the list verbatim.
- If NO approved recipe fits the user's pantry and budget constraints, return the CLOSEST matching approved recipe instead of inventing one, and describe the minor changes in "adaptationNote" (e.g. "Adapted from Budget Bytes black bean quesadillas: swapped cheddar for the mozzarella the user has"). Set "adaptationNote" to "" when the recipe needs no changes.
Approved sources:
${sourcesCtx}`;
}

async function handlePlanRequest(req, res, { chat = airChat } = {}) {
  const { pantry = [], budget = 30, dinners = 3, maxTimeMin = 30,
          equipment = ["stove"], diet = "", useSoon = [], request = "", exclude = [],
          catalogOnly = false } = req.body || {};
  if (pantry !== undefined && !Array.isArray(pantry)) {
    return res.status(400).json({ ok: false, failure: { message: "pantry must be an array of strings" } });
  }
  if (equipment !== undefined && !Array.isArray(equipment)) {
    return res.status(400).json({ ok: false, failure: { message: "equipment must be an array of strings" } });
  }
  if (useSoon !== undefined && !Array.isArray(useSoon)) {
    return res.status(400).json({ ok: false, failure: { message: "useSoon must be an array of strings" } });
  }
  if (exclude !== undefined && !Array.isArray(exclude)) {
    return res.status(400).json({ ok: false, failure: { message: "exclude must be an array of meal titles" } });
  }
  if (diet !== undefined && typeof diet !== "string") {
    return res.status(400).json({ ok: false, failure: { message: "diet must be a string" } });
  }
  const safePantry = asStringArray(pantry, []);
  const safeEquipment = asStringArray(equipment, ["stove"]);
  const safeUseSoon = asStringArray(useSoon, []);
  const safeExclude = asStringArray(exclude, []);
  const safeDiet = typeof diet === "string" ? diet : "";
  if (catalogOnly) {
    return res.json({
      ok: true,
      mock: true,
      model: "grounded-catalog",
      ...localPlan({ pantry: safePantry, dinners, maxTimeMin, equipment: safeEquipment, diet: safeDiet, budget, useSoon: safeUseSoon, exclude: safeExclude })
    });
  }
  const priceCtx = PRICES.items.map((i) => {
    const c = cheapestPack(i.name);
    return `${i.name} (~${c.pack} @ ${c.store} $${c.packPrice})`;
  }).join("; ");
  const planningMessages = [
    { role: "system", content: buildPlanSystemPrompt(priceCtx) },
    { role: "user", content: `Pantry: ${safePantry.join(", ") || "(empty)"}. Use soon: ${safeUseSoon.join(", ") || "none"}. Budget total $${budget} for the whole plan. Dinners: ${dinners}. Max ${maxTimeMin} min each. Equipment: ${safeEquipment.join(", ")}. Diet/notes: ${safeDiet || "none"}. Avoid these meals: ${safeExclude.join(", ") || "none"}. Latest request: ${request || "build the best plan"}.` },
  ];
  const out = await chat(planningMessages, { maxTokens: 1800 });
  if (!out.ok) {
    if (out.mock) {
      return res.json({ ok: true, mock: true, ...localPlan({ pantry: safePantry, dinners, maxTimeMin, equipment: safeEquipment, diet: safeDiet, budget, useSoon: safeUseSoon, exclude: safeExclude }),
        note: "MOCK planner — set VOYAGER_KEY for live AI planning." });
    }
    // Live AI failed: still return local plan AND the failure (demo never dies, failure visible).
    return res.json({ ok: true, fallback: true, failure: out.failure,
      ...localPlan({ pantry: safePantry, dinners, maxTimeMin, equipment: safeEquipment, diet: safeDiet, budget, useSoon: safeUseSoon, exclude: safeExclude }) });
  }
  const expectedDinners = asDinners(dinners, 3);
  const content = out.data?.choices?.[0]?.message?.content;
  try {
    const plan = groundShoppingPlan(parseAiPlan(content, expectedDinners));
    return res.json({ ok: true, model: AIR_MODEL, ...plan });
  } catch (initialError) {
    const repaired = await repairAiPlan(chat, content, expectedDinners, initialError, planningMessages[1].content);
    if (!repaired.ok) {
      return res.json({ ok: false, failure: repaired.failure || reportFailure("asu-air", "plan-repair", {
        status: "repair-failed",
        message: `Could not repair AI plan: ${initialError.message}`,
      }) });
    }
    try {
      const repairedContent = repaired.data?.choices?.[0]?.message?.content;
      const plan = groundShoppingPlan(parseAiPlan(repairedContent, expectedDinners));
      return res.json({ ok: true, model: AIR_MODEL, repaired: true, ...plan });
    } catch (repairError) {
      return res.json({ ok: false, failure: reportFailure("asu-air", "plan-repair", {
        status: "parse-error",
        message: `Could not repair AI plan: ${repairError.message}`,
        initialMessage: initialError.message,
      }) });
    }
  }
}

app.post("/api/plan", handlePlanRequest);

app.get("/api/prices", (req, res) => {
  const q = (req.query.item || "").toLowerCase();
  if (!q) return res.json({ ok: true, stores: PRICES.stores, items: PRICES.items, aliases: ITEM_ALIASES, zip: PRICES.zip, note: PRICES.note });
  const hit = findPrice(q);
  if (!hit) return res.json({ ok: false, failure: { message: `No mock price for "${q}". Try /api/prices for full list.` } });
  res.json({ ok: true, ...hit, zip: PRICES.zip });
});

// Nearby branches with distance from the caller. Falls back to campus rather
// than erroring when the browser gives us no usable fix.
app.get("/api/stores", (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const hasFix = isValidCoordinate(lat, lng);
  const origin = hasFix
    ? { lat, lng, label: "your location" }
    : { lat: DEFAULT_ORIGIN.lat, lng: DEFAULT_ORIGIN.lng, label: DEFAULT_ORIGIN.label };
  const radius = asPositiveNumber(req.query.maxDistanceMi, DEFAULT_MAX_DISTANCE_MI) || DEFAULT_MAX_DISTANCE_MI;
  const stores = BRANCHES
    .map((branch) => ({
      ...branch,
      chainLabel: PRICES.stores[branch.chain],
      distanceMi: +haversineMiles(origin.lat, origin.lng, branch.lat, branch.lng).toFixed(2),
    }))
    .sort((a, b) => a.distanceMi - b.distanceMi)
    .filter((store) => store.distanceMi <= radius);
  res.json({
    ok: true,
    origin,
    usedFallbackLocation: !hasFix,
    maxDistanceMi: radius,
    count: stores.length,
    stores,
    zip: STORE_DATA.zip,
    note: STORE_DATA.note,
  });
});

// Turns a fix into something readable. The local description always comes back;
// the third-party lookup only runs when the client sends allowLookup: true.
async function handleGeoDescribe(req, res, { geocode = reverseGeocode } = {}) {
  const body = req.body || {};
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).json({ ok: false, failure: { message: "A valid lat and lng are required." } });
  }
  const local = describeLocation(lat, lng);
  // Strict equality: only an explicit true sends coordinates off this machine.
  if (body.allowLookup !== true) {
    return res.json({ ok: true, local, lookupUsed: false });
  }
  const lookup = await geocode(lat, lng);
  return res.json({
    ok: true,
    local,
    lookupUsed: true,
    placeName: lookup.ok ? lookup.placeName : null,
    precisionNote: lookup.ok ? lookup.precisionNote : null,
    // A failed lookup is reported, not fatal: the local description still stands.
    failure: lookup.ok ? undefined : lookup.failure,
  });
}

app.post("/api/geo/describe", handleGeoDescribe);

// Resolves a saved profile ZIP into a point to shop from. The catalog's own ZIP
// resolves locally; any other ZIP needs the same consent as a place-name lookup.
async function handleGeoPostal(req, res, { geocode = geocodePostalCode } = {}) {
  const body = req.body || {};
  const zip = String(body.postalCode ?? "").trim();
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ ok: false, failure: { message: "Enter a five-digit ZIP code." } });
  }
  // The catalog's own ZIP is already a known point, so it resolves with no
  // third-party call and no consent question at all.
  if (zip === String(STORE_DATA.zip)) {
    return res.json({
      ok: true, resolved: true,
      lat: DEFAULT_ORIGIN.lat, lng: DEFAULT_ORIGIN.lng,
      label: DEFAULT_ORIGIN.label, source: "local-store-data", lookupUsed: false,
    });
  }
  if (body.allowLookup !== true) {
    return res.json({
      ok: true,
      resolved: false,
      needsConsent: true,
      note: `Finding ZIP ${zip} needs a lookup outside this app. ZIP ${STORE_DATA.zip} resolves without one.`,
    });
  }
  const result = await geocode(zip);
  if (!result.ok) {
    return res.json({ ok: false, resolved: false, failure: result.failure });
  }
  return res.json({ ok: true, resolved: true, ...result });
}

app.post("/api/geo/postal", handleGeoPostal);

// Prices a basket at every nearby branch and ranks them cheapest-first.
app.post("/api/grocery/optimize", (req, res) => {
  const body = req.body || {};
  if (body.items !== undefined && !Array.isArray(body.items)) {
    return res.status(400).json({ ok: false, failure: { message: "items must be an array of names or {name, qty} entries" } });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    return res.status(400).json({ ok: false, failure: { message: "Add at least one item before comparing stores." } });
  }
  if (!BRANCHES.length) {
    return res.status(503).json({ ok: false, failure: reportFailure("grocery", "optimize", {
      status: "no-stores", message: "No store locations are loaded — check data/stores.json.",
    }) });
  }
  try {
    return res.json({ ok: true, ...optimizeCart({ items, lat: body.lat, lng: body.lng, maxDistanceMi: body.maxDistanceMi }) });
  } catch (e) {
    return res.status(500).json({ ok: false, failure: reportFailure("grocery", "optimize", {
      status: "optimize-error", message: e.message,
    }) });
  }
});

// Honest live-price attempt: tries the real store search page, reports blocks.
// Expected to be blocked often (Akamai/Cloudflare) — that IS the data for slides.
const LIVE_SEARCH = {
  walmart: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
  frys: (q) => `https://www.kroger.com/s?query=${encodeURIComponent(q)}`,
  aldi: (q) => `https://www.aldi.us/search/?q=${encodeURIComponent(q)}`,
};
app.get("/api/prices/live", async (req, res) => {
  const q = req.query.item || "";
  const store = (req.query.store || "walmart").toLowerCase();
  if (!q) return res.status(400).json({ ok: false, failure: { message: "item required" } });
  if (!LIVE_SEARCH[store]) {
    return res.json({ ok: false, failure: reportFailure("agent-browser", "live-price", {
      status: "no-search-url", store, message: `${store} has no simple search URL (Trader Joe's has none) — use mock.`,
    })});
  }
  const url = LIVE_SEARCH[store](q);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(t);
    const text = await r.text();
    const blocked = /captcha|robot|challenge|access denied|blocked/i.test(text.slice(0, 5000));
    if (!r.ok || blocked) {
      return res.json({ ok: false, live: false, url, failure: reportFailure("agent-browser", "live-price", {
        status: r.status, store, item: q, url, blocked,
        message: `Live fetch ${blocked ? "looks bot-blocked" : `HTTP ${r.status}`} — this is why v0 prices are mock/harvested.`,
        hint: "Reliable live prices need Playwright+stealth+residential IP+location cookies (see slides).",
      })});
    }
    const m = text.match(/\$\s?\d+\.\d{2}/);
    return res.json({ ok: true, live: true, store, item: q, url, firstPriceSeen: m ? m[0] : null,
      note: "Unverified scrape — prefer mock DB for totals." });
  } catch (e) {
    return res.json({ ok: false, live: false, url, failure: reportFailure("agent-browser", "live-price", {
      status: e.name === "AbortError" ? "timeout" : "network-error", store, item: q, url, message: e.message,
    })});
  }
});

app.get("/api/failures", (req, res) => res.json({ ok: true, count: failures.length, failures: failures.slice(-20) }));

// Export the Express app itself so Vercel can detect this file as an Express
// deployment. Attach the named helpers as properties so the in-process tests
// and the Netlify wrapper can keep using the existing module API.
module.exports = app;
Object.assign(module.exports, {
  app, localPlan, cheapestPack, findPrice, extractJson, PRICES, STORES, RECIPES,
  RECIPE_SOURCES, buildPlanSystemPrompt, reportFailure, resolveDataPath,
  DEFAULT_AIR_MODEL, AIR_MODEL, AIR_VISION_MODEL, AIR_VISION_VERIFY_MODEL,
  handlePlanRequest, handleVisionRequest, normalizeVisionResult,
  haversineMiles, isValidCoordinate, resolveCatalogItem, normalizeCartItems, optimizeCart,
  describeLocation, reverseGeocode, handleGeoDescribe, geocodePostalCode, handleGeoPostal,
  STORE_DATA, BRANCHES, DEFAULT_ORIGIN, ITEM_ALIASES
});

if (require.main === module) {
  // 0.0.0.0 so a phone on the same WiFi can reach the demo.
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`FridgeFuse v0 on http://localhost:${PORT}`);
    console.log(`AIR: ${AIR_BASE} text=${AIR_MODEL} vision=${AIR_VISION_MODEL} visionVerify=${AIR_VISION_VERIFY_MODEL} key=${AIR_KEY ? "set" : "MISSING (mock mode)"}`);
  });
}
