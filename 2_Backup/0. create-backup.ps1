# Backup Script for STL Slicer / AutoSupport
# This script creates a versioned backup of the project, excluding node_modules and backup folders.

# --- Configuration ---
$backupRootPath = Join-Path $PSScriptRoot "Backups"
# The project source directory is the parent of the script's location (e.g., ../ from '2. Backup')
$projectSourcePath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# --- 1. Determine the next version number ---
Write-Host "Checking for existing backups in '$backupRootPath'..." -ForegroundColor Cyan

# Ensure the backup root directory exists
if (-not (Test-Path -Path $backupRootPath)) {
    Write-Host "Backup root folder not found. Creating it now: '$backupRootPath'" -ForegroundColor Yellow
    New-Item -Path $backupRootPath -ItemType Directory | Out-Null
}

# Get all directories starting with 'v' followed by digits
$existingVersions = Get-ChildItem -Path $backupRootPath -Directory | Where-Object { $_.Name -match '^v\d+$' }

$latestVersion = 0
if ($existingVersions) {
    # Extract the number from each version folder name and find the maximum
    $latestVersion = $existingVersions | ForEach-Object { [int]($_.Name -replace 'v', '') } | Measure-Object -Maximum | ForEach-Object { $_.Maximum }
    Write-Host "Latest version found: v$latestVersion" -ForegroundColor Green
} else {
    Write-Host "No existing backups found. Starting with v1." -ForegroundColor Yellow
}

$newVersionNumber = $latestVersion + 1
$newVersionFolderName = "v$newVersionNumber"
$newBackupPath = Join-Path -Path $backupRootPath -ChildPath $newVersionFolderName

Write-Host "Creating new backup folder: '$newBackupPath'" -ForegroundColor Cyan
New-Item -Path $newBackupPath -ItemType Directory -Force | Out-Null

# --- 2. Copy project files using robocopy ---
Write-Host "Starting backup from '$projectSourcePath'..." -ForegroundColor Cyan
Write-Host "Excluding 'node_modules' and backup subdirectories."

$robocopyArgs = @(
    $projectSourcePath,
    $newBackupPath,
    "/E",          # Copy subdirectories, including empty ones.
    "/XD",         # Exclude Directories.
    "node_modules", # Exclude any directory with this name.
    (Join-Path $projectSourcePath "2. Backup\Backups"), # Exclude the Backups subdirectory.
    "/NFL",        # No File List - don't log file names.
    "/NDL",        # No Directory List - don't log directory names.
    "/NJH",        # No Job Header.
    "/NJS",        # No Job Summary.
    "/R:1",        # Retry 1 time on failed copies.
    "/W:1"         # Wait 1 second between retries.
)

robocopy @robocopyArgs

# --- 3. Final Confirmation ---
if ($LASTEXITCODE -lt 8) { # Robocopy returns codes < 8 for success (even if no files were copied)
    Write-Host "-----------------------------------------------------" -ForegroundColor Green
    Write-Host "Backup to '$newVersionFolderName' completed successfully!" -ForegroundColor Green
    Write-Host "-----------------------------------------------------" -ForegroundColor Green
} else {
    Write-Host "-----------------------------------------------------" -ForegroundColor Red
    Write-Host "ERROR: Robocopy encountered an error. Exit code: $LASTEXITCODE" -ForegroundColor Red
    Write-Host "Please check the output above for details." -ForegroundColor Red
    Write-Host "-----------------------------------------------------" -ForegroundColor Red
}

