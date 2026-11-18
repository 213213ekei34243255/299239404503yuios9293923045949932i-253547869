# noah-elevated-host.ps1 - administrator access for Noah's computer helper (optional, OFF by default; the user turns it on in Noah's panel).
#
# Windows keeps a normal program from reading or operating the windows of a program that runs as administrator (installers, Task Manager,
# some games and editors). Electron Jonah's answer was to restart the WHOLE of Jonah as administrator. Jonah on Chromium elevates only this:
# Electron's Windows helper (Noah\desktop\NoahDesktop.cs, the same requests as host.ps1), started through Windows' own permission prompt
# (UAC). The browser and web pages keep running normally.
#
# It talks to noah-native-host.cjs over a private named pipe instead of stdin/stdout (an elevated process cannot inherit a normal
# process's pipes). The first line it receives must be the one-time token it was started with, so it only ever obeys the Noah that
# started it. When that pipe closes (Stop, Ctrl+Alt+X, Jonah closed) it exits AT ONCE, even in the middle of typing.
param([Parameter(Mandatory = $true)][string]$Pipe, [Parameter(Mandatory = $true)][string]$Token, [Parameter(Mandatory = $true)][string]$HostDir)
$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
public static class NoahElevatedPipe {
  static NamedPipeClientStream pipe; static StreamWriter writer;
  static BlockingCollection<string> lines = new BlockingCollection<string>();
  public static bool Connect(string name, string token) {
    // Asynchronous (overlapped): with a synchronous pipe handle Windows lets only one I/O run at a time, so the reader thread's
    // pending ReadLine would block every reply this helper writes
    pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
    pipe.Connect(15000);
    var reader = new StreamReader(pipe, new UTF8Encoding(false));
    writer = new StreamWriter(pipe, new UTF8Encoding(false)); writer.AutoFlush = true; writer.NewLine = "\n";
    if (reader.ReadLine() != token) return false;
    var t = new Thread(() => {
      try { string l; while ((l = reader.ReadLine()) != null) lines.Add(l); } catch { }
      Environment.Exit(0); // Noah let go of the pipe: stop now, whatever this helper is doing
    });
    t.IsBackground = true; t.Start();
    return true;
  }
  public static string Next() { return lines.Take(); }
  public static void Send(string s) { lock (writer) { writer.WriteLine(s); } }
}
'@

if (-not [NoahElevatedPipe]::Connect($Pipe, $Token)) { exit 2 }

$code = [System.IO.File]::ReadAllText((Join-Path $HostDir 'NoahDesktop.cs'))
Add-Type -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase' -TypeDefinition $code -Language CSharp
[NoahDesktop]::Init()
[NoahElevatedPipe]::Send('{"ready":true,"elevated":true}')

# from here on: exactly host.ps1's loop
while ($true) {
  $line = [NoahElevatedPipe]::Next()
  if ($line.Trim().Length -eq 0) { continue }
  if ($line -match '"op"\s*:\s*"apps"') {
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
  [NoahElevatedPipe]::Send($resp)
}
