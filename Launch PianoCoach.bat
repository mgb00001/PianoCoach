@echo off
setlocal
title PianoCoach Generator
cd /d "%~dp0"

rem Prefer the GPU environment (kept OUTSIDE OneDrive so 2.6GB of CUDA torch is not synced).
rem It holds the CUDA build of torch, which makes song analysis ~5x faster (5 min -> ~65 s).
rem Falls back to the in-repo .venv, which still works but analyses on the CPU.
set "PCVENV=C:\AIProjects(local)\pianocoach-venv312\Scripts\python.exe"
set "PCWHICH=GPU - pianocoach-venv312 - fast analysis"
if not exist "%PCVENV%" (
  set "PCVENV=.venv\Scripts\python.exe"
  set "PCWHICH=CPU - .venv fallback - analysis will be slow"
)

if not exist "%PCVENV%" (
  echo.
  echo   PianoCoach: no Python environment found.
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
echo   Environment: %PCWHICH%
echo   Your browser will open in a few seconds. Keep this window open while you work.
echo   Press Ctrl+C (or close this window) to stop the server.
echo.

rem Open the browser after a short delay (benign built-ins only; spawned so it does not block).
start "" /min cmd /c "timeout /t 3 /nobreak >nul & explorer http://127.0.0.1:8770/"

rem Run the server (blocks here, showing logs).
"%PCVENV%" -m uvicorn webgen.server:app --port 8770

echo.
echo   Server stopped.
pause