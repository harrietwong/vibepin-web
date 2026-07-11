# DEV-ONLY — local Windows manual testing. Production uses scripts/run_stl_score_daily.sh + run_worker.py.
$ErrorActionPreference = "Continue"$backendDir = $PSScriptRoot
$logDir     = Join-Path $backendDir "logs\daily"
$python     = "C:\Users\44740\AppData\Local\Python\pythoncore-3.14-64\python.exe"
$pipeline   = Join-Path $backendDir "pipeline.py"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stamp = Get-Date -Format "yyyyMMdd_HHmm"
Set-Location $backendDir

# STL + Score only — crawl is handled by run_crawl_daily.ps1 (09:00 / 10:00).
# Do NOT run crawl here; avoids overlap with morning crawl window.

$logStl = Join-Path $logDir "pipeline_${stamp}_stl.log"
"===== STL started: $(Get-Date) =====" | Out-File $logStl -Encoding utf8
& $python -u $pipeline --step stl --stl-limit 300 2>&1 | Out-File $logStl -Append -Encoding utf8
"===== STL finished: $(Get-Date) exit=$LASTEXITCODE =====" | Out-File $logStl -Append -Encoding utf8

$logScore = Join-Path $logDir "pipeline_${stamp}_score.log"
"===== Score started: $(Get-Date) =====" | Out-File $logScore -Encoding utf8
& $python -u $pipeline --step score 2>&1 | Out-File $logScore -Append -Encoding utf8
"===== Score finished: $(Get-Date) exit=$LASTEXITCODE =====" | Out-File $logScore -Append -Encoding utf8

exit $LASTEXITCODE
