# DEPRECATED — use run_crawl_daily.ps1 for scheduled crawl jobs.
# Kept as a thin wrapper so existing Windows Task Scheduler entries keep working.
& (Join-Path $PSScriptRoot "run_crawl_daily.ps1")
exit $LASTEXITCODE
