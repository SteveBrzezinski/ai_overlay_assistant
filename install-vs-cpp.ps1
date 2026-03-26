# Install Visual C++ Build Tools for Rust
param(
    [switch]$Silent = $false
)

$vsPath = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\VSU"
$vsInstallerPath = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe"

# Check if VS Installer exists
if (-not (Test-Path $vsInstallerPath)) {
    $vsInstallerPath = "C:\Program Files\Microsoft Visual Studio\Installer\vs_installer.exe"
}

if (-not (Test-Path $vsInstallerPath)) {
    Write-Error "Visual Studio Installer not found. Please ensure Visual Studio 2022 is installed."
    exit 1
}

Write-Host "Installing Visual C++ Build Tools for Rust..."
Write-Host "This will add the 'Desktop development with C++' workload to Visual Studio 2022."
Write-Host ""

# Run the installer with the necessary workload
$args = @(
    "modify",
    "--installPath", "C:\Program Files\Microsoft Visual Studio\2022\Community",
    "--add", "Microsoft.VisualStudio.Workload.NativeDesktop",
    "--passive",
    "--norestart"
)

Write-Host "Running: $vsInstallerPath $($args -join ' ')"
Write-Host "This may take several minutes..."

& $vsInstallerPath @args

if ($LASTEXITCODE -eq 0) {
    Write-Host "Installation completed successfully!"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "1. Close and reopen any open PowerShell/Terminal windows"
    Write-Host "2. Run: npm run tauri:dev"
}
else {
    Write-Host "Installation may have failed. Exit code: $LASTEXITCODE"
    Write-Host "Please try manually:"
    Write-Host "1. Open Visual Studio Installer"
    Write-Host "2. Click Modify on Visual Studio 2022 Community"
    Write-Host "3. Add 'Desktop development with C++' workload"
}
