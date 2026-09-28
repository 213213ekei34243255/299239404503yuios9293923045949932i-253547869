// file-extract.cjs
//
// Turns an uploaded file (bytes + name) into plain text the assistant can read. Runs in Electron's MAIN process (Node 18:
// the version Electron 28 ships, which is why pdfjs-dist is pinned to its 3.x line - 4.x needs Node 20).
//
//   PDF                     pdfjs-dist text layer, page by page (a scanned PDF has no text layer: reported, not guessed)
//   .docx                   mammoth -> HTML -> Markdown (headings, lists, tables survive)
//   .doc  (Word 97-2003)    word-extractor
//   .xlsx .xls .xlsm .ods .csv   SheetJS, every sheet as a Markdown table (capped per sheet)
//   .pptx                   slides in DISPLAY order from presentation.xml (not file-name order), text + tables + speaker notes
//   .ppt  (PowerPoint 97-2003)   text atoms read out of the OLE "PowerPoint Document" stream
//   .odt .odp .ods          content.xml text
//   images                  OCR (tesseract.js)
//   .rtf                    control words stripped
//   everything else that is text (txt md csv json html xml source code ...)  decoded as UTF-8/UTF-16
//
// Every extractor returns { kind, text, meta, warnings }. Nothing here ever throws for "this file has no text": that is
// a normal result with a warning, so the panel can tell the user plainly instead of failing silently.

"use strict";

const path = require("path");

const MAX_FILE_BYTES = 30 * 1024 * 1024; // refuse larger uploads outright
const MAX_TEXT_CHARS = 400_000; // per file, after extraction
const MAX_SHEET_ROWS = 2000; // rows kept per spreadsheet sheet
const MAX_SHEET_COLS = 60;
const MAX_ZIP_ENTRY_BYTES = 40 * 1024 * 1024; // zip-bomb guard: one office XML part larger than this is skipped

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".html", ".htm", ".css", ".log", ".yml", ".yaml", ".toml", ".ini", ".cfg",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".bat", ".ps1", ".sql",
  ".swift", ".kt", ".dart", ".lua", ".r", ".tex", ".srt", ".vtt", ".env", ".gitignore",
]);

class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ small helpers

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new ExtractError("bad_data", "The file's contents were not received as bytes.");
}

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString("utf8");
  return buf.toString("utf8");
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
function safeFromCodePoint(n) {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch (_) {
    return "";
  }
}

function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeCell(v) {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

/** rows: string[][] -> a GitHub-style Markdown table (first row is the header). */
function rowsToMarkdown(rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (!width || !rows.length) return "";
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => escapeCell(r[i])));
  const head = norm[0];
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const r of norm.slice(1)) lines.push(`| ${r.join(" | ")} |`);
  return lines.join("\n");
}

function clip(text, warnings) {
  if (text.length <= MAX_TEXT_CHARS) return text;
  warnings.push(`The file is long: only the first ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters were kept.`);
  return text.slice(0, MAX_TEXT_CHARS);
}

// ------------------------------------------------------------------ PDF

let _pdfjs = null;
function pdfjs() {
  if (!_pdfjs) {
    // pdf.js prints "Cannot polyfill DOMMatrix/Path2D" when no canvas package exists. Those are only for RENDERING pages;
    // reading their text needs neither, so the warning is noise. Muted for the require only, never for anything else.
    const orig = { log: console.log, warn: console.warn };
    const quiet = (fn) => (...a) => {
      if (!/Cannot polyfill/.test(String(a[0]))) fn.apply(console, a);
    };
    console.log = quiet(orig.log); // pdf.js reports its warnings through console.log ("Warning: ...")
    console.warn = quiet(orig.warn);
    try {
      _pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
    }
  }
  return _pdfjs;
}

