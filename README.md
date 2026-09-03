# FridgeFuse prototype

Fuse what you have into a meal you can afford.

FridgeFuse is a chat-first meal planner for a freshman cooking in a dorm. It
turns a rough pantry, a grocery limit, and limited equipment into three simple
dinners, one full-package shopping list, and a view of what will remain.

Live demo: [fridgefuse.netlify.app](https://fridgefuse.netlify.app)

## Prerequisites

- Node.js 20+ (`netlify.toml` pins `NODE_VERSION = "20"`) and npm
- git

Check with `node --version` / `npm --version`.

## Setup

```bash
git clone https://github.com/satyalyadav/fridge-fuse.git
cd fridge-fuse
npm install
```

Optional, live AI mode for photo recognition and meal planning:

```bash
cp .env.example .env
```

Then edit `.env` and set `VOYAGER_KEY` to your ASU AIR (Voyager) API key.
`ASU_AIR_BASE_URL`, `ASU_AIR_MODEL`, and `ASU_AIR_VISION_MODEL` already have
working defaults. Text planning uses `llama4-scout-17b`, while photo recognition
uses `qwen3-vl-32b-instruct`. A second, independent photo check uses the faster
multimodal `llama4-scout-17b` by default; it can be overridden with
`ASU_AIR_VISION_VERIFY_MODEL`.

Without `VOYAGER_KEY` the app runs in deterministic MOCK demo mode using the
grounded Tempe 85281 catalog in `data/prices.json`. This is expected and fine
for the stage demo. With the key missing you will see
`key=MISSING (mock mode)` in the server log.

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
`{"ok":true,...}` with `airConfigured: false` in mock mode,
`true` when `VOYAGER_KEY` is set.

## Demo flow

The home screen is a conversation, not a constraint form. A student can describe
their food, budget, time, and equipment in one message or add a fridge photo.
FridgeFuse keeps a rough pantry in local browser storage and renders the evolving
plan beside the chat.

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

Without `VOYAGER_KEY`, planning and photo recognition use deterministic mock
responses. If a live planning call fails, the server returns a local plan so the
demo can continue. If Voyager returns malformed plan JSON, the server asks the
model to repair it once. A failed repair is reported to the interface instead of
silently replacing the response with a local plan.

## Shop tab: cheapest-store comparison

The Shop tab answers the other half of the problem — not “what can I cook” but
“where do I buy it for the least money.” A student builds a shopping list, shares
their location, and gets every nearby store ranked by what the whole basket
actually costs, with distance and a per-item breakdown.

1. Open **Shop** and add items (`eggs, milk, cheese`), or pull the missing
   ingredients straight from the current meal plan.
2. Adjust quantities; the list is saved on the device like the pantry.
3. Choose “Use my location,” press **Shop near &lt;ZIP&gt;** to use the ZIP saved in
   your profile, or skip both and let distances run from the catalog origin.
4. Compare — stores that stock the whole list rank first, then price, then
   distance. The cheapest is flagged and the saving is spelled out.

### Shopping from a saved ZIP

The profile drawer already stores an optional ZIP code. The Shop tab uses it as a
second way to set the point distances are measured from, for anyone who would
rather not share a live GPS fix. The catalog's own ZIP (`data/stores.json`
`zip`) resolves straight to the stored origin — no network call and no consent
question, because that point is already in the data. Any other ZIP needs the
same third-party lookup, and the same consent, as a place name; declining leaves
the ZIP unresolved rather than guessing at it.

This path is fully deterministic: no model call, no third-party location service,
no API key. Store branches live in `data/stores.json` and inherit their chain's
prices from `data/prices.json`; distances are computed locally with the haversine
formula. Names a student types are resolved through the `aliases` map in
`data/prices.json` (`cheese` → `cheddar`), and anything the catalog does not know
is reported as unpriced rather than guessed at.

Branch coordinates are **approximate neighborhood-level mock data**, like the
prices — good enough for ranking, not surveyed addresses. Browser geolocation
needs a secure context, so it works on `localhost` and on the HTTPS deploy but
not over a plain LAN IP; the app falls back to the origin in `data/stores.json`
and says so.

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

## API

- `GET /api/health` reports server and catalog status.
- `POST /api/vision {imageDataUrl}` returns independently verified `confirmed`
  pantry items plus `uncertain` items with bounding boxes for user review.
- `POST /api/plan` builds and prices the dinner plan.
- `GET /api/prices?item=` reads the Tempe 85281 mock catalog.
- `GET /api/stores?lat=&lng=&maxDistanceMi=` lists nearby branches with distances.
- `POST /api/grocery/optimize {items,lat,lng}` ranks stores by what the basket costs.
- `POST /api/geo/describe {lat,lng,allowLookup}` names a location; the third-party
  lookup runs only when `allowLookup` is exactly `true`.
- `POST /api/geo/postal {postalCode,allowLookup}` resolves a ZIP to a point to
  shop from; the catalog's own ZIP resolves locally without any lookup.
- `GET /api/failures` returns recent external-service failures.

Mock prices are development estimates. The interface labels them as mock Tempe
prices and does not present them as live store quotes.

## Troubleshooting

- `EADDRINUSE :::3000`: something already uses port 3000 — run `PORT=4000 npm start`.
- `key=MISSING (mock mode)`: normal without `VOYAGER_KEY`. Add it to `.env` and restart for live AI.
- Slow live plans: check `/api/health` and confirm `airModel` is `llama4-scout-17b`.
- `npm test` fails: make sure you ran `npm install` first and did not edit `data/prices.json`.
- Phone on same WiFi can't reach demo: server binds `0.0.0.0`, use your laptop's LAN IP, e.g. `http://192.168.1.x:3000`.

## Deploy to Netlify

The repository includes a Netlify Function wrapper for the Express API and a
redirect that keeps the browser-facing `/api/*` URLs unchanged. Netlify serves
the static interface from `public/`.

```bash
npx netlify-cli deploy --prod
```

Set `VOYAGER_KEY`, `ASU_AIR_BASE_URL`, `ASU_AIR_MODEL`, and
`ASU_AIR_VISION_MODEL` under Site settings > Environment variables to enable
live planning and photo recognition. `ASU_AIR_VISION_VERIFY_MODEL` is optional
and defaults to `ASU_AIR_MODEL`. Use `llama4-scout-17b` for
`ASU_AIR_MODEL`. Without the key, the app keeps working in deterministic demo
mode.
