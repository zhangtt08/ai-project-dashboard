@echo off
title AI Project Commander
cd /d "%~dp0"

rem Prefer the native desktop app (own window + icon + tray). Falls back to the
rem browser launcher if the exe has not been built on this machine yet.
if exist "desktop\AIProjectCommander.exe" (
  start "" "desktop\AIProjectCommander.exe"
  exit /b 0
)

echo Desktop app not built yet - starting the browser version instead.
echo Rebuild it with: powershell -File desktop\build.ps1
echo.

if exist "data\server-url.txt" del /q "data\server-url.txt" >nul 2>&1
start "AI-Project-Commander-Server" /min cmd /c "node src\server\cli.js start"

set /a tries=0
:waiturl
if exist "data\server-url.txt" goto open
timeout /t 1 /nobreak >nul
set /a tries+=1
if %tries% lss 40 goto waiturl
echo Server did not start within 40 seconds. Check the server window for errors.
pause
exit /b 1

:open
set /p APPURL=<data\server-url.txt
echo   URL: %APPURL%
start "" "%APPURL%"
