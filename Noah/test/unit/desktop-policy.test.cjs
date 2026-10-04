// Noah/test/unit/desktop-policy.test.cjs - what Noah may do on the Windows desktop (Noah/desktop/policy.cjs). Pure rules: no windows are touched.
// The user's choice is "the whole desktop, ask only for risky things": reading and ordinary actions run, risky ones ask, and a short list stays
// off-limits in every mode.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decideDesktop, offLimits } = require("../../desktop/policy.cjs");

const d = (a, mode) => decideDesktop(a, { mode });
const W = (process, title) => ({ process, title: title || `${process} window` });
const NOTEPAD = W("notepad", "Untitled - Notepad");

test("looking is always allowed, in every mode: the list of windows, reading a window, a picture, waiting", () => {
  for (const mode of ["autonomous", "supervised", "strict"]) {
    for (const op of ["windows", "read", "screenshot", "wait"]) assert.equal(d({ op, window: NOTEPAD }, mode).decision, "allow", `${op} in ${mode}`);
    assert.equal(d({ op: "focus", window: NOTEPAD }, mode).decision, "allow", "bringing a window to the front changes nothing in it");
  }
});

test("ordinary actions run in the user's chosen mode and ask in the stricter ones", () => {
  const typeIt = { op: "type", window: NOTEPAD, text: "hello" };
  assert.equal(d(typeIt, "autonomous").decision, "allow");
  assert.equal(d(typeIt, "supervised").decision, "confirm");
  assert.equal(d(typeIt, "strict").decision, "confirm");
  for (const a of [{ op: "click", window: NOTEPAD, element: { name: "Save" } }, { op: "setText", window: NOTEPAD, element: { name: "Name" }, text: "x" }, { op: "key", window: NOTEPAD, combo: "ctrl+s" }, { op: "scroll", window: NOTEPAD }]) {
    assert.equal(d(a, "autonomous").decision, "allow", a.op);
    assert.equal(d(a, "supervised").decision, "confirm", a.op);
  }
});

