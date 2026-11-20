@echo off
rem Read-only check of this computer's security settings (it changes nothing).
title Server PC security check
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\tools\check_server_pc.ps1"
pause
