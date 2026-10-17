#!/bin/sh
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Première installation, patientez..."
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
fi
.venv/bin/python app.py
