@echo off
rem Entry point for Tauri's bundle.windows.signCommand.
rem
rem The bundler spawns this by name and reports any failure as "failed to run
rem <command>" with the child's output discarded, so the batch file records what
rem it did to DF_SIGN_LOG before anything else can go wrong. An empty log means
rem the batch never started, which points at the spawn.
setlocal

>>"%DF_SIGN_LOG%" echo [shim] start cwd=%CD%
>>"%DF_SIGN_LOG%" echo [shim] args=%*
>>"%DF_SIGN_LOG%" echo [shim] script=%~dp0sign-windows.ps1

set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%PWSH%" set "PWSH=pwsh"
>>"%DF_SIGN_LOG%" echo [shim] pwsh=%PWSH%

"%PWSH%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0sign-windows.ps1" %* >>"%DF_SIGN_LOG%.out" 2>&1
set "RC=%ERRORLEVEL%"
>>"%DF_SIGN_LOG%" echo [shim] exit=%RC%
exit /b %RC%
