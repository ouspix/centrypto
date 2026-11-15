param(
    [string]$Distribution = 'Ubuntu',
    [string]$ProjectRoot = '/home/mellinien/projects/centrypto',
    [string]$DatabaseDistribution = 'CentryptoDB',
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
if ($Distribution -notmatch '^[a-zA-Z0-9_.-]+$' -or $DatabaseDistribution -notmatch '^[a-zA-Z0-9_.-]+$' -or $ProjectRoot -notmatch '^/[a-zA-Z0-9_./-]+$') { throw 'Use simple distribution names and an absolute WSL project path.' }
$installDirectory = Join-Path $env:LOCALAPPDATA 'Centrypto\runtime'
New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
$launcher = Join-Path $installDirectory 'start_local_service.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start_local_service.ps1') -Destination $launcher -Force

# Keep the Linux watchdog/drop-in reproducible in the repository. Installation
# does not stop PostgreSQL, migrate data, or alter its durability settings.
$keepalive = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'centrypto-postgres-keepalive.sh')))
$restart = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'postgres-restart.conf')))
$setup = @"
set -eu
test -f /etc/postgresql/17/centrypto/postgresql.conf
printf %s '$keepalive' | base64 -d > /usr/local/sbin/centrypto-postgres-keepalive.new
chmod 755 /usr/local/sbin/centrypto-postgres-keepalive.new
mv /usr/local/sbin/centrypto-postgres-keepalive.new /usr/local/sbin/centrypto-postgres-keepalive
mkdir -p /etc/systemd/system/postgresql@17-centrypto.service.d
printf %s '$restart' | base64 -d > /etc/systemd/system/postgresql@17-centrypto.service.d/restart.conf
systemctl daemon-reload
systemctl enable postgresql@17-centrypto.service
"@
$setupEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($setup.Replace("`r", '')))
& wsl.exe -d $DatabaseDistribution -u root --cd / --exec sh -c "printf %s '$setupEncoded' | base64 -d | sh"
if ($LASTEXITCODE -ne 0) { throw 'Database watchdog installation failed.' }

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$definitions = @(
    @{ Name = 'Centrypto local PostgreSQL'; Service = 'Database'; Distro = $DatabaseDistribution },
    @{ Name = 'Centrypto local intelligence'; Service = 'Runtime'; Distro = $Distribution }
)
foreach ($definition in $definitions) {
    $existing = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
    $backup = Join-Path $installDirectory ($definition.Service + '.original-task.xml')
    if ($existing -and -not (Test-Path -LiteralPath $backup)) { Export-ScheduledTask -TaskName $definition.Name | Set-Content -LiteralPath $backup }
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $launcher + '" -Service ' + $definition.Service + ' -Distribution ' + $definition.Distro + ' -ProjectRoot ' + $ProjectRoot
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $installDirectory
    Register-ScheduledTask -TaskName $definition.Name -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Persistent Centrypto service recovery. Preserves book enablement and existing execution permissions.' -Force | Select-Object TaskName, State
}
# These two identical one-shot bootstrap tasks raced the owned supervisor/web.
# Keep their definitions for rollback, but use the two managed tasks above.
foreach ($legacy in @('Centrypto local services', 'Centrypto start services')) {
    $oldTask = Get-ScheduledTask -TaskName $legacy -ErrorAction SilentlyContinue
    if ($oldTask -and $oldTask.State -ne 'Disabled') {
        try { Disable-ScheduledTask -InputObject $oldTask | Out-Null }
        catch {
            # Some Task Scheduler versions report not-found after applying the
            # change. Only accept that response if the persisted state confirms it.
            if ((Get-ScheduledTask -TaskName $legacy).State -ne 'Disabled') { throw }
        }
    }
}
if (-not $NoStart) {
    foreach ($definition in $definitions) { Start-ScheduledTask -TaskName $definition.Name }
}
