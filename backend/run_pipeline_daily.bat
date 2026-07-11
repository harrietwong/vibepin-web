@echo off
:: DEPRECATED — superseded by split daily scripts (see SCHEDULING.md):
::   run_trends_daily.ps1   (08:30)
::   run_crawl_daily.ps1    (09:00 / 10:00)
::   run_stl_score_daily.ps1 (11:30)
:: Do not schedule this file alongside the split scripts.
::
:: VibePin Daily Pipeline — each step logs independently
:: If one step fails, the rest still run (best-effort).
:: Re-run any single step manually:
::   py pipeline.py --step crawl
::   py pipeline.py --step stl
::   py pipeline.py --step score
::   py pipeline.py --step digital

cd /d "d:\代码\Pinterest flow\backend"

set PY="C:\Users\44740\AppData\Local\Python\pythoncore-3.14-64\python.exe"
set PIPELINE="d:\代码\Pinterest flow\backend\pipeline.py"

set LOG_DIR=d:\代码\Pinterest flow\backend\logs\daily
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Date-stamped prefix shared across all step logs for this run
set D=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%
set T=%TIME:~0,2%%TIME:~3,2%
set T=%T: =0%
set STAMP=%D%_%T%

echo ===== Pipeline run started: %DATE% %TIME% =====

:: ── Step 1+2: Trends ──────────────────────────────────────────────────────────
set LOG=%LOG_DIR%\%STAMP%_01_trends.log
echo [%TIME%] Starting step: trends >> "%LOG%"
%PY% -u %PIPELINE% --step trends >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
    echo [%TIME%] WARNING: step trends exited %ERRORLEVEL% >> "%LOG%"
    echo STEP TRENDS FAILED (%ERRORLEVEL%) — continuing
) else (
    echo STEP TRENDS OK
)

:: ── Step 3: Crawl ─────────────────────────────────────────────────────────────
set LOG=%LOG_DIR%\%STAMP%_02_crawl.log
echo [%TIME%] Starting step: crawl >> "%LOG%"
%PY% -u %PIPELINE% --step crawl >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
    echo [%TIME%] WARNING: step crawl exited %ERRORLEVEL% >> "%LOG%"
    echo STEP CRAWL FAILED (%ERRORLEVEL%) — continuing
) else (
    echo STEP CRAWL OK
)

:: ── Step 4: Shop the Look ─────────────────────────────────────────────────────
set LOG=%LOG_DIR%\%STAMP%_03_stl.log
echo [%TIME%] Starting step: stl >> "%LOG%"
%PY% -u %PIPELINE% --step stl >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
    echo [%TIME%] WARNING: step stl exited %ERRORLEVEL% >> "%LOG%"
    echo STEP STL FAILED (%ERRORLEVEL%) — continuing
) else (
    echo STEP STL OK
)

:: ── Step 5: Product Scoring ───────────────────────────────────────────────────
set LOG=%LOG_DIR%\%STAMP%_04_score.log
echo [%TIME%] Starting step: score >> "%LOG%"
%PY% -u %PIPELINE% --step score >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
    echo [%TIME%] WARNING: step score exited %ERRORLEVEL% >> "%LOG%"
    echo STEP SCORE FAILED (%ERRORLEVEL%) — continuing
) else (
    echo STEP SCORE OK
)

:: ── Step 6: Digital Product Signals ──────────────────────────────────────────
set LOG=%LOG_DIR%\%STAMP%_05_digital.log
echo [%TIME%] Starting step: digital >> "%LOG%"
%PY% -u %PIPELINE% --step digital >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
    echo [%TIME%] WARNING: step digital exited %ERRORLEVEL% >> "%LOG%"
    echo STEP DIGITAL FAILED (%ERRORLEVEL%)
) else (
    echo STEP DIGITAL OK
)

echo ===== Pipeline run finished: %DATE% %TIME% =====
