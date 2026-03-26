@echo off
REM Install Visual C++ Build Tools for Rust
REM Run as Administrator

echo Installing Visual C++ Build Tools for Rust...
echo.

set VS_INSTALLER="C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe"
if not exist %VS_INSTALLER% (
    set VS_INSTALLER="C:\Program Files\Microsoft Visual Studio\Installer\vs_installer.exe"
)

echo Found installer: %VS_INSTALLER%
echo.
echo This will add the C++ workload to Visual Studio 2022.
echo The installation may take 5-15 minutes.
echo.

%VS_INSTALLER% modify ^
  --installPath "C:\Program Files\Microsoft Visual Studio\2022\Community" ^
  --add "Microsoft.VisualStudio.Workload.NativeDesktop" ^
  --passive ^
  --norestart

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Installation completed successfully!
    echo.
    echo Next: Close this window and all terminals, then run:
    echo   npm run tauri:dev
) else (
    echo.
    echo Installation encountered an issue.
    echo Please manually:
    echo 1. Open Visual Studio Installer
    echo 2. Click "Modify" for Visual Studio 2022 Community
    echo 3. Check "Desktop development with C++"
    echo 4. Click Modify
)

pause
