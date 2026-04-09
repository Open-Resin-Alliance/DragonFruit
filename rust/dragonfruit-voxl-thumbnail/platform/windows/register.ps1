# Register the VOXL thumbnail provider on Windows.
# Run elevated (Admin) for HKCR, or without elevation for per-user (HKCU).
#
# Usage:
#   .\register.ps1 [-DllPath <path>] [-PerUser]

param(
    [string]$DllPath,
    [switch]$PerUser
)

$ErrorActionPreference = 'Stop'

$CLSID = '{8B4F2E3A-7C1D-4A5E-B9F0-6D2E8C3A1B5F}'
$ThumbnailHandlerCATID = '{E357FCCD-A995-4576-B01F-234630154E96}'

if (-not $DllPath) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $DllPath = Join-Path (Split-Path -Parent (Split-Path -Parent $ScriptDir)) `
        "target\release\dragonfruit_voxl_thumbnail_com.dll"
}

if (-not (Test-Path $DllPath)) {
    Write-Error "DLL not found: $DllPath`nBuild first: cargo build --release -p dragonfruit-voxl-thumbnail-com"
    exit 1
}

$DllPath = (Resolve-Path $DllPath).Path

$Root = if ($PerUser) { 'HKCU:\Software\Classes' } else { 'HKCR:' }

# Ensure HKCR drive exists
if (-not $PerUser -and -not (Test-Path 'HKCR:\')) {
    New-PSDrive -Name HKCR -PSProvider Registry -Root HKEY_CLASSES_ROOT -Scope Script | Out-Null
}

Write-Host "Registering VOXL thumbnail handler..."
Write-Host "  DLL:  $DllPath"
Write-Host "  Root: $Root"

# CLSID registration
$ClsidKey = "$Root\CLSID\$CLSID"
New-Item -Path $ClsidKey -Force | Out-Null
Set-ItemProperty -Path $ClsidKey -Name '(Default)' -Value 'DragonFruit VOXL Thumbnail Provider'

$InProcKey = "$ClsidKey\InProcServer32"
New-Item -Path $InProcKey -Force | Out-Null
Set-ItemProperty -Path $InProcKey -Name '(Default)' -Value $DllPath
Set-ItemProperty -Path $InProcKey -Name 'ThreadingModel' -Value 'Apartment'

# .voxl file type
New-Item -Path "$Root\.voxl" -Force | Out-Null
Set-ItemProperty -Path "$Root\.voxl" -Name '(Default)' -Value 'VoxlFile'

New-Item -Path "$Root\VoxlFile" -Force | Out-Null
Set-ItemProperty -Path "$Root\VoxlFile" -Name '(Default)' -Value 'DragonFruit VOXL Scene'

# Thumbnail handler association
$ShellExKey = "$Root\VoxlFile\shellex\$ThumbnailHandlerCATID"
New-Item -Path $ShellExKey -Force | Out-Null
Set-ItemProperty -Path $ShellExKey -Name '(Default)' -Value $CLSID

Write-Host "`nRegistration complete."
Write-Host "You may need to restart Explorer or clear the thumbnail cache:"
Write-Host "  ie4uinit.exe -show"
Write-Host "  del /f /q `"$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db`""
