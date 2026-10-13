@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js LTS 22.12 or newer, then try again.
  pause
  exit /b 1
)
node scripts\start.mjs
if errorlevel 1 pause
endlocal
