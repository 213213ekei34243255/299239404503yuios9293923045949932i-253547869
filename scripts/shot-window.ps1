# Takes a screenshot of the newest Jonah window (to compare the UI with the owner's design).
# Usage: shot-window.ps1 <exe path> <output png> [click-chat]
param([string]$Exe, [string]$Out, [switch]$NoActivate)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class JW {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  public struct RECT { public int L, T, R, B; }
}
"@
$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { "no window"; exit 1 }
$h = $p.MainWindowHandle
if (-not $NoActivate) {
  [JW]::ShowWindow($h, 9) | Out-Null
  [JW]::MoveWindow($h, 40, 40, 1300, 820, $true) | Out-Null
  [JW]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 1500
}
$r = New-Object JW+RECT
[JW]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"saved $Out ${w}x${hh}"
