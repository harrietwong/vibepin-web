# DEPRECATED — see SCHEDULING.md. Use run_trends_daily.ps1 + run_crawl_daily.ps1 + run_stl_score_daily.ps1.
# daily_pipeline.ps1 — legacy 11 AM monolithic pipeline (populate + crawl + STL)

$ROOT = "d:\代码\Pinterest flow\backend"
$PY   = "C:\Users\44740\AppData\Local\Python\bin\python.exe"
$DATE = Get-Date -Format "yyyy-MM-dd"
$LOG  = "C:\Users\44740\AppData\Local\Temp\vibepinlogs\daily_$DATE.log"

New-Item -ItemType Directory -Force (Split-Path $LOG) | Out-Null
Start-Transcript -Path $LOG -Append | Out-Null

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] === Daily Pipeline Start ==="

Set-Location $ROOT

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Step 1: Reset stuck items"
& $PY reset_failed.py

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Step 2: Populate crawl queue skipped (deprecated; use pipeline.py --step trends)"

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Step 3: Crawl pins"
& $PY -u pipeline.py --step crawl --concurrency 2

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Step 4: Shop the Look"
& $PY -u pipeline.py --step stl

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Step 5: Product scoring"
& $PY -u calculate_product_scores.py

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] === Daily Pipeline Done ==="
Stop-Transcript | Out-Null
