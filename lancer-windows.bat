@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Premiere installation, patientez...
  py -m venv .venv || python -m venv .venv
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python app.py
pause
