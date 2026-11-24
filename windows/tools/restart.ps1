# Restarts the ordering server and the Cloudflare Tunnel (use after changing config.ini, or if something seems stuck).
. "$PSScriptRoot\common.ps1"
Ensure-Admin $PSCommandPath
$Host.UI.RawUI.WindowTitle = 'QR Ordering - Restart'
try {
  Step 'Restarting the ordering server'
  Stop-Server
  Start-Server
  if (Wait-Server) { Ok 'Ordering server is running' } else { Warn 'The server did not start. Please send the newest file in data\logs.' }
  if (Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue) {
    Step 'Restarting the Cloudflare Tunnel'
    Restart-Service cloudflared -Force
    Ok 'Cloudflare Tunnel is running'
  }
  $cfg = Read-Config
  if ($cfg.PUBLIC_URL) {
    Start-Sleep -Seconds 5
    if (Test-Url "$($cfg.PUBLIC_URL)/") { Ok "$($cfg.PUBLIC_URL) works from the internet" }
    else { Warn "$($cfg.PUBLIC_URL) cannot be opened right now. Check the internet connection, then try again in a minute." }
  }
} catch {
  Say "  Something went wrong: $($_.Exception.Message)" 'Red'
}
Pause-End