async function extractPdf(buf) {
  const lib = pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const warnings = [];
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Rebuild lines from item positions: a new line whenever the baseline moves; tab-ish gap between items on one line.
      let line = "";
      let lastY = null;
      let lastEndX = null;
      const lines = [];
      for (const it of content.items) {
        if (typeof it.str !== "string") continue;
        const y = it.transform ? it.transform[5] : 0;
        const x = it.transform ? it.transform[4] : 0;
        if (lastY !== null && Math.abs(y - lastY) > 2.5) {
          lines.push(line);
          line = "";
          lastEndX = null;
        }
        if (line && lastEndX !== null && x - lastEndX > 6 && !/\s$/.test(line) && !/^\s/.test(it.str)) line += " ";
        line += it.str;
        lastY = y;
        lastEndX = x + (it.width || 0);
        if (it.hasEOL) {
          lines.push(line);
          line = "";
          lastY = null;
          lastEndX = null;
        }
      }
      if (line) lines.push(line);
      const text = tidy(lines.join("\n"));
      if (text) pages.push(`## Page ${n}\n\n${text}`);
      page.cleanup();
    }
  } finally {
    try {
      await doc.destroy();
    } catch (_) {
      /* ignore */
    }
  }
  if (!pages.length) warnings.push("This PDF has no text layer (it is probably a scan). Attach the pages as images instead and the text will be read by OCR.");
  return { kind: "pdf", text: pages.join("\n\n"), meta: { pages: doc.numPages }, warnings };
}

// ------------------------------------------------------------------ HTML -> Markdown-ish (mammoth output, .html files)

function htmlToMarkdown(html) {
  let s = String(html);
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "");
  // tables first (cells can contain <p>): one pipe row per <tr>
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows = [];
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map((c) => decodeEntities(c.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
      if (cells.length) rows.push(cells);
    }
    return `\n\n${rowsToMarkdown(rows)}\n\n`;
  });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${"#".repeat(+l)} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`);
  // lists: nesting depth from the surrounding <ul>/<ol>
  s = replaceLists(s);
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**").replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => (/^https?:/i.test(href) ? `[${t.replace(/<[^>]+>/g, "")}](${href})` : t.replace(/<[^>]+>/g, "")));
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|blockquote|pre)>/gi, "\n\n").replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(s));
}

function replaceLists(html) {
  // Iteratively flatten the innermost list first so nested lists keep their indentation.
  let out = html;
  for (let guard = 0; guard < 8 && /<(ul|ol)[\s>]/i.test(out); guard++) {
    out = out.replace(/<(ul|ol)[^>]*>((?:(?!<(?:ul|ol)[\s>])[\s\S])*?)<\/\1>/gi, (_, kind, inner) => {
      let n = 0;
      const items = (inner.match(/<li[\s\S]*?<\/li>/gi) || []).map((li) => {
        n++;
        const text = li.replace(/^<li[^>]*>/i, "").replace(/<\/li>$/i, "").replace(/<\/?p[^>]*>/gi, "").trim();
        const marker = kind.toLowerCase() === "ol" ? `${n}.` : "-";
        // anything already flattened from a deeper list is indented under this item
        return `${marker} ${text.replace(/\n/g, "\n  ")}`;
      });
      return `\n${items.join("\n")}\n`;
    });
  }
  return out;
}

// ------------------------------------------------------------------ Word

async function extractDocx(buf) {
  const mammoth = require("mammoth");
  const warnings = [];
  const res = await mammoth.convertToHtml({ buffer: buf }, { ignoreEmptyParagraphs: true });
  for (const m of res.messages || []) if (m.type === "warning" && warnings.length < 3) warnings.push(m.message);
  const text = htmlToMarkdown(res.value);
  if (!text) warnings.push("This Word document has no text.");
  return { kind: "docx", text, meta: {}, warnings: warnings.filter((w) => !/^Unrecognised paragraph style|^Unrecognised run style/i.test(w)) };
}

async function extractDoc(buf) {
  const WordExtractor = require("word-extractor");
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buf);
  const body = tidy(doc.getBody() || "");
  const parts = [body];
  const foot = tidy(doc.getFootnotes ? doc.getFootnotes() || "" : "");
  if (foot) parts.push(`## Footnotes\n\n${foot}`);
  const text = parts.filter(Boolean).join("\n\n");
  return { kind: "doc", text, meta: {}, warnings: text ? [] : ["This Word document has no text."] };
}

// ------------------------------------------------------------------ Spreadsheets

