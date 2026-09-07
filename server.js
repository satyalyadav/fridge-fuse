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
    // Ephemeral/read-only serverless FS — memory + console carry it.
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

function aiFailureStatus(failure) {
  const providerStatus = Number(failure?.status);
  if (Number.isInteger(providerStatus) && providerStatus >= 500 && providerStatus <= 599) return providerStatus;
  return failure?.status === "no-key" ? 503 : 502;
}

async function airChat(messages, { maxTokens = 1200, wantJson = true, model = AIR_MODEL, schema = null, temperature } = {}) {
  // Returns { ok:true, data } or { ok:false, failure }
  if (!AIR_KEY) {
    const f = reportFailure("asu-air", "chat", {
      status: "no-key",
      message: "VOYAGER_KEY is required for AI requests.",
      model,
      hint: "Set VOYAGER_KEY before starting the app.",
    });
    return { ok: false, failure: f };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const body = { model, messages, max_tokens: maxTokens };
    if (Number.isFinite(temperature)) body.temperature = temperature;
    if (schema) body.response_format = { type: "json_schema", json_schema: { name: "meal_plan", strict: true, schema } };
    else if (wantJson) body.response_format = { type: "json_object" };
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

// ---------- data files (work both locally and from the serverless task root) ----------
function resolveDataPath(runtimeDir = __dirname, taskRoot = process.env.LAMBDA_TASK_ROOT, exists = fs.existsSync, filename = "prices.json") {
  const candidates = [path.join(runtimeDir, "data", filename)];
  if (taskRoot) candidates.push(path.join(taskRoot, "data", filename));
  return candidates.find((candidate) => exists(candidate)) || candidates[0];
}

const PRICES = JSON.parse(fs.readFileSync(resolveDataPath(), "utf8"));

// ---------- approved recipes (grounds AI meal generation) ----------
// The /api/plan system prompt is built from these exact recipe records. A
// publisher homepage is not evidence that a generated recipe exists.
const RECIPE_SOURCES = JSON.parse(fs.readFileSync(resolveDataPath(__dirname, process.env.LAMBDA_TASK_ROOT, fs.existsSync, "recipe-sources.json"), "utf8"));
if (!Array.isArray(RECIPE_SOURCES.sources) || RECIPE_SOURCES.sources.length === 0) {
  throw new Error("data/recipe-sources.json must contain a non-empty sources array");
}
const APPROVED_RECIPES = [];
const approvedRecipeUrls = new Set();
const catalogIngredientNames = new Set(PRICES.items.map((item) => item.name));
for (const source of RECIPE_SOURCES.sources) {
  if (!source || typeof source.name !== "string" || !source.name.trim() || typeof source.url !== "string" || !/^https?:\/\//.test(source.url)) {
    throw new Error("every approved recipe source needs a name and http(s) URL");
  }
  if (!Array.isArray(source.recipes) || source.recipes.length === 0) {
    throw new Error(`approved recipe source ${source.name} must contain recipes`);
  }
  const sourceOrigin = new URL(source.url).origin;
  for (const recipe of source.recipes) {
    const recipeUrl = typeof recipe?.url === "string" ? recipe.url : "";
    const parsedRecipeUrl = /^https?:\/\//.test(recipeUrl) ? new URL(recipeUrl) : null;
    const hasFacts = Number.isFinite(Number(recipe?.timeMin)) && Number(recipe.timeMin) > 0 &&
      Array.isArray(recipe?.equipment) && recipe.equipment.length > 0 &&
      Array.isArray(recipe?.ingredients) && recipe.ingredients.length > 0 &&
      recipe.ingredients.every((ingredient) => catalogIngredientNames.has(ingredient)) &&
      typeof recipe?.method === "string" && recipe.method.trim();
    if (!recipe || typeof recipe.title !== "string" || !recipe.title.trim() || !parsedRecipeUrl || parsedRecipeUrl.origin !== sourceOrigin || recipeUrl.replace(/\/$/, "") === source.url.replace(/\/$/, "") || !hasFacts) {
      throw new Error(`every approved recipe for ${source.name} needs an exact title, same-site recipe URL, time, equipment, catalog ingredients, and method`);
    }
    if (approvedRecipeUrls.has(recipeUrl)) throw new Error(`duplicate approved recipe URL: ${recipeUrl}`);
    approvedRecipeUrls.add(recipeUrl);
    APPROVED_RECIPES.push({ ...recipe, source: source.name });
  }
}

function recipesWithinTime(maxTimeMin) {
  const limit = Number(maxTimeMin);
  return Number.isFinite(limit) && limit > 0
    ? APPROVED_RECIPES.filter((recipe) => Number(recipe.timeMin) <= limit)
    : APPROVED_RECIPES;
}

function recipeSourcesContext(recipes = APPROVED_RECIPES) {
  return recipes
    .map((recipe) => `- recipeId: "recipe-${APPROVED_RECIPES.indexOf(recipe) + 1}"; sourceRecipe: ${JSON.stringify(recipe.title)}; source: ${JSON.stringify(recipe.source)}; sourceUrl: ${recipe.url}; verified time: ${recipe.timeMin} min; equipment: ${recipe.equipment.join(", ")}; catalog-ready ingredients: ${recipe.ingredients.join(", ")}; method outline: ${recipe.method}`)
    .join("\n");
}

function recipeFitsEquipment(recipe, equipment) {
  const appliances = new Set(EQUIPMENT_OPTIONS.map((option) => option.id));
  const available = new Set(equipment);
  return recipe.equipment.filter((item) => appliances.has(item)).every((item) => available.has(item));
}

function assertPlanEquipment(plan, equipment) {
  for (const dinner of plan.dinners) {
    const recipe = approvedRecipeForCitation(dinner.source, dinner.sourceRecipe, dinner.sourceUrl);
    if (!recipeFitsEquipment(recipe, equipment)) {
      throw new Error(`"${recipe.title}" requires ${recipe.equipment.join(" + ")}; available equipment: ${equipment.join(" + ") || "none"}`);
    }
    // A model must not add an unavailable appliance in its instructions either.
    let instructionText = normalizeDietText((dinner.steps || []).join(" "));
    for (const option of EQUIPMENT_OPTIONS.filter((option) => equipment.includes(option.id))) {
      for (const term of [option.id, ...(option.aliases || [])].sort((a, b) => b.length - a.length)) {
        instructionText = instructionText.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "g"), " ");
      }
    }
    for (const option of EQUIPMENT_OPTIONS) {
      if (equipment.includes(option.id)) continue;
      const terms = [option.id, ...(option.aliases || [])];
      if (terms.some((term) => dietPhraseMatcher(term)?.test(instructionText))) {
        throw new Error(`Cooking steps require unavailable equipment: ${option.id}`);
      }
    }
  }
  return plan;
}

