Dim shell
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 3 Then
  WScript.Quit 1
End If

Dim nodePath
Dim daemonPath
Dim logPath
Dim command

nodePath = WScript.Arguments.Item(0)
daemonPath = WScript.Arguments.Item(1)
logPath = WScript.Arguments.Item(2)

command = "cmd.exe /c """ & Chr(34) & nodePath & Chr(34) & " " & Chr(34) & daemonPath & Chr(34) & " >> " & Chr(34) & logPath & Chr(34) & " 2>>&1"""
shell.Run command, 0, False
