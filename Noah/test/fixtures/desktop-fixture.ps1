# A tiny Windows Forms app used ONLY by the desktop tests (Noah/test/unit/desktop-bridge.test.cjs). It stands in for "a real application" so the tests can
# read it, click it and type into it without ever touching a program the user owns. It closes itself after -Seconds, whatever happens to the test.
param([string]$Token = 'fixture', [int]$Seconds = 150, [int]$Left = 120, [int]$Top = 120)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Noah Fixture $Token"
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($Left, $Top)
$form.ClientSize = New-Object System.Drawing.Size(420, 300)

function Add-Control($c, [int]$x, [int]$y, [int]$w, [int]$h) {
  $c.Location = New-Object System.Drawing.Point($x, $y)
  $c.Size = New-Object System.Drawing.Size($w, $h)
  $form.Controls.Add($c)
  return $c
}

$lblName = Add-Control (New-Object System.Windows.Forms.Label) 20 22 85 22
$lblName.Text = 'Your name'
$txt = Add-Control (New-Object System.Windows.Forms.TextBox) 110 18 280 24
$txt.AccessibleName = 'Name field'
$txt.TabIndex = 0

$pw = Add-Control (New-Object System.Windows.Forms.TextBox) 110 52 280 24
$pw.UseSystemPasswordChar = $true
$pw.Text = 'hunter2-fixture-secret'
$pw.AccessibleName = 'Second entry'
$pw.TabIndex = 1

$btn = Add-Control (New-Object System.Windows.Forms.Button) 110 90 120 30
$btn.Text = 'Greet'
$btn.TabIndex = 2

$chk = Add-Control (New-Object System.Windows.Forms.CheckBox) 110 130 200 24
$chk.Text = 'I agree'
$chk.TabIndex = 3

$del = Add-Control (New-Object System.Windows.Forms.Button) 250 90 140 30
$del.Text = 'Delete everything'
$del.TabIndex = 4

$out = Add-Control (New-Object System.Windows.Forms.Label) 20 175 380 30
$out.Text = '(nothing yet)'

$tok = Add-Control (New-Object System.Windows.Forms.TextBox) 110 215 280 24
$tok.AccessibleName = 'API token'
$tok.Text = 'tok-visible-test-value'
$tok.TabIndex = 5

$btn.Add_Click({ $out.Text = 'Hello ' + $txt.Text })
$del.Add_Click({ $out.Text = 'DELETED' })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Seconds * 1000
$timer.Add_Tick({ $form.Close() })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
