# Register the VOXL thumbnail provider on Windows.
#
# Usage:
#   .\register.ps1 [-DllPath <path>] [-PerUser]
#
# Notes:
#   - Registration is per-user (HKCU) inside DllRegisterServer.
#   - -PerUser is kept only for backwards compatibility.

param(
    [string]$DllPath,
    [switch]$PerUser
)

$ErrorActionPreference = 'Stop'

$CLSID = '{8B4F2E3A-7C1D-4A5E-B9F0-6D2E8C3A1B5F}'
$ThumbnailHandlerCATID = '{E357FCCD-A995-4576-B01F-234630154E96}'

function Resolve-DllPath {
    param([string]$ScriptDir)

    $crateRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
    $candidates = @(
        (Join-Path $crateRoot 'windows-com\target\release\dragonfruit_voxl_thumbnail_com.dll'),
        (Join-Path $crateRoot ('windows-com\target\{0}\release\dragonfruit_voxl_thumbnail_com.dll' -f $env:TAURI_ENV_TARGET_TRIPLE)),
        (Join-Path $crateRoot 'target\release\dragonfruit_voxl_thumbnail_com.dll'),
        (Join-Path $crateRoot '..\..\src-tauri\windows-resources\dragonfruit_voxl_thumbnail_com.dll')
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    Write-Error (
        "DLL not found in expected locations:`n" +
        ($candidates | ForEach-Object { "  - $_" } | Out-String) +
        "`nBuild first from windows-com:`n" +
        "  cd rust\dragonfruit-voxl-thumbnail\windows-com`n" +
        "  cargo build --release"
    )
}

if ($PerUser) {
    Write-Host "-PerUser is no longer needed; registration is already per-user (HKCU)."
}

if (-not $DllPath) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $DllPath = Resolve-DllPath -ScriptDir $ScriptDir
}

if (-not (Test-Path $DllPath)) {
    Write-Error "DLL not found: $DllPath"
    exit 1
}

$DllPath = (Resolve-Path $DllPath).Path
$RegSvr32 = Join-Path $env:WINDIR 'System32\regsvr32.exe'

Write-Host "Registering VOXL thumbnail handler via regsvr32..."
Write-Host "  DLL:  $DllPath"

& $RegSvr32 /s $DllPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "regsvr32 failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

# Quick sanity checks
$inprocKey = "HKCU:\Software\Classes\CLSID\$CLSID\InProcServer32"
$shellExKey = "HKCU:\Software\Classes\.voxl\ShellEx\$ThumbnailHandlerCATID"
$approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved'

if (-not (Test-Path $inprocKey)) {
    Write-Warning "Missing registry key: $inprocKey"
}
if (-not (Test-Path $shellExKey)) {
    Write-Warning "Missing registry key: $shellExKey"
}
if (-not (Get-ItemProperty -Path $approvedKey -Name $CLSID -ErrorAction SilentlyContinue)) {
    Write-Warning "Missing approved shell extension entry at: $approvedKey"
}

Write-Host "`nRegistration complete."
Write-Host "If thumbnails still don't appear, refresh shell caches:"
Write-Host "  ie4uinit.exe -show"
Write-Host "  Remove-Item `"$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db`" -Force -ErrorAction SilentlyContinue"
Write-Host "Then restart Explorer (or sign out/in)."
