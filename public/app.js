const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "fridgefuse-state-v2";
const MAX_VISION_IMAGE_EDGE = 1024;

const DEFAULT_STATE = {
  profile: {
    displayName: "",
    // false until the first-run wizard is completed once.
    onboarded: false
  },
  pantry: [],
  constraints: {
    budget: 20,
    dinners: 3,
    maxTimeMin: 20,
    equipment: ["microwave"],
    diet: ""
  },
  excludedTitles: [],
  plan: null,
  messages: [],
  groceryList: [],
  savedRecipes: [],
  offLimitsPantry: [],
  location: null
};

const MAX_EXCLUDED = 20;
const MAX_MESSAGES = 30;
const MAX_GROCERY_ITEMS = 50;
const MAX_SAVED_RECIPES = 40;
const MAX_GROCERY_QTY = 99;
const PROFILE_EXTRA_DIET_TERMS = ["peanut allergy", "lactose intolerant", "celiac"];

function addExclusion(title) {
  if (!title) return;
  state.excludedTitles = [...new Set([...state.excludedTitles, title])].slice(-MAX_EXCLUDED);
}

function isLegacyRecipeCitation(dinner) {
  if (!String(dinner?.sourceRecipe || "").trim()) return true;
  if (String(dinner?.source || "").trim() === "FridgeFuse Demo Catalog") return true;
  try {
    const hostname = new URL(String(dinner?.sourceUrl || "")).hostname.toLowerCase();
    return hostname === "github.com" || hostname.endsWith(".github.com");
  } catch {
    return false;
  }
}

function safeText(value, limit = 500) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function safeStrings(value, limit = 100) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim()).slice(0, limit).map((entry) => entry.slice(0, 500)) : [];
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function safeNumber(value, fallback = 0, max = 100000) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, max) : fallback;
}

function safeConstraints(value = {}) {
  return {
    budget: safeNumber(value?.budget, DEFAULT_STATE.constraints.budget, 100),
    dinners: Math.max(1, Math.floor(safeNumber(value?.dinners, 3, 7))),
    maxTimeMin: Math.max(1, safeNumber(value?.maxTimeMin, 20, 180)),
    equipment: Array.isArray(value?.equipment) ? safeStrings(value.equipment, 20) : [...DEFAULT_STATE.constraints.equipment],
    diet: safeText(value?.diet, 500)
  };
}

function safeMeal(meal) {
  if (!meal || typeof meal !== "object" || typeof meal.title !== "string" || !meal.title.trim()) return null;
  const sourceUrl = safeUrl(meal.sourceUrl);
  return {
    title: safeText(meal.title), sourceRecipe: safeText(meal.sourceRecipe), source: safeText(meal.source), sourceUrl,
    sourceUnavailable: !sourceUrl || isLegacyRecipeCitation(meal), adaptationNote: safeText(meal.adaptationNote),
    timeMin: safeNumber(meal.timeMin, 0, 180),
    steps: safeStrings(meal.steps, 30), equip: safeStrings(meal.equip, 20), usesPantry: safeStrings(meal.usesPantry),
    needs: safeStrings(meal.needs), savedAt: safeText(meal.savedAt)
  };
}

function sanitizeStoredPlan(plan) {
  if (!plan || !Array.isArray(plan.dinners)) return null;
  const dinners = plan.dinners.slice(0, 7).map(safeMeal).filter(Boolean);
  if (!dinners.length) return null;
  return {
    dinners, constraints: plan.constraints ? safeConstraints(plan.constraints) : undefined,
    shoppingList: (Array.isArray(plan.shoppingList) ? plan.shoppingList : []).filter((item) => item && typeof item.item === "string").slice(0, 50).map((item) => ({
      item: safeText(item.item), qty: Math.max(1, Math.floor(safeNumber(item.qty, 1, 99))), sharedBy: safeStrings(item.sharedBy)
    })),
    offLimitsPantry: safeStrings(plan.offLimitsPantry)
  };
}

// structuredClone is missing on Safari < 15.4 and other older browsers, and the
// whole app runs through it on load — fall back rather than fail to start.
const clone = typeof structuredClone === "function"
  ? structuredClone
  : (value) => JSON.parse(JSON.stringify(value));

let state = loadState();
let activeView = "chat";
let visionReviewItems = [];

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored) return clone(DEFAULT_STATE);
    return normaliseState(stored);
  } catch {
    return clone(DEFAULT_STATE);
  }
}

// Everything that reaches state goes through here — what the browser saved last
// time, and any file a student restores. A truncated, edited or hostile file
// therefore cannot put a shape in state that the renderers do not expect.
function normaliseState(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return clone(DEFAULT_STATE);
  const records = (value, max) => Array.isArray(value) ? value.filter((item) => item && typeof item === "object").slice(0, max) : [];
  const location = stored.location;
  return {
    profile: { displayName: safeText(stored.profile?.displayName, 40), onboarded: stored.profile?.onboarded === true },
    constraints: safeConstraints(stored.constraints),
    plan: sanitizeStoredPlan(stored.plan),
    pantry: records(stored.pantry, 100).filter((item) => typeof item.name === "string" && item.name.trim())
      .map((item) => ({ name: item.name.trim().toLowerCase().slice(0, 80), soon: item.soon === true })),
    excludedTitles: safeStrings(stored.excludedTitles).slice(-MAX_EXCLUDED),
    messages: records(stored.messages, MAX_MESSAGES).filter((item) => typeof item.text === "string")
      .map((item) => ({ role: item.role === "user" ? "user" : "assistant", text: safeText(item.text, 4000), supportingText: safeText(item.supportingText, 4000), tone: item.tone === "error" ? "error" : "" })),
    groceryList: records(stored.groceryList, MAX_GROCERY_ITEMS).filter((item) => typeof item.name === "string" && item.name.trim())
      .map((item) => ({ name: item.name.trim().toLowerCase().slice(0, 80), qty: Math.max(1, Math.floor(safeNumber(item.qty, 1, MAX_GROCERY_QTY))) })),
    savedRecipes: records(stored.savedRecipes, MAX_SAVED_RECIPES).map(safeMeal).filter(Boolean),
    offLimitsPantry: safeStrings(stored.offLimitsPantry),
    location: location && Number.isFinite(location.lat) && Number.isFinite(location.lng) && Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180
      ? { lat: location.lat, lng: location.lng, accuracyM: safeNumber(location.accuracyM), label: safeText(location.label) } : null
  };
}

// Export and restore. Accounts would sync this same object, so the file is the
// state itself under a small envelope rather than a separate format that would
// have to be kept in step.
const EXPORT_FORMAT = "fridgefuse.kitchen";
const EXPORT_VERSION = 1;

function exportKitchen() {
  const payload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    state
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fridgefuse-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Kitchen downloaded. Keep the file somewhere you can find it.");
}

async function importKitchen(file) {
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("Kitchen files must be under 2 MB.");
    const text = await file.text();
    const payload = JSON.parse(text);
    const incoming = payload?.format === EXPORT_FORMAT ? payload.state : payload;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || !["profile", "pantry", "constraints", "plan", "savedRecipes"].some((key) => Object.prototype.hasOwnProperty.call(incoming, key))) {
      throw new Error("That file is not a FridgeFuse kitchen.");
    }
    if (payload?.format === EXPORT_FORMAT && Number(payload.version) > EXPORT_VERSION) {
      throw new Error("That file came from a newer version of FridgeFuse.");
    }
    const restored = normaliseState(incoming);
    const summary = `${restored.pantry.length} pantry items, ${restored.savedRecipes.length} saved recipes`;
    if (!window.confirm(`Restore this kitchen? It replaces what is on this device with ${summary}.`)) return;

    state = restored;
    saveState();
    // Reload rather than re-render: the message history and every panel are
    // rebuilt from scratch, with no chance of a half-restored screen.
    window.location.reload();
  } catch (error) {
    toast(error.message || "That file could not be read.", "error");
  }
}

function recordMessage(entry) {
  state.messages = [...(state.messages || []), entry].slice(-MAX_MESSAGES);
  saveState();
  updateChatEmptyState();
}

// The greeting and starter prompts center themselves while the chat is empty.
function updateChatEmptyState() {
  $("chatView").classList.toggle("is-empty", !state.messages?.length);
}

// Private windows, blocked site data, and a full quota all make setItem throw.
// Losing persistence is survivable; losing the click that triggered it is not.
let storageWarned = false;
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    if (!storageWarned) {
      storageWarned = true;
      toast("This browser is blocking saved data, so your list will not survive a reload.", "error");
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function mealSequenceLabel(index) {
  return index === 0 ? "TONIGHT" : `NIGHT ${index + 1}`;
}

function toast(message, type = "") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  $("toastRegion").append(node);
  window.setTimeout(() => node.remove(), 4200);
}

function addUserMessage(text, { record = true } = {}) {
  const article = document.createElement("article");
  article.className = "message user-message";
  const displayName = state.profile?.displayName?.trim();
  article.innerHTML = `
    <div class="message-copy">
      ${displayName
        ? `<span class="message-author">${escapeHtml(displayName)}</span>`
        : ""}
      <p>${escapeHtml(text)}</p>
    </div>`;
  $("messages").append(article);
  scrollMessages();
  if (record) recordMessage({ role: "user", text });
}

function addAssistantMessage(text, supportingText = "", options = {}) {
  const { record = true, tone = "" } = typeof options === "boolean" ? { record: options } : options;
  const article = document.createElement("article");
  article.className = `message assistant-message${tone === "error" ? " error-message" : ""}`;
  article.innerHTML = `
    <div class="assistant-symbol" aria-hidden="true">F</div>
    <div class="message-copy">
      <p>${escapeHtml(text)}</p>
      ${supportingText ? `<p class="message-example">${escapeHtml(supportingText)}</p>` : ""}
    </div>`;
  $("messages").append(article);
  scrollMessages();
  if (record) recordMessage({ role: "assistant", text, supportingText, tone });
}

