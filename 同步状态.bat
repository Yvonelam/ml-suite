@echo off
chcp 65001 >nul
cd /d "%~dp0"

title ML Suite - 同步状态

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 找不到 node 命令，请在装有 Node.js 的环境下运行。
  echo.
  pause
  exit /b 1
)

node "%~dp0sync-status.js"

echo.
pause
