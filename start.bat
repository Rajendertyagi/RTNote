@echo off
cd /d %~dp0
rem APP_HOST defaults to 127.0.0.1 (this PC only). To open the app to your
rem LAN, set it first, e.g.:  set APP_HOST=0.0.0.0
if "%APP_HOST%"=="" set APP_HOST=127.0.0.1
if "%APP_PORT%"=="" set APP_PORT=8000
echo Starting Trilium Notes server on http://localhost:%APP_PORT% ...
python -m uvicorn main:app --host %APP_HOST% --port %APP_PORT%
pause
