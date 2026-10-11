// Noah/desktop/policy.cjs
//
// What Noah may do on the user's Windows desktop. Pure rules, no windows: given an action and the window it is aimed at, the answer is
// allow / confirm / deny, and why. It reuses safety/policy.cjs `decide` so the modes mean the same thing everywhere:
//   autonomous  asks only for HIGH-risk actions     supervised  asks for medium and high     strict  asks before every change
//
// The user chose "the whole desktop, ask only for risky things". That is the default mode here. What stays OFF-LIMITS whatever the mode, because a
// slip would be hard to undo or would reach out of the task:
//   * Noah's own windows and the Claude app (it could type into the very conversation that is running it)
//   * password managers and the Windows security and sign-in screens (nothing there is Noah's business)
//   * terminals and shells (typing into one bypasses the command policy that guards the project tasks)
//   * tools that edit other programs (a process or memory editor, the registry editor, Task Manager)
//   * the Windows key and the shortcuts that sign out, lock, switch user or open Run
//   * programs launched from a download or temporary folder (the "run downloaded code" rule)
//
// Heuristics, not a boundary: they work from window titles, program names and control names, which an application chooses. They catch the common
// cases; the reading of the screen as untrusted text and the user's own Stop button are what stand behind them.

"use strict";

const { decide } = require("../safety/policy.cjs");

const risk = (level, category, reason) => ({ level, categories: [category], reasons: [reason] });

const lower = (s) => String(s || "").toLowerCase();
const exeName = (p) => lower(p).replace(/\.(exe|app)$/, "");

// ---- off-limits programs (matched on the program name, without .exe)
const OWN = ["jonah", "claude", "claude code", "claudecode"]; // the app this runs in, and the Claude app
const SECRET_KEEPERS = ["1password", "bitwarden", "keepass", "keepassxc", "keepassxc-proxy", "lastpass", "dashlane", "enpass", "nordpass", "roboform", "keeper", "proton pass", "protonpass", "keychain access", "passwords"]; // (the last two are the Mac's own)
const SECURITY_UI = ["consent", "securityhealthsystray", "securityhealthservice", "sechealthui", "windowsdefender", "logonui", "credwiz", "winlogon", "lockapp", "windows security", "securityagent", "loginwindow", "coreauthuiagent", "universalaccessauthwarn"]; // (the last four are the Mac's)
const SHELLS = ["cmd", "powershell", "powershell_ise", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "bash", "wsl", "wslhost", "mintty", "putty", "git-bash", "sh", "alacritty", "hyper", "termius", "terminal", "iterm2", "iterm", "warp", "wezterm", "kitty", "ghostty", "tabby", "tmux", "xterm"]; // (from "terminal" on: the Mac's)
const PROCESS_TOOLS = ["regedit", "taskmgr", "mmc", "cheatengine", "cheatengine-x86_64", "cheatengine-x86_64-sse4-avx2", "cheatengine-i386", "processhacker", "procexp", "procexp64", "procmon", "perfmon", "diskpart", "gpedit", "secpol", "services", "eventvwr", "compmgmt", "lusrmgr", "wscript", "cscript", "mshta", "activity monitor", "console", "disk utility", "script editor", "automator", "system information"]; // (from "activity monitor" on: the Mac's)

