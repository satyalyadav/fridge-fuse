const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "fridgefuse-state-v2";

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
  messages: []
};

const MAX_EXCLUDED = 20;
const MAX_MESSAGES = 30;

function addExclusion(title) {
  if (!title) return;
  state.excludedTitles = [...new Set([...state.excludedTitles, title])].slice(-MAX_EXCLUDED);
}

let state = loadState();
let activeMobileView = state.plan ? "plan" : "chat";

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored) return structuredClone(DEFAULT_STATE);
    return {
      ...structuredClone(DEFAULT_STATE),
      ...stored,
      constraints: { ...DEFAULT_STATE.constraints, ...(stored.constraints || {}) },
      pantry: Array.isArray(stored.pantry) ? stored.pantry : [],
      excludedTitles: Array.isArray(stored.excludedTitles) ? stored.excludedTitles.slice(-MAX_EXCLUDED) : [],
      messages: Array.isArray(stored.messages) ? stored.messages.slice(-MAX_MESSAGES) : []
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function recordMessage(entry) {
  state.messages = [...(state.messages || []), entry].slice(-MAX_MESSAGES);
  saveState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  article.innerHTML = `<div class="message-copy"><p>${escapeHtml(text)}</p></div>`;
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
        exclude: state.excludedTitles,
        catalogOnly: true
      })
    });
    if (!response.ok) throw new Error(`Planning returned HTTP ${response.status}`);
    const result = await response.json();
    if (!result.ok && !result.dinners) throw new Error(result.failure?.message || "The planner did not return a plan");

    state.plan = result;
    saveState();
    renderPlan();
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

  $("emptyPlan").hidden = true;
  $("planContent").hidden = false;
  $("budgetStamp").hidden = false;
  $("planTitle").textContent = `${plan.dinners.length} dinners, one small grocery run`;
  $("planSubtitle").textContent = `Built for ${state.constraints.equipment.join(" + ") || "the equipment you have"}, ${state.constraints.maxTimeMin} minutes or less each.`;
  $("budgetTotal").textContent = formatMoney(plan.totalCost);
  $("budgetLimit").textContent = `of ${formatMoney(state.constraints.budget)}`;
  $("budgetStamp").classList.toggle("over", plan.totalCost > state.constraints.budget);
  $("tripStatus").classList.add("ready");
  $("tripLabel").textContent = `${plan.shoppingList?.length || 0} packages · ${formatMoney(plan.totalCost)} estimated`;

  const soon = state.pantry.filter((item) => item.soon).map((item) => item.name);
  const shared = (plan.shoppingList || []).filter((item) => (item.sharedBy || []).length > 1);
  const logicParts = [];
  if (soon.length) logicParts.push(`${capitalize(soon.join(" and "))} get used first`);
  if (shared.length) logicParts.push(`${shared.length} purchase${shared.length === 1 ? " works" : "s work"} across multiple dinners`);
  logicParts.push(plan.totalCost <= state.constraints.budget ? `${formatMoney(state.constraints.budget - plan.totalCost)} stays in your budget` : `${formatMoney(plan.totalCost - state.constraints.budget)} over budget`);
  $("planLogic").textContent = logicParts.join(". ") + ".";

  const dayLabels = ["TONIGHT", "NEXT", "THEN", "LATER", "LAST"];
  $("mealList").innerHTML = plan.dinners.map((meal, index) => {
    const pantryUsed = meal.usesPantry || [];
    const useSoon = pantryUsed.filter((name) => soon.includes(name));
    const reason = useSoon.length
      ? `Uses ${useSoon.join(" and ")} while it is still fresh`
      : pantryUsed.length
        ? `Uses ${pantryUsed.join(", ")} from your pantry`
        : "Built from the same grocery run";
    const steps = (meal.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("");
    return `
      <article class="meal-card" data-meal-index="${index}">
        <div class="meal-day">${dayLabels[index] || `DAY ${index + 1}`}</div>
        <div class="meal-main">
          <h3>${escapeHtml(meal.title)}</h3>
          <p class="meal-meta">${Number(meal.timeMin) || "—"} min · beginner · ${escapeHtml((meal.equip || []).join(" + ") || state.constraints.equipment[0] || "simple equipment")}</p>
          <p class="meal-reason">${escapeHtml(reason)}</p>
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

function openPantry() {
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

function setMobileView(view) {
  if (view === "pantry") {
    openPantry();
    return;
  }
  activeMobileView = view;
  $("chatView").classList.toggle("mobile-active", view === "chat");
  $("planView").classList.toggle("mobile-active", view === "plan");
  document.querySelectorAll(".mobile-nav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
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

async function handlePhoto(file) {
  if (!file) return;
  addUserMessage(`I added a photo: ${file.name}`);
  showThinking();

  try {
    const imageDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const response = await fetch("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl })
    });
    const result = await response.json();
    hideThinking();
    if (!result.ok) throw new Error(result.failure?.message || "The photo could not be read");

    const confident = (result.items || []).filter((item) => Number(item.confidence) >= 0.65);
    confident.forEach((item) => addPantryItem(item.name, "amount unknown", false));
    saveState();
    renderPantry();
    addAssistantMessage(
      confident.length ? `I found ${confident.map((item) => item.name).join(", ")}.` : "I could not identify anything clearly enough to add.",
      confident.length ? "I added the clear matches. Check the pantry to correct anything before I plan." : "Try a closer photo with labels facing the camera."
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
    if (window.matchMedia("(max-width: 980px)").matches) setMobileView(view);
    else if (view === "pantry") openPantry();
    else {
      document.querySelectorAll(".desktop-nav .nav-item").forEach((item) => item.classList.toggle("active", item === button));
      if (view === "chat") $("chatInput").focus();
      if (view === "plan") $("planView").querySelector(".plan-scroll").scrollTo({ top: 0, behavior: "smooth" });
    }
  });
});

$("resetDemoButton").addEventListener("click", () => {
  if (!window.confirm("Clear the saved pantry and current plan?")) return;
  state = structuredClone(DEFAULT_STATE);
  saveState();
  window.location.reload();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePantry();
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
renderPantry();
renderPlan();
setMobileView(activeMobileView);
