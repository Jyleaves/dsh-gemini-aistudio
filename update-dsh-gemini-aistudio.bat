@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-dsh-gemini-aistudio.ps1" %*
if errorlevel 1 pause
