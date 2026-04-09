# Unregister the VOXL thumbnail provider on Windows.
#
# Usage:
#   .\unregister.ps1 [-PerUser]

param(
    [switch]$PerUser
)

$ErrorActionPreference = 'SilentlyContinue'

$CLSID = '{8B4F2E3A-7C1D-4A5E-B9F0-6D2E8C3A1B5F}'
$ThumbnailHandlerCATID = '{E357FCCD-A995-4576-B01F-234630154E96}'

$Root = if ($PerUser) { 'HKCU:\Software\Classes' } else { 'HKCR:' }

if (-not $PerUser -and -not (Test-Path 'HKCR:\')) {
    New-PSDrive -Name HKCR -PSProvider Registry -Root HKEY_CLASSES_ROOT -Scope Script | Out-Null
}

Write-Host "Removing VOXL thumbnail handler from $Root..."

Remove-Item -Path "$Root\CLSID\$CLSID" -Recurse -Force 2>$null
Remove-Item -Path "$Root\VoxlFile\shellex\$ThumbnailHandlerCATID" -Recurse -Force 2>$null

Write-Host "Done. Restart Explorer to see the change."
