// Figure furniture: legends (keys) built from the figure's icons, scale bars, and panel labels
// (bold A, B, C… as ordinary text objects). The Insert menu (main.js) calls these.

import { state, setSelection, selectedObjs, bbox, docPx, commit, MM } from "./model.js";
import { renderDoc, viewCenter } from "./canvas.js";
import { fitFurniture, measureText } from "./render.js";
import { hasLabels } from "./labels.js";
import { modal } from "./menus.js";
import { el, uid, bus, toast, clamp } from "./util.js";

/** `at`, stepped down and right while an object that `same` matches is already centred there. */
function freeSpot([cx, cy], same) {
  const taken = () => state.doc.objects.some((x) => same(x) && Math.abs(x.x + x.w / 2 - cx) < 2 && Math.abs(x.y + x.h / 2 - cy) < 2);
  for (let i = 0; i < 12 && taken(); i++) {
    cx += 6 * MM;
    cy += 6 * MM;
  }
  return [cx, cy];
}

/** Centre a box object on `at`, kept on the page when it fits. */
function centreOnPage(o, [cx, cy]) {
  const { w, h } = docPx();
  o.x = clamp(cx - o.w / 2, Math.min(0, w - o.w), Math.max(0, w - o.w));
  o.y = clamp(cy - o.h / 2, Math.min(0, h - o.h), Math.max(0, h - o.h));
}

/**
 * Put a new object centred on `at` (kept on the page when it fits), select it and record one undo step.
 * Inserting the same kind again steps down and right instead of landing exactly on the last one.
 */
function addCentred(o, at) {
  centreOnPage(o, freeSpot(at, (x) => x.type === o.type));
  state.doc.objects.push(o);
  setSelection([o.id]);
  renderDoc();
  commit();
  bus.emit("edit-furniture", { id: o.id, row: -1, focus: false }); // show its settings
  return o;
}

/* ---------- legends ---------- */

/** Rows match when they show the same library icon in the same colours. */
export function legendKey(asset, colors) {
  const c = Object.entries(colors || {})
    .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()])
    .filter(([k, v]) => k !== v)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return asset + "|" + JSON.stringify(c);
}

/** A row's starting label: the object's own name (an icon brush's without " (brush)"), else the icon's. */
function rowLabel(o, asset) {
  return String(o.name || "").replace(/\s*\(brush\)$/, "").trim() || asset.meta?.name || "Icon";
}

/**
 * One legend row per different icon in the figure, in the order they were added: icons (in groups
 * too) and icon brushes, the same library icon in the same colours listed once. Hidden objects are
 * left out; text drawn inside an icon is hidden in its swatch.
 */
export function figureLegendRows(objs = state.doc.objects, doc = state.doc) {
  const rows = new Map();
  const walk = (list) => {
    for (const o of list) {
      if (o.hidden) continue;
      const asset = (o.type === "icon" || (o.type === "membrane" && o.brush === "icon")) && o.asset ? doc.assets[o.asset] : null;
      if (asset) {
        const k = legendKey(o.asset, o.colors);
        if (!rows.has(k)) {
          const r = { asset: o.asset, colors: { ...(o.colors || {}) }, label: rowLabel(o, asset) };
          if (hasLabels(asset)) r.labels = "hidden";
          rows.set(k, r);
        }
      }
      if (o.children) walk(o.children);
    }
  };
  walk(objs);
  return [...rows.values()];
}

/** Figure icons a legend doesn't list yet. */
export const missingLegendRows = (legend) => {
  const have = new Set((legend.rows || []).filter((r) => r.asset).map((r) => legendKey(r.asset, r.colors)));
  return figureLegendRows().filter((r) => !have.has(legendKey(r.asset, r.colors)));
};

/** Rows that aren't icons: a colour square, and line samples for the usual arrows. */
export const EXTRA_ROWS = [
  ["Colour square", { color: "#4aa9d0", label: "Label" }],
  ["Arrow (activation)", { color: "#2b3440", line: { head: "arrow" }, label: "Activation" }],
  ["Inhibition", { color: "#2b3440", line: { head: "bar" }, label: "Inhibition" }],
  ["Dashed arrow (indirect)", { color: "#2b3440", line: { head: "arrow", dash: "dash" }, label: "Indirect effect" }],
];

