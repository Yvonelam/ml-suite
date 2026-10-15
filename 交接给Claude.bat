@echo off
chcp 65001 >nul
title ML Suite - Handoff to Claude
cd /d "%~dp0"
node handoff.js %*
echo.
pause
