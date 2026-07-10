@echo off
title Stop PianoCoach
echo.
echo   Stopping the PianoCoach Generator (port 8770)...
echo.
set "found="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8770" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
  set "found=1"
)
if defined found (echo   Stopped.) else (echo   PianoCoach was not running.)
echo.
pause
