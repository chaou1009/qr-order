@echo off
title QR Ordering - Restart
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\restart.ps1"
