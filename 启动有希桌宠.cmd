@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if not exist "%~dp0release\DeskAI2-Pet-Drag-20261030\DeskAI.exe" (
  echo Desktop pet package is missing: release\DeskAI2-Pet-Drag-20261030\DeskAI.exe
  pause
  exit /b 1
)
start "" "%~dp0release\DeskAI2-Pet-Drag-20261030\DeskAI.exe"
