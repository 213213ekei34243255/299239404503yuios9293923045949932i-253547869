// hubs/images.cjs - fetch ONE image for a moodboard, safely. A page cannot do this itself (cross-origin images cannot be read), so the main process does it for the
// Aesthetic Lab, with limits: https only, never a private/local address (no reaching into the user's own network), a size cap, a time cap, image content only.
"use strict";

const MAX_BYTES = 8 * 1024 * 1024;
const OK_TYPES = /^image\/(png|jpe?g|webp|gif|avif|bmp)$/i;

/** True for addresses that point inside the user's own computer or network. */
function isPrivateAddress(addr) {
  const a = String(addr || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "localhost" || a.endsWith(".localhost") || a.endsWith(".local") || a.endsWith(".internal") || a.endsWith(".lan") || a.endsWith(".home.arpa")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m) { const [x, y] = [Number(m[1]), Number(m[2])]; return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || x >= 224; }
  if (a.includes(":")) { // IPv6: loopback, unspecified, unique-local, link-local, and IPv4-mapped private ones
    if (a === "::1" || a === "::" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return false;
}
/** { ok, url } or { ok:false, why } for a URL that may be fetched. Host NAMES are checked here; the addresses they resolve to are checked by the fetcher. */
function checkUrl(text) {
  let u; try { u = new URL(String(text)); } catch (_) { return { ok: false, why: "That is not a web address." }; }
  if (u.protocol !== "https:") return { ok: false, why: "Only https:// image links are allowed." };
  if (u.username || u.password) return { ok: false, why: "Links with a login in them are not allowed." };
  if (isPrivateAddress(u.hostname)) return { ok: false, why: "That address is inside your own network, so Jonah will not fetch it." };
  return { ok: true, url: u.href };
}
/** Image bytes by their first bytes: the server's word is not trusted. */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.slice(0, 3).toString() === "GIF") return "image/gif";
  if (buf.slice(4, 12).toString() === "ftypavif") return "image/avif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

/**
 * `fetchFn` and `lookup` are injected. Follows at most 3 redirects, re-checking every hop and every resolved address.
 * Resolves { ok:true, mime, base64, bytes } or { ok:false, why }.
 */
async function fetchImage(text, { fetchFn = (...a) => fetch(...a), lookup = async (host) => (await require("dns").promises.lookup(host, { all: true })).map((r) => r.address), timeoutMs = 15000 } = {}) {
  let current = text;
  for (let hop = 0; hop <= 3; hop++) {
    const c = checkUrl(current);
    if (!c.ok) return c;
    try { for (const addr of await lookup(new URL(c.url).hostname)) if (isPrivateAddress(addr)) return { ok: false, why: "That address resolves to your own network, so Jonah will not fetch it." }; } catch (_) { return { ok: false, why: "That site could not be found." }; }
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(c.url, { redirect: "manual", signal: ctl.signal, headers: { Accept: "image/*", "User-Agent": "JonahBrowser/1.4 (moodboard)" } });
      if (res.status >= 300 && res.status < 400 && res.headers && res.headers.get("location")) { current = new URL(res.headers.get("location"), c.url).href; continue; }
      if (!res.ok) return { ok: false, why: `The site answered ${res.status}.` };
      const type = String((res.headers && res.headers.get("content-type")) || "").split(";")[0].trim();
      if (type && !OK_TYPES.test(type)) return { ok: false, why: "That link is not an image." };
      const len = Number(res.headers && res.headers.get("content-length"));
      if (len > MAX_BYTES) return { ok: false, why: "That image is too big (limit 8 MB)." };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) return { ok: false, why: "That image is too big (limit 8 MB)." };
      const mime = sniff(buf);
      if (!mime) return { ok: false, why: "That file is not a picture Jonah can read." };
      return { ok: true, mime, base64: buf.toString("base64"), bytes: buf.length };
    } catch (err) { return { ok: false, why: err && err.name === "AbortError" ? "The site took too long." : "Could not download it (" + String(err && err.message || err).slice(0, 60) + ")." }; } finally { clearTimeout(timer); }
  }
  return { ok: false, why: "Too many redirects." };
}

module.exports = { MAX_BYTES, isPrivateAddress, checkUrl, sniff, fetchImage };
