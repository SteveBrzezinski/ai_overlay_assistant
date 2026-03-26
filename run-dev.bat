@echo off
setlocal enabledelayedexpansion

echo Starting Tauri Development Server with corrected ports...
echo.

cd /d "C:\Users\david\Desktop\ai_overlay_assistant"

REM Initialize Visual Studio build environment
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" amd64

REM Run Tauri dev
echo Running: npm run tauri:dev
echo.

npm run tauri:dev

pause
