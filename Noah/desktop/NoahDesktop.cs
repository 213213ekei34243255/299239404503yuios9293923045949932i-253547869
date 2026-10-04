// Noah/desktop/NoahDesktop.cs
//
// Noah's eyes and hands on the Windows desktop. Compiled once by host.ps1 (Add-Type, C# 5) and driven by the Node bridge (bridge.cjs) over JSON lines.
//
//   EYES   windows     the visible top-level windows (title, program, position, which one is in front)
//          tree        what is INSIDE a window, read through Windows UI Automation: named buttons, fields, menus, their state and value
//                      (password fields are flagged and their value is never read)
//          screenshot  a picture of a window or the whole screen
//   HANDS  focus, click (a control's own action when it has one, else a real mouse click), setText, type, key, launch, close
//
// Every action that sends keys or mouse input first checks that the target window is IN FRONT, so input never lands in whatever the user clicked
// on a moment ago. Typing into a password field is refused here, not only in the layer above. What Noah may do at all is decided by the policy
// layer in Node (policy.cjs); this file does what it is asked, carefully, and reports exactly what happened.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

public class DesktopError : Exception
{
    public string Code;
    public DesktopError(string code, string message) : base(message) { Code = code; }
}

public static class NoahDesktop
{
    // ------------------------------------------------------------------------------------------------------------------------ native
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDED = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4;
    const uint MOUSEEVENTF_MOVE = 1, MOUSEEVENTF_LEFTDOWN = 2, MOUSEEVENTF_LEFTUP = 4, MOUSEEVENTF_RIGHTDOWN = 8, MOUSEEVENTF_RIGHTUP = 0x10, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;

    // ------------------------------------------------------------------------------------------------------------------------ plumbing
    static readonly Dictionary<string, AutomationElement> Cache = new Dictionary<string, AutomationElement>();
    static int _elementCounter = 0;
    static readonly object CacheLock = new object();

    public static void Init()
    {
        try { SetProcessDPIAware(); } catch { } // real pixels: the same numbers in window rectangles, UI Automation, screenshots and mouse input
    }

    public static string Ascii(string s)
    {
        var sb = new StringBuilder(s.Length + 16);
        foreach (char c in s)
        {
            if (c < 127) sb.Append(c);
            else sb.Append("\\u").Append(((int)c).ToString("x4"));
        }
        return sb.ToString();
    }

    static string Str(Dictionary<string, object> a, string k, string d = null) { object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : d; }
    static int Int(Dictionary<string, object> a, string k, int d) { object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : d; }
    static long Long(Dictionary<string, object> a, string k, long d) { object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToInt64(v) : d; }
    static bool Bool(Dictionary<string, object> a, string k, bool d) { object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToBoolean(v) : d; }

    static string Reply(JavaScriptSerializer js, object id, bool ok, object result, string code, string error)
    {
        var d = new Dictionary<string, object>();
        d["id"] = id;
        d["ok"] = ok;
        if (ok) d["result"] = result; else { d["code"] = code; d["error"] = error; }
        return Ascii(js.Serialize(d));
    }

