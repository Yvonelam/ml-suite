@echo off
chcp 65001 >nul
title ML Suite - Restyle Handoff
cd /d "%~dp0"
node handoff.js style %*
echo.
node shots.js
echo.
pause
