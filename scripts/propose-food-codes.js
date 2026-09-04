// Propose standard food codes for the price catalog. Run by hand, never at
// runtime: node scripts/propose-food-codes.js
//
// Why this only PROPOSES. Automated name lookup is not safe to apply blind. Run
// against this catalog, an unreviewed "take the best hit" rule produced:
//
//   eggs        -> FOODON:00004269  "rohu egg"      (a fish egg)
//   yogurt      -> FOODON:00003193  "soy yogurt"    (flips the dairy answer)
//   black beans -> FOODON:03309936  "black gram bean"
//   potatoes    -> FOODON:03414704  "potato bush"
//   tamari      -> FOODON:00003730  "tamarillo"     (a fruit)
//   soy sauce   -> FOODON:00002395  "moromi"        (a fermentation mash)
//   milk        -> UBERON:0001913                   (anatomy, not food)
//
// A wrong code on a diet-safety path is worse than no code, so data/prices.json
// carries an id only where the ontology label matches the item exactly, and the
// contains-tags that drive enforcement stay hand-curated. Neither FoodData
// Central nor Open Food Facts can replace them: FDC has no structured allergen
// field (only a free-text ingredient string), and OFF's tags are patchy — its
// record for a product named "Gluten Free Spaghetti" (GTIN 0012700122081) has an
// empty allergens_tags and no gluten-free label.
//
// Set FDC_API_KEY (https://fdc.nal.usda.gov/api-key-signup) to also see USDA
// FoodData Central ids and GTINs. Without it, FoodOn alone is queried.

const fs = require("fs");
const path = require("path");

const CATALOG = path.join(__dirname, "..", "data", "prices.json");
const OLS4 = "https://www.ebi.ac.uk/ols4/api/search";
const FDC = "https://api.nal.usda.gov/fdc/v1/foods/search";
const FDC_KEY = process.env.FDC_API_KEY || "";
const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function foodOnCandidates(name) {
  const url = `${OLS4}?q=${encodeURIComponent(name)}&ontology=foodon&rows=12`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`OLS4 HTTP ${response.status}`);
  const body = await response.json();
  // OLS4 answers a foodon query with imported terms too: "milk" comes back as
  // UBERON:0001913, an anatomy concept. Only FoodOn ids belong in the catalog.
  return (body.response?.docs || [])
    .filter((doc) => doc.obo_id && doc.label && doc.obo_id.startsWith("FOODON:") && !/\d/.test(doc.label))
    .map((doc) => ({ id: doc.obo_id, label: doc.label }));
}

async function fdcCandidate(name) {
  if (!FDC_KEY) return null;
  const url = `${FDC}?query=${encodeURIComponent(name)}&pageSize=1&api_key=${FDC_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`FDC HTTP ${response.status}`);
  const food = (await response.json()).foods?.[0];
  return food ? { fdcId: food.fdcId, description: food.description, gtin: food.gtinUpc || null } : null;
}

(async () => {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  let exact = 0;
  for (const item of catalog.items) {
    const current = item.codes?.foodon || null;
    let line = `${item.name.padEnd(20)} current=${String(current).padEnd(18)}`;
    try {
      const candidates = await foodOnCandidates(item.name);
      const match = candidates.find((c) => normalize(c.label) === normalize(item.name));
      if (match) exact++;
      line += match
        ? `EXACT ${match.id} (${match.label})`
        : `REVIEW ${candidates.slice(0, 3).map((c) => `${c.id} "${c.label}"`).join(" | ") || "no candidates"}`;
      const fdc = await fdcCandidate(item.name);
      if (fdc) line += `\n${" ".repeat(22)}FDC ${fdc.fdcId} "${fdc.description}"${fdc.gtin ? ` gtin=${fdc.gtin}` : ""}`;
    } catch (error) {
      line += `ERROR ${error.message}`;
    }
    console.log(line);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  console.log(`\n${exact}/${catalog.items.length} items have an exact FoodOn label match.`);
  console.log("REVIEW rows need a human decision — do not paste them in unread.");
})();
