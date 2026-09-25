# FridgeFuse prototype

Fuse what you have into a meal you can afford.

FridgeFuse is a chat-first meal planner for a freshman cooking in a dorm. It
turns a rough pantry, a grocery limit, and limited equipment into three simple
dinners and one full-package shopping list.

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
Meal planning ranks the curated URL index and fetches publisher pages directly,
so it does not need a paid search key.
`ASU_AIR_BASE_URL`, `ASU_AIR_MODEL`, and `ASU_AIR_VISION_MODEL` already have
working defaults. Text planning uses `llama4-scout-17b`, while photo recognition
uses `qwen3-vl-32b-instruct`. A second, independent photo check uses the faster
multimodal `llama4-scout-17b` by default; it can be overridden with
`ASU_AIR_VISION_VERIFY_MODEL`.

`VOYAGER_KEY` is required for meal planning and photo recognition. If it is
missing, or a publisher page cannot be verified, the endpoint reports an error
instead of inventing a plan or recipe.

`.env` is gitignored — never commit the real key.

The Shop tab needs no search key. After you click **Find the cheapest store**, it
sends only the selected grocery names and the typed city/ZIP area to one endpoint
that queries each chain through its own live source. Results are cached in the
server process for six hours.

Each response carries `storeEstimates`: a per-store ballpark for the whole list,
built only from the prices the adapters returned. A store that could not price an
item lists it under `missing` and the total is labeled partial; no invented price
enters the total. The Shop compare view merges these totals across batches and
marks the leading store as a ballpark, not a verified checkout total.

