"use strict";

// Curated discovery supplies URLs; this service verifies live page facts before
// they enter a plan. Injectable network and DNS functions keep the SSRF checks
// testable without requests to arbitrary hosts.
const dns = require("node:dns").promises;
const net = require("node:net");

const DEFAULT_VERIFIED_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RECIPE_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BODY_BYTES = 1.5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_INSTRUCTIONS = 6000;
const DEFAULT_MAX_INSTRUCTION_LINE = 700;
const DEFAULT_MAX_INGREDIENT_LINE = 400;
const DEFAULT_MAX_INGREDIENTS = 80;
const DEFAULT_MAX_INSTRUCTION_STEPS = 30;

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

const INGREDIENT_UNITS = [
  "teaspoons?", "tsps?", "tbsps?", "tablespoons?", "tbsp", "cups?", "pints?", "quarts?", "gallons?",
  "ounces?", "oz", "pounds?", "lbs?", "grams?", "kilograms?", "kg", "mg", "g", "ml", "millilit(?:er|re)s?", "lit(?:er|re)s?", "l",
  "cans?", "tins?", "jars?", "packs?", "packages?", "pkgs?", "bags?", "bottles?", "cartons?", "cloves?", "slices?",
  "sprigs?", "stalks?", "heads?", "bunch(?:es)?", "pieces?", "squares?", "bars?", "sticks?", "pinch(?:es)?", "dash(?:es)?", "handfuls?",
];
const QUANTITY_PART = String.raw`(?:\d+(?:\.\d+)?(?:\s*\/\s*\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])`;
const LEADING_QUANTITY = new RegExp(
  String.raw`^(?:about\s+|approximately\s+)?${QUANTITY_PART}(?:\s*${QUANTITY_PART})?(?:\s*(?:to|[-–—])\s*${QUANTITY_PART}(?:\s*${QUANTITY_PART})?)?\s*`,
  "i"
);
const PREPARATION_WORDS = /^(?:thawed|cooked|uncooked|raw|ripe|large|small|medium|extra[- ]large|boneless|skinless|roughly|finely|thinly|softened|melted|divided|plus more|to taste|for serving|as needed)\s+/i;
const PREPARATION_PHRASE = /^(?:(?:roughly|finely|thinly)\s+)(?:chopped|diced|minced|sliced|shredded|grated|crushed)\s+/i;
const TRAILING_PREPARATION = /\s+(?:(?:roughly|finely|thinly)\s+)?(?:chopped|diced|minced|sliced|shredded|grated|crushed)\s*$/i;
const TRAILING_PRESERVATION = /\s+(?:drained(?:\s+and\s+(?:rinsed|juice\s+reserved))?|rinsed|juice\s+reserved)\s*$/i;
const GARNISH_PREPARATION = /^(?:(?:roughly|finely|thinly)\s+)?(?:chopped|diced|minced|sliced|shredded|grated|crushed)\s+/i;