function showThinking() {
  const article = document.createElement("article");
  article.className = "message assistant-message thinking";
  article.id = "thinkingMessage";
  article.innerHTML = `
    <div class="assistant-symbol" aria-hidden="true">F</div>
    <div class="message-copy">
      <span class="thinking-dots" aria-label="FridgeFuse is planning"><i></i><i></i><i></i></span>
    </div>`;
  $("messages").append(article);
  scrollMessages();
}

function hideThinking() {
  $("thinkingMessage")?.remove();
}

function scrollMessages() {
  requestAnimationFrame(() => {
    $("messages").scrollTop = $("messages").scrollHeight;
  });
}

function addPantryItem(name, soon = false) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  const existing = state.pantry.find((item) => item.name === normalized);
  if (existing) {
    existing.soon = Boolean(existing.soon || soon);
    return false;
  }
  state.pantry.push({ name: normalized, soon: Boolean(soon) });
  return true;
}

const CLAUSE_BOUNDARY = /\bbut\b|\bhowever\b|\balthough\b|\bthough\b|\bexcept\b|[,;]+/;
function clausesOf(text) {
  return text.split(/[.!?;\n]+/).flatMap((s) => s.split(CLAUSE_BOUNDARY));
}
const HAVE_NEG = /\b(dont|doesnt|didnt|never) have\b|\bdo not have\b|\bno longer have\b/i;
const NEG_WORD = /\b(dont|doesnt|didnt|cant|cannot|not|no|without|lacking|never|neither|nor)\b|\brid of\b/i;
const AFFIRM_WORD = /\bhave\b|\bve\b|\bgot\b|\bwith\b|\bkeep\b|\bkept\b|\bbought\b|\bonly\b|\bjust\b|\bstill\b/i;

function wordsBefore(text, index, n) {
  // Normalize apostrophes first so "don't" becomes one "dont" token.
  return text.slice(Math.max(0, index - 40), index).toLowerCase().replace(/['’]/g, "").split(/[^a-z]+/).filter(Boolean).slice(-n).join(" ");
}
// A mention is negated when a negation word sits right before it ("no stove")
// or a have-negation scopes over it ("don't have a stove and microwave").
function negatedBefore(clause, matchIndex) {
  if (NEG_WORD.test(wordsBefore(clause, matchIndex, 3))) return true;
  return HAVE_NEG.test(clause.slice(0, matchIndex).toLowerCase());
}
function affirmedBefore(clause, matchIndex) {
  return AFFIRM_WORD.test(wordsBefore(clause, matchIndex, 2));
}
function clauseMentionIndex(clause, name) {
  const m = clause.match(new RegExp(`\\b${name.replaceAll(" ", "\\s+")}\\b`, "i"));
  return m ? m.index : -1;
}

function preferenceMentions(message, options) {
  const lower = String(message).toLowerCase();
  const mentions = [];
  for (const option of options || []) {
    const terms = [option.id, ...(option.aliases || [])]
      .map((term) => String(term).trim().toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const term = terms.find((candidate) => {
      const pattern = candidate
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, "\\s+");
      return new RegExp(`(?:^|\\b)${pattern}(?=$|\\b)`, "i").test(lower);
    });
    if (term) mentions.push({ id: option.id, term });
  }
  return mentions;
}

function parseMessage(message) {
  const lower = message.toLowerCase();
  const budget = lower.match(/\$(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:dollars|bucks)/);
  if (budget) state.constraints.budget = Number(budget[1] || budget[2]);

  const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const dinners = lower.match(/\b([1-7]|one|two|three|four|five|six|seven)\s+(?:easy\s+)?(?:dinners?|meals?|nights?)\b/);
  if (dinners) state.constraints.dinners = NUMBER_WORDS[dinners[1]] ?? Number(dinners[1]);

  const time = lower.match(/\b(\d{1,3})\s*(?:minutes?|mins?)\b/);
  if (time) state.constraints.maxTimeMin = Number(time[1]);

  const equipmentMentions = preferenceMentions(message, PREFERENCES.equipment);
  const removedEquipment = equipmentMentions.filter((mention) =>
    clausesOf(message).some((clause) => {
      const idx = clauseMentionIndex(clause, mention.term);
      return idx !== -1 && negatedBefore(clause, idx);
    })
  ).map((mention) => mention.id);
  const addedEquipment = equipmentMentions
    .map((mention) => mention.id)
    .filter((item) => !removedEquipment.includes(item));
  if (removedEquipment.length) {
    state.constraints.equipment = state.constraints.equipment.filter((item) => !removedEquipment.includes(item));
  }
  if (addedEquipment.length && /\b(?:only|just)\b/.test(lower)) state.constraints.equipment = [...new Set(addedEquipment)];
  else if (addedEquipment.length) state.constraints.equipment = [...new Set([...state.constraints.equipment, ...addedEquipment])];

  if (/\b(?:no (?:diet|diets|restrictions?)|not (?:vegetarian|vegan|gluten-free|dairy-free)(?: anymore)?|eat (?:everything|anything)|clear (?:my )?diet|regular diet)\b/.test(lower)) {
    // Casual diet changes never remove an allergy. Allergies are edited explicitly in the profile.
    const clearable = new Set(PREFERENCES.diets.filter((option) => option.group !== "Allergy").map((option) => option.id));
    const removed = preferenceMentions(message, PREFERENCES.diets).map((mention) => mention.id);
    state.constraints.diet = safeStrings(String(state.constraints.diet || "").split(",").map((item) => item.trim()))
      .filter((item) => !clearable.has(item) || (removed.length && !removed.includes(item))).join(", ");
  } else {
    const diets = preferenceMentions(message, PREFERENCES.diets).map((mention) => mention.id);
    if (diets.length) state.constraints.diet = [...new Set([...String(state.constraints.diet || "").split(",").map((item) => item.trim()).filter(Boolean), ...diets])].join(", ");
  }

  saveState();
  renderPantry();
  return {};
}


function planningFailureCopy(context) {
  const failure = context?.failure || null;
  const status = failure?.status;

  if (failure?.provider === "asu-air" && failure?.operation === "plan-repair") {
    return {
      title: "AI recipe response rejected",
      detail: "FridgeFuse rejected a mismatched or unsafe recipe instead of showing it. Try the request again."
    };
  }

  if (failure?.provider === "asu-air" && failure?.operation === "chat") {
    if (status === "no-key") {
      return {
        title: "ASU AI is not configured",
        detail: "The server is missing its Voyager API key."
      };
    }
    if (status === "bad-json-envelope") {
      return {
        title: "ASU AI response unreadable",
        detail: "The recipe API answered, but its response could not be read. Try again."
      };
    }
    if (status === "timeout") {
      return {
        title: "ASU AI API failure",
        detail: "The recipe API timed out before sending a response. Try again."
      };
    }
    const providerStatus = Number(status);
    return {
      title: "ASU AI API failure",
      detail: Number.isInteger(providerStatus)
        ? `The recipe API returned HTTP ${providerStatus}. Try again.`
        : "FridgeFuse could not reach the recipe API. Try again."
    };
  }

  if ([400, 422].includes(context?.httpStatus) && failure?.message) {
    return { title: "This plan needs a change", detail: failure.message };
  }

  if (!context?.responseReceived) {
    return {
      title: "FridgeFuse connection failure",
      detail: "Your browser could not reach the FridgeFuse server. Check your connection and try again."
    };
  }

  if (context?.responseAccepted) {
    return {
      title: "FridgeFuse display failure",
      detail: "A plan arrived, but the app could not display it. Try again."
    };
  }

  return {
    title: "FridgeFuse server failure",
    detail: Number.isInteger(context?.httpStatus)
      ? `The FridgeFuse server returned HTTP ${context.httpStatus}. Try again.`
      : "The FridgeFuse server returned an unreadable response. Try again."
  };
}

let planRequestSequence = 0;
let planningOptions = {};

let interpreting = false;

async function interpretMessage(message) {
  const response = await fetch("/api/chat/interpret", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, pantry: state.pantry.map(({ name }) => ({ name })) })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.failure?.message || "Could not understand that message. No changes were made.");
  return result;
}

function applyChatActions(actions) {
  if (!Array.isArray(actions)) throw new Error("AI returned no action list.");
  const pantryNames = new Set(state.pantry.map(item => item.name));
  const shoppingNames = new Set(state.groceryList.map(item => item.name));
  for (const action of actions) {
    if (action.type === "pantry_set") pantryNames.add(action.name);
    if (action.type === "pantry_remove") pantryNames.delete(action.name);
    if (action.type === "shopping_add") shoppingNames.add(action.name);
    if (action.type === "shopping_remove") shoppingNames.delete(action.name);
  }
  if (pantryNames.size > 100 || shoppingNames.size > MAX_GROCERY_ITEMS) throw new Error("This update exceeds the list limit. Remove some items first.");
  const confirmations = [];
  for (const action of actions) {
    if (action.type === "pantry_set") {
      addPantryItem(action.name, action.soon);
      confirmations.push(`Pantry updated: ${action.name}.`);
    } else if (action.type === "pantry_remove") {
      state.pantry = state.pantry.filter(item => item.name !== action.name);
      confirmations.push(`Removed ${action.name} from your pantry.`);
    } else if (action.type === "shopping_add") {
      addGroceryItem(action.name, action.qty);
      confirmations.push(`Added ${action.name} to your shopping list.`);
    } else if (action.type === "shopping_remove") {
      state.groceryList = state.groceryList.filter(item => item.name !== action.name);
      confirmations.push(`Removed ${action.name} from your shopping list.`);
    }
  }
  if (actions.some(action => action.type.startsWith("shopping_"))) invalidateGroceryResults();
  saveState(); renderPantry(); renderGroceryList();
  return confirmations.join(" ");
}

