@echo off
title QR Ordering Demo - keep this window open
cd /d "%~dp0"
set RESTAURANT_NAME=Restoran Demo
set STAFF_PIN=8888
set DEMO=1
set PORT=3000
echo.
echo  QR Ordering Demo is starting...
echo  Keep this window open. Close it to stop the demo.
echo  If Windows Firewall asks, click "Allow" so phones on the same Wi-Fi can connect.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000/demo"
runtime\node.exe server.js
echo.
echo  The server stopped. If it says the port is in use, the demo may already be running.
pause