Walmart has no free official API: its internal GraphQL returns 418, product
pages return a CAPTCHA to plain server fetches, and the affiliate API needs
approval. The item search instead reads Walmart's public search page directly
through `lib/walmart-direct.js`: it parses the page's embedded `__NEXT_DATA__`,
sorted by price, and gets past the CAPTCHA with impit's browser fingerprint
plus a matching header set. The profile is what decides it: chrome151,
chrome142, and ios18 pass from Vercel's AWS IP, while chrome131 and chrome136
are challenged there. The list is resolved at startup from impit's shipped
profiles (newest two Chrome plus newest iOS), so an impit upgrade is enough to
modernize it. `WALMART_BROWSERS` overrides the list and `WALMART_WARMUP=1`
visits the homepage first. `/api/walmart/canary` tests every profile
from the deployment, and a daily Vercel Cron calls it, so a Walmart block
lands in `/api/failures` before a demo. The
prices are Walmart's own advertised web prices, with no key and no credits.
When the direct read fails, the failure is reported for that item and Walmart
is left out of the comparison for it. The adapter passes the area ZIP
(Walmart's result set changes with it), prefers first-party Walmart listings
over marketplace bulk packs, and labels the prices as advertised web prices,
not verified pickup prices. Walmart grocery prices are national, so the web
price is the price at the nearby Tempe store.

When `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` are set (free registration at
developer.kroger.com), Fry's prices come from the official Kroger Products API
scoped to the nearest Fry's location for the search ZIP. That is the exact
store price with size and promo fields, and it uses the free daily quota
(10,000 product calls, 1,600 location calls). The client-credentials token is
cached for its 30-minute life and the location is cached per ZIP; a throttled 5xx
gets one short retry. Without the credentials the Fry's chain reports no prices;
it never falls back to a web search. Official prices enter the ballpark with
`store-api` scope.

ALDI joins when the `aldiPages` option is on. Its storefront GraphQL (the same
public operations its web app calls, with a guest session cookie) returns
search results with names, sizes, and prices. Weight-priced produce uses the
per-pound unit price; packaged goods use the package price. The route
enables `aldiPages`; tests use the default off.

Cache state is in memory and therefore resets when a Vercel process is replaced.
Pickup availability, dietary suitability, and the cheapest complete cart are not
verified.

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
opens the finished plan on its own screen. Chat is home; Plan and Shop are one
tap away in the rail, and the pantry stays open beside the conversation on wide
screens.

With `VOYAGER_KEY` configured, the planning flow sends the pantry, constraints,
and latest request to ASU AIR. Voyager creates the dinners and cooking steps.
The server turns the ingredient names into a shopping list and drops every
number the model returned; the Shop tab prices that list live.

The demo flow is:

1. Choose “Try a sample pantry.”
2. See three microwave-safe dinners with use-soon food scheduled first.
3. Open beginner cooking steps.
4. Send the shopping list to Shop, where live prices rank the stores.
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

The Shop tab answers the other half of the problem — not “what can I cook” but
“where do I buy it for the least money.” A student builds a shopping list, shares
their location, and gets every nearby store ranked by what the whole basket
actually costs, with distance and a per-item breakdown.

1. Open **Shop** and add items (`eggs, milk, cheese`), or press “Add what my
   plan needs” to pull the ingredients from the current meal plan.
2. Adjust quantities; the list is saved on the device like the pantry.
3. Type the search area (Tempe, AZ 85281 by default) or share a location.
4. Compare — every chain is searched live per item, stores that priced more of
   the list rank first, then total. The cheapest complete ballpark is flagged
   and compared against the profile budget.

### Showing where the user is

Sharing a fix labels the Shop tab with the area name (`Tempe, Arizona`). The name
comes from OpenStreetMap's free Nominatim service through `POST /api/geo/describe`.
That call runs server-side, so Nominatim's User-Agent policy is honoured, requests
are throttled to their ~1/second limit, and the browser never makes a cross-origin
call. Only coordinates rounded to three decimals (~110 m) are sent, and the request
carries a literal `allowLookup: true`, which the server requires before it calls the
third party. If the service is slow or down the label falls back to "Your location",
the failure is logged like any other external call, and the OpenStreetMap credit sits
in the Shop fine print rather than under the name.

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

- `data/curated-recipe-leads.json` stores publisher URLs and ranking hints only.
  The server freshly fetches candidate HTTPS pages with a browser-safe client,
  follows only manually validated public redirects, and accepts a candidate
  only when recursive schema.org Recipe JSON-LD supplies its title, ingredients,
  instructions, and exact time; equipment is inferred from verified directions.
  Per-request page checks are bounded.
- Every returned dinner carries an exact `sourceRecipe`, `source`, and
  `sourceUrl` triple from the verified candidates. Publisher homepages,
  hallucinated URLs/IDs, snippets, and model timing claims are rejected.
- Voyager selects recipe IDs only and does not receive publisher directions.
  The server returns the exact verified JSON-LD ingredients, time, inferred
  equipment, and ordered publisher directions, alongside the publisher link and
  visible credit. RCP recipes retain the page's required attribution and license
  notice. For other listed publishers, reuse permission has not been verified;
  credit does not grant permission. This is a hackathon display path pending
  reuse-rights review, not a claim that the source text is legally cleared.
- Candidate source text is bounded and treated as untrusted evidence. Titles,
  ingredients, and directions that violate the active diet or contain obvious
  prompt-injection text are rejected. Voyager sees only the candidate IDs and
  bounded selection facts; it does not receive publisher directions.
- The server does not adapt a source recipe. It uses the verified ingredient set
  and rejects candidates that do not fit the request's time, equipment, and diet.
- Publisher requests use a process-wide host pacer and bounded per-request
  checks. Failures are aggregated and exposed through `/api/failures`. There is
  no search API fallback or model-invented URL fallback.

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
shopping line, shared across the dinners that need it. Amounts were deliberately
removed: the model misjudged them and the package math produced false precision,
so the plan asks for names and claims no leftovers. Do not reintroduce amounts,
units, per-serving bands, or leftover estimates without a design for where
measured quantities come from.

`shoppingList`, `leftovers`, and `totalCost` are not accepted from the model at
all. It is asked for dinners and ingredient names; anything with a number in it
is discarded. Prices come from the live comparison in Shop.

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
runs live searches and the plan prices nothing itself. Kroger
(Fry's parent) publishes a location-aware product API behind OAuth partner
credentials; ALDI's storefront GraphQL is read directly; Walmart's public search
page is read with a browser fingerprint; Trader Joe's has no online prices and is
not compared. Pickup availability, package sizes, and in-store prices are not
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
  `sourceRecipe`, `source`, `sourceUrl`, and (when adapted) `adaptationNote`.
  The response echoes the `dietRules` that were enforced; a plan that breaks them
  is rejected, not returned.
- `GET /api/preferences` serves the dietary and equipment catalogs the profile renders.
- `GET /api/walmart/canary` tests every configured Walmart fingerprint from the
  deployment; Vercel Cron calls it daily.
- `POST /api/grocery/offers {items,area}` prices up to five selected items per
  chain from each chain's own live source, reports per-item sources and failures,
  and returns a per-store `storeEstimates` ballpark. The Shop compare button
  calls this endpoint.
- `POST /api/geo/describe {lat,lng,allowLookup}` names a location; the third-party
  lookup runs only when `allowLookup` is exactly `true`.
- `GET /api/failures` returns recent external-service failures.

Prices are advertised web prices or official store-API prices, labeled with their
scope in the results. Pickup availability is never claimed.

## Troubleshooting

- `EADDRINUSE :::3000`: something already uses port 3000 — run `PORT=4000 npm start`.
- `key=MISSING (AI unavailable)`: add `VOYAGER_KEY` to `.env` and restart. Plans
  and photo recognition stay unavailable until the key is configured.
- `npm test` fails: make sure you ran `npm install` first and did not edit
  `data/diet-rules.json`.
- Live plans need `VOYAGER_KEY`, a usable curated recipe index, and reachable
  publisher pages. `/api/health` reports the provider and eligible lead counts.
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

Vercel functions have an ephemeral filesystem, so
`/api/failures` is an in-memory/log view and is not durable storage.

The default `vercel.app` URL is enough for a live app. You do not need to buy
or connect a custom domain.

## Planning and the pantry

Plans use request-scoped verified recipe IDs and server-validated equipment,
ingredients, dietary restrictions, exact source times, and citations. The model
still creates the plan; there is no local fallback if Voyager or live recipe
search fails. A saved recipe request must still have enough verified candidates
for every requested dinner.

The browser sends pantry names only — no amounts. Shopping covers every
ingredient the recipes need that the pantry does not have, at one package per
dinner that uses it. Plan totals use a complete checkout at one store, matching
the Shop comparison.

Swaps replace one dinner and recalculate the full shopping list.

`npm test` includes the behavioral regressions in `test-fixes.js`, covering
pantry ownership, request races, dietary safety, file validation, equipment,
shopping totals, and swaps without browser automation.
