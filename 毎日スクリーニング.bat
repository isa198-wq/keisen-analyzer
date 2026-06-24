@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [%date% %time%] daily screening start
python fetch_market.py
python fetch_data.py
node screen_daily.mjs
echo [%date% %time%] done
