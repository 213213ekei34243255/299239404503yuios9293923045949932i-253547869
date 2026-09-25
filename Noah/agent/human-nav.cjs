// Noah/agent/human-nav.cjs
//
// "Act like a person": inside a site, a person uses the page - the search box, the links, the buttons - and does not
// type a guessed URL into the address bar. Models that jump to a URL they made up (`youtube.com/watch?v=...`,
// `amazon.com/s?k=...`) skip everything the user wants to watch, and often land on a page that does not exist.
//
// humanNavigationBlock() says why a same-site navigation should not be executed as-is; null means it is fine:
//   - the site's home page ("/"), or any URL on another site (that is how you open a site);
//   - a URL the user wrote in the goal;
//   - a URL that is a real link on the current page (that is a click, just not made with the mouse).

"use strict";

const stripWww = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
const clean = (u) => u.replace(/#.*$/, "").replace(/\/+$/, "");

function humanNavigationBlock({ url, goal, currentUrl, elements }) {
  let target;
  let here;
  try {
    target = new URL(url);
    here = new URL(currentUrl);
  } catch (_) {
    return null;
  }
  if (!/^https?:$/.test(here.protocol) || !/^https?:$/.test(target.protocol)) return null;
  if (stripWww(target.host) !== stripWww(here.host)) return null; // opening another site
  if (target.pathname === "/" || target.pathname === "") return null;
  if (clean(target.href) === clean(here.href)) return null; // "I am already here": harmless
  const g = String(goal || "").toLowerCase();
  if (g.includes(clean(target.href).toLowerCase()) || g.includes(`${stripWww(target.host)}${target.pathname}`.replace(/\/+$/, "").toLowerCase())) return null;
  for (const e of elements || []) {
    if (e.role !== "link" || !e.href) continue;
    try {
      if (clean(new URL(e.href, here.href).href) === clean(target.href)) return null;
    } catch (_) {
      /* ignore */
    }
  }
  return `Do not jump to a URL inside ${stripWww(here.host)}. Do it the way a person would on this page: click the search box and type, scroll, and click the link or button you want.`;
}

module.exports = { humanNavigationBlock };
