# DEPRECATED — use run_stl_score_daily.ps1 (schedule at 11:30, not 11:00).
& (Join-Path $PSScriptRoot "run_stl_score_daily.ps1")
exit $LASTEXITCODE
