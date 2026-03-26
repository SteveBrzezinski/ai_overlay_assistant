@echo off
REM Download and install Build Tools for Visual Studio 2022 with C++ workload
REM This requires internet connection

setlocal enabledelayedexpansion

echo Installing Visual Studio 2022 Build Tools for C++...
echo This requires downloading ~4GB and may take 15-20 minutes
echo.

set TEMP_DIR=%TEMP%\VS2022BuildTools
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

cd /d "%TEMP_DIR%"

echo Downloading installer...
powershell -Command "& {try { Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile 'vs_BuildTools.exe' -TimeoutSec 600 } catch { Write-Host 'Download failed'; exit 1 }}" 

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Download failed. Please check your internet connection.
    echo Manual installation:
    echo 1. Go to: https://visualstudio.microsoft.com/downloads/
    echo 2. Download: "Build Tools for Visual Studio 2022"
    echo 3. Run installer and select "Desktop development with C++"
    pause
    exit /b 1
)

echo Running installer...
vs_BuildTools.exe ^
    --passive ^
    --wait ^
    --add "Microsoft.VisualStudio.Workload.NativeDesktop" ^
    --add "Microsoft.VisualStudio.Component.VC.Tools.x86.x64" ^
    --add "Microsoft.VisualStudio.Component.Windows10SDK"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Installation completed!
    echo.
    echo 1. Close all PowerShell/Terminal windows
    echo 2. Open NEW PowerShell
    echo 3. Run: npm run tauri:dev
) else (
    echo Installation may have encountered issues.
    echo Exit code: %ERRORLEVEL%
)

pause
