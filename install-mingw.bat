@echo off
REM Install MinGW-w64 using Chocolatey
REM If Chocolatey is not installed, this will fail

choco install mingw -y
if %ERRORLEVEL% equ 0 (
    echo MinGW installed successfully
    echo Cargo will now use x86_64-pc-windows-gnu target
) else (
    echo Chocolatey not found or installation failed
    echo Please install Chocolatey from: https://chocolatey.org/install
    echo Then run: choco install mingw -y
)

pause
