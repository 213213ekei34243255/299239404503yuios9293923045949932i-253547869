# Test helper: clicks at a point (relative to the Jonah test window at 40,40) WITHOUT re-focusing the window, so an open
# drop-down menu stays open - but only if the foreground window belongs to the Jonah test program. Then screenshots.
param([string]$Exe, [string]$Out, [int]$RelX, [int]$RelY, [int]$WaitMs = 3000)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class JP {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
$pid0 = 0; [JP]::GetWindowThreadProcessId([JP]::GetForegroundWindow(), [ref]$pid0) | Out-Null
$path = (Get-Process -Id $pid0 -ErrorAction SilentlyContinue).Path
if ($path -ne $Exe) { "foreground is not Jonah ($path) - not clicking"; exit 2 }
[JP]::SetCursorPos(40 + $RelX, 40 + $RelY) | Out-Null
Start-Sleep -Milliseconds 150
[JP]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[JP]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds $WaitMs
$bmp = New-Object System.Drawing.Bitmap 1300, 820
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(40, 40, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"saved $Out"
