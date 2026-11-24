# One-time setup on the shop computer. Safe to run again (it keeps your menu, orders and settings).
. "$PSScriptRoot\common.ps1"
Ensure-Admin $PSCommandPath
$Host.UI.RawUI.WindowTitle = 'QR Ordering - Setup'

try {
Say ''
Say '  QR Ordering - setup for this computer' 'White'
Say '  ------------------------------------'

# 1. Put the program in C:\QROrder (so it does not depend on the Downloads folder)
Step 'Step 1 of 7: Program folder'
if ($AppDir -ne $InstallTo) {
  if (-not (Test-Path (Join-Path $AppDir 'runtime\node.exe'))) { throw 'runtime\node.exe is missing. Please unzip the whole package first, then run the setup again.' }
  if (Test-Path (Join-Path $InstallTo 'server.js')) {
    Say "   $InstallTo already exists. Program files there will be replaced; menu, orders and settings are kept."
  }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    $AppDirSaved = $AppDir; $AppDir = $InstallTo; $Node = Join-Path $InstallTo 'runtime\node.exe'
    Stop-Server
    $AppDir = $AppDirSaved
  }
  $cfSvc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($cfSvc -and $cfSvc.Status -eq 'Running') { Stop-Service cloudflared -Force; $restartCf = $true }
  New-Item -ItemType Directory -Force -Path $InstallTo | Out-Null
  robocopy $AppDir $InstallTo /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Could not copy files to $InstallTo" }
  if ($restartCf) { Start-Service cloudflared }
  Ok "Copied to $InstallTo"
  Say '   Continuing from the new folder...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallTo 'tools\install.ps1')
  exit
}
Ok "Program folder: $AppDir"

# 2. Stop anything already using port 3000 (for example the demo window)
Step 'Step 2 of 7: Checking the demo is closed'
Stop-Server
$owner = Port-Owner 3000
while ($owner) {
  Warn "Another program is using port 3000: $($owner.ProcessName) ($($owner.Path))"
  Say  '   This is usually the old demo window. Please close it (the black window), then press Enter.'
  Read-Host '   ' | Out-Null
  $owner = Port-Owner 3000
}
Ok 'Port 3000 is free'