async function handleMessage(message) {
  const clean = message.trim();
  if (!clean) return;
  if (interpreting) { toast("Please wait for the current message to finish."); return; }
  interpreting = true;
  addUserMessage(clean);
  $("starterPrompts").hidden = true;
  // Discard interpretation if the user edits or resets inventory while AIR is responding.
  const requestState = state;
  const snapshot = JSON.stringify([state.pantry, state.groceryList, state.constraints]);
  showThinking();
  try {
    await loadPreferences();
    const parsed = await interpretMessage(clean);
    if (requestState !== state || snapshot !== JSON.stringify([state.pantry, state.groceryList, state.constraints])) {
      addAssistantMessage("Your pantry or preferences changed while I was reading that. Please send the message again.");
      return;
    }
    if (parsed.clarification) { addAssistantMessage(parsed.clarification); return; }
    const confirmation = applyChatActions(parsed.actions);
    parseMessage(clean);
    if (parsed.planToShop) {
      const planItems = state.plan?.shoppingList || [];
      if (!planItems.length) {
        addAssistantMessage("There is no meal plan yet. Build one and I will send its shopping list to Shop.");
      } else {
        const added = addPlanItemsToShop();
        addAssistantMessage(added
          ? `${added} item${added === 1 ? "" : "s"} added to Shop from your meal plan.`
          : "Your meal plan items are already on the Shop list.");
      }
    }
    if (confirmation) addAssistantMessage(confirmation);
    if (!parsed.requestPlan) {
      if (!confirmation && !parsed.planToShop) addAssistantMessage("Preferences noted. Ask me to build a meal plan when you want one.");
      setView("chat");
      return;
    }
    if (parsed.swapIndex !== null) {
      const meal = state.plan?.dinners?.[parsed.swapIndex];
      if (!meal) { addAssistantMessage("That meal number is not in your current plan."); return; }
      addExclusion(meal.sourceRecipe || meal.title);
      planningOptions = { swapIndex: parsed.swapIndex, previousDinners: clone(state.plan.dinners) };
    }
    hideThinking();
    await buildPlan(clean);
  } catch (error) {
    addAssistantMessage(error.message, "Your message was not completed. Please try again.", { tone: "error" });
  } finally {
    interpreting = false;
    hideThinking();
  }
}

async function buildPlan(request = "") {
  const requestId = ++planRequestSequence;
  const snapshot = clone(state);
  const options = planningOptions;
  planningOptions = {};
  hideThinking();
  showThinking();
  const soon = snapshot.pantry.filter((item) => item.soon).map((item) => item.name);
  let responseReceived = false;
  let responseAccepted = false;
  let httpStatus = null;
  let serverFailure = null;

  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pantry: snapshot.pantry.map((item) => item.name),
        shoppingLocation: snapshot.location ? { lat: snapshot.location.lat, lng: snapshot.location.lng } : undefined,
        ...options,
        useSoon: soon,
        budget: snapshot.constraints.budget,
        dinners: snapshot.constraints.dinners,
        maxTimeMin: snapshot.constraints.maxTimeMin,
        equipment: snapshot.constraints.equipment,
        diet: snapshot.constraints.diet,
        request,
        exclude: snapshot.excludedTitles
      })
    });
    if (requestId !== planRequestSequence) return;
    responseReceived = true;
    httpStatus = response.status;
    // Read the body even on an error status: the server explains WHY it refused
    // (an unpriced ingredient, an unapproved recipe, a dietary violation), and
    // that reason is more useful to the student than the status code.
    const result = await response.json().catch(() => null);
    if (requestId !== planRequestSequence) return;
    if (JSON.stringify(state.constraints) !== JSON.stringify(snapshot.constraints) || JSON.stringify(state.pantry) !== JSON.stringify(snapshot.pantry)) {
      hideThinking();
      addAssistantMessage("Your kitchen changed while the plan was being made.", "Build a new plan to use your latest pantry and preferences.");
      return;
    }
    serverFailure = result?.failure || null;
    if (!response.ok) {
      throw new Error(result?.failure?.message || `Planning returned HTTP ${response.status}`);
    }
    if (!result) throw new Error("The planner did not return a plan");
    if (!result.ok && !result.dinners) throw new Error(result.failure?.message || "The planner did not return a plan");
    responseAccepted = true;

    // Leaving food out silently is what makes a diet feature untrustworthy: the
    // student can see the item sitting in their pantry and cannot tell whether
    // the planner respected it or forgot it.
    const offLimits = Array.isArray(result.offLimitsPantry) ? result.offLimitsPantry : [];

    state.plan = {
      ...result,
      constraints: clone(snapshot.constraints)
    };
    state.offLimitsPantry = offLimits;
    saveState();
    renderPlan();
    renderGroceryList();
    renderPantry();
    hideThinking();

    if (!result.dinners?.length) {
      addAssistantMessage(
        "I couldn't find any recipes for that combination.",
        result.note || "Try more time, more equipment, or fewer restrictions."
      );
      return;
    }
    const priceStatus = "Add the shopping list to Shop and compare live Walmart, ALDI, and Fry's prices.";
    const usedSoon = soon.filter((name) => result.dinners?.[0]?.usesPantry?.includes(name));
    const soonText = usedSoon.length ? ` The first dinner uses ${usedSoon.join(" and ")}.` : "";
    const dietText = snapshot.constraints.diet ? ` Every dinner is ${snapshot.constraints.diet}.` : "";
    const offLimitsText = offLimits.length
      ? ` I left ${offLimits.join(" and ")} out of the cooking — ${offLimits.length === 1 ? "it does not" : "they do not"} fit ${snapshot.constraints.diet || "your food restrictions"}. If yours is a safe version, add it under its own name (for example "gluten free pasta") and I will use it.`
      : "";
    if (result.swapUnavailable) {
      addAssistantMessage(
        "I could not find a different recipe that fits your time and equipment, so that dinner is still here.",
        "Loosening one of those — more time or another appliance — usually opens up more options."
      );
    }
    addAssistantMessage(
      `Here ${result.dinners.length === 1 ? "is" : "are"} ${result.dinners.length} dinner${result.dinners.length === 1 ? "" : "s"} you can make.${soonText}${dietText}${offLimitsText}`,
      `${priceStatus} ${result.dinners.length === 1 ? "Use the Swap button." : 'Do not like one? Say "swap dinner two".'}`
    );
    setView("plan");
  } catch (error) {
    if (requestId !== planRequestSequence) return;
    hideThinking();
    const copy = planningFailureCopy({
      failure: serverFailure,
      responseReceived,
      responseAccepted,
      httpStatus
    });
    addAssistantMessage(copy.title, copy.detail, { tone: "error" });
    toast(error.message, "error");
  }
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0));
}

