// Noah/bench/integration/mac-diagnose.js - run on a Mac with:  osascript -l JavaScript mac-diagnose.js
// Prints, step by step, what macOS answers to the exact calls Jonah's Mac helper makes (running apps, each app's windows through the Accessibility API, the on-screen window list,
// the permissions). It changes nothing. It runs with the permissions of the app you run it from (Terminal), not Jonah's: its point is to show WHAT macOS answers and whether
// the calls themselves work, so a bug in the way the helper asks can be told from a missing permission.
ObjC.import("Cocoa");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");
ObjC.import("Foundation");

var lines = [];
function say(k, v) { lines.push(k + ": " + v); }
function t(label, fn) {
  try { var v = fn(); say(label, typeof v === "string" ? v : JSON.stringify(v)); } catch (e) { say(label, "THREW: " + e); }
}

t("macOS", function () { return ObjC.unwrap($.NSProcessInfo.processInfo.operatingSystemVersionString); });
t("AXIsProcessTrusted (for the app you ran this from)", function () { return !!$.AXIsProcessTrusted(); });
t("CGPreflightScreenCaptureAccess (same)", function () { return !!$.CGPreflightScreenCaptureAccess(); });

var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
t("running applications", function () { return Number(apps.count); });

var regular = [];
t("first 14 apps  name | pid | activationPolicy (0 = normal app)", function () {
  var r = [];
  for (var i = 0; i < Number(apps.count); i++) {
    var a = apps.objectAtIndex(i);
    var p = Number(a.activationPolicy);
    if (p === 0) regular.push({ name: ObjC.unwrap(a.localizedName), pid: Number(a.processIdentifier) });
    if (r.length < 14) r.push(ObjC.unwrap(a.localizedName) + " | " + a.processIdentifier + " | " + p + " (" + typeof a.activationPolicy + ")");
  }
  return r;
});
say("normal apps found", regular.length + " -> " + regular.map(function (a) { return a.name; }).join(", "));

regular.slice(0, 8).forEach(function (a) {
  t("AXWindows of " + a.name, function () {
    var el = $.AXUIElementCreateApplication(a.pid);
    var r = Ref();
    var err = $.AXUIElementCopyAttributeValue(el, $("AXWindows"), r);
    var res = { errorCode: err, gotValue: r[0] !== undefined && r[0] !== null };
    if (res.gotValue) {
      res.count = Number(r[0].count);
      if (res.count > 0) {
        var w = r[0].objectAtIndex(0);
        var tt = Ref();
        var e2 = $.AXUIElementCopyAttributeValue(w, $("AXTitle"), tt);
        res.firstWindowTitle = e2 === 0 ? ObjC.unwrap(tt[0]) : "(error " + e2 + ")";
      }
    }
    return res;
  });
});

t("on-screen window list (count, then first 8: owner | layer | name | x,y,w,h)", function () {
  var info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
  return {
    count: info.length,
    first: info.slice(0, 8).map(function (w) {
      var b = w.kCGWindowBounds;
      return w.kCGWindowOwnerName + " | " + w.kCGWindowLayer + " | " + (w.kCGWindowName || "") + " | " + (b ? [b.X, b.Y, b.Width, b.Height].join(",") : "?");
    })
  };
});

lines.join("\n");
