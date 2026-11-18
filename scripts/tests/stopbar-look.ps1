# Shows Noah's Stop bar for a few seconds with sample words and saves a picture of ONLY the bar's own rectangle (bottom right
# of the main screen) - to check its look. Nothing else on the screen is captured.
param([string]$Out)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$psi = New-Object System.Diagnostics.ProcessStartInfo 'powershell.exe', '-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File "D:\Jonah-Chromium\scripts\jonah-ext-src\native\noah-stop-bar.ps1"'
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$in = New-Object System.IO.StreamWriter($p.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding($false)))
$in.AutoFlush = $true
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$rect = New-Object System.Drawing.Rectangle ($wa.Right - 420 - 16 - 12), ($wa.Bottom - 50 - 12 - 12), (420 + 24), (50 + 24)
function Snap($name) {
  Start-Sleep -Milliseconds 900
  $bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size); $g.Dispose()
  $bmp.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$in.WriteLine('arm')
$in.WriteLine('show Read Gmail - Personal - Microsoft Edge (26 controls) - Caf' + [char]0xE9)
Snap 'bar-working.png'
$in.WriteLine('ask Noah needs your OK in Jonah')
Snap 'bar-asking.png'
$in.WriteLine('quit')
$p.WaitForExit(5000) | Out-Null
"hotkey: " + $p.StandardOutput.ReadLine()
