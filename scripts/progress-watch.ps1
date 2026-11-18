# Writes a progress line to BUILD-LOG.md every 2 hours while the build runs.
# If C: free space drops below 25 GB it stops the build (resume = run step4-build.cmd again) and exits.
$log = 'D:\Jonah-Chromium\BUILD-LOG.md'
$start = Get-Date
$env:PATH = "C:\src\depot_tools;$env:PATH"
function Progress {
  $out = & cmd.exe /c "cd /d C:\src\chromium\src && siso ps -C out\Jonah 2>&1"
  $m = [regex]::Match(($out -join ' '), '\[(\d+)/(\d+)')
  if ($m.Success) { "$($m.Groups[1].Value)/$($m.Groups[2].Value)" } else { 'n/a' }
}
$next = (Get-Date).AddMinutes(5)
while ($true) {
  $siso = Get-Process siso -ErrorAction SilentlyContinue
  $free = [math]::Round((Get-Volume -DriveLetter C).SizeRemaining / 1GB, 1)
  if ($free -lt 25) {
    if ($siso) { $siso | Stop-Process -Force }
    Add-Content $log "- [progress] $(Get-Date -Format 'yyyy-MM-dd HH:mm') **PAUSED: C: free $free GB < 25 GB** - build stopped, owner must free space, then re-run step4-build.cmd"
    "LOW DISK $free GB - build paused"
    exit 2
  }
  if (-not $siso) { "build process ended"; exit 0 }
  if ((Get-Date) -ge $next) {
    $ram = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
    Add-Content $log ("- [progress] {0} [{1}] C: free {2} GB, RAM free {3} GB, elapsed {4:N1} h" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), (Progress), $free, $ram, ((Get-Date) - $start).TotalHours)
    $next = (Get-Date).AddHours(2)
  }
  Start-Sleep 60
}
