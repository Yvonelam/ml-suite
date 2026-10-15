@echo off
chcp 65001 >nul
title ML Suite 停止公网服务
cd /d "%~dp0"
echo ============================================================
echo    ML Suite - 停止公网服务
echo ============================================================
echo   将结束：本地服务 + Cloudflare 隧道
echo ============================================================
echo.
node stop-public.js
echo.
pause
