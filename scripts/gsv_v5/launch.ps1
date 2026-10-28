param(
    [ValidateSet('start','status','stop','check')][string]$Action = 'start',
    [ValidateSet('all','sovits','gpt')][string]$Stage = 'all'
)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$projectDir = Join-Path $workspaceRoot 'training\nagato_disappearance_v5'
$pythonPath = Join-Path $workspaceRoot '.conda\gsv-v5\python.exe'
$workerPath = Join-Path $PSScriptRoot 'manage.py'
$pidPath = Join-Path $projectDir 'worker.json'
$statusPath = Join-Path $projectDir 'status.json'
$record = if (Test-Path -LiteralPath $pidPath) { Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json } else { $null }
$running = $null
if ($record) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.ExecutablePath -eq $pythonPath -and $candidate.CommandLine -like "*$workerPath* train *") {
        $running = $candidate
    }
}
if ($Action -eq 'status') {
    if ($running) { Write-Host "Running: PID $($running.ProcessId)" } else { Write-Host 'Training is not running.' }
    $sovitsCount = @(Get-ChildItem -LiteralPath (Join-Path $projectDir 'weights\sovits') -Filter '*.pth' -File -ErrorAction SilentlyContinue).Count
    $gptCount = @(Get-ChildItem -LiteralPath (Join-Path $projectDir 'weights\gpt') -Filter '*.ckpt' -File -ErrorAction SilentlyContinue).Count
    Write-Host "Exported epochs: SoVITS=$sovitsCount; GPT=$gptCount. Both stages must finish."
    if (Test-Path -LiteralPath $statusPath) { Get-Content -LiteralPath $statusPath }
    if ($record) {
        Write-Host "Log: $($record.stdout)"
        if (Test-Path -LiteralPath $record.stdout) { Get-Content -LiteralPath $record.stdout -Tail 12 }
        if (Test-Path -LiteralPath $record.stderr) { Get-Content -LiteralPath $record.stderr -Tail 8 }
    }
    exit 0
}
if ($Action -eq 'stop') {
    if (-not $running) { Write-Host 'No matching training worker is running.'; exit 0 }
    # Only terminate the verified project worker and its current descendants.
    $allProcesses = Get-CimInstance Win32_Process
    function Stop-WorkerTree([uint32]$WorkerId) {
        foreach ($child in @($allProcesses | Where-Object { $_.ParentProcessId -eq $WorkerId })) {
            Stop-WorkerTree $child.ProcessId
        }
        Stop-Process -Id $WorkerId -ErrorAction SilentlyContinue
    }
    Stop-WorkerTree $running.ProcessId
    @{status='stopped'; pid=$record.pid; updated_at=[DateTime]::UtcNow.ToString('o'); note='Resume uses the last completed epoch checkpoint.'} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
    Write-Host 'Stopped. Saved checkpoints are retained.'
    exit 0
}
if ($running) { throw "Training is already running: PID $($running.ProcessId)" }
if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'ready.json'))) {
    throw 'Training is not ready: transcript labels and preprocessing are still pending. No training was started.'
}
& $pythonPath $workerPath preflight
if ($LASTEXITCODE -ne 0) { throw 'Training preflight failed. No worker was launched; see the error above.' }
if ($Action -eq 'check') { exit 0 }
$logsDir = Join-Path $projectDir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logsDir "$stamp-$Stage.stdout.log"
$stderr = Join-Path $logsDir "$stamp-$Stage.stderr.log"
$arguments = '-u "{0}" train --stage {1}' -f $workerPath,$Stage
$process = Start-Process -FilePath $pythonPath -ArgumentList $arguments -WorkingDirectory $workspaceRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
@{pid=$process.Id; stage=$Stage; stdout=$stdout; stderr=$stderr; started_at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding UTF8
Write-Host "Background training launched: PID $($process.Id)"
Write-Host "Log: $stdout"
Write-Host 'Use status-nagato-v5-training.cmd to check progress.'
