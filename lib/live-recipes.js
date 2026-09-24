"use strict";

// Live recipe discovery is deliberately kept separate from planning. Search
// results are only leads: the page is fetched, its structured Recipe facts are
// parsed, and every candidate is filtered again before it enters a prompt.
// The network and DNS functions are injectable so the SSRF boundary can be
// tested without making requests to arbitrary hosts.
const dns = require("node:dns").promises;
const net = require("node:net");

const TAVILY_URL = "https://api.tavily.com/search";
const DEFAULT_SEARCH_TTL_MS = 60 * 1000;
const DEFAULT_VERIFIED_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SEARCH_RESULTS = 20;
const DEFAULT_MAX_SEARCH_ATTEMPTS = 3;
// A plan needs several choices for swaps and repair, but an unbounded page
// crawl turns a single request into a slow and expensive search job.
const DEFAULT_MAX_CANDIDATES = 12;
const DEFAULT_FETCH_CONCURRENCY = 4;
const DEFAULT_SEARCH_TIMEOUT_MS = 10000;
const DEFAULT_RECIPE_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BODY_BYTES = 1.5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_INSTRUCTIONS = 6000;
const DEFAULT_MAX_INSTRUCTION_LINE = 700;
const DEFAULT_MAX_INGREDIENT_LINE = 400;
const DEFAULT_MAX_INGREDIENTS = 80;

const EQUIPMENT_ALIASES = [
  ["microwave", ["microwave", "microwave-safe", "microwaveable"]],
  ["stove", ["stove", "stovetop", "stove top", "hot plate", "burner", "skillet", "frying pan", "fry pan", "pan", "saucepan", "sauté pan", "saute pan", "pot", "saute", "sauté", "cook over", "medium heat", "high heat", "low heat", "heat oil", "boil", "simmer"]],
  ["oven", ["oven", "bake", "baking", "roast", "broil", "broiler"]],
  ["toaster oven", ["toaster oven"]],
  ["air fryer", ["air fryer", "air-fry", "air fry"]],
  ["rice cooker", ["rice cooker"]],
  ["kettle", ["kettle", "electric kettle"]],
  ["slow cooker", ["slow cooker", "crock pot", "crockpot"]],
  ["pressure cooker", ["pressure cooker", "instant pot"]],
  ["blender", ["blender", "blend until"]],
  ["sandwich press", ["sandwich press", "panini press", "grill press"]],
];

// Broad searches tend to return listicles and videos instead of pages with a
// Recipe JSON-LD block. Give each appliance a few concrete dish seeds so the
// discovery results are more likely to be directly verifiable. These are
// query hints only; the page facts still decide whether a recipe is usable.
const EQUIPMENT_QUERY_SEEDS = {
  microwave: ["microwave chilli", "microwave potato", "microwave rice bowl"],
  stove: ["skillet rice and beans", "stovetop pasta", "vegetable stir fry"],
  oven: ["sheet pan vegetables", "baked pasta", "roasted chickpeas"],
  "toaster oven": ["toaster oven quesadilla", "toaster oven baked potato", "toaster oven vegetable melt"],
  "air fryer": ["air fryer potato", "air fryer chickpeas", "air fryer vegetable tacos"],
  "rice cooker": ["rice cooker rice and beans", "rice cooker lentil curry", "rice cooker oatmeal"],
  kettle: ["kettle couscous", "kettle noodle bowl", "kettle oatmeal"],
  "slow cooker": ["slow cooker chilli", "slow cooker lentil soup", "slow cooker bean stew"],
  "pressure cooker": ["pressure cooker lentil curry", "pressure cooker rice and beans", "pressure cooker vegetable soup"],
  blender: ["blender smoothie", "blender gazpacho", "blender bean dip"],
  "sandwich press": ["sandwich press quesadilla", "panini press vegetable sandwich", "sandwich press bean melt"],
};
const DEFAULT_QUERY_SEEDS = ["rice and beans bowl", "vegetable pasta", "chickpea skillet"];

