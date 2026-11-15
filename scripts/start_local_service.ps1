param(
    [Parameter(Mandatory = $true)][ValidateSet('Database', 'Runtime')][string]$Service,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Distribution,
    [ValidatePattern('^/[a-zA-Z0-9_./-]+$')][string]$ProjectRoot = '/home/mellinien/projects/centrypto'
)
$ErrorActionPreference = 'Stop'
$logDirectory = Join-Path $env:LOCALAPPDATA 'Centrypto\runtime\logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$logFile = Join-Path $logDirectory "$Service.log"
$arguments = if ($Service -eq 'Database') {
    "-d $Distribution -u root --cd / --exec /usr/local/sbin/centrypto-postgres-keepalive"
} else {
    "-d $Distribution --cd $ProjectRoot --exec python3 scripts/start_local_runtime.py"
}
$delaySeconds = 5
while ($true) {
    $startedAt = Get-Date
    try {
        # The Windows parent survives WSL shutdown; retry even a clean child exit.
        $process = Start-Process -FilePath 'wsl.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait `
            -RedirectStandardOutput (Join-Path $logDirectory "$Service.stdout.log") `
            -RedirectStandardError (Join-Path $logDirectory "$Service.stderr.log")
        $result = "WSL exited with code $($process.ExitCode)"
    } catch {
        $result = "WSL launch failed: $($_.Exception.Message)"
    }
    if (((Get-Date) - $startedAt).TotalSeconds -ge 60) { $delaySeconds = 5 }
    if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 1MB) {
        Move-Item -LiteralPath $logFile -Destination "$logFile.1" -Force
    }
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) $result; retrying in ${delaySeconds}s"
    Start-Sleep -Seconds $delaySeconds
    $delaySeconds = [Math]::Min(60, $delaySeconds * 2)
}
