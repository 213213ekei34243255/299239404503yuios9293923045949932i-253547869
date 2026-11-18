# noah-ocr.ps1 - reads the text in a screenshot with Windows' own OCR engine (Windows.Media.Ocr: built into Windows 10/11, offline,
# nothing downloaded). Electron Jonah used tesseract.js for this (an npm package that downloads its language data on first use);
# noah-native-host.cjs puts this in its place, with the same answer: lines of text, each with its box and its words' boxes,
# in the screenshot's own pixels.
# Long-lived: one image file path per line on stdin, one JSON line on stdout (ASCII only: non-ASCII as \uXXXX).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(30000)
  $task.Result
}
function Ascii([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $s.ToCharArray()) { if ([int]$c -lt 32 -or [int]$c -gt 126) { [void]$sb.AppendFormat('\u{0:x4}', [int]$c) } elseif ($c -eq '"' -or $c -eq '\') { [void]$sb.Append('\').Append($c) } else { [void]$sb.Append($c) } }
  $sb.ToString()
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $lang = New-Object Windows.Globalization.Language 'en-US'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
}
if ($null -eq $engine) { [Console]::Out.WriteLine('{"ready":false,"error":"Windows has no OCR language installed"}'); [Console]::Out.Flush(); exit 1 }
[Console]::Out.WriteLine('{"ready":true,"language":"' + (Ascii $engine.RecognizerLanguage.LanguageTag) + '"}')
[Console]::Out.Flush()

while ($true) {
  $path = [Console]::In.ReadLine()
  if ($null -eq $path) { break }
  $path = $path.Trim()
  if ($path.Length -eq 0) { continue }
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in $result.Lines) {
      $words = New-Object System.Collections.Generic.List[string]
      $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = 0; $y1 = 0
      foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        if ($r.X -lt $x0) { $x0 = $r.X }; if ($r.Y -lt $y0) { $y0 = $r.Y }
        if ($r.X + $r.Width -gt $x1) { $x1 = $r.X + $r.Width }; if ($r.Y + $r.Height -gt $y1) { $y1 = $r.Y + $r.Height }
        $words.Add('{"text":"' + (Ascii $w.Text) + '","rect":{"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"width":' + [int]$r.Width + ',"height":' + [int]$r.Height + '}}')
      }
      if ($words.Count -eq 0) { continue }
      $lines.Add('{"text":"' + (Ascii $line.Text) + '","rect":{"x":' + [int]$x0 + ',"y":' + [int]$y0 + ',"width":' + [int]($x1 - $x0) + ',"height":' + [int]($y1 - $y0) + '},"words":[' + ($words -join ',') + ']}')
    }
    $stream.Dispose()
    [Console]::Out.WriteLine('{"ok":true,"lines":[' + ($lines -join ',') + ']}')
  } catch {
    [Console]::Out.WriteLine('{"ok":false,"error":"' + (Ascii $_.Exception.Message) + '"}')
  }
  [Console]::Out.Flush()
}
