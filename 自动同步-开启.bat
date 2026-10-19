@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   ML Suite - 开启自动同步到 GitHub
echo ============================================================
echo.

rem 已经在跑就不重复启动（单实例锁本身也会挡，这里提前告知一下）
if exist ".autosync.pid" (
  set /p OLDPID=<.autosync.pid
  tasklist /FI "PID eq !OLDPID!" 2>nul | find "!OLDPID!" >nul
  if not errorlevel 1 (
    echo   [提示] 自动同步已经在运行（PID !OLDPID!），无需重复开启。
    echo   日志：同步日志.txt
    echo.
    pause
    exit /b 0
  )
)

if exist ".sync-pause" (
  del /q ".sync-pause"
  echo   [提示] 已清除 .sync-pause 暂停标记。
)

rem 清掉「主动关闭」标记，否则启动器以后不会再自动拉起它
if exist ".sync-off" (
  del /q ".sync-off"
  echo   [提示] 已清除 .sync-off 关闭标记。
)

echo   正在启动（最小化窗口，需要一直开着）...
start "ML-Suite 自动同步" /min node "%~dp0git-autosync.js"

echo.
echo   启动后行为：
echo     - 每 20 秒检查一次本地改动；停手 25 秒就提交并推送到 GitHub 的 main
echo     - 推送失败自动重试（5 秒起，最长 5 分钟一次，永不放弃）
echo     - 远端有新提交时自动 rebase 后再推
echo     - 空闲时每 2 分钟拉一次远端，别人（远端 AI / 别的电脑）推的改动自动合入
echo.
echo   查看状态：双击「同步状态.bat」（一眼看出有没有没推上去的提交）
echo   临时暂停：在本目录新建一个 .sync-pause 文件
echo   停止同步：双击「自动同步-关闭.bat」
echo   查看日志：同步日志.txt
echo.

pause
