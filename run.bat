@echo off
setlocal
cd /d "%~dp0"
where swipl >nul 2>nul
if errorlevel 1 (
  echo SWI-Prolog 9.x was not found. Install it and make sure swipl.exe is on PATH.
  pause
  exit /b 1
)
echo Starting Tower of Hanoi: Beyond Infinity - Browser Edition...
echo Open http://localhost:8080 in your browser.
swipl -q -s prolog/web_server.pl
if errorlevel 1 pause
