# Step 2 admin tasks for the Jonah-Chromium build. Runs elevated (one UAC prompt).
# Approved by owner 2026-11-16: Defender exclusion for C:\src, depot_tools first in system PATH,
# DEPOT_TOOLS_WIN_TOOLCHAIN=0, install VS 2026 Community (C++ + ATL/MFC) and Windows SDK 10.0.28000.2270.
$ErrorActionPreference = 'Continue'
$log = 'D:\Jonah-Chromium\scripts\step2-admin.log'
function L($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Tee-Object -FilePath $log -Append }

L "=== start (elevated) ==="

# 1. Defender exclusion for C:\src only
try { Add-MpPreference -ExclusionPath 'C:\src' -ErrorAction Stop; L "Defender exclusion added: C:\src" } catch { L "Defender exclusion FAILED: $_" }
L ("Defender exclusions now: " + ((Get-MpPreference).ExclusionPath -join '; '))

# 2. depot_tools first in the SYSTEM PATH (back up the old value first, keep REG_EXPAND_SZ)
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$old = (Get-Item $key).GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
L "OLD system PATH: $old"
if (($old -split ';') -notcontains 'C:\src\depot_tools') {
  Set-ItemProperty -Path $key -Name Path -Value ("C:\src\depot_tools;" + $old) -Type ExpandString
  L "system PATH: prepended C:\src\depot_tools"
} else { L "system PATH already contains C:\src\depot_tools" }

# 3. DEPOT_TOOLS_WIN_TOOLCHAIN=0 (machine-wide; this call also broadcasts the environment change)
[Environment]::SetEnvironmentVariable('DEPOT_TOOLS_WIN_TOOLCHAIN', '0', 'Machine')
L "DEPOT_TOOLS_WIN_TOOLCHAIN=0 set (Machine)"

# 4. Visual Studio 2026 Community - exactly the components Chromium's guide lists
L "VS 2026 install starting"
$t = Get-Date
$p = Start-Process -FilePath 'D:\Jonah-Chromium\downloads\vs2026\vs_Community.exe' -ArgumentList @(
  '--add','Microsoft.VisualStudio.Workload.NativeDesktop',
  '--add','Microsoft.VisualStudio.Component.VC.ATLMFC',
  '--includeRecommended','--passive','--wait','--norestart') -Wait -PassThru
L ("VS 2026 install exit code {0} after {1:N0} min (0 = ok, 3010 = ok but restart needed)" -f $p.ExitCode, ((Get-Date)-$t).TotalMinutes)

# 5. Windows SDK 10.0.28000.2270 - all features (includes Debugging Tools for Windows)
L "Windows SDK install starting"
$t = Get-Date
$p = Start-Process -FilePath 'D:\Jonah-Chromium\downloads\winsdk\winsdksetup.exe' -ArgumentList @(
  '/features','+','/quiet','/norestart','/log','D:\Jonah-Chromium\scripts\winsdk-install.log') -Wait -PassThru
L ("Windows SDK install exit code {0} after {1:N0} min (0 = ok, 3010 = ok but restart needed)" -f $p.ExitCode, ((Get-Date)-$t).TotalMinutes)

L "=== done ==="
