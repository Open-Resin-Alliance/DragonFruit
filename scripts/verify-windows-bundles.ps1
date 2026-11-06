#Requires -Version 5.1
<#
.SYNOPSIS
Verify Windows installers do not redistribute the Microsoft runtime.
.DESCRIPTION
Extracts NSIS/MSI payloads without installing them, rejects CRT/redistributable
payloads, and checks the NSIS verifier, download plugin, and license notice.
#>
[CmdletBinding()]
param(
    [string]$BundleDirectory,
    [ValidateSet('nsis', 'msi')][string[]]$Formats = @('nsis', 'msi'),
    # Release builds sign the executable before packing it, so the copy inside
    # the installer must carry a signature. Preview builds do not sign, so the
    # check is opt-in rather than always on.
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
        $pattern = if ($format -eq 'nsis') { '*-setup.exe' } else { '*.msi' }
        $installers = @(Get-ChildItem -LiteralPath (Join-Path $BundleDirectory $format) -Filter $pattern -File)
        if ($installers.Count -eq 0) { throw "No $format installer found in $BundleDirectory" }
        foreach ($installer in $installers) {
            $destination = Join-Path $work ([Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $destination | Out-Null
            if ($format -eq 'nsis') {
                & 7z.exe x $installer.FullName "-o$destination" -y
                if ($LASTEXITCODE -ne 0) { throw "Could not unpack NSIS installer: $($installer.FullName)" }
            } else {
                # Administrative extraction only; never /i or a nested MSI install.
                $log = Join-Path $work 'msi-extraction.log'
                $process = Start-Process msiexec.exe -ArgumentList "/a `"$($installer.FullName)`" /qn TARGETDIR=`"$destination`" /L*v `"$log`"" -Wait -PassThru
                if ($process.ExitCode -ne 0) {
                    Get-Content -LiteralPath $log -ErrorAction SilentlyContinue | Write-Host
                    throw "Could not unpack MSI installer (exit $($process.ExitCode)): $($installer.FullName)"
                }
            }
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
            if ($format -eq 'nsis') {
                foreach ($name in @('INetC.dll', 'verify-windows-runtime.ps1')) {
                    $matches = @($files | Where-Object Name -ieq $name)
                    if ($matches.Count -ne 1) { throw "$($installer.Name) must include one prerequisite helper $name." }
                }
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
