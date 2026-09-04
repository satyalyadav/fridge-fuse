const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "fridgefuse-state-v2";
const MAX_VISION_IMAGE_EDGE = 1024;

const KNOWN_INGREDIENTS = [
  "banana", "black beans", "bread", "butter", "carrots", "cheddar",
  "chicken breast", "eggs", "frozen peas", "garlic", "ground beef",
  "marinara", "milk", "oats", "olive oil", "onion", "pasta",
  "peanut butter", "potatoes", "rice", "salsa", "soy sauce",
  "spinach", "tortillas", "yogurt"
];

const ALIASES = {
  "beans": "black beans",
  "cheese": "cheddar",
  "chicken": "chicken breast",
  "peas": "frozen peas",
  "tomato sauce": "marinara",
  "spaghetti sauce": "marinara",
  "wraps": "tortillas"
};

const DEFAULT_STATE = {
  profile: {
    displayName: "",
    postalCode: "",
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
  location: null,
  // null = never asked. Only true sends coordinates to the place-name service.
  allowPlaceLookup: null
};

const MAX_EXCLUDED = 20;
const MAX_MESSAGES = 30;
const PROFILE_EQUIPMENT_OPTIONS = ["microwave", "stove", "oven", "air fryer"];
const PROFILE_DIET_OPTIONS = ["vegetarian", "vegan", "dairy-free", "gluten-free", "no peanuts"];
const PROFILE_EXTRA_DIET_TERMS = ["peanut allergy"];
const MAX_GROCERY_ITEMS = 50;
const MAX_GROCERY_QTY = 99;

function addExclusion(title) {
  if (!title) return;
  state.excludedTitles = [...new Set([...state.excludedTitles, title])].slice(-MAX_EXCLUDED);
}

function isLegacyRecipeCitation(dinner) {
  if (String(dinner?.source || "").trim() === "FridgeFuse Demo Catalog") return true;
  try {
    const hostname = new URL(String(dinner?.sourceUrl || "")).hostname.toLowerCase();
    return hostname === "github.com" || hostname.endsWith(".github.com");
  } catch {
    return false;
  }
}

function sanitizeStoredPlan(plan) {
  if (!plan || !Array.isArray(plan.dinners)) return plan;
  let changed = false;
  const dinners = plan.dinners.map((dinner) => {
    if (!isLegacyRecipeCitation(dinner)) return dinner;
    changed = true;
    const { source, sourceUrl, ...rest } = dinner;
    return { ...rest, sourceUnavailable: true };
  });
  return changed ? { ...plan, dinners } : plan;
}

// structuredClone is missing on Safari < 15.4 and other older browsers, and the
// whole app runs through it on load — fall back rather than fail to start.
const clone = typeof structuredClone === "function"
  ? structuredClone
  : (value) => JSON.parse(JSON.stringify(value));

let state = loadState();
let activeMobileView = state.plan ? "plan" : "chat";
let visionReviewItems = [];

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored) return clone(DEFAULT_STATE);
    return {
      ...clone(DEFAULT_STATE),
      ...stored,
      profile: {
        ...DEFAULT_STATE.profile,
        ...(stored.profile || {}),
        onboarded: stored.profile?.onboarded === true
      },
      constraints: { ...DEFAULT_STATE.constraints, ...(stored.constraints || {}) },
      plan: sanitizeStoredPlan(stored.plan || null),
      pantry: Array.isArray(stored.pantry) ? stored.pantry : [],
      excludedTitles: Array.isArray(stored.excludedTitles) ? stored.excludedTitles.slice(-MAX_EXCLUDED) : [],
      messages: Array.isArray(stored.messages) ? stored.messages.slice(-MAX_MESSAGES) : [],
      groceryList: Array.isArray(stored.groceryList) ? stored.groceryList.slice(0, MAX_GROCERY_ITEMS) : [],
      location: stored.location && Number.isFinite(stored.location.lat) && Number.isFinite(stored.location.lng)
        ? stored.location
        : null,
      // Anything other than a stored true/false means the question is still open.
      allowPlaceLookup: typeof stored.allowPlaceLookup === "boolean" ? stored.allowPlaceLookup : null
    };
  } catch {
    return clone(DEFAULT_STATE);
  }
}