function renderPlan() {
  const plan = state.plan;
  if (!plan || !Array.isArray(plan.dinners) || !plan.dinners.length) {
    $("emptyPlan").hidden = false;
    $("planContent").hidden = true;
    $("tripStatus").classList.remove("ready");
    $("tripLabel").textContent = "No grocery run planned";
    return;
  }

  const planConstraints = {
    ...DEFAULT_STATE.constraints,
    ...(plan.constraints || state.constraints)
  };

  $("emptyPlan").hidden = true;
  $("planContent").hidden = false;
  $("planTitle").textContent = `${plan.dinners.length} ${plan.dinners.length === 1 ? "dinner" : "dinners"}, one small grocery run`;
  const dietSummary = String(planConstraints.diet || "").trim();
  $("planSubtitle").textContent = `Built for ${planConstraints.equipment.join(" + ") || "the equipment you have"}, ${planConstraints.maxTimeMin} minutes or less each.${dietSummary ? ` Kept ${dietSummary}.` : ""}`;
  $("tripStatus").classList.add("ready");
  const packages = (plan.shoppingList || []).reduce((sum, item) => sum + Math.max(1, Number(item.qty) || 1), 0);
  $("tripLabel").textContent = `${packages} ${packages === 1 ? "item" : "items"} · priced live in Shop`;

  const soon = state.pantry.filter((item) => item.soon).map((item) => item.name);
  const shared = (plan.shoppingList || []).filter((item) => (item.sharedBy || []).length > 1);
  const logicParts = [];
  const usedFirst = soon.filter((name) => plan.dinners[0]?.usesPantry?.includes(name));
  if (usedFirst.length) logicParts.push(`The first dinner uses ${usedFirst.join(" and ")}`);
  if (shared.length) logicParts.push(`${shared.length} purchase${shared.length === 1 ? " works" : "s work"} across multiple dinners`);
  logicParts.push("live totals come from the Shop comparison");
  $("planLogic").textContent = logicParts.join(". ") + ".";

  $("mealList").innerHTML = plan.dinners.map((meal, index) => {
    const pantryUsed = meal.usesPantry || [];
    const useSoon = pantryUsed.filter((name) => soon.includes(name));
    const reason = useSoon.length
      ? `Uses ${useSoon.join(" and ")} while it is still fresh`
      : pantryUsed.length
        ? `Uses ${pantryUsed.join(", ")} from your pantry`
        : "Built from the same grocery run";
    const steps = (meal.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("");
    const recipeSource = meal.sourceUnavailable
      ? `<span class="meal-source unavailable">Recipe source unavailable — regenerate this plan</span>`
      : meal.sourceRecipe && meal.source && meal.sourceUrl && !isLegacyRecipeCitation(meal)
      ? `<a class="meal-source" href="${escapeHtml(meal.sourceUrl)}" target="_blank" rel="noopener noreferrer">Recipe: ${escapeHtml(meal.sourceRecipe)} on ${escapeHtml(meal.source)}</a>`
      : "";
    return `
      <article class="meal-card" data-meal-index="${index}">
        <div class="meal-day">${mealSequenceLabel(index)}</div>
        <div class="meal-main">
          <h3>${escapeHtml(meal.title)}</h3>
          <p class="meal-meta">${Number(meal.timeMin) || "—"} min · beginner · ${escapeHtml((meal.equip || []).join(" + ") || planConstraints.equipment[0] || "simple equipment")}</p>
          <p class="meal-reason">${escapeHtml(reason)}</p>
          ${recipeSource}
        </div>
        <div class="meal-actions">
          <button data-action="details" data-index="${index}">Steps</button>
          <button data-action="save" data-index="${index}" aria-pressed="${isRecipeSaved(meal)}">${isRecipeSaved(meal) ? "Saved" : "Save"}</button>
          <button data-action="swap" data-index="${index}">Swap</button>
        </div>
        <div class="meal-details">
          <strong>How to make it</strong>
          <ol>${steps || "<li>Follow the package directions and combine the listed ingredients.</li>"}</ol>
        </div>
      </article>`;
  }).join("");

  const shopping = plan.shoppingList || [];
  $("shoppingList").innerHTML = shopping.map((item) => {
    const qty = Math.max(1, Number(item.qty || 1));
    const qtyLabel = qty > 1 ? `${qty} × ` : "";
    const sharedBy = Array.isArray(item.sharedBy) ? item.sharedBy : [];
    const coversLabel = sharedBy.length > 1 ? ` · covers ${sharedBy.length} dinners` : "";
    return `
    <div class="receipt-row">
      <span class="receipt-item">
        <strong>${escapeHtml(item.item)}</strong>
        <small>${qtyLabel}${coversLabel.replace(/^ · /, "") || "1 dinner"}</small>
      </span>
    </div>
  `;
  }).join("") + `
    <div class="receipt-total"><span>PRICES</span><strong>live in Shop</strong></div>`;
}

// A dinner the student liked used to vanish the moment they swapped it or
// rebuilt the plan. Saving keeps the recipe itself — its citation, timing and
// steps — not the plan it happened to appear in.
function recipeKey(meal) {
  return normaliseKey(meal?.sourceRecipe || meal?.title);
}

function normaliseKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isRecipeSaved(meal) {
  const key = recipeKey(meal);
  return Boolean(key) && state.savedRecipes.some((saved) => recipeKey(saved) === key);
}

function toggleSavedRecipe(meal) {
  const key = recipeKey(meal);
  if (!key) return;
  const existing = state.savedRecipes.findIndex((saved) => recipeKey(saved) === key);
  if (existing >= 0) {
    const [removed] = state.savedRecipes.splice(existing, 1);
    toast(`Removed ${removed.title} from your saved recipes`);
  } else {
    state.savedRecipes.unshift({
      title: meal.title,
      sourceRecipe: meal.sourceRecipe || "",
      source: meal.source || "",
      sourceUrl: meal.sourceUrl || "",
      timeMin: Number(meal.timeMin) || null,
      steps: Array.isArray(meal.steps) ? meal.steps.slice(0, 12) : [],
      savedAt: new Date().toISOString()
    });
    state.savedRecipes = state.savedRecipes.slice(0, MAX_SAVED_RECIPES);
    toast(`Saved ${meal.title}`);
  }
  saveState();
  renderSavedRecipes();
  renderPlan();
}

function renderSavedRecipes() {
  const host = $("savedRecipeList");
  $("savedRecipeCount").textContent = state.savedRecipes.length;
  // An empty section is noise on a first visit: it appears once it has content.
  $("savedRecipes").hidden = state.savedRecipes.length === 0;
  if (!state.savedRecipes.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = state.savedRecipes.map((recipe, index) => `
    <article class="saved-recipe">
      <div class="saved-recipe-main">
        <strong>${escapeHtml(recipe.title)}</strong>
        <span>${recipe.timeMin ? `${safeNumber(recipe.timeMin, 0, 180)} min · ` : ""}${escapeHtml(recipe.source || "saved recipe")}</span>
      </div>
      <div class="saved-recipe-actions">
        <button data-saved-action="cook" data-index="${index}">Cook again</button>
        <button data-saved-action="remove" data-index="${index}" aria-label="Remove ${escapeHtml(recipe.title)}">Remove</button>
      </div>
    </article>
  `).join("");
}

function renderPantry() {
  $("mobilePantryCount").textContent = state.pantry.length;
  const soon = state.pantry.filter((item) => item.soon);
  $("useFirstText").textContent = soon.length ? soon.map((item) => titleCase(item.name)).join(" · ") : "Nothing marked yet";
  // Gold is for something to act on, not for an empty list.
  document.querySelector(".use-first-strip")?.classList.toggle("is-empty", soon.length === 0);

  if (!state.pantry.length) {
    $("pantryList").innerHTML = `
      <div class="pantry-empty">
        Nothing here yet. Type what food you have, or add a photo of your fridge.
      </div>`;
    return;
  }

  // Items the last plan could not cook with stay in the pantry — they belong to
  // the student — but they are labelled, so nobody has to wonder whether the
  // planner respected their diet or just forgot the item.
  const offLimits = new Set((state.offLimitsPantry || []).map((name) => String(name).toLowerCase()));
  $("pantryList").innerHTML = state.pantry.map((item, index) => `
    <div class="pantry-item ${item.soon ? "soon" : ""}${offLimits.has(item.name.toLowerCase()) ? " off-limits" : ""}">
      <button class="pantry-toggle" data-pantry-action="soon" data-index="${index}"
        aria-pressed="${Boolean(item.soon)}"
        title="${item.soon ? "Stop using this first" : "Use this one first"}">
        <span class="pantry-icon" aria-hidden="true">${escapeHtml(item.name[0])}</span>
        <span class="pantry-info">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${item.soon ? "use first" : "in your pantry"}${offLimits.has(item.name.toLowerCase()) ? ` · not used · does not fit ${escapeHtml(state.constraints.diet || "your food restrictions")}` : ""}</span>
        </span>
      </button>
      <button class="pantry-remove" data-pantry-action="remove" data-index="${index}" aria-label="Remove ${escapeHtml(item.name)}" title="Remove">&times;</button>
    </div>
  `).join("");
}

/* ---------------- preference catalogs + onboarding ---------------- */

// Option lists come from the server so the form and the planner's filter can
// never disagree. Falls back to the minimum viable set if the fetch fails.
let PREFERENCES = {
  diets: [],
  equipment: [{ id: "microwave", label: "Microwave", hint: "" }, { id: "stove", label: "Stovetop or hot plate", hint: "" }],
  limits: { budget: { min: 5, max: 100 }, dinners: { min: 1, max: 7 }, maxTimeMin: { min: 10, max: 60 } },
  disclaimer: "Preferences filter suggestions. They are not an allergy-safety guarantee.",
  recipeCount: 0,
};
let preferencesLoaded = false;

async function loadPreferences() {
  if (preferencesLoaded) return PREFERENCES;
  try {
    const response = await fetch("/api/preferences");
    const result = await response.json();
    if (result.ok && Array.isArray(result.equipment) && result.equipment.length) {
      PREFERENCES = result;
      preferencesLoaded = true;
    }
  } catch {
    // Keep the fallback list; the form still works.
  }
  return PREFERENCES;
}

function selectedDietSet() {
  return new Set(
    String(state.constraints.diet || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Renders equipment cards and diet chips into a given pair of containers, so
// the welcome wizard and the profile drawer share one implementation.
function renderPreferenceControls({ equipmentHost, dietHost, namePrefix }) {
  const chosenEquipment = new Set((state.constraints.equipment || []).map((item) => String(item).toLowerCase()));
  if (equipmentHost) {
    equipmentHost.innerHTML = PREFERENCES.equipment.map((option) => `
      <label class="option-card${chosenEquipment.has(option.id) ? " is-checked" : ""}">
        <input type="checkbox" name="${namePrefix}-equipment" value="${escapeHtml(option.id)}"${chosenEquipment.has(option.id) ? " checked" : ""}>
        <strong>${escapeHtml(option.label)}</strong>
        ${option.hint ? `<small>${escapeHtml(option.hint)}</small>` : ""}
      </label>`).join("");
  }

  if (dietHost) {
    const chosenDiet = selectedDietSet();
    const groups = [];
    for (const option of PREFERENCES.diets) {
      const group = groups.find((entry) => entry.name === option.group);
      if (group) group.options.push(option);
      else groups.push({ name: option.group, options: [option] });
    }
    const groupIntro = {
      Diet: "How you eat",
      Allergy: "Allergies and intolerances",
      Avoid: "Things to skip",
    };
    dietHost.innerHTML = groups.map((group) => `
      <div class="diet-group">
        <h3>${escapeHtml(groupIntro[group.name] || group.name)}</h3>
        <div class="chip-row">
          ${group.options.map((option) => {
            const checked = chosenDiet.has(option.id) || chosenDiet.has(option.label.toLowerCase());
            return `
              <label class="chip${checked ? " is-checked" : ""}"${option.note ? ` title="${escapeHtml(option.note)}"` : ""}>
                <input type="checkbox" name="${namePrefix}-diet" value="${escapeHtml(option.id)}"${checked ? " checked" : ""}>
                ${escapeHtml(option.label)}
              </label>`;
          }).join("")}
        </div>
      </div>`).join("");
  }
}

// :has() is unavailable on older browsers, so selection state is also a class.
function bindOptionToggles(root, notePrefix) {
  root.addEventListener("change", (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    const holder = input.closest(".option-card, .chip");
    if (holder) holder.classList.toggle("is-checked", input.checked);
    // Clear the "pick something" warning the moment it stops being true.
    if (input.name === `${notePrefix}-equipment` && readCheckedValues(`${notePrefix}-equipment`).length) {
      $("equipmentError").hidden = true;
    }
    updateKitchenNote(notePrefix);
  });
  root.addEventListener("focusin", (event) => {
    const holder = event.target.closest?.(".option-card, .chip");
    if (holder) holder.classList.add("is-focus");
  });
  root.addEventListener("focusout", (event) => {
    const holder = event.target.closest?.(".option-card, .chip");
    if (holder) holder.classList.remove("is-focus");
  });
}

function readCheckedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

// Describes the cooking style a selection unlocks, purely from the already-
// fetched PREFERENCES catalog — no network round trip on every click, and no
// claim of a precise count now that planning is fully AI-driven with no fixed
// recipe list to count against.
function equipmentVibeText(ids) {
  const chosen = ids.map((id) => PREFERENCES.equipment.find((e) => e.id === id)).filter(Boolean);
  if (!chosen.length) return "";
  const labels = chosen.map((e) => e.label).join(" + ");
  const vibes = [...new Set(chosen.map((e) => e.vibe).filter(Boolean))].join(", ");
  return vibes ? `${labels} — ${vibes}.` : `${labels}.`;
}

function dietVibeText(ids) {
  const chosen = ids.map((id) => PREFERENCES.diets.find((d) => d.id === id)).filter(Boolean);
  if (!chosen.length) return "";
  const labels = chosen.map((d) => d.label).join(", ");
  const notes = chosen.filter((d) => d.note).map((d) => d.note);
  return notes.length ? `${labels} selected. ${notes.join(" ")}` : `${labels} selected — matching dinners will avoid these ingredients.`;
}

function updateKitchenNote(prefix) {
  const host = $(prefix === "welcome" ? "welcomeKitchenNote" : "profileKitchenNote");
  if (!host) return;
  const equipmentText = equipmentVibeText(readCheckedValues(`${prefix}-equipment`));
  const dietText = dietVibeText(readCheckedValues(`${prefix}-diet`));
  const parts = [equipmentText, dietText].filter(Boolean);

  if (prefix === "welcome") {
    // The hero panel always shows something, even before a choice is made.
    host.innerHTML = parts.length
      ? parts.map((text) => `<p>${escapeHtml(text)}</p>`).join("")
      : "<p>Pick your equipment to see what kind of meals you'll get.</p>";
  } else {
    // The profile drawer stays silent until there is something to say
    // (:empty hides it in CSS), since it sits above an already-labelled form.
    host.innerHTML = parts.map((text) => `<p>${escapeHtml(text)}</p>`).join("");
  }
}

/* ----- the welcome wizard ----- */

let welcomeSteps = [];
let welcomeIndex = 0;

function needsOnboarding() {
  return state.profile?.onboarded !== true;
}

function stepLabels() {
  return { identity: "About you", kitchen: "Your kitchen", food: "Your food" };
}

function renderWelcomeStep() {
  const current = welcomeSteps[welcomeIndex];
  document.querySelectorAll(".welcome-step").forEach((section) => {
    section.hidden = section.dataset.step !== current;
  });

  const labels = stepLabels();
  $("welcomeProgress").innerHTML = welcomeSteps.map((step, index) => `
    <li class="${index === welcomeIndex ? "current" : index < welcomeIndex ? "done" : ""}">${escapeHtml(labels[step] || step)}</li>
  `).join("");

  $("welcomeBack").hidden = welcomeIndex === 0;
  const isLast = welcomeIndex === welcomeSteps.length - 1;
  $("welcomeNext").textContent = isLast ? "Start cooking" : "Continue";
  updateKitchenNote("welcome");
}

// Runs once, ever — the first time the app opens with no saved profile. Later
// visits go straight to the app; preferences after that are only ever changed
// by deliberately opening the profile drawer, never re-asked on login.
async function openWelcome() {
  await loadPreferences();

  welcomeSteps = ["identity", "kitchen", "food"];
  welcomeIndex = 0;

  $("welcomeName").value = state.profile?.displayName || "";

  const budget = clampNumber(state.constraints.budget, PREFERENCES.limits.budget, 20);
  $("welcomeBudget").value = budget;
  $("welcomeBudgetValue").textContent = `$${budget}`;

  renderPreferenceControls({
    equipmentHost: $("equipmentOptions"),
    dietHost: $("dietOptions"),
    namePrefix: "welcome",
  });
  $("dietDisclaimer").textContent = PREFERENCES.disclaimer;

  $("welcomeScreen").hidden = false;
  document.body.dataset.welcomeOpen = "true";
  renderWelcomeStep();
  requestAnimationFrame(() => $("welcomeName").focus());
}

function closeWelcome() {
  $("welcomeScreen").hidden = true;
  delete document.body.dataset.welcomeOpen;
}

function clampNumber(value, limit, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(limit.max, Math.max(limit.min, n));
}

// Saves whatever the wizard currently holds. Called on finish and on skip so a
// partly-filled form is never silently discarded.
function commitWelcome({ markOnboarded }) {
  const equipment = readCheckedValues("welcome-equipment");
  const diets = readCheckedValues("welcome-diet");

  if (state.plan && !state.plan.constraints) {
    state.plan.constraints = clone(state.constraints);
  }

  state.profile = {
    ...state.profile,
    displayName: $("welcomeName").value.trim().slice(0, 40),
    onboarded: markOnboarded ? true : state.profile?.onboarded === true,
  };

  if (equipment.length) state.constraints.equipment = equipment;
  state.constraints.diet = diets.join(", ");
  state.constraints.budget = clampNumber($("welcomeBudget").value, PREFERENCES.limits.budget, 20);

  saveState();
  renderProfile();
  renderLocation();
}

function advanceWelcome() {
  const current = welcomeSteps[welcomeIndex];

  if (current === "kitchen" && !readCheckedValues("welcome-equipment").length) {
    $("equipmentError").hidden = false;
    return;
  }
  $("equipmentError").hidden = true;

  if (welcomeIndex < welcomeSteps.length - 1) {
    welcomeIndex += 1;
    renderWelcomeStep();
    // A long step can leave the next one scrolled halfway down.
    $("welcomeForm").scrollTop = 0;
    return;
  }

  commitWelcome({ markOnboarded: true });
  closeWelcome();
  const name = state.profile.displayName;
  toast(name ? `You're set, ${name}. Plans will use these preferences.` : "You're set. Plans will use these preferences.");
}

function profileInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) return "ME";

  return parts
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function renderProfile() {
  const name = state.profile?.displayName?.trim() || "";

  $("profileButton").textContent = profileInitials(name);
  $("profileButton").setAttribute(
    "aria-label",
    name ? `Open ${name}'s profile` : "Open profile"
  );
}

async function openProfile() {
  closePantry();
  await loadPreferences();

  $("profileName").value = state.profile?.displayName || "";

  const budget = clampNumber(state.constraints.budget, PREFERENCES.limits.budget, 20);
  $("profileBudget").value = budget;
  $("profileBudgetValue").textContent = `$${budget}`;

  // Same renderer as the welcome wizard, so both stay in step automatically.
  renderPreferenceControls({
    equipmentHost: $("profileEquipmentOptions"),
    dietHost: $("profileDietOptions"),
    namePrefix: "profile",
  });
  $("profileDietDisclaimer").textContent = PREFERENCES.disclaimer;
  updateKitchenNote("profile");

  $("profileDrawer").classList.add("open");
  $("profileDrawer").setAttribute("aria-hidden", "false");
  document.body.dataset.drawerOpen = "true";

  requestAnimationFrame(() => $("profileName").focus());
}

function closeProfile() {
  $("profileDrawer").classList.remove("open");
  $("profileDrawer").setAttribute("aria-hidden", "true");
  delete document.body.dataset.drawerOpen;
}

// The pantry is a drawer only where there is no room for a side panel.
const wideShellQuery = window.matchMedia("(min-width: 981px)");
const isWideShell = () => wideShellQuery.matches;
wideShellQuery.addEventListener?.("change", syncPantryShell);

function syncPantryShell() {
  if (isWideShell()) {
    $("pantryDrawer").setAttribute("aria-hidden", "false");
    return;
  }
  $("pantryDrawer").classList.remove("open");
  $("pantryDrawer").setAttribute("aria-hidden", "true");
  delete document.body.dataset.drawerOpen;
}

function openPantry() {
  if (isWideShell()) return;
  closeProfile();
  $("pantryDrawer").classList.add("open");
  $("pantryDrawer").setAttribute("aria-hidden", "false");
  document.body.dataset.drawerOpen = "true";
  requestAnimationFrame(() => $("pantryInput").focus());
}

function closePantry() {
  if (isWideShell()) return;
  $("pantryDrawer").classList.remove("open");
  $("pantryDrawer").setAttribute("aria-hidden", "true");
  delete document.body.dataset.drawerOpen;
}

// One view at a time at every width. Chat is home, the Plan is a result screen
// that opens when a build finishes, and the nav buttons always change the pane.
function setView(view) {
  if (view === "pantry") {
    openPantry();
    return;
  }
  activeView = view;
  document.body.dataset.view = view;
  document.querySelectorAll(".mobile-nav button, .desktop-nav .nav-item").forEach((button) => {
    const isActive = button.dataset.view === view;
    if (button.dataset.view) {
      button.classList.toggle("active", isActive);
      if (isActive) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
}

function loadSamplePantry() {
  if (state.pantry.length && !window.confirm("Replace your pantry with the sample list?")) return;
  state.pantry = [
    { name: "eggs", soon: true },
    { name: "spinach", soon: true },
    { name: "rice", soon: false },
    { name: "tortillas", soon: false },
    { name: "cheddar", soon: false },
    { name: "salsa", soon: false }
  ];
  state.constraints = { ...state.constraints, budget: 18, dinners: 3, maxTimeMin: 20 };
  state.excludedTitles = [];
  saveState();
  renderPantry();
  addUserMessage("I have 4 eggs, half a bag of spinach, 2 cups of cooked rice, 4 tortillas, some cheddar and salsa. The spinach and eggs need using. I have $18 and my saved cooking equipment.");
  $("starterPrompts").hidden = true;
  buildPlan("Prioritize the spinach and eggs, minimize extra purchases, and keep every dinner beginner-friendly.");
}

function cropImage(imageDataUrl, bbox) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const [x1, y1, x2, y2] = Array.isArray(bbox) && bbox.length === 4 ? bbox : [0, 0, 1, 1];
      const sx = Math.max(0, x1 * image.naturalWidth);
      const sy = Math.max(0, y1 * image.naturalHeight);
      const sw = Math.max(1, Math.min(image.naturalWidth - sx, (x2 - x1) * image.naturalWidth));
      const sh = Math.max(1, Math.min(image.naturalHeight - sy, (y2 - y1) * image.naturalHeight));
      const scale = Math.min(1, 320 / Math.max(sw, sh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      canvas.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => resolve(imageDataUrl);
    image.src = imageDataUrl;
  });
}

function resizeImageForVision(file, maxEdge = MAX_VISION_IMAGE_EDGE) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const originalDataUrl = reader.result;
      const image = new Image();
      image.onerror = () => resolve(originalDataUrl);
      image.onload = () => {
        const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
        if (longestEdge <= maxEdge) return resolve(originalDataUrl);
        const scale = maxEdge / longestEdge;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      image.src = originalDataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function renderVisionReview() {
  const section = $("visionReview");
  section.hidden = visionReviewItems.length === 0;
  $("visionReviewCount").textContent = visionReviewItems.length || "";
  $("visionReviewList").innerHTML = visionReviewItems.map((item, index) => `
    <article class="vision-review-card">
      <img class="vision-review-crop" src="${item.cropDataUrl}" alt="Photo crop for ${escapeHtml(item.guess)}">
      <div class="vision-review-fields">
        <label for="visionGuess${index}">What is this?</label>
        <input id="visionGuess${index}" value="${escapeHtml(item.guess === "unknown item" ? "" : item.guess)}" placeholder="Type the item name" autocomplete="off">
        <p class="vision-review-reason">${escapeHtml(item.reason || "The item was not clear enough to add.")}</p>
        ${item.alternatives?.length ? `<p class="vision-review-alternatives">Other possibilities: ${escapeHtml(item.alternatives.join(", "))}</p>` : ""}
        <div class="vision-review-actions">
          <button type="button" data-vision-action="confirm" data-index="${index}">Add item</button>
          <button type="button" data-vision-action="dismiss" data-index="${index}">Dismiss</button>
        </div>
      </div>
    </article>
  `).join("");
}

async function prepareVisionReview(items, imageDataUrl) {
  visionReviewItems = await Promise.all((items || []).map(async (item) => ({
    ...item,
    cropDataUrl: await cropImage(imageDataUrl, item.bbox)
  })));
  renderVisionReview();
}

async function handlePhoto(file) {
  if (!file) return;
  addUserMessage(`I added a photo: ${file.name}`);
  showThinking();
  visionReviewItems = [];
  renderVisionReview();

  try {
    const imageDataUrl = await resizeImageForVision(file);
    const response = await fetch("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl })
    });
    const result = await response.json();
    hideThinking();
    if (!result.ok) throw new Error(result.failure?.message || "The photo could not be read");

    const confirmed = result.confirmed || [];
    const uncertain = result.uncertain || [];
    confirmed.forEach((item) => addPantryItem(item.name, false));
    await prepareVisionReview(uncertain, imageDataUrl);
    saveState();
    renderPantry();
    addAssistantMessage(
      confirmed.length ? `I clearly found ${confirmed.map((item) => item.name).join(", ")}.` : "I did not add anything I could not clearly identify.",
      uncertain.length
        ? `${uncertain.length} item${uncertain.length === 1 ? " needs" : "s need"} your confirmation. Check the cropped photo${uncertain.length === 1 ? "" : "s"} in the pantry.`
        : confirmed.length ? "I added only the fully visible matches." : "Try a closer photo with the whole item and label visible."
    );
    openPantry();
  } catch (error) {
    hideThinking();
    addAssistantMessage("I could not read that photo.", "Try a brighter, closer shot or type the ingredients instead.");
    toast(error.message, "error");
  } finally {
    $("photoInput").value = "";
  }
}

$("profileButton").addEventListener("click", openProfile);
$("exportKitchenButton").addEventListener("click", exportKitchen);
$("importKitchenButton").addEventListener("click", () => $("importKitchenInput").click());
$("importKitchenInput").addEventListener("change", (event) => {
  const [file] = event.target.files || [];
  importKitchen(file);
  // Let the same file be chosen twice in a row.
  event.target.value = "";
});

document
  .querySelectorAll("[data-close-profile]")
  .forEach((button) => {
    button.addEventListener("click", closeProfile);
  });

$("profileBudget").addEventListener("input", () => {
  $("profileBudgetValue").textContent = `$${$("profileBudget").value}`;
});

$("profileForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const equipment = readCheckedValues("profile-equipment");
  if (!equipment.length) {
    toast("Choose at least one cooking option.", "error");
    return;
  }

  if (state.plan && !state.plan.constraints) {
    state.plan.constraints = clone(state.constraints);
  }

  state.profile = {
    ...state.profile,
    displayName: $("profileName").value.trim().slice(0, 40),
  };

  state.constraints.equipment = equipment;
  state.constraints.diet = readCheckedValues("profile-diet").join(", ");
  state.constraints.budget = clampNumber($("profileBudget").value, PREFERENCES.limits.budget, 20);

  saveState();
  renderProfile();
  closeProfile();

  toast("Profile saved. New plans will use these preferences.");
});

/* ---------------- groceries: build a list, price it at every nearby store ---------------- */

let comparing = false;
const DEFAULT_OFFER_AREA = "Tempe, AZ 85281";
const MAX_ADVERTISED_OFFER_ITEMS = 5;

function addGroceryItem(name, qty = 1) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return false;
  const existing = state.groceryList.find((item) => item.name === normalized);
  if (existing) {
    existing.qty = Math.min(existing.qty + qty, MAX_GROCERY_QTY);
    return false;
  }
  if (state.groceryList.length >= MAX_GROCERY_ITEMS) {
    toast(`The list is capped at ${MAX_GROCERY_ITEMS} items.`, "error");
    return false;
  }
  state.groceryList.push({ name: normalized, qty: Math.min(Math.max(1, qty), MAX_GROCERY_QTY) });
  return true;
}

function safeOfferUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function offerTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString();
}

function safeOfferBranch(value) {
  if (!value || typeof value !== "object") return null;
  const id = safeText(value.id, 120).trim();
  const name = safeText(value.name, 240).trim();
  const address = safeText(value.address, 400).trim();
  const url = safeOfferUrl(value.url);
  return {
    id,
    name,
    address,
    url,
    valid: Boolean(id && name && url)
  };
}

function localOfferDetails(source) {
  const branch = safeOfferBranch(source?.branch);
  const offerUrl = safeOfferUrl(source?.url);
  const price = Number(source?.price);
  const priced = Boolean(offerUrl) && Number.isFinite(price) && price > 0;
  const retailer = safeText(source?.retailer, 80).trim();
  if (source?.scope === "branch-advertised" && branch?.valid && priced) {
    return { kind: "branch", branch, offerUrl, price, retailer, valid: true };
  }
  // A retailer-advertised price is the chain's advertised web price. It is
  // shown with its own label because pickup at a nearby branch is not verified.
  if (source?.scope === "retailer-advertised" && priced) {
    return { kind: "retailer", branch: null, offerUrl, price, retailer, valid: true };
  }
  // The Kroger API returns the exact price for the selected store, not a page.
  if (source?.scope === "store-api" && priced) {
    return { kind: "retailer", branch: null, offerUrl, price, retailer, storeApi: true, valid: true };
  }
  return { kind: "none", branch, offerUrl, price: null, retailer, valid: false };
}

function redactUnverifiedPriceText(value) {
  return safeText(value, 700)
    .replace(/\$\s*\d{1,4}(?:,\d{3})*(?:\.\d{2})?/g, "[price omitted]")
    .replace(/\b\d{1,4}(?:,\d{3})*\.\d{2}\b/g, "[price omitted]");
}

function renderGroceryList() {
  const count = state.groceryList.length;
  $("groceryNavCount").textContent = count;
  $("mobileGroceryCount").textContent = count;
  $("compareButton").disabled = count === 0;

  const planItems = state.plan?.shoppingList?.length || 0;
  $("fromPlanButton").disabled = planItems === 0;
  $("fromPlanButton").textContent = "Add plan items";
  $("planShopButton").disabled = planItems === 0;
  $("planShopButton").textContent = "Add to shop";

  if (!count) {
    $("groceryList").innerHTML = `
      <div class="grocery-empty">
        Nothing on the list yet. Add what you need to buy, or pull in the missing
        ingredients from your meal plan.
      </div>`;
    return;
  }

  $("groceryList").innerHTML = state.groceryList.map((item, index) => `
    <div class="grocery-item${item.unknown ? " unknown" : ""}">
      <span class="grocery-item-name">
        <strong>${escapeHtml(item.name)}</strong>
        ${item.unknown ? "<span>No supported web price found</span>" : ""}
      </span>
      <span class="qty-stepper">
        <button type="button" data-grocery-action="less" data-index="${index}" aria-label="Fewer ${escapeHtml(item.name)}">−</button>
        <span>${Number(item.qty) || 1}</span>
        <button type="button" data-grocery-action="more" data-index="${index}" aria-label="More ${escapeHtml(item.name)}">+</button>
      </span>
      <button type="button" class="remove-item" data-grocery-action="remove" data-index="${index}" aria-label="Remove ${escapeHtml(item.name)}">Remove</button>
    </div>
  `).join("");
}

function renderLocation() {
  const bar = $("locationBar");
  const located = Boolean(state.location);
  bar.classList.toggle("located", located);
  $("useLocationButton").textContent = located ? "Update location" : "Use my location";
  $("locationLabel").textContent = located
    ? (state.location.label || "Your location")
    : "No location shared yet";
}

// Sharing a location is the consent: the request always asks for the name, and
// the server rounds the fix to ~110 m before OpenStreetMap sees it. The label
// stays usable when the lookup fails, so the name is never load-bearing.
const LOCATION_PENDING_LABEL = "Working out where that is…";
let locationRevision = 0;

async function describeCurrentLocation() {
  if (!state.location) return;
  const revision = locationRevision;
  const settle = (label) => {
    if (!state.location) return;
    state.location.label = label;
    saveState();
    renderLocation();
  };
  try {
    const response = await fetch("/api/geo/describe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: state.location.lat, lng: state.location.lng, allowLookup: true })
    });
    const result = await response.json();
    if (revision !== locationRevision) return;
    if (!result.ok) {
      settle("Your location");
      return;
    }
    if (result.placeName) {
      settle(result.placeName);
      return;
    }
    settle("Your location");
    if (result.failure) toast("Could not reach the place-name service. Showing your location instead.", "error");
  } catch {
    // A failed lookup must not leave the label stuck mid-sentence.
    if (revision !== locationRevision || state.location?.label !== LOCATION_PENDING_LABEL) return;
    settle("Your location");
  }
}

function requestLocation() {
  const hadPreviousLocation = Boolean(state.location);
  const reportLocationFailure = (message) => {
    const suffix = hadPreviousLocation
      ? " Keeping your previous location."
      : "";
    toast(`${message}${suffix}`, "error");
  };
  if (!navigator.geolocation) {
    reportLocationFailure("This browser has no location support.");
    return;
  }
  // Every browser blocks geolocation outside a secure context, so the LAN-IP
  // demo path (http://192.168.x.x:3000) fails here no matter the permission.
  if (window.isSecureContext === false) {
    reportLocationFailure("Location needs HTTPS or localhost.");
    return;
  }
  const button = $("useLocationButton");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      locationRevision += 1;
      state.location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracyM: Number(position.coords.accuracy),
        label: LOCATION_PENDING_LABEL
      };
      saveState();
      renderLocation();
      button.disabled = false;
      toast("Location set. Distances are measured from here.");
      describeCurrentLocation();
      invalidateGroceryResults();
      if (state.groceryList.length) compareStores();
    },
    (error) => {
      button.disabled = false;
      button.textContent = original;
      const reason = error.code === error.PERMISSION_DENIED
        ? "Location permission was denied."
        : error.code === error.TIMEOUT
          ? "Locating timed out."
          : "Location is unavailable.";
      reportLocationFailure(reason);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

let groceryRevision = 0;
function invalidateGroceryResults() {
  groceryRevision += 1;
  $("groceryResults").innerHTML = '<p class="results-note">Your list changed. Compare stores again for updated totals.</p>';
}

async function compareStores() {
  if (comparing || !state.groceryList.length) return;
  comparing = true;
  const revision = groceryRevision;
  const button = $("compareButton");
  button.disabled = true;
  button.textContent = "Checking live prices…";
  const area = $("offerAreaInput").value.trim() || DEFAULT_OFFER_AREA;
  const names = state.groceryList.map((item) => item.name);
  // The server checks each chain with one search per item, so a cart over the
  // per-request cap runs in sequential batches and the results are merged.
  $("groceryResults").innerHTML = `<p class="results-note">Checking live store pages near ${escapeHtml(area)}. This searches each store once per item and can take a few seconds.</p>`;

  try {
    const results = [];
    for (let index = 0; index < names.length; index += MAX_ADVERTISED_OFFER_ITEMS) {
      const batch = names.slice(index, index + MAX_ADVERTISED_OFFER_ITEMS);
      const response = await fetch("/api/grocery/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: batch, area })
      });
      const result = await response.json();
      if (revision !== groceryRevision) return;
      if (!response.ok || !result.ok) {
        throw new Error(result.failure?.message || `Live comparison returned HTTP ${response.status}`);
      }
      results.push(result);
    }
    const estimates = mergeStoreEstimates(results, names);
    renderLiveComparison({ area, estimates, failures: results.flatMap((result) => result.failures || []) });
  } catch (error) {
    if (revision !== groceryRevision) return;
    $("groceryResults").innerHTML = `<p class="results-note warn">${escapeHtml(error.message)}</p>`;
    toast(error.message, "error");
  } finally {
    comparing = false;
    button.disabled = state.groceryList.length === 0;
    button.textContent = "Find the cheapest store";
  }
}

// The server sends one storeEstimates entry per chain per batch. Merging them
// keeps a full-cart ballpark without a second round of searches.
function mergeStoreEstimates(results, requestedNames) {
  const requestedCount = requestedNames.length;
  const byChain = new Map();
  for (const result of results) {
    for (const estimate of result.storeEstimates || []) {
      const entry = byChain.get(estimate.chain) || { chain: estimate.chain, label: estimate.label, lines: [], missing: [], branch: null };
      entry.lines.push(...(Array.isArray(estimate.lines) ? estimate.lines : []));
      entry.missing.push(...(Array.isArray(estimate.missing) ? estimate.missing : []));
      entry.branch = entry.branch || estimate.branch || null;
      entry.label = entry.label || estimate.label;
      byChain.set(estimate.chain, entry);
    }
  }
  const merged = [...byChain.values()].map((entry) => {
    const missing = requestedNames.filter((name) => !entry.lines.some((line) => line.item === name));
    return {
      ...entry,
      missing,
      itemCount: entry.lines.length,
      requestedCount,
      advertisedCount: entry.lines.length,
      total: +entry.lines.reduce((sum, line) => sum + (Number(line.price) || 0), 0).toFixed(2),
      complete: requestedCount > 0 && entry.lines.length === requestedCount && missing.length === 0,
    };
  });
  merged.sort((a, b) =>
    Number(b.complete) - Number(a.complete) ||
    b.itemCount - a.itemCount ||
    a.total - b.total ||
    a.label.localeCompare(b.label)
  );
  merged.forEach((entry, index) => { entry.cheapest = index === 0 && entry.itemCount > 0; });
  return merged;
}

function renderLiveComparison({ area, estimates, failures }) {
  const section = renderStoreEstimates(estimates, area);
  if (!section) {
    $("groceryResults").innerHTML = '<p class="results-note warn">No advertised prices came back. Try again, or check the search area.</p>';
    return;
  }
  const failureNotes = (failures || [])
    .slice(0, 3)
    .map((entry) => `<p class="results-note warn">${escapeHtml(entry.item ? `${titleCase(entry.item)}: ${entry.message}` : entry.message)}</p>`)
    .join("");
  $("groceryResults").innerHTML = section + failureNotes;
}

function renderStoreEstimates(estimates, area) {
  if (!Array.isArray(estimates) || !estimates.length) return "";
  const cards = estimates.map((estimate, index) => {
    const lines = (Array.isArray(estimate.lines) ? estimate.lines : []).map((line) => {
      const validTo = safeText(line.validTo, 40).trim();
      const weeklyUntil = validTo && !Number.isNaN(new Date(validTo).getTime())
        ? ` through ${new Date(validTo).toLocaleDateString()}`
        : "";
      const priceNote = line.origin === "weekly-ad"
        ? `weekly ad${weeklyUntil}`
        : line.origin === "store-api"
          ? "store price"
          : line.scope === "branch-advertised" ? "branch page" : "advertised web price";
      return `
      <tr>
        <td>
          ${escapeHtml(titleCase(line.item))}
          <div class="pack-note">${escapeHtml(safeText(line.product, 200) || "Advertised package")}</div>
        </td>
        <td>
          ${escapeHtml(formatMoney(Number(line.price) || 0))}
          <div class="pack-note">${escapeHtml(priceNote)}</div>
        </td>
      </tr>`;
    }).join("");
    const label = safeText(estimate.label, 120).trim() || "Store";
    const branchName = safeText(estimate.branch?.name, 240).trim();
    const meta = [
      `${Number(estimate.itemCount) || 0} of ${Number(estimate.requestedCount) || 0} items priced`,
      branchName
    ].filter(Boolean).join(" · ");
    const missing = Array.isArray(estimate.missing) && estimate.missing.length
      ? `<p class="store-missing">No live price found: ${escapeHtml(estimate.missing.join(", "))}</p>`
      : "";
    const rankLabel = estimate.cheapest
      ? estimate.complete ? "CHEAPEST LIVE BALLPARK" : "BEST LIVE BALLPARK SO FAR"
      : `#${index + 1}`;
    return `<article class="store-card${estimate.cheapest ? " best" : ""}">
      <div>
        <span class="store-rank">${rankLabel}</span>
        <h3 class="store-name">${escapeHtml(label)}</h3>
        <p class="store-meta">${escapeHtml(meta)}</p>
        ${missing}
      </div>
      <div class="store-total">
        <strong>${escapeHtml(formatMoney(Number(estimate.total) || 0))}</strong>
        <small>${estimate.complete ? "BALLPARK" : "PARTIAL"}</small>
      </div>
      <details class="store-breakdown">
        <summary>Price breakdown</summary>
        <table>
          <thead><tr><th>Item</th><th>Price</th></tr></thead>
          <tbody>${lines}</tbody>
        </table>
      </details>
    </article>`;
  }).join("");
  const areaLabel = safeText(area, 120).trim();
  // The profile budget applies here now: it compares against the cheapest
  // complete live ballpark, not against any precomputed catalog total.
  const budget = Number(state.constraints.budget);
  const winner = estimates.find((estimate) => estimate.cheapest);
  const budgetNote = winner && winner.complete && Number.isFinite(budget) && budget > 0
    ? `<p class="results-note${winner.total > budget ? " warn" : ""}">${escapeHtml(formatMoney(Math.abs(budget - winner.total)))} ${winner.total <= budget ? "under" : "over"} your ${escapeHtml(formatMoney(budget))} budget at ${escapeHtml(safeText(winner.label, 120).trim() || "the cheapest store")}.</p>`
    : "";
  return `
    <section class="advertised-basket">
      <div class="advertised-results-heading">
        <div><h3>Where to buy this list</h3><small>Live advertised prices${areaLabel ? ` near ${escapeHtml(areaLabel)}` : ""}, ranked by items priced, then total</small></div>
      </div>
      <p class="results-note">Live prices found on each store's own pages. Package sizes, pickup availability, and in-store prices are not verified.</p>
      ${budgetNote}
      <div class="store-list">${cards}</div>
    </section>`;
}

$("groceryForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("groceryInput").value.trim();
  if (!value) return;
  const names = value.split(",").map((item) => item.trim()).filter(Boolean);
  let added = 0;
  for (const name of names) if (addGroceryItem(name)) added++;
  $("groceryInput").value = "";
  saveState();
  renderGroceryList();
  invalidateGroceryResults();
  if (added) toast(`${added === 1 ? titleCase(names[0]) : `${added} items`} added to the list`);
});