/** "₹1,200" / "12%" / "-3.5" -> a number; anything else -> null. */
function toNumber(cell) {
  const t = String(cell == null ? "" : cell).trim().replace(/[\p{Sc}\s,%]/gu, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}
const tidyNumber = (n) => String(Math.round(n * 100) / 100);

/**
 * Exact per-column facts (highest / lowest / total / average) worked out HERE, not left for the model. Measured on the real hosted
 * chat model: asked "which region had the highest Q2 sales?" of a plain 5-row table it was right 4 times in 10; given the same
 * table plus this summary, 8 in 10. A small model reads values fine but is unreliable at comparing and adding them, so the
 * program does the arithmetic (as Noah already does for quiz sums) and states the result.
 * `rows[0]` is the header. Returns "" when there is nothing numeric worth summarising.
 */
function columnSummary(rows, truncatedTo) {
  const header = rows[0] || [];
  const data = rows.slice(1);
  if (data.length < 2) return "";
  // column 0 names the rows ("North", "Laptop") when it is mostly text
  const textish = data.filter((r) => String(r[0] || "").trim() && toNumber(r[0]) === null).length;
  const labelCol = textish >= data.length * 0.6 ? 0 : -1;
  const lines = [];
  for (let c = 0; c < header.length && lines.length < 15; c++) {
    if (c === labelCol) continue;
    const vals = [];
    let filled = 0;
    for (const r of data) {
      const cell = String(r[c] == null ? "" : r[c]).trim();
      if (!cell) continue;
      filled++;
      const n = toNumber(cell);
      if (n !== null) vals.push({ n, label: labelCol >= 0 ? String(r[labelCol] || "").trim() : "" });
    }
    if (vals.length < 2 || vals.length < filled * 0.6) continue;
    let hi = vals[0], lo = vals[0], sum = 0;
    for (const v of vals) {
      if (v.n > hi.n) hi = v;
      if (v.n < lo.n) lo = v;
      sum += v.n;
    }
    const at = (v) => (v.label ? `${v.label} (${tidyNumber(v.n)})` : tidyNumber(v.n));
    lines.push(`- ${String(header[c] || `column ${c + 1}`).trim()}: highest = ${at(hi)}, lowest = ${at(lo)}, total = ${tidyNumber(sum)}, average = ${tidyNumber(sum / vals.length)}`);
  }
  if (!lines.length) return "";
  return `Column summary (worked out by the program from the table above, exact):\n${lines.join("\n")}${truncatedTo ? `\n(These figures cover only the first ${truncatedTo} rows.)` : ""}`;
}

function extractSheets(buf, kind) {
  const XLSX = require("xlsx");
  // CSV from a Buffer is read as Windows-1252 by SheetJS: decode it ourselves so UTF-8 (accents, ₹, emoji) survives
  const wb = kind === "csv" ? XLSX.read(decodeText(buf), { type: "string", cellDates: true }) : XLSX.read(buf, { type: "buffer", cellDates: true, dense: false });
  const warnings = [];
  const out = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet["!ref"]) continue;
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: false });
    let rows = grid.map((r) => r.slice(0, MAX_SHEET_COLS).map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? ""))));
    rows = rows.filter((r) => r.some((c) => c.trim() !== ""));
    if (!rows.length) continue;
    let note = "";
    if (rows.length > MAX_SHEET_ROWS) {
      note = `\n\n_(sheet "${name}" has ${rows.length.toLocaleString("en-US")} rows; the first ${MAX_SHEET_ROWS.toLocaleString("en-US")} are shown)_`;
      warnings.push(`Sheet "${name}" is long: only its first ${MAX_SHEET_ROWS} rows were kept.`);
      rows = rows.slice(0, MAX_SHEET_ROWS);
    }
    const summary = columnSummary(rows, note ? MAX_SHEET_ROWS : 0);
    out.push(`## Sheet: ${name}\n\n${rowsToMarkdown(rows)}${note}${summary ? `\n\n${summary}` : ""}`);
  }
  if (!out.length) warnings.push("This spreadsheet has no data in any sheet.");
  return { kind, text: out.join("\n\n"), meta: { sheets: wb.SheetNames.length }, warnings };
}