    /// <summary>One request line in, one reply line out. Every operation runs on its own thread with a time limit, so one stuck application cannot freeze Noah.</summary>
    public static string Handle(string requestJson)
    {
        var js = new JavaScriptSerializer();
        js.MaxJsonLength = int.MaxValue;
        js.RecursionLimit = 200;
        object id = null;
        try
        {
            var req = js.Deserialize<Dictionary<string, object>>(requestJson);
            if (req.ContainsKey("id")) id = req["id"];
            string op = Str(req, "op", "");
            var args = req.ContainsKey("args") ? req["args"] as Dictionary<string, object> : null;
            if (args == null) args = new Dictionary<string, object>();
            object result = null;
            Exception err = null;
            var t = new Thread(() => { try { result = Dispatch(op, args); } catch (Exception e) { err = e; } });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA); // UI Automation must not be called from a single-threaded apartment with a message loop
            t.Start();
            int timeout = Int(args, "timeoutMs", 20000);
            if (!t.Join(timeout)) return Reply(js, id, false, null, "timeout", "the application did not answer within " + (timeout / 1000) + " seconds");
            if (err != null)
            {
                var de = err as DesktopError;
                return Reply(js, id, false, null, de != null ? de.Code : "error", err.Message);
            }
            return Reply(js, id, true, result, null, null);
        }
        catch (Exception e)
        {
            return Reply(js, id, false, null, "bad_request", e.Message);
        }
    }

    static object Dispatch(string op, Dictionary<string, object> a)
    {
        switch (op)
        {
            case "ping": return "pong";
            case "windows": return Windows(Bool(a, "all", false));
            case "tree": return Tree(a);
            case "screenshot": return Screenshot(a);
            case "focus": return Focus(a);
            case "click": return Click(a);
            case "setText": return SetText(a);
            case "type": return TypeText(a);
            case "key": return Key(a);
            case "launch": return Launch(a);
            case "close": return CloseWindow(a);
            case "cursor": return CursorPos();
            case "waitWindow": return WaitWindow(a);
            case "scroll": return Scroll(a);
            case "interactive": return Interactive(a);
            case "elementAt": return ElementAt(a);
            case "userIdle": return UserIdle(a);
            default: throw new DesktopError("unknown_op", "unknown operation '" + op + "'");
        }
    }

    // ------------------------------------------------------------------------------------------------------------------------ windows
    static string Title(IntPtr h)
    {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static void Proc(uint pid, out string name, out string path)
    {
        name = ""; path = "";
        try
        {
            var p = Process.GetProcessById((int)pid);
            name = p.ProcessName;
            try { path = p.MainModule.FileName; } catch { } // a program running as administrator will not tell us
        }
        catch { }
    }

    static Dictionary<string, object> WinInfo(IntPtr h, IntPtr fg)
    {
        RECT r; GetWindowRect(h, out r);
        uint pid; GetWindowThreadProcessId(h, out pid);
        string name, path; Proc(pid, out name, out path);
        var d = new Dictionary<string, object>();
        d["window"] = h.ToInt64();
        d["title"] = Title(h);
        d["class"] = ClassOf(h);
        d["pid"] = (long)pid;
        d["process"] = name;
        d["path"] = path;
        d["x"] = r.Left; d["y"] = r.Top; d["w"] = r.Right - r.Left; d["h"] = r.Bottom - r.Top;
        d["minimized"] = IsIconic(h);
        d["foreground"] = (fg == h) || (fg != IntPtr.Zero && GetAncestor(fg, 2) == h);
        return d;
    }

    static List<Dictionary<string, object>> Windows(bool all)
    {
        var list = new List<Dictionary<string, object>>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            int cloaked = 0;
            try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
            if (cloaked != 0) return true; // a hidden app-frame that Windows keeps around
            string title = Title(h);
            RECT r; GetWindowRect(h, out r);
            if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return true;
            if (!all)
            {
                if (title.Length == 0) return true;
                string cls = ClassOf(h);
                if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return true; // the desktop and the taskbar
            }
            list.Add(WinInfo(h, fg));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static IntPtr Hwnd(Dictionary<string, object> a, string key)
    {
        long v = Long(a, key, 0);
        if (v == 0) throw new DesktopError("no_window", "which window? give its number from the window list");
        var h = new IntPtr(v);
        if (!IsWindow(h)) throw new DesktopError("no_window", "that window no longer exists");
        return h;
    }

    static bool InFront(IntPtr h)
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return false;
        if (fg == h || GetAncestor(fg, 2) == h) return true;
        uint p1, p2;
        GetWindowThreadProcessId(fg, out p1);
        GetWindowThreadProcessId(h, out p2);
        return p1 == p2 && p1 != 0; // a dialog that belongs to the same program counts as in front
    }

    static void RequireFront(IntPtr h)
    {
        if (!InFront(h)) throw new DesktopError("not_foreground", "that window is not in front (something else took focus): bring it to the front first, then try again");
    }

    static object Focus(Dictionary<string, object> a)
    {
        IntPtr h = Hwnd(a, "window");
        IntPtr before = GetForegroundWindow(); // what the user was looking at
        if (IsIconic(h)) ShowWindow(h, 9);
        // Windows refuses to change the front window for a moment while another window is still starting up or being activated, so try a few times
        for (int attempt = 0; attempt < 4 && !InFront(h); attempt++)
        {
            if (attempt == 1) SwitchToThisWindow(h, true); // the other documented-by-use way to ask for the front, which needs no key presses
            else if (attempt == 2) { ShowWindow(h, 7); Thread.Sleep(60); ShowWindow(h, 9); } // minimise without activating, then restore: Windows activates a restored window
            if (attempt != 1)
            {
                uint tmp;
                uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out tmp);
                uint cur = GetCurrentThreadId();
                bool attached = false;
                if (fgThread != 0 && fgThread != cur) attached = AttachThreadInput(cur, fgThread, true);
                BringWindowToTop(h);
                SetForegroundWindow(h);
                if (attached) AttachThreadInput(cur, fgThread, false);
            }
            for (int i = 0; i < 12 && !InFront(h); i++) Thread.Sleep(50);
            if (!InFront(h)) Thread.Sleep(250);
        }
        if (!InFront(h)) throw new DesktopError("focus_failed", "Windows would not bring that window to the front");
        var info = WinInfo(h, GetForegroundWindow());
        if (before != IntPtr.Zero && before != h && IsWindow(before) && GetAncestor(before, 2) != h) info["previous"] = before.ToInt64();
        return info;
    }

    static object WaitWindow(Dictionary<string, object> a)
    {
        string needle = (Str(a, "title", "") ?? "").ToLowerInvariant();
        string proc = (Str(a, "process", "") ?? "").ToLowerInvariant();
        int wait = Int(a, "waitMs", 8000);
        var sw = Stopwatch.StartNew();
        while (true)
        {
            foreach (var w in Windows(false))
            {
                bool okTitle = needle.Length == 0 || ((string)w["title"]).ToLowerInvariant().Contains(needle);
                bool okProc = proc.Length == 0 || ((string)w["process"]).ToLowerInvariant() == proc;
                if (okTitle && okProc) return w;
            }
            if (sw.ElapsedMilliseconds > wait) throw new DesktopError("not_found", "no window like that appeared within " + (wait / 1000) + " seconds");
            Thread.Sleep(250);
        }
    }

    static object CloseWindow(Dictionary<string, object> a)
    {
        IntPtr h = Hwnd(a, "window");
        PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE: the same as the X button, so the program may ask "save changes?"
        Thread.Sleep(500);
        var d = new Dictionary<string, object>();
        d["closed"] = !IsWindow(h) || !IsWindowVisible(h);
        return d;
    }

    static object CursorPos()
    {
        POINT p; GetCursorPos(out p);
        var d = new Dictionary<string, object>();
        d["x"] = p.X; d["y"] = p.Y;
        return d;
    }

    // ------------------------------------------------------------------------------------------------------------------------ reading a window
    static readonly Regex SensitiveName = new Regex(@"pass(word|code)?|\bpin\b|\botp\b|\bcvv\b|card number|secret|token|api.?key", RegexOptions.IgnoreCase);

    static string Id(AutomationElement el)
    {
        lock (CacheLock)
        {
            if (Cache.Count > 6000) Cache.Clear();
            string id = "e" + (++_elementCounter);
            Cache[id] = el;
            return id;
        }
    }

    static AutomationElement El(string id)
    {
        AutomationElement el;
        lock (CacheLock) { if (!Cache.TryGetValue(id, out el)) el = null; }
        if (el == null) throw new DesktopError("stale", "unknown control '" + id + "': read the window again to get current control ids");
        try { var pid = el.Current.ProcessId; }
        catch { throw new DesktopError("stale", "that control is gone (the window changed): read the window again"); }
        return el;
    }

    static string TypeName(AutomationElement el)
    {
        string n = el.Current.ControlType.ProgrammaticName;
        int i = n.IndexOf('.');
        return i >= 0 ? n.Substring(i + 1) : n;
    }

    static bool Supports(AutomationElement el, AutomationPattern p)
    {
        object o;
        return el.TryGetCurrentPattern(p, out o);
    }

    static void Walk(AutomationElement el, int depth, int parent, List<Dictionary<string, object>> nodes, int maxDepth, int budget, int[] counter)
    {
        if (counter[0] >= budget || depth > maxDepth) return;
        var n = new Dictionary<string, object>();
        try
        {
            var c = el.Current;
            counter[0]++;
            string name = c.Name ?? "";
            if (name.Length > 140) name = name.Substring(0, 140) + "...";
            string type = TypeName(el);
            bool pw = c.IsPassword;
            n["element"] = Id(el);
            n["depth"] = depth;
            n["parent"] = parent;
            n["name"] = name;
            n["type"] = type;
            if (!string.IsNullOrEmpty(c.AutomationId)) n["autoId"] = c.AutomationId;
            n["enabled"] = c.IsEnabled;
            if (c.IsOffscreen) n["offscreen"] = true;
            if (c.HasKeyboardFocus) n["focused"] = true;
            if (pw) n["password"] = true;
            var r = c.BoundingRectangle;
            if (!r.IsEmpty && !double.IsInfinity(r.X) && !double.IsInfinity(r.Width)) { n["x"] = (int)r.X; n["y"] = (int)r.Y; n["w"] = (int)r.Width; n["h"] = (int)r.Height; }
            var pats = new List<string>();
            object po;
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out po)) pats.Add("invoke");
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out po)) { pats.Add("toggle"); n["toggle"] = ((TogglePattern)po).Current.ToggleState.ToString(); }
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out po)) { pats.Add("select"); n["selected"] = ((SelectionItemPattern)po).Current.IsSelected; }
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out po)) pats.Add("expand");
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out po))
            {
                var vp = (ValuePattern)po;
                pats.Add(vp.Current.IsReadOnly ? "value(read-only)" : "value");
                if (pw) n["value"] = "(hidden)";
                else if (type == "Edit" && (SensitiveName.IsMatch(name) || SensitiveName.IsMatch(c.AutomationId ?? ""))) n["value"] = "(hidden: looks sensitive)";
                else { string v = vp.Current.Value ?? ""; if (v.Length > 300) v = v.Substring(0, 300) + "..."; n["value"] = v; }
            }
            else if (!pw && (type == "Document" || type == "Edit") && el.TryGetCurrentPattern(TextPattern.Pattern, out po))
            {
                string v = ((TextPattern)po).DocumentRange.GetText(300) ?? "";
                n["value"] = v;
                pats.Add("text");
            }
            if (el.TryGetCurrentPattern(RangeValuePattern.Pattern, out po)) { pats.Add("range"); n["range"] = ((RangeValuePattern)po).Current.Value; }
            if (el.TryGetCurrentPattern(ScrollPattern.Pattern, out po)) pats.Add("scroll");
            n["actions"] = pats;
        }
        catch (ElementNotAvailableException) { return; }
        catch (InvalidOperationException) { return; }
        nodes.Add(n);
        int myIndex = nodes.Count - 1;
        AutomationElement child = null;
        try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { }
        while (child != null && counter[0] < budget)
        {
            Walk(child, depth + 1, myIndex, nodes, maxDepth, budget, counter);
            try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { child = null; }
        }
    }

    static object Tree(Dictionary<string, object> a)
    {
        IntPtr h = Hwnd(a, "window");
        var root = AutomationElement.FromHandle(h);
        WakeWeb(h, root);
        var nodes = new List<Dictionary<string, object>>();
        int budget = Math.Max(10, Math.Min(Int(a, "maxNodes", 250), 1500));
        int maxDepth = Math.Max(1, Math.Min(Int(a, "maxDepth", 8), 20));
        var counter = new int[] { 0 };
        Walk(root, 0, -1, nodes, maxDepth, budget, counter);
        var d = new Dictionary<string, object>();
        d["window"] = h.ToInt64();
        d["title"] = Title(h);
        d["nodes"] = nodes;
        d["truncated"] = counter[0] >= budget;
        return d;
    }

    // ------------------------------------------------------------------------------------------------------------------------ the user, and finding things fast
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);

    static uint _ownTick; // the "last input" tick that Windows recorded for what Noah itself sent last (0 = none yet)
    static void StampOwn() { _ownTick = LastInputTick(); } // read from Windows, not from our own clock: only then can ANY other value mean that someone else's input came in between

    static uint LastInputTick()
    {
        var li = new LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        return GetLastInputInfo(ref li) ? li.dwTime : 0;
    }

    // the USER has used the keyboard or mouse since Noah last did. Windows keeps ONE "last input" time (to ~15 ms), and Noah's own keystrokes a few ms apart would overwrite
    // the user's: so Noah remembers the exact value Windows gave for its own input, and any different value means someone else's input arrived in between.
    static bool UserTookOver()
    {
        if (_ownTick == 0) return false;
        uint last = LastInputTick();
        return last != 0 && last != _ownTick;
    }

    static void RequireNoUser()
    {
        if (UserTookOver()) throw new DesktopError("user_busy", "you started using the computer, so Noah stopped to stay out of your way");
    }

    /// <summary>How long since the USER last touched the keyboard or mouse. Input that Noah injected itself does not count: after Noah's own action the answer is "a long time".</summary>
    static object UserIdle(Dictionary<string, object> a)
    {
        var d = new Dictionary<string, object>();
        uint last = LastInputTick();
        bool ours = _ownTick != 0 && last != 0 && last == _ownTick;
        d["idleMs"] = ours ? 3600000L : (long)((uint)Environment.TickCount - last);
        d["own"] = ours;
        d["lastTick"] = (long)last; d["ownTick"] = (long)_ownTick;
        return d;
    }

    static readonly ControlType[] Interesting = new ControlType[] { ControlType.Button, ControlType.CheckBox, ControlType.ComboBox, ControlType.Edit, ControlType.Hyperlink, ControlType.ListItem, ControlType.MenuItem, ControlType.RadioButton, ControlType.TabItem, ControlType.TreeItem, ControlType.DataItem, ControlType.SplitButton, ControlType.Slider, ControlType.Spinner };

    static string TypeNameOf(ControlType ct)
    {
        string n = ct.ProgrammaticName;
        int i = n.IndexOf('.');
        return i >= 0 ? n.Substring(i + 1) : n;
    }

    // everything the list needs, fetched in ONE round trip per element instead of a dozen slow calls (a web page's controls took ~25 ms each that way)
    static CacheRequest InteractiveCache()
    {
        var cr = new CacheRequest();
        cr.TreeScope = TreeScope.Element;
        cr.Add(AutomationElement.NameProperty);
        cr.Add(AutomationElement.ControlTypeProperty);
        cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.IsEnabledProperty);
        cr.Add(AutomationElement.IsOffscreenProperty);
        cr.Add(AutomationElement.HasKeyboardFocusProperty);
        cr.Add(AutomationElement.IsPasswordProperty);
        return cr;
    }

    static bool Avail(AutomationElement el, AutomationProperty p)
    {
        try { return (bool)el.GetCachedPropertyValue(p); } catch (Exception) { return false; }
    }

    /// <summary>
    /// The controls below `el`, each fetched TOGETHER WITH its properties in one call (a cached tree walk). A web page's controls cost ~25 ms each when every property is a
    /// separate cross-process call; this is the fast path UI Automation documents. Subtrees that are scrolled out of view are skipped (long lists show only what is visible).
    /// </summary>
    // controls whose insides are not separately useful (a button's label, the texts of a chat row): not walked into. Each step into a web page costs ~50 ms, so this is most of the speed.
    static bool IsLeafLike(AutomationElement el)
    {
        ControlType t;
        try { t = el.Cached.ControlType; } catch (Exception) { return false; }
        return t == ControlType.Button || t == ControlType.ListItem || t == ControlType.MenuItem || t == ControlType.TabItem || t == ControlType.CheckBox || t == ControlType.RadioButton
            || t == ControlType.Hyperlink || t == ControlType.Edit || t == ControlType.ComboBox || t == ControlType.Text || t == ControlType.Image || t == ControlType.Separator
            || t == ControlType.SplitButton || t == ControlType.DataItem || t == ControlType.Slider || t == ControlType.Spinner || t == ControlType.ScrollBar || t == ControlType.ProgressBar;
    }

    static void CachedWalk(AutomationElement el, int depth, int maxDepth, List<AutomationElement> found, int[] budget, Stopwatch clock, int millis, CacheRequest cr)
    {
        AutomationElement child = null;
        try { child = TreeWalker.ControlViewWalker.GetFirstChild(el, cr); } catch (Exception) { }
        while (child != null && budget[0] > 0 && clock.ElapsedMilliseconds < millis)
        {
            budget[0]--;
            bool off = false;
            try { off = child.Cached.IsOffscreen; } catch (Exception) { }
            if (!off)
            {
                found.Add(child);
                if (depth + 1 < maxDepth && !IsLeafLike(child)) CachedWalk(child, depth + 1, maxDepth, found, budget, clock, millis, cr);
            }
            try { child = TreeWalker.ControlViewWalker.GetNextSibling(child, cr); } catch (Exception) { child = null; }
        }
    }

    static int _walkVisited, _walkMs; static bool _walkLimited;

    static List<AutomationElement> CachedElements(AutomationElement root, int maxNodes, int millis)
    {
        var found = new List<AutomationElement>();
        var clock = Stopwatch.StartNew();
        var budget = new int[] { maxNodes };
        var cr = InteractiveCache();
        using (cr.Activate()) { CachedWalk(root, 0, 40, found, budget, clock, millis, cr); }
        _walkVisited = maxNodes - budget[0]; _walkMs = (int)clock.ElapsedMilliseconds; _walkLimited = clock.ElapsedMilliseconds >= millis || budget[0] <= 0;
        return found;
    }

    static readonly HashSet<long> AwakeWindows = new HashSet<long>();
    static object _poked;

    /// <summary>
    /// Chromium only builds a page's accessibility tree once something PROBES it (asks a control for its properties and patterns): walking alone leaves the page invisible.
    /// So the wake-up probes the page's document and panes.
    /// </summary>
    static void Poke(List<AutomationElement> found)
    {
        int pokes = 0;
        foreach (var el in found)
        {
            if (pokes >= 8) break;
            try
            {
                var ct = el.Cached.ControlType;
                if (ct != ControlType.Document && ct != ControlType.Pane && ct != ControlType.Group) continue;
                object po;
                el.TryGetCurrentPattern(TextPattern.Pattern, out po);
                _poked = el.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty);
                _poked = el.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty);
                pokes++;
            }
            catch (Exception) { }
        }
    }

    /// <summary>
    /// A Chromium page (Edge, Chrome, Electron, WebView2) shows its contents to UI Automation only AFTER a client has asked for them: the first look sees the browser's own
    /// buttons and nothing of the page, and the page then fills in over a few seconds. So the first look at such a window wakes it and waits until what it shows stops growing.
    /// </summary>
    static void WakeWeb(IntPtr h, AutomationElement root)
    {
        if (!ClassOf(h).StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) return;
        lock (AwakeWindows) { if (AwakeWindows.Contains(h.ToInt64())) return; }
        var sw = Stopwatch.StartNew();
        int first = -1, last = -1, steady = 0;
        while (sw.ElapsedMilliseconds < 3500)
        {
            int n = 0;
            try { var els = CachedElements(root, 600, 1500); Poke(els); n = els.Count; } catch (Exception) { }
            if (first < 0) first = n;
            if (n == last) steady++; else steady = 0;
            last = n;
            // done when the page has appeared (more than the first look saw) and stopped growing; or, if nothing ever appears, after a few seconds (it may be awake already, or empty)
            if (steady >= 2 && n > first) break;
            Thread.Sleep(400);
        }
        lock (AwakeWindows) { AwakeWindows.Add(h.ToInt64()); }
    }

    /// <summary>The controls of a window that can be pressed, ticked, chosen or typed into, with their names and places, in reading order.</summary>
    static List<Dictionary<string, object>> InteractiveList(IntPtr h, int max, out bool truncated, int budgetMs)
    {
        var root = AutomationElement.FromHandle(h);
        WakeWeb(h, root);
        var all = CachedElements(root, 1500, Math.Max(1500, Math.Min(budgetMs, 15000)));
        var items = new List<Dictionary<string, object>>();
        foreach (AutomationElement el in all)
        {
            try
            {
                var c = el.Cached;
                string type = TypeNameOf(c.ControlType);
                if (Array.IndexOf(Interesting, c.ControlType) < 0) continue;
                string name = (c.Name ?? "").Trim();
                if (name.Length == 0 && type != "Edit" && type != "ComboBox") continue; // a control with no name cannot be referred to
                var r = c.BoundingRectangle;
                if (r.IsEmpty || double.IsInfinity(r.X) || double.IsInfinity(r.Width) || r.Width < 2 || r.Height < 2) continue;
                if (name.Length > 140) name = name.Substring(0, 140) + "...";
                var n = new Dictionary<string, object>();
                n["_el"] = el;
                n["name"] = name;
                n["type"] = type;
                n["enabled"] = c.IsEnabled;
                n["x"] = (int)r.X; n["y"] = (int)r.Y; n["w"] = (int)r.Width; n["h"] = (int)r.Height;
                if (c.HasKeyboardFocus) n["focused"] = true;
                if (c.IsPassword) { n["password"] = true; n["value"] = "(hidden)"; }
                // what it can do is read when it is used (a click tries the control's own action first); the list only says what kind of thing it is
                var acts = new List<string>();
                if (type == "Edit" || type == "ComboBox" || type == "Spinner" || type == "Slider") acts.Add("value");
                else if (type == "CheckBox" || type == "RadioButton") acts.Add("toggle");
                else acts.Add("invoke");
                n["actions"] = acts;
                items.Add(n);
            }
            catch (ElementNotAvailableException) { }
        }
        items.Sort(delegate (Dictionary<string, object> p, Dictionary<string, object> q)
        {
            int rows = ((int)p["y"] / 12).CompareTo((int)q["y"] / 12); // rows of 12 pixels, left to right inside a row
            return rows != 0 ? rows : ((int)p["x"]).CompareTo((int)q["x"]);
        });
        truncated = items.Count > max;
        if (truncated) items.RemoveRange(max, items.Count - max);
        int edits = 0;
        foreach (var n in items)
        {
            var el = (AutomationElement)n["_el"];
            n.Remove("_el");
            n["element"] = Id(el);
            if (edits < 10 && (string)n["type"] == "Edit" && !n.ContainsKey("value"))
            {
                edits++;
                object po;
                try
                {
                    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out po))
                    {
                        string v = ((ValuePattern)po).Current.Value ?? "";
                        if (SensitiveName.IsMatch((string)n["name"])) v = "(hidden: looks sensitive)";
                        n["value"] = v.Length > 200 ? v.Substring(0, 200) + "..." : v;
                    }
                }
                catch (Exception) { }
            }
        }
        return items;
    }

    static object Interactive(Dictionary<string, object> a)
    {
        IntPtr h = Hwnd(a, "window");
        int max = Math.Max(10, Math.Min(Int(a, "maxNodes", 120), 400));
        bool truncated;
        var items = InteractiveList(h, max, out truncated, Int(a, "budgetMs", 4000));
        var d = new Dictionary<string, object>();
        d["window"] = h.ToInt64();
        d["title"] = Title(h);
        d["nodes"] = items;
        d["truncated"] = truncated || _walkLimited;
        d["visited"] = _walkVisited; d["walkMs"] = _walkMs; d["walkLimited"] = _walkLimited;
        return d;
    }

    /// <summary>What is at a point on the screen (so a click at a spot can be judged by what it would press, not by its numbers).</summary>
    static object ElementAt(Dictionary<string, object> a)
    {
        int x = Int(a, "x", int.MinValue), y = Int(a, "y", int.MinValue);
        if (x == int.MinValue || y == int.MinValue) throw new DesktopError("no_target", "where? give x and y");
        var d = new Dictionary<string, object>();
        AutomationElement el = null;
        try { el = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch (Exception) { }
        if (el == null) { d["found"] = false; return d; }
        try
        {
            var c = el.Current;
            d["found"] = true;
            d["element"] = Id(el);
            d["name"] = c.Name ?? "";
            d["type"] = TypeName(el);
            d["enabled"] = c.IsEnabled;
            if (c.IsPassword) d["password"] = true;
        }
        catch (ElementNotAvailableException) { d["found"] = false; }
        return d;
    }

    static void DrawMarks(Bitmap bmp, List<Dictionary<string, object>> items, int originX, int originY, double scale, List<Dictionary<string, object>> marks)
    {
        using (var g = Graphics.FromImage(bmp))
        using (var pen = new Pen(Color.FromArgb(235, 255, 40, 120), 2))
        using (var font = new Font("Segoe UI", 10f, FontStyle.Bold))
        using (var back = new SolidBrush(Color.FromArgb(235, 255, 40, 120)))
        using (var fore = new SolidBrush(Color.White))
        {
            int n = 0;
            foreach (var it in items)
            {
                double rx = ((int)it["x"] - originX) * scale, ry = ((int)it["y"] - originY) * scale, rw = (int)it["w"] * scale, rh = (int)it["h"] * scale;
                if (rx + rw < 0 || ry + rh < 0 || rx > bmp.Width || ry > bmp.Height) continue; // outside the picture
                n++;
                g.DrawRectangle(pen, (float)rx, (float)ry, (float)Math.Max(2, rw), (float)Math.Max(2, rh));
                string label = n.ToString();
                SizeF sz = g.MeasureString(label, font);
                float lx = (float)Math.Max(0, Math.Min(bmp.Width - sz.Width, rx)), ly = (float)Math.Max(0, ry - sz.Height + 2);
                g.FillRectangle(back, lx, ly, sz.Width, sz.Height);
                g.DrawString(label, font, fore, lx, ly);
                var m = new Dictionary<string, object>();
                m["n"] = n; m["element"] = it["element"]; m["name"] = it["name"]; m["type"] = it["type"];
                m["x"] = (int)rx; m["y"] = (int)ry; m["w"] = (int)rw; m["h"] = (int)rh;
                m["cx"] = (int)(rx + rw / 2); m["cy"] = (int)(ry + rh / 2);
                marks.Add(m);
            }
        }
    }

    static void DrawGrid(Bitmap bmp)
    {
        using (var g = Graphics.FromImage(bmp))
        using (var pen = new Pen(Color.FromArgb(70, 0, 160, 255), 1))
        using (var font = new Font("Segoe UI", 8f, FontStyle.Bold))
        using (var back = new SolidBrush(Color.FromArgb(200, 0, 90, 160)))
        using (var fore = new SolidBrush(Color.White))
        {
            for (int gx = 100; gx < bmp.Width; gx += 100) { g.DrawLine(pen, gx, 0, gx, bmp.Height); g.FillRectangle(back, gx + 1, 0, 30, 13); g.DrawString(gx.ToString(), font, fore, gx + 1, 0); }
            for (int gy = 100; gy < bmp.Height; gy += 100) { g.DrawLine(pen, 0, gy, bmp.Width, gy); g.FillRectangle(back, 0, gy + 1, 30, 13); g.DrawString(gy.ToString(), font, fore, 0, gy + 1); }
        }
    }

    // ------------------------------------------------------------------------------------------------------------------------ pictures
    static object Screenshot(Dictionary<string, object> a)
    {
        long wv = Long(a, "window", 0);
        int maxWidth = Math.Max(200, Math.Min(Int(a, "maxWidth", 1280), 3000));
        int x, y, w, hgt;
        IntPtr h = IntPtr.Zero;
        if (wv != 0)
        {
            h = Hwnd(a, "window");
            RECT r; GetWindowRect(h, out r);
            x = r.Left; y = r.Top; w = r.Right - r.Left; hgt = r.Bottom - r.Top;
        }
        else
        {
            x = GetSystemMetrics(76); y = GetSystemMetrics(77); w = GetSystemMetrics(78); hgt = GetSystemMetrics(79);
        }
        if (w <= 0 || hgt <= 0) throw new DesktopError("empty_window", "that window has no size on screen");
        using (var bmp = new Bitmap(w, hgt, PixelFormat.Format32bppArgb))
        {
            bool drawn = false;
            if (h != IntPtr.Zero)
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    try { drawn = PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); } // 2 = render the whole window, even if another one is in front of it
                }
                if (drawn && IsMostlyBlank(bmp)) drawn = false;
            }
            if (!drawn)
            {
                using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, hgt));
            }
            Bitmap outBmp = bmp;
            double scale = 1.0;
            if (w > maxWidth)
            {
                scale = (double)maxWidth / w;
                outBmp = new Bitmap(bmp, new Size(maxWidth, Math.Max(1, (int)(hgt * scale))));
            }
            var marks = new List<Dictionary<string, object>>();
            if (h != IntPtr.Zero && Bool(a, "marks", false))
            {
                try
                {
                    bool cut;
                    DrawMarks(outBmp, InteractiveList(h, 60, out cut, 4000), x, y, scale, marks);
                }
                catch (Exception) { /* a page that cannot be listed is still shown, just without marks */ }
            }
            bool grid = Bool(a, "grid", false) || (Bool(a, "gridIfBlind", false) && marks.Count < 5);
            if (grid) DrawGrid(outBmp);
            try
            {
                using (var ms = new MemoryStream())
                {
                    outBmp.Save(ms, ImageFormat.Png);
                    var d = new Dictionary<string, object>();
                    d["mime"] = "image/png";
                    d["base64"] = Convert.ToBase64String(ms.ToArray());
                    d["width"] = outBmp.Width; d["height"] = outBmp.Height;
                    d["sourceWidth"] = w; d["sourceHeight"] = hgt; d["scale"] = scale;
                    d["x"] = x; d["y"] = y;
                    d["marks"] = marks;
                    d["grid"] = grid;
                    return d;
                }
            }
            finally { if (!object.ReferenceEquals(outBmp, bmp)) outBmp.Dispose(); }
        }
    }

    static bool IsMostlyBlank(Bitmap b)
    {
        int seen = 0, blank = 0;
        for (int yy = 0; yy < b.Height; yy += Math.Max(1, b.Height / 12))
            for (int xx = 0; xx < b.Width; xx += Math.Max(1, b.Width / 12))
            {
                var c = b.GetPixel(xx, yy);
                seen++;
                if (c.A == 0 || (c.R == 0 && c.G == 0 && c.B == 0)) blank++;
            }
        return seen > 0 && blank * 10 >= seen * 9;
    }

    // ------------------------------------------------------------------------------------------------------------------------ input
    static void Send(params INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length) throw new DesktopError("input_blocked", "Windows did not accept the input (a program running as administrator, or a security tool, can block it)");
        StampOwn();
    }

    static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        var i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags;
        return i;
    }

    static INPUT MouseInput(int dx, int dy, uint data, uint flags)
    {
        var i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
        return i;
    }

    static void MoveMouse(int x, int y)
    {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        POINT p; GetCursorPos(out p);
        const int steps = 8; // a short visible glide, so the user can follow what Noah is doing
        for (int s = 1; s <= steps; s++)
        {
            int cx = p.X + (x - p.X) * s / steps, cy = p.Y + (y - p.Y) * s / steps;
            int ax = (int)((long)(cx - vx) * 65535 / Math.Max(1, vw - 1)), ay = (int)((long)(cy - vy) * 65535 / Math.Max(1, vh - 1));
            Send(MouseInput(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
            Thread.Sleep(10);
        }
    }

    static void MouseClick(int x, int y, bool right, bool dbl, bool force)
    {
        MoveMouse(x, y);
        Thread.Sleep(40);
        POINT at; GetCursorPos(out at);
        // Noah has been given the mouse ("take over"): if the pointer is not where it was sent (a hand nudged it), point again a few times instead of giving up
        for (int tries = 0; force && tries < 3 && (Math.Abs(at.X - x) > 4 || Math.Abs(at.Y - y) > 4); tries++)
        {
            MoveMouse(x, y);
            Thread.Sleep(60);
            GetCursorPos(out at);
        }
        if (Math.Abs(at.X - x) > 4 || Math.Abs(at.Y - y) > 4) throw new DesktopError("user_busy", force ? "the mouse pointer would not stay on the spot Noah pointed at (something else keeps moving it), so Noah did not click" : "the mouse pointer was moved away (by you?), so Noah did not click");
        uint down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN, up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        for (int n = 0; n < (dbl ? 2 : 1); n++)
        {
            Send(MouseInput(0, 0, 0, down));
            Thread.Sleep(30);
            Send(MouseInput(0, 0, 0, up));
            Thread.Sleep(60);
        }
    }

    static Dictionary<string, object> M(string method, string name)
    {
        var d = new Dictionary<string, object>();
        d["method"] = method;
        d["name"] = name;
        return d;
    }

    static void InvokeAsync(InvokePattern p)
    {
        // Invoke on a button that opens a modal dialog does not return until the dialog is closed: do not wait for it
        var th = new Thread(() => { try { p.Invoke(); } catch { } });
        th.IsBackground = true;
        th.SetApartmentState(ApartmentState.MTA);
        th.Start();
        th.Join(1500);
    }

    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);

    /// <summary>A click or a scroll at a screen point goes to whatever is ON TOP there, not to the window Noah meant. Refuse when that is something else (the taskbar, a pop-up, another window).</summary>
    static void RequireUncovered(IntPtr target, int x, int y)
    {
        var p = new POINT();
        p.X = x; p.Y = y;
        IntPtr under = WindowFromPoint(p);
        if (under == IntPtr.Zero) return;
        IntPtr root = GetAncestor(under, 2), want = GetAncestor(target, 2);
        if (root == IntPtr.Zero) root = under;
        if (want == IntPtr.Zero) want = target;
        if (root == want) return;
        string t = Title(root);
        if (t == "Noah is working") return; // Noah's own Stop bar lets the mouse through except over its button
        throw new DesktopError("covered", "something else is on top of that spot" + (t.Length > 0 ? " (" + (t.Length > 40 ? t.Substring(0, 40) : t) + ")" : "") + ", so the click would not reach the window: move or close it, or choose a spot that is visible");
    }

    static void RequireFrontOfElement(AutomationElement el)
    {
        IntPtr fg = GetForegroundWindow();
        uint fgPid; GetWindowThreadProcessId(fg, out fgPid);
        if ((int)fgPid != el.Current.ProcessId) throw new DesktopError("not_foreground", "that control's program is not in front: bring its window to the front first");
    }

    static object Click(Dictionary<string, object> a)
    {
        bool dbl = Bool(a, "double", false), right = Bool(a, "right", false), force = Bool(a, "force", false);
        string id = Str(a, "element");
        if (id != null)
        {
            var el = El(id);
            if (!el.Current.IsEnabled) throw new DesktopError("disabled", "that control is disabled");
            string name = el.Current.Name;
            if (!right && !dbl && !Bool(a, "mouse", false))
            {
                object p;
                if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { InvokeAsync((InvokePattern)p); return M("invoke", name); }
                if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return M("toggle", name); }
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return M("select", name); }
                if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p))
                {
                    var ec = (ExpandCollapsePattern)p;
                    if (ec.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) ec.Expand(); else ec.Collapse();
                    return M("expand", name);
                }
            }
            System.Windows.Point pt;
            if (!el.TryGetClickablePoint(out pt)) throw new DesktopError("not_clickable", "that control has no visible spot to click (scroll it into view first)");
            RequireFrontOfElement(el);
            RequireUncovered(GetForegroundWindow(), (int)pt.X, (int)pt.Y);
            MouseClick((int)pt.X, (int)pt.Y, right, dbl, force);
            return M("mouse", name);
        }
        // a spot on the screen: only inside a window that is in front
        IntPtr h = Hwnd(a, "window");
        RequireFront(h);
        int x = Int(a, "x", int.MinValue), y = Int(a, "y", int.MinValue);
        if (x == int.MinValue || y == int.MinValue) throw new DesktopError("no_target", "click what? give a control id, or x and y inside the window");
        RECT r; GetWindowRect(h, out r);
        if (x < r.Left || x >= r.Right || y < r.Top || y >= r.Bottom) throw new DesktopError("outside_window", "that spot is outside the window");
        RequireUncovered(h, x, y);
        MouseClick(x, y, right, dbl, force);
        return M("mouse", "(" + x + "," + y + ")");
    }

    static object Scroll(Dictionary<string, object> a)
    {
        IntPtr h = Hwnd(a, "window");
        RequireFront(h);
        int x = Int(a, "x", int.MinValue), y = Int(a, "y", int.MinValue);
        RECT r; GetWindowRect(h, out r);
        if (x == int.MinValue) x = (r.Left + r.Right) / 2;
        if (y == int.MinValue) y = (r.Top + r.Bottom) / 2;
        if (x < r.Left || x >= r.Right || y < r.Top || y >= r.Bottom) throw new DesktopError("outside_window", "that spot is outside the window");
        int clicks = Math.Max(-20, Math.Min(Int(a, "clicks", -3), 20)); // negative = down
        RequireUncovered(h, x, y);
        MoveMouse(x, y);
        for (int i = 0; i < Math.Abs(clicks); i++) { Send(MouseInput(0, 0, (uint)(clicks > 0 ? 120 : -120), MOUSEEVENTF_WHEEL)); Thread.Sleep(40); }
        var d = new Dictionary<string, object>();
        d["scrolled"] = clicks;
        return d;
    }

    static object SetText(Dictionary<string, object> a)
    {
        var el = El(Str(a, "element", ""));
        if (el.Current.IsPassword) throw new DesktopError("password_field", "Noah never writes into a password field");
        string text = Str(a, "text", "");
        object p;
        if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) throw new DesktopError("not_settable", "this field cannot be set directly: click into it and use type");
        var vp = (ValuePattern)p;
        if (vp.Current.IsReadOnly) throw new DesktopError("read_only", "that field is read-only");
        vp.SetValue(text);
        var d = new Dictionary<string, object>();
        d["method"] = "value";
        d["now"] = vp.Current.Value;
        return d;
    }

    static ushort KeyCode(string k)
    {
        k = k.ToLowerInvariant();
        switch (k)
        {
            case "enter": case "return": return 0x0D;
            case "tab": return 0x09;
            case "esc": case "escape": return 0x1B;
            case "space": return 0x20;
            case "backspace": return 0x08;
            case "delete": case "del": return 0x2E;
            case "insert": return 0x2D;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": return 0x21;
            case "pagedown": return 0x22;
            case "up": return 0x26;
            case "down": return 0x28;
            case "left": return 0x25;
            case "right": return 0x27;
            case "ctrl": case "control": return 0x11;
            case "shift": return 0x10;
            case "alt": return 0x12;
            case "win": case "windows": return 0x5B;
            case ",": return 0xBC;
            case ".": return 0xBE;
            case "-": return 0xBD;
            case "=": return 0xBB;
            case "/": return 0xBF;
            case ";": return 0xBA;
            case "'": return 0xDE;
            case "[": return 0xDB;
            case "]": return 0xDD;
            case "\\": return 0xDC;
            case "`": return 0xC0;
        }
        if (k.Length == 1 && k[0] >= 'a' && k[0] <= 'z') return (ushort)(0x41 + (k[0] - 'a'));
        if (k.Length == 1 && k[0] >= '0' && k[0] <= '9') return (ushort)(0x30 + (k[0] - '0'));
        if (k.Length >= 2 && k[0] == 'f')
        {
            int n;
            if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 12) return (ushort)(0x6F + n);
        }
        throw new DesktopError("bad_key", "unknown key '" + k + "'");
    }

    static bool IsExtended(ushort vk)
    {
        return vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22 || vk == 0x5B;
    }

    static object Key(Dictionary<string, object> a)
    {
        IntPtr h = Hwnd(a, "window");
        RequireFront(h);
        string combo = Str(a, "combo", "");
        if (combo.Length == 0) throw new DesktopError("bad_key", "which key?");
        var parts = combo.Split('+');
        var mods = new List<ushort>();
        for (int i = 0; i < parts.Length - 1; i++)
        {
            ushort m = KeyCode(parts[i].Trim());
            if (m != 0x11 && m != 0x10 && m != 0x12 && m != 0x5B) throw new DesktopError("bad_key", "'" + parts[i] + "' is not a modifier key");
            mods.Add(m);
        }
        string last = parts[parts.Length - 1].Trim();
        if (last.Length == 0 && combo.EndsWith("+")) last = "+";
        ushort key = last == "+" ? (ushort)0xBB : KeyCode(last);
        // a combination must END in a real key: "ctrl+shift" alone does nothing useful, and on Windows it switches the keyboard language
        if (key == 0x11 || key == 0x10 || key == 0x12 || key == 0x5B) throw new DesktopError("bad_key", "'" + last + "' is a modifier key: end the combination with a letter, number or other key (for example ctrl+s)");
        foreach (var m in mods) Send(KeyInput(m, 0, IsExtended(m) ? KEYEVENTF_EXTENDED : 0));
        Send(KeyInput(key, 0, IsExtended(key) ? KEYEVENTF_EXTENDED : 0));
        Thread.Sleep(20);
        Send(KeyInput(key, 0, KEYEVENTF_KEYUP | (IsExtended(key) ? KEYEVENTF_EXTENDED : 0)));
        for (int i = mods.Count - 1; i >= 0; i--) Send(KeyInput(mods[i], 0, KEYEVENTF_KEYUP | (IsExtended(mods[i]) ? KEYEVENTF_EXTENDED : 0)));
        var d = new Dictionary<string, object>();
        d["pressed"] = combo;
        return d;
    }

    static object TypeText(Dictionary<string, object> a)
    {
        IntPtr h = Hwnd(a, "window");
        string text = Str(a, "text", "");
        if (text.Length == 0) throw new DesktopError("no_text", "type what?");
        if (text.Length > 4000) throw new DesktopError("too_long", "type at most 4000 characters at a time");
        string id = Str(a, "element");
        if (id != null)
        {
            var target = El(id);
            if (target.Current.IsPassword) throw new DesktopError("password_field", "Noah never types into a password field");
            RequireFront(h);
            try { target.SetFocus(); } catch { throw new DesktopError("not_focusable", "that control cannot take the keyboard focus"); }
            Thread.Sleep(80);
        }
        RequireFront(h);
        AutomationElement focused = null;
        try { focused = AutomationElement.FocusedElement; } catch { }
        if (focused != null)
        {
            try
            {
                if (focused.Current.IsPassword) throw new DesktopError("password_field", "Noah never types into a password field");
            }
            catch (ElementNotAvailableException) { }
        }
        int typed = 0;
        bool force = Bool(a, "force", false); // Noah has been given the keyboard ("take over"): the user's own keys no longer stop it (a window that loses the front still does)
        StampOwn(); // from here on, any input that is not ours is the user's
        for (int i = 0; i < text.Length; i++)
        {
            try { if (!force) RequireNoUser(); RequireFront(h); } // the user started typing or moving the mouse, or the window lost the front: stop, never mix our characters into theirs
            catch (DesktopError stop) { if (typed > 0) throw new DesktopError(stop.Code, stop.Message + " (" + typed + " of " + text.Length + " characters had already been typed)"); throw; }
            RequireFront(h); // before EVERY character: if focus moves while typing, stop at once instead of typing even one more character into something else
            char c = text[i];
            if (c == '\r') continue;
            if (c == '\n') { Send(KeyInput(0x0D, 0, 0), KeyInput(0x0D, 0, KEYEVENTF_KEYUP)); }
            else if (c == '\t') { Send(KeyInput(0x09, 0, 0), KeyInput(0x09, 0, KEYEVENTF_KEYUP)); }
            else { Send(KeyInput(0, c, KEYEVENTF_UNICODE), KeyInput(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)); }
            typed++;
            Thread.Sleep(4);
        }
        var d = new Dictionary<string, object>();
        d["typed"] = typed;
        return d;
    }

    // ------------------------------------------------------------------------------------------------------------------------ launching
    static object Launch(Dictionary<string, object> a)
    {
        string appId = Str(a, "appId"), file = Str(a, "file"), args = Str(a, "args", "");
        ProcessStartInfo psi;
        if (appId != null) psi = new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + appId);
        else if (file != null) psi = new ProcessStartInfo(file, args);
        else throw new DesktopError("no_target", "launch what?");
        psi.UseShellExecute = true;
        var p = Process.Start(psi);
        var d = new Dictionary<string, object>();
        d["started"] = true;
        d["pid"] = p != null ? (object)p.Id : null;
        return d;
    }
}
