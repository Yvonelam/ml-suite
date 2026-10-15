@echo off
chcp 65001 >nul
title ML Suite 配置固定域名
cd /d "%~dp0"
echo ============================================================
echo    ML Suite - 配置固定公网地址
echo ============================================================
echo    把「每次重启都变的临时地址」换成「永久固定域名」
echo.
echo    需要先准备：Cloudflare 账号 + 一个已接入 Cloudflare 的域名
echo ============================================================
echo.
if not exist "tools\cloudflared.exe" (
  echo [提示] 未找到隧道程序，正在自动下载...
  node setup-tunnel.js
  echo.
)
node setup-named-tunnel.js
echo.
pause