// ------------------------------------------------------------------ Office zip containers (pptx, odt/odp/ods)

async function loadZip(buf) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buf);
  return zip;
}

async function zipText(zip, name) {
  const f = zip.file(name);
  if (!f) return null;
  const size = f._data && f._data.uncompressedSize;
  if (size && size > MAX_ZIP_ENTRY_BYTES) return null;
  return f.async("string");
}

function xmlText(xml) {
  // <a:t>text</a:t> runs; <a:br/> and paragraph ends become newlines
  const withBreaks = xml.replace(/<a:br\s*\/>/g, "\n").replace(/<\/a:p>/g, "\n");
  const runs = [];
  let last = 0;
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|\n/g;
  let m;
  while ((m = re.exec(withBreaks))) {
    if (m[0] === "\n") runs.push("\n");
    else runs.push(decodeEntities(m[1]));
    last = re.lastIndex;
  }
  void last;
  return tidy(runs.join(""));
}

function pptxTables(xml) {
  const tables = [];
  for (const tbl of xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/g) || []) {
    const rows = [];
    for (const tr of tbl.match(/<a:tr[\s>][\s\S]*?<\/a:tr>/g) || []) {
      rows.push((tr.match(/<a:tc[\s>][\s\S]*?<\/a:tc>/g) || []).map((tc) => xmlText(tc).replace(/\n+/g, " ")));
    }
    if (rows.length) tables.push(rowsToMarkdown(rows));
  }
  return tables;
}

async function extractPptx(buf) {
  const zip = await loadZip(buf);
  const warnings = [];
  const presentation = await zipText(zip, "ppt/presentation.xml");
  const rels = await zipText(zip, "ppt/_rels/presentation.xml.rels");
  let slidePaths = [];
  if (presentation && rels) {
    // DISPLAY order: <p:sldId r:id="rId3"/> in sequence, mapped through the relationships file.
    const target = {};
    for (const r of rels.match(/<Relationship\b[^>]*>/g) || []) {
      const id = /\bId="([^"]+)"/.exec(r);
      const tg = /\bTarget="([^"]+)"/.exec(r);
      if (id && tg) target[id[1]] = tg[1];
    }
    for (const s of presentation.match(/<p:sldId\b[^>]*>/g) || []) {
      const rid = /r:id="([^"]+)"/.exec(s);
      const t = rid && target[rid[1]];
      if (t) slidePaths.push(t.startsWith("/") ? t.slice(1) : path.posix.normalize(`ppt/${t}`));
    }
  }
  if (!slidePaths.length) {
    slidePaths = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10));
  }
  const out = [];
  let n = 0;
  for (const p of slidePaths) {
    const xml = await zipText(zip, p);
    if (xml == null) continue;
    n++;
    const tables = pptxTables(xml);
    // text outside tables (table cells would otherwise appear twice)
    const text = xmlText(xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, ""));
    const relName = `ppt/slides/_rels/${path.posix.basename(p)}.rels`;
    const relXml = await zipText(zip, relName);
    let notes = "";
    const nm = relXml && /Target="[^"]*notesSlides\/(notesSlide\d+\.xml)"/.exec(relXml);
    if (nm) {
      const nx = await zipText(zip, `ppt/notesSlides/${nm[1]}`);
      if (nx) notes = xmlText(nx).replace(/^\d+$/gm, "").trim(); // a bare slide number is the notes page's own placeholder
    }
    const parts = [`## Slide ${n}`];
    if (text) parts.push(text);
    for (const t of tables) parts.push(t);
    if (notes) parts.push(`_Speaker notes:_ ${notes.replace(/\n+/g, " ")}`);
    out.push(parts.join("\n\n"));
  }
  if (!out.length) warnings.push("This presentation has no readable slides.");
  return { kind: "pptx", text: out.join("\n\n"), meta: { slides: n }, warnings };
}

