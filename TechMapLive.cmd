@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-portable.ps1"
set "TECHMAP_EXIT=%ERRORLEVEL%"
if not "%TECHMAP_EXIT%"=="0" pause
exit /b %TECHMAP_EXIT%
