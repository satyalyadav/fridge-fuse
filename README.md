# FridgeFuse prototype

Fuse what you have into a meal you can afford.

FridgeFuse is a chat-first meal planner for a student cooking in a dorm. It
turns a rough pantry, grocery budget, and limited equipment into dinner
suggestions and an ingredient list. The Shop view compares that list against
live advertised prices.

Live deployment: Vercel will provide the project URL after the first deploy.

## Prerequisites

- Node.js 24+ (`package.json` pins the runtime family) and npm
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
Meal planning starts with a bounded curated pool and can use at most one
pantry-driven RCP `/search` lookup (`source=wikibooks`) per request. Search
results are cached for five minutes and capped at four fresh recipe URLs per
request. No client-side or paid search key is needed.
`ASU_AIR_BASE_URL`, `ASU_AIR_MODEL`, and `ASU_AIR_VISION_MODEL` already have
working defaults. General text/chat uses `llama4-scout-17b`, while photo recognition
uses `qwen3-vl-32b-instruct`. A second, independent photo check uses the faster
multimodal `llama4-scout-17b` by default; it can be overridden with
`ASU_AIR_VISION_VERIFY_MODEL`.
Recipe drafts use the separate `gemma4-31b-it` model by default, while general
text/chat remains on `ASU_AIR_MODEL`. The one repair also defaults to the recipe
drafting model and fixes deterministic validation failures. Set
`ASU_AIR_RECIPE_PLANNING_MODEL` to change the recipe writer, or optionally set
`ASU_AIR_RECIPE_REPAIR_MODEL` for a separate repair model. The recipe checks enforce
hard diet, equipment, source, and time constraints. Planning,
discovery, and verification share a 110-second request deadline; each individual
planning or repair model call is capped at 30 seconds, with remaining
request time taking precedence.

`VOYAGER_KEY` is required for meal planning and photo recognition. Verified
publisher recipes remain available when a matching page can be checked. Voyager
can also adapt a verified recipe or create a new recipe when the source pool
cannot satisfy the request; generated recipes have no publisher citation.

`.env` is gitignored — never commit the real key.

Vercel requests to planning, photo recognition, chat interpretation, live offers,
and location lookup pass through Vercel BotID's Basic check before they reach
those services. Enable Vercel OIDC for the project so the server can verify the
check. BotID uses no extra app secret or CAPTCHA account. Local development
bypasses BotID; `/api/models` and `/api/failures` answer only on localhost while
the app runs outside production. Basic checks reduce automated abuse, but do not
stop deliberate manual use. FridgeFuse has no access code or app-wide request quota.

The Shop tab needs no search key. After you click **Find the cheapest store**, it
sends selected grocery names and the typed search area to `/api/grocery/offers`,
which queries each chain through its live source. Results are cached in server
memory for up to six hours; a replaced process starts with an empty cache.

Each response carries `storeEstimates`: a per-store ballpark built only from
prices the adapters returned. Missing items make a result partial; no invented
price enters the total. The Shop view merges batches, applies the quantities the
student selected, and ranks stores by items priced and then total. Even a complete
result is not a verified checkout total.

ALDI uses its storefront GraphQL; Fry's uses Kroger's official Products API when
`KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` are set. Without those credentials,
Fry's returns no prices and the app does not search the web as a fallback. The
Shop view labels each live source. It does not verify package sizes, pickup
availability, or checkout totals.

## Run

