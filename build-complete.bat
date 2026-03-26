@echo off
REM Comprehensive environment setup for Rust MSVC compilation
setlocal enabledelayedexpansion

echo Setting up complete MSVC environment for Rust...

set BuildToolspath=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools

REM Call vcvars to set all require variables
echo Calling vcvars64.bat...
call "!BuildToolspath!\VC\Auxiliary\Build\vcvars64.bat" amd64

REM Additional SDK paths for Windows 10/11
set "LIB=!LIB!;!BuildToolspath!\VC\Tools\MSVC\14.44.35207\lib\x64"

REM Look for Windows 11 SDK (more recent than Windows 10)
if exist "C:\Program Files (x86)\Windows Kits\11" (
    for /d %%D in ("C:\Program Files (x86)\Windows Kits\11\Lib\*") do (
        set "LIB=!LIB!;%%D\um\x64;%%D\ucrt\x64"
    )
    echo Using Windows 11 SDK
) else if exist "C:\Program Files (x86)\Windows Kits\10" (
    for /d %%D in ("C:\Program Files (x86)\Windows Kits\10\Lib\*") do (
       set "LIB=!LIB!;%%D\um\x64;%%D\ucrt\x64"
    )
    echo Using Windows 10 SDK
) else (
    echo WARNING: Windows SDK not found
    echo Attempting to continue anyway...
)

echo.
echo Environment variables set:
echo INCLUDE: %INCLUDE:~0,80%...
echo LIB: %LIB:~0,80%...
echo.

cd /d "C:\Users\david\Desktop\ai_overlay_assistant"
echo Current directory: %CD%
echo.

echo Starting Tauri dev server...
call npm run tauri:dev

if %ERRORLEVEL% equ 0 (
    echo.
    echo SUCCESS! Build completed.
) else (
    echo.
    echo Build failed with exit code: %ERRORLEVEL%
)

pause
