@echo off
chcp 65001 >nul
title ML Suite - Version Manager
cd /d "%~dp0"
node version.js %*
echo.
pause
