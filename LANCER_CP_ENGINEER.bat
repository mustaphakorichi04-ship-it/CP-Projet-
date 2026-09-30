@echo off
chcp 65001 > nul
title CP Engineer Pro - Serveur SaaS
echo ============================================================
echo   CP Engineer Pro - Lancement du SaaS en local
echo ============================================================
echo.
echo [1/2] Demarrage du serveur backend (Python + SQLite)...
set PYTHONIOENCODING=utf-8
start http://127.0.0.1:5000
python -X utf8 backend.py
pause