function recordMessage(entry) {
  state.messages = [...(state.messages || []), entry].slice(-MAX_MESSAGES);
  saveState();
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
  const { record = true } = typeof options === "boolean" ? { record: options } : options;
  const article = document.createElement("article");
  article.className = "message assistant-message";
  article.innerHTML = `
    <div class="assistant-symbol" aria-hidden="true">F</div>
    <div class="message-copy">
      <p>${escapeHtml(text)}</p>
      ${supportingText ? `<p class="message-example">${escapeHtml(supportingText)}</p>` : ""}
    </div>`;
  $("messages").append(article);
  scrollMessages();
  if (record) recordMessage({ role: "assistant", text, supportingText });
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

function getIngredientMentions(message) {
  const lower = ` ${message.toLowerCase()} `;
  const found = new Set();

  for (const ingredient of KNOWN_INGREDIENTS) {
    const pattern = new RegExp(`\\b${ingredient.replaceAll(" ", "\\s+")}\\b`);
    if (pattern.test(lower)) found.add(ingredient);
  }
  for (const [alias, ingredient] of Object.entries(ALIASES)) {
    if (new RegExp(`\\b${alias.replace(" ", "\\s+")}\\b`).test(lower)) found.add(ingredient);
  }
  return [...found];
}

function mentionIndex(lower, ingredient) {
  let idx = lower.indexOf(ingredient);
  if (idx !== -1) return idx;
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (target === ingredient) {
      idx = lower.indexOf(alias);
      if (idx !== -1) return idx;
    }
  }
  return -1;
}

function roughAmount(message, ingredient) {
  const lower = message.toLowerCase();
  const idx = mentionIndex(lower, ingredient);
  if (idx === -1) return "some";
  const near = lower.slice(Math.max(0, idx - 18), idx + ingredient.length + 18);
  if (/half|1\/2/.test(near)) return "about half left";
  if (/almost (?:gone|empty)|little|tiny bit/.test(near)) return "almost gone";
  if (/full|unopened|whole/.test(near)) return "plenty";
  const count = near.match(/\b(\d+)\b/);
  return count ? `about ${count[1]} left` : "some";
}

function addPantryItem(name, amount = "some", soon = false) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  const existing = state.pantry.find((item) => item.name === normalized);
  if (existing) {
    existing.amount = amount || existing.amount;
    existing.soon = Boolean(existing.soon || soon);
    return false;
  }
  state.pantry.push({ name: normalized, amount: amount || "some", soon: Boolean(soon) });
  return true;
}