function approvedRecipeForCitation(source, sourceRecipe, sourceUrl) {
  return APPROVED_RECIPES.find((approved) =>
    approved.source === source && approved.title === sourceRecipe && approved.url === sourceUrl
  ) || null;
}

function isApprovedRecipeCitation(source, sourceRecipe, sourceUrl) {
  return !!approvedRecipeForCitation(source, sourceRecipe, sourceUrl);
}

function assertDinnerMatchesRecipe(dinner, recipe, dinnerNumber, { exact = false } = {}) {
  const normalizeIngredient = (name) => {
    const resolved = resolveCatalogItem(name);
    return resolved?.name || String(name || "").trim().toLowerCase();
  };
  const pantryIngredients = new Set((dinner.usesPantry || []).map(normalizeIngredient).filter(Boolean));
  const needIngredients = new Set((dinner.needs || [])
    .map((need) => normalizeIngredient(typeof need === "string" ? need : need?.item))
    .filter(Boolean));
  const overlap = [...pantryIngredients].filter((name) => needIngredients.has(name));
  if (overlap.length) {
    throw new Error(`Dinner ${dinnerNumber} lists ${overlap.join(", ")} as both pantry food and a shopping need`);
  }
  const dinnerIngredients = new Set([...pantryIngredients, ...needIngredients]);
  const recipeIngredients = new Set(recipe.ingredients);
  const matchingIngredients = [...dinnerIngredients].filter((name) => recipeIngredients.has(name));

  if (exact && (dinnerIngredients.size !== recipeIngredients.size || matchingIngredients.length !== recipeIngredients.size)) {
    const listed = [...dinnerIngredients].join(", ") || "none";
    throw new Error(`Dinner ${dinnerNumber} repair must use the exact ingredient set for "${recipe.title}": planned ingredients are ${listed}`);
  }
  // A substitution is an adaptation; once fewer than half of either side still
  // matches, it is a different recipe wearing the old citation.
  if (!exact && (!dinnerIngredients.size || matchingIngredients.length * 2 < recipeIngredients.size ||
      matchingIngredients.length * 2 < dinnerIngredients.size)) {
    const listed = [...dinnerIngredients].join(", ") || "none";
    throw new Error(`Dinner ${dinnerNumber} does not match its cited recipe "${recipe.title}": planned ingredients are ${listed}`);
  }

  const time = Number(dinner.timeMin);
  const minimumTime = Math.max(1, Number(recipe.timeMin) * 0.75);
  const maximumTime = Number(recipe.timeMin) * 1.25;
  if (time < minimumTime || time > maximumTime) {
    throw new Error(`Dinner ${dinnerNumber} timeMin ${time} is not credible for the cited ${recipe.timeMin}-minute recipe "${recipe.title}"`);
  }
  // The card should describe the recipe it actually cites, not whichever
  // appliance happens to be first in the user's profile.
  dinner.equip = [...recipe.equipment];
}

// Typed words a student uses -> catalog item ("cheese" -> "cheddar"). Lives in
// the data file so the UI can fetch it instead of keeping a second copy.
const ITEM_ALIASES = PRICES.aliases || {};

// ---------- dietary restrictions (enforced, not just requested) ----------
// The plan prompt is built from this file AND every generated plan is checked
// against it. A model that ignores "no peanuts" must not reach the student, so
// a violating plan is repaired once and then rejected — never quietly served.
const DIET_RULES_DATA = JSON.parse(fs.readFileSync(resolveDataPath(__dirname, process.env.LAMBDA_TASK_ROOT, fs.existsSync, "diet-rules.json"), "utf8"));
if (!Array.isArray(DIET_RULES_DATA.rules) || DIET_RULES_DATA.rules.length === 0) {
  throw new Error("data/diet-rules.json must contain a non-empty rules array");
}
const isNonEmptyStringArray = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim());
for (const rule of DIET_RULES_DATA.rules) {
  if (!rule || typeof rule.id !== "string" || !rule.id.trim() || typeof rule.label !== "string" || !rule.label.trim()) {
    throw new Error("every diet rule needs an id and a label");
  }
  if (!isNonEmptyStringArray(rule.aliases) || !isNonEmptyStringArray(rule.forbids)) {
    throw new Error(`diet rule ${rule.id} needs non-empty aliases and forbids arrays`);
  }
  if (rule.allows !== undefined && !isNonEmptyStringArray(rule.allows)) {
    throw new Error(`diet rule ${rule.id} allows must be a non-empty string array when present`);
  }
  if (!isNonEmptyStringArray(rule.excludesTags)) {
    throw new Error(`diet rule ${rule.id} needs a non-empty excludesTags array`);
  }
  if (typeof rule.group !== "string" || !rule.group.trim()) {
    throw new Error(`diet rule ${rule.id} needs a group for the profile form`);
  }
  if (rule.note !== undefined && (typeof rule.note !== "string" || !rule.note.trim())) {
    throw new Error(`diet rule ${rule.id} note must be a non-empty string when present`);
  }
}
const DIET_RULES = DIET_RULES_DATA.rules;

// A tag typo would silently stop excluding an ingredient, so the catalog and the
// rules are checked against each other at startup rather than at dinner time.
const DIET_TAGS = new Set(DIET_RULES.flatMap((rule) => rule.excludesTags));
for (const item of PRICES.items) {
  if (!Array.isArray(item.tags)) {
    throw new Error(`price catalog item ${item.name} must declare a tags array (use [] when it contains none)`);
  }
  for (const tag of item.tags) {
    if (!DIET_TAGS.has(tag)) {
      throw new Error(`price catalog item ${item.name} carries tag "${tag}", which no diet rule excludes`);
    }
  }
}

