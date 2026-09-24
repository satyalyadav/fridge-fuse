# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

FridgeFuse — a chat-first meal planner for a student cooking in a dorm. It turns a
rough pantry + a grocery budget + limited equipment into dinners, a shopping list,
and a cheapest-store comparison of live advertised prices. There is no mock price
catalog anymore: every price the app shows comes from a live store source. Hackathon
prototype, no build step, no framework.

## Working on this repo

Enable the shared hooks once per clone:

```bash
git config core.hooksPath .githooks
```

`.githooks/commit-msg` strips assistant attribution trailers from commit
messages. The deliverable is an app running on ASU AIR — it calls Voyager for
planning and photo recognition — and which local editor or assistant a
contributor uses is not part of it, so those lines come out automatically
instead of being remembered by hand.

## Commands

```bash
npm install          # required before anything; node_modules is not committed
npm start            # Express on 0.0.0.0:3000 (PORT=4000 npm start to change)
npm test             # the whole test suite — must print "ALL <n> CHECKS PASSED"
npm run dev:vercel   # vercel dev
```

There is no linter, formatter, or watch mode. `npm test` is the only gate, and
`vercel.json` (`buildCommand`) runs it during deploy —
a failing test blocks the deploy.

## Layout

- `server.js` (~1100 lines) — the entire backend: Express app, Voyager/ASU AIR proxy,
  meal-plan grounding, live-offer service wiring, geocoding. Exports the `app`
  itself (so Vercel detects an Express deployment) with named helpers attached via
  `Object.assign` for tests.
- `public/` — `index.html`, `app.js` (~1300 lines), `styles.css`. Plain DOM, no
  bundler; `app.js` is served as-is. One view shows at a time at every width:
  Chat is home, Plan opens when a build finishes, Shop is the comparison view.
  The pantry is a permanent side panel on wide screens and a drawer on phones.
  `body[data-view]` is the only view switch.
- `lib/live-recipes.js` — request-scoped Tavily discovery, public-page fetch,
  Recipe JSON-LD verification, and bounded safety filters.
- `data/diet-rules.json` — dietary restrictions: student phrasings → a word-level
  `forbids` net with per-rule `allows` exceptions and advisory `notes`.
- `test.js` — one flat script of `ok(...)` assertions, run in-process.

## Things that will bite you

**The tests assert on source text.** `test.js` reads `public/app.js`,
`public/index.html`, and `server.js` as strings and matches them with regexes — e.g.
`buildPlanSource` is captured with `/async function buildPlan[\s\S]*?\n}\n\nfunction formatMoney/`,
and other checks pin `MAX_VISION_IMAGE_EDGE = 1024`, `data-vision-action`, element
IDs, and the relative order of `state.plan =` and `renderGroceryList()`. Renaming a
frontend function, reordering declarations, or changing an `id` can break tests
without changing behavior. Read the failing assertion's regex before "fixing" the code.

**Element IDs are contract.** Every `$("someId")` in `app.js` must have a matching
`id="someId"` in `index.html` — a test walks both files and fails on any missing one.
`RUNTIME_IDS` in `test.js` is the small allowlist for elements created at runtime.

**Voyager is required, not optional.** Planning (`/api/plan`) and photo recognition
(`/api/vision`) fail loudly without `VOYAGER_KEY` rather than falling back to a local
plan or demo data. Do not add a fallback that invents plans or prices — earlier
commits deliberately removed those. Failures go to `reportFailure()` and surface at
`/api/failures`.

**Recipes are grounded to live verified candidates.** Each planning request uses
Tavily discovery, a public HTTPS page fetch, recursive schema.org Recipe JSON-LD
extraction, and time/equipment/diet filtering before Voyager sees a candidate.
The prompt and repair call reuse that exact request-scoped candidate set. Source
titles, ingredients, and instructions are bounded untrusted facts; unsafe URLs,
redirects, malformed pages, prompt-injection text, and diet-violating source facts
are rejected. There is no static recipe catalog or model-invented URL fallback.

**Dietary restrictions are enforced, not requested.** `data/diet-rules.json` drives
both the prompt and a post-generation check (`assertPlanRespectsDiet()`) that scans
titles, pantry uses, needs, steps, and the shopping list. A violating plan
gets one repair attempt and is then rejected. Each rule's `allows` list is stripped
before its `forbids` are matched — that is what keeps "peanut butter" from tripping
dairy-free's "butter" and "almond milk" from tripping its "milk", so add a
substitute there rather than loosening a `forbids` entry. Every ingredient now goes
through that same word net; there is no catalog to answer for known items, so an
alias like "gf pasta" is conservatively flagged. An allergy is a safety constraint:
do not add a path that serves a violation.

**Needs are ingredient names, not quantities or packages.** `dinner.needs` is
`["eggs", "rice"]`. `needName()` lowercases and singularizes each name;
`groundShoppingPlan()` turns the names into one shopping line per ingredient, shared
across the dinners that need it, and returns no prices, no packages, no total. The
model's own `shoppingList`, `leftovers`, and `totalCost` are discarded — do not start
trusting them again. Quantities were deliberately removed (the model misjudged
amounts and the package math produced false precision); do not reintroduce amounts,
units, per-serving bands, or leftover estimates without a design for where measured
quantities come from.

