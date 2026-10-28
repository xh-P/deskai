@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\gsv_v5\launch.ps1" -Action status
pause