$("groceryList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-grocery-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  const item = state.groceryList[index];
  if (!item) return;
  const action = button.dataset.groceryAction;
  if (action === "remove") state.groceryList.splice(index, 1);
  if (action === "more") item.qty = Math.min((Number(item.qty) || 1) + 1, MAX_GROCERY_QTY);
  if (action === "less") {
    item.qty = (Number(item.qty) || 1) - 1;
    if (item.qty < 1) state.groceryList.splice(index, 1);
  }
  saveState();
  renderGroceryList();
  invalidateGroceryResults();
});

// Copies the meal plan's shopping list into the Shop list. Shared by the plan
// panel button and the "add the list to shop" chat command.
function addPlanItemsToShop() {
  const planItems = state.plan?.shoppingList || [];
  if (!planItems.length) return 0;
  let added = 0;
  for (const entry of planItems) {
    const existing = state.groceryList.find((item) => item.name === entry.item.toLowerCase());
    const required = Math.min(MAX_GROCERY_QTY, Math.max(1, Number(entry.qty) || 1));
    if (existing) {
      if (existing.qty < required) { existing.qty = required; added++; }
    } else if (addGroceryItem(entry.item, required)) added++;
  }
  saveState();
  renderGroceryList();
  invalidateGroceryResults();
  return added;
}