**All prices are live and always come from the offer pipeline.** The meal plan's
shopping list is priced in the Shop tab through `/api/grocery/offers`; the profile
budget is compared against the cheapest complete live ballpark. Never add a local
price fallback, a mock catalog, or a model-supplied price. `lib/grocery-offers.js`
is the only source of prices, and `describeLocation()` returns a coordinate label
with no branch data behind it; the Nominatim lookup names the place when the
client shares a fix.

**Advertised offers are a separate, unverified view.** `lib/grocery-offers.js`
is the only price source and every chain runs through one adapter: Walmart reads
its public search page through `lib/walmart-direct.js`, ALDI reads its
storefront GraphQL, and Fry's uses the official Kroger API when
`KROGER_CLIENT_ID`/`KROGER_CLIENT_SECRET` are set. There is no web-search or
model fallback: an adapter that fails reports a failure and its store column
stays partial. Each price keeps its scope (`retailer-advertised` for Walmart's
advertised web price, `store-api` for the Kroger/ALDI APIs), and
`groundShoppingPlan()` never reads these prices. The Shop compare view calls
`/api/grocery/offers` from one button and renders `storeEstimates`; a missing
item makes the store partial, and no invented price may fill it. Fry's without
credentials reports the missing configuration and must not fall back to a web
search. API adapters have their own quotas (Kroger: 10,000 product and 1,600
location calls per day) and nothing else makes outbound price calls.

Walmart item search reads the public search page directly through
`lib/walmart-direct.js`: the parser reads the
page's embedded `__NEXT_DATA__`, and impit supplies a browser TLS fingerprint
because a plain server fetch gets the CAPTCHA. Keep the fingerprint version
and the header set in sync (`chrome151` today); a mismatched pair returns the
robot page with HTTP 200. The profile matters more than the IP: chrome131 and
chrome136 are challenged from Vercel's AWS IP while chrome151, chrome142, and
ios18 pass there, so the default list is `chrome151, chrome142, ios18`.
`WALMART_BROWSERS` overrides the list and `WALMART_WARMUP=1` visits the
homepage first, which the code keeps for the day the WAF starts demanding
session cookies. The default list comes from impit's shipped typings at
startup (newest two Chrome profiles plus the newest iOS one), so an impit
upgrade modernizes the fingerprints with no code edit; `DEFAULT_BROWSERS` is
only the fallback for when those typings cannot be read. `/api/walmart/canary`
tests every profile from the deployment and Vercel Cron calls it daily, so a
Walmart block shows up in the failure log before a demo does. Dependabot opens
the weekly impit bump and the GitHub test workflow gates it. When the direct
read fails, the failure is reported for that item; there is no search fallback.
ALDI search and prices come from
its storefront GraphQL with a cached guest session (in-flight dedupe included):
weight-priced items use the per-pound unit price, packaged goods the package
price. When `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` are set, the Fry's
chain uses the official Kroger Products and Locations APIs:
cache the 30-minute token and the location per ZIP, never log the secret, keep
the daily quotas in mind (10,000 product and 1,600 location calls), and label
those prices `store-api`. Without credentials the Fry's chain reports no
prices; it must not fall back to a web search.

**Third-party geocoding needs an explicit `allowLookup: true`.** Sharing a location
is the consent: `public/app.js` sends the flag with the fix, and the server keeps the
literal `true` check so no other caller can reach Nominatim. Coordinates are rounded
to three decimals (~110 m) before they leave, requests are throttled server-side
(`NOMINATIM_MIN_INTERVAL_MS`, ~1/sec), and the browser never makes the call, to honor
Nominatim's policy. When the lookup fails the label falls back to "Your location".
The OpenStreetMap credit lives in the Shop fine print, not under the name.

**One deploy target.** `server.js` runs on Vercel (Express export,
`data/*.json` via `includeFiles`). `resolveDataPath()` exists so data files
resolve from `LAMBDA_TASK_ROOT` as well as `__dirname` — use it for any new
data file, and add the file to `vercel.json`.

**Frontend state lives in localStorage** under `fridgefuse-state-v2` (pantry,
constraints, messages, grocery list, profile, location). Changing the shape of
`DEFAULT_STATE` in a breaking way means bumping the key; `loadState()` and
`sanitizeStoredPlan()` defend against stale stored plans (e.g. legacy recipe citations
or the removed package fields).

**One word per job.** Fridge is the appliance, the fridge photo, and the brand.
Pantry is the food list. Kitchen is the saved bundle you download or restore.
Visible copy must not mix them: no "mini-fridge" for the food list, no "pantry"
for the export file. Nav labels, headings, and buttons use the same noun for the
same thing. Button labels stay fixed while counts and states move to a count,
chip, or disabled state; "No meal plan yet" as a label is the pattern to avoid.

## Models

Set via env, defaults in `.env.example`. Text planning uses `llama4-scout-17b`; photo
recognition uses `qwen3-vl-32b-instruct`; a second independent verification pass uses
`ASU_AIR_VISION_VERIFY_MODEL` (defaults to the text model). Tests pin all three — the
split between text and vision models is asserted, not incidental.

Photo recognition is deliberately conservative: an item is auto-added only with a safe
crop, a whole unobstructed object at high confidence, *and* an independent second pass
confirming it. Everything else goes to user review. Do not loosen this without reading
issue #1.

## Style

Match what is there: CommonJS, double quotes, 2-space indent, no semicolon-free style,
no TypeScript, no new dependencies without a reason (the runtime is express, dotenv,
and impit, whose browser TLS fingerprint is what gets the Walmart page read past the
CAPTCHA). Comments in this codebase explain *why* a constraint exists
— keep that habit rather than narrating what the code does.
