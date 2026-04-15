# Unregister the VOXL thumbnail provider on Windows.
#
# Usage:
#   .\unregister.ps1 [-DllPath <path>] [-PerUser]

param(
    [string]$DllPath,
    [switch]$PerUser
)

$ErrorActionPreference = 'Continue'

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

    return $null
}

if ($PerUser) {
    Write-Host "-PerUser is no longer needed; unregistration is per-user (HKCU)."
}

if (-not $DllPath) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $DllPath = Resolve-DllPath -ScriptDir $ScriptDir
}

if ($DllPath -and (Test-Path $DllPath)) {
    $DllPath = (Resolve-Path $DllPath).Path
    $RegSvr32 = Join-Path $env:WINDIR 'System32\regsvr32.exe'
    Write-Host "Unregistering VOXL thumbnail handler via regsvr32..."
    Write-Host "  DLL: $DllPath"
    & $RegSvr32 /s /u $DllPath
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "regsvr32 /u exited with code $LASTEXITCODE"
    }
} else {
    Write-Warning "DLL path not found; skipping regsvr32 /u and cleaning registry entries directly."
}

# Cleanup both current and legacy registration paths.
Remove-Item -Path "HKCU:\Software\Classes\CLSID\$CLSID" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Classes\.voxl\ShellEx\$ThumbnailHandlerCATID" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Classes\VoxlFile\shellex\$ThumbnailHandlerCATID" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Classes\SystemFileAssociations\.voxl\ShellEx\$ThumbnailHandlerCATID" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCR:\CLSID\$CLSID" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCR:\VoxlFile\shellex\$ThumbnailHandlerCATID" -Recurse -Force -ErrorAction SilentlyContinue

$approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved'
Remove-ItemProperty -Path $approvedKey -Name $CLSID -ErrorAction SilentlyContinue

Write-Host "Done. Restart Explorer to see the change."