function addPlanItemsToShopMessage() {
  if (!(state.plan?.shoppingList || []).length) return;
  const added = addPlanItemsToShop();
  toast(added ? `${added} item${added === 1 ? "" : "s"} added from your meal plan` : "Those items are already on the list");
}

$("fromPlanButton").addEventListener("click", addPlanItemsToShopMessage);
$("planShopButton").addEventListener("click", addPlanItemsToShopMessage);

/* ----- welcome wizard wiring ----- */
$("welcomeNext").addEventListener("click", advanceWelcome);
$("welcomeBack").addEventListener("click", () => {
  if (welcomeIndex === 0) return;
  welcomeIndex -= 1;
  $("equipmentError").hidden = true;
  renderWelcomeStep();
});
$("welcomeSkip").addEventListener("click", () => {
  // Skipping still keeps whatever was entered, and still counts as onboarded
  // so the identity step is not asked for again.
  commitWelcome({ markOnboarded: true });
  closeWelcome();
});
$("welcomeBudget").addEventListener("input", () => {
  $("welcomeBudgetValue").textContent = `$${$("welcomeBudget").value}`;
});
$("welcomeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  advanceWelcome();
});
bindOptionToggles($("welcomeForm"), "welcome");
bindOptionToggles($("profileForm"), "profile");

