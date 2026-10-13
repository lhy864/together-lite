@echo off
setlocal
cd /d "%~dp0"
set "TOGETHER_DATA_DIR=%~dp0local-data"
start "" "%~dp0release\Together Lite 0.2.1.exe"
exit /b