const INGREDIENT_UNITS = [
  "teaspoons?", "tsps?", "tbsps?", "tablespoons?", "tbsp", "cups?", "pints?", "quarts?", "gallons?",
  "ounces?", "oz", "pounds?", "lbs?", "grams?", "kilograms?", "kg", "mg", "g", "ml", "millilit(?:er|re)s?", "lit(?:er|re)s?", "l",
  "cans?", "tins?", "jars?", "packages?", "pkgs?", "bags?", "bottles?", "cartons?", "cloves?", "slices?",
  "sprigs?", "stalks?", "heads?", " bunch(?:es)?", "pieces?", "squares?", "bars?", "sticks?", "pinch(?:es)?", "dash(?:es)?", "handfuls?",
];
const QUANTITY_PART = String.raw`(?:\d+(?:\.\d+)?(?:\s*\/\s*\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])`;
const LEADING_QUANTITY = new RegExp(
  String.raw`^(?:about\s+|approximately\s+)?${QUANTITY_PART}(?:\s*${QUANTITY_PART})?(?:\s*(?:to|[-–—])\s*${QUANTITY_PART}(?:\s*${QUANTITY_PART})?)?\s*`,
  "i"
);
const PREPARATION_WORDS = /^(?:fresh|frozen|thawed|cooked|uncooked|raw|ripe|large|small|medium|extra[- ]large|boneless|skinless|chopped|diced|minced|sliced|shredded|grated|crushed|ground|roughly|finely|thinly|softened|melted|divided|plus more|to taste|for serving|as needed)\s+/i;

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)));
}