async function extractOdf(buf, kind) {
  const zip = await loadZip(buf);
  const xml = await zipText(zip, "content.xml");
  if (xml == null) throw new ExtractError("bad_file", "This OpenDocument file has no content.xml.");
  let s = xml
    .replace(/<text:tab\s*\/>/g, "\t")
    .replace(/<text:line-break\s*\/>/g, "\n")
    .replace(/<text:s(?:\s[^>]*)?\/>/g, " ")
    .replace(/<\/text:(p|h)>/g, "\n")
    .replace(/<\/table:table-row>/g, "\n")
    .replace(/<\/table:table-cell>/g, "\t")
    .replace(/<[^>]+>/g, "");
  const text = tidy(decodeEntities(s));
  return { kind, text, meta: {}, warnings: text ? [] : ["This document has no text."] };
}

// ------------------------------------------------------------------ PowerPoint 97-2003 (.ppt)

// The deck is an OLE compound file. Slide text lives in the "PowerPoint Document" stream as records ([MS-PPT]):
//   header = [verInstance u16][recType u16][recLen u32]; a container has (verInstance & 0xF) == 0xF and holds child records;
//   recInstance = verInstance >> 4.
//   TextCharsAtom 0x0FA0 = UTF-16LE text, TextBytesAtom 0x0FA8 = Latin-1 text, SlidePersistAtom 0x03F3 starts a slide inside
//   SlideListWithText 0x0FF0 (recInstance 0 = the slides, 1 = masters, 2 = notes), Slide 0x03EE, Notes 0x03F0, MainMaster 0x03F8.
// The slides' own text (titles, bodies) is in SlideListWithText; text boxes drawn on a slide live inside the Slide container.
// Masters hold TEMPLATE text ("Click to edit Master title style") that is not the deck's content, so they are skipped.
// NOTE: written from the file-format specification and checked against a hand-built file only - no real PowerPoint-authored
// .ppt was available to test with (see the unit tests), so a .pptx is always the safer format.
function extractPpt(buf) {
  const CFB = require("cfb");
  const cfb = CFB.read(buf, { type: "buffer" });
  const entry = CFB.find(cfb, "/PowerPoint Document") || CFB.find(cfb, "PowerPoint Document");
  if (!entry || !entry.content) throw new ExtractError("bad_file", "This is not a PowerPoint 97-2003 presentation (no 'PowerPoint Document' stream).");
  const data = Buffer.from(entry.content);
  const listSlides = []; // from SlideListWithText (preferred: it is the slides' placeholder text, in order)
  const boxSlides = []; // from Slide containers (fallback: text boxes)
  let list = null; // the slide currently being filled from SlideListWithText
  let box = null; // the slide currently being filled from a Slide container
  const readText = (type, raw) => (type === 0x0fa0 ? raw.toString("utf16le") : raw.toString("latin1")).replace(/\r/g, "\n").replace(/\u000b/g, "\n").replace(/\u0000/g, "").trim();
  const walk = (start, end, ctx) => {
    let p = start;
    while (p + 8 <= end) {
      const verInst = data.readUInt16LE(p);
      const type = data.readUInt16LE(p + 2);
      const len = data.readUInt32LE(p + 4);
      const bodyStart = p + 8;
      const bodyEnd = Math.min(bodyStart + len, end);
      if (bodyEnd < bodyStart) return;
      if ((verInst & 0xf) === 0xf) {
        if (type === 0x03f8 || type === 0x03f0) {
          /* MainMaster / Notes: not slide content */
        } else if (type === 0x0ff0) {
          if (verInst >> 4 === 0) walk(bodyStart, bodyEnd, "list"); // instance 0 = slides
        } else if (type === 0x03ee) {
          box = [];
          boxSlides.push(box);
          walk(bodyStart, bodyEnd, "slide");
        } else {
          walk(bodyStart, bodyEnd, ctx);
        }
      } else if (type === 0x03f3 && ctx === "list") {
        list = [];
        listSlides.push(list);
      } else if ((type === 0x0fa0 || type === 0x0fa8) && ctx) {
        const text = readText(type, data.slice(bodyStart, bodyEnd));
        if (text) {
          if (ctx === "list") (list || (list = (listSlides.push([]), listSlides[listSlides.length - 1]))).push(text);
          else if (ctx === "slide" && box) box.push(text);
        }
      }
      p = bodyEnd;
    }
  };
  walk(0, data.length, null);
  const slides = listSlides.some((s) => s.length) ? listSlides : boxSlides;
  const out = slides.map((s, i) => [i + 1, s]).filter(([, s]) => s.length).map(([n, s]) => `## Slide ${n}\n\n${s.join("\n\n")}`);
  return { kind: "ppt", text: out.join("\n\n"), meta: { slides: slides.length }, warnings: out.length ? [] : ["No slide text was found in this presentation."] };
}

