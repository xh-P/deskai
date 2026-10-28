@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
"%~dp0.conda\gsv-v5\python.exe" -u "%~dp0scripts\gsv_v5\audition.py" %*
pause