function ingredientNeedsUsing(message, ingredient) {
  const itemPattern = ingredient.replaceAll(" ", "\\s+");
  const item = new RegExp("\\b" + itemPattern + "\\b", "i");
  const urgency = /\b(?:use|using|used|going bad|expir|wilting|old)\b/i;
  return message.split(/[.!?;\n]+/).some((sentence) => item.test(sentence) && urgency.test(sentence));
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

function parseMessage(message) {
  const lower = message.toLowerCase();
  const ingredients = getIngredientMentions(message);
  const removalPattern = /\b(?:out of|no more|used up|remov(?:e|ing)|don't have|do not have|dont have|all gone|no (?:more )?left)\b/;
  const removalTargets = new Set();
  for (const sentence of message.split(/[.!?;\n]+/)) {
    if (!removalPattern.test(sentence.toLowerCase())) continue;
    for (const name of getIngredientMentions(sentence)) {
      const clause = clausesOf(sentence).find((c) => clauseMentionIndex(c, name) !== -1) || sentence;
      const idx = clauseMentionIndex(clause, name);
      // "I have eggs, but I'm out of milk" must only remove milk: an affirmed
      // mention without its own negation is exempt.
      if (idx !== -1 && affirmedBefore(clause, idx) && !negatedBefore(clause, idx)) continue;
      removalTargets.add(name);
    }
  }
  const removal = removalTargets.size > 0;
  const urgency = /\b(?:use|using|used|going bad|expir|wilting|old)\b/.test(lower);
  let pantryChanged = false;

  if (removal) {
    for (const ingredient of removalTargets) {
      const before = state.pantry.length;
      state.pantry = state.pantry.filter((item) => item.name !== ingredient);
      pantryChanged ||= before !== state.pantry.length;
    }
  } else if (ingredients.length) {
    for (const ingredient of ingredients) {
      const useSoon = urgency && ingredientNeedsUsing(message, ingredient);
      pantryChanged = addPantryItem(ingredient, roughAmount(message, ingredient), useSoon) || pantryChanged;
    }
  }

  const budget = lower.match(/\$(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:dollars|bucks)/);
  if (budget) state.constraints.budget = Number(budget[1] || budget[2]);

  const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const dinners = lower.match(/\b([1-7]|one|two|three|four|five|six|seven)\s+(?:easy\s+)?(?:dinners?|meals?|nights?)\b/);
  if (dinners) state.constraints.dinners = NUMBER_WORDS[dinners[1]] ?? Number(dinners[1]);

  const time = lower.match(/\b(\d{1,3})\s*(?:minutes?|mins?)\b/);
  if (time) state.constraints.maxTimeMin = Number(time[1]);

  const equipment = [];
  if (/\bmicrowave\b/.test(lower)) equipment.push("microwave");
  if (/\b(?:stove|hot plate|burner)\b/.test(lower)) equipment.push("stove");
  if (/\boven\b/.test(lower)) equipment.push("oven");
  if (lower.includes("air fryer")) equipment.push("air fryer");
  const removedEquipment = equipment.filter((item) =>
    clausesOf(message).some((clause) => {
      const idx = clauseMentionIndex(clause, item);
      return idx !== -1 && negatedBefore(clause, idx);
    })
  );
  const addedEquipment = equipment.filter((item) => !removedEquipment.includes(item));
  if (removedEquipment.length) {
    state.constraints.equipment = state.constraints.equipment.filter((item) => !removedEquipment.includes(item));
    if (!state.constraints.equipment.length) state.constraints.equipment = ["microwave"];
  }
  if (addedEquipment.length && /\b(?:only|just)\b/.test(lower)) state.constraints.equipment = [...new Set(addedEquipment)];
  else if (addedEquipment.length) state.constraints.equipment = [...new Set([...state.constraints.equipment, ...addedEquipment])];

  if (/\b(?:no (?:diet|diets|restrictions?)|not (?:vegetarian|vegan|gluten-free|dairy-free)(?: anymore)?|eat (?:everything|anything)|clear (?:my )?diet|regular diet)\b/.test(lower)) {
    state.constraints.diet = "";
  } else {
    const dietTerms = ["vegetarian", "vegan", "gluten-free", "dairy-free", "no peanuts", "peanut allergy"];
    const diets = dietTerms.filter((term) => lower.includes(term));
    if (diets.length) state.constraints.diet = diets.join(", ");
  }

  saveState();
  renderPantry();
  return { ingredients, pantryChanged, removal, urgency };
}

function isPantryOnlyRequest(message) {
  const lower = message.toLowerCase().trim();
  const namesPantry = /\b(?:pantry|fridge|mini[- ]fridge)\b/.test(lower);
  const changesPantry = /\b(?:add|put|save|store|remove)\b/.test(lower);
  const startsWithPantryAction = /^(?:(?:can|could|would) you\s+|please\s+)?(?:add|put|save|store|remove)\b/.test(lower);
  const asksForFoodIdeas = /\b(?:plan|recipe|dinner|meal|cook|make|suggest|idea|breakfast|lunch|tonight)\b/.test(lower);
  return (startsWithPantryAction || (namesPantry && changesPantry)) && !asksForFoodIdeas;
}

async function handleMessage(message) {
  const clean = message.trim();
  if (!clean) return;

  addUserMessage(clean);
  $("starterPrompts").hidden = true;
  const swapMatch = clean.toLowerCase().match(/\bswap\b.*?\b(one|two|three|four|five|six|seven|first|second|third|fourth|fifth|sixth|seventh|[1-7])\b/);
  if (swapMatch && state.plan?.dinners?.length) {
    const positions = { one: 0, two: 1, three: 2, four: 3, five: 4, six: 5, seven: 6, first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 };
    const meal = state.plan.dinners[positions[swapMatch[1]]];
    if (meal) addExclusion(meal.title);
  }
  const parsed = parseMessage(clean);

  if (isPantryOnlyRequest(clean) && parsed.ingredients.length) {
    const orderedIngredients = [...parsed.ingredients]
      .sort((a, b) => mentionIndex(clean.toLowerCase(), a) - mentionIndex(clean.toLowerCase(), b));
    const names = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" })
      .format(orderedIngredients);
    let confirmation;
    if (parsed.removal) {
      confirmation = parsed.pantryChanged
        ? `Removed ${names} from your pantry.`
        : `${capitalize(names)} ${orderedIngredients.length === 1 ? "was" : "were"} not in your pantry.`;
    } else {
      confirmation = parsed.pantryChanged
        ? `Added ${names} to your pantry.`
        : `${capitalize(names)} ${orderedIngredients.length === 1 ? "is" : "are"} already in your pantry.`;
    }
    addAssistantMessage(confirmation, "Ask me to build a meal plan when you want one.");
    setMobileView("chat");
    return;
  }

  if (!state.pantry.length && !parsed.ingredients.length) {
    addAssistantMessage(
      "What is already in your mini-fridge or room?",
      "Type a rough list, add a photo, or try the sample pantry. Even two ingredients help."
    );
    setMobileView("chat");
    return;
  }

  await buildPlan(clean);
}

async function buildPlan(request = "") {
  showThinking();
  const soon = state.pantry.filter((item) => item.soon).map((item) => item.name);

  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pantry: state.pantry.map((item) => item.name),
        useSoon: soon,
        budget: state.constraints.budget,
        dinners: state.constraints.dinners,
        maxTimeMin: state.constraints.maxTimeMin,
        equipment: state.constraints.equipment,
        diet: state.constraints.diet,
        request,
        exclude: state.excludedTitles
      })
    });
    if (!response.ok) throw new Error(`Planning returned HTTP ${response.status}`);
    const result = await response.json();
    if (!result.ok && !result.dinners) throw new Error(result.failure?.message || "The planner did not return a plan");

    state.plan = {
      ...result,
      constraints: structuredClone(state.constraints)
    };
    saveState();
    renderPlan();
    renderGroceryList();
    hideThinking();

    if (!result.dinners?.length) {
      addAssistantMessage(
        "I couldn't find any recipes for that combination.",
        result.note || "Try more time, more equipment, or fewer restrictions."
      );
      setMobileView("plan");
      return;
    }
    const budgetStatus = result.totalCost <= state.constraints.budget
      ? `The checkout total is ${formatMoney(result.totalCost)}, under your ${formatMoney(state.constraints.budget)} limit.`
      : `The cheapest full-package version is ${formatMoney(result.totalCost)}, which is over your ${formatMoney(state.constraints.budget)} limit.`;
    const soonText = soon.length ? ` I put ${soon.join(" and ")} first so it gets used.` : "";
    addAssistantMessage(
      `I built ${result.dinners.length} beginner-friendly dinners for the equipment you have.${soonText}`,
      `${budgetStatus} Say "swap dinner two," lower the budget, or tell me what you dislike.`
    );
    setMobileView("plan");
  } catch (error) {
    hideThinking();
    addAssistantMessage(
      "I could not build the plan.",
      "Check that the server is running, then send the message again."
    );
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
    $("budgetStamp").hidden = true;
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
  $("budgetStamp").hidden = false;
  $("planTitle").textContent = `${plan.dinners.length} ${plan.dinners.length === 1 ? "dinner" : "dinners"}, one small grocery run`;
  $("planSubtitle").textContent = `Built for ${planConstraints.equipment.join(" + ") || "the equipment you have"}, ${planConstraints.maxTimeMin} minutes or less each.`;
  $("budgetTotal").textContent = formatMoney(plan.totalCost);
  $("budgetLimit").textContent = `of ${formatMoney(planConstraints.budget)}`;
  $("budgetStamp").classList.toggle("over", plan.totalCost > planConstraints.budget);
  $("tripStatus").classList.add("ready");
  $("tripLabel").textContent = `${plan.shoppingList?.length || 0} packages · ${formatMoney(plan.totalCost)} estimated`;

  const soon = state.pantry.filter((item) => item.soon).map((item) => item.name);
  const shared = (plan.shoppingList || []).filter((item) => (item.sharedBy || []).length > 1);
  const logicParts = [];
  if (soon.length) logicParts.push(`${capitalize(soon.join(" and "))} get used first`);
  if (shared.length) logicParts.push(`${shared.length} purchase${shared.length === 1 ? " works" : "s work"} across multiple dinners`);
  logicParts.push(plan.totalCost <= planConstraints.budget ? `${formatMoney(planConstraints.budget - plan.totalCost)} stays in your budget` : `${formatMoney(plan.totalCost - planConstraints.budget)} over budget`);
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
      : meal.source && meal.sourceUrl && !isLegacyRecipeCitation(meal)
      ? `<a class="meal-source" href="${escapeHtml(meal.sourceUrl)}" target="_blank" rel="noopener noreferrer">Recipe source: ${escapeHtml(meal.source)}</a>`
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
          <button data-action="swap" data-index="${index}">Swap</button>
        </div>
        <div class="meal-details">
          <strong>How to make it</strong>
          <ol>${steps || "<li>Follow the package directions and combine the listed ingredients.</li>"}</ol>
        </div>
      </article>`;
  }).join("");

  const shopping = plan.shoppingList || [];
  $("shoppingList").innerHTML = shopping.map((item) => `
    <div class="receipt-row">
      <span class="receipt-item">
        <strong>${escapeHtml(item.item)}</strong>
        <small>${escapeHtml(item.pack || "1 package")} · ${escapeHtml(titleCase(item.store || "mock store"))}${(item.sharedBy || []).length > 1 ? ` · covers ${item.sharedBy.length} dinners` : ""}</small>
      </span>
      <span class="receipt-price">${formatMoney(Number(item.packPrice || 0) * Number(item.qty || 1))}</span>
    </div>
  `).join("") + `
    <div class="receipt-total"><span>ESTIMATED TOTAL</span><strong>${formatMoney(plan.totalCost)}</strong></div>`;

  const leftovers = plan.leftovers?.length ? plan.leftovers : shopping.slice(0, 4).map((item) => ({
    item: item.item,
    amount: (item.sharedBy || []).length > 1 ? "a little left" : "most of the package"
  }));
  $("leftoverList").innerHTML = leftovers.length
    ? leftovers.map((item) => `<div class="leftover-chip"><strong>${escapeHtml(item.item)}</strong><span>${escapeHtml(item.amount || item.remaining || "some left")}</span></div>`).join("")
    : `<div class="leftover-chip"><span>The plan uses the packages cleanly.</span></div>`;
}

function renderPantry() {
  $("pantryNavCount").textContent = state.pantry.length;
  $("mobilePantryCount").textContent = state.pantry.length;
  const soon = state.pantry.filter((item) => item.soon);
  $("useFirstText").textContent = soon.length ? soon.map((item) => titleCase(item.name)).join(" · ") : "Nothing marked yet";
  $("markUseSoonButton").textContent = soon.length ? "Edit pantry" : "Mark an item";

  if (!state.pantry.length) {
    $("pantryList").innerHTML = `
      <div class="pantry-empty">
        Your pantry is empty. Type what you have in the conversation, add it here, or take a photo.
      </div>`;
    return;
  }

  $("pantryList").innerHTML = state.pantry.map((item, index) => `
    <div class="pantry-item ${item.soon ? "soon" : ""}">
      <span class="pantry-icon" aria-hidden="true">${escapeHtml(item.name[0])}</span>
      <span class="pantry-info">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.amount)}${item.soon ? " · use soon" : ""}</span>
      </span>
      <span class="pantry-actions">
        <button data-pantry-action="soon" data-index="${index}">${item.soon ? "Unmark" : "Use soon"}</button>
        <button data-pantry-action="remove" data-index="${index}" aria-label="Remove ${escapeHtml(item.name)}">Remove</button>
      </span>
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
  $("welcomeZip").value = state.profile?.postalCode || "";

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
    postalCode: $("welcomeZip").value.trim(),
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

  if (current === "identity") {
    const zip = $("welcomeZip").value.trim();
    if (zip && !/^\d{5}$/.test(zip)) {
      toast("Enter a five-digit ZIP code, or leave it blank.", "error");
      $("welcomeZip").focus();
      return;
    }
  }

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
  $("profilePostalCode").value = state.profile?.postalCode || "";

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

