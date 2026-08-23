@echo off
cd /d %~dp0
echo Starting Trilium Notes server on http://localhost:8000 ...
python -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
