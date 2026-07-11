# DEV-ONLY — local Windows manual testing. Production crawl runs via VibePinLocalCrawl
# (scripts/local_crawl_nightly.ps1) or VPS when PINTEREST_SEARCH_CRAWL_ENABLED=true.
$ErrorActionPreference = "Continue"
$backendDir     = $PSScriptRoot
$logDir         = Join-Path $backendDir "logs\daily"
$python         = "C:\Users\44740\AppData\Local\Python\pythoncore-3.14-64\python.exe"
$workerScript   = Join-Path $backendDir "run_worker.py"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$stamp = Get-Date -Format "yyyyMMdd_HHmm"
$logCrawl = Join-Path $logDir "pipeline_${stamp}_crawl.log"

"===== Crawl started: $(Get-Date) =====" | Out-File $logCrawl -Encoding utf8
Set-Location $backendDir
& $python -u $workerScript --job crawl --limit-keywords 150 --top 50 --created-by local 2>&1 |
    Out-File $logCrawl -Append -Encoding utf8
"===== Crawl finished: $(Get-Date) exit=$LASTEXITCODE =====" |
    Out-File $logCrawl -Append -Encoding utf8

exit $LASTEXITCODE