// The catalog items each rule rules out, computed from the tags rather than
// listed by name. Adding an ingredient to data/prices.json with the right tags
// updates every affected option; there is no second list to keep in step.
function blocksForRule(rule) {
  return PRICES.items
    .filter((item) => (item.tags || []).some((tag) => rule.excludesTags.includes(tag)))
    .map((item) => item.name);
}

// The profile form renders itself from this, so an option can never appear in
// the form without being enforced — it is the same record the plan check uses.
// An option that blocks nothing carries a note explaining why, so it never
// looks broken: nothing in the Tempe catalog contains it yet.
const DIET_OPTIONS = DIET_RULES.map((rule) => ({
  id: rule.id,
  label: rule.label,
  group: rule.group,
  note: rule.note,
  aliases: rule.aliases,
  blocks: blocksForRule(rule),
}));

// Accepts the comma-joined string the profile saves, in any historic spelling.
// One resolver for the form, the prompt, and the post-generation check.
function parseDietSelections(diet) {
  return resolveDietRules(diet).map((rule) => DIET_OPTIONS.find((option) => option.id === rule.id));
}

function blockedIngredientsForDiet(diet) {
  const blocked = new Set();
  for (const option of parseDietSelections(diet)) {
    for (const ingredient of option.blocks) blocked.add(ingredient);
  }
  return blocked;
}

// Ingredient text arrives from three directions (the student, the model, the
// catalog) with different punctuation, so everything is flattened the same way
// before it is matched.
function normalizeDietText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dietPhraseMatcher(phrase, { plural = false } = {}) {
  const normalized = normalizeDietText(phrase);
  if (!normalized) return null;
  return new RegExp(`(^| )${escapeRegExp(normalized)}${plural ? "(e?s)?" : ""}( |$)`);
}

// Which of the student's restrictions this free-text diet string turns on.
function resolveDietRules(dietText) {
  const text = normalizeDietText(dietText);
  if (!text) return [];
  return DIET_RULES.filter((rule) =>
    rule.aliases.some((alias) => {
      const matcher = dietPhraseMatcher(alias);
      return matcher ? matcher.test(text) : false;
    })
  );
}

// "peanut butter" must not trip the dairy-free rule's "butter", so allowed
// substitutes are removed from the text before forbidden terms are matched.
function stripAllowedPhrases(text, rule) {
  let scanned = ` ${text} `;
  for (const phrase of rule.allows || []) {
    const normalized = normalizeDietText(phrase);
    if (!normalized) continue;
    scanned = scanned.replace(new RegExp(`(^| )${escapeRegExp(normalized)}(e?s)?( |$)`, "g"), "  ");
  }
  return scanned.replace(/\s+/g, " ").trim();
}

function findForbiddenTerm(text, rule) {
  const scanned = stripAllowedPhrases(normalizeDietText(text), rule);
  if (!scanned) return null;
  for (const term of rule.forbids) {
    const matcher = dietPhraseMatcher(term, { plural: true });
    if (matcher && matcher.test(scanned)) return term;
  }
  return null;
}

// What the catalog says a named ingredient contains. Resolution is strict on
// purpose: "eggs" and the alias "egg" resolve, a whole cooking step does not.
// Loose matching here would read "a splash of almond milk" as milk.
function catalogTagsFor(name) {
  const q = normalizeDietText(name);
  if (!q) return null;
  const direct = PRICES.items.find((item) => normalizeDietText(item.name) === q);
  if (direct) return direct.tags || [];
  const aliasTarget = Object.entries(ITEM_ALIASES).find(([alias]) => normalizeDietText(alias) === q)?.[1];
  if (!aliasTarget) return null;
  const aliased = PRICES.items.find((item) => normalizeDietText(item.name) === normalizeDietText(aliasTarget));
  return aliased ? aliased.tags || [] : null;
}

// The catalog's own answer for an ingredient it knows, which is exact where word
// matching can only be careful: "gluten free pasta" is not pasta.
function findCatalogTagConflict(name, rule) {
  const tags = catalogTagsFor(name);
  if (!tags) return null;
  const hit = tags.find((tag) => rule.excludesTags.includes(tag));
  return hit ? `${String(name).trim()} (${hit})` : null;
}

// An ingredient the catalog knows is judged by its tags alone — they are exact,
// and the word net would fail an alias like "gf pasta" for containing "pasta".
// Anything the catalog has never heard of falls back to the word net.
function findIngredientConflict(name, rule) {
  if (catalogTagsFor(name)) return findCatalogTagConflict(name, rule);
  return findForbiddenTerm(name, rule);
}

// Pantry items the student already owns but must not be cooked with. They are
// reported, never silently dropped — the pantry is theirs, the plan is ours.
function pantryDietConflicts(pantry, rules) {
  if (!rules.length) return [];
  return (pantry || []).filter((item) =>
    rules.some((rule) => findIngredientConflict(item, rule))
  );
}

function dietRulesContext(rules) {
  if (!rules.length) return "";
  return rules
    .map((rule) => {
      const allowed = (rule.allows || []).length ? ` Allowed substitutes: ${rule.allows.join(", ")}.` : "";
      return `- ${rule.label} — never use, buy, or mention: ${rule.forbids.join(", ")}.${allowed}`;
    })
    .join("\n");
}

