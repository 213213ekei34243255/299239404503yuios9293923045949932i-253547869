# noah-stop-bar.ps1 - the Stop bar and Ctrl+Alt+X while Noah works on the computer (Electron Jonah: an always-on-top BrowserWindow +
# globalShortcut, Noah/desktop/guard.cjs). Started by noah-native-host.cjs; one UTF-8 command per line on stdin:
#   arm            register Ctrl+Alt+X (stops the task from any program)
#   show <text>    show the bar (bottom right, above the taskbar) with what Noah is doing
#   text <text>    change the words
#   ask <text>     Noah waits for the user's OK: the words change and a "Review" button appears (brings Jonah forward)
#   unask          the OK was given (or refused): Review goes away
#   hide           hide the bar (the shortcut stays while the task runs)
#   quit           release the shortcut and exit
# It writes "stop" (Stop button or Ctrl+Alt+X), "review" (Review button), and "hotkey ok" / "hotkey busy" after arm.
# The bar never takes the keyboard focus, and the mouse passes through it everywhere except over its buttons.
# Look: a dark rounded pill (Windows 11 rounds the window itself; older Windows get a rounded window shape) with round buttons.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -Language CSharp -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Round {
  public static GraphicsPath Rect(RectangleF r, float radius) {
    var p = new GraphicsPath(); float d = radius * 2;
    if (d > r.Height) d = r.Height; if (d > r.Width) d = r.Width;
    p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure(); return p;
  }
}

// a round, anti-aliased pill button that never takes the focus
public class PillButton : Control {
  public Color Fill = Color.FromArgb(239, 68, 68), FillHover = Color.FromArgb(248, 96, 96);
  bool hover;
  public PillButton() {
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
    SetStyle(ControlStyles.Selectable, false);
    Cursor = Cursors.Hand; ForeColor = Color.White; Font = new Font("Segoe UI Semibold", 9f);
  }
  public void PerformClickForTest() { OnClick(EventArgs.Empty); }
  protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
  protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    g.Clear(Parent != null ? Parent.BackColor : BackColor);
    using (var path = Round.Rect(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Height / 2f))
    using (var b = new SolidBrush(hover ? FillHover : Fill)) g.FillPath(b, path);
    TextRenderer.DrawText(g, Text, Font, ClientRectangle, ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
  }
}

public class NoahStopBar : Form {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
  const int GWL_EXSTYLE = -20, WS_EX_TRANSPARENT = 0x20, WS_EX_LAYERED = 0x80000, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOPMOST = 0x8;
  const int DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2, DWMWA_BORDER_COLOR = 34;
  const uint MOD_ALT = 1, MOD_CONTROL = 2, MOD_NOREPEAT = 0x4000;
  const int HOTKEY_ID = 0x4E4F; // "NO"
  static readonly Color Bg = Color.FromArgb(22, 16, 36), Purple = Color.FromArgb(168, 85, 247);
  string words = "Noah is using your computer"; bool asking;
  PillButton stop, review; System.Windows.Forms.Timer pointer; bool hotkey; bool through = true; bool dwmRound;

