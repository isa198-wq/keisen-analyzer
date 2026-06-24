@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 毎日 07:30 に「毎日スクリーニング.bat」を実行するWindowsタスクをHIDDEN登録します。
rem 時刻を変えたい場合は下の 07:30 を編集してください（24時間表記）。
set TASKNAME=KeisenDailyScreening
set TIME=07:30
schtasks /create /tn "%TASKNAME%" /tr "\"%~dp0毎日スクリーニング.bat\"" /sc daily /st %TIME% /f
if %errorlevel%==0 (
  echo.
  echo 登録しました: 毎日 %TIME% に自動実行されます（PCが起動・ログイン中）。
  echo 解除したいときは「タスク削除.bat」を実行してください。
) else (
  echo.
  echo 登録に失敗しました。
)
echo.
pause
