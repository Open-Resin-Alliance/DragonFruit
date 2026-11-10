#Requires -Version 5.1
<#
.SYNOPSIS
Signs one Windows binary with Azure Artifact Signing.

.DESCRIPTION
Tauri's `bundle.windows.signCommand` invokes this once per binary it produces:
the application executable, sidecars and plugin DLLs, and the NSIS
installer. Signing therefore happens before the updater artifacts are
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

# Tauri runs this through output_ok, which turns any non-zero exit into
# "failed to run pwsh" and throws the stderr away. Write what happened to a
# file the workflow can print, so a failure is diagnosable at all. An empty log
# means the script never started, which points at the spawn rather than here.
$logPath = if ([string]::IsNullOrWhiteSpace($env:DF_SIGN_LOG)) {
    Join-Path ([IO.Path]::GetTempPath()) 'dragonfruit-sign.log'
} else {
    $env:DF_SIGN_LOG
}

function Write-SignLog([string]$Message) {
    try {
        Add-Content -LiteralPath $logPath -Value $Message -Encoding utf8
    } catch {
        Write-Warning "could not write $logPath"
    }
}

Write-SignLog "$(Get-Date -Format o) signing $Path"

# azure/login exchanges the workflow's OIDC token once, and that assertion lives
# about five minutes. A release build reaches its first signing call eight
# minutes in, so the CLI can no longer refresh and the signer fails with
# AADSTS700024. Mint a fresh assertion here instead, at most every four minutes
# so a run that signs a dozen files does not log in a dozen times.
function Connect-SigningIdentity {
    $url = $env:ACTIONS_ID_TOKEN_REQUEST_URL
    $bearer = $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if ([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($bearer)) {
        Write-SignLog 'no OIDC request context; using the existing az login'
        return
    }

    $marker = Join-Path ([IO.Path]::GetTempPath()) 'dragonfruit-sign-login.stamp'
    if ((Test-Path -LiteralPath $marker) -and
        ((Get-Date) - (Get-Item -LiteralPath $marker).LastWriteTime).TotalMinutes -lt 4) {
        return
    }

    $oidc = Invoke-RestMethod -Uri "$url&audience=api://AzureADTokenExchange" `
        -Headers @{ Authorization = "Bearer $bearer" }
    & az login --service-principal -u $env:AZURE_CLIENT_ID --tenant $env:AZURE_TENANT_ID `
        --federated-token $oidc.value --output none
    if ($LASTEXITCODE -ne 0) {
        throw 'az login with a fresh federated token failed'
    }
    Set-Content -LiteralPath $marker -Value (Get-Date -Format o)
    Write-SignLog 'refreshed the az login with a fresh federated token'
}

try {
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

    Connect-SigningIdentity
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

    Write-SignLog "$(Get-Date -Format o) signed $Path"
} catch {
    Write-SignLog (@(
        "$(Get-Date -Format o) FAILED $Path"
        ($_ | Out-String)
        $_.ScriptStackTrace
    ) -join "`n")
    throw
}
