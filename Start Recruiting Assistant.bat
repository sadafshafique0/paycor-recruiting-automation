@echo off
title Recruiting Assistant
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this computer.
  echo  Install the LTS version from https://nodejs.org, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo  First start: installing the app's components. This takes a minute...
  echo.
  rem Playwright drives the Edge that is already installed, so no browser download is needed.
  set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  call npm install --omit=dev
  if errorlevel 1 (
    echo.
    echo  Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
node server\index.js --open
echo.
pause
