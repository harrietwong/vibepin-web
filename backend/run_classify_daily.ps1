# DEV-ONLY — local Windows manual testing. Production uses scripts/run_classify_daily.sh on the VPS.
# Runs classify + opportunities via run_worker (same as cloud worker).
$ErrorActionPreference = "Continue"
$backendDir = $PSScriptRoot
$logDir     = Join-Path $backendDir "logs\daily"
$python     = "C:\Users\44740\AppData\Local\Python\pythoncore-3.14-64\python.exe"
$worker     = Join-Path $backendDir "run_worker.py"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stamp = Get-Date -Format "yyyyMMdd_HHmm"
Set-Location $backendDir

$logClassify = Join-Path $logDir "pipeline_${stamp}_classify.log"
"===== Classify+Opportunities started: $(Get-Date) =====" | Out-File $logClassify -Encoding utf8
& $python -u $worker --job classify --created-by local 2>&1 | Out-File $logClassify -Append -Encoding utf8
"===== Classify+Opportunities finished: $(Get-Date) exit=$LASTEXITCODE =====" | Out-File $logClassify -Append -Encoding utf8

exit $LASTEXITCODE
