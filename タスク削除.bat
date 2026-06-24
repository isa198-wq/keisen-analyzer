@echo off
chcp 65001 >nul
schtasks /delete /tn "KeisenDailyScreening" /f
echo.
echo 自動実行タスクを解除しました（手動での「毎日スクリーニング.bat」は引き続き使えます）。
echo.
pause
