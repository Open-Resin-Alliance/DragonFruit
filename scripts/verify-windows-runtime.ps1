#Requires -Version 5.1
# Verify the official latest-x64 download before NSIS executes it. Never installs anything.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][version]$MinimumVersion
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Authenticode verification requires Windows.'
}
if ($MinimumVersion.Major -ne 14 -or $MinimumVersion.Revision -lt 0) {
    throw 'A four-part VC14 minimum version is required.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
$signer = if ($null -ne $signature.SignerCertificate) {
    $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
} else { '<none>' }
if ($signature.Status -ne 'Valid' -or $signer -cne 'Microsoft Corporation') {
    throw "Expected a valid Microsoft installer signature (status=$($signature.Status), signer=$signer)."
}
$info = [Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path -LiteralPath $InstallerPath).ProviderPath)
$version = [version]('{0}.{1}.{2}.{3}' -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart, $info.FilePrivatePart)
if ($version.Major -ne 14 -or $version -lt $MinimumVersion) {
    throw "Microsoft runtime $version does not satisfy the required VC14 version $MinimumVersion."
}
Write-Host "Verified Microsoft signature and runtime $version (minimum $MinimumVersion)."
