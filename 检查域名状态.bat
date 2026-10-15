@echo off
chcp 65001 >nul
title ML Suite 域名接入进度自查
cd /d "%~dp0"
node check-domain.js
echo.
pause
