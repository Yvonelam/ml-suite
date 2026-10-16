' ML Suite - autostart entry point (no visible window).
' Installed into the Startup folder by the "enable autostart" bat; removed by the "disable" bat.
' It only starts the watchdog; the watchdog is what launches/monitors the real service.
' NOTE: keep this file pure ASCII - Windows Script Host reads it as ANSI, not UTF-8.
Option Explicit

Dim fso, sh, root, nodeExe, versionsDir, sub, cand
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = "E:\ML-suite"
nodeExe = ""

' 1) managed node runtime (exact known build)
If nodeExe = "" Then
  If fso.FileExists("C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe") Then
    nodeExe = "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
  End If
End If

' 2) any managed version folder (the "-6" build suffix changes on upgrade)
If nodeExe = "" Then
  versionsDir = "C:\Users\Administrator\.workbuddy\binaries\node\versions"
  If fso.FolderExists(versionsDir) Then
    For Each sub In fso.GetFolder(versionsDir).SubFolders
      cand = sub.Path & "\node.exe"
      If fso.FileExists(cand) Then
        nodeExe = cand
        Exit For
      End If
    Next
  End If
End If

' 3) system node
If nodeExe = "" Then
  If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = "C:\Program Files\nodejs\node.exe"
  End If
End If

' 4) last resort: whatever "node" resolves to on PATH
If nodeExe = "" Then nodeExe = "node"

If Not fso.FileExists(root & "\autostart-watchdog.js") Then
  WScript.Quit 0
End If

sh.CurrentDirectory = root
' 0 = hidden window, False = do not wait
sh.Run """" & nodeExe & """ """ & root & "\autostart-watchdog.js""", 0, False
