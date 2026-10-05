// Noah/bench/integration/mac-diagnose2.js - run on a Mac with:  osascript -l JavaScript mac-diagnose2.js
// Round 2 of the Mac diagnosis. Round 1 showed that macOS ANSWERS the "windows of this app" question (error code 0) but the helper could not read the length of the answer
// ("count": null). This tries the ways of reading such an answer, and the ways of asking whether Screen Recording is allowed. It changes nothing.
ObjC.import("Cocoa");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");
ObjC.import("Foundation");

var lines = [];
function say(k, v) { lines.push(k + ": " + (typeof v === "string" ? v : JSON.stringify(v))); }
function t(label, fn) { try { say(label, fn()); } catch (e) { say(label, "THREW: " + e); } }

function ask(el, name) { var r = Ref(); var err = $.AXUIElementCopyAttributeValue(el, $(name), r); return { err: err, value: err === 0 ? r[0] : undefined }; }

function describeList(v) {
  var out = { typeofValue: typeof v };
  try { out.directCount = typeof v.count + " " + String(v.count); } catch (e) { out.directCount = "THREW " + e; }
  try { out.directCountCall = String(v.count()); } catch (e) { out.directCountCall = "THREW " + e; }
  try { out.length = String(v.length); } catch (e) { out.length = "THREW " + e; }
  var casted = null;
  try { casted = ObjC.castRefToObject(v); out.castCount = typeof casted.count + " " + String(casted.count); out.castCountNumber = Number(casted.count); } catch (e) { out.cast = "THREW " + e; }
  try { var u = ObjC.unwrap(v); out.unwrap = typeof u + (Array.isArray(u) ? " array of " + u.length : ""); } catch (e) { out.unwrap = "THREW " + e; }
  try { var d = ObjC.deepUnwrap(v); out.deepUnwrap = typeof d + (Array.isArray(d) ? " array of " + d.length : ""); } catch (e) { out.deepUnwrap = "THREW " + e; }
  // can the first element be used afterwards? (read its title and role)
  if (casted && Number(casted.count) > 0) {
    try {
      var first = casted.objectAtIndex(0);
      var ti = ask(first, "AXTitle"); var ro = ask(first, "AXRole");
      out.firstElement = { title: ti.err === 0 ? ObjC.unwrap(ti.value) : "error " + ti.err, role: ro.err === 0 ? ObjC.unwrap(ro.value) : "error " + ro.err };
      var ch = ask(first, "AXChildren");
      out.firstElementChildren = ch.err === 0 ? ("cast count " + Number(ObjC.castRefToObject(ch.value).count)) : "error " + ch.err;
    } catch (e) { out.firstElement = "THREW " + e; }
  }
  return out;
}

var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
var wanted = ["Google Chrome", "Finder", "Terminal"];
for (var i = 0; i < Number(apps.count); i++) {
  var a = apps.objectAtIndex(i);
  var name = ObjC.unwrap(a.localizedName);
  if (Number(a.activationPolicy) !== 0 || wanted.indexOf(name) < 0) continue;
  (function (appName, pid) {
    t("AXWindows of " + appName, function () {
      var res = ask($.AXUIElementCreateApplication(pid), "AXWindows");
      if (res.err !== 0) return { error: res.err };
      return describeList(res.value);
    });
  })(name, Number(a.processIdentifier));
}

// Screen Recording: is the function there under another name, or can it be bound by hand?
t("typeof $.CGPreflightScreenCaptureAccess", function () { return typeof $.CGPreflightScreenCaptureAccess; });
t("bound by hand: CGPreflightScreenCaptureAccess()", function () { ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); return String($.CGPreflightScreenCaptureAccess()); });
t("another way: do other apps' windows have names? (names are hidden without Screen Recording)", function () {
  var info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
  var normal = info.filter(function (w) { return w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 60; });
  return { normalWindows: normal.length, withNames: normal.filter(function (w) { return !!w.kCGWindowName; }).length, owners: normal.slice(0, 6).map(function (w) { return w.kCGWindowOwnerName + (w.kCGWindowName ? ": " + w.kCGWindowName : " (no name)"); }) };
});

lines.join("\n");