/** A new legend listing `rows`, sized to them. */
export function newLegend(rows) {
  return fitFurniture({ id: uid(), type: "legend", x: 0, y: 0, w: 1, h: 1, rot: 0, rows, fontSize: 12, fontFamily: "Arial", color: "#1c2733", iconSize: 24, columns: 1 });
}

/** Insert › Legend: a key of every different icon in the figure, centred in the view. */
export function insertLegend(at = viewCenter()) {
  let rows = figureLegendRows();
  const empty = !rows.length;
  if (empty) rows = [JSON.parse(JSON.stringify(EXTRA_ROWS[0][1]))];
  const o = addCentred(newLegend(rows), at);
  toast(empty
    ? "There are no icons in the figure yet, so the legend starts with a colour square. Add rows in the Design panel."
    : `Legend of ${rows.length} icon${rows.length > 1 ? "s" : ""}: rename, reorder or remove rows in the Design panel`);
  return o;
}

/* ---------- scale bars ---------- */

export const UNITS = ["nm", "µm", "mm"];

/** A new scale bar: "10 µm" over a 15 mm bar. */
export function newScaleBar() {
  return fitFurniture({
    id: uid(), type: "scalebar", x: 0, y: 0, w: 1, h: 1, rot: 0, value: 10, unit: "µm", length: 15 * MM, thickness: 3,
    color: "#1c2733", fontSize: 12, fontFamily: "Arial", bold: false, labelPos: "above",
  });
}

export function insertScaleBar(at = viewCenter()) {
  return addCentred(newScaleBar(), at);
}

/* ---------- panel labels ---------- */