// Every field a forbidden ingredient could hide in, including the cooking steps
// (a vegan plan can pass its shopping list and still say "brush with butter").
function findDietViolations(plan, rules) {
  if (!rules.length) return [];
  // [where, text, isNamedIngredient] — only a named ingredient can be looked up
  // in the catalog; prose gets the word net alone.
  const fields = [];
  for (const [index, dinner] of (plan.dinners || []).entries()) {
    const where = `dinner ${index + 1} "${dinner?.title || "untitled"}"`;
    fields.push([`${where} title`, dinner?.title, false]);
    for (const item of dinner?.usesPantry || []) fields.push([`${where} pantry use`, item, true]);
    for (const need of dinner?.needs || []) fields.push([`${where} shopping need`, typeof need === "object" && need ? need.item : need, true]);
    for (const step of dinner?.steps || []) fields.push([`${where} cooking steps`, step, false]);
  }
  for (const entry of plan.shoppingList || []) fields.push(["the shopping list", entry?.item, true]);

  const violations = [];
  for (const [where, text, isIngredient] of fields) {
    for (const rule of rules) {
      const term = isIngredient ? findIngredientConflict(text, rule) : findForbiddenTerm(text, rule);
      if (term) violations.push({ rule: rule.label, term, where });
    }
  }
  return violations;
}

function assertPlanRespectsDiet(plan, rules) {
  const violations = findDietViolations(plan, rules);
  if (!violations.length) return plan;
  const detail = violations
    .slice(0, 6)
    .map((violation) => `${violation.term} in ${violation.where} breaks "${violation.rule}"`)
    .join("; ");
  throw new Error(`AI plan breaks the user's dietary restrictions: ${detail}`);
}

const STORES = Object.keys(PRICES.stores);

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
  const q = String(itemName || "").toLowerCase().trim();
  if (!q) return null;
  const exact = PRICES.items.find((it) => it.name.toLowerCase() === q);
  if (exact) return exact;
  const aliased = ITEM_ALIASES[q];
  if (aliased) {
    const hit = PRICES.items.find((it) => it.name.toLowerCase() === String(aliased).toLowerCase());
    if (hit) return hit;
  }
  // Ingredient identity must survive pricing unchanged, especially substitutes.
  return null;
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
    const missing = [...unmatched];
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
    (a.complete ? 0 : b.itemCount - a.itemCount) ||
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
    requestedCount: resolved.length + unmatched.length,
    options,
    cheapestStoreId: options[0]?.storeId || null,
    savingsVsWorst,
    zip: PRICES.zip,
    locationNote: STORE_DATA.note,
    priceNote: PRICES.note,
    note: notes.join(" "),
  };
}

// ---------- preference catalogs ----------
// One source of truth for what the profile can offer. GET /api/preferences
// serves this to both the welcome wizard and the profile drawer, and
// handlePlanRequest turns a selection into a concrete exclusion list for the
// AI prompt, so an option can never appear in the form without being enforced.
// `blocks` lists catalog ingredients the option rules out. An empty list is
// honest: nothing in the Tempe catalog currently contains it, so the option
// carries a `note` explaining why instead of silently doing nothing.
// `vibe` is a short, human phrase used client-side to describe what a kitchen
// setup is good for, without claiming a precise recipe count the AI-only
// planner can't guarantee ahead of a real request.
const EQUIPMENT_OPTIONS = [
  { id: "microwave", label: "Microwave", hint: "Most dorm rooms", vibe: "quick bowls and melts" },
  { id: "stove", label: "Stovetop or hot plate", aliases: ["stovetop", "hot plate", "burner"], hint: "Burner of any kind", vibe: "sautes, stir-fries, and sauces" },
  { id: "oven", label: "Oven", hint: "Full-size oven", vibe: "roasts, bakes, and sheet-pan dinners" },
  { id: "toaster oven", label: "Toaster oven", hint: "Counter-top oven", vibe: "small-batch toasting and melts" },
  { id: "air fryer", label: "Air fryer", hint: "Crisps without a stove", vibe: "crispy sides with little oil" },
  { id: "rice cooker", label: "Rice cooker", hint: "Also steams and simmers", vibe: "hands-off rice and grains" },
  { id: "kettle", label: "Electric kettle", aliases: ["electric kettle"], hint: "Boiling water only", vibe: "instant, no-cook meals" },
  { id: "slow cooker", label: "Slow cooker", aliases: ["crock pot", "crockpot"], hint: "Long, unattended cooking", vibe: "low-effort, cook-while-away meals" },
  { id: "pressure cooker", label: "Pressure cooker", aliases: ["instant pot"], hint: "Instant Pot and similar", vibe: "fast one-pot meals" },
  { id: "blender", label: "Blender", hint: "Smoothies and sauces", vibe: "smoothies and blended sauces" },
  { id: "sandwich press", label: "Sandwich press", aliases: ["panini press", "grill press"], hint: "Panini or grill press", vibe: "pressed sandwiches and paninis" },
];

// A dinner's needs are ingredient NAMES, not quantities. The model reliably
// knows which ingredients a recipe uses and reliably misjudges how much, so the
// plan requests names and the server shops whole packages: one package of each
// ingredient per dinner that uses it, shared across the plan.
function needName(raw) {
  const rawName = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.item : raw;
  const name = String(rawName ?? "").trim().toLowerCase();
  if (!name) throw new Error("a need is missing its item name");
  const catalogItem = findPrice(name);
  if (!catalogItem) {
    throw new Error(`AI plan includes ingredients outside the price catalog: ${name}`);
  }
  return catalogItem.name;
}

// A swap has to be enforced, not requested. The prompt lets a dinner's title
// describe the adapted result, so the same curated recipe can come back under a
// new name — the recipe identity is what the exclusion has to match.
function findRepeatedExclusion(plan, excluded) {
  if (!excluded.length) return null;
  const unwanted = new Set(excluded.map((entry) => normalizeDietText(entry)).filter(Boolean));
  for (const [index, dinner] of (plan.dinners || []).entries()) {
    for (const field of ["sourceRecipe", "title"]) {
      const value = normalizeDietText(dinner?.[field]);
      if (value && unwanted.has(value)) {
        return `dinner ${index + 1} is "${dinner[field]}" again, which the user asked to swap out`;
      }
    }
  }
  return null;
}

