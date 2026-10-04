# Used ONLY by Noah's real-window checks (Noah/bench/integration/desktop-guard-check.cjs, desktop-mission-check.cjs, desktop-web-check.cjs): presses a real keyboard chord or makes a real
# mouse click through Windows, the way a person's hand would, so a check can prove that something works for real (a fake event inside a program proves nothing about that).
#   -Op chord -Keys ctrl,alt,x      press the keys in order, release in reverse
#   -Op chord -Keys shift -Repeat 12 -EveryMs 250      the same, again and again (a user who keeps at the keyboard)
#   -Op click -X 100 -Y 200         move to this PHYSICAL screen point and left-click
#   -Op move -X 100 -Y 200          only move the pointer there
param([string]$Op, [string]$Keys = '', [int]$X = 0, [int]$Y = 0, [int]$Repeat = 1, [int]$EveryMs = 200)   # -File does not split 'ctrl,alt,x' into an array, so it is split below

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RealInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  // a REAL pointer movement (what a hand makes): SetCursorPos alone only teleports the pointer and sends no mouse event, so a program listening for movement hears nothing
  public static void Glide(int x, int y) {
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
    SetCursorPos(x, y);
    mouse_event(0x8001, (uint)(x * 65535L / Math.Max(1, w - 1)), (uint)(y * 65535L / Math.Max(1, h - 1)), 0, UIntPtr.Zero);
  }
}
"@

[void][RealInput]::SetProcessDPIAware()   # so X and Y are real screen pixels, not scaled ones

if ($Op -eq 'move') {
  [RealInput]::Glide($X, $Y)   # only move the pointer (no click)
  Write-Output 'moved'
} elseif ($Op -eq 'click') {
  [RealInput]::Glide($X, $Y)
  Start-Sleep -Milliseconds 250   # long enough for a program that reacts to the pointer arriving (a hover) to react before the click lands
  [RealInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # left down
  Start-Sleep -Milliseconds 60
  [RealInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # left up
  Write-Output 'clicked'
} elseif ($Op -eq 'chord') {
  $codes = @{ ctrl = 0x11; alt = 0x12; shift = 0x10; x = 0x58; a = 0x41 }
  $vks = @($Keys -split ',' | ForEach-Object { $c = $codes[$_.Trim().ToLower()]; if (-not $c) { Write-Error "unknown key '$_'"; exit 2 }; [byte]$c })
  for ($r = 0; $r -lt $Repeat; $r++) {
    foreach ($k in $vks) { [RealInput]::keybd_event($k, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
    Start-Sleep -Milliseconds 80
    for ($i = $vks.Count - 1; $i -ge 0; $i--) { [RealInput]::keybd_event($vks[$i], 0, 0x0002, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
    if ($r -lt $Repeat - 1) { Start-Sleep -Milliseconds $EveryMs }
  }
  Write-Output 'pressed'
} else {
  Write-Error "unknown -Op '$Op'"
  exit 2
}
