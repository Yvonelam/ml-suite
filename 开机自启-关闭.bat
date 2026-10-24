@echo off
chcp 65001 >nul
title ML Suite 关闭开机自启
cd /d "%~dp0"
echo ============================================================
echo    ML Suite - 关闭开机自启
echo ============================================================
echo   移除开机启动项，并结束看门狗进程。
echo   注意：不会停止正在运行的服务（要停服务用「停止公网服务.bat」）。
echo ============================================================
echo.

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "ENTRY=%STARTUP%\ML-Suite-Autostart.vbs"

if exist "%ENTRY%" (
  del /q "%ENTRY%" >nul 2>&1
  if exist "%ENTRY%" (
    echo [失败] 删除启动项失败，可能被占用：%ENTRY%
  ) else (
    echo [成功] 已移除启动项：ML-Suite-Autostart.vbs
  )
) else (
  echo [跳过] 启动文件夹里没有 ML-Suite-Autostart.vbs（本来就没开）。
)

if exist "%~dp0.watchdog.pid" (
  for /f "usebackq delims=" %%p in ("%~dp0.watchdog.pid") do (
    taskkill /f /pid %%p >nul 2>&1
    echo [成功] 已结束看门狗进程 PID %%p
  )
  del /q "%~dp0.watchdog.pid" >nul 2>&1
) else (
  echo [跳过] 没有找到 .watchdog.pid，看门狗可能没在跑。
)

echo.
echo [3/3] 移除计划任务 ML-Suite Watchdog（每 10 分钟巡检看门狗的那一条）
schtasks /end /tn "ML-Suite Watchdog" >nul 2>&1
schtasks /delete /tn "ML-Suite Watchdog" /f >nul 2>&1
if errorlevel 1 (
  echo [跳过] 没有这个计划任务，或已移除。
) else (
  echo [成功] 已移除计划任务 ML-Suite Watchdog
)

echo.
pause