// A dinner requires ingredient names; a store sells packages. Each dinner that
// needs an ingredient adds one package of it, and the same package covers every
// dinner sharing it — which is why shared ingredients are called out on the
// receipt. Nothing here is estimated from amounts the model guessed.
function groundShoppingPlan(plan) {
  const demand = new Map();
  for (const [dinnerIndex, dinner] of (plan.dinners || []).entries()) {
    const mealLabel = `Night ${dinnerIndex + 1}: ${dinner.title}`;
    for (const raw of dinner.needs || []) {
      const name = needName(raw);
      const entry = demand.get(name) || { dinners: 0, sharedBy: [] };
      entry.dinners += 1;
      if (!entry.sharedBy.includes(mealLabel)) entry.sharedBy.push(mealLabel);
      demand.set(name, entry);
    }
  }

  const shoppingList = [];
  for (const [name, entry] of demand) {
    const cheapest = cheapestPack(name);
    shoppingList.push({
      ...cheapest,
      qty: entry.dinners,
      sharedBy: entry.sharedBy
    });
  }

  // Quote one complete checkout, using the same deterministic comparison as Shop.
  let checkoutStore = null;
  if (shoppingList.length) {
    const comparison = optimizeCart({ items: shoppingList.map((item) => ({ name: item.item, qty: item.qty })), lat: plan.shoppingLocation?.lat, lng: plan.shoppingLocation?.lng });
    if (shoppingList.some((item) => item.qty > MAX_ITEM_QTY)) throw new Error("This plan exceeds the supported 99 packages per ingredient. Reduce dinners.");
    const best = comparison.options.find((option) => option.complete);
    if (!best) throw new Error("No nearby catalog store stocks the complete shopping list.");
    checkoutStore = { id: best.storeId, name: best.name, chain: best.chain };
    for (const item of shoppingList) {
      const price = findPrice(item.item).prices[best.chain];
      Object.assign(item, { store: best.chain, pack: price.pack, packPrice: price.price });
    }
  }
  return {
    ...plan,
    checkoutStore,
    shoppingList,
    leftovers: [],
    totalCost: +shoppingList.reduce((total, item) => total + item.packPrice * item.qty, 0).toFixed(2)
  };
}

function parseAiPlan(content, expectedDinners, { maxTimeMin = null, deferRecipeGrounding = false } = {}) {
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
    if (dinner.recipeId !== undefined) {
      const recipeIndex = /^recipe-([1-9]\d*)$/.exec(String(dinner.recipeId));
      const selected = recipeIndex && APPROVED_RECIPES[Number(recipeIndex[1]) - 1];
      if (!selected) throw new Error(`Dinner ${index + 1} has an unknown recipeId`);
      dinner.source = selected.source;
      dinner.sourceRecipe = selected.title;
      dinner.sourceUrl = selected.url;
    }
    const approvedRecipe = approvedRecipeForCitation(dinner.source, dinner.sourceRecipe, dinner.sourceUrl);
    if (!approvedRecipe) {
      throw new Error(`Dinner ${index + 1} needs an exact sourceRecipe/source/sourceUrl match from the approved recipe catalog`);
    }
    if (dinner.adaptationNote !== undefined && typeof dinner.adaptationNote !== "string") {
      throw new Error(`Dinner ${index + 1} adaptationNote must be a string when present`);
    }
    for (const field of ["usesPantry", "needs", "steps"]) {
      if (!Array.isArray(dinner[field])) throw new Error(`Dinner ${index + 1} needs a ${field} array`);
    }
    if (dinner.usesPantry.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`Dinner ${index + 1} usesPantry must contain ingredient names`);
    }
    if (dinner.steps.some((step) => typeof step !== "string" || !step.trim())) throw new Error(`Dinner ${index + 1} needs text cooking steps`);
    if (dinner.steps.length === 0) throw new Error(`Dinner ${index + 1} needs at least one cooking step`);
    if (!deferRecipeGrounding) {
      for (const need of dinner.needs) {
        try {
          needName(need);
        } catch (error) {
          throw new Error(`Dinner ${index + 1}: ${error.message}`);
        }
      }
      assertDinnerMatchesRecipe(dinner, approvedRecipe, index + 1);
    }
    if (Number.isFinite(Number(maxTimeMin)) &&
        (Number(dinner.timeMin) > Number(maxTimeMin) || Number(approvedRecipe.timeMin) > Number(maxTimeMin))) {
      throw new Error(`Dinner ${index + 1} exceeds the requested ${maxTimeMin}-minute limit: cited recipe "${approvedRecipe.title}" takes ${approvedRecipe.timeMin} minutes`);
    }
  }
  // The model's own shoppingList, leftovers, and totalCost are ignored rather
  // than validated; groundShoppingPlan computes them from the needs.
  return plan;
}

function assertPlanUsesExactRecipes(plan) {
  for (const [index, dinner] of (plan.dinners || []).entries()) {
    const recipe = approvedRecipeForCitation(dinner.source, dinner.sourceRecipe, dinner.sourceUrl);
    assertDinnerMatchesRecipe(dinner, recipe, index + 1, { exact: true });
  }
  return plan;
}

function reconcilePantryOwnership(plan, pantry) {
  const pantryNames = new Set((pantry || [])
    .map((name) => resolveCatalogItem(name)?.name || String(name || "").trim().toLowerCase())
    .filter(Boolean));
  return {
    ...plan,
    dinners: (plan.dinners || []).map((dinner) => {
      const ingredientOrder = [];
      const seen = new Set();
      const suppliedNeeds = new Map();
      const remember = (rawName) => {
        const name = resolveCatalogItem(rawName)?.name || String(rawName || "").trim().toLowerCase();
        if (name && !seen.has(name)) {
          seen.add(name);
          ingredientOrder.push(name);
        }
        return name;
      };
      for (const name of dinner.usesPantry || []) remember(name);
      for (const need of dinner.needs || []) {
        const rawName = typeof need === "string" ? need : need?.item;
        const name = remember(rawName);
        if (name) suppliedNeeds.set(name, need);
      }
      return {
        ...dinner,
        usesPantry: ingredientOrder.filter((name) => pantryNames.has(name)),
        needs: ingredientOrder
          .filter((name) => !pantryNames.has(name))
          .map((name) => suppliedNeeds.get(name) || name)
      };
    })
  };
}

