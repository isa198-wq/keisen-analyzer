@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo  1/2 Fetching market indices (fetch_market.py) ...
echo ==============================================
echo.
python fetch_market.py
echo.
echo ==============================================
echo  2/2 Fetching stock data (fetch_data.py) ...
echo ==============================================
echo.
python fetch_data.py
echo.
echo ==============================================
echo  Done.
echo   - market overview loads automatically
echo   - load screening_data.csv into the app for screening
echo  Press any key to close this window.
echo ==============================================
pause >nul