  public NoahStopBar() {
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
    BackColor = Bg; Size = new Size(420, 50); Opacity = 0.97; Text = "Noah is working";
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
    stop = new PillButton { Text = "Stop", Size = new Size(76, 32), Location = new Point(Width - 76 - 10, 9) };
    stop.Click += (s, e) => Say("stop");
    review = new PillButton { Text = "Review", Size = new Size(80, 32), Location = new Point(Width - 76 - 10 - 80 - 8, 9), Visible = false,
                              Fill = Color.FromArgb(124, 58, 237), FillHover = Color.FromArgb(147, 92, 246) };
    review.Click += (s, e) => Say("review");
    Controls.Add(stop); Controls.Add(review);
    pointer = new System.Windows.Forms.Timer { Interval = 25 };
    pointer.Tick += (s, e) => {
      if (!Visible) return;
      bool over = Hit(stop) || (review.Visible && Hit(review));
      if (over == !through) return;
      through = !over;
      int ex = GetWindowLong(Handle, GWL_EXSTYLE);
      SetWindowLong(Handle, GWL_EXSTYLE, through ? (ex | WS_EX_TRANSPARENT) : (ex & ~WS_EX_TRANSPARENT));
    };
    pointer.Start();
  }
  bool Hit(Control c) { var r = c.RectangleToScreen(c.ClientRectangle); r.Inflate(4, 4); return r.Contains(Cursor.Position); }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { var cp = base.CreateParams; cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT; return cp; }
  }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    int pref = DWMWCP_ROUND;
    try { dwmRound = DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, 4) == 0 && Environment.OSVersion.Version.Build >= 22000; } catch { dwmRound = false; }
    try { int border = Purple.R | (Purple.G << 8) | (Purple.B << 16); DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref border, 4); } catch { }
    if (!dwmRound) using (var p = Round.Rect(new RectangleF(0, 0, Width, Height), 14)) Region = new Region(p); // Windows 10: rounded shape
  }
  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    g.Clear(Bg);
    if (!dwmRound) using (var p = Round.Rect(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 14)) using (var pen = new Pen(Color.FromArgb(110, Purple), 1f)) g.DrawPath(pen, p);
    using (var dot = new SolidBrush(asking ? Color.FromArgb(245, 158, 11) : Purple)) g.FillEllipse(dot, 16, Height / 2 - 5, 10, 10);
    int right = (review.Visible ? review.Left : stop.Left) - 10;
    var textRect = new Rectangle(36, 0, Math.Max(40, right - 36), Height);
    TextRenderer.DrawText(g, words, new Font("Segoe UI", 9.5f), textRect, Color.FromArgb(239, 234, 254),
      TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312 && (int)m.WParam == HOTKEY_ID) Say("stop"); // WM_HOTKEY
    base.WndProc(ref m);
  }
  // stdin/stdout are opened directly (not through Console.In/Console.Out: in .NET Framework a thread blocked in Console.In.ReadLine
  // can hold up Console.Out on another thread, so "stop" never reached Noah)
  static System.IO.StreamWriter output;
  static readonly object outLock = new object();
  internal static void Say(string s) { lock (outLock) { if (output != null) { output.Write(s + "\n"); output.Flush(); } } }
  void Place() {
    var wa = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(wa.Right - Width - 16, wa.Bottom - Height - 12);
  }
  public void Command(string line) {
    string cmd = line, arg = "";
    int sp = line.IndexOf(' ');
    if (sp > 0) { cmd = line.Substring(0, sp); arg = line.Substring(sp + 1); }
    switch (cmd) {
      case "arm":
        if (!hotkey) hotkey = RegisterHotKey(Handle, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, (uint)Keys.X);
        Say(hotkey ? "hotkey ok" : "hotkey busy");
        break;
      case "show": if (arg.Length > 0 && !asking) words = arg; Place(); if (!Visible) Show(); Invalidate(); break;
      case "text": if (arg.Length > 0 && !asking) { words = arg; Invalidate(); } break;
      case "ask": asking = true; if (arg.Length > 0) words = arg; review.Visible = true; Place(); if (!Visible) Show(); Invalidate(); break;
      case "unask": asking = false; review.Visible = false; words = "Noah is using your computer"; Invalidate(); break;
      case "hide": Hide(); break;
      case "ping": Say("pong"); break; // answered from the window's own thread, the same way a Stop click is
      case "click-stop": stop.PerformClickForTest(); break; // tests only: the Stop button's own click path

      case "quit": Quit(); break;
    }
  }
  void Quit() { if (hotkey) { UnregisterHotKey(Handle, HOTKEY_ID); hotkey = false; } Application.ExitThread(); }

  public static void Run() {
    var utf8 = new System.Text.UTF8Encoding(false);
    output = new System.IO.StreamWriter(Console.OpenStandardOutput(), utf8);
    var input = new System.IO.StreamReader(Console.OpenStandardInput(), utf8);
    var bar = new NoahStopBar();
    var h = bar.Handle; // create the window (needed for the hotkey) without showing it
    var reader = new Thread(() => {
      string line;
      while ((line = input.ReadLine()) != null) {
        var l = line.Trim();
        if (l.Length == 0) continue;
        try { bar.BeginInvoke((Action)(() => bar.Command(l))); } catch { return; }
        if (l == "quit") return;
      }
      try { bar.BeginInvoke((Action)(() => bar.Command("quit"))); } catch { } // Noah's process is gone
    });
    reader.IsBackground = true;
    reader.Start();
    Application.Run();
  }
}
'@
[NoahStopBar]::Run()