function stripMarkup(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWords(value) {
  return stripMarkup(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseIsoDuration(value) {
  const text = String(value || "").trim().toUpperCase();
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  if (!match || !text.includes("T") && !match[1]) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const total = days * 1440 + hours * 60 + minutes + seconds / 60;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(1, Math.ceil(total));
}

function durationFromStructuredData(data) {
  const total = parseIsoDuration(data?.totalTime);
  if (total) return total;
  const prep = parseIsoDuration(data?.prepTime) || 0;
  const cook = parseIsoDuration(data?.cookTime) || 0;
  const combined = prep + cook;
  return combined > 0 ? combined : null;
}

function normalizeIngredientLine(value) {
  let line = stripMarkup(value)
    .replace(/^[•*\-–—]\s*/, "")
    .replace(/\([^)]*(?:ounce|oz|gram|g|pound|lb|package|can|serving)[^)]*\)/gi, " ")
    .trim();
  // Remove a leading quantity, including mixed fractions and ranges written
  // with "to". Keep this separate from rawIngredients, which retain the
  // publisher's exact wording for dietary safety checks.
  line = line.replace(LEADING_QUANTITY, "");
  const unitPrefix = new RegExp(`^(?:${INGREDIENT_UNITS.join("|")})\\b\\s*`, "i");
  for (let i = 0; i < 3; i++) {
    const next = line.replace(unitPrefix, "");
    if (next === line) break;
    line = next;
  }
  line = line.replace(/^(?:of\s+|plus\s+)/i, "");
  line = line.split(/\s*,\s*|\s+\(.*$/)[0].trim();
  // A publisher may put a measured substitution after the canonical name,
  // as in "thyme leaves or 1 teaspoon dried". Drop only that quantity-bearing
  // branch; an unnumbered alternative remains part of the ingredient name.
  const alternative = /\s+or\s+(.+)$/i.exec(line);
  if (alternative && LEADING_QUANTITY.test(alternative[1])) line = line.slice(0, alternative.index).trim();
  for (let i = 0; i < 5; i++) {
    const next = line.replace(PREPARATION_WORDS, "").trim();
    if (next === line) break;
    line = next;
  }
  return line.replace(/[.;:]+$/, "").trim().slice(0, DEFAULT_MAX_INGREDIENT_LINE).toLowerCase();
}

function flattenIngredients(value) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw.flatMap((item) => typeof item === "string" ? [stripMarkup(item)] : item && typeof item === "object" ? flattenIngredients(item.text || item.name || item.itemListElement) : [])
    .map((line) => String(line).trim())
    .filter(Boolean)
    .slice(0, DEFAULT_MAX_INGREDIENTS);
}

function flattenInstructions(value, output = []) {
  if (typeof value === "string") {
    const clean = stripMarkup(value);
    if (clean) output.push(clean);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenInstructions(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    if (value.text) flattenInstructions(value.text, output);
    // HowToSection commonly has both a section name and itemListElement. Do
    // not let the heading hide the actual steps.
    if (value.name) flattenInstructions(value.name, output);
    if (value.itemListElement) flattenInstructions(value.itemListElement, output);
  }
  return output;
}

function sanitizeInstructions(lines, maxChars = DEFAULT_MAX_INSTRUCTIONS) {
  const output = [];
  let used = 0;
  for (const line of lines) {
    const clean = stripMarkup(line).slice(0, DEFAULT_MAX_INSTRUCTION_LINE);
    if (!clean || used >= maxChars) continue;
    const remaining = maxChars - used;
    const bounded = clean.slice(0, remaining);
    if (bounded) {
      output.push(bounded);
      used += bounded.length;
    }
  }
  return output;
}

// Recipe pages are untrusted input. A publisher should never be able to smuggle
// instructions for the planner into the model context, even if a page is
// compromised or a test fixture contains an obvious prompt injection.
function hasPromptInjection(value) {
  const text = normalizeWords(value);
  return /(?:ignore|disregard|forget) (?:all |any |the )?(?:previous|prior|above|system|developer|user) (?:instructions?|prompt)|(?:system|developer) prompt|jailbreak|do not follow (?:the )?(?:rules|instructions?)/i.test(text);
}

function assertSafeSourceText(values) {
  for (const value of values) {
    if (hasPromptInjection(value)) {
      const error = new Error("Recipe page contained unsafe instruction-like source text.");
      error.code = "unsafe-source-content";
      throw error;
    }
  }
}

function structuredPublisher(data, fallbackUrl) {
  const publisher = data?.publisher || data?.author || data?.creator;
  const candidate = Array.isArray(publisher) ? publisher[0] : publisher;
  const name = typeof candidate === "string" ? candidate : candidate?.name;
  if (typeof name === "string" && name.trim()) return stripMarkup(name).slice(0, 160);
  try {
    return new URL(fallbackUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "Unknown publisher";
  }
}

function structuredLicense(value) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map((entry) => {
    if (typeof entry === "string") return stripMarkup(entry).slice(0, 300);
    if (!entry || typeof entry !== "object") return "";
    return stripMarkup(entry.name || entry.url || entry.identifier || "").slice(0, 300);
  }).filter(Boolean);
  return normalized.length ? [...new Set(normalized)].join("; ") : null;
}

function sourceAttribution(html) {
  const visibleText = stripMarkup(String(html || "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " "));
  const match = /\b(?:Adapted from\b[^.]{1,360}\b(?:CC BY-SA(?:\s+4\.0)?|public domain)\.?|Source:\s*[^.]{1,260}\bpublic domain\.?)\b/i.exec(visibleText);
  return match ? match[0].slice(0, 500) : "";
}

function deriveEquipment(instructions) {
  const text = normalizeWords((instructions || []).join(" "));
  const equipment = [];
  for (const [id, aliases] of EQUIPMENT_ALIASES) {
    if (aliases.some((alias) => new RegExp(`(?:^| )${escapeRegExp(normalizeWords(alias))}(?: |$)`, "i").test(text))) {
      equipment.push(id);
    }
  }
  // A toaster oven is an oven variant. Requiring both makes a recipe appear
  // impossible to a student who has the toaster oven but no full oven.
  if (equipment.includes("toaster oven")) {
    const index = equipment.indexOf("oven");
    if (index >= 0) equipment.splice(index, 1);
  }
  return equipment;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recursiveRecipeObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) recursiveRecipeObjects(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((entry) => String(entry || "").toLowerCase().split(/[\/#]/).pop() === "recipe")) output.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "@context" || key === "@type") continue;
    recursiveRecipeObjects(child, output);
  }
  return output;
}

function parseJsonLdScripts(html) {
  const scripts = [...String(html || "").matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  const recipes = [];
  let malformed = 0;
  for (const match of scripts) {
    const raw = decodeHtmlEntities(match[1]).trim();
    if (!raw) continue;
    try {
      recipes.push(...recursiveRecipeObjects(JSON.parse(raw)));
    } catch {
      malformed++;
    }
  }
  return { recipes, malformed, scripts: scripts.length };
}

function parseRecipeHtml(html, { finalUrl = "https://example.invalid/recipe" } = {}) {
  const parsed = parseJsonLdScripts(html);
  const usable = parsed.recipes.find((data) => {
    const ingredients = flattenIngredients(data.recipeIngredient);
    const instructions = flattenInstructions(data.recipeInstructions);
    return typeof data.name === "string" && data.name.trim() && ingredients.length && instructions.length && durationFromStructuredData(data);
  });
  if (!usable) {
    const reason = parsed.malformed && !parsed.recipes.length ? "Recipe page contained malformed JSON-LD." : "Recipe page has no usable Recipe JSON-LD.";
    const error = new Error(reason);
    error.code = "no-recipe-jsonld";
    throw error;
  }
  const rawIngredients = flattenIngredients(usable.recipeIngredient);
  const ingredients = [...new Set(rawIngredients.map(normalizeIngredientLine).filter(Boolean))];
  const rawInstructions = flattenInstructions(usable.recipeInstructions);
  const instructions = sanitizeInstructions(rawInstructions);
  assertSafeSourceText([usable.name, ...rawIngredients, ...rawInstructions]);
  const timeMin = durationFromStructuredData(usable);
  const title = stripMarkup(usable.name).slice(0, 240);
  const publisher = structuredPublisher(usable, finalUrl);
  const equipment = deriveEquipment(rawInstructions);
  if (!equipment.length) {
    const error = new Error("Recipe page did not reveal usable cooking equipment in its instructions.");
    error.code = "no-equipment";
    throw error;
  }
  return {
    title,
    sourceRecipe: title,
    publisher,
    source: publisher,
    sourceUrl: finalUrl,
    finalUrl,
    url: finalUrl,
    timeMin,
    ingredients,
    rawIngredients,
    instructions,
    rawInstructions: rawInstructions.map((line) => stripMarkup(line).slice(0, DEFAULT_MAX_INSTRUCTION_LINE)),
    method: instructions.join(" "),
    equipment,
    // Prompts must label these as untrusted source facts. They are evidence,
    // not commands, and are bounded before they cross into model context.
    untrustedInstructions: true,
    factsFrom: "schema.org Recipe JSON-LD",
    license: structuredLicense(usable.license),
    attribution: sourceAttribution(html),
  };
}

function isPrivateOrReservedIp(address) {
  const ip = String(address || "").replace(/^\[|\]$/g, "").toLowerCase().split("%", 1)[0];
  const version = net.isIP(ip);
  if (version === 4) {
    const octets = ip.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0);
  }
  if (version !== 6) return true;
  const normalized = ip;
  if (normalized === "::" || normalized === "::1") return true;
  const dottedMapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalized);
  if (dottedMapped) return isPrivateOrReservedIp(dottedMapped[1]);
  const parts = normalized.split("::");
  if (parts.length > 2) return true;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const expandedParts = parts.length === 2
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : [...left];
  if (expandedParts.length !== 8 || expandedParts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return true;
  const expanded = expandedParts.map((part) => Number.parseInt(part || "0", 16));
  const first = expanded[0] || 0;
  const second = expanded[1] || 0;
  if ((first & 0xff00) === 0xff00) return true; // multicast and reserved
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first === 0x2001 && second === 0x0db8)) return true;
  // IPv4-mapped addresses need the IPv4 policy too. Dotted mapped forms were
  // handled by the recursive branch in older versions; the hex form is just
  // as easy to produce from DNS and must not bypass the check.
  if (expanded.slice(0, 6).every((part, index) => part === (index === 5 ? 0xffff : 0))) {
    const mapped = `${expanded[6] >> 8}.${expanded[6] & 255}.${expanded[7] >> 8}.${expanded[7] & 255}`;
    return isPrivateOrReservedIp(mapped);
  }
  // Documentation and benchmarking ranges are not public recipe hosts.
  if (first === 0x2001 && (second === 0x0002 || second === 0x000d)) return true;
  return first === 0;
}

function isPublicRecipeUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
    if (net.isIP(hostname)) return !isPrivateOrReservedIp(hostname);
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) && !hostname.includes("..") && hostname.length <= 253;
  } catch {
    return false;
  }
}

function failure(status, message, extra = {}) {
  return { status, message, ...extra };
}

function defaultRecipeFetch() {
  try {
    const { Impit } = require("impit");
    const client = new Impit({ browser: "chrome151", timeout: 15000 });
    return client.fetch.bind(client);
  } catch {
    return globalThis.fetch;
  }
}

function responseHeader(response, name) {
  if (response?.headers?.get) return response.headers.get(name);
  const headers = response?.headers || {};
  return headers[name] || headers[name.toLowerCase()] || null;
}

async function readCappedBody(response, maxBytes) {
  const contentLength = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error(`Recipe response is too large (${contentLength} bytes).`);
    error.code = "body-too-large";
    throw error;
  }
  if (response?.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        const error = new Error(`Recipe response exceeded the ${maxBytes}-byte limit.`);
        error.code = "body-too-large";
        throw error;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        size += buffer.length;
        if (size > maxBytes) {
          const error = new Error(`Recipe response exceeded the ${maxBytes}-byte limit.`);
          error.code = "body-too-large";
          try { await reader.cancel(); } catch { /* best effort */ }
          throw error;
        }
        chunks.push(buffer);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* best effort */ }
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const error = new Error(`Recipe response exceeded the ${maxBytes}-byte limit.`);
    error.code = "body-too-large";
    throw error;
  }
  return text;
}

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(cache, key, value, ttl, maxEntries) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function normalizeEquipment(equipment) {
  const requested = new Set((Array.isArray(equipment) ? equipment : []).map(normalizeWords));
  return new Set([...requested].flatMap((entry) => {
    const found = EQUIPMENT_ALIASES.find(([id, aliases]) => id === entry || aliases.some((alias) => normalizeWords(alias) === entry));
    return found ? [found[0]] : [entry];
  }));
}

