@echo off
rem ============================================================
rem  Barangay Kaligayahan Health Center - connect the database to Supabase
rem  Double-click: connect (or reconnect) and move the records to Supabase.
rem  Drag Supabase's SSL certificate (.crt) onto this file: the server then
rem  also checks it is really talking to Supabase.
rem  The site is stopped while this runs and started again afterwards.
rem  See docs\SUPABASE.md.
rem ============================================================
setlocal
set "ROOT=%~dp0"
set "PORT=8123"
set "HOME_DIR=%LOCALAPPDATA%\KaligayahanHealthCenter"
set "VENV=%HOME_DIR%\venv"
set "PYTHONDONTWRITEBYTECODE=1"
title Kaligayahan Health Center - connect to Supabase

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (
  echo.
  echo  Python was not found on this computer. Install it from https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

if not exist "%VENV%\Scripts\python.exe" (
  echo.
  echo  Setting up the server's Python packages. This needs internet and takes about a minute...
  %PY% -m venv "%VENV%" || goto :setupfail
)
fc /b "%ROOT%backend\requirements.txt" "%VENV%\installed-requirements.txt" >nul 2>nul
if errorlevel 1 (
  "%VENV%\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r "%ROOT%backend\requirements.txt" || goto :setupfail
  copy /y "%ROOT%backend\requirements.txt" "%VENV%\installed-requirements.txt" >nul
)

rem The site must be stopped while the connection is changed
set "WAS_RUNNING="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%PORT% .*LISTENING" /c:"0.0.0.0:%PORT% .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
  set "WAS_RUNNING=1"
)
if defined WAS_RUNNING (
  echo.
  echo  The website was stopped while this runs. It starts again afterwards.
  ping -n 3 127.0.0.1 >nul
)

"%VENV%\Scripts\python.exe" "%ROOT%backend\tools\connect_supabase.py" %*
echo.
if defined WAS_RUNNING (
  echo  Press any key to start the website again...
  pause >nul
  start "" "%ROOT%Start Website (localhost).bat"
) else (
  pause
)
exit /b 0

:setupfail
echo.
echo  Setup failed. Check the internet connection and try again.
pause
exit /b 1
