# A tiny Windows Forms app used ONLY by the pointing tests (Noah/test/unit/desktop-pointing-real.test.cjs): named buttons and an unnamed solid red square at known places,
# and one label that says what was clicked last. It closes itself after -Seconds, whatever happens to the test.
param([string]$Token = 'pointing', [int]$Seconds = 150, [int]$Left = 120, [int]$Top = 100)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Noah Pointing $Token"
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($Left, $Top)
$form.ClientSize = New-Object System.Drawing.Size(640, 380)
$form.BackColor = [System.Drawing.Color]::White

function Add-Control($c, [int]$x, [int]$y, [int]$w, [int]$h) {
  $c.Location = New-Object System.Drawing.Point($x, $y)
  $c.Size = New-Object System.Drawing.Size($w, $h)
  $form.Controls.Add($c)
  return $c
}

$out = Add-Control (New-Object System.Windows.Forms.Label) 20 20 600 30
$out.Text = 'nothing clicked'

$a = Add-Control (New-Object System.Windows.Forms.Button) 40 80 140 44
$a.Text = 'Alpha'
$b = Add-Control (New-Object System.Windows.Forms.Button) 250 80 140 44
$b.Text = 'Beta'
$g = Add-Control (New-Object System.Windows.Forms.Button) 460 80 140 44
$g.Text = 'Gamma'

# an unnamed solid red square: "something with no words", which can only be clicked by where it is in the picture
$red = Add-Control (New-Object System.Windows.Forms.Panel) 400 220 90 90
$red.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 0)

$a.Add_Click({ $out.Text = 'Alpha clicked' })
$b.Add_Click({ $out.Text = 'Beta clicked' })
$g.Add_Click({ $out.Text = 'Gamma clicked' })
$red.Add_MouseDown({ $out.Text = 'RED clicked' })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Seconds * 1000
$timer.Add_Tick({ $form.Close() })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
