@echo off
REM Double-click this on Windows to run FridgeFuse.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install the LTS build from https://nodejs.org, then double-click this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies. This takes a minute.
  call npm install --no-audit --no-fund || (echo Install failed. & pause & exit /b 1)
)

if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Created .env - open it and paste your Voyager key after VOYAGER_KEY=
  echo Meal plans and photo recognition need it. Everything else works without.
  echo.
)

if "%PORT%"=="" set PORT=3000
echo FridgeFuse is starting on http://localhost:%PORT%
echo Leave this window open. Close it to stop the app.
start "" http://localhost:%PORT%
call npm start
