@echo off
setlocal ENABLEEXTENSIONS
REM Launches lys_full_extract.py with drag-and-drop or a file picker

set "SCRIPT_DIR=%~dp0"
set "PYTHON=python"

REM If a file was dragged onto this .bat, use it. Otherwise, show a file picker.
if "%~1"=="" (
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $dlg=New-Object System.Windows.Forms.OpenFileDialog; $dlg.Filter='Lychee Scene (*.lys)|*.lys|All files (*.*)|*.*'; if($dlg.ShowDialog() -eq 'OK'){Write-Output $dlg.FileName}"`) do set "LYS_FILE=%%I"
) else (
  set "LYS_FILE=%~1"
)

if not defined LYS_FILE (
  echo No .lys file selected. Exiting.
  pause
  exit /b 1
)

REM Run the extractor (output folder will be auto-created next to the .lys)
"%PYTHON%" "%SCRIPT_DIR%lys_full_extract.py" "%LYS_FILE%"

set ERR=%ERRORLEVEL%
if %ERR% NEQ 0 (
  echo.
  echo The script returned error code %ERR%.
  echo If Python is not installed or not on PATH, install Python 3 and try again.
  pause
  exit /b %ERR%
)

echo.
echo Extraction complete.
pause