function recipeFitsEquipment(candidate, equipment) {
  const available = normalizeEquipment(equipment);
  return (candidate.equipment || []).every((required) => available.has(required));
}

function dietTextForCandidate(candidate) {
  return [candidate.title, ...(candidate.rawIngredients || candidate.ingredients || []), ...(candidate.rawInstructions || candidate.instructions || [])].join(" ");
}

function stripAllowedDietPhrases(text, rule) {
  let output = ` ${normalizeWords(text)} `;
  for (const allowed of rule?.allows || []) {
    const phrase = normalizeWords(allowed);
    if (phrase) output = output.replace(new RegExp(`(?:^| )${escapeRegExp(phrase)}(?: |$)`, "g"), " ");
  }
  return output.replace(/\s+/g, " ").trim();
}

function recipeViolatesDiet(candidate, rules = []) {
  const text = dietTextForCandidate(candidate);
  for (const rule of rules || []) {
    const scanned = stripAllowedDietPhrases(text, rule);
    for (const forbidden of rule.forbids || []) {
      const term = normalizeWords(forbidden);
      if (term && new RegExp(`(?:^| )${escapeRegExp(term)}(?:e?s)?(?: |$)`, "i").test(scanned)) return forbidden;
    }
  }
  return null;
}

function queryForConstraints({ maxTimeMin, equipment, dietRules, includeRecipe, attempt }) {
  const equipmentIds = [...normalizeEquipment(equipment)];
  const tools = equipmentIds.join(" ") || "small kitchen appliances";
  const diets = (Array.isArray(dietRules) ? dietRules : []).map((rule) => rule.label || rule.id).filter(Boolean).join(", ");
  const queryAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  const equipmentSeeds = equipmentIds.map((id) => EQUIPMENT_QUERY_SEEDS[id]).filter(Boolean);
  const seededEquipment = equipmentSeeds.length > 0;
  let seed;
  if (equipmentSeeds.length > 1) {
    // Spread the bounded attempts over the requested appliances. This keeps a
    // microwave-and-stove request from spending every query on microwave.
    const equipmentIndex = queryAttempt % equipmentSeeds.length;
    const seedIndex = Math.floor(queryAttempt / equipmentSeeds.length) % equipmentSeeds[equipmentIndex].length;
    seed = equipmentSeeds[equipmentIndex][seedIndex];
  } else {
    const seeds = equipmentSeeds[0] || DEFAULT_QUERY_SEEDS;
    seed = seeds[queryAttempt % seeds.length];
  }
  const toolClause = seededEquipment ? "" : ` using ${tools}`;
  const base = `${seed} recipe${toolClause} under ${Number(maxTimeMin) || 30} minutes`;
  const diet = diets ? ` ${diets}` : "";
  const include = includeRecipe ? ` ${String(includeRecipe).slice(0, 120)}` : "";
  return `${base}${diet}${include}`;
}

