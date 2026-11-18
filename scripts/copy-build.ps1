# Copies the files Jonah needs to run (list from `gn desc out\Jonah //chrome:chrome runtime_deps`)
# from C:\src\chromium\src\out\Jonah to D:\Jonah-Chromium\jonah-build. Debug symbol files (.pdb) are skipped.
param([string]$Src = 'C:\src\chromium\src\out\Jonah', [string]$Dst = 'D:\Jonah-Chromium\jonah-build', [string]$List = 'D:\Jonah-Chromium\scripts\chrome-runtime-deps.txt')
$src  = $Src
$dst  = $Dst
$files = @(Get-Content -LiteralPath $List)  # (not $list: PowerShell names ignore case, and $List is the [string] parameter)
$n = 0; $bytes = 0; $bad = 0
foreach ($f in $files) {
  if ($f -notmatch '^[\w./+-]+$' -or $f -like '*.pdb' -or $f -like '../*') { continue }
  $s = Join-Path $src $f
  if (-not (Test-Path -LiteralPath $s -PathType Leaf)) { continue }
  $d = Join-Path $dst $f
  # skip files that are already up to date in the copy (same size and not older)
  $si = Get-Item -LiteralPath $s
  if (Test-Path -LiteralPath $d -PathType Leaf) {
    $di = Get-Item -LiteralPath $d
    if ($di.Length -eq $si.Length -and $di.LastWriteTime -ge $si.LastWriteTime) { continue }
  }
  $dir = Split-Path $d -Parent
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  try { Copy-Item -LiteralPath $s -Destination $d -Force -ErrorAction Stop; $n++; $bytes += (Get-Item -LiteralPath $s).Length }
  catch { $bad++; "COPY FAILED: $f : $($_.Exception.Message)" }
}
"copied $n files, {0:N0} MB, failed $bad" -f ($bytes/1MB)
if ($bad -gt 0) { exit 1 }
