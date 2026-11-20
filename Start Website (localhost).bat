@echo off
rem ============================================================
rem  Barangay Kaligayahan Health Center - start the secure server
rem  Double-click this file. It starts the server and opens
rem  http://localhost:8123 in your browser.
rem  Keep the black window open while you use the site.
rem  Close the window (or press Ctrl+C) to stop the server.
rem ============================================================
setlocal
set "PORT=8123"
set "URL=http://localhost:%PORT%"
set "ROOT=%~dp0"
set "HOME_DIR=%LOCALAPPDATA%\KaligayahanHealthCenter"
set "VENV=%HOME_DIR%\venv"
set "PYTHONDONTWRITEBYTECODE=1"
title Kaligayahan Health Center - secure server

rem Already running? Then just open the browser.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo The website is already running at %URL%
  start "" "%URL%"
  timeout /t 3 >nul
  exit /b 0
)

rem Find Python ("py" launcher first, then "python").
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (
  echo.
  echo  Python was not found on this computer.
  echo  Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^),
  echo  or open "Kaligayahan Health Center.html" instead - the offline demo works without a server.
  echo.
  pause
  exit /b 1
)

rem First start (or after an update): set up the server's own Python packages.
if not exist "%VENV%\Scripts\python.exe" (
  echo.
  echo  First start: setting up the secure server. This needs internet once and takes about a minute...
  %PY% -m venv "%VENV%" || goto :setupfail
)
fc /b "%ROOT%backend\requirements.txt" "%VENV%\installed-requirements.txt" >nul 2>nul
if errorlevel 1 (
  "%VENV%\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r "%ROOT%backend\requirements.txt" || goto :setupfail
  copy /y "%ROOT%backend\requirements.txt" "%VENV%\installed-requirements.txt" >nul
)

rem Open the browser after the server has had a moment to start.
if not defined BKHC_NO_BROWSER start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" "%URL%""
"%VENV%\Scripts\python.exe" "%ROOT%backend\run.py"
echo.
echo  The server stopped.
pause
exit /b 0

:setupfail
echo.
echo  Setup failed. Check the internet connection and try again.
echo  (Delete the folder "%VENV%" to start the setup over.)
pause
exit /b 1
