# FridgeFuse prototype

Fuse what you have into a meal you can afford.

FridgeFuse is a chat-first meal planner for a freshman cooking in a dorm. It
turns a rough pantry, a grocery limit, and limited equipment into three simple
dinners, one full-package shopping list, and a view of what will remain.

Live deployment: Vercel will provide the project URL after the first deploy.

## Prerequisites

- Node.js 20+ (`package.json` pins the runtime family) and npm
- git

Check with `node --version` / `npm --version`.

## Setup

```bash
git clone https://github.com/satyalyadav/fridge-fuse.git
cd fridge-fuse
npm install
```

AI setup for photo recognition and meal planning:

```bash
cp .env.example .env
```

Then edit `.env` and set `VOYAGER_KEY` to your ASU AIR (Voyager) API key.
`ASU_AIR_BASE_URL`, `ASU_AIR_MODEL`, and `ASU_AIR_VISION_MODEL` already have
working defaults. Text planning uses `llama4-scout-17b`, while photo recognition
uses `qwen3-vl-32b-instruct`. A second, independent photo check uses the faster
multimodal `llama4-scout-17b` by default; it can be overridden with
`ASU_AIR_VISION_VERIFY_MODEL`.

`VOYAGER_KEY` is required for meal planning and photo recognition. If it is
missing, or Voyager is unavailable, those endpoints return an error instead of
inventing a local plan or demo grocery results.

`.env` is gitignored — never commit the real key.

## Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).
To use another port: `PORT=4000 npm start`.

Verify it works:

```bash
npm test
curl http://localhost:3000/api/health
```

`npm test` runs the in-process planner and contract checks (expects
`ALL ... CHECKS PASSED`). `/api/health` should return
`{"ok":true,...}` with `airConfigured: false` when the key is missing and
`true` when `VOYAGER_KEY` is set.

## Setting up a profile

The profile is the landing screen, because everything downstream depends on it:
a plan is only useful if it respects the equipment in the room and the food the
student cannot eat.

The welcome wizard runs **once, ever** — three steps the first time the app is
opened: who you are (name, optional ZIP), what you can cook with, and what you
cannot eat. It never reappears on later visits; after that, preferences are
changed only by deliberately opening the profile from the avatar button. Either
the wizard or a later edit can be dismissed in one click — nothing is mandatory.

Dinners and minutes-per-meal are deliberately **not** in the profile. Those
change on every request, and the chat already parses them from a normal
sentence ("3 easy dinners", "15 minutes") — a profile field for them would just
be a second, staler place for the same value to live.

