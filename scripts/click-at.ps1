# Clicks once at a screen position (used only to test Jonah's own test window).
param([int]$X, [int]$Y)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class JC {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[JC]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 200
[JC]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[JC]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
"clicked $X,$Y"