/** The i-th panel letter: 0 → A, 25 → Z, 26 → AA… */
export function letterAt(i, upper = true) {
  let s = "";
  i = Math.max(0, Math.floor(i));
  do {
    s = String.fromCharCode(97 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return upper ? s.toUpperCase() : s;
}

/** Index of a panel letter ("C" → 2, "aa" → 26), or -1. */
export function letterIndex(s) {
  const m = /^\(?([a-z]{1,2})[).]?$/i.exec(String(s || "").trim());
  if (!m) return -1;
  return [...m[1].toLowerCase()].reduce((a, c) => a * 26 + (c.charCodeAt(0) - 96), 0) - 1;
}

/** Panel labels already in the figure (texts made by Add panel labels). */
function panelLabels(objs = state.doc.objects, out = []) {
  for (const o of objs) {
    if (o.type === "text" && o.panelLabel) out.push(o);
    if (o.children) panelLabels(o.children, out);
  }
  return out;
}

/** The letter after the last panel label in the figure (0 = A). */
export const nextPanelIndex = () => Math.max(-1, ...panelLabels().map((o) => letterIndex(o.text))) + 1;

/**
 * What Add panel labels labels: the selected visible objects (not panel labels themselves) in reading
 * order, top row first and left to right, as {o, b: bounds, top: the top of its row}; an object
 * starting above the middle of a row's shortest object joins that row.
 */
export function panelTargets(objs = selectedObjs()) {
  const items = objs.filter((o) => !o.hidden && !(o.type === "text" && o.panelLabel)).map((o) => ({ o, b: bbox(o) }));
  items.sort((a, b) => a.b.y - b.b.y);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && it.b.y < row.top + row.minH / 2) {
      row.items.push(it);
      row.minH = Math.min(row.minH, it.b.h);
    } else rows.push({ top: it.b.y, minH: it.b.h, items: [it] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.b.x - b.b.x).map((it) => ({ ...it, top: r.top })));
}

/**
 * Add bold panel letters as ordinary text objects: one at the top-left corner of each target (inside
 * the corner, or just above it when there is room on the page), or one centred on `at` when there are
 * no targets (stepping down and right from a panel label already there). Labels of a row line up when
 * the tops differ by less than a label's height. Labels stay on the page. Selects them; one undo step.
 */
export function addPanelLabels({ upper = true, size = 14, place = "inside", start = nextPanelIndex() } = {}, targets = panelTargets(), at = null) {
  const page = docPx(), gap = 0.6 * MM;
  const mk = (i) => {
    const t = {
      id: uid(), type: "text", text: letterAt(start + i, upper), x: 0, y: 0, w: 10, h: 10, rot: 0, fontSize: Math.max(1, size) / 0.75,
      fontFamily: "Arial", color: "#1c2733", align: "left", bold: true, italic: false, panelLabel: true,
    };
    measureText(t);
    return t;
  };
  const made = [];
  if (!targets.length) {
    const t = mk(0);
    centreOnPage(t, freeSpot(at || viewCenter(), (x) => x.type === "text" && x.panelLabel));
    made.push(t);
  } else {
    targets.forEach(({ b, top = b.y }, i) => {
      const t = mk(i);
      const y = b.y - top < t.h ? top : b.y; // slightly uneven panels get level labels
      t.x = b.x;
      t.y = place === "above" && y - t.h - gap >= 0 ? y - t.h - gap : y;
      t.x = clamp(t.x, 0, Math.max(0, page.w - t.w));
      t.y = clamp(t.y, 0, Math.max(0, page.h - t.h));
      made.push(t);
    });
  }
  state.doc.objects.push(...made);
  setSelection(made.map((t) => t.id));
  renderDoc();
  commit();
  return made;
}

const PL_KEY = "biocraft.panelLabels";

function panelOpts() {
  const o = { upper: true, size: 14, place: "inside" };
  try {
    const s = JSON.parse(localStorage.getItem(PL_KEY) || "null");
    if (s && typeof s === "object") {
      if (typeof s.upper === "boolean") o.upper = s.upper;
      if (Number.isFinite(s.size)) o.size = clamp(s.size, 4, 96);
      if (s.place === "inside" || s.place === "above") o.place = s.place;
    }
  } catch {}
  return o;
}

/** Insert › Panel labels…: case, size, first letter and placement, then addPanelLabels. */
export async function panelLabelsDialog() {
  const targets = panelTargets();
  if (state.selection.length && !targets.length) return toast("Select the objects or groups to label (not the labels themselves)");
  const o = { ...panelOpts(), start: nextPanelIndex() };
  const note = el("div.small.muted");
  const size = el("input.num", { type: "number", min: 4, max: 96, step: 1, value: o.size, style: { width: "64px" } });
  const start = el("input.num", { value: letterAt(o.start, o.upper), maxlength: "2", spellcheck: "false", style: { width: "56px" } });
  const startIdx = () => (letterIndex(start.value) >= 0 ? letterIndex(start.value) : o.start);
  const describe = () => {
    const n = Math.max(1, targets.length), a = letterAt(startIdx(), o.upper), z = letterAt(startIdx() + n - 1, o.upper);
    note.textContent = targets.length > 1
      ? `${a}–${z} at the top-left of the ${n} selected objects, top row first, left to right.`
      : targets.length ? `${a} at the top-left of the selected object.`
        : `One label (${a}) in the middle of the view. Select objects or groups first to label each of them.`;
  };
  const seg = (key, items) => {
    const box = el("div.seg");
    const draw = () => box.replaceChildren(...items.map(([v, t]) => el("button" + (o[key] === v ? ".on" : ""), {
      type: "button",
      onclick: () => {
        o[key] = v;
        if (key === "upper") start.value = letterAt(startIdx(), v);
        draw();
        describe();
      },
    }, t)));
    draw();
    return box;
  };
  start.addEventListener("input", describe);
  describe();
  const row = (label, ...kids) => el("div.field.wide", {}, el("label", {}, label), ...kids);
  const body = el("div.pl-body", {},
    row("Letters", seg("upper", [[true, "A, B, C"], [false, "a, b, c"]])),
    row("Size", size, el("span.small.muted", {}, "pt, bold")),
    row("Start at", start),
    row("Place", seg("place", [["inside", "Inside the corner"], ["above", "Above the corner"]])),
    note);
  const ok = await modal("Add panel labels", body, [{ label: "Cancel", value: false }, { label: targets.length > 1 ? `Add ${targets.length} labels` : "Add label", primary: true, value: true }], { enter: true });
  if (!ok) return;
  const opts = { upper: o.upper, size: clamp(parseFloat(size.value) || o.size, 4, 96), place: o.place };
  try {
    localStorage.setItem(PL_KEY, JSON.stringify(opts));
  } catch {}
  return addPanelLabels({ ...opts, start: startIdx() }, targets);
}