function openPantry() {
  closeProfile();
  $("pantryDrawer").classList.add("open");
  $("pantryDrawer").setAttribute("aria-hidden", "false");
  document.body.dataset.drawerOpen = "true";
  requestAnimationFrame(() => $("pantryInput").focus());
}

function closePantry() {
  $("pantryDrawer").classList.remove("open");
  $("pantryDrawer").setAttribute("aria-hidden", "true");
  delete document.body.dataset.drawerOpen;
}

// One view model for both breakpoints. Chat and plan stay paired side by side
// on desktop (body[data-view] only splits the grocery tab out); on mobile the
// .mobile-active class picks the single visible panel.
function setMobileView(view) {
  if (view === "pantry") {
    openPantry();
    return;
  }
  activeMobileView = view;
  document.body.dataset.view = view;
  $("chatView").classList.toggle("mobile-active", view === "chat");
  $("planView").classList.toggle("mobile-active", view === "plan");
  document.querySelectorAll(".mobile-nav button, .desktop-nav .nav-item").forEach((button) => {
    if (button.dataset.view) button.classList.toggle("active", button.dataset.view === view);
  });
  if (view === "grocery") loadCatalog();
}

function loadSamplePantry() {
  if (state.pantry.length && !window.confirm("Replace your current pantry with the sample mini-fridge?")) return;
  state.pantry = [
    { name: "eggs", amount: "4 left", soon: true },
    { name: "spinach", amount: "half a bag", soon: true },
    { name: "rice", amount: "2 cups cooked", soon: false },
    { name: "tortillas", amount: "4 left", soon: false },
    { name: "cheddar", amount: "some", soon: false },
    { name: "salsa", amount: "half a jar", soon: false }
  ];
  state.constraints = { ...DEFAULT_STATE.constraints, budget: 18, dinners: 3, maxTimeMin: 20, equipment: ["microwave"] };
  state.excludedTitles = [];
  saveState();
  renderPantry();
  addUserMessage("I have 4 eggs, half a bag of spinach, 2 cups of cooked rice, 4 tortillas, some cheddar and salsa. The spinach and eggs need using. I have $18 and only a microwave.");
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
    confirmed.forEach((item) => addPantryItem(item.name, "amount unknown", false));
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

  const postalCode = $("profilePostalCode").value.trim();
  if (postalCode && !/^\d{5}$/.test(postalCode)) {
    toast("Enter a five-digit ZIP code.", "error");
    $("profilePostalCode").focus();
    return;
  }

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
    postalCode,
  };

  state.constraints.equipment = equipment;
  state.constraints.diet = readCheckedValues("profile-diet").join(", ");
  state.constraints.budget = clampNumber($("profileBudget").value, PREFERENCES.limits.budget, 20);

  saveState();
  renderProfile();
  // Keeps the Shop tab's "Shop near <ZIP>" button in step with the saved ZIP.
  renderLocation();
  closeProfile();

  toast("Profile saved. New plans will use these preferences.");
});

