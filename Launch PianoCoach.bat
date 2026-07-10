@echo off
setlocal
title PianoCoach Generator
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   PianoCoach: the Python environment .venv is not set up yet.
  echo   One-time setup, from this folder in a terminal:
  echo.
  echo     py -3.12 -m venv .venv
  echo     .venv\Scripts\python.exe -m pip install fastapi uvicorn[standard] numpy python-multipart
  echo.
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting PianoCoach Generator on http://127.0.0.1:8770/
echo   Your browser will open in a few seconds. Keep this window open while you work.
echo   Press Ctrl+C (or close this window) to stop the server.
echo.

rem Open the browser after a short delay (benign built-ins only; spawned so it does not block).
start "" /min cmd /c "timeout /t 3 /nobreak >nul & explorer http://127.0.0.1:8770/"

rem Run the server (blocks here, showing logs).
.venv\Scripts\python.exe -m uvicorn webgen.server:app --port 8770

echo.
echo   Server stopped.
pause