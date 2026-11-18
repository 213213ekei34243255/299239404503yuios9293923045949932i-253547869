# Test helper: brings the Jonah test window to the front at a fixed place (40,40 1300x820), clicks at a point INSIDE it
# (coordinates relative to the window), waits, and screenshots it without changing focus (so open drop-downs stay open).
# Refuses to click if the Jonah window is not the foreground window.
param([string]$Exe, [string]$Out, [int]$RelX = -1, [int]$RelY = -1, [int]$WaitMs = 2500)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class JT {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public struct RECT { public int L, T, R, B; }
}
"@
$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { "no window"; exit 1 }
$h = $p.MainWindowHandle
[JT]::ShowWindow($h, 9) | Out-Null
[JT]::MoveWindow($h, 40, 40, 1300, 820, $true) | Out-Null
[JT]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
if ($RelX -ge 0) {
  if ([JT]::GetForegroundWindow() -ne $h) { "Jonah is not in front - not clicking"; exit 2 }
  [JT]::SetCursorPos(40 + $RelX, 40 + $RelY) | Out-Null
  Start-Sleep -Milliseconds 150
  [JT]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [JT]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
Start-Sleep -Milliseconds $WaitMs
$r = New-Object JT+RECT
[JT]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap 1300, 820
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"saved $Out"
