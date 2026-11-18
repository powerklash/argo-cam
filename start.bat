@echo off
rem Avvia il server e apre l'interfaccia come finestra app di Edge.
cd /d "%~dp0"
start "Argo server" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" msedge --app=http://localhost:8780