/* ---------------- groceries: build a list, price it at every nearby store ---------------- */

let catalogNames = [];
let catalogLoaded = false;
let comparing = false;
// Where the server measures from without a fix, and the ZIP its catalog covers.
// Both are fetched, never assumed, so the copy stays correct if
// data/stores.json moves to another city.
let originLabel = "the default area";
let originZip = "";

// Autocomplete source. Optional: a failure here must not block adding items,
// because the server resolves names anyway.
async function loadCatalog() {
  if (catalogLoaded) return;
  catalogLoaded = true;
  try {
    const [pricesResponse, storesResponse] = await Promise.all([
      fetch("/api/prices"),
      fetch("/api/stores")
    ]);
    const result = await pricesResponse.json();
    if (result.ok && Array.isArray(result.items)) {
      catalogNames = [...result.items.map((item) => item.name), ...Object.keys(result.aliases || {})].sort();
      $("catalogOptions").innerHTML = catalogNames
        .map((name) => `<option value="${escapeHtml(name)}"></option>`)
        .join("");
    }
    const stores = await storesResponse.json();
    if (stores.ok) {
      if (stores.origin?.label) originLabel = stores.origin.label;
      if (stores.zip) originZip = String(stores.zip);
      renderLocation();
    }
  } catch {
    catalogLoaded = false; // let the next visit retry
  }
}

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