function canonicalizeRepairedPlan(plan, pantry) {
  const pantryNames = new Set((pantry || []).map((name) => resolveCatalogItem(name)?.name).filter(Boolean));
  return {
    ...plan,
    dinners: (plan.dinners || []).map((dinner) => {
      const recipe = approvedRecipeForCitation(dinner.source, dinner.sourceRecipe, dinner.sourceUrl);
      const suppliedNeeds = new Map((dinner.needs || []).map((need) => {
        const rawName = typeof need === "string" ? need : need?.item;
        return [resolveCatalogItem(rawName)?.name || String(rawName || "").trim().toLowerCase(), need];
      }));
      return {
        ...dinner,
        title: recipe.title,
        adaptationNote: "",
        timeMin: Number(recipe.timeMin),
        equip: [...recipe.equipment],
        usesPantry: recipe.ingredients.filter((name) => pantryNames.has(name)),
        needs: recipe.ingredients
          .filter((name) => !pantryNames.has(name))
          .map((name) => suppliedNeeds.get(name) || name),
        steps: [recipe.method]
      };
    })
  };
}

async function repairAiPlan(chat, _content, expectedDinners, initialError, requirements, maxTimeMin = null, requireExactRecipe = true, recipes = recipesWithinTime(maxTimeMin)) {
  const ingredientRule = requireExactRecipe
    ? "Adaptations are not allowed during repair: copy one record's complete ingredient set with no additions, omissions, or substitutions, and use an empty adaptationNote."
    : "Make only the dietary substitutions required by the original restrictions, name them in adaptationNote, and keep the result recognizably grounded in one record.";
  return chat([
    {
      role: "system",
      content: `Start a new FridgeFuse meal plan from the original requirements. The earlier response was rejected, so do not preserve or imitate it. Reply ONLY with valid JSON containing exactly ${expectedDinners} dinners and notes. Prefer the exact recipeId from the catalog; the server supplies its citation fields. Each dinner must have a non-empty title, numeric timeMin, arrays named usesPantry, needs, and steps, and an exact sourceRecipe/source/sourceUrl triple from this curated recipe catalog. ${ingredientRule} usesPantry is the intersection of that record's ingredients and the user's pantry, not a copy of the pantry. Put every remaining record ingredient in needs. An ingredient must never appear in both arrays. Keep timeMin equal to the record's verified time and base the steps on its method. Every selected record's verified time must fit the user's requested maximum; choose a different curated record when one takes too long:\n${recipeSourcesContext(recipes)} Every entry in needs must be a plain ingredient NAME string from the supplied price catalog — no amounts or units, the server buys whole packages. Do not return shoppingList, leftovers, or totalCost — the server computes them. Do not add commentary or Markdown fences.`
    },
    {
      role: "user",
      content: `Original requirements:\n${requirements}\n\nWhy the earlier response was rejected:\n${initialError.message}\n\nStart over from the original requirements and return a new plan.`
    }
  ], { maxTokens: Math.max(1800, expectedDinners * 1400) });
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
    dietRules: DIET_RULES.map((rule) => rule.label),
    zip: PRICES.zip,
    failures: failures.length,
  });
});

