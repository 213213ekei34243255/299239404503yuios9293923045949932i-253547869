// internal-pages.js - one definition of "this is one of Jonah's OWN pages" (the start page, error pages, the drawing tool, ...), shared
// by everything in the browser chrome that shows or acts on the current page's address.
//
//   displayUrl(url)  what the address bar may show. Internal pages show an EMPTY bar (like a new-tab page in any browser), so no file
//                    name or install path (file:///C:/Users/.../home.html, "home.html", 127.0.0.1:5589/search.html) is ever visible.
//   canCite(url)     citations only make sense for a real website: true only for http(s) pages that are not Jonah's own.
//
// Works in the page (window.JonahUrls) and in Node (require) so it can be unit tested.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JonahUrls = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Jonah's own local UI server (main.cjs serves the app's pages on this port for the pages that are loaded over http).
  const OWN_SERVER = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):5589(?:[/?#]|$)/i;
  // How a tab remembers one of Jonah's own pages: a bare file name such as "home.html".
  const BARE_LOCAL_PAGE = /^[\w.-]+\.html?(?:[?#].*)?$/i;
  // Everything that is not a website at all.
  const NON_WEB_SCHEME = /^(?:file|about|data|blob|javascript|chrome|chrome-error|devtools|view-source|jonah):/i;

  function isInternalUrl(url) {
    const s = String(url == null ? "" : url).trim();
    if (!s) return true; // nothing loaded yet: there is nothing to show or cite
    if (NON_WEB_SCHEME.test(s)) return true;
    if (OWN_SERVER.test(s)) return true;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && BARE_LOCAL_PAGE.test(s)) return true;
    return false;
  }

  function displayUrl(url) {
    const s = String(url == null ? "" : url).trim();
    if (/google-blocked\.html/i.test(s)) return "Jonah://blocked"; // the one internal page that has always had a friendly name
    return isInternalUrl(s) ? "" : s;
  }

  function canCite(url) {
    const s = String(url == null ? "" : url).trim();
    return /^https?:\/\//i.test(s) && !isInternalUrl(s);
  }

  return { isInternalUrl, displayUrl, canCite };
});
