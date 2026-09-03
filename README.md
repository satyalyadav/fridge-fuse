# FridgeFuse prototype

Fuse what you have into a meal you can afford.

FridgeFuse is a chat-first meal planner for a freshman cooking in a dorm. It
turns a rough pantry, a grocery limit, and limited equipment into three simple
dinners, one full-package shopping list, and a view of what will remain.

Live demo: [fridgefuse.netlify.app](https://fridgefuse.netlify.app)

## Run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Run `npm test` for the
in-process planner and contract checks.

## Demo flow

The home screen is a conversation, not a constraint form. A student can describe
their food, budget, time, and equipment in one message or add a fridge photo.
FridgeFuse keeps a rough pantry in local browser storage and renders the evolving
plan beside the chat.

The stable stage path uses the grounded mock catalog so it responds immediately:

1. Choose “Try a sample mini-fridge.”
2. See three microwave-safe dinners with use-soon food scheduled first.
3. Open beginner cooking steps.
4. Review the merged full-package list and estimated checkout total.
5. Swap a meal without resetting the pantry or budget.
6. Open the pantry to edit rough amounts or mark another item “use soon.”

ASU AIR remains available for photo recognition. The text demo uses deterministic
constraint extraction and a catalog optimizer so a slow model cannot stall the
stage presentation.

## API

- `GET /api/health` reports server and catalog status.
- `POST /api/vision {imageDataUrl}` identifies likely pantry items.
- `POST /api/plan` builds and prices the dinner plan.
- `GET /api/prices?item=` reads the Tempe 85281 mock catalog.
- `GET /api/failures` returns recent external-service failures.

Mock prices are development estimates. The interface labels them as mock Tempe
prices and does not present them as live store quotes.

## Deploy to Netlify

The repository includes a Netlify Function wrapper for the Express API and a
redirect that keeps the browser-facing `/api/*` URLs unchanged. Netlify serves
the static interface from `public/`.

```bash
npx netlify-cli deploy --prod
```

Set `VOYAGER_KEY` as a secret function environment variable to enable live photo
recognition. Without it, the app keeps working in deterministic demo mode.
