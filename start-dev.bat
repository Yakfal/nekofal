@echo off
REM ============================================================
REM PersonalMediaHub - Development Launcher
REM ============================================================

echo Starting PersonalMediaHub...
echo.

REM Navigate to project directory
cd /d "H:\MyownX"

REM Check if node_modules exists
if NOT exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    echo.
)

REM Run development server
echo Starting dev server on http://localhost:3000
echo Press Ctrl+C to stop the server
echo.

REM Start Electron with Vite dev server
npm start
