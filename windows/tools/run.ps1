# Started by Windows Task Scheduler when the computer turns on (runs in the background, no window).
# Keeps the ordering server running: if it ever stops, it starts again after 5 seconds.
$AppDir = Split-Path -Parent $PSScriptRoot
Set-Location $AppDir
$LogDir = Join-Path $AppDir 'data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Settings from config.ini become environment variables for server.js
$env:PORT = '3000'
$env:TZ_NAME = 'Asia/Kuala_Lumpur'
$cfgFile = Join-Path $AppDir 'config.ini'
if (Test-Path $cfgFile) {
  foreach ($line in Get-Content $cfgFile) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
  }
}

while ($true) {
  Get-ChildItem $LogDir -Filter 'server-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue
  $log = Join-Path $LogDir ('server-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
  Add-Content -Path $log -Value ("---- start " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
  cmd.exe /c "runtime\node.exe server.js >> `"$log`" 2>&1"
  Add-Content -Path $log -Value ("---- stopped " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ", restarting in 5 seconds") -Encoding UTF8
  Start-Sleep -Seconds 5
}