function renderGroceryList() {
  const count = state.groceryList.length;
  $("groceryNavCount").textContent = count;
  $("mobileGroceryCount").textContent = count;
  $("compareButton").disabled = count === 0;

  const planItems = state.plan?.shoppingList?.length || 0;
  $("fromPlanButton").disabled = planItems === 0;
  $("fromPlanButton").textContent = planItems
    ? `Add ${planItems} meal-plan item${planItems === 1 ? "" : "s"}`
    : "No meal plan yet";

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
        ${item.unknown ? "<span>Not in the Tempe mock catalog — not priced</span>" : ""}
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
    ? (state.location.label || `${state.location.lat.toFixed(4)}, ${state.location.lng.toFixed(4)}`)
    : `No location shared yet — distances from ${originLabel}`;

  // The profile's saved ZIP is the way in for anyone who will not share a fix.
  const zip = String(state.profile?.postalCode || "").trim();
  const zipButton = $("useProfileZipButton");
  zipButton.hidden = !/^\d{5}$/.test(zip);
  if (!zipButton.hidden) zipButton.textContent = `Shop near ${zip}`;

  const detail = $("locationDetail");
  const parts = [];
  if (located) {
    if (state.location.detail && state.location.detail !== state.location.label) parts.push(state.location.detail);
    if (Number.isFinite(state.location.accuracyM)) parts.push(`accurate to about ${Math.round(state.location.accuracyM)} m`);
  }
  detail.textContent = parts.join(" · ");
  detail.hidden = parts.length === 0;
}

// Asks the server to put the fix in words. The local description is always
// computed here; the third-party name lookup only runs with explicit consent.
async function describeCurrentLocation(allowLookup) {
  if (!state.location) return;
  try {
    const response = await fetch("/api/geo/describe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: state.location.lat, lng: state.location.lng, allowLookup })
    });
    const result = await response.json();
    if (!result.ok) return;
    if (result.placeName) {
      state.location.label = result.placeName;
      state.location.detail = result.local?.text || "";
    } else {
      state.location.label = result.local?.text || "Your current location";
      state.location.detail = "";
      if (allowLookup && result.failure) {
        toast("Could not reach the place-name service — showing the local estimate instead.", "error");
      }
    }
    saveState();
    renderLocation();
  } catch {
    // The label is cosmetic: a failure here must not disturb the comparison.
  }
}

function showLookupConsent() {
  // Only ask when there is no standing answer.
  $("lookupConsent").hidden = state.allowPlaceLookup !== null;
}

// Set when a ZIP outside the catalog is waiting on the consent answer, so
// saying yes resumes the action the user actually asked for.
let pendingZipLookup = null;

