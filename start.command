#!/bin/bash
# Double-click this on macOS or Linux to run FridgeFuse.
# Windows: use start.bat instead.
cd "$(dirname "$0")" || exit 1

if ! command -v node > /dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install the LTS build from https://nodejs.org, then double-click this again."
  read -r -p "Press Enter to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies. This takes a minute."
  npm install --no-audit --no-fund || { read -r -p "Install failed. Press Enter to close."; exit 1; }
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Created .env — open it and paste your Voyager key after VOYAGER_KEY="
  echo "Meal plans and photo recognition need it. Everything else works without."
  echo
fi

ADDRESS="http://localhost:${PORT:-3000}"
echo "FridgeFuse is starting on $ADDRESS"
echo "Leave this window open. Close it to stop the app."
(sleep 2 && (xdg-open "$ADDRESS" || open "$ADDRESS") > /dev/null 2>&1) &
npm start
