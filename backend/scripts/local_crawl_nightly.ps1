# local_crawl_nightly.ps1
# Runs nightly Pinterest crawl from local residential IP.
# Called by Windows Task Scheduler at 02:00 daily.
# Logs to backend\logs\local_crawl_daily.log (rolling, kept ≤30 days).

$ErrorActionPreference = "Stop"

$root    = "d:\代码\Pinterest flow\backend"
$logDir  = "$root\logs"
$logFile = "$logDir\local_crawl_daily.log"
$python  = "C:\Users\44740\AppData\Local\Python\pythoncore-3.14-64\python.exe"
$maxRunMinutes = 90  # hard kill after 90 min

# --- Rotate logs older than 30 days ---
Get-ChildItem "$logDir\local_crawl_daily_*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force -Confirm:$false

# --- Archive yesterday's log ---
$stamp    = (Get-Date).ToString("yyyyMMdd_HHmm")
$logFile  = "$logDir\local_crawl_$stamp.log"

$started  = Get-Date

function Write-Log {
    param([string]$msg)
    $line = "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] $msg"
    $line | Out-File -FilePath $logFile -Append -Encoding utf8
    Write-Output $line
}

Write-Log "=== local_crawl_nightly START ==="
Write-Log "Working dir: $root"
Write-Log "Python: $python"

Set-Location $root
$env:PYTHONUTF8 = "1"

# --- Run crawl with max-runtime guard ---
$proc = Start-Process `
    -FilePath $python `
    -ArgumentList "-X", "utf8", "run_worker.py", "--job", "crawl",
                  "--limit-keywords", "150", "--concurrency", "3",
                  "--top", "50",
                  "--region", "US", "--created-by", "local" `
    -WorkingDirectory $root `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput "$logDir\crawl_stdout_$stamp.tmp" `
    -RedirectStandardError  "$logDir\crawl_stderr_$stamp.tmp"

Write-Log "Crawl PID: $($proc.Id)"

$deadline = (Get-Date).AddMinutes($maxRunMinutes)
$killed   = $false
while (-not $proc.HasExited) {
    if ((Get-Date) -gt $deadline) {
        Write-Log "WARN: max runtime ($maxRunMinutes min) exceeded — killing PID $($proc.Id)"
        Stop-Process -Id $proc.Id -Force -Confirm:$false -ErrorAction SilentlyContinue
        $killed = $true
        break
    }
    Start-Sleep -Seconds 30
}

$exitCode = if ($killed) { 124 } else { $proc.ExitCode }

# Append captured output to main log
if (Test-Path "$logDir\crawl_stdout_$stamp.tmp") {
    Get-Content "$logDir\crawl_stdout_$stamp.tmp" -Encoding utf8 | Out-File $logFile -Append -Encoding utf8
    Remove-Item "$logDir\crawl_stdout_$stamp.tmp" -Force
}
if (Test-Path "$logDir\crawl_stderr_$stamp.tmp") {
    $stderr = Get-Content "$logDir\crawl_stderr_$stamp.tmp" -Encoding utf8
    if ($stderr) {
        Write-Log "=== STDERR ==="
        $stderr | Out-File $logFile -Append -Encoding utf8
    }
    Remove-Item "$logDir\crawl_stderr_$stamp.tmp" -Force
}

$elapsed = [int]((Get-Date) - $started).TotalSeconds
if ($exitCode -eq 0) {
    Write-Log "=== COMPLETED OK  exit=$exitCode  elapsed=${elapsed}s ==="
} elseif ($killed) {
    Write-Log "=== KILLED (timeout)  exit=$exitCode  elapsed=${elapsed}s ==="
    exit 1
} else {
    Write-Log "=== FAILED  exit=$exitCode  elapsed=${elapsed}s ==="
    exit $exitCode
}
