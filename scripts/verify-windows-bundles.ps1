#Requires -Version 5.1
<#
.SYNOPSIS
Verify Windows installers do not redistribute the Microsoft runtime.
.DESCRIPTION
Extracts NSIS payloads without installing them, rejects CRT/redistributable
payloads, and checks the NSIS verifier, download plugin, and license notice.
#>
[CmdletBinding()]
param(
    [string]$BundleDirectory,
    # Only NSIS is built (#979). Kept as a parameter because a workflow from
    # the base branch may still pass `-Formats nsis` to this script.
    [ValidateSet('nsis')][string[]]$Formats = @('nsis'),
    # Signed builds (releases and previews) sign the executable before packing
    # it, so the copy inside the installer must carry a signature. Local builds
    # do not sign, so the check is opt-in rather than always on.
    [switch]$RequireSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $PSBoundParameters.ContainsKey('BundleDirectory')) {
    $BundleDirectory = Join-Path $PSScriptRoot '../src-tauri/target/x86_64-pc-windows-msvc/release/bundle'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows installer verification requires Windows.'
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('dragonfruit-bundle-check-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    foreach ($format in $Formats) {
        $installers = @(Get-ChildItem -LiteralPath (Join-Path $BundleDirectory $format) -Filter '*-setup.exe' -File)
        if ($installers.Count -eq 0) { throw "No $format installer found in $BundleDirectory" }
        foreach ($installer in $installers) {
            $destination = Join-Path $work ([Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $destination | Out-Null
            & 7z.exe x $installer.FullName "-o$destination" -y
            if ($LASTEXITCODE -ne 0) { throw "Could not unpack NSIS installer: $($installer.FullName)" }
            $files = @(Get-ChildItem -LiteralPath $destination -Recurse -File)
            $forbidden = @($files | Where-Object {
                $_.Name -match '^(msvcp\d+.*|vcruntime\d+.*|concrt\d+.*|vcamp\d+.*|vccorlib\d+.*|vcomp\d+.*)\.dll$' -or
                $_.Name -match '^(VC_redist.*\.exe|vc_runtime.*\.msi)$'
            })
            if ($forbidden.Count -gt 0) {
                throw "Microsoft runtime payloads must not ship in $($installer.Name): $($forbidden.Name -join ', ')"
            }
            $executables = @($files | Where-Object Name -eq 'dragonfruit-desktop.exe')
            if ($executables.Count -ne 1) { throw "Expected one DragonFruit executable in $($installer.Name)." }
            if ($RequireSignature) {
                $signature = Get-AuthenticodeSignature -LiteralPath $executables[0].FullName
                if (-not $signature.SignerCertificate) {
                    throw "The executable inside $($installer.Name) is not signed."
                }
                if ($signature.Status -eq 'HashMismatch') {
                    throw "The executable inside $($installer.Name) has a signature that does not match its contents."
                }
                if (-not $signature.TimeStamperCertificate) {
                    throw "The executable inside $($installer.Name) is signed but not timestamped."
                }
                Write-Host "[windows-runtime] $($installer.Name): installed executable signed, status=$($signature.Status)"
            }
            foreach ($name in @('INetC.dll', 'verify-windows-runtime.ps1')) {
                $matches = @($files | Where-Object Name -ieq $name)
                if ($matches.Count -ne 1) { throw "$($installer.Name) must include one prerequisite helper $name." }
            }
            $notice = Join-Path $executables[0].DirectoryName 'licenses/InetC.txt'
            $sourceNotice = Join-Path $PSScriptRoot 'inetc-license.txt'
            if (-not (Test-Path -LiteralPath $notice) -or
                (Get-FileHash -LiteralPath $notice).Hash -ne (Get-FileHash -LiteralPath $sourceNotice).Hash) {
                throw "$($installer.Name) is missing the unmodified InetC license notice."
            }
            Write-Host "[windows-runtime] $($installer.Name): prerequisite-only payload verified; no Microsoft CRT or redistributable bundled."
        }
    }
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
