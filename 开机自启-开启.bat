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
echo [3/3] 注册计划任务 ML-Suite Watchdog（看门狗的看门狗）
set "NODE_EXE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE set "NODE_EXE=node"
rem 必须用 PowerShell 注册，两个原因：
rem   1) schtasks 建出来的任务默认 ExecutionTimeLimit=72 小时，到点会把整棵任务树杀掉
rem      （看门狗 + 服务 + 隧道一起），这里要显式设成 0（不超时）。
rem   2) 必须用 S4U 主体（-LogonType S4U）：否则 node.exe 是控制台程序，每次触发都会
rem      在桌面上弹一个黑窗口，关掉又弹，10 分钟一次。S4U 让它跑在会话 0，全程无窗口。
powershell -NoProfile -Command "$a=New-ScheduledTaskAction -Execute '%NODE_EXE%' -Argument '%~dp0autostart-watchdog.js' -WorkingDirectory '%~dp0'; $p=New-ScheduledTaskPrincipal -UserId \"$env:COMPUTERNAME\$env:USERNAME\" -LogonType S4U -RunLevel Limited; $t1=New-ScheduledTaskTrigger -AtLogOn; $t2=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650); $s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero); Register-ScheduledTask -TaskName 'ML-Suite Watchdog' -Action $a -Principal $p -Trigger $t1,$t2 -Settings $s -Description 'ML Suite watchdog (S4U, no console window)' -Force | Out-Null" >nul 2>&1
if errorlevel 1 (
  echo [跳过] 注册失败（可能没有权限）。不影响上面两层，只是少了「看门狗死了能自动重建」。
) else (
  echo [成功] 已注册：登录时 + 每 10 分钟确认一次看门狗存活
)
echo.

echo.
echo 立刻启动看门狗（隐藏窗口）...
start "" wscript.exe "%~dp0autostart.vbs"
echo.
echo 完成。以后开机登录就会自动运行。
echo 想关掉：双击「开机自启-关闭.bat」。
echo 想临时停服务：双击「停止公网服务.bat」（看门狗会尊重它，不会自己拉回来）。
echo.
pause