app.get("/api/models", async (req, res) => {
  if (!AIR_KEY) {
    const failure = reportFailure("asu-air", "models", {
      status: "no-key", message: "VOYAGER_KEY not set.", hint: "export VOYAGER_KEY=...",
    });
    return res.status(aiFailureStatus(failure)).json({ ok: false, failure });
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
    return res.status(aiFailureStatus(out.failure)).json({ ok: false, failure: out.failure });
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
    const failure = reportFailure("asu-air", "vision-parse", {
      status: "parse-error", message: `Could not parse vision JSON: ${e.message}`,
    });
    res.status(aiFailureStatus(failure)).json({ ok: false, failure });
  }
}

app.post("/api/vision", handleVisionRequest);

// System prompt for AI meal generation. Grounded to exact, curated recipe
// records in data/recipe-sources.json rather than publisher homepages, and
// carrying the user's dietary restrictions when they have any.
function buildPlanSystemPrompt(priceCtx, dietCtx = "", maxTimeMin = null, recipes = recipesWithinTime(maxTimeMin)) {
  const sourcesCtx = recipeSourcesContext(recipes);
  const dietSection = dietCtx
    ? `\nDietary restrictions (STRICT — these are safety constraints):
- The restrictions below are absolute. NEVER put a forbidden ingredient in a title, usesPantry, needs, steps, or notes — not as a garnish, not as an optional topping, not as a "serve with" suggestion.
- A forbidden ingredient stays forbidden even when the user already has it in their pantry. Leave it in the pantry and cook something else.
- Choose a curated recipe that already fits when possible. A compliant substitution is allowed only when the result still passes the recipe-match rules below, and must be named in "adaptationNote".
- If a cited recipe cannot stay recognizable after a safe substitution, choose a different curated recipe rather than serving a forbidden ingredient.
${dietCtx}`
    : "";
  return `You are FridgeFuse, a student meal planner for Tempe AZ 85281. Reply ONLY with JSON:
{"dinners":[{"recipeId":"recipe-1","title":"...","sourceRecipe":"...","source":"...","sourceUrl":"...","adaptationNote":"","timeMin":20,"protein":25,"carbs":50,"fiber":6,"usesPantry":["..."],"needs":["..."],"steps":["..."]}],
"notes":"..."}
Use recipeId from a curated record for every dinner. The server fills sourceRecipe, source, and sourceUrl from that ID; you may omit those three fields.
Rules: plan EXACTLY the requested number of dinners. The user is a freshman cook, so give concrete beginner-safe steps and only use the listed equipment. First use food marked use-soon, then minimize unique purchases, stay within budget, and keep cooking easy. Prefer purchases shared across dinners. Put only missing ingredients in needs; pantry items cost $0. Respect time, equipment, and dietary restrictions.
Ingredients (REQUIRED): needs is a plain list of ingredient NAME strings from the price catalog — no amounts, units, or packages. Do NOT return shoppingList, leftovers, or totalCost — the server does the package arithmetic from its own catalog. Price context: ${priceCtx}.
Recipe grounding (STRICT):
- Select every dinner from the curated recipe records below. NEVER invent a source recipe, cite a publisher homepage, or use an unlisted recipe.
- Prefer each selected record's exact ingredient list. Put its pantry-owned ingredients in usesPantry and its missing ingredients in needs. Owning an unrelated pantry item does not mean it belongs in every dinner.
- Treat each record's verified ingredients, time, and method outline as authoritative. The union of usesPantry and needs must retain at least half of the cited ingredients, and at least half of the dinner ingredients must come from that record. Keep timeMin within 25% of the verified time. The server checks all three rules.
- Use adaptationNote for small ingredient changes. If those limits do not work for the user's pantry, budget, equipment, time, or diet, select another curated recipe. Do not rely on other knowledge about the publisher's site.
- Copy "sourceRecipe", "source", and "sourceUrl" from one record exactly. The server rejects any mismatched title, publisher, or URL.
- The dinner "title" may describe the adapted result. State every ingredient substitution, addition, or omission in "adaptationNote". Use "" only when the ingredient list follows the selected record without changes.
- Never keep a citation after turning its recipe into a different meal. Select a better-matching record instead.
Curated recipes:
${sourcesCtx}${dietSection}`;
}

async function handlePlanRequest(req, res, { chat = airChat } = {}) {
  const { pantry = [], budget = 30, dinners = 3, maxTimeMin = 30,
          equipment = ["stove"], diet = "", useSoon = [], request = "", exclude = [], swapIndex, previousDinners, includeRecipe = "", shoppingLocation } = req.body || {};
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
  if (typeof includeRecipe !== "string") return res.status(400).json({ ok: false, failure: { message: "includeRecipe must be a recipe title" } });
  const swapping = Number.isInteger(swapIndex) && Array.isArray(previousDinners) && swapIndex >= 0 && swapIndex < previousDinners.length && previousDinners.length <= 7;
  const safePantry = asStringArray(pantry, []);
  const safeEquipment = asStringArray(equipment, ["stove"]);
  const safeUseSoon = asStringArray(useSoon, []);
  const safeExclude = asStringArray(exclude, []).filter((name) => normalizeDietText(name) !== normalizeDietText(includeRecipe));
  const safeDiet = typeof diet === "string" ? diet : "";
  const dietRules = resolveDietRules(safeDiet);
  const dietCtx = dietRulesContext(dietRules);
  // Pantry items the diet rules out are named as off-limits rather than hidden,
  // and never offered as use-soon food the model should cook first.
  const offLimitsPantry = pantryDietConflicts(safePantry, dietRules);
  const cookablePantry = safePantry.filter((item) => !offLimitsPantry.includes(item));
  const cookableUseSoon = safeUseSoon.filter((item) => !offLimitsPantry.includes(item));
  // Keep the profile catalog's user-facing phrasing in the prompt so advisory
  // notes (for catalog gaps like halal/kosher) still reach the model.
  const dietSelections = parseDietSelections(safeDiet);
  const dietBlocked = [...blockedIngredientsForDiet(safeDiet)];
  const dietGuidance = dietSelections.length
    ? ` Hard exclusions from the price catalog: ${dietBlocked.length ? dietBlocked.join(", ") : "none from this catalog"} (from: ${dietSelections.map((o) => o.label).join(", ")}).${dietSelections.some((o) => o.note) ? ` Also note: ${dietSelections.filter((o) => o.note).map((o) => o.note).join(" ")}` : ""}`
    : "";
  const priceCtx = PRICES.items.map((i) => {
    const c = cheapestPack(i.name);
    return `${i.name} (~${c.pack} @ ${c.store} $${c.packPrice})`;
  }).join("; ");
  const offLimitsCtx = offLimitsPantry.length
    ? ` Pantry items you must NOT cook with or mention (they break the diet): ${offLimitsPantry.join(", ")}.`
    : "";
  const eligibleRecipes = recipesWithinTime(maxTimeMin).filter((recipe) => recipeFitsEquipment(recipe, safeEquipment));
  if (!eligibleRecipes.length) return res.status(422).json({ ok: false, failure: { message: "No curated recipe fits your available equipment and time. Try more time or another appliance." } });
  const requestedCount = swapping ? 1 : asDinners(dinners, 3);
  const planningMessages = [
    { role: "system", content: buildPlanSystemPrompt(priceCtx, dietCtx, maxTimeMin, eligibleRecipes) },
    { role: "user", content: `Pantry: ${cookablePantry.join(", ") || "(empty)"}. Use soon: ${cookableUseSoon.join(", ") || "none"}. Budget total $${budget} for the whole plan. Dinners: ${requestedCount}. Max ${maxTimeMin} min each. Equipment: ${safeEquipment.join(", ")}. Diet/notes: ${safeDiet || "none"}.${dietGuidance}${offLimitsCtx} Do NOT use these recipes again, under any title: ${safeExclude.join(", ") || "none"}. Choose a different curated record instead. Latest request: ${request || "build the best plan"}.${includeRecipe ? ` MUST include this curated recipe: ${includeRecipe}.` : ""}` },
  ];
  const out = await chat(planningMessages, { maxTokens: Math.max(1800, requestedCount * 1400) });
  if (!out.ok) {
    return res.status(aiFailureStatus(out.failure)).json({ ok: false, failure: out.failure });
  }
  const expectedDinners = requestedCount;
  const finalize = (parsed) => {
    assertPlanEquipment(parsed, safeEquipment);
    if (!dietRules.length) assertPlanUsesExactRecipes(parsed);
    let combined = parsed;
    if (swapping) {
      // Never trust a saved client plan as a way around current safety checks.
      const retained = previousDinners.map((dinner, index) => index === swapIndex ? parsed.dinners[0] : dinner);
      combined = parseAiPlan(JSON.stringify({ dinners: retained }), retained.length, { maxTimeMin });
      assertPlanEquipment(combined, safeEquipment);
    }
    const owned = reconcilePantryOwnership(combined, cookablePantry);
    const priced = groundShoppingPlan({ ...assertPlanRespectsDiet(owned, dietRules), shoppingLocation });
    assertPlanRespectsDiet(priced, dietRules);
    if (includeRecipe && !priced.dinners.some((dinner) => normalizeDietText(dinner.sourceRecipe) === normalizeDietText(includeRecipe))) throw new Error(`The plan did not include ${includeRecipe}`);
    return priced;
  };
  const content = out.data?.choices?.[0]?.message?.content;
  try {
    const parsed = parseAiPlan(content, expectedDinners, { maxTimeMin });
    const plan = finalize(parsed);
    const repeated = findRepeatedExclusion(swapping ? { dinners: [plan.dinners[swapIndex]] } : plan, safeExclude);
    if (repeated) throw new Error(repeated);
    return res.json({ ok: true, model: AIR_MODEL, diet: safeDiet, dietRules: dietRules.map((rule) => rule.id), offLimitsPantry, ...plan });
  } catch (initialError) {
    const repaired = await repairAiPlan(chat, content, expectedDinners, initialError, `${planningMessages[1].content}\n\nPrice catalog:\n${priceCtx}${dietCtx ? `\n\nDietary restrictions (absolute):\n${dietCtx}` : ""}`, maxTimeMin, dietRules.length === 0, eligibleRecipes);
    if (!repaired.ok) {
      const failure = repaired.failure || reportFailure("asu-air", "plan-repair", {
        status: "repair-failed",
        message: `Could not repair AI plan: ${initialError.message}`,
      });
      return res.status(aiFailureStatus(failure)).json({ ok: false, failure });
    }
    try {
      const repairedContent = repaired.data?.choices?.[0]?.message?.content;
      const parsed = parseAiPlan(repairedContent, expectedDinners, {
        maxTimeMin,
        deferRecipeGrounding: dietRules.length === 0
      });
      const dietSafe = assertPlanRespectsDiet(reconcilePantryOwnership(parsed, cookablePantry), dietRules);
      const repairedPlan = dietRules.length ? dietSafe : canonicalizeRepairedPlan(dietSafe, cookablePantry);
      const plan = finalize(dietRules.length ? repairedPlan : assertPlanUsesExactRecipes(repairedPlan));
      // The curated catalog is small, and equipment and budget narrow it
      // further. When nothing else fits, saying so beats a silent no-op.
      const stillRepeated = findRepeatedExclusion(swapping ? { dinners: [plan.dinners[swapIndex]] } : plan, safeExclude);
      if (swapping && stillRepeated) return res.status(422).json({ ok: false, failure: { message: "No different recipe fits this swap. Your existing plan is unchanged." } });
      return res.json({
        ok: true, model: AIR_MODEL, repaired: true, diet: safeDiet,
        dietRules: dietRules.map((rule) => rule.id), offLimitsPantry,
        swapUnavailable: stillRepeated ? true : undefined,
        ...plan
      });
    } catch (repairError) {
      const failure = reportFailure("asu-air", "plan-repair", {
        status: "parse-error",
        message: `Could not repair AI plan: ${repairError.message}`,
        initialMessage: initialError.message,
      });
      return res.status(aiFailureStatus(failure)).json({ ok: false, failure });
    }
  }
}

app.post("/api/plan", handlePlanRequest);

const { createInterpreter } = require("./lib/chat-intents");
const interpretChat = createInterpreter({ chat: airChat, extractJson });
app.post("/api/chat/interpret", async (req, res) => {
  try {
    const result = await interpretChat(req.body?.message, Array.isArray(req.body?.pantry) ? req.body.pantry : []);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(error.status || 502).json({ ok: false, failure: reportFailure("asu-air", "interpret", { message: error.message }) });
  }
});


// The profile form renders itself from this, so a new option never has to be
// added in two places. Dinners and minutes-per-meal are deliberately absent:
// those change per request and belong to the chat, which already parses them
// ("3 easy dinners", "15 minutes") — asking for them here would just be a
// second, staler place for the same value to live.
app.get("/api/preferences", (req, res) => {
  res.json({
    ok: true,
    diets: DIET_OPTIONS.map(({ id, label, group, note, blocks, aliases }) => ({
      id, label, group, note, aliases, restricts: blocks.length,
    })),
    equipment: EQUIPMENT_OPTIONS,
    limits: { budget: { min: 5, max: 100 } },
    disclaimer: "Preferences filter suggestions from a small mock catalog. They are not an allergy-safety guarantee — always check labels.",
  });
});

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
        message: `Live fetch ${blocked ? "looks blocked as automated traffic" : `HTTP ${r.status}`} — this is why v0 prices are mock/harvested.`,
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
// can keep using the existing module API.
module.exports = app;
Object.assign(module.exports, {
  app, cheapestPack, findPrice, extractJson, PRICES, STORES, interpretChat, airChat,
  RECIPE_SOURCES, APPROVED_RECIPES, approvedRecipeForCitation, isApprovedRecipeCitation, assertDinnerMatchesRecipe,
  buildPlanSystemPrompt, reportFailure, resolveDataPath,
  DEFAULT_AIR_MODEL, AIR_MODEL, AIR_VISION_MODEL, AIR_VISION_VERIFY_MODEL,
  handlePlanRequest, handleVisionRequest, normalizeVisionResult,
  haversineMiles, isValidCoordinate, resolveCatalogItem, normalizeCartItems, optimizeCart,
  describeLocation, reverseGeocode, handleGeoDescribe,
  STORE_DATA, BRANCHES, DEFAULT_ORIGIN, ITEM_ALIASES,
  DIET_RULES, resolveDietRules, findForbiddenTerm, findDietViolations,
  assertPlanRespectsDiet, pantryDietConflicts, dietRulesContext,
  catalogTagsFor, findCatalogTagConflict, findIngredientConflict,
  DIET_OPTIONS, EQUIPMENT_OPTIONS, parseDietSelections, blockedIngredientsForDiet,
  needName, groundShoppingPlan,
  findRepeatedExclusion
});

if (require.main === module) {
  // 0.0.0.0 so a phone on the same WiFi can reach the demo.
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`FridgeFuse v0 on http://localhost:${PORT}`);
    console.log(`AIR: ${AIR_BASE} text=${AIR_MODEL} vision=${AIR_VISION_MODEL} visionVerify=${AIR_VISION_VERIFY_MODEL} key=${AIR_KEY ? "set" : "MISSING (AI unavailable)"}`);
  });
}
