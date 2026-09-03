// FridgeFuse v0 — hackathon prototype backend.
// Mobile web frontend (public/) + backend proxy that holds VOYAGER_KEY,
// calls ASU AIR Voyager (OpenAI-compatible) and serves Tempe 85281 mock prices.
// Every external call failure is logged AND surfaced to the client.

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const AIR_BASE = (process.env.ASU_AIR_BASE_URL || "https://openai.rc.asu.edu/v1").replace(/\/$/, "");
const AIR_KEY = process.env.VOYAGER_KEY || "";
const AIR_MODEL = process.env.ASU_AIR_MODEL || "glm-5-3-flash";
const AIR_VISION_MODEL = process.env.ASU_AIR_VISION_MODEL || "qwen3-vl-32b-instruct";

const app = express();
app.use(express.json({ limit: "12mb" }));

// ---------- failure reporting (user requirement: report API failures) ----------
const failures = [];
function reportFailure(provider, operation, details) {
  const entry = {
    time: new Date().toISOString(),
    provider,
    operation,
    ...details,
  };
  failures.push(entry);
  if (failures.length > 100) failures.shift();
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

// ---------- mock price DB (Tempe 85281, dev-harvested mock) ----------
const PRICES = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "prices.json"), "utf8"));
const STORES = Object.keys(PRICES.stores);

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
  const have = new Set(pantry.map((item) => String(item).toLowerCase()));
  const urgent = new Set(useSoon.map((item) => String(item).toLowerCase()));
  const excluded = new Set(exclude.map((title) => String(title).toLowerCase()));
  const dietQ = diet.toLowerCase();
  const blockedForVegetarian = new Set(["chicken breast", "ground beef"]);
  const blockedForVegan = new Set([...blockedForVegetarian, "eggs", "milk", "cheddar", "butter", "yogurt"]);

  const candidates = RECIPES
    .filter((recipe) => recipe.timeMin <= maxTimeMin)
    .filter((recipe) => recipe.equip.every((item) => equipment.includes(item)))
    .filter((recipe) => !excluded.has(recipe.title.toLowerCase()))
    .filter((recipe) => {
      if (dietQ.includes("vegan") && recipe.needs.some((item) => blockedForVegan.has(item))) return false;
      if (dietQ.includes("vegetarian") && recipe.needs.some((item) => blockedForVegetarian.has(item))) return false;
      if (dietQ.includes("peanut") && recipe.needs.includes("peanut butter")) return false;
      return true;
    })
    .map((recipe) => ({
      recipe,
      missing: recipe.needs.filter((item) => !pantryHas(have, item)),
      urgentUsed: recipe.needs.filter((item) => urgent.has(item))
    }));

  const planSize = Math.min(Math.max(1, dinners), candidates.length);
  const possiblePlans = combinations(candidates, planSize);
  const evaluated = possiblePlans.map((group) => {
    const missingReferences = group.flatMap((item) => item.missing);
    const uniqueMissing = [...new Set(missingReferences)];
    const cost = uniqueMissing.reduce((total, item) => total + (cheapestPack(item)?.packPrice || 3.99), 0);
    const urgentCovered = new Set(group.flatMap((item) => item.urgentUsed)).size;
    const sharedUses = missingReferences.length - uniqueMissing.length;
    const pantryUses = group.reduce((total, item) => total + item.recipe.needs.length - item.missing.length, 0);
    const overBudget = Math.max(0, cost - budget);
    const score = overBudget * 1000 + uniqueMissing.length * 18 + cost - urgentCovered * 60 - sharedUses * 12 - pantryUses * 4;
    return { group, cost, score };
  }).sort((a, b) => a.score - b.score);

  const picked = (evaluated[0]?.group || candidates.slice(0, planSize))
    .sort((a, b) => b.urgentUsed.length - a.urgentUsed.length);

  const listMap = {};
  for (const selection of picked) {
    for (const missing of selection.missing) {
      if (!listMap[missing]) {
        const pack = cheapestPack(missing) || { item: missing, store: "walmart", pack: "1 package", packPrice: 3.99 };
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
      usesPantry: selection.recipe.needs.filter((item) => !selection.missing.includes(item)),
      needs: selection.missing,
      steps: selection.recipe.steps
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
        const pack = cheapestPack(name) || { item: name, store: "walmart", pack: "1 package", packPrice: 3.99 };
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

// ---------- routes ----------
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    airConfigured: !!AIR_KEY,
    airBase: AIR_BASE,
    airModel: AIR_MODEL,
    airVisionModel: AIR_VISION_MODEL,
    stores: STORES,
    priceItems: PRICES.items.length,
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

app.post("/api/vision", async (req, res) => {
  const { imageDataUrl } = req.body || {};
  if (!imageDataUrl) return res.status(400).json({ ok: false, failure: { message: "imageDataUrl required" } });
  const out = await airChat([
    { role: "system", content: 'You identify grocery ingredients visible in a fridge/pantry photo. Reply ONLY with JSON: {"items":[{"name":"...","confidence":0.0-1.0}]}. Use common grocery names (e.g. "eggs", "milk", "chicken breast", "rice"). Max 25 items.' },
    { role: "user", content: [
      { type: "text", text: "List the ingredients you can see. When unsure, include with low confidence." },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ]},
  ], { maxTokens: 800, model: AIR_VISION_MODEL });
  if (!out.ok) {
    if (out.mock) {
      return res.json({ ok: true, mock: true, items: [
        { name: "eggs", confidence: 0.9 }, { name: "milk", confidence: 0.85 },
        { name: "rice", confidence: 0.7 }, { name: "onion", confidence: 0.6 },
      ], note: "MOCK — set VOYAGER_KEY for live vision." });
    }
    return res.json({ ok: false, failure: out.failure });
  }
  try {
    const content = out.data.choices[0].message.content;
    res.json({ ok: true, ...extractJson(content), model: AIR_VISION_MODEL });
  } catch (e) {
    res.json({ ok: false, failure: reportFailure("asu-air", "vision-parse", {
      status: "parse-error", message: `Could not parse vision JSON: ${e.message}`,
    })});
  }
});

app.post("/api/plan", async (req, res) => {
  const { pantry = [], budget = 30, dinners = 3, maxTimeMin = 30,
          equipment = ["stove"], diet = "", useSoon = [], request = "", exclude = [],
          catalogOnly = false } = req.body || {};
  if (catalogOnly) {
    return res.json({
      ok: true,
      mock: true,
      model: "grounded-catalog",
      ...localPlan({ pantry, dinners, maxTimeMin, equipment, diet, budget, useSoon, exclude })
    });
  }
  const priceCtx = PRICES.items.map((i) => {
    const c = cheapestPack(i.name);
    return `${i.name} (~${c.pack} @ ${c.store} $${c.packPrice})`;
  }).join("; ");
  const out = await airChat([
    { role: "system", content: `You are FridgeFuse, a student meal planner for Tempe AZ 85281. Reply ONLY with JSON:
{"dinners":[{"title":"...","timeMin":20,"protein":25,"carbs":50,"fiber":6,"usesPantry":["..."],"needs":["..."],"steps":["..."]}],
"shoppingList":[{"item":"...","pack":"...","packPrice":0.0,"store":"...","qty":1,"sharedBy":["..."]}],
"totalCost":0.0,"notes":"..."}
Rules: plan EXACTLY the requested number of dinners. The user is a freshman cook, so give concrete beginner-safe steps and only use the listed equipment. First use food marked use-soon, then minimize unique purchases, stay within budget, and keep cooking easy. Prefer purchases shared across dinners. Put only missing ingredients in needs; pantry items cost $0. The server will ground final prices against its catalog. Respect time, equipment, and dietary restrictions. Price context: ${priceCtx}.` },
    { role: "user", content: `Pantry: ${pantry.join(", ") || "(empty)"}. Use soon: ${useSoon.join(", ") || "none"}. Budget total $${budget} for the whole plan. Dinners: ${dinners}. Max ${maxTimeMin} min each. Equipment: ${equipment.join(", ")}. Diet/notes: ${diet || "none"}. Avoid these meals: ${exclude.join(", ") || "none"}. Latest request: ${request || "build the best plan"}.` },
  ], { maxTokens: 1800 });
  if (!out.ok) {
    if (out.mock) {
      return res.json({ ok: true, mock: true, ...localPlan({ pantry, dinners, maxTimeMin, equipment, diet, budget, useSoon, exclude }),
        note: "MOCK planner — set VOYAGER_KEY for live AI planning." });
    }
    // Live AI failed: still return local plan AND the failure (demo never dies, failure visible).
    return res.json({ ok: true, fallback: true, failure: out.failure,
      ...localPlan({ pantry, dinners, maxTimeMin, equipment, diet, budget, useSoon, exclude }) });
  }
  try {
    const content = out.data.choices[0].message.content;
    const plan = groundShoppingPlan(extractJson(content));
    res.json({ ok: true, model: AIR_MODEL, ...plan });
  } catch (e) {
    res.json({ ok: true, fallback: true,
      failure: reportFailure("asu-air", "plan-parse", { status: "parse-error", message: e.message }),
      ...localPlan({ pantry, dinners, maxTimeMin, equipment, diet, budget, useSoon, exclude }) });
  }
});

app.get("/api/prices", (req, res) => {
  const q = (req.query.item || "").toLowerCase();
  if (!q) return res.json({ ok: true, stores: PRICES.stores, items: PRICES.items, zip: PRICES.zip, note: PRICES.note });
  const hit = findPrice(q);
  if (!hit) return res.json({ ok: false, failure: { message: `No mock price for "${q}". Try /api/prices for full list.` } });
  res.json({ ok: true, ...hit, zip: PRICES.zip });
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

// Exported for in-process tests (require without side effects).
module.exports = {
  app, localPlan, cheapestPack, findPrice, extractJson, PRICES, STORES,
  reportFailure, AIR_MODEL, AIR_VISION_MODEL
};

if (require.main === module) {
  // 0.0.0.0 so a phone on the same WiFi can reach the demo.
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`FridgeFuse v0 on http://localhost:${PORT}`);
    console.log(`AIR: ${AIR_BASE} text=${AIR_MODEL} vision=${AIR_VISION_MODEL} key=${AIR_KEY ? "set" : "MISSING (mock mode)"}`);
  });
}
