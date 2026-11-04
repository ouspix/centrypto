param(
    [string]$Distribution = 'Ubuntu',
    [string]$ProjectRoot = '/home/mellinien/projects/centrypto'
)
$ErrorActionPreference = 'Stop'
if ($Distribution -notmatch '^[a-zA-Z0-9_.-]+$' -or $ProjectRoot -notmatch '^/[a-zA-Z0-9_./-]+$') { throw 'Use a simple distribution name and absolute WSL project path.' }
$arguments = "-d $Distribution --cd $ProjectRoot --exec python3 scripts/start_local_runtime.py"
$command = "Start-Process -FilePath wsl.exe -ArgumentList '$arguments' -WindowStyle Hidden -Wait"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -Command "' + $command + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Centrypto local intelligence' -Action $action -Trigger $trigger -Settings $settings -Description 'SSH database tunnel and local Codex inference. Does not start trading.' -Force | Select-Object TaskName, State
Start-Process -FilePath 'wsl.exe' -ArgumentList $arguments -WindowStyle Hidden