$("useLocationButton").addEventListener("click", requestLocation);
$("compareButton").addEventListener("click", compareStores);
$("offerAreaInput").addEventListener("input", () => {
  groceryRevision += 1;
  $("groceryResults").innerHTML = '<p class="results-note">Search area changed. Compare stores again for updated totals.</p>';
});

$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const message = $("chatInput").value;
  $("chatInput").value = "";
  $("chatInput").style.height = "auto";
  handleMessage(message);
});

$("chatInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("chatForm").requestSubmit();
  }
});

$("chatInput").addEventListener("input", () => {
  $("chatInput").style.height = "auto";
  $("chatInput").style.height = `${Math.min($("chatInput").scrollHeight, 120)}px`;
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => handleMessage(button.dataset.prompt));
});

$("samplePantryButton").addEventListener("click", loadSamplePantry);
$("photoButton").addEventListener("click", () => $("photoInput").click());
$("drawerPhotoButton").addEventListener("click", () => $("photoInput").click());
$("photoInput").addEventListener("change", () => handlePhoto($("photoInput").files[0]));
$("openPantryButton").addEventListener("click", openPantry);
document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", closePantry));

$("pantryForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("pantryInput").value.trim();
  if (!value) return;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  items.forEach((item) => addPantryItem(item, false));
  $("pantryInput").value = "";
  saveState();
  renderPantry();
  toast(`${items.length === 1 ? titleCase(items[0]) : `${items.length} items`} added`);
});

