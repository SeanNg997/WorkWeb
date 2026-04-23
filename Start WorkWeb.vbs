Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)

checkCode = shell.Run("cmd /c where node >nul 2>nul", 0, True)
If checkCode <> 0 Then
  MsgBox "未找到 Node.js，请先安装 Node.js 后再双击启动。", 16, "WorkWeb"
  WScript.Quit 1
End If

launchCmd = "cmd /c cd /d """ & projectDir & """ && node ""scripts\launch.js"""
launchCode = shell.Run(launchCmd, 0, True)

If launchCode <> 0 Then
  MsgBox "启动失败。请双击 Start WorkWeb.bat 查看错误信息。", 16, "WorkWeb"
  WScript.Quit launchCode
End If