// ---- windows where ANY action deserves a question (money, sign-in, official or sensitive things): matched on the title
const SENSITIVE_TITLE = /\b(bank|banking|netbanking|paypal|upi|payment|payments|checkout|wallet|crypto|binance|coinbase|invoice|billing|tax return|income tax|sign in|log in|login|password|passcode|verify|verification|otp|one-time|two-factor|2fa|credit card|debit card)\b/i;
// ---- messaging and mail: a typed newline or an Enter key can SEND
const MESSAGING = ["discord", "whatsapp", "telegram", "slack", "teams", "ms-teams", "outlook", "olk", "thunderbird", "signal", "skype", "zoom", "messenger", "mailspring", "hxoutlook", "wlmail", "messages", "mail", "facetime", "imessage", "microsoft outlook", "microsoft teams", "zoom.us", "wechat"]; // (from "messages" on: the Mac's)
// (a web app in a browser has its name in the window title: "(1) WhatsApp Business - Personal - Microsoft Edge" is a messaging window as much as the WhatsApp program is)
const MESSAGING_TITLE = /\b(chat|compose|message|messages|inbox|mail|reply|new email|draft|whatsapp|telegram|messenger|signal|discord|slack|gmail|outlook|instagram|linkedin|microsoft teams|skype|hangouts|facebook)\b/i;
// ---- control names that do something hard to undo, or that reach other people, money or the system
const RISKY_CONTROL = /\b(send|submit|post|publish|share|delete|remove|erase|wipe|format|buy|purchase|pay|checkout|place order|order now|confirm|uninstall|install|reset|restore defaults|factory|sign out|log out|logout|empty recycle|empty bin|transfer|donate|subscribe|accept|agree|allow|grant|authori[sz]e|overwrite|replace all|discard|don't save|do not save|clear all|clear history|close without saving|unpair|disconnect|reboot|restart|shut ?down|power off|sleep|hibernate|run as|apply|upgrade|update now)\b/i;

// ---- keys: some shortcuts close things or leave the task
const KEY_DENY = /(^|\+)win(\+|$)|ctrl\+alt\+(delete|del)|alt\+tab$|ctrl\+shift\+esc|cmd\+(space|tab)|cmd\+alt\+esc|cmd\+ctrl\+q|cmd\+(alt\+)?shift\+q|(cmd\+)?(alt\+)?ctrl\+(power|eject)/i; // the Windows key, task switching, the secure attention sequence, Task Manager; on a Mac Spotlight, app switching, Force Quit, lock screen, log out, power
const KEY_CONFIRM = /^(alt\+f4|ctrl\+w|ctrl\+shift\+w|ctrl\+q|ctrl\+shift\+delete|ctrl\+delete|shift\+delete|f11|ctrl\+shift\+n|delete|del|cmd\+q|cmd\+w|cmd\+shift\+w|cmd\+alt\+w|cmd\+(shift\+)?(alt\+)?(delete|backspace))$/i;
const KEY_SEND = /^(enter|return|ctrl\+enter|ctrl\+return|shift\+enter|alt\+enter|cmd\+enter|cmd\+return|cmd\+shift\+enter)$/i;

// the modifiers in one fixed order with one name each (the Mac's command is "cmd", its option is "alt"): so the rules below need not list every spelling and order
const MOD_ORDER = ["win", "cmd", "ctrl", "alt", "shift"];
const MOD_ALIAS = { windows: "win", command: "cmd", meta: "cmd", control: "ctrl", option: "alt", opt: "alt" };
const COMBO = (k) => {
  const parts = lower(k).replace(/\s+/g, "").split("+").map((p) => MOD_ALIAS[p] || p);
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const mine = MOD_ORDER.filter((m) => mods.includes(m));
  return [...mine, ...mods.filter((m) => !MOD_ORDER.includes(m)), key].join("+");
};
// Ctrl+Alt+<key> is the user's own: Jonah's Stop shortcut is Ctrl+Alt+X (Noah/desktop/guard.cjs), and Ctrl+Alt is also AltGr on many keyboards. Noah types text with
// "type", never with a Ctrl+Alt chord, so any chord holding both (in either order, with any name for the keys) is refused.
const holdsCtrlAndAlt = (k) => { const p = COMBO(k).split("+"); return p.includes("ctrl") && p.includes("alt"); }; // (alt is the Mac's option key too)

const inList = (list, name) => list.includes(exeName(name));
const startsWithAny = (list, name) => { const n = exeName(name); return list.some((x) => n === x || n.startsWith(x)); };

/** Why this window is off-limits ("" if it is not). `reading` = only looking: looking at a terminal is allowed, looking at a password manager is not. */
function offLimits(win, { reading = false } = {}) {
  if (!win) return "";
  const proc = exeName(win.process);
  const title = lower(win.title);
  if (inList(OWN, proc) || /^(jonah|claude)\b/.test(title) || /\b(claude code|noah)\b.*\b(panel|assistant)\b/.test(title)) return "this is Noah's own window or the Claude app: Noah never operates the window it is running in";
  if (startsWithAny(SECRET_KEEPERS, proc) || /\b(1password|bitwarden|keepass|lastpass|dashlane|enpass|nordpass|roboform)\b/.test(title)) return "this is a password manager: nothing in it is Noah's business";
  if (inList(SECURITY_UI, proc) || /\b(user account control|windows security|windows hello|credential manager|privacy & security|security & privacy|touch id & password|login password)\b/.test(title)) return "this is a Windows security or sign-in screen: only you should use it";
  if (!reading && (inList(SHELLS, proc) || /\b(command prompt|windows powershell|git bash|ubuntu|wsl)\b/.test(title))) return "this is a terminal: typing into one would bypass the command safety rules that guard project tasks (use the shell tool instead)";
  if (!reading && (startsWithAny(PROCESS_TOOLS, proc) || /\b(registry editor|task manager|cheat engine|process hacker|group policy|local security policy|services)\b/.test(title))) return "this tool edits other programs or the system itself";
  return "";
}

/**
 * @param {object} a
 * @param {'windows'|'read'|'screenshot'|'wait'|'focus'|'click'|'type'|'setText'|'key'|'scroll'|'launch'|'close'} a.op
 * @param {{ title?: string, process?: string, path?: string }} [a.window]   the window the action is aimed at
 * @param {{ name?: string, type?: string, password?: boolean }} [a.element]  the control, when one is named
 * @param {string} [a.text]    text to type or set
 * @param {string} [a.combo]   key combination
 * @param {{ appName?: string, path?: string, file?: string, fromStartMenu?: boolean }} [a.target]  what is being launched
 * @param {object} [o]
 * @param {'autonomous'|'supervised'|'strict'} [o.mode]
 * @returns {{ decision: 'allow'|'confirm'|'deny', why: string, risk: { level: string, categories: string[], reasons: string[] } }}
 */
function decideDesktop(a, { mode = "autonomous" } = {}) {
  const op = a.op;
  const win = a.window || null;
  const el = a.element || null;
  const looking = ["windows", "read", "screenshot", "wait"].includes(op);
  const mutates = !looking && op !== "focus";

  // ---- off-limits, whatever the mode
  if (op === "launch") {
    const t = a.target || {};
    const p = lower(t.path || t.file || "");
    if (/\\(downloads|temp|appdata\\local\\temp)\\/.test(p) || /^\\\\/.test(p) || /^https?:/.test(p) || /^\/(users\/[^/]+\/downloads|tmp|private\/(tmp|var)|var\/folders|volumes)\//.test(p) || /\/downloads\//.test(p)) return { decision: "deny", why: "Noah does not run programs from a download, temporary or network location", risk: risk("blocked", "run_downloaded_code", "a program from a download, temporary or network location") };
    const name = exeName((t.appName || p.split("\\").pop() || ""));
    const own = offLimits({ process: name, title: t.appName || name }, { reading: false });
    if (own) return { decision: "deny", why: own, risk: risk("blocked", "off_limits", own) };
  } else if (win) {
    const why = offLimits(win, { reading: looking });
    if (why) return { decision: "deny", why, risk: risk("blocked", "off_limits", why) };
  }
  if (op === "key" && a.combo && (KEY_DENY.test(COMBO(a.combo)) || holdsCtrlAndAlt(a.combo))) return { decision: "deny", why: `the key combination ${a.combo} leaves the task (the Windows key, task switching, the sign-in screen, or the user's own Ctrl+Alt shortcuts such as Stop)`, risk: risk("blocked", "off_limits", "a system-level key combination") };
  if ((op === "type" || op === "setText") && el && el.password) return { decision: "deny", why: "Noah never types into a password field", risk: risk("blocked", "password_field", "a password field") };

  // ---- how risky, for the user's mode to judge
  let r;
  if (looking) r = risk("low", "look", "only looking");
  else if (op === "focus") r = risk("low", "focus", "brings a window to the front");
  else r = risk("medium", "act", "changes something in an application");

  const sensitiveWin = win && SENSITIVE_TITLE.test(String(win.title || ""));
  const msgApp = win && (startsWithAny(MESSAGING, win.process) || MESSAGING_TITLE.test(String(win.title || "")));

  if (op === "click" && el && RISKY_CONTROL.test(String(el.name || ""))) r = risk("high", "risky_control", `presses "${String(el.name).slice(0, 40)}", which can send, delete, buy or change something that is hard to undo`);
  // in a window about money, sign-in or verification EVERYTHING that acts is a question, whatever the control is called ("Next" can be the step that pays)
  if (sensitiveWin && ["click", "type", "setText", "key", "scroll"].includes(op)) r = risk("high", "sensitive_window", "acts in a window about money, sign-in or verification");
  // a click at a bare spot can press Send and nothing says what it presses: in a messaging window it asks, unless the thing under it has a name (and then the risky-name rule judges it)
  if (op === "click" && a.spot && msgApp && !(el && el.name)) r = risk("high", "sends_message", "clicks at a spot in a messaging or mail window, where it could press Send");
  if (op === "type" && msgApp && /[\r\n]/.test(String(a.text || ""))) r = risk("high", "sends_message", "types a line break in a messaging or mail window, which sends the message");
  if (op === "key" && a.combo) {
    const k = COMBO(a.combo);
    if (KEY_CONFIRM.test(k)) r = risk("high", "closes_or_deletes", `${a.combo} closes a window or deletes something`);
    else if (KEY_SEND.test(k) && msgApp) r = risk("high", "sends_message", `${a.combo} in a messaging or mail window sends the message`);
    else if (KEY_SEND.test(k) && sensitiveWin) r = risk("high", "sensitive_window", `${a.combo} in a window about money, sign-in or verification`);
  }
  if (op === "close") r = risk("high", "closes_window", "closes a window (it may hold unsaved work)");
  if (win && /^(systemsettings|settings|system settings|system preferences)$/.test(exeName(win.process)) && mutates) r = risk("high", "system_settings", "changes the system's settings");
  if (op === "launch") {
    const t = a.target || {};
    if (t.fromStartMenu) r = risk("medium", "launch", `starts ${t.appName || "an app"} from the list of installed apps`);
    else r = risk("high", "launch_unknown", "starts a program that is not in the list of installed apps");
  }

  const d = decide(r, { mode, mutates: mutates || op === "launch" });
  return { decision: d.decision, why: d.decision === "allow" ? "" : (r.reasons[0] || d.why), risk: r };
}

module.exports = { decideDesktop, offLimits, RISKY_CONTROL, SENSITIVE_TITLE };
