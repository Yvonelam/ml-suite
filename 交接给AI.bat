@echo off
chcp 65001 >nul
title ML Suite - Handoff to AI
cd /d "%~dp0"
node handoff.js %*
echo.
pause
