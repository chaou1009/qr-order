# Shared helpers for the Windows scripts (install / update / restart).
# Messages are in simple English on purpose: an English Windows console cannot show Chinese characters.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppDir    = Split-Path -Parent $PSScriptRoot           # folder with server.js
$InstallTo = 'C:\QROrder'
$TaskName  = 'QR Ordering Server'
$Node      = Join-Path $AppDir 'runtime\node.exe'
$Cloudflared = Join-Path $AppDir 'runtime\cloudflared.exe'
$DataDir   = Join-Path $AppDir 'data'
$ConfigFile = Join-Path $AppDir 'config.ini'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }

# Re-run this script as Administrator if needed (Windows shows a "Yes / No" prompt).
function Ensure-Admin($scriptPath) {
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"")
    exit
  }
}

function Read-Config {
  $cfg = [ordered]@{}
  if (Test-Path $ConfigFile) {
    foreach ($line in Get-Content $ConfigFile) {
      if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2] }
    }
  }
  return $cfg
}

function Write-Config($cfg) {
  $lines = @('# QR ordering settings. After changing this file, run the restart file.')
  foreach ($k in $cfg.Keys) { $lines += "$k=$($cfg[$k])" }
  Set-Content -Path $ConfigFile -Value $lines -Encoding ASCII
}

function Get-OurNode {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $Node) }
}

function Stop-Server {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*tools\run.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-OurNode | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Start-Server { Start-ScheduledTask -TaskName $TaskName }

function Port-Owner($port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue }
}

function Test-Url($url) {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10; return $r.StatusCode -eq 200 } catch { return $false }
}

function Wait-Server($seconds = 40) {
  $cfg = Read-Config; $port = if ($cfg.PORT) { $cfg.PORT } else { 3000 }
  for ($i = 0; $i -lt $seconds; $i += 2) {
    if (Test-Url "http://localhost:$port/") { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

# Safety copy of the database before risky steps. Keeps the newest 5.
function Backup-Data($label) {
  $db = Join-Path $DataDir 'restaurant.db'
  if (-not (Test-Path $db)) { return }
  $root = Join-Path $DataDir 'safety-copies'
  $dest = Join-Path $root ((Get-Date -Format 'yyyyMMdd-HHmmss') + "-$label")
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem $DataDir -Filter 'restaurant.db*' | Copy-Item -Destination $dest
  Copy-Item (Join-Path $DataDir 'secret.key') $dest -ErrorAction SilentlyContinue
  Get-ChildItem $root -Directory | Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Recurse -Force
  Ok "Safety copy of the menu and orders saved (data\safety-copies)"
}

# Run a Windows command without stopping on its normal messages. Returns its text output.
function Native([scriptblock]$cmd) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { return (& $cmd 2>&1 | Out-String) } finally { $ErrorActionPreference = $old }
}

function Pause-End { Write-Host ''; Read-Host 'Press Enter to close this window' | Out-Null }
