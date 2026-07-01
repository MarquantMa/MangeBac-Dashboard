@echo off
title ManageBac Student Dashboard Launcher
echo ===================================================
echo   Starting ManageBac Student Dashboard Backend...
echo ===================================================
echo.
echo Launching local server on port 8082...
start /b python server.py
timeout /t 2 >nul
echo Opening dashboard in your default browser...
start http://localhost:8082
echo.
echo To close the dashboard, close this command prompt window.
pause
