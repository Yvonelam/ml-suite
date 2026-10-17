@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   ML Suite - 关闭自动同步
echo ============================================================
echo.

rem 写下「主动关闭」标记：启动器和开机自启看到它就不会再把自动同步拉起来。
rem 想恢复：双击「自动同步-开启.bat」。
> ".sync-off" echo off
echo   [标记] 已写入 .sync-off（启动器/开机自启不会再自动拉起）

if not exist ".autosync.pid" (
  echo   [提示] 没有找到 .autosync.pid，自动同步可能本来就没在跑。
  echo.
  pause
  exit /b 0
)

set /p PID=<.autosync.pid
echo   正在结束自动同步进程（PID !PID!）...

tasklist /FI "PID eq !PID!" 2>nul | find "!PID!" >nul
if errorlevel 1 (
  echo   [提示] 该 PID 已经不在运行了，清理残留文件。
  del /q ".autosync.pid" 2>nul
  echo.
  pause
  exit /b 0
)

taskkill /F /PID !PID! >nul 2>nul
if errorlevel 1 (
  echo   [失败] 结束进程失败，请用任务管理器结束 node.exe。
) else (
  echo   [完成] 自动同步已停止。
  del /q ".autosync.pid" 2>nul
)

echo.
echo   注意：只是不再自动推送，本地代码不受影响。
echo   想临时暂停又不想关进程：在本目录新建 .sync-pause 文件。
echo.

pause
