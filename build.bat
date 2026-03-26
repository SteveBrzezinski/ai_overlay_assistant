@echo off
REM Initialize Visual Studio build environment and run cargo build
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if %ERRORLEVEL% neq 0 (
    echo Failed to initialize build environment
    exit /b 1
)
echo Build environment initialized successfully
cd /d "C:\Users\david\Desktop\ai_overlay_assistant\src-tauri"
cargo build --release
