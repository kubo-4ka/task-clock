@echo off
rem Task Clock をローカルサーバーで起動し、Edge のアプリウインドウで開きます（Node.js が必要）
cd /d "%~dp0.."
start "Task Clock server" /min node tools\serve.js 8790
timeout /t 1 >nul
start "" msedge --app=http://localhost:8790/ --window-size=480,860