// ------------------------------------------------------------------ RTF

function extractRtf(buf) {
  let s = decodeText(buf);
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\u(-?\d+)\??/g, (_, n) => safeFromCodePoint(n < 0 ? 65536 + +n : +n));
  s = s.replace(/\{\\\*[^{}]*\}/g, "").replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict)[^]*?\}\}/g, "");
  s = s.replace(/\\(par|line)\b ?/g, "\n").replace(/\\tab\b ?/g, "\t").replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, "");
  return { kind: "rtf", text: tidy(s), meta: {}, warnings: [] };
}

// ------------------------------------------------------------------ Images (OCR)

let _ocrWorker = null;
let _ocrIdle = null;
let _ocrOptions = { cachePath: undefined };

/** Optional: where tesseract keeps its downloaded language data (the app passes a folder under userData). */
function configureOcr(opts) {
  _ocrOptions = { ..._ocrOptions, ...opts };
}

async function ocrWorker() {
  if (!_ocrWorker) {
    const { createWorker } = require("tesseract.js");
    _ocrWorker = createWorker("eng", 1, { cachePath: _ocrOptions.cachePath, logger: () => {} });
  }
  clearTimeout(_ocrIdle);
  _ocrIdle = setTimeout(async () => {
    const w = _ocrWorker;
    _ocrWorker = null;
    try {
      (await w).terminate();
    } catch (_) {
      /* ignore */
    }
  }, 60_000);
  if (_ocrIdle.unref) _ocrIdle.unref();
  return _ocrWorker;
}

async function extractImage(buf, ext) {
  const warnings = [];
  if (ext === ".gif" || ext === ".tif" || ext === ".tiff") {
    // tesseract.js reads png/jpg/bmp/webp reliably; the others are not guaranteed
    warnings.push(`${ext.slice(1).toUpperCase()} images may not be read reliably; PNG or JPG work best.`);
  }
  let text = "";
  let confidence = null;
  try {
    const worker = await ocrWorker();
    const { data } = await worker.recognize(buf, {}, { blocks: true, text: true }); // per-line confidence is only returned when asked for
    // Tesseract "reads" noise: a blank or textureless image comes back as a stray line like "B=" at ~20% confidence.
    // Keep only lines it is reasonably sure of and that hold real characters, so junk is never presented as content.
    const lines = (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => (p.lines || []).map((l) => ({ ...l, para: p }))));
    if (lines.length) {
      const kept = lines.filter((l) => l.confidence >= 40 && (l.text.match(/[\p{L}\p{N}]/gu) || []).length >= 2);
      const out = [];
      let lastPara = null;
      for (const l of kept) {
        if (lastPara && l.para !== lastPara) out.push("");
        out.push(l.text.trim());
        lastPara = l.para;
      }
      text = tidy(out.join("\n"));
      confidence = kept.length ? Math.round(kept.reduce((n, l) => n + l.confidence, 0) / kept.length) : null;
    } else {
      text = tidy(data.text || "");
      confidence = typeof data.confidence === "number" ? Math.round(data.confidence) : null;
    }
  } catch (err) {
    throw new ExtractError("ocr_failed", `Could not read text from this image (${err && err.message ? err.message : err}). The first image needs an internet connection to fetch the OCR language data.`);
  }
  if (!text) warnings.push("No text was found in this image.");
  else if (confidence !== null && confidence < 50) warnings.push(`The text in this image was hard to read (OCR confidence ${confidence}%), so parts may be wrong.`);
  return { kind: "image", text, meta: { ocrConfidence: confidence }, warnings };
}

async function shutdownOcr() {
  clearTimeout(_ocrIdle);
  const w = _ocrWorker;
  _ocrWorker = null;
  if (w) {
    try {
      (await w).terminate();
    } catch (_) {
      /* ignore */
    }
  }
}

