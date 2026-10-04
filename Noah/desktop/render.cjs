// Noah/desktop/render.cjs
//
// What the model reads: the list of windows and the controls inside one, as compact plain text. This is TEXT FROM THE SCREEN: titles and control names are
// chosen by whoever wrote the application or the web page, so it is untrusted (the mission context fences and scans it like a file or program output).
//
// Controls are shown as   [e12] Button "Greet" {invoke}   with their state in words; a control that is only decoration (an unnamed pane that does nothing)
// is left out, so a window of a few hundred nodes reads as a few dozen lines.

"use strict";

const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n - 1) + "…" : String(s ?? ""));
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** @param {{ window: number, title: string, process: string, w: number, h: number, foreground: boolean, minimized: boolean }[]} list */
function renderWindows(list, { max = 40 } = {}) {
  if (!Array.isArray(list) || !list.length) return "No windows are open.";
  const lines = [`Open windows (${list.length}); the number in [ ] is what you pass as "window":`];
  for (const w of list.slice(0, max)) {
    lines.push(`[${w.window}] "${clip(oneLine(w.title), 90)}" - ${w.process || "?"}${w.foreground ? " (in front)" : ""}${w.minimized ? " (minimized)" : ""} ${w.w}x${w.h}`);
  }
  if (list.length > max) lines.push(`... and ${list.length - max} more`);
  return lines.join("\n");
}

const DECORATION = new Set(["Pane", "Group", "Custom", "Image", "Separator", "Thumb", "TitleBar", "ToolTip"]);
const DOES_SOMETHING = new Set(["invoke", "toggle", "select", "expand", "value", "text", "range", "scroll"]);

/**
 * @param {{ window: number, title: string, nodes: object[], truncated?: boolean }} tree  the helper's answer to "tree"
 * @param {{ maxLines?: number }} [o]
 * @returns {string}
 */
function renderTree(tree, { maxLines = 200 } = {}) {
  const nodes = (tree && tree.nodes) || [];
  const lines = [`Window [${tree.window}] "${clip(oneLine(tree.title), 90)}": ${nodes.length} controls${tree.truncated ? " (the window has more than this; the rest are not shown)" : ""}. Use the id in [ ] as "element".`];
  const shownDepth = new Map(); // node index -> how far to indent it (decoration does not add a level)
  let shown = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const parentDepth = n.parent >= 0 ? shownDepth.get(n.parent) || 0 : -1;
    const actions = (n.actions || []).map((a) => a.replace(/\(read-only\)/, ""));
    const named = oneLine(n.name).length > 0;
    const quiet = DECORATION.has(n.type) && !named && !actions.some((a) => DOES_SOMETHING.has(a)) && n.value === undefined;
    if (quiet) { shownDepth.set(i, Math.max(parentDepth, 0)); continue; }
    const depth = parentDepth + 1;
    shownDepth.set(i, depth);
    if (shown >= maxLines) continue;
    shown++;
    let line = `${"  ".repeat(Math.min(depth, 9))}[${n.element}] ${n.type}${named ? ` "${clip(oneLine(n.name), 80)}"` : ""}`;
    if (n.password) line += " (PASSWORD FIELD: Noah never types here)";
    else if (n.value !== undefined && n.value !== "") line += ` = "${clip(oneLine(n.value), 120)}"`;
    else if (n.value === "") line += ' = ""';
    if (n.toggle) line += ` (${String(n.toggle).toLowerCase()})`;
    if (n.selected === true) line += " (selected)";
    if (n.enabled === false) line += " (disabled)";
    if (n.focused) line += " (focused)";
    if (n.offscreen) line += " (off screen)";
    const doable = actions.filter((a) => DOES_SOMETHING.has(a) || /^value/.test(a));
    if (doable.length) line += ` {${[...new Set(doable)].join(",")}}`;
    lines.push(line);
  }
  const hidden = nodes.length - shownDepth.size;
  if (shown >= maxLines && nodes.length > shown) lines.push(`... ${nodes.filter((_, i) => !DECORATION.has(nodes[i].type) || oneLine(nodes[i].name)).length - shown} more controls not shown: read a smaller part, or scroll`);
  return lines.join("\n");
}

module.exports = { renderWindows, renderTree };