As equipment and diet are chosen, the hero panel updates with a short line
describing the kind of cooking that combination supports (*"Microwave + air
fryer — quick bowls and crispy sides, no stove needed."*) and any advisory
notes a selection carries. It is deliberately not a recipe count: planning is
fully AI-driven now (see below), so there is no static list to count against
without making a real request, and a live number the app can't back up would
be worse than no number.

`DIET_OPTIONS` and `EQUIPMENT_OPTIONS` in `server.js` are the single source of
truth — `GET /api/preferences` serves them to both the welcome wizard and the
profile drawer, so an option can't appear in the form without also existing on
the server. There are 17 dietary options across three groups (diets including
halal, kosher and pescatarian; nine allergens; things to skip) and 11 pieces of
equipment. A restriction is enforced by turning it into a concrete "hard
exclusions" ingredient list appended to the AI planning prompt — not by hoping
the model infers "vegan" correctly from a word — and an option that blocks
nothing in the current catalog must carry a note saying so, which is enforced
by a test.

Dietary options filter a small mock catalog. The form says plainly that this is
not an allergy-safety guarantee.

## Demo flow

Behind the profile, the home screen is a conversation, not a constraint form. A
student can describe their food, budget, time, and equipment in one message or
add a fridge photo. FridgeFuse keeps a rough pantry in local browser storage and
renders the evolving plan beside the chat.

With `VOYAGER_KEY` configured, the planning flow sends the pantry, constraints,
and latest request to ASU AIR. Voyager creates the dinners and cooking steps.
The server replaces its shopping prices with packages from the local Tempe 85281
catalog before returning the plan.

The demo flow is:

1. Choose “Try a sample mini-fridge.”
2. See three microwave-safe dinners with use-soon food scheduled first.
3. Open beginner cooking steps.
4. Review the merged full-package list and estimated checkout total.
5. Swap a meal without resetting the pantry or budget.
6. Open the pantry to edit rough amounts or mark another item “use soon.”

Photo recognition is intentionally conservative. A grocery is added
automatically only when Voyager supplies a safe object crop, identifies the
whole unobstructed item at high confidence, and a second visual pass independently
confirms it. Partial, cropped, generic-container, and lower-confidence matches
appear as image crops for the user to rename, add, or dismiss. If the verification
pass fails, proposed automatic additions also go to review rather than being
silently accepted.

Before upload, the browser scales large photos to a maximum 1024-pixel edge. Live
comparison tests reduced latency at that size without weakening the conservative
classification behavior. Smaller 640- and 768-pixel versions lost enough object
detail to fail the safety target, so the app does not use them.

Planning and photo recognition require Voyager. If Voyager returns malformed
plan JSON, the server asks the model to repair it once. A failed request or
repair is reported to the interface; the server does not replace it with a local
response.

## Shop tab: cheapest-store comparison

The Shop tab answers the other half of the problem — not “what can I cook” but
“where do I buy it for the least money.” A student builds a shopping list, shares
their location, and gets every nearby store ranked by what the whole basket
actually costs, with distance and a per-item breakdown.

1. Open **Shop** and add items (`eggs, milk, cheese`), or pull the missing
   ingredients straight from the current meal plan.
2. Adjust quantities; the list is saved on the device like the pantry.
3. Choose “Use my location,” or skip it and let distances run from the catalog
   origin (ASU Tempe). FridgeFuse is built for ASU students, so every store in the
   catalog is in the Phoenix metro and there is no ZIP to ask for.
4. Compare — stores that stock the whole list rank first, then price, then
   distance. The cheapest is flagged and the saving is spelled out.

### Showing where the user is

Once a fix is granted, the Shop tab says where that is in words. The description
is computed on the server from `data/stores.json` alone — the nearest branch or
origin plus the measured distance, so it reads like `0.5 mi from Tempe —
University Dr`. Nothing about it is hardcoded: move the branches to another city
and the wording follows, and if `origin` is absent it is derived from the mean of
the loaded branches.

A real place name (`Tempe, Arizona`) needs a third party, so the app **asks
first**. The disclaimer names the service, says the coordinates are rounded to
~110 m, and makes clear the comparison works identically either way. Only a
literal `true` from the client unlocks it; the answer is remembered, and
declining keeps every coordinate on the machine. The lookup runs through
`POST /api/geo/describe` server-side — so Nominatim's User-Agent policy is
honoured, requests are throttled to their ~1/second limit, and the browser never
makes a cross-origin call. If the service is slow or down, the local description
stands and the failure is logged like any other external call.

## Swapping a dinner

"Swap" excludes the **recipe**, not the dinner's title: the plan prompt lets a title
describe the adapted result, so the same curated record could otherwise come back
under a new name and the swap would look like it did nothing. The server refuses a
plan that reuses an excluded recipe and asks the model again.

The curated catalog is small, and equipment, time, and budget narrow it further, so a
swap can genuinely have nowhere to go. When the second attempt still has no
alternative the plan is returned with `swapUnavailable`, and the chat says so rather
than silently handing back the same dinner. More microwave-only records in
`data/recipe-sources.json` is what widens this.

## Recipe sources

- AI meal generation is constrained to the exact recipe records in
  `data/recipe-sources.json` (v3). Each record has a canonical title, recipe-page
  URL, timing, equipment, ingredients, and a short verified method outline.
- Every returned dinner carries an exact `sourceRecipe`, `source`, and
  `sourceUrl` triple. Publisher homepages and mismatched titles are rejected.
- The model builds from the selected record's facts. When a small pantry,
  budget, equipment, time, or diet change is needed, it records that change in
  `adaptationNote`.
- Edit the JSON to change the catalog. The prompt and validation rules are
  rebuilt from it at startup, and malformed or empty recipe data prevents the
  server from starting. Recipe pages are curated ahead of time rather than
  fetched during each request.

## Recipes as typed requirements

A dinner requires *quantities of ingredients*; a store sells *packages*. The plan
keeps those separate, because conflating them is what made the old numbers guesses:

```json
"needs": [{ "item": "eggs", "amount": 3, "unit": "each" },
          { "item": "gluten free pasta", "amount": 8, "unit": "oz" }]
```

The model supplies the amounts; the server does the arithmetic. Demand is summed
across every dinner, packages are bought whole (`qty = ceil(total / packSize)`), the
total is the sum of what was actually bought, and the leftover is what the packages
exceed the demand by. Three dinners needing fourteen eggs buy two dozen and report
ten eggs left — the plan used to buy one package of everything and let the model
write "most of the carton" in the leftovers.

Units come in three families — count, mass, volume — converted only within a family.
`data/prices.json` gives each item its canonical pack `size`, and a requirement in
the wrong family is refused, not converted: turning a cup of rice into ounces needs a
per-ingredient density, and a guessed density is a wrong shopping list. The model is
told which family each item uses in the price context.

`shoppingList`, `leftovers`, and `totalCost` are no longer accepted from the model at
all. It is asked for dinners and requirements; everything with a number in it is
computed here.

Amounts themselves cannot be verified — that would mean checking them against the
cited recipe, and the app never fetches recipe pages. What can be checked is
magnitude. Each catalog item carries a `perServing` band, each dinner may state
`servings` (one student unless it says otherwise), and an amount outside its band is
sent back to the model once with the specific complaint. Items with no band of their
own fall back to a package-count guard: more than three packages of one ingredient
for a single serving is a misplaced decimal whatever the ingredient. The bands are
deliberately wide judgement calls — they catch "forty ounces of spinach", not
someone who likes a big portion.

A quantity the server cannot read — a bare `"soy sauce"`, a missing unit, a cup of
something sold by weight — falls back to one whole package and labels the line
"amount not given", with no leftover claimed for it. Guessing a quantity is
recoverable and visible; guessing a price is not, so an ingredient the catalog
cannot price is still a hard failure.

## Dietary restrictions

A student's restrictions are treated as a safety constraint, not a preference the
model is asked to keep in mind. `data/diet-rules.json` maps the phrasings a student
types (`peanut allergy`, `dairy free`, `plant-based`) to ingredients the plan may
never contain, and the server enforces it on both sides of the model call:

- The plan prompt lists every forbidden ingredient for the restrictions in play.
- Pantry items that break the diet are named as off-limits instead of being offered
  as food to cook — they stay in the student's pantry, they just do not get planned.
- Every generated plan is re-checked afterwards: titles, pantry uses, shopping needs,
  cooking steps, the shopping list, and leftovers. A cooking step that says "brush
  with butter" fails a dairy-free plan even when the shopping list is clean.
- A violating plan is sent back for one repair with the restrictions restated, and
  rejected if the repair still breaks them. It is never served with the violation
  quietly left in.

Matching is word-boundary and plural-tolerant, so `egg` catches `eggs` but not
`eggplant`. Each rule's `allows` list is removed from the text before its `forbids`
are matched, so `peanut butter` does not trip the dairy-free rule's `butter`, and
`corn tortillas` does not trip gluten-free's `tortillas`.

How an ingredient is judged depends on whether the catalog knows it. A catalog item
is judged by its own `tags` in `data/prices.json` (`pasta` carries `gluten`, `gluten
free pasta` carries nothing), which is exact — the word net would fail an alias like
`gf pasta` for containing "pasta". Anything the catalog has never heard of, and every
cooking step, falls back to word matching. The two are cross-checked against each
other by `npm test`, so a mis-tagged item fails the build.

Edit the JSON to change the rules — the prompt and the check are both rebuilt from it
at startup, and a bad or empty file makes the server refuse to start, by design. The
five rules shipped (vegetarian, vegan, dairy-free, gluten-free, no peanuts) match the
checkboxes in the profile drawer; the chat also understands "peanut allergy".

Gluten-free substitutes are stocked in the catalog (`gluten free bread`, `gluten free
pasta`, `corn tortillas`, `tamari`) so a celiac's plan can actually be priced. Vegan
and dairy-free do not have their substitutes yet — plant milks and a cheese
alternative would need adding before those restrictions are equally usable.

## Food codes

Catalog items carry a `codes.foodon` id — an [EBI FoodOn](https://foodon.org)
ontology term, the closest thing food has to SNOMED/LOINC. `npm run codes:propose`
queries FoodOn (and USDA FoodData Central, if `FDC_API_KEY` is set) and prints
candidates for review. It never writes the catalog, because unreviewed name lookup
gets it wrong in ways that matter here: the best hit for `eggs` is a fish egg, for
`yogurt` it is "soy yogurt", for `tamari` it is a tamarind plant, and `milk` resolves
to an anatomy term. Only the 11 items whose ontology label matches exactly carry an
id; the rest are `null` pending a human decision.

The allergen tags stay hand-curated for the same reason. No food API returns a
classification dependable enough for an allergy: FoodData Central has no structured
allergen field, only a free-text ingredient string, and Open Food Facts' tags are
patchy — its record for a product named "Gluten Free Spaghetti" has an empty
`allergens_tags` and no gluten-free label.

Prices are mock for the same practical reason: there is no open grocery-price API.
Kroger (Fry's parent) publishes a location-aware product API behind OAuth partner
credentials; Aldi, Trader Joe's, and Walmart offer nothing comparable publicly. The
catalog's shape leaves room for a per-chain adapter to fill later.

## API

- `GET /api/health` reports server, catalog, and diet-rule status.
- `POST /api/vision {imageDataUrl}` returns independently verified `confirmed`
  pantry items plus `uncertain` items with bounding boxes for user review.
- `POST /api/plan` builds and prices the dinner plan; dinners include
  `sourceRecipe`, `source`, `sourceUrl`, and (when adapted) `adaptationNote`.
  The response echoes the `dietRules` that were enforced; a plan that breaks them
  is rejected, not returned.
- `GET /api/preferences` serves the dietary and equipment catalogs the profile renders.
- `GET /api/prices?item=` reads the Tempe 85281 mock catalog.
- `GET /api/stores?lat=&lng=&maxDistanceMi=` lists nearby branches with distances.
- `POST /api/grocery/optimize {items,lat,lng}` ranks stores by what the basket costs.
- `POST /api/geo/describe {lat,lng,allowLookup}` names a location; the third-party
  lookup runs only when `allowLookup` is exactly `true`.
- `GET /api/failures` returns recent external-service failures.

Mock prices are development estimates. The interface labels them as mock Tempe
prices and does not present them as live store quotes.

## Troubleshooting

- `EADDRINUSE :::3000`: something already uses port 3000 — run `PORT=4000 npm start`.
- `key=MISSING (AI unavailable)`: add `VOYAGER_KEY` to `.env` and restart. Plans
  and photo recognition stay unavailable until the key is configured.
- `npm test` fails: make sure you ran `npm install` first and did not edit
  `data/prices.json`, `data/recipe-sources.json`, or `data/diet-rules.json`.
- Slow live plans: check `/api/health` and confirm `airModel` is `llama4-scout-17b`.
- Phone on same WiFi can't reach demo: server binds `0.0.0.0`, use your laptop's LAN IP, e.g. `http://192.168.1.x:3000`.

## Hosting it somewhere else

FridgeFuse is not a static page: the server holds `VOYAGER_KEY` and calls ASU AIR
on the student's behalf, so a static host would mean shipping the key to the
browser. Anything that runs Node works, and the repository is already configured
for three:

| Host | What it needs | Notes |
| --- | --- | --- |
| Vercel | `vercel.json` (in repo) | Express preset, `npm test` gates the build |
| Netlify | `netlify.toml` (in repo) | Same app through `serverless-http` |
| Render | `render.yaml` (in repo) | Plain `node server.js`; free instance sleeps after ~15 min idle |

All three need `VOYAGER_KEY` set in the host's own environment settings. Planning
and photo recognition return an error without it, by design — there is no local
fallback that invents a plan.

## Deploy to Vercel

The repository is configured as an Express deployment. Vercel serves the
interface from `public/` and runs the Express API from `server.js`, so the
browser-facing `/api/*` URLs stay the same. `npm test` runs during each build,
and the local JSON data files are included with the function.

### Option 1: import the GitHub repository

1. Open [vercel.com/new](https://vercel.com/new) and import
   `satyalyadav/fridge-fuse`.
2. Leave the root directory as `/` and the framework preset as `Express`.
3. Add the environment variables below under Settings > Environment Variables.
4. Deploy. Vercel will create a preview URL first, then production when you
   merge or deploy the production branch.

### Option 2: deploy from the terminal

```bash
npx vercel@latest login
npx vercel@latest link
npx vercel@latest env add VOYAGER_KEY
npx vercel@latest env add ASU_AIR_BASE_URL
npx vercel@latest env add ASU_AIR_MODEL
npx vercel@latest env add ASU_AIR_VISION_MODEL
npx vercel@latest env add ASU_AIR_VISION_VERIFY_MODEL
npx vercel@latest --prod
```

When prompted for an environment, add the variables to `production`.
`VOYAGER_KEY` is required for plans and photo recognition; the deployed app does
not include a local demo fallback.

Set these values to enable live AI:

```text
VOYAGER_KEY=your-asu-air-key
ASU_AIR_BASE_URL=https://openai.rc.asu.edu/v1
ASU_AIR_MODEL=llama4-scout-17b
ASU_AIR_VISION_MODEL=qwen3-vl-32b-instruct
ASU_AIR_VISION_VERIFY_MODEL=llama4-scout-17b
```

After deployment, check `https://your-project.vercel.app/api/health` and open
the project URL in a browser. Confirm the sample mini-fridge flow, photo
review, Shop tab, and browser-location prompt on the preview before switching
to the production URL. Vercel Functions have an ephemeral filesystem, so
`/api/failures` is an in-memory/log view and is not durable storage.

The default `vercel.app` URL is enough for a live app. You do not need to buy
or connect a custom domain.
