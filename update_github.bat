@echo off
echo ====================================================
echo   CP ENGINEER PRO - MISE A JOUR GITHUB AUTOMATIQUE
echo ====================================================
echo.

cd /d "C:\Users\K2m358\Desktop\59-cp_engineer 1 - Copy"

echo 1. Verification de l'etat des fichiers...
git status

echo.
echo 2. Ajout des fichiers corriges (app.py, router.js, templates...)...
git add .

echo.
echo 3. Creation du Commit de sauvegarde...
git commit -m "Fix: Correction complete navigation sidebar, routes Flask et router.js sans regression SaaS"

echo.
echo 4. Envoi vers votre depot GitHub...
git push origin main

echo.
echo ====================================================
echo   SUCCES : Votre code est a jour sur GitHub !
echo ====================================================
pause