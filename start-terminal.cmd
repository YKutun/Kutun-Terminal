@echo off
setlocal EnableDelayedExpansion

:: ============================================================
:: start-terminal.cmd — Kutun Terminal Local Server Launcher
:: Serves the project at http://127.0.0.1:8000
::
:: Safety rules:
::   - Does NOT run any data collectors (macro_engine.py etc.)
::   - Does NOT advise killing arbitrary processes
::   - Does NOT silently pick an alternate port
::   - Opens the browser only after confirming the server is ready
::   - Uses exactly one server process in the foreground
:: ============================================================

:: Change to the directory containing this script
cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════╗
echo  ║      KUTUN TERMINAL — LAUNCHER       ║
echo  ╚══════════════════════════════════════╝
echo.

:: ── 1. Check for Python launcher ──────────────────────────
where py >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python launcher "py" not found.
    echo.
    echo  Please install Python 3.x from https://www.python.org/downloads/
    echo  Make sure to tick "Add Python to PATH" during installation.
    echo  After installation, close this window and try again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('py --version 2^>^&1') do set PYVER=%%v
echo  Python found: !PYVER!

:: ── 2. Check whether port 8000 is already in use ──────────
set PORT_IN_USE=0
for /f "tokens=1-5" %%a in ('netstat -ano 2^>nul ^| findstr /R "[:.]8000 "') do (
    if /I "%%d"=="LISTENING" set PORT_IN_USE=1
    if /I "%%c"=="LISTENING" set PORT_IN_USE=1
)

if "!PORT_IN_USE!"=="1" (
    echo.
    echo  [ERROR] Port 8000 is already in use.
    echo.
    echo  The existing server may already be running — open your browser
    echo  and visit http://127.0.0.1:8000 to check.
    echo.
    echo  Close the window of the existing server to free the port.
    echo.
    pause
    exit /b 1
)

:: ── 3. Start readiness poll and browser launcher in background
:: This loops up to 15 times testing the port. When ready, it opens the browser.
start /b cmd /c "for /l %%i in (1,1,15) do ( py -c \"import socket,sys; s=socket.socket(); s.settimeout(1); r=s.connect_ex(('127.0.0.1',8000)); s.close(); sys.exit(0 if r==0 else 1)\" 2>nul && ( start \"\" http://127.0.0.1:8000 & exit ) || timeout /t 1 /nobreak >nul ) & echo [WARNING] Server did not respond within 15 seconds. Browser was not opened."

:: ── 4. Start the server in the foreground ─────────────────
echo.
echo  Starting HTTP server on http://127.0.0.1:8000 ...
echo.
echo  ─────────────────────────────────────────────────
echo  The server is running.  Keep this window open.
echo  Press Ctrl+C to stop the server when you are done.
echo  ─────────────────────────────────────────────────
echo.

py -m http.server 8000 --bind 127.0.0.1

endlocal