function ingredientIdentityWords(value) {
  return stripMarkup(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function repeatedGarnishIngredient(value) {
  const parts = /^(.*?)\s+plus\s+(.+?)(?:,\s*|\s+)to garnish$/i.exec(String(value || "").trim());
  if (!parts) return "";

  let garnish = parts[2].trim();
  const unitPrefix = new RegExp(`^(?:${INGREDIENT_UNITS.map((unit) => unit.trim()).join("|")})\\b\\s*`, "i");
  for (let i = 0; i < 6; i++) {
    const next = garnish.replace(LEADING_QUANTITY, "").replace(/^[x×]\s*/i, "");
    if (next === garnish) break;
    garnish = next;
  }
  for (let i = 0; i < 6; i++) {
    const next = garnish.replace(unitPrefix, "");
    if (next === garnish) break;
    garnish = next;
  }
  garnish = garnish.replace(GARNISH_PREPARATION, "").replace(/^(?:some|of|plus)\s+/i, "").trim();

  const baseWords = ingredientIdentityWords(parts[1]);
  const garnishWords = ingredientIdentityWords(garnish);
  const sameIngredient = baseWords.length === garnishWords.length && baseWords.every((word, index) => word === garnishWords[index]);
  const addsLeafForm = garnishWords.length === baseWords.length + 1 &&
    garnishWords[garnishWords.length - 1] === "leaves" &&
    baseWords.every((word, index) => word === garnishWords[index]);
  if (!sameIngredient && !addsLeafForm) return "";
  return addsLeafForm ? garnish : parts[1].trim();
}

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
  // Recipe ingredients often list equivalent choices; keep the first choice
  // for shopping, while rawIngredients retain every publisher-listed option.
  line = line.split(/\s+or\s+|\s*\/\s*(?=[a-z])/i, 1)[0].trim();
  line = repeatedGarnishIngredient(line) || line;
  line = line.replace(/^(?:some|a little|a few|a bit of)\s+/i, "");
  const cannedChoppedTomatoes = /\b(?:cans?|tins?)\b/i.test(line) && /\b(?:chopped|diced)\s+tomatoes?\b/i.test(line);
  // Remove a leading quantity, including mixed fractions and ranges written
  // with "to". Keep this separate from rawIngredients, which retain the
  // publisher's exact wording for dietary safety checks.
  for (let i = 0; i < 6; i++) {
    const next = line.replace(LEADING_QUANTITY, "").replace(/^[x×]\s*/i, "");
    if (next === line) break;
    line = next;
  }
  for (let i = 0; i < 6; i++) {
    const next = line.replace(PREPARATION_WORDS, "");
    if (next === line) break;
    line = next;
  }
  const unitPrefix = new RegExp(`^(?:${INGREDIENT_UNITS.map((unit) => unit.trim()).join("|")})\\b\\s*`, "i");
  for (let i = 0; i < 6; i++) {
    const next = line.replace(unitPrefix, "");
    if (next === line) break;
    line = next;
  }
  line = line.replace(/^(?:of\s+|plus\s+)/i, "");
  const repeatedGarnish = repeatedGarnishIngredient(line.replace(/,\s*to garnish\s*$/i, " to garnish"));
  if (repeatedGarnish) {
    line = repeatedGarnish;
  } else {
    line = line.split(/\s*,\s*|\s+\(.*$/)[0].trim();
    line = line.replace(TRAILING_PRESERVATION, "").replace(TRAILING_PREPARATION, "").trim();
    for (let i = 0; i < 5; i++) {
      const next = line.replace(PREPARATION_PHRASE, "").replace(PREPARATION_WORDS, "").trim();
      if (next === line) break;
      line = next;
    }
  }
  if (cannedChoppedTomatoes && /^(?:chopped|diced)\s+tomatoes?$/i.test(line)) line = "diced tomatoes";
  line = line.replace(/^sweet\s?corn$/i, "corn").replace(/^soured cream$/i, "sour cream");
  return line.replace(/[.;:]+$/, "").trim().slice(0, DEFAULT_MAX_INGREDIENT_LINE).toLowerCase();
}

function flattenIngredients(value) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw.flatMap((item) => typeof item === "string" ? [stripMarkup(item)] : item && typeof item === "object" ? flattenIngredients(item.text || item.name || item.itemListElement) : [])
    .map((line) => String(line).trim())
    .filter(Boolean);
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
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    const isSection = types.some((type) => String(type || "").toLowerCase().split(/[\/#]/).pop() === "howtosection") || value.itemListElement !== undefined;
    if (isSection) {
      if (value.name) flattenInstructions(value.name, output);
      if (value.text && normalizeWords(value.text) !== normalizeWords(value.name)) flattenInstructions(value.text, output);
      if (value.itemListElement) flattenInstructions(value.itemListElement, output);
    } else if (value.text) {
      // HowToStep.name often repeats its text or adds unrelated step metadata.
      flattenInstructions(value.text, output);
    } else if (value.name) {
      flattenInstructions(value.name, output);
    }
  }
  return output;
}

function collectInstructionSourceText(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInstructionSourceText(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "name", "itemListElement"]) {
      if (value[key] !== undefined) collectInstructionSourceText(value[key], output);
    }
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

function assertRecipeSourceBounds(ingredients, instructions) {
  const reject = (message) => {
    const error = new Error(message);
    error.code = "source-facts-limit";
    throw error;
  };
  if (ingredients.length > DEFAULT_MAX_INGREDIENTS) {
    reject(`Recipe lists more than ${DEFAULT_MAX_INGREDIENTS} ingredients.`);
  }
  if (ingredients.some((line) => line.length > DEFAULT_MAX_INGREDIENT_LINE)) {
    reject(`Recipe ingredient lines must be ${DEFAULT_MAX_INGREDIENT_LINE} characters or fewer.`);
  }
  if (instructions.length > DEFAULT_MAX_INSTRUCTION_STEPS) {
    reject(`Recipe has more than ${DEFAULT_MAX_INSTRUCTION_STEPS} direction steps.`);
  }
  if (instructions.some((line) => line.length > DEFAULT_MAX_INSTRUCTION_LINE)) {
    reject(`Recipe direction lines must be ${DEFAULT_MAX_INSTRUCTION_LINE} characters or fewer.`);
  }
  if (instructions.reduce((sum, line) => sum + line.length, 0) > DEFAULT_MAX_INSTRUCTIONS) {
    reject(`Recipe directions exceed the ${DEFAULT_MAX_INSTRUCTIONS}-character limit.`);
  }
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
  const rawInstructions = flattenInstructions(usable.recipeInstructions);
  assertRecipeSourceBounds(rawIngredients, rawInstructions);
  const ingredients = [...new Set(rawIngredients.map(normalizeIngredientLine).filter(Boolean))];
  const instructions = sanitizeInstructions(rawInstructions);
  assertSafeSourceText([usable.name, ...rawIngredients, ...collectInstructionSourceText(usable.recipeInstructions)]);
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

async function readCappedBody(response, maxBytes, signal) {
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
    const cancelOnAbort = () => {
      try {
        const cancelled = reader.cancel();
        if (cancelled && typeof cancelled.catch === "function") cancelled.catch(() => {});
      } catch { /* best effort */ }
    };
    if (signal?.aborted) cancelOnAbort();
    else signal?.addEventListener("abort", cancelOnAbort, { once: true });
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
      signal?.removeEventListener("abort", cancelOnAbort);
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

function createLiveRecipeService(options = {}) {
  // Production uses impit's browser-fingerprint client for recipe pages.
  const recipeFetch = options.recipeFetch || options.fetchRecipe || options.fetchImpl || defaultRecipeFetch();
  const dnsLookup = options.dnsLookup || options.resolveDns || dns.lookup.bind(dns);
  const reportFailure = typeof options.reportFailure === "function" ? options.reportFailure : () => null;
  const verifiedTtlMs = Number(options.verifiedTtlMs) > 0 ? Number(options.verifiedTtlMs) : DEFAULT_VERIFIED_TTL_MS;
  const maxBodyBytes = Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;
  const maxRedirects = Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0 ? options.maxRedirects : DEFAULT_MAX_REDIRECTS;
  const recipeTimeoutMs = Number(options.recipeTimeoutMs) > 0 ? Number(options.recipeTimeoutMs) : DEFAULT_RECIPE_TIMEOUT_MS;
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
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error("Recipe page request timed out.");
        error.code = "timeout";
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(url, { ...init, signal: controller.signal });
          const status = Number(response?.status || 0);
          const redirect = [301, 302, 303, 307, 308].includes(status);
          const type = String(responseHeader(response, "content-type") || "").toLowerCase();
          const isHtml = !type || type.includes("text/html") || type.includes("application/xhtml+xml");
          const body = !redirect && response?.ok && isHtml
            ? await readCappedBody(response, maxBodyBytes, controller.signal)
            : null;
          return { response, body };
        })(),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
      if (existingSignal) existingSignal.removeEventListener("abort", relayAbort);
    }
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
          const fetched = await timedFetch(recipeFetch, current.href, {
            redirect: "manual",
            headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "FridgeFuse/0.1 live recipe verifier" },
          }, recipeTimeoutMs);
          const response = fetched.response;
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
          const body = fetched.body;
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

  return {
    verifyUrl,
    validatePublicUrl,
    caches: { verified: verifiedCache, verifiedInflight },
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
};