**Double-click `start.command`** (macOS or Linux) or **`start.bat`** (Windows). It
installs anything missing, creates `.env` from the example on first run, starts the
app and opens the browser. The only prerequisite is Node.js from
[nodejs.org](https://nodejs.org).

In VS Code you can instead run the **Run FridgeFuse** task (Terminal → Run Task, or
Ctrl/Cmd+Shift+B), which does the same thing without touching a terminal.

From a terminal:

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
opened: who you are (name), what you can cook with, and what you
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

`data/diet-rules.json` and `EQUIPMENT_OPTIONS` in `server.js` are the single
source of truth — `GET /api/preferences` serves them to both the welcome wizard
and the profile drawer, so an option can't appear in the form without also
existing on the server. There are 17 dietary options across three groups (diets
including halal, kosher and pescatarian; nine allergens; things to skip) and 11
pieces of equipment. A restriction is enforced by turning it into a concrete
forbidden-term list appended to the AI planning prompt — not by hoping the model
infers "vegan" correctly from a word. The form says plainly that this is not an
allergy-safety guarantee.

## Demo flow

Behind the profile, the home screen is a conversation, not a constraint form. A
student can describe their food, budget, time, and equipment in one message or
add a fridge photo. FridgeFuse keeps a rough pantry in local browser storage and
shows recipe suggestions in Chat. The student adds wanted recipes to Plan one
at a time. Chat is home; Plan and Shop are one tap away in the rail, and the
pantry stays open beside the conversation on wide screens.

With `VOYAGER_KEY` configured, the planning flow sends the pantry, constraints,
and latest request to ASU AIR. It uses verified publisher recipes when suitable,
can adapt a verified recipe, and can generate a recipe if no source fits. The
server checks dietary restrictions and equipment for every result. Generated
and adapted cooking times are estimates and are labeled in the app.
For authored recipes, the server raises an estimate when needed to cover sequential
timers plus two minutes for prep and plating. If that exceeds the requested limit,
the recipe is rejected; verified publisher times remain exact.
Quick authored meals must name mature beans as canned or cooked; draining alone
does not establish their prepared form. Explicitly used plain salt and pepper are
included in the ingredient list, while optional, negated, or alternative mentions
are not inferred.
The server turns ingredient names into a shopping list and discards model-supplied
shopping lists, quantities, totals, and prices. The Shop tab prices that list live.

The demo flow is:

1. Choose “Show me an example.”
2. Review recipe suggestions and directions in Chat; add wanted dinners to Plan.
3. Review the selected dinners and their ingredient needs in Plan.
4. Add plan items to Shop, where live prices rank the stores.
5. Swap a meal without resetting the pantry or budget.
6. Open the pantry to add food or mark another item “use soon.”

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

The Shop tab shows advertised prices for the search area and ranks stores by how
many items they priced, then by total. It does not report store distances or
verified checkout costs.

1. Open **Shop** and add items (`eggs, milk, cheese`), or press **Add plan items**
   to pull the ingredients from the current meal plan.
2. Adjust quantities; the list is saved on the device like the pantry.
3. Type the search area (Tempe, AZ 85281 by default) or share a location.
4. Compare — every chain is searched live per item, stores that priced more of
   the list rank first, then total. The cheapest complete ballpark is flagged
   and compared against the profile budget.

### Showing where the user is

Sharing a fix labels the location bar with the area name (`Tempe, Arizona`). The
name comes from OpenStreetMap's free Nominatim service through
`POST /api/geo/describe`.
That call runs server-side, so Nominatim's User-Agent policy is honoured, requests
are throttled to their ~1/second limit, and the browser never makes a cross-origin
call. Only coordinates rounded to three decimals (~110 m) are sent, and the request
carries a literal `allowLookup: true`, which the server requires before it calls the
third party. The shared fix labels the location bar; price searches still use the
editable search area. If Nominatim is slow or down the label falls back to "Your
location". The failure is logged, and the OpenStreetMap credit sits in the Shop
fine print.

## Swapping a dinner

"Swap" excludes the **recipe**, not the dinner's title: the plan prompt lets a title
describe the adapted result, so the same verified source could otherwise come back
under a new name and the swap would look like it did nothing. The server refuses a
plan that reuses an excluded recipe and asks the model again.

Equipment and time narrow the verified live candidates, so a
swap can genuinely have nowhere to go. When the second attempt still has no
alternative the plan is returned with `swapUnavailable`, and the chat says so rather
than silently handing back the same dinner. Each swap reuses the same
request-scoped verified candidate set and re-verifies any retained dinner that
was not returned by search.

## Recipe sources

- `data/curated-recipe-leads.json` supplies a bounded starter pool of publisher
  URLs. A request can use at most one pantry-driven RCP `/search` lookup with
  `source=wikibooks`; results are cached for five minutes and capped at four fresh
  dynamic URLs per request. Search results are leads only: the server checks
  exact hosts and paths, fetches public HTTPS pages, and verifies Recipe JSON-LD
  before a page can ground a dinner.
- A dinner is marked as sourced, adapted, or generated. Sourced dinners use the
  verified publisher ingredients and directions with the exact recipe citation.
  Adapted dinners carry the verified source citation and visible credit, plus an
  AI-authored adaptation note and directions. Generated dinners have no publisher
  source or link and are labeled “AI-created recipe.” Adapted and generated
  cooking times are estimates; the UI labels them.
- RCP recipes retain the page's required attribution and license notice. For
  other listed publishers, reuse permission has not been verified; credit does
  not grant permission. This is a hackathon display path pending reuse-rights
  review, not a claim that the source text is legally cleared.
- Candidate source text is bounded and treated as untrusted evidence. The server
  applies dietary, equipment, and time checks to results, and rejects unsafe
  pages and source facts. Recipe generation does not create a price catalog or
  guarantee that the live Shop total fits the profile budget.
- Publisher requests use a process-wide host pacer and bounded per-request
  checks. Local development can inspect aggregated failures through
  `/api/failures`. No client-side search key is needed.

## Your kitchen data

Everything a student builds up — pantry, plan, saved recipes, preferences, Shop
list — is saved in that browser under one key, with no account and nothing
uploaded. The profile drawer can **download it as a JSON file** and **restore one
back**, so the data survives a cleared browser and can be moved to another device
by hand.

Restoring goes through the same validator as the stored state (`normaliseState`),
so a truncated, hand-edited or hostile file cannot put a shape into the app that
the renderers do not expect: wrong types fall back to defaults, lists are bounded,
and a location with no usable coordinates is dropped. The file carries a format
marker and a version, and a file from a newer version is refused rather than
half-read. Restoring asks before it replaces what is on the device.

The exported file is the state object itself under a small envelope, so if
accounts are added later they sync the same shape rather than a second format
that would have to be kept in step.

## Needs are ingredient names

A dinner requires *ingredients*; the plan keeps those separate from prices:

```json
"needs": ["eggs", "gluten free pasta"]
```

The model names what each dinner uses; the server turns each name into one
shopping line, shared across the dinners that need it. Ingredient amounts were
deliberately removed: the model misjudged them and package math produced false
precision, so the plan asks for names and claims no leftovers. Do not reintroduce amounts,
units, per-serving bands, or leftover estimates without a design for where
measured quantities come from.

`shoppingList`, `leftovers`, `totalCost`, and prices are not accepted from the
model. It is asked for dinner ingredients and may provide estimated cooking times
for generated or adapted recipes. Prices come from the live comparison in Shop.

## Dietary restrictions

A student's restrictions are treated as a safety constraint, not a preference the
model is asked to keep in mind. `data/diet-rules.json` maps the phrasings a student
types (`peanut allergy`, `dairy free`, `plant-based`) to ingredients the plan may
never contain, and the server enforces it on both sides of the model call:

- The plan prompt lists every forbidden ingredient for the restrictions in play.
- Pantry items that break the diet are named as off-limits instead of being offered
  as food to cook — they stay in the student's pantry, they just do not get planned.
- Every generated plan is re-checked afterwards: titles, pantry uses, shopping needs,
  cooking steps, and the shopping list. A cooking step that says "brush
  with butter" fails a dairy-free plan even when the shopping list is clean.
- A violating plan is sent back for one repair with the restrictions restated, and
  rejected if the repair still breaks them. It is never served with the violation
  quietly left in.

Matching is word-boundary and plural-tolerant, so `egg` catches `eggs` but not
`eggplant`. Each rule's `allows` list is removed from the text before its `forbids`
are matched, so `peanut butter` does not trip the dairy-free rule's `butter`, and
`corn tortillas` does not trip gluten-free's `tortillas`.

Every ingredient and every cooking step goes through the same word net, with each
rule's `allows` list stripped first. That keeps `peanut butter` from tripping
dairy-free's `butter` and `almond milk` from tripping its `milk`, but it is
conservative: an unlisted alias like `gf pasta` is flagged for containing "pasta".
Add the safe phrasing to the rule's `allows` list rather than loosening a `forbids`
entry.

Edit the JSON to change the rules — the prompt and the check are both rebuilt from it
at startup, and a bad or empty file makes the server refuse to start, by design. All
17 rules ship with the app, matching the checkboxes in the profile drawer.

## Where prices come from

There is no open grocery-price API shared by every chain, so the Shop compare
runs live searches and the plan prices nothing itself. Kroger (Fry's parent)
publishes a location-aware product API behind OAuth partner credentials, and
ALDI's storefront GraphQL is read directly. Trader Joe's has no online prices
and is not compared. Pickup availability and final checkout totals are not
verified.

## AI chat

Every chat message goes through ASU AIR at `/api/chat/interpret`. The model returns
separate pantry and shopping actions, retaining specific names such as almond milk,
gluten-free pasta, corn tortillas, and tamari. Each
action needs evidence copied from the message. A run of foods with no punctuation is
split into separate items ("add salmon rice bean spinach" is four things), while real
multiword foods stay together. Invalid interpretations receive one
repair attempt; failed or ambiguous requests apply no food actions, and the model can
ask a follow-up question when one token could be one food or two. The chat also
understands "add the list to shop", which copies the current meal plan's shopping
list into the Shop list. Equipment and
dietary preference rules remain deterministic, including preserving allergies.
Pantry-only messages no longer generate dinners. An explicit cooking request does.

Run deterministic tests with `npm test`.


## API

- `POST /api/chat/interpret {message,pantry}` interprets food actions using AIR.
- `GET /api/health` reports server, curated recipe lead/source counts, and
  diet-rule status.
- `POST /api/vision {imageDataUrl}` returns independently verified `confirmed`
  pantry items plus `uncertain` items with bounding boxes for user review.
- `POST /api/plan` builds the dinner plan and its unpriced shopping list; dinners include
  `provenanceType` (`sourced`, `adapted`, or `generated`) and `timeIsEstimate`.
  Sourced and adapted dinners also include the verified `sourceRecipe`, `source`,
  and `sourceUrl`; adapted dinners include `adaptationNote`. Generated dinners
  have no source citation.
  The response echoes the `dietRules` that were enforced; a plan that breaks them
  is rejected, not returned.
- `GET /api/preferences` serves the dietary and equipment catalogs the profile renders.
- `POST /api/grocery/offers {items,area}` prices up to five selected items per
  chain from each chain's own live source, reports per-item sources and failures,
  and returns a per-store `storeEstimates` ballpark. The Shop compare button
  calls this endpoint.
- `POST /api/geo/describe {lat,lng,allowLookup}` names a location; the third-party
  lookup runs only when `allowLookup` is exactly `true`.
- `GET /api/models` and `GET /api/failures` work only from localhost during
  development. They are unavailable on Vercel deployments.

Prices are advertised web prices or official store-API prices, labeled with their
scope in the results. Pickup availability is never claimed.

## Troubleshooting

- `EADDRINUSE :::3000`: something already uses port 3000 — run `PORT=4000 npm start`.
- `key=MISSING (AI unavailable)`: add `VOYAGER_KEY` to `.env` and restart. Plans
  and photo recognition stay unavailable until the key is configured.
- `npm test` fails: make sure you ran `npm install` first and did not edit
  `data/diet-rules.json`.
- Live plans need `VOYAGER_KEY`; `/api/health` reports the provider and recipe
  source status. Publisher pages may be unavailable, in which case Voyager can
  generate a recipe subject to the server's diet and equipment checks.
- Phone on same WiFi can't reach demo: server binds `0.0.0.0`, use your laptop's LAN IP, e.g. `http://192.168.1.x:3000`.

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
npx vercel@latest env add KROGER_CLIENT_ID
npx vercel@latest env add KROGER_CLIENT_SECRET
npx vercel@latest --prod
```

When prompted for an environment, add the variables to `production`.
`VOYAGER_KEY` is required for chat interpretation, plans and photo recognition; the deployed app does
not include a local demo fallback.

Set these values to enable live AI:

```text
VOYAGER_KEY=your-asu-air-key
ASU_AIR_BASE_URL=https://openai.rc.asu.edu/v1
ASU_AIR_MODEL=llama4-scout-17b
ASU_AIR_VISION_MODEL=qwen3-vl-32b-instruct
ASU_AIR_VISION_VERIFY_MODEL=llama4-scout-17b
ASU_AIR_RECIPE_PLANNING_MODEL=gemma4-31b-it
# Optional; defaults to ASU_AIR_RECIPE_PLANNING_MODEL.
# ASU_AIR_RECIPE_REPAIR_MODEL=
KROGER_CLIENT_ID=your-kroger-client-id
KROGER_CLIENT_SECRET=your-kroger-client-secret
```

After deployment, check `https://your-project.vercel.app/api/health` and open
the project URL in a browser. Confirm the sample pantry flow, photo
review, the Shop comparison, and the browser-location prompt on the preview
before switching to the production URL. For a live price smoke check, add one or
two grocery items, leave the area as `Tempe, AZ 85281`, and click **Find the
cheapest store**. The same check can be run without a browser against a running
local server:

```bash
curl -sS http://localhost:3000/api/grocery/offers \
  -H 'content-type: application/json' \
  --data '{"items":["eggs"],"area":"Tempe, AZ 85281"}'
# Repeat the identical command to observe the in-process cache indications.
```

Vercel functions have an ephemeral filesystem, so local `/api/failures` is an
in-memory/log view and is not durable storage.

The default `vercel.app` URL is enough for a live app. You do not need to buy
or connect a custom domain.

## Planning and the pantry

Plans can use verified source recipes, AI adaptations, or generated recipes.
The server validates ingredients, equipment, and dietary restrictions for all
returned dinners. Only sourced recipes have exact publisher times; adapted and
generated times are estimates. There is no local planning fallback if Voyager is
unavailable. A saved sourced or adapted recipe request keeps its actual source
title and saved recipe details for validation.

The browser sends pantry names only — no amounts. The Plan lists each missing
ingredient once and names the dinners that need it. The student chooses Shop
quantities; live prices are unit prices, and package sizes and checkout totals
are not verified.

Swaps replace one dinner and recalculate the full shopping list.

`npm test` includes the behavioral regressions in `test-fixes.js`, covering
pantry ownership, request races, dietary safety, file validation, equipment,
shopping totals, and swaps without browser automation.