function answerLookupConsent(allow) {
  state.allowPlaceLookup = allow;
  saveState();
  $("lookupConsent").hidden = true;

  const zip = pendingZipLookup;
  pendingZipLookup = null;
  if (zip) {
    if (allow) resolveProfileZip();
    else toast(`Kept local. FridgeFuse can only place ZIP ${originZip || "the catalog area"} without a lookup.`);
    return;
  }

  describeCurrentLocation(allow);
  toast(allow
    ? "Place-name lookup enabled. Reset the demo to change this."
    : "Kept local. Your coordinates stay on this machine.");
}

// Turns the profile's saved ZIP into the point we measure from. The catalog's
// own ZIP resolves with no network call at all.
async function resolveProfileZip() {
  const zip = String(state.profile?.postalCode || "").trim();
  if (!/^\d{5}$/.test(zip)) return;
  const button = $("useProfileZipButton");
  button.disabled = true;
  button.textContent = "Locating…";
  try {
    const response = await fetch("/api/geo/postal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postalCode: zip, allowLookup: state.allowPlaceLookup === true })
    });
    const result = await response.json();

    if (result.needsConsent) {
      if (state.allowPlaceLookup === false) {
        pendingZipLookup = null;
        toast(`Kept local. ZIP ${zip} needs a place lookup; use ZIP ${originZip || "the catalog area"} or reset the demo to enable it.`, "error");
        return;
      }
      pendingZipLookup = zip;
      $("lookupConsent").hidden = false;
      toast(result.note || `ZIP ${zip} needs a lookup outside this app.`);
      return;
    }
    if (!result.ok || !result.resolved) {
      throw new Error(result.failure?.message || `Could not place ZIP ${zip}`);
    }

    state.location = {
      lat: result.lat,
      lng: result.lng,
      label: result.label || `ZIP ${zip}`,
      detail: `From ZIP ${zip}`,
      fromPostalCode: zip
    };
    saveState();
    renderLocation();
    toast(`Shopping from ZIP ${zip}. Distances are measured from there.`);
    if (state.groceryList.length) compareStores();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    renderLocation();
  }
}

function requestLocation() {
  const hadPreviousLocation = Boolean(state.location);
  const reportLocationFailure = (message) => {
    const suffix = hadPreviousLocation
      ? " Keeping your previous location."
      : ` Distances will use ${originLabel} instead.`;
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
      state.location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracyM: Number(position.coords.accuracy),
        label: "Working out where that is…",
        detail: ""
      };
      saveState();
      renderLocation();
      button.disabled = false;
      toast("Location set. Distances are measured from here.");
      // Local description first — it needs no network and cannot fail.
      describeCurrentLocation(state.allowPlaceLookup === true);
      showLookupConsent();
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

async function compareStores() {
  if (comparing || !state.groceryList.length) return;
  comparing = true;
  const button = $("compareButton");
  button.disabled = true;
  button.textContent = "Comparing…";
  $("groceryResults").innerHTML = `<p class="results-note">Pricing your list at every nearby store…</p>`;

  try {
    const response = await fetch("/api/grocery/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: state.groceryList.map((item) => ({ name: item.name, qty: item.qty })),
        lat: state.location?.lat,
        lng: state.location?.lng
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.failure?.message || `Comparison returned HTTP ${response.status}`);
    }
    // Flag list entries the catalog could not price so the user can fix them.
    const unmatched = new Set((result.unmatched || []).map((name) => String(name).toLowerCase()));
    for (const item of state.groceryList) item.unknown = unmatched.has(item.name);
    saveState();
    renderGroceryList();
    renderGroceryResults(result);
  } catch (error) {
    $("groceryResults").innerHTML = `<p class="results-note warn">${escapeHtml(error.message)}</p>`;
    toast(error.message, "error");
  } finally {
    comparing = false;
    button.disabled = state.groceryList.length === 0;
    button.textContent = "Compare nearby stores";
  }
}

