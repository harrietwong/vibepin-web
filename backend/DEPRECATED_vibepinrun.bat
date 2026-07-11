@echo off
:: DEPRECATED — do not schedule at 11:00.
:: Replaced by: backend\run_stl_score_daily.ps1 (schedule at 11:30)
:: See SCHEDULING.md for the full split pipeline.
::
:: If C:\Users\44740\vibepinrun.bat still exists on this machine, disable its
:: Windows Task Scheduler entry and point "VibePin Daily Pipeline" to:
::   powershell.exe -File "d:\代码\Pinterest flow\backend\run_stl_score_daily.ps1"
exit /b 1