test("controls that send, delete, buy or change something hard to undo always ask, even in the most relaxed mode", () => {
  for (const name of ["Send", "Submit", "Post", "Publish", "Delete", "Delete everything", "Remove", "Erase", "Format", "Buy now", "Pay", "Place order", "Confirm", "Uninstall", "Install", "Reset", "Sign out", "Log out", "Empty Recycle Bin", "Transfer", "Accept", "I agree", "Allow", "Overwrite", "Discard", "Don't save", "Restart", "Shut down", "Share", "Subscribe"]) {
    const r = d({ op: "click", window: NOTEPAD, element: { name } }, "autonomous");
    assert.equal(r.decision, "confirm", name);
    assert.equal(r.risk.level, "high", name);
    assert.match(r.why, new RegExp(`presses "${name.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  }
  for (const name of ["Save", "Open", "Next", "OK", "Cancel", "Bold", "Greet", "Search", "File", "Edit", "Preview", "Undo", "Copy", "Paste", "Font", "Zoom in", "Delivery", "Sender name", "Resend code later"]) {
    assert.equal(d({ op: "click", window: NOTEPAD, element: { name } }, "autonomous").decision, "allow", `${name} is not a risky control`);
  }
});

test("a window about money, sign-in or verification: everything that acts there asks, whatever the control is called", () => {
  for (const title of ["Netbanking - Google Chrome", "PayPal: Send money", "Checkout - Amazon", "Sign in to your account", "Enter the OTP", "Binance", "Credit card details", "Verify your identity"]) {
    for (const a of [{ op: "click", element: { name: "Next" } }, { op: "type", text: "x" }, { op: "setText", element: { name: "Amount" }, text: "5" }, { op: "key", combo: "ctrl+s" }, { op: "scroll" }]) {
      const r = d({ ...a, window: W("chrome", title) }, "autonomous");
      assert.equal(r.decision, "confirm", `${title} / ${a.op}`);
      assert.equal(r.risk.categories[0], "sensitive_window");
    }
    assert.equal(d({ op: "read", window: W("chrome", title) }, "autonomous").decision, "allow", `looking at ${title} is fine`);
  }
  assert.equal(d({ op: "click", window: W("chrome", "Cat videos - YouTube"), element: { name: "Play" } }, "autonomous").decision, "allow");
});

test("messaging and mail: a line break or Enter can SEND, so it asks; ordinary typing there does not", () => {
  for (const win of [W("Discord", "general - Discord"), W("WhatsApp", "WhatsApp"), W("OUTLOOK", "Inbox - Outlook"), W("chrome", "Compose - Gmail"), W("notepad", "New message")]) {
    assert.equal(d({ op: "type", window: win, text: "hi there" }, "autonomous").decision, "allow", `typing words in ${win.title}`);
    assert.equal(d({ op: "type", window: win, text: "hi\n" }, "autonomous").decision, "confirm", `a line break in ${win.title} sends`);
    assert.equal(d({ op: "key", window: win, combo: "enter" }, "autonomous").decision, "confirm", `Enter in ${win.title} sends`);
    assert.equal(d({ op: "key", window: win, combo: "ctrl+enter" }, "autonomous").decision, "confirm");
  }
  assert.equal(d({ op: "key", window: NOTEPAD, combo: "enter" }, "autonomous").decision, "allow", "Enter in an editor is a new line");
  assert.equal(d({ op: "type", window: NOTEPAD, text: "line one\nline two" }, "autonomous").decision, "allow");
});

test("shortcuts that close or delete ask; the Windows key and system shortcuts are off-limits", () => {
  for (const combo of ["alt+f4", "ctrl+w", "ctrl+shift+w", "ctrl+q", "ctrl+shift+delete", "shift+delete", "delete", "f11"]) assert.equal(d({ op: "key", window: NOTEPAD, combo }, "autonomous").decision, "confirm", combo);
  for (const combo of ["win+r", "win+d", "windows+e", "ctrl+alt+delete", "ctrl+shift+esc", "alt+tab", "ctrl+win+d", "ctrl+alt+x", "alt+ctrl+x", "control+alt+x", "Ctrl + Alt + Shift + X", "ctrl+alt+a"]) {
    const r = d({ op: "key", window: NOTEPAD, combo }, "autonomous");
    assert.equal(r.decision, "deny", combo);
    assert.match(r.why, /leaves the task/);
  }
  for (const combo of ["ctrl+s", "ctrl+a", "ctrl+c", "ctrl+v", "ctrl+z", "enter", "tab", "f5", "ctrl+shift+s", "alt+d", "ctrl+x", "alt+x", "ctrl+shift+x", "alt+shift+x"]) assert.notEqual(d({ op: "key", window: NOTEPAD, combo }, "autonomous").decision, "deny", combo);
  assert.equal(d({ op: "key", window: NOTEPAD, combo: " Win + R " }, "autonomous").decision, "deny", "spaces and capitals do not get round it");
});

test("closing a window asks (it may hold unsaved work)", () => {
  const r = d({ op: "close", window: NOTEPAD }, "autonomous");
  assert.deepEqual([r.decision, r.risk.level], ["confirm", "high"]);
});

test("OFF-LIMITS in every mode: Noah's own window and the Claude app, password managers, security screens, terminals, system tools", () => {
  const cases = [
    [W("Jonah", "Jonah"), /Noah's own window or the Claude app/], [W("claude", "Claude"), /Noah's own window or the Claude app/], [W("Claude Code", "x"), /own window/],
    [W("1Password", "1Password"), /password manager/], [W("Bitwarden", "My Vault - Bitwarden"), /password manager/], [W("KeePassXC", "KeePassXC"), /password manager/], [W("chrome", "LastPass - Chrome"), /password manager/],
    [W("consent", "User Account Control"), /security or sign-in/], [W("SecurityHealthSystray", "Windows Security"), /security or sign-in/], [W("LogonUI", "x"), /security or sign-in/],
    [W("cmd", "Command Prompt"), /terminal/], [W("powershell", "Windows PowerShell"), /terminal/], [W("WindowsTerminal", "x"), /terminal/], [W("bash", "Git Bash"), /terminal/], [W("wsl", "Ubuntu"), /terminal/],
    [W("regedit", "Registry Editor"), /edits other programs/], [W("Taskmgr", "Task Manager"), /edits other programs/], [W("cheatengine-x86_64", "Cheat Engine 7.5"), /edits other programs/], [W("mmc", "Computer Management"), /edits other programs/],
  ];
  for (const [win, why] of cases) {
    for (const mode of ["autonomous", "supervised", "strict"]) {
      for (const op of ["click", "type", "key", "setText", "scroll", "close"]) {
        const r = d({ op, window: win, element: { name: "x" }, text: "x", combo: "ctrl+s" }, mode);
        assert.equal(r.decision, "deny", `${win.process} ${op} ${mode}`);
        assert.match(r.why, why, `${win.process}`);
      }
    }
  }
});

test("off-limits is judged by the program name ALONE and by the window title ALONE: either is enough, because an app chooses its own title", () => {
  // by program name, with an innocent title
  for (const [process, title] of [["Jonah", "YouTube - Jonah"], ["claude", "New chat"], ["Bitwarden", "My vault"], ["1Password", "Vaults"], ["consent", "Do you want to allow this app to make changes?"], ["Taskmgr", "Processes"], ["regedit", "Editor"], ["powershell", "Untitled"], ["cmd", "Untitled"], ["cheatengine-x86_64", "Untitled"]]) {
    assert.equal(d({ op: "click", window: { process, title } }, "autonomous").decision, "deny", `${process} by program name`);
  }
  // by title, with an ordinary program name (a browser tab, an extension, a web app)
  for (const title of ["Jonah", "Claude", "Bitwarden - Extension", "LastPass vault", "1Password", "User Account Control", "Windows Security", "Credential Manager", "Command Prompt", "Windows PowerShell", "Registry Editor", "Task Manager", "Cheat Engine 7.5"]) {
    assert.equal(d({ op: "click", window: { process: "chrome", title } }, "autonomous").decision, "deny", `${title} by title`);
  }
  // looking: a password manager is refused by program name alone too (a terminal is not)
  assert.equal(d({ op: "read", window: { process: "Bitwarden", title: "My vault" } }).decision, "deny");
  assert.equal(d({ op: "read", window: { process: "consent", title: "Allow?" } }).decision, "deny");
  assert.equal(d({ op: "read", window: { process: "powershell", title: "Untitled" } }).decision, "allow");
  assert.equal(d({ op: "read", window: { process: "Taskmgr", title: "Processes" } }).decision, "allow", "Task Manager may be looked at");
});

test("a window is judged 'about money or sign-in' by any one of the title words", () => {
  for (const title of ["HDFC Bank - Home", "Netbanking", "Paypal", "Payment details", "Checkout", "Wallet", "Coinbase", "Billing", "Invoice 12", "Login", "Please log in", "Password reset", "Verification code", "OTP", "2FA setup", "Credit card"]) {
    assert.equal(d({ op: "type", window: W("chrome", title), text: "x" }, "autonomous").decision, "confirm", title);
  }
  for (const title of ["Bankside Photos", "Cooking", "Notes", "Download", "Meeting notes", "Paymentsville map"]) {
    assert.equal(d({ op: "type", window: W("chrome", title), text: "x" }, "autonomous").decision, "allow", `${title} is not about money`);
  }
});

test("launching is judged by the file's program name too, with the .exe and the folders stripped", () => {
  for (const file of ["C:\\Windows\\System32\\cmd.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\Windows\\regedit.exe", "C:\\Windows\\System32\\Taskmgr.exe", "C:\\Program Files\\Bitwarden\\Bitwarden.exe", "C:\\Program Files\\Cheat Engine 7.5\\cheatengine-x86_64.exe"]) {
    const r = d({ op: "launch", target: { file } }, "autonomous");
    assert.equal(r.decision, "deny", file);
    assert.equal(r.risk.categories[0], "off_limits", file);
  }
  assert.equal(d({ op: "launch", target: { file: "C:\\Windows\\System32\\notepad.exe" } }, "autonomous").decision, "confirm", "an ordinary program given by path is still not 'from the Start menu'");
});

test("looking at a terminal is allowed (it is only text), but a password manager or security screen may not even be read", () => {
  for (const win of [W("powershell", "Windows PowerShell"), W("cmd", "Command Prompt"), W("regedit", "Registry Editor")]) assert.equal(d({ op: "read", window: win }).decision, "allow", `reading ${win.process}`);
  for (const win of [W("1Password", "1Password"), W("Bitwarden", "Bitwarden"), W("consent", "User Account Control"), W("claude", "Claude"), W("Jonah", "Jonah")]) {
    for (const op of ["read", "screenshot", "wait"]) assert.equal(d({ op, window: win }).decision, "deny", `${op} ${win.process}`);
  }
});

test("a password field is never typed into, whatever the mode or window", () => {
  for (const mode of ["autonomous", "supervised", "strict"]) {
    for (const op of ["type", "setText"]) {
      const r = d({ op, window: NOTEPAD, element: { name: "Passphrase", password: true }, text: "x" }, mode);
      assert.deepEqual([r.decision, r.risk.categories[0]], ["deny", "password_field"], `${op} ${mode}`);
    }
  }
  assert.equal(d({ op: "click", window: NOTEPAD, element: { name: "Passphrase", password: true } }).decision, "allow", "clicking into it (to focus) is not typing");
});

test("launching: a Start-menu app is an ordinary action, an unknown program asks, a download or temp folder is refused", () => {
  assert.equal(d({ op: "launch", target: { appName: "Excel", fromStartMenu: true } }, "autonomous").decision, "allow");
  assert.equal(d({ op: "launch", target: { appName: "Excel", fromStartMenu: true } }, "supervised").decision, "confirm");
  const unknown = d({ op: "launch", target: { file: "D:\\tools\\thing.exe" } }, "autonomous");
  assert.deepEqual([unknown.decision, unknown.risk.level], ["confirm", "high"]);
  for (const file of ["C:\\Users\\me\\Downloads\\setup.exe", "C:\\Users\\me\\AppData\\Local\\Temp\\x.exe", "\\\\server\\share\\tool.exe", "https://example.com/a.exe", "c:\\users\\me\\DOWNLOADS\\Setup.EXE"]) {
    const r = d({ op: "launch", target: { file } }, "autonomous");
    assert.deepEqual([r.decision, r.risk.categories[0]], ["deny", "run_downloaded_code"], file);
  }
  // an off-limits program cannot be launched either, even from the Start menu
  for (const appName of ["Windows PowerShell", "cmd", "Registry Editor", "Task Manager", "Bitwarden", "1Password", "Claude", "Jonah"]) {
    const r = d({ op: "launch", target: { appName, fromStartMenu: true } }, "autonomous");
    assert.equal(r.decision, "deny", appName);
  }
});

test("Windows Settings: any change there asks", () => {
  const settings = W("SystemSettings", "Settings");
  assert.equal(d({ op: "click", window: settings, element: { name: "Display" } }, "autonomous").decision, "confirm");
  assert.equal(d({ op: "read", window: settings }, "autonomous").decision, "allow");
});

test("the answer always says why, in words, when it is not 'allow'", () => {
  for (const a of [{ op: "click", window: NOTEPAD, element: { name: "Delete" } }, { op: "close", window: NOTEPAD }, { op: "key", window: NOTEPAD, combo: "win+r" }, { op: "launch", target: { file: "D:\\x.exe" } }, { op: "type", window: W("powershell", "x"), text: "x" }]) {
    const r = d(a, "autonomous");
    assert.notEqual(r.decision, "allow");
    assert.ok(r.why && r.why.length > 15, JSON.stringify(a));
  }
  assert.equal(d({ op: "read", window: NOTEPAD }).why, "");
});

test("offLimits(): the same list as a plain question about a window", () => {
  assert.match(offLimits(W("Bitwarden", "Bitwarden"), { reading: true }), /password manager/);
  assert.equal(offLimits(W("powershell", "x"), { reading: true }), "", "a terminal may be read");
  assert.match(offLimits(W("powershell", "x")), /terminal/);
  assert.equal(offLimits(NOTEPAD), "");
  assert.equal(offLimits(null), "");
  assert.equal(offLimits({ process: "Excel", title: "Book1 - Excel" }), "");
});

// ------------------------------------------------------------------------------------------------ the same protection on a Mac
test("on a Mac: terminals, password managers, the Keychain and the security prompts are off-limits to act in, with the same split for looking", () => {
  for (const process of ["Terminal", "iTerm2", "Warp", "Activity Monitor", "Script Editor", "Automator", "Disk Utility", "Console"]) {
    assert.equal(d({ op: "type", window: W(process), text: "ls" }, "autonomous").decision, "deny", `${process}: acting is refused`);
    assert.equal(d({ op: "read", window: W(process) }, "autonomous").decision, "allow", `${process}: looking is allowed (as for a Windows terminal)`);
  }
  for (const process of ["Keychain Access", "Passwords", "1Password", "SecurityAgent", "loginwindow", "coreauthuiagent"]) {
    assert.equal(d({ op: "read", window: W(process) }, "autonomous").decision, "deny", `${process}: not even looking`);
    assert.equal(d({ op: "click", window: W(process), element: { name: "OK" } }, "autonomous").decision, "deny", process);
  }
  for (const title of ["Privacy & Security", "Security & Privacy", "Touch ID & Password"]) assert.equal(d({ op: "click", window: W("System Settings", title), element: { name: "Next" } }, "autonomous").decision, "deny", title);
  assert.equal(d({ op: "click", window: W("Safari", "Apple") , element: { name: "Next" } }, "autonomous").decision, "allow", "an ordinary Mac app is fine");
  assert.equal(d({ op: "type", window: W("Jonah", "Jonah"), text: "x" }, "autonomous").decision, "deny", "and Jonah itself is not");
});

test("on a Mac: Spotlight, app switching, Force Quit, lock and log out are refused, whatever the spelling or the order of the modifier keys", () => {
  for (const combo of ["cmd+space", "cmd+tab", "cmd+alt+esc", "Command+Option+Escape", "option+command+escape", "cmd+ctrl+q", "ctrl+cmd+q", "cmd+shift+q", "shift+cmd+q", "cmd+alt+shift+q", "ctrl+power", "ctrl+eject"]) {
    assert.equal(d({ op: "key", window: NOTEPAD, combo }, "autonomous").decision, "deny", combo);
  }
  for (const combo of ["cmd+s", "cmd+a", "cmd+c", "cmd+v", "cmd+z", "cmd+shift+s", "cmd+t", "cmd+n", "cmd+f", "shift+cmd+z", "command+shift+4x"]) {
    assert.notEqual(d({ op: "key", window: NOTEPAD, combo }, "autonomous").decision, "deny", combo);
  }
});

test("on a Mac: quitting, closing, and emptying the Trash ask first; Cmd+Enter sends in Mail and Messages", () => {
  for (const combo of ["cmd+q", "Command+W", "shift+cmd+w", "cmd+alt+w", "cmd+delete", "cmd+shift+backspace", "alt+cmd+delete"]) {
    assert.equal(d({ op: "key", window: NOTEPAD, combo }, "autonomous").decision, "confirm", combo);
  }
  for (const process of ["Mail", "Messages", "Microsoft Outlook", "Slack"]) {
    assert.equal(d({ op: "key", window: W(process), combo: "cmd+enter" }, "autonomous").decision, "confirm", `${process}: cmd+enter sends`);
    assert.equal(d({ op: "type", window: W(process), text: "hello\nworld" }, "autonomous").decision, "confirm", `${process}: a line break sends`);
  }
  assert.equal(d({ op: "key", window: NOTEPAD, combo: "cmd+enter" }, "autonomous").decision, "allow", "but not in an editor");
});

test("the user's own Stop shortcut is refused on a Mac too, however the keys are named (Control+Option+X)", () => {
  for (const combo of ["ctrl+alt+x", "control+option+x", "option+control+x", "ctrl+opt+x", "Control + Option + Shift + X", "cmd+ctrl+alt+x"]) {
    assert.equal(d({ op: "key", window: NOTEPAD, combo }, "autonomous").decision, "deny", combo);
  }
  assert.notEqual(d({ op: "key", window: NOTEPAD, combo: "option+x" }, "autonomous").decision, "deny", "Option alone is fine (it types a character)");
  assert.notEqual(d({ op: "key", window: NOTEPAD, combo: "control+x" }, "autonomous").decision, "deny");
});

test("on a Mac: programs from Downloads, the temporary folders and a mounted disk image are refused; an installed app asks; a path ending in .app is judged by its name", () => {
  for (const file of ["/Users/me/Downloads/Setup.app", "/Users/me/Downloads/sub/Tool.app", "/tmp/x.app", "/private/tmp/x.app", "/private/var/folders/ab/T/x.app", "/Volumes/Install Foo/Foo.app"]) {
    assert.equal(d({ op: "launch", target: { file, appName: file.split("/").pop() } }, "autonomous").decision, "deny", file);
  }
  assert.equal(d({ op: "launch", target: { file: "/Applications/Terminal.app", appName: "Terminal.app" } }, "autonomous").decision, "deny", "a terminal given as a path");
  assert.equal(d({ op: "launch", target: { file: "/Applications/Keychain Access.app", appName: "Keychain Access.app" } }, "autonomous").decision, "deny");
  const safari = d({ op: "launch", target: { appName: "Safari", fromStartMenu: true } }, "autonomous");
  assert.equal(safari.decision, "allow", "an installed app is fine in the relaxed mode");
  assert.equal(d({ op: "launch", target: { appName: "Safari", fromStartMenu: true } }, "supervised").decision, "confirm");
  assert.match(d({ op: "launch", target: { appName: "Safari", fromStartMenu: true } }, "strict").why, /from the list of installed apps/);
  assert.equal(d({ op: "launch", target: { file: "/Applications/Weird.app", appName: "Weird.app" } }, "autonomous").decision, "confirm", "an app that is not in the list of installed apps asks");
});

test("changing System Settings asks, as changing Windows settings does", () => {
  const r = d({ op: "click", window: W("System Settings", "Wi-Fi"), element: { name: "Turn Wi-Fi Off" } }, "autonomous");
  assert.equal(r.decision, "confirm");
  assert.match(r.why, /settings/);
  assert.equal(d({ op: "click", window: W("System Preferences", "General"), element: { name: "Dark" } }, "autonomous").decision, "confirm");
});

test("a click at a bare spot in a messaging or mail window asks first, because nothing says it is not Send; a named control there is judged by its name", () => {
  const wins = [
    W("msedge", "WhatsApp - Microsoft Edge"), W("chrome", "Inbox (3) - Gmail - Google Chrome"), W("msedge", "Telegram Web"), W("firefox", "Slack | general | Acme"),
    W("chrome", "Messenger"), W("msedge", "Messages for web"), W("chrome", "Instagram"), W("chrome", "LinkedIn Messaging"), W("Discord", "general - Discord"), W("OUTLOOK", "Inbox - Outlook"),
  ];
  for (const win of wins) {
    const spot = d({ op: "click", window: win, spot: true }, "autonomous");
    assert.equal(spot.decision, "confirm", `${win.title}: a bare spot`);
    assert.equal(spot.risk.level, "high", win.title);
    assert.equal(spot.risk.categories[0], "sends_message", win.title);
    assert.match(spot.why, /could press Send/);
    // the thing under the spot is only a page: Windows names a web page after its title, which says nothing about what is pressed (the tools pass no name then)
    assert.equal(d({ op: "click", window: win, spot: true, element: undefined }, "autonomous").decision, "confirm", win.title);
    assert.equal(d({ op: "click", window: win, spot: true, element: { name: "" } }, "autonomous").decision, "confirm", `${win.title}: an empty name is no name`);
    // a named chat row: an ordinary click
    assert.equal(d({ op: "click", window: win, spot: true, element: { name: "Ansuman Kumar" } }, "autonomous").decision, "allow", `${win.title}: a contact by name`);
    // but a named control that sends is still judged by its name
    const send = d({ op: "click", window: win, spot: true, element: { name: "Send" } }, "autonomous");
    assert.equal(send.decision, "confirm", `${win.title}: Send by name`);
    assert.equal(send.risk.categories[0], "risky_control");
  }
});

test("a click at a spot in an ordinary window is an ordinary click (no card for every pixel), and a click by element in a chat is unaffected", () => {
  for (const win of [NOTEPAD, W("EXCEL", "Budget - Excel"), W("msedge", "News - Microsoft Edge"), W("chrome", "Cat videos - YouTube")]) {
    assert.equal(d({ op: "click", window: win, spot: true }, "autonomous").decision, "allow", win.title);
  }
  assert.equal(d({ op: "click", window: W("msedge", "WhatsApp - Microsoft Edge"), element: { name: "Ansuman" } }, "autonomous").decision, "allow");
  for (const element of [{ name: "" }, { name: "", type: "Pane" }, undefined]) {
    assert.equal(d({ op: "click", window: W("msedge", "WhatsApp - Microsoft Edge"), element }, "autonomous").decision, "allow", "a click on a control (even one the tools could not name) is not a click at a spot: only spot clicks ask for want of a name");
  }
  assert.equal(d({ op: "click", window: NOTEPAD, spot: true }, "supervised").decision, "confirm", "the stricter modes ask for every action, as before");
});

test("words that merely contain a messaging name do not make a window a messaging window", () => {
  for (const title of ["Chatham House report - Word", "Compositions - Notepad", "Signaling theory - Edge", "Slacker Radio", "Skyper", "Voicemail greeting - Notepad"]) {
    assert.equal(d({ op: "click", window: W("msedge", title), spot: true }, "autonomous").decision, "allow", title);
  }
});
