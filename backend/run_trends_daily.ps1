# DEV-ONLY — local Windows manual testing. Production uses run_worker.py on a cloud worker.
# See CLOUD_WORKER.md and SCHEDULING.md.
$ErrorActionPreference = "Continue"$backendDir     = $PSScriptRoot
$logDir         = Join-Path $backendDir "logs\daily"
$python         = "C:\Users\44740\AppData\Local\Python\pythoncore-3.14-64\python.exe"
$pipelineScript = Join-Path $backendDir "pipeline.py"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$stamp = Get-Date -Format "yyyyMMdd_HHmm"
$logTrends = Join-Path $logDir "pipeline_${stamp}_trends.log"

"===== Trends replenish started: $(Get-Date) =====" | Out-File $logTrends -Encoding utf8
Set-Location $backendDir
& $python -u $pipelineScript --step trends --top 30 2>&1 |
    Out-File $logTrends -Append -Encoding utf8
"===== Trends replenish finished: $(Get-Date) exit=$LASTEXITCODE =====" |
    Out-File $logTrends -Append -Encoding utf8

exit $LASTEXITCODE
