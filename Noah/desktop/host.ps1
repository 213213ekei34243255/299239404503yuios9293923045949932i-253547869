# Noah/desktop/host.ps1
#
# A long-lived helper: compiles NoahDesktop.cs once, then answers one JSON request per line on stdin with one JSON reply per line on stdout.
# It is started (and stopped) by bridge.cjs; nothing here decides what Noah may do. That is policy.cjs, in Node, before a request is ever sent.
#
# The protocol is ASCII only in both directions (non-ASCII is sent as \uXXXX), so no console encoding setting can garble a title or a typed word.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$code = [System.IO.File]::ReadAllText((Join-Path $here 'NoahDesktop.cs'))
Add-Type -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase' -TypeDefinition $code -Language CSharp
[NoahDesktop]::Init()

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  if ($line -match '"op"\s*:\s*"apps"') {
    # the installed apps in the Start menu: only PowerShell knows how to list them
    $id = 0
    try {
      $req = $line | ConvertFrom-Json
      $id = $req.id
      $apps = @(Get-StartApps | ForEach-Object { @{ name = [string]$_.Name; id = [string]$_.AppID } })
      $json = ConvertTo-Json -InputObject $apps -Compress -Depth 4
      $resp = [NoahDesktop]::Ascii('{"id":' + $id + ',"ok":true,"result":' + $json + '}')
    } catch {
      $resp = '{"id":' + $id + ',"ok":false,"code":"error","error":"could not list the installed apps"}'
    }
  } else {
    $resp = [NoahDesktop]::Handle($line)
  }
  [Console]::Out.WriteLine($resp)
  [Console]::Out.Flush()
}
