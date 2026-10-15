@echo off
chcp 65001 >nul
title ML Suite 公网服务
cd /d "%~dp0"
echo ============================================================
echo    ML Suite - 美客多运营工作台（公网模式）
echo ============================================================
echo   本窗口会同时启动：本地服务 + Cloudflare 隧道
echo   启动后请留意窗口里打印的公网地址
echo   关闭本窗口 = 服务下线
echo ============================================================
echo.
if not exist "tools\cloudflared.exe" (
  echo [提示] 未找到隧道程序，正在自动下载...
  node setup-tunnel.js
  echo.
)
node start-public.js
echo.
echo 服务已停止。
pause
