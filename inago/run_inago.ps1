<#
  run_inago.ps1 ― イナゴ盤 日次自動化ランナー
  流れ: (1) data.js は build_data_js.mjs で screening_data.csv から生成
        (2) detect_clusters.mjs で点火クラスタ検知 → clusters.json（未実装なら検知スキップ）
        (3) grok_name.py で Grok命名 → cluster_names.js（XAI_API_KEY がある時のみ）
        (4) inago_offline.html を開く

  使い方:
    .\run_inago.ps1            # 1回実行
    .\run_inago.ps1 -Open      # 実行して盤をブラウザで開く
    .\run_inago.ps1 -Register  # 毎日15:45に自動実行するタスクを登録（-Open付きで登録）

  前提: node と python が PATH に通っていること。
        PowerShell実行ポリシーで弾かれる場合は -ExecutionPolicy Bypass を併用。
#>
param([switch]$Register, [switch]$Open)
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
function Log($m){ Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m) }

# ---- タスクスケジューラ登録 ----
if ($Register) {
  $argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Open"
  $action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -Daily -At 15:45      # 大引け後。寄り前運用なら 08:00 等に変更
  Register-ScheduledTask -TaskName "InagoDaily" -Action $action -Trigger $trigger -Description "イナゴ盤 日次更新" -Force | Out-Null
  Log "タスク 'InagoDaily' を毎日15:45で登録しました（解除: Unregister-ScheduledTask -TaskName InagoDaily）。"
  return
}

# ---- (1) data.js 更新 ----
Log "data.js 更新 (node build_data_js.mjs)…"
node build_data_js.mjs

# ---- (2) クラスタ検知（未実装なら明示してスキップ） ----
if (Test-Path "detect_clusters.mjs") {
  Log "クラスタ検知 (node detect_clusters.mjs)…"
  node detect_clusters.mjs

  # ---- (3) Grok命名（キーがある時のみ）----
  if ($env:XAI_API_KEY) {
    if (Test-Path "clusters.json") {
      Log "Grok命名 (python grok_name.py)…"
      python grok_name.py clusters.json
    } else {
      Log "clusters.json が無いため命名スキップ。"
    }
  } else {
    Log "XAI_API_KEY 未設定 → 命名スキップ（盤のプロンプトをコピーして grok.com に手動でも可）。"
  }
} else {
  Log "detect_clusters.mjs が未実装のためクラスタ検知はスキップ（盤の「新テーマ」タブはブラウザ内で自前計算するため影響なし）。"
}

# ---- (4) 盤を開く ----
if ($Open) {
  Log "盤を開きます。"
  Start-Process (Join-Path $dir "inago_offline.html")
}
Log "完了。"