// ------------------------------------------------------------------ entry point

function sniff(buf) {
  if (buf.length >= 5 && buf.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
  if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "ole";
  if (buf.length >= 8 && buf.slice(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n") return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.length >= 2 && buf.slice(0, 2).toString("latin1") === "BM") return "bmp";
  return null;
}

/**
 * @param {Buffer|Uint8Array|ArrayBuffer} data
 * @param {string} name original file name (its extension picks the reader; the bytes are sniffed to catch a wrong extension)
 * @returns {Promise<{ kind: string, text: string, meta: object, warnings: string[] }>}
 */
async function extractFile(data, name) {
  const buf = toBuffer(data);
  if (!buf.length) throw new ExtractError("empty", "The file is empty.");
  if (buf.length > MAX_FILE_BYTES) throw new ExtractError("too_large", `The file is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB.`);
  const ext = path.extname(String(name || "")).toLowerCase();
  const magic = sniff(buf);
  let res;
  try {
    if (ext === ".pdf" || magic === "pdf") res = await extractPdf(buf);
    else if (ext === ".docx" || ext === ".docm" || ext === ".dotx") res = await extractDocx(buf);
    else if (ext === ".doc" || ext === ".dot") res = magic === "zip" ? await extractDocx(buf) : await extractDoc(buf);
    else if ([".xlsx", ".xlsm", ".xls", ".xlsb", ".ods"].includes(ext)) res = extractSheets(buf, ext === ".ods" ? "ods" : "spreadsheet");
    else if (ext === ".pptx" || ext === ".pptm" || ext === ".ppsx") res = await extractPptx(buf);
    else if (ext === ".ppt" || ext === ".pps") res = magic === "zip" ? await extractPptx(buf) : extractPpt(buf);
    else if (ext === ".odt") res = await extractOdf(buf, "odt");
    else if (ext === ".odp") res = await extractOdf(buf, "odp");
    else if (ext === ".rtf") res = extractRtf(buf);
    else if (IMAGE_EXT.has(ext) || ["png", "jpg", "webp", "bmp"].includes(magic)) res = await extractImage(buf, ext);
    else if (ext === ".csv" || ext === ".tsv") res = extractSheets(buf, "csv");
    else if (ext === ".html" || ext === ".htm") res = { kind: "html", text: htmlToMarkdown(decodeText(buf)), meta: {}, warnings: [] };
    else if (TEXT_EXT.has(ext) || (!ext && looksLikeText(buf))) res = { kind: "text", text: tidy(decodeText(buf)), meta: {}, warnings: [] };
    else if (magic === "zip") throw new ExtractError("unsupported", `Unsupported file type "${ext || "unknown"}". Supported: PDF, Word, Excel, PowerPoint, OpenDocument, images, and text files.`);
    else if (looksLikeText(buf)) res = { kind: "text", text: tidy(decodeText(buf)), meta: {}, warnings: [] };
    else throw new ExtractError("unsupported", `Unsupported file type "${ext || "unknown"}". Supported: PDF, Word, Excel, PowerPoint, OpenDocument, images, and text files.`);
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    const msg = err && err.message ? err.message : String(err);
    // Encrypted / corrupt files are the common real cause: say that instead of a stack trace.
    if (/password|encrypt/i.test(msg)) throw new ExtractError("encrypted", "This file is password-protected. Remove the password and attach it again.");
    throw new ExtractError("bad_file", `Could not read this ${ext ? ext.slice(1).toUpperCase() : ""} file (${msg.slice(0, 160)}). It may be damaged.`);
  }
  const warnings = res.warnings || [];
  res.text = clip(res.text || "", warnings);
  res.warnings = warnings;
  return res;
}

function looksLikeText(buf) {
  const n = Math.min(buf.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / n < 0.02;
}

module.exports = {
  extractFile,
  ExtractError,
  configureOcr,
  shutdownOcr,
  // exported for tests
  htmlToMarkdown,
  rowsToMarkdown,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  SUPPORTED_HINT: "PDF, Word (.doc/.docx), Excel (.xls/.xlsx/.csv), PowerPoint (.ppt/.pptx), OpenDocument, images (OCR) and text files",
};
