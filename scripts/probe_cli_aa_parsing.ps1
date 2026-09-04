# PowerShell script to verify that the CLI does not currently support custom AA/blur parameters

Write-Output "Building dragonfruit-cli..."
cd "x:/Antigravity/DragonFruit-ORA/DragonFruit/rust/dragonfruit-cli"
cargo build

if ($LASTEXITCODE -ne 0) {
    Write-Error "Cargo build failed"
    exit 1
}

Write-Output "Executing dragonfruit-cli with advanced custom AA parameters..."
$cliPath = "target/debug/dragonfruit-cli.exe"

# We pass advanced flags that are expected in the future but currently missing:
# --blur-brush-radius-px 4
# --z-blur-radius-layers 3
# --blur-brush-sigma-x 1.5
# --z-blur-sigma 1.2
# --aa-on-supports true

try {
    $output = & $cliPath slice run --help 2>&1
    Write-Output "Checking slice run --help output for missing options:"
    
    $hasBlurRadius = $output -like "*--blur-brush-radius-px*"
    $hasZBlurLayers = $output -like "*--z-blur-radius-layers*"
    
    if (-not $hasBlurRadius) {
        Write-Output "[FAIL] Slicer CLI is missing custom parameter flags: --blur-brush-radius-px"
    }
    if (-not $hasZBlurLayers) {
        Write-Output "[FAIL] Slicer CLI is missing custom parameter flags: --z-blur-radius-layers"
    }
    
    # Intentionally call the CLI with the advanced flags to verify it throws a Clap command-line error
    & $cliPath slice run dummy.stl -o output.zip --anti-aliasing-mode Blur --blur-brush-radius-px 4 2>&1
} catch {
    Write-Output "Execution caught error: $_"
}