function createLiveRecipeService(options = {}) {
  const tavilyKey = options.tavilyKey === undefined ? process.env.TAVILY_API_KEY || "" : String(options.tavilyKey || "");
  const searchEndpoint = options.searchEndpoint || TAVILY_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  // A single injected fetch keeps tests deterministic for both Tavily and page
  // reads; production uses impit's browser-fingerprint client for pages.
  const recipeFetch = options.recipeFetch || options.fetchRecipe || options.fetchImpl || defaultRecipeFetch();
  const dnsLookup = options.dnsLookup || options.resolveDns || dns.lookup.bind(dns);
  const reportFailure = typeof options.reportFailure === "function" ? options.reportFailure : () => null;
  const searchTtlMs = Number(options.searchTtlMs) > 0 ? Number(options.searchTtlMs) : DEFAULT_SEARCH_TTL_MS;
  const verifiedTtlMs = Number(options.verifiedTtlMs) > 0 ? Number(options.verifiedTtlMs) : DEFAULT_VERIFIED_TTL_MS;
  const maxBodyBytes = Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;
  const maxRedirects = Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0 ? options.maxRedirects : DEFAULT_MAX_REDIRECTS;
  const maxSearchAttempts = Number.isInteger(options.maxSearchAttempts) && options.maxSearchAttempts > 0 ? options.maxSearchAttempts : DEFAULT_MAX_SEARCH_ATTEMPTS;
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0 ? options.maxCandidates : DEFAULT_MAX_CANDIDATES;
  const fetchConcurrency = Number.isInteger(options.fetchConcurrency) && options.fetchConcurrency > 0 ? options.fetchConcurrency : DEFAULT_FETCH_CONCURRENCY;
  const searchTimeoutMs = Number(options.searchTimeoutMs) > 0 ? Number(options.searchTimeoutMs) : DEFAULT_SEARCH_TIMEOUT_MS;
  const recipeTimeoutMs = Number(options.recipeTimeoutMs) > 0 ? Number(options.recipeTimeoutMs) : DEFAULT_RECIPE_TIMEOUT_MS;
  const searchCache = new Map();
  const searchInflight = new Map();
  const verifiedCache = new Map();
  const verifiedInflight = new Map();

  function loggedFailure(provider, operation, details) {
    const entry = failure(details.status || "failed", details.message || "Live recipe request failed.", details);
    try { reportFailure(provider, operation, entry); } catch { /* reporting must not break the safety path */ }
    return entry;
  }

  async function timedFetch(fetcher, url, init, timeoutMs) {
    const controller = new AbortController();
    const existingSignal = init?.signal;
    const relayAbort = () => controller.abort(existingSignal.reason);
    if (existingSignal) {
      if (existingSignal.aborted) controller.abort(existingSignal.reason);
      else existingSignal.addEventListener("abort", relayAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (existingSignal) existingSignal.removeEventListener("abort", relayAbort);
    }
  }

  async function searchTavily(query) {
    const key = String(query).trim();
    const cached = cacheGet(searchCache, key);
    if (cached !== undefined) return { ok: true, urls: cached };
    if (searchInflight.has(key)) return searchInflight.get(key);
    const work = (async () => {
      if (!tavilyKey) {
        return { ok: false, failure: loggedFailure("tavily", "search", { status: "no-key", message: "TAVILY_API_KEY is required for live recipe search.", hint: "Set TAVILY_API_KEY before planning." }) };
      }
      try {
        const response = await timedFetch(fetchImpl, searchEndpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${tavilyKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            query: key,
            search_depth: "basic",
            max_results: DEFAULT_MAX_SEARCH_RESULTS,
            topic: "general",
            include_answer: false,
            include_raw_content: false,
            include_images: false,
            safe_search: true,
          }),
        }, searchTimeoutMs);
        const body = await readCappedBody(response, 512 * 1024);
        if (!response?.ok) return { ok: false, failure: loggedFailure("tavily", "search", { status: response.status, message: `Tavily search failed: HTTP ${response.status}`, responseSnippet: body.slice(0, 300) }) };
        let data;
        try { data = JSON.parse(body); } catch (error) {
          return { ok: false, failure: loggedFailure("tavily", "search", { status: "bad-json", message: `Tavily returned invalid JSON: ${error.message}` }) };
        }
        const urls = [...new Set((Array.isArray(data?.results) ? data.results : []).map((result) => typeof result?.url === "string" ? result.url.trim() : "").filter(Boolean))].slice(0, DEFAULT_MAX_SEARCH_RESULTS);
        cacheSet(searchCache, key, urls, searchTtlMs, 32);
        return { ok: true, urls };
      } catch (error) {
        return { ok: false, failure: loggedFailure("tavily", "search", { status: error.name === "AbortError" ? "timeout" : "network-error", message: `Tavily search failed: ${error.message}` }) };
      }
    })();
    searchInflight.set(key, work);
    try { return await work; } finally { searchInflight.delete(key); }
  }

  async function validatePublicUrl(value) {
    if (!isPublicRecipeUrl(value)) return { ok: false, failure: failure("unsafe-url", "Recipe URL is not a public HTTPS URL.") };
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(hostname)) return { ok: true, url: parsed };
    try {
      const answers = await dnsLookup(hostname, { all: true, verbatim: true });
      const records = Array.isArray(answers) ? answers : answers?.address ? [answers] : [];
      if (!records.length || records.some((record) => isPrivateOrReservedIp(record.address || record))) {
        return { ok: false, failure: failure("unsafe-url", `Recipe hostname ${hostname} resolves to a private or reserved address.`) };
      }
      return { ok: true, url: parsed };
    } catch (error) {
      return { ok: false, failure: failure("dns-error", `Recipe hostname ${hostname} could not be resolved safely: ${error.message}`) };
    }
  }

  async function verifyUrl(value, verifyOptions = {}) {
    const requestedKey = String(value || "").trim();
    const fresh = verifyOptions?.fresh === true;
    const allowedHosts = Array.isArray(verifyOptions?.allowedHosts)
      ? new Set(verifyOptions.allowedHosts.map((host) => String(host).toLowerCase()).filter(Boolean))
      : null;
    const hostAllowed = (url) => !allowedHosts || allowedHosts.has(String(url?.hostname || "").toLowerCase());
    const cachedHostAllowed = (recipe) => {
      try { return hostAllowed(new URL(recipe?.finalUrl || recipe?.sourceUrl)); } catch { return false; }
    };
    if (!fresh) {
      const directCached = cacheGet(verifiedCache, requestedKey);
      if (directCached !== undefined && cachedHostAllowed(directCached)) return { ok: true, recipe: directCached };
      if (verifiedInflight.has(requestedKey)) return verifiedInflight.get(requestedKey);
    }
    const work = (async () => {
      const initial = await validatePublicUrl(requestedKey);
      if (!initial.ok) return { ok: false, failure: loggedFailure("live-recipes", "verify", initial.failure) };
      if (!hostAllowed(initial.url)) return { ok: false, failure: loggedFailure("live-recipes", "verify", failure("unsafe-url", "Recipe URL is outside the allowed publisher host.")) };
      const cacheKey = initial.url.href;
      if (!fresh) {
        const cached = cacheGet(verifiedCache, cacheKey);
        if (cached !== undefined && cachedHostAllowed(cached)) return { ok: true, recipe: cached };
      }
      let current = initial.url;
      try {
        for (let hop = 0; hop <= maxRedirects; hop++) {
          if (!hostAllowed(current)) return { ok: false, failure: loggedFailure("live-recipes", "verify", failure("unsafe-redirect", "Recipe redirect is outside the allowed publisher host.")) };
          const checked = hop === 0 ? initial : await validatePublicUrl(current.href);
          if (!checked.ok) return { ok: false, failure: loggedFailure("live-recipes", "verify", checked.failure) };
          if (typeof verifyOptions?.beforeFetch === "function") await verifyOptions.beforeFetch(current.href, hop);
          const response = await timedFetch(recipeFetch, current.href, {
            redirect: "manual",
            headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "FridgeFuse/0.1 live recipe verifier" },
          }, recipeTimeoutMs);
          const status = Number(response?.status || 0);
          if ([301, 302, 303, 307, 308].includes(status)) {
            if (hop >= maxRedirects) return { ok: false, failure: loggedFailure("live-recipes", "verify", { status: "too-many-redirects", message: "Recipe page exceeded the redirect limit." }) };
            const location = responseHeader(response, "location");
            if (!location) return { ok: false, failure: loggedFailure("live-recipes", "verify", { status: "redirect-without-location", message: "Recipe page returned a redirect without a location." }) };
            current = new URL(location, current.href);
            continue;
          }
          if (!response?.ok) return { ok: false, failure: loggedFailure("live-recipes", "verify", { status: status || "http-error", message: `Recipe page failed: HTTP ${status}` }) };
          const type = String(responseHeader(response, "content-type") || "").toLowerCase();
          if (type && !type.includes("text/html") && !type.includes("application/xhtml+xml")) {
            return { ok: false, failure: loggedFailure("live-recipes", "verify", { status: "not-html", message: `Recipe page is not HTML (${type}).` }) };
          }
          const body = await readCappedBody(response, maxBodyBytes);
          if (!/<html[\s>]/i.test(body) && !/<script\b/i.test(body)) {
            return { ok: false, failure: loggedFailure("live-recipes", "verify", { status: "not-html", message: "Recipe response did not contain an HTML document." }) };
          }
          let recipe;
          try { recipe = parseRecipeHtml(body, { finalUrl: current.href }); } catch (error) {
            return { ok: false, failure: loggedFailure("live-recipes", "verify", { status: error.code || "parse-error", message: error.message }) };
          }
          cacheSet(verifiedCache, cacheKey, recipe, verifiedTtlMs, 96);
          cacheSet(verifiedCache, current.href, recipe, verifiedTtlMs, 96);
          return { ok: true, recipe };
        }
      } catch (error) {
        return { ok: false, failure: loggedFailure("live-recipes", "verify", { status: error.code || "network-error", message: `Recipe fetch failed: ${error.message}` }) };
      }
      return { ok: false, failure: loggedFailure("live-recipes", "verify", { status: "failed", message: "Recipe verification failed." }) };
    })();
    if (fresh) return work;
    verifiedInflight.set(requestedKey, work);
    try { return await work; } finally { verifiedInflight.delete(requestedKey); }
  }

  async function mapLimit(values, limit, mapper) {
    const output = new Array(values.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        output[index] = await mapper(values[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
    return output;
  }

  async function findRecipes(input = {}) {
    const requested = Math.min(7, Math.max(1, Math.floor(Number(input.dinners) || 1)));
    const maxTimeMin = Number(input.maxTimeMin) > 0 ? Number(input.maxTimeMin) : 30;
    const equipment = Array.isArray(input.equipment) ? input.equipment.map(String) : [];
    const dietRules = Array.isArray(input.dietRules) ? input.dietRules : [];
    const exclude = new Set((Array.isArray(input.exclude) ? input.exclude : []).map(normalizeWords).filter(Boolean));
    const includeRecipe = normalizeWords(input.includeRecipe || "");
    // Return several verified choices so Voyager can choose a compatible
    // dinner and a swap/repair can reuse the very same candidate set. A saved
    // recipe is a required member, not the only member: a three-dinner request
    // still needs alternatives while the requested recipe may be repeated.
    const target = Math.min(maxCandidates, Math.max(requested, requested * 3));
    const fetchBudget = Math.min(36, DEFAULT_MAX_SEARCH_RESULTS * maxSearchAttempts, Math.max(20, target * 2));
    // A large first Tavily response must not consume the entire crawl budget.
    // Keep each of the bounded discovery attempts a fair slice while retaining
    // one global cap for total page work.
    const perAttemptFetchBudget = Math.min(12, Math.max(8, Math.ceil(fetchBudget / maxSearchAttempts)));
    const found = [];
    const seenUrls = new Set();
    const seenCandidates = new Set();
    const sourceFailures = [];
    const rejected = { time: 0, equipment: 0, diet: 0, excluded: 0, include: 0 };
    let lastFailure = null;
    for (let attempt = 0; attempt < maxSearchAttempts && found.length < target; attempt++) {
      const query = queryForConstraints({ maxTimeMin, equipment, dietRules, includeRecipe: input.includeRecipe, attempt });
      const search = await searchTavily(query);
      if (!search.ok) {
        lastFailure = search.failure;
        if (search.failure?.status === "no-key") return search;
        continue;
      }
      let attemptFetches = 0;
      const pending = search.urls.filter((url) => {
        if (attemptFetches >= perAttemptFetchBudget || seenUrls.size >= fetchBudget || seenUrls.has(url)) return false;
        seenUrls.add(url);
        attemptFetches++;
        return true;
      });
      const checkedResults = await mapLimit(pending, fetchConcurrency, (url) => verifyUrl(url));
      for (const [index, checked] of checkedResults.entries()) {
        const url = pending[index];
        if (!checked.ok) {
          lastFailure = checked.failure;
          sourceFailures.push({ url: String(url).slice(0, 400), status: checked.failure?.status || "failed", message: String(checked.failure?.message || "Recipe source failed.").slice(0, 240) });
          continue;
        }
        const candidate = checked.recipe;
        const titleKey = normalizeWords(candidate.title);
        if (!candidate.timeMin || candidate.timeMin > maxTimeMin) { rejected.time++; continue; }
        if (!candidate.equipment?.length || !recipeFitsEquipment(candidate, equipment)) { rejected.equipment++; continue; }
        if (exclude.has(titleKey) || exclude.has(normalizeWords(candidate.finalUrl))) { rejected.excluded++; continue; }
        const dietViolation = recipeViolatesDiet(candidate, dietRules);
        if (dietViolation) { rejected.diet++; continue; }
        const candidateKey = normalizeWords(candidate.finalUrl || candidate.sourceUrl || candidate.title);
        if (seenCandidates.has(candidateKey)) continue;
        seenCandidates.add(candidateKey);
        found.push(candidate);
      }
    }
    if (includeRecipe && !found.some((candidate) => normalizeWords(candidate.title) === includeRecipe)) {
      return { ok: false, failure: loggedFailure("live-recipes", "find", {
        status: "no-safe-recipes",
        message: `The requested saved recipe "${String(input.includeRecipe).slice(0, 120)}" was not found among verified live candidates.`,
        attempted: maxSearchAttempts,
        verified: found.length,
        attemptedUrls: seenUrls.size,
        sourceFailures: sourceFailures.slice(0, 24),
        sourceFailureCount: sourceFailures.length,
        rejected,
      }) };
    }
    if (found.length >= requested) return { ok: true, candidates: found.slice(0, maxCandidates) };
    if (lastFailure?.status === "no-key") return { ok: false, failure: lastFailure };
    return { ok: false, failure: loggedFailure("live-recipes", "find", {
      status: "no-safe-recipes",
      message: "Live recipe search and verification found no safe recipes matching this request.",
      attempted: maxSearchAttempts,
      verified: found.length,
      attemptedUrls: seenUrls.size,
      sourceFailures: sourceFailures.slice(0, 24),
      sourceFailureCount: sourceFailures.length,
      rejected,
    }) };
  }

  return {
    searchTavily,
    verifyUrl,
    validatePublicUrl,
    findRecipes,
    caches: { search: searchCache, verified: verifiedCache, searchInflight, verifiedInflight },
  };
}

module.exports = {
  createLiveRecipeService,
  parseIsoDuration,
  parseRecipeHtml,
  parseJsonLdScripts,
  normalizeIngredientLine,
  deriveEquipment,
  isPublicRecipeUrl,
  isPrivateOrReservedIp,
  recipeFitsEquipment,
  recipeViolatesDiet,
  sanitizeInstructions,
  hasPromptInjection,
  normalizeWords,
  queryForConstraints,
};
