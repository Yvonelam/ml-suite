@echo off
chcp 65001 >nul
title ML Suite 开机自启
cd /d "%~dp0"
echo ============================================================
echo    ML Suite - 开启开机自启
echo ============================================================
echo   在「启动」文件夹放一个入口：下次登录 Windows 自动拉起服务。
echo   并立刻启动看门狗（每分钟检查一次，服务掉了一分钟内自动拉回）。
echo ============================================================
echo.

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "ENTRY=%STARTUP%\ML-Suite-Autostart.vbs"

copy /y "%~dp0autostart.vbs" "%ENTRY%" >nul
if errorlevel 1 (
  echo [失败] 无法写入启动文件夹：%STARTUP%
) else (
  echo [成功] 已加入启动项：ML-Suite-Autostart.vbs
)

echo.
echo 立刻启动看门狗（隐藏窗口）...
start "" wscript.exe "%~dp0autostart.vbs"
echo.
echo 完成。以后开机登录就会自动运行。
echo 想关掉：双击「开机自启-关闭.bat」。
echo 想临时停服务：双击「停止公网服务.bat」（看门狗会尊重它，不会自己拉回来）。
echo.
pause
