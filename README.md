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
uses `qwen3-vl-32b-instruct`.

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

Without `VOYAGER_KEY`, planning and photo recognition use deterministic mock
responses. If a live planning call fails, the server returns a local plan so the
demo can continue. If Voyager returns malformed plan JSON, the server asks the
model to repair it once. A failed repair is reported to the interface instead of
silently replacing the response with a local plan.

## API

- `GET /api/health` reports server and catalog status.
- `POST /api/vision {imageDataUrl}` identifies likely pantry items.
- `POST /api/plan` builds and prices the dinner plan.
- `GET /api/prices?item=` reads the Tempe 85281 mock catalog.
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
live planning and photo recognition. Use `llama4-scout-17b` for
`ASU_AIR_MODEL`. Without the key, the app keeps working in deterministic demo
mode.
