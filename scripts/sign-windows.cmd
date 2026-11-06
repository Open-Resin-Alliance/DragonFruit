@echo off
rem Entry point for Tauri's bundle.windows.signCommand.
rem
rem The bundler spawns this by name, and `pwsh` is not on the PATH the Tauri
rem process sees even though a PowerShell step resolves it: the same process
rem spawns `powershell` from System32 without trouble, so the name lookup works
rem and the entry is simply missing. cmd.exe is always in System32, which is
rem searched before PATH, so going through it removes the dependency entirely.
setlocal
set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%PWSH%" set "PWSH=pwsh"
"%PWSH%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0sign-windows.ps1" %*
exit /b %ERRORLEVEL%