function renderGroceryResults(result) {
  const options = result.options || [];
  const notes = [];
  if (result.note) notes.push({ text: result.note, warn: !options.length });

  if (!options.length) {
    $("groceryResults").innerHTML = notes
      .map((note) => `<p class="results-note${note.warn ? " warn" : ""}">${escapeHtml(note.text)}</p>`)
      .join("");
    return;
  }

  const best = options[0];
  const savings = Number(result.savingsVsWorst) || 0;
  const completeOptions = options.filter((option) => option.complete);
  const priciest = completeOptions[completeOptions.length - 1] || options[options.length - 1];
  const summary = savings > 0
    ? `${titleCase(best.name)} on ${best.area.replace(/^.*—\s*/, "")} fills the whole list for ${formatMoney(best.subtotal)} — ${formatMoney(savings)} less than the priciest nearby option, ${priciest.distanceMi} miles away.`
    : best.complete
      ? `${titleCase(best.name)} fills the list for ${formatMoney(best.subtotal)}, ${best.distanceMi} miles away.`
      : `${titleCase(best.name)} covers ${best.itemCount} of ${(result.requested || []).length} items for ${formatMoney(best.subtotal)}, ${best.distanceMi} miles away.`;

  const cards = options.map((option, index) => {
    const rows = (option.lineItems || []).map((line) => `
      <tr>
        <td>
          ${escapeHtml(line.item)}${line.qty > 1 ? ` ×${line.qty}` : ""}
          <div class="pack-note">${escapeHtml(line.pack || "1 package")}</div>
        </td>
        <td>${formatMoney(line.lineTotal)}</td>
      </tr>`).join("");
    return `
      <article class="store-card${option.best ? " best" : ""}">
        <div>
          <span class="store-rank">${option.best ? "CHEAPEST" : `#${index + 1}`}</span>
          <h3 class="store-name">${escapeHtml(option.name)}</h3>
          <p class="store-meta">${escapeHtml(option.area)} · ${option.distanceMi} mi away · ${option.itemCount} of ${(result.requested || []).length} items</p>
          ${option.missing?.length ? `<p class="store-missing">Does not stock: ${escapeHtml(option.missing.join(", "))}</p>` : ""}
        </div>
        <div class="store-total">
          <strong>${formatMoney(option.subtotal)}</strong>
          <small>${option.complete ? "WHOLE LIST" : "PARTIAL"}</small>
        </div>
        <details class="store-breakdown">
          <summary>Price breakdown</summary>
          <table>
            <thead><tr><th>Item</th><th>Cost</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </details>
      </article>`;
  }).join("");

  $("groceryResults").innerHTML = `
    <div class="results-heading">
      <div>
        <p class="eyebrow">Ranked cheapest first</p>
        <h3>${options.length} nearby option${options.length === 1 ? "" : "s"}</h3>
      </div>
    </div>
    <p class="results-note">${escapeHtml(summary)}</p>
    ${notes.map((note) => `<p class="results-note${note.warn ? " warn" : ""}">${escapeHtml(note.text)}</p>`).join("")}
    <div class="store-list">${cards}</div>`;
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
});

$("fromPlanButton").addEventListener("click", () => {
  const planItems = state.plan?.shoppingList || [];
  if (!planItems.length) return;
  let added = 0;
  for (const entry of planItems) if (addGroceryItem(entry.item, Number(entry.qty) || 1)) added++;
  saveState();
  renderGroceryList();
  toast(added ? `${added} item${added === 1 ? "" : "s"} added from your meal plan` : "Those items are already on the list");
});

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
$("useProfileZipButton").addEventListener("click", resolveProfileZip);
$("compareButton").addEventListener("click", compareStores);
$("allowLookupButton").addEventListener("click", () => answerLookupConsent(true));
$("declineLookupButton").addEventListener("click", () => answerLookupConsent(false));

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
$("markUseSoonButton").addEventListener("click", openPantry);
document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", closePantry));

$("pantryForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("pantryInput").value.trim();
  if (!value) return;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  items.forEach((item) => addPantryItem(item, "some", false));
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
    addPantryItem(name, "confirmed from photo", false);
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

  if (button.dataset.action === "swap") {
    addExclusion(meal.title);
    saveState();
    setMobileView("chat");
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
    setMobileView(view);
    // Desktop keeps chat and plan side by side, so those clicks only move focus.
    if (window.matchMedia("(max-width: 980px)").matches) return;
    if (view === "chat") $("chatInput").focus();
    if (view === "plan") $("planView").querySelector(".plan-scroll").scrollTo({ top: 0, behavior: "smooth" });
  });
});

$("resetDemoButton").addEventListener("click", () => {
  if (!window.confirm("Clear the saved pantry and current plan?")) return;
  state = structuredClone(DEFAULT_STATE);
  saveState();
  window.location.reload();
});

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
    else addAssistantMessage(entry.text, entry.supportingText || "", { record: false });
  }
} else if (state.plan) {
  $("starterPrompts").hidden = true;
  const firstMessage = document.querySelector(".assistant-message .message-copy");
  firstMessage.innerHTML = "<p>Your last plan and pantry are still here. Tell me what changed.</p><p class=\"message-example\">Try \"lower my budget to $15\" or swap a meal from the plan.</p>";
}

renderProfile();
renderPantry();
renderPlan();
renderGroceryList();
renderLocation();
setMobileView(activeMobileView);

// The welcome wizard is a one-time landing experience: it runs once, ever,
// on the very first visit. After that, preferences are only ever changed by
// deliberately opening the profile drawer — never re-asked on login.
if (needsOnboarding()) openWelcome();