# 3. Menu data: keep existing, or bring in the demo data / a backup zip
Step 'Step 3 of 7: Menu and photos'
$db = Join-Path $DataDir 'restaurant.db'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
if (Test-Path $db) {
  Ok 'Existing menu and orders found in this folder. They are kept.'
} else {
  # Look for the demo the shop already set up (Desktop / Downloads / Documents)
  $cands = @()
  foreach ($u in Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue) {
    foreach ($sub in 'Desktop', 'Downloads', 'Documents', 'OneDrive\Desktop', 'OneDrive\Documents') {
      $d = Join-Path $u.FullName $sub
      if (Test-Path $d) {
        $cands += Get-ChildItem $d -Recurse -Depth 4 -Filter 'restaurant.db' -ErrorAction SilentlyContinue |
          Where-Object { $_.Directory.Name -eq 'data' -and $_.FullName -notlike '*safety-copies*' -and $_.FullName -notlike "$AppDir*" }
      }
    }
  }
  $cands = @($cands | Where-Object { $_ } | Sort-Object LastWriteTime -Descending)
  $from = $null
  if ($cands.Count -gt 0) {
    Say '   Found the menu you set up in the demo:'
    for ($i = 0; $i -lt [Math]::Min($cands.Count, 5); $i++) {
      Say ("     {0}) {1}   (last changed {2:yyyy-MM-dd HH:mm})" -f ($i + 1), $cands[$i].Directory.Parent.FullName, $cands[$i].LastWriteTime)
    }
    Say '   Press Enter to use number 1 (the newest), or type another number.'
    Say '   Type Z to pick a backup zip instead, or N to start with the menu in this package.'
  } else {
    Say '   No demo menu found on this computer.'
    Say '   Type Z to pick a backup zip (downloaded from the back office),'
    Say '   or press Enter to start with the Tasty Chicken Rice menu in this package.'
  }
  $ans = (Read-Host '   Your choice').Trim().ToUpper()
  $tmp = $null
  if ($ans -eq 'Z') {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Filter = 'Backup zip (*.zip)|*.zip'; $dlg.Title = 'Pick the backup zip'
    $dlg.InitialDirectory = [Environment]::GetFolderPath('UserProfile') + '\Downloads'
    if ($dlg.ShowDialog() -eq 'OK') {
      $tmp = Join-Path $env:TEMP ('qr-import-' + [guid]::NewGuid())
      Expand-Archive -Path $dlg.FileName -DestinationPath $tmp -Force
      $f = Get-ChildItem $tmp -Recurse -Filter 'restaurant.db' | Select-Object -First 1
      if ($f) { $from = $f.DirectoryName } else { Warn 'No menu inside that zip.' }
    }
  } elseif ($cands.Count -gt 0 -and $ans -ne 'N') {
    $k = if ($ans -match '^\d+$') { [int]$ans - 1 } else { 0 }
    if ($k -lt 0 -or $k -ge $cands.Count) { $k = 0 }
    $from = $cands[$k].DirectoryName
  }
  if ($from) {
    Get-ChildItem $from -Filter 'restaurant.db*' | Copy-Item -Destination $DataDir -Force
    if (Test-Path (Join-Path $from 'secret.key')) { Copy-Item (Join-Path $from 'secret.key') $DataDir -Force }
    if (Test-Path (Join-Path $from 'uploads')) {
      New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'uploads') | Out-Null
      Copy-Item (Join-Path $from 'uploads\*') (Join-Path $DataDir 'uploads') -Recurse -Force
    }
    $n = @(Get-ChildItem (Join-Path $DataDir 'uploads') -File -ErrorAction SilentlyContinue).Count
    Ok "Menu brought in ($n photos)"
  } else {
    Copy-Item (Join-Path $AppDir 'tools\starter-data\*') $DataDir -Recurse -Force
    Ok 'Started with the menu that comes with this package'
  }
  if ($tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# 4. Settings: web address and staff PIN
Step 'Step 4 of 7: Web address and staff PIN'
$cfg = Read-Config
$cur = if ($cfg.PUBLIC_URL) { $cfg.PUBLIC_URL -replace '^https?://', '' } else { '' }
Say '   Type your shop web address, for example:  ordertastychickenrice.com'
if ($cur) { Say "   (Now: $cur  - press Enter to keep it)" }
$domain = (Read-Host '   Web address').Trim()
if (-not $domain) { $domain = $cur }
$domain = ($domain -replace '^https?://', '' -replace '/.*$', '').ToLower()
if ($domain) { $cfg.PUBLIC_URL = "https://$domain" } else { $cfg.Remove('PUBLIC_URL'); Warn 'No web address yet. The QR codes will only work on the shop Wi-Fi until you run setup again.' }

$curPin = $cfg.STAFF_PIN
Say '   Choose the staff PIN (4 to 8 digits). Staff type it once on each tablet.'
if ($curPin) { Say "   (Now: $curPin  - press Enter to keep it)" }
while ($true) {
  $pin = (Read-Host '   Staff PIN').Trim()
  if (-not $pin -and $curPin) { $pin = $curPin }
  if ($pin -match '^\d{4,8}$' -and $pin -notin @('1234', '8888', '0000')) { break }
  Warn 'Please use 4 to 8 digits, and not 1234 / 8888 / 0000.'
}
$cfg.STAFF_PIN = $pin
if (-not $cfg.PORT) { $cfg.PORT = '3000' }
if (-not $cfg.AUTO_CLOSE_HOURS) { $cfg.AUTO_CLOSE_HOURS = '1' }
Write-Config $cfg
Ok 'Saved in config.ini'

# 5. Never sleep while plugged in (the screen may still turn off, that is fine)
Step 'Step 5 of 7: Keep the computer awake'
Native { powercfg /change standby-timeout-ac 0 } | Out-Null
Native { powercfg /change hibernate-timeout-ac 0 } | Out-Null
Native { powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP HYBRIDSLEEP 0 } | Out-Null
Native { powercfg /setactive SCHEME_CURRENT } | Out-Null
Ok 'Sleep is off (the screen can still turn off by itself)'

# 6. Start automatically when the computer turns on (even before anyone logs in)
Step 'Step 6 of 7: Start automatically'
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\tools\run.ps1`"" -WorkingDirectory $AppDir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-Server
if (Wait-Server) { Ok 'Ordering server is running and will start by itself every time the computer turns on' }
else { throw 'The server did not start. Please send a photo of this window and the newest file in data\logs.' }

# 7. Cloudflare Tunnel (makes the web address reach this computer)
Step 'Step 7 of 7: Cloudflare Tunnel'
$svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
$doTunnel = $true
if ($svc) {
  Ok "Cloudflare Tunnel is already installed (status: $($svc.Status))."
  $ans = Read-Host '   Press Enter to keep it, or type NEW to paste a new token'
  $doTunnel = ($ans.Trim().ToUpper() -eq 'NEW')
}
if ($doTunnel) {
  Say '   Paste the tunnel install command (or just the token) from the Cloudflare website, then press Enter.'
  Say '   (Right-click in this window to paste. Press Enter without pasting to skip this for now.)'
  $paste = Read-Host '   Token'
  $token = [regex]::Match($paste, 'eyJ[A-Za-z0-9_\-=+/\.]{40,}').Value
  if ($paste.Trim() -and -not $token) { Warn 'That does not look like a tunnel token. Skipped - run the setup again to try once more.' }
  elseif ($token) {
    if ($svc) { Native { & $Cloudflared service uninstall }; Start-Sleep -Seconds 3 }
    $out = Native { & $Cloudflared service install $token }
    Start-Sleep -Seconds 5
    $svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { Ok 'Cloudflare Tunnel installed and running (starts by itself with the computer)' }
    else { Say $out; Warn 'Cloudflare Tunnel did not start. Please send a photo of this window.' }
  } else { Warn 'Skipped. Run the setup again when you have the token.' }
}

# Final check
Step 'Checking'
Ok 'On this computer: http://localhost:3000/staff'
if ($cfg.PUBLIC_URL) {
  Start-Sleep -Seconds 3
  if (Test-Url "$($cfg.PUBLIC_URL)/") { Ok "Online: $($cfg.PUBLIC_URL) works from the internet" }
  else { Warn "$($cfg.PUBLIC_URL) cannot be opened yet. It can take a few minutes after adding the address in Cloudflare. Try it on your phone later." }
}

# Shortcuts on the desktop
$desk = [Environment]::GetFolderPath('CommonDesktopDirectory')
$base = if ($cfg.PUBLIC_URL) { $cfg.PUBLIC_URL } else { 'http://localhost:3000' }
Set-Content -Path (Join-Path $desk 'QR Order - Staff.url') -Value @('[InternetShortcut]', "URL=$base/staff") -Encoding ASCII
Set-Content -Path (Join-Path $desk 'QR Order - Back office.url') -Value @('[InternetShortcut]', "URL=$base/admin") -Encoding ASCII
Ok 'Shortcuts added to the desktop: "QR Order - Staff" and "QR Order - Back office"'

Say ''
Say '  All done! You can close this window.' 'Green'
Say "  Program folder: $AppDir   (you may delete the downloaded zip and its unzipped folder)" 'Green'
Start-Process "$base/staff"
} catch {
  Say ''
  Say "  Something went wrong: $($_.Exception.Message)" 'Red'
  Say '  Please take a photo of this window and send it over.' 'Red'
}
Pause-End
