# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

FridgeFuse — a chat-first meal planner for a student cooking in a dorm. It turns a
rough pantry + a grocery budget + limited equipment into dinners, a full-package
shopping list, and a cheapest-store comparison. Hackathon prototype, no build step,
no framework.

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
npm run dev:netlify  # netlify dev --offline
```

There is no linter, formatter, or watch mode. `npm test` is the only gate, and both
`vercel.json` (`buildCommand`) and `netlify.toml` (`command`) run it during deploy —
a failing test blocks the deploy.

## Layout

- `server.js` (~1100 lines) — the entire backend: Express app, Voyager/ASU AIR proxy,
  price + store catalog loading, grocery optimizer, geocoding. Exports the `app`
  itself (so Vercel detects an Express deployment) with named helpers attached via
  `Object.assign` for tests and the Netlify wrapper.
- `public/` — `index.html`, `app.js` (~1300 lines), `styles.css`. Plain DOM, no
  bundler; `app.js` is served as-is.
- `data/prices.json` — mock Tempe 85281 catalog: `aliases`, `items[].prices[chain]`,
  `stores`. Prices are development estimates, labeled as such in the UI.
- `data/stores.json` — approximate neighborhood-level branch coordinates + `origin`.
- `data/recipe-sources.json` — the recipe citation allowlist (versioned).
- `data/diet-rules.json` — dietary restrictions: student phrasings → excluded
  catalog tags plus a word-level net, with per-rule `allows` exceptions.
- `scripts/propose-food-codes.js` — maintenance only, never runtime. Proposes
  FoodOn/FDC codes for review; `npm run codes:propose`.
- `test.js` — one flat script of `ok(...)` assertions, run in-process.
- `netlify/functions/api.js` — 4-line `serverless-http` wrapper around `server.js`.

## Things that will bite you

**The interface says "inventory"; the code says "pantry".** The rename was
user-facing only: element ids, CSS classes, `state.pantry` and the `/api/plan`
`pantry` field are unchanged, so nothing on the wire moved. A test fails any
user-visible "pantry" in the markup.


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

**Recipes are grounded to an allowlist.** The plan system prompt is built from
`data/recipe-sources.json` at startup and the server rejects citations that do not
match it exactly. Changing the allowlist changes the prompt and the tests that
enumerate every source. A bad or empty file makes the server refuse to start, by design.

**Dietary restrictions are enforced, not requested.** `data/diet-rules.json` drives
both the prompt and a post-generation check (`assertPlanRespectsDiet()`) that scans
titles, pantry uses, needs, steps, the shopping list, and leftovers. A violating plan
gets one repair attempt and is then rejected. Each rule's `allows` list is stripped
before its `forbids` are matched — that is what keeps "peanut butter" from tripping
dairy-free's "butter", so add a substitute there rather than loosening a `forbids`
entry. An ingredient the catalog knows is judged by its `tags` alone (exact); only
unknown ingredients and free-text steps reach the word net. A test cross-checks the
two, so a new catalog item needs correct tags or the build fails. An allergy is a safety constraint: do not add a path that serves a violation.

**`findPrice()` resolves most-specific-first.** Exact name, then alias, then the
longest loose match. It used to take any substring hit, which meant "gluten free
pasta" resolved to wheat `pasta` — do not reintroduce a first-match-wins lookup.

**Recipes are typed requirements, not ingredient names.** `dinner.needs` is
`[{item, amount, unit}]`. `normalizeRequirement()` validates each one against the
catalog and its unit family; `groundShoppingPlan()` sums demand, buys whole packages,
and computes leftovers and `totalCost`. The model's own `shoppingList`, `leftovers`,
and `totalCost` are ignored — do not start trusting them again. Units convert only
within a family (count/mass/volume); a cross-family requirement is refused rather
than converted through a guessed density.

**Amount checks are plausibility, not accuracy.** `perServing` bands in
`data/prices.json` plus `MAX_PACKAGES_PER_DINNER` catch magnitude errors, scaled by
`dinner.servings`. `parseAiPlan` is strict on the first pass so the model can correct
itself, and lenient on the repaired pass so a stubborn amount degrades to one package
instead of 502-ing the plan. Widen a band rather than deleting it if it fires on a
legitimate portion.

**Prices are always re-grounded server-side.** The model may propose a shopping list,
but `groundShoppingPlan()` replaces its prices with real packs from `data/prices.json`.
Never let model-supplied prices reach the client.

**The grocery optimizer is deterministic.** `optimizeCart()`, `haversineMiles()`,
`describeLocation()` and friends use only local JSON — no model call, no API key.
Keep it that way; it is the part of the demo that works offline.

**Third-party geocoding is consent-gated.** `/api/geo/describe` and `/api/geo/postal`
only call Nominatim when the client sends literal `true` for `allowLookup`. Requests
are throttled server-side (`NOMINATIM_MIN_INTERVAL_MS`, ~1/sec) and never made from
the browser, to honor Nominatim's policy. The catalog's own ZIP resolves locally with
no lookup at all.

**Two deploy targets share one app.** `server.js` must keep working under Vercel
(Express export, `data/*.json` via `includeFiles`) and Netlify (`serverless-http`,
`included_files`). `resolveDataPath()` exists so data files resolve from
`LAMBDA_TASK_ROOT` as well as `__dirname` — use it for any new data file, and add the
file to both `netlify.toml` and `vercel.json`.

**Frontend state lives in localStorage** under `fridgefuse-state-v2` (pantry,
constraints, messages, grocery list, profile, location consent). Changing the shape of
`DEFAULT_STATE` in a breaking way means bumping the key; `loadState()` and
`sanitizeStoredPlan()` defend against stale stored plans (e.g. legacy recipe citations).

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
no TypeScript, no new dependencies without a reason (the whole runtime is express +
serverless-http + dotenv). Comments in this codebase explain *why* a constraint exists
— keep that habit rather than narrating what the code does.
