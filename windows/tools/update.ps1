# Downloads the newest version and installs it. Menu, orders, photos and settings are kept.
. "$PSScriptRoot\common.ps1"
Ensure-Admin $PSCommandPath
$Host.UI.RawUI.WindowTitle = 'QR Ordering - Update'

$work = Join-Path $env:TEMP ('qr-update-' + [guid]::NewGuid())
try {
Say ''
Say '  QR Ordering - update' 'White'
Say '  --------------------'
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw 'Not installed yet. Please run the setup file first.' }
$cfg = Read-Config
$repo   = if ($cfg.UPDATE_REPO) { $cfg.UPDATE_REPO } else { 'chaou1009/qr-order' }
$branch = if ($cfg.UPDATE_BRANCH) { $cfg.UPDATE_BRANCH } else { 'main' }

Step 'Downloading the newest version'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$zip = Join-Path $work 'new.zip'
Invoke-WebRequest -Uri "https://codeload.github.com/$repo/zip/refs/heads/$branch" -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'x') -Force
$new = Get-ChildItem (Join-Path $work 'x') -Directory | Select-Object -First 1
if (-not $new -or -not (Test-Path (Join-Path $new.FullName 'server.js'))) { throw 'The download looks incomplete. Please try again later.' }
$newVer = (Get-Content (Join-Path $new.FullName 'package.json') -Raw | ConvertFrom-Json).version
$oldVer = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
if ([version]$newVer -lt [version]$oldVer) { throw "The online version ($newVer) is older than this computer's ($oldVer). Nothing was changed." }
Ok "Downloaded version $newVer (this computer has $oldVer)"

Step 'Installing'
Say '   The ordering page pauses for about 10 seconds. Guests who are ordering just tap again.'
Stop-Server
Backup-Data 'before-update'
# keep the current program so we can go back if the new one does not start
$old = Join-Path $work 'old'
New-Item -ItemType Directory -Force -Path $old | Out-Null
robocopy $AppDir $old /E /XD data runtime /NFL /NDL /NJH /NJS /NP | Out-Null

function Copy-Program($from) {
  foreach ($f in 'server.js', 'package.json', 'seed.json') {
    if (Test-Path (Join-Path $from $f)) { Copy-Item (Join-Path $from $f) $AppDir -Force }
  }
  robocopy (Join-Path $from 'public') (Join-Path $AppDir 'public') /E /XD uploads /NFL /NDL /NJH /NJS /NP | Out-Null
  if (Test-Path (Join-Path $from 'windows')) {
    robocopy (Join-Path $from 'windows') $AppDir /E /XD starter-data /NFL /NDL /NJH /NJS /NP | Out-Null
  }
}
Copy-Program $new.FullName
Start-Server
if (Wait-Server) {
  Ok "Updated to version $newVer and running"
} else {
  Warn 'The new version did not start. Going back to the previous version...'
  Stop-Server
  robocopy $old $AppDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Start-Server
  if (Wait-Server) { Warn "Back on version $oldVer. Nothing was lost. Please send a photo of this window." }
  else { throw 'The server does not start. Please send a photo of this window and the newest file in data\logs.' }
}
Say ''
Say '  Done. Tablets and phones show the new version after a refresh.' 'Green'
} catch {
  Say ''
  Say "  Update did not finish: $($_.Exception.Message)" 'Red'
  if (-not (Get-OurNode)) { try { Start-Server } catch {} }
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
Pause-End