$("pantryList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-pantry-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (!state.pantry[index]) return;
  if (button.dataset.pantryAction === "soon") state.pantry[index].soon = !state.pantry[index].soon;
  if (button.dataset.pantryAction === "remove") state.pantry.splice(index, 1);
  saveState();
  renderPantry();
});

$("visionReviewList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-vision-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  const item = visionReviewItems[index];
  if (!item) return;
  if (button.dataset.visionAction === "confirm") {
    const name = $(`visionGuess${index}`).value.trim();
    if (!name) {
      toast("Type the item name before adding it.", "error");
      return;
    }
    addPantryItem(name, false);
    saveState();
    renderPantry();
    toast(`${titleCase(name)} added`);
  }
  visionReviewItems.splice(index, 1);
  renderVisionReview();
});

$("mealList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || !state.plan) return;
  const index = Number(button.dataset.index);
  const meal = state.plan.dinners[index];
  if (!meal) return;

  if (button.dataset.action === "details") {
    button.closest(".meal-card").classList.toggle("open");
    button.textContent = button.closest(".meal-card").classList.contains("open") ? "Hide" : "Steps";
    return;
  }

  if (button.dataset.action === "save") {
    toggleSavedRecipe(meal);
    return;
  }

  if (button.dataset.action === "swap") {
    // The plan prompt lets a title describe the adapted result, so the title
    // alone does not identify the recipe to avoid; the citation does.
    addExclusion(meal.sourceRecipe || meal.title);
    planningOptions = { swapIndex: index, previousDinners: clone(state.plan.dinners) };
    saveState();
    setView("chat");
    addUserMessage(`Swap ${meal.title}. Keep the same budget and equipment.`);
    await buildPlan(`Replace ${meal.title} with a different beginner-friendly dinner. Keep the same budget and equipment.`);
  }
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view === "pantry") {
      openPantry();
      return;
    }
    setView(view);
    if (view === "chat") $("chatInput").focus();
    if (view === "plan") $("planView").querySelector(".plan-scroll").scrollTo({ top: 0, behavior: "smooth" });
  });
});

$("savedRecipeList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-saved-action]");
  if (!button) return;
  const recipe = state.savedRecipes[Number(button.dataset.index)];
  if (!recipe) return;

  if (button.dataset.savedAction === "remove") {
    toggleSavedRecipe(recipe);
    return;
  }
  // "Cook again" asks for the recipe by its citation, which is what the server
  // matches on, rather than by a title the model is free to reword.
  const named = recipe.sourceRecipe || recipe.title;
  state.excludedTitles = state.excludedTitles.filter((title) => normaliseKey(title) !== normaliseKey(named));
  planningOptions = { includeRecipe: named };
  saveState();
  setView("chat");
  addUserMessage(`Put ${named} back in the plan.`);
  buildPlan(`Include ${named} as one of the dinners. Keep the same budget and equipment.`);
});

function resetDemo() {
  const warning = "Reset the demo? This clears your kitchen, including your profile, pantry, plan, chat history, Shop list, and saved location.";
  if (!window.confirm(warning)) return;
  state = clone(DEFAULT_STATE);
  saveState();
  window.location.reload();
}

$("resetDemoButton").addEventListener("click", resetDemo);
$("resetMobileButton").addEventListener("click", resetDemo);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePantry();
    closeProfile();
  }
});

if (state.messages?.length) {
  $("starterPrompts").hidden = true;
  $("messages").innerHTML = "";
  for (const entry of state.messages) {
    if (entry.role === "user") addUserMessage(entry.text, { record: false });
    else addAssistantMessage(entry.text, entry.supportingText || "", { record: false, tone: entry.tone });
  }
} else if (state.plan) {
  $("starterPrompts").hidden = true;
  const firstMessage = document.querySelector(".assistant-message .message-copy");
  firstMessage.innerHTML = "<p>Your last plan and pantry are still here. Tell me what changed.</p><p class=\"message-example\">Try \"lower my budget to $15\" or swap a meal from the plan.</p>";
}

updateChatEmptyState();
syncPantryShell();
renderProfile();
renderPantry();
renderPlan();
renderGroceryList();
renderSavedRecipes();
renderLocation();
setView(activeView);

// The welcome wizard is a one-time landing experience: it runs once, ever,
// on the very first visit. After that, preferences are only ever changed by
// deliberately opening the profile drawer — never re-asked on login.
if (needsOnboarding()) openWelcome();
