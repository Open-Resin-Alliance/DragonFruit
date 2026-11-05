#Requires -Version 5.1
<#
.SYNOPSIS
Signs one Windows binary with Azure Artifact Signing.

.DESCRIPTION
Tauri's `bundle.windows.signCommand` invokes this once per binary it produces:
the application executable, sidecars and plugin DLLs, and the NSIS and MSI
installers. Signing therefore happens before the updater artifacts are
generated, so the `.exe.sig` Tauri writes covers the signed bytes.

The workflow authenticates with OpenID Connect through `azure/login`, which
leaves an Azure CLI login behind. `Invoke-ArtifactSigning` uses
`DefaultAzureCredential`; the credential types that cannot work on a GitHub
runner are excluded so it fails fast instead of probing each one, leaving
`AzureCliCredential` as the only path. No client secret is involved.

The endpoint, account and certificate profile come from the environment
(`AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`,
`AZURE_SIGNING_CERTIFICATE_PROFILE`) because they differ per Azure
deployment and must not be baked into the checked-in Tauri config.

.PARAMETER Path
The file to sign. Tauri passes it as the single positional argument.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$required = @(
    'AZURE_SIGNING_ENDPOINT',
    'AZURE_SIGNING_ACCOUNT',
    'AZURE_SIGNING_CERTIFICATE_PROFILE'
)
foreach ($name in $required) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "$name is not set. Windows release builds sign with Azure Artifact Signing; see docs/dev/releases.md."
    }
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Cannot sign '$Path': no such file."
}

Import-Module ArtifactSigning -ErrorAction Stop

Invoke-ArtifactSigning `
    -Endpoint $env:AZURE_SIGNING_ENDPOINT `
    -CodeSigningAccountName $env:AZURE_SIGNING_ACCOUNT `
    -CertificateProfileName $env:AZURE_SIGNING_CERTIFICATE_PROFILE `
    -Files $Path `
    -FileDigest SHA256 `
    -TimestampRfc3161 'http://timestamp.acs.microsoft.com' `
    -TimestampDigest SHA256 `
    -Description 'DragonFruit' `
    -ExcludeEnvironmentCredential `
    -ExcludeWorkloadIdentityCredential `
    -ExcludeManagedIdentityCredential `
    -ExcludeSharedTokenCacheCredential `
    -ExcludeVisualStudioCredential `
    -ExcludeVisualStudioCodeCredential `
    -ExcludeAzurePowerShellCredential `
    -ExcludeAzureDeveloperCliCredential `
    -ExcludeInteractiveBrowserCredential
