// Dev harness: runs the plain-ES-module UI (ui/js) in Node, builds figures programmatically,
// checks editing commands and renders figures to PNG through the running debug server
// (`biocraft --serve 8791`), so changes can be checked by eye as well as by assertion.
//
//   node tools/dev/harness.mjs [scenario ...] [--out dir] [--dpi n] [--base http://127.0.0.1:8791]
//   scenarios: replace, select, menus, transform, paste, style, glow, parts, connectors, brushes, furniture, shapes, panels (default: all)
//
// Other scripts can import the helpers: setup(), ui, icon(id), blankDoc(), png(svg, file), check().

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, "../../ui/js");
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
export const BASE = opt("--base", "http://127.0.0.1:8791");
const OUT = resolve(opt("--out", join(HERE, "out")));
const DPI = +opt("--dpi", 110);

/* ---------- headless browser stubs ---------- */

/** Minimal DOM: a 2D canvas whose measureText approximates Arial, and inert event targets. */
function stubDom() {
  const ctx = {
    font: "16px Arial",
    measureText(s) {
      const px = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || "16");
      return { width: String(s).length * px * 0.55 };
    },
  };
  const node = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, append() {}, appendChild() {}, addEventListener() {} });
  globalThis.window = globalThis;
  globalThis.document ||= {
    createElement: (t) => (t === "canvas" ? { getContext: () => ctx } : node()),
    createElementNS: () => node(),
    createTextNode: (s) => ({ textContent: s }),
    addEventListener() {},
    removeEventListener() {},
    querySelector: (sel) => (sel === "#toast" ? (globalThis.__toast ||= Object.assign(node(), { textContent: "" })) : null), // toasts are kept for checks
    querySelectorAll: () => [],
    body: node(),
    activeElement: null,
  };
  globalThis.addEventListener ||= () => {};
  globalThis.innerWidth ||= 1400;
  globalThis.innerHeight ||= 900;
  // the UI calls /api/... relative to the page: send those to the debug server, except calls that
  // would change the user's library state (recent icons, favourites)
  const realFetch = globalThis.fetch;
  if (!realFetch.__harness) {
    const quiet = /\/api\/library\.(recent|favorite)$/;
    globalThis.fetch = Object.assign((u, o) => {
      if (typeof u === "string" && quiet.test(u)) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { favorite: false } })));
      return realFetch(typeof u === "string" && u.startsWith("/") ? BASE + u : u, o);
    }, { __harness: true });
  }
}

export const ui = {};

/** Stub the DOM and import the UI modules into `ui` (ui.model, ui.render, ui.actions, ui.menu…). */
export async function setup() {
  stubDom();
  const load = (f) => import(pathToFileURL(join(UI, f)).href);
  Object.assign(ui, {
    util: await load("util.js"),
    model: await load("model.js"),
    render: await load("render.js"),
    color: await load("color.js"),
    actions: await load("actions.js"),
    menu: await load("contextmenu.js"),
    style: await load("style.js"),
    furniture: await load("furniture.js"),
  });
  return ui;
}

/* ---------- server helpers ---------- */

export async function api(cmd, args = {}) {
  const r = await fetch(`${BASE}/api/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${cmd}: ${j.error}`);
  return j.result;
}

/** A library icon as a document asset (what the app's loadAsset stores). */
export async function icon(id) {
  return ui.actions.assetFromIcon(await api("library.icon", { id }));
}

/** Render SVG markup to a PNG file through the server's exporter; returns the path. */
export async function png(svg, file, dpi = DPI) {
  const r = await api("export", { format: "png", svg, dpi });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(r.base64, "base64"));
  return file;
}

export function blankDoc(wmm = 178, hmm = 120) {
  const d = ui.model.newDoc(wmm, hmm);
  ui.model.state.doc = d;
  ui.model.state.selection = [];
  ui.model.resetHistory();
  return d;
}

/* ---------- checks ---------- */

let fails = 0, passes = 0;
export function check(ok, what, detail = "") {
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${!ok && detail ? " — " + detail : ""}`);
  return ok;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

/* ---------- figure helpers ---------- */

const MMpx = 96 / 25.4;
function text(s, x, y, size = 9) {
  const o = { id: ui.util.uid(), type: "text", text: s, x, y, w: 10, h: 10, rot: 0, fontSize: size, fontFamily: "Arial", color: "#3a4452", align: "center" };
  ui.render.measureText(o);
  o.x = x - o.w / 2;
  return o;
}
function iconObj(id, asset, cx, cy, size) {
  const [, , vw, vh] = ui.render.assetParts(id, asset).vb;
  const ar = vw / vh, w = ar >= 1 ? size : size * ar, h = ar >= 1 ? size / ar : size;
  return { id: ui.util.uid(), type: "icon", asset: id, name: asset.meta.name, x: cx - w / 2, y: cy - h / 2, w, h, rot: 0, colors: {}, slotColors: [] };
}
/** Dashed outline of a box object's frame (rotation included). */
function frame(o, color = "#e0457b") {
  return { id: ui.util.uid(), type: "rect", x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0, fill: "none", stroke: color, strokeWidth: 1, dash: "dash" };
}

/* ---------- scenarios ---------- */

const SCEN = {};

/** Replace: centre, fitted size, rotation, flips, opacity, colours and one-step undo. */
SCEN.replace = async () => {
  const { model, actions, color } = ui;
  const doc = blankDoc(290, 124);
  const A = "nih/509-t-cell", WIDE = "biocanvas/fibroblast", TALL = "servier/testtube-glass";
  const ids = [A, WIDE, TALL, "biocanvas/macrophage", "biocanvas/b-cell", "biocanvas/neutrophil", "nih/913-neutrophil", "nih/383-neutrophil", "nih/152-fibroblast", "nih/843-fibroblast", "biocanvas/fibroblast"];
  const assets = {};
  for (const id of ids) {
    try {
      assets[id] = await icon(id);
    } catch (e) {
      console.log("  (skip " + id + ": " + e.message + ")");
    }
  }
  Object.assign(doc.assets, assets);
  const a = assets[A];
  const same = ids.find((id) => id !== A && assets[id] && assets[id].slots.length === a.slots.length);
  const other = ids.find((id) => id !== A && assets[id] && assets[id].slots.length && assets[id].slots.length !== a.slots.length);
  console.log(`  T cell has ${a.slots.length} parts; same-count target: ${same}; different-count target: ${other}`);

  const S = 23 * MMpx, row1 = 30 * MMpx, row2 = 90 * MMpx;
  const cases = [];
  const add = (label, target, mut = () => {}, opts = {}) => cases.push({ label, target, mut, opts });
  add("plain → wide", WIDE);
  add("plain → tall", TALL);
  add("rot 30°, flipX, 60% → wide", WIDE, (o) => Object.assign(o, { rot: 30, flipX: true, opacity: 0.6 }));
  add("rot 200°, flipY → tall", TALL, (o) => Object.assign(o, { rot: 200, flipY: true }));
  add("part colours → same count", same, (o) => {
    o.slotColors = a.slots.map((s, i) => ["#3b7dd8", "#f2cf4a", "#5b3d9e", "#1f7a62"][i % 4]);
    o.colors = color.slotColorMap(a.slots, o.slotColors);
  });
  add("part colours → other count", other, (o) => {
    o.slotColors = a.slots.map((s, i) => ["#3b7dd8", "#f2cf4a", "#5b3d9e"][i % 3]);
    o.colors = color.slotColorMap(a.slots, o.slotColors);
  });
  add("tint → other count", other, (o) => {
    o.tint = "#4fb59a";
    o.colors = color.tintMap(a.slots, o.tint);
  });
  add("old tint (inferred)", other, (o) => (o.colors = color.tintMap(a.slots, "#d465b5")));
  add("greyscale → other", other, (o) => {
    o.tint = "gray";
    o.colors = color.grayMap(a.slots);
  });

  const befores = [], afters = [];
  cases.forEach((c, i) => {
    const cx = (19 + i * 31.5) * MMpx;
    const o = iconObj(A, a, cx, row1, S);
    c.mut(o);
    // stretch the first box a little so "fitted" is visible
    if (i < 2) {
      o.w *= 1.15;
      o.x = cx - o.w / 2;
    }
    const before = JSON.parse(JSON.stringify(o));
    const after = model.cloneObj(o);
    model.moveObj(after, 0, row2 - row1);
    const oldBox = JSON.parse(JSON.stringify(after));
    actions.replaceIconObj(after, c.target, assets[c.target], c.opts);
    befores.push(o);
    afters.push(after);
    doc.objects.push(o, after, frame(oldBox, "#9aa3ad"), text(c.label, cx, 52 * MMpx, 7));

    // ---- checks
    const t = assets[c.target], [, , vw, vh] = ui.render.assetParts(c.target, t).vb;
    const ccx = (q) => q.x + q.w / 2, ccy = (q) => q.y + q.h / 2;
    check(near(ccx(after), ccx(oldBox)) && near(ccy(after), ccy(oldBox)), `${c.label}: centre kept`);
    check(near(after.w, oldBox.w) || near(after.h, oldBox.h), `${c.label}: same width or height as the old box`, `${after.w.toFixed(1)}×${after.h.toFixed(1)} in ${oldBox.w.toFixed(1)}×${oldBox.h.toFixed(1)}`);
    check(after.w <= oldBox.w + 1e-6 && after.h <= oldBox.h + 1e-6, `${c.label}: fits inside the old box`);
    check(near(after.w / after.h, vw / vh, 1e-9), `${c.label}: aspect of the new drawing`);
    check((after.rot || 0) === (before.rot || 0) && !!after.flipX === !!before.flipX && !!after.flipY === !!before.flipY && after.opacity === before.opacity, `${c.label}: rotation, flips, opacity kept`);
    check(after.asset === c.target && after.name === t.meta.name, `${c.label}: asset and name swapped`);
    if (c.label.startsWith("part colours → same")) check(JSON.stringify(after.slotColors) === JSON.stringify(before.slotColors) && Object.keys(after.colors).length > 0, `${c.label}: part colours carried`);
    if (c.label.startsWith("part colours → other")) check(!after.slotColors.length && !Object.keys(after.colors).length && !after.tint, `${c.label}: colours reset (counts differ, no tint)`);
    if (c.label.startsWith("tint")) check(after.tint === "#4fb59a" && Object.keys(after.colors).length > 0, `${c.label}: tint carried`);
    if (c.label.startsWith("old tint")) check(/^#[0-9a-f]{6}$/.test(after.tint || "") && color.toLch(color.parseHex(after.tint))[2] > 280 && color.toLch(color.parseHex(after.tint))[2] < 360, `${c.label}: magenta tint inferred`, after.tint);
    if (c.label.startsWith("greyscale")) check(after.tint === "gray", `${c.label}: greyscale carried`);
  });
  doc.objects.push(text("before", 14 * MMpx, 10 * MMpx, 10), text("after Replace (grey dashes: the old box)", 46 * MMpx, 66 * MMpx, 10));
  const file = await png(ui.render.documentSvg(doc), join(OUT, "replace.png"));
  console.log("  wrote " + file);

  // variants show their own colours
  const v = a.meta.variants[0];
  if (v) {
    const va = await icon(v.id);
    const o = iconObj(A, a, 50, 50, 80);
    o.slotColors = a.slots.map(() => "#ff0000");
    o.colors = color.slotColorMap(a.slots, o.slotColors);
    actions.replaceIconObj(o, v.id, va, { colors: false });
    check(!o.slotColors.length && !Object.keys(o.colors).length, "variant swap shows the variant's own colours");
  }

  // one undo step through the real command (loadAsset goes through the server)
  const d2 = blankDoc();
  const x1 = iconObj(A, a, 100, 100, 90), x2 = iconObj(A, a, 300, 100, 90);
  x2.rot = 45;
  d2.assets[A] = a;
  d2.objects.push(x1, x2);
  model.resetHistory();
  const snap0 = JSON.stringify(d2.objects);
  model.setSelection([x1.id, x2.id]);
  await actions.replaceIcons(WIDE);
  check(d2.objects.every((o) => o.asset === WIDE), "replaceIcons swaps every selected icon");
  check(model.canUndo() && (model.undo(), JSON.stringify(model.state.doc.objects) === snap0), "one undo restores both icons");
  check(!model.canUndo(), "the replace was a single undo step");
  model.redo();
  check(model.state.doc.objects.every((o) => o.asset === WIDE), "redo replays the replace");
  // a menu or dialog holding the icons from before an undo still replaces the ones in the figure
  const held = model.selectedObjs();
  model.undo();
  const live = model.selectedObjs();
  check(live.length === 2 && live.every((o) => !held.includes(o) && o.asset === A), "undo puts new icon objects in place (same ids)");
  await actions.replaceIcons(TALL, held);
  check(model.state.doc.objects.every((o) => o.asset === TALL) && held.every((o) => o.asset === WIDE), "Replace with objects from before the undo changes the icons in the figure, not the old copies");
  check(model.canUndo() && (model.undo(), model.state.doc.objects.every((o) => o.asset === A)), "…as one undo step");
};

/** Select all same / Select… kinds / invert. */
SCEN.select = async () => {
  const { model, actions } = ui;
  const d = blankDoc();
  const A = "nih/509-t-cell", B = "biocanvas/macrophage";
  d.assets[A] = await icon(A);
  d.assets[B] = await icon(B);
  const mk = (o) => (d.objects.push({ id: ui.util.uid(), rot: 0, ...o }), d.objects[d.objects.length - 1]);
  const i1 = mk({ type: "icon", asset: A, x: 0, y: 0, w: 50, h: 50 });
  const i2 = mk({ type: "icon", asset: A, x: 60, y: 0, w: 50, h: 50 });
  const i3 = mk({ type: "icon", asset: B, x: 120, y: 0, w: 50, h: 50 });
  const iL = mk({ type: "icon", asset: A, x: 180, y: 0, w: 50, h: 50, locked: true });
  const iH = mk({ type: "icon", asset: A, x: 240, y: 0, w: 50, h: 50, hidden: true });
  const t1 = mk({ type: "text", text: "a", x: 0, y: 80, w: 10, h: 10, fontSize: 16, fontFamily: "Arial", color: "#111111" });
  const t2 = mk({ type: "text", text: "b", x: 40, y: 80, w: 10, h: 10, fontSize: 16, fontFamily: "Arial", color: "#111111" });
  const t3 = mk({ type: "text", text: "c", x: 80, y: 80, w: 10, h: 10, fontSize: 24, fontFamily: "Arial", color: "#111111" });
  const r1 = mk({ type: "rect", x: 0, y: 120, w: 40, h: 20, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5 });
  const r2 = mk({ type: "rect", x: 50, y: 120, w: 40, h: 20, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5 });
  const e1 = mk({ type: "ellipse", x: 100, y: 120, w: 40, h: 20, fill: "#fde7c8", stroke: "#c76b1f", strokeWidth: 1.5 });
  const l1 = mk({ type: "line", x1: 0, y1: 160, x2: 50, y2: 160, stroke: "#2b3440", strokeWidth: 2, startHead: "none", endHead: "arrow" });
  const l2 = mk({ type: "line", x1: 0, y1: 170, x2: 50, y2: 170, stroke: "#2b3440", strokeWidth: 2, startHead: "none", endHead: "bar" });
  const m1 = mk({ type: "membrane", brush: "dna", pts: [[0, 200], [50, 200]], closed: false, thickness: 12 });
  const ids = (xs) => xs.map((o) => (typeof o === "string" ? o : o.id)).sort().join(",");
  const sel = (xs) => model.setSelection(xs.map((o) => o.id));

  sel([i1]);
  check(ids(actions.sameIds()) === ids([i1, i2]), "same icons: same asset, skipping locked and hidden");
  sel([iL]);
  check(ids(actions.sameIds()) === ids([i1, i2, iL]), "same icons from a locked icon keeps it selected");
  sel([t1]);
  check(ids(actions.sameIds()) === ids([t1, t2]), "same style text (size differs → excluded)");
  sel([r1]);
  check(ids(actions.sameIds()) === ids([r1, r2]), "same style shapes (ellipse excluded)");
  sel([l1]);
  check(ids(actions.sameIds()) === ids([l1]), "lines: arrow vs inhibition differ");
  sel([i3, t3]);
  check(ids(actions.sameIds()) === ids([i3, t3]), "several kinds at once");
  check(ids(actions.kindIds("icons").map((id) => ({ id }))) === ids([i1, i2, i3]), "All icons (no locked/hidden)");
  check(ids(actions.kindIds("text").map((id) => ({ id }))) === ids([t1, t2, t3]), "All text");
  check(ids(actions.kindIds("lines").map((id) => ({ id }))) === ids([l1, l2]), "All arrows and lines");
  check(ids(actions.kindIds("shapes").map((id) => ({ id }))) === ids([r1, r2, e1]), "All shapes");
  check(ids(actions.kindIds("brushes").map((id) => ({ id }))) === ids([m1]), "All brushes");
  check(ids(actions.kindIds("locked").map((id) => ({ id }))) === ids([iL]), "All locked");
  sel([i1, t1, r1]);
  actions.invertSelection();
  check(ids(model.state.selection.map((id) => ({ id }))) === ids([i2, i3, t2, t3, r2, e1, l1, l2, m1]), "Invert selection (skips locked and hidden)");
  void iH;
};

/** Context menu contents: which items are enabled for each kind of selection. */
SCEN.menus = async () => {
  const { model, menu } = ui;
  const d = blankDoc();
  const A = "nih/509-t-cell";
  d.assets[A] = await icon(A);
  const mk = (o) => (d.objects.push({ id: ui.util.uid(), rot: 0, ...o }), d.objects[d.objects.length - 1]);
  const i1 = mk({ type: "icon", asset: A, x: 0, y: 0, w: 50, h: 50, colors: {}, slotColors: [] });
  const i2 = mk({ type: "icon", asset: A, x: 60, y: 0, w: 50, h: 50, colors: {}, slotColors: [] });
  const r1 = mk({ type: "rect", x: 0, y: 120, w: 40, h: 20, fill: "#d9ecf7", stroke: "#1d6fa5" });
  const iL = mk({ type: "icon", asset: A, x: 180, y: 0, w: 50, h: 50, locked: true });
  const g = mk({ type: "group", children: [{ id: "c1", type: "rect", x: 0, y: 0, w: 5, h: 5 }, { id: "c2", type: "rect", x: 10, y: 0, w: 5, h: 5 }] });
  const on = (items) => items.filter((it) => it && it !== "-" && !it.heading && !it.disabled).map((it) => typeof it.label === "string" ? it.label : "?");
  const show = (what, ids) => {
    model.setSelection(ids);
    const items = menu.contextItems();
    console.log(`  [${what}] enabled: ${on(items).join(" · ")}`);
    return items;
  };
  const has = (items, label) => on(items).includes(label);
  let it = show("nothing", []);
  check(!has(it, "Cut") && !has(it, "Delete") && has(it, "Select All") && has(it, "Select…") && !has(it, "Replace") && !has(it, "Lock"), "empty: only paste/select items");
  it = show("one icon", [i1.id]);
  check(has(it, "Replace") && has(it, "Add To Favourites") && has(it, "Flip") && has(it, "Align") && !has(it, "Group") && has(it, "Lock"), "one icon: replace, favourites, flip, align, lock");
  const rep = menu.replaceItems();
  console.log(`  replace submenu: ${rep.filter((x) => x !== "-").map((x) => x.heading || x.label + (x.img ? " [img]" : "") + (x.disabled ? " (off)" : "")).join(" · ")}`);
  check(rep.filter((x) => x.img).length === d.assets[A].meta.variants.length + 1, "replace submenu lists the variants with thumbnails");
  it = show("two icons", [i1.id, i2.id]);
  check(has(it, "Group") && has(it, "Replace") && !has(it, "Ungroup"), "two icons: group and replace");
  it = show("icon + rect", [i1.id, r1.id]);
  check(!has(it, "Replace") && !has(it, "Add To Favourites") && has(it, "Group"), "mixed: no replace or favourites");
  it = show("locked icon", [iL.id]);
  check(has(it, "Unlock") && !has(it, "Cut") && !has(it, "Delete") && !has(it, "Flip") && !has(it, "Replace") && has(it, "Copy"), "locked: unlock and copy only");
  it = show("group", [g.id]);
  check(has(it, "Ungroup") && !has(it, "Group"), "group: ungroup");
  const al = menu.alignItems();
  check(on(al).length === 6, "align submenu: 6 aligns, distribute off for one object");
  model.setSelection([i1.id, i2.id, r1.id]);
  check(on(menu.alignItems()).length === 8, "align submenu: distribute on for three");
};

/** Transform fields: one box object and a multi-selection. */
SCEN.transform = async () => {
  const { model, actions } = ui;
  const d = blankDoc();
  const r = { id: "r", type: "rect", x: 100, y: 100, w: 200, h: 100, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5" };
  d.objects.push(r);
  model.setSelection(["r"]);
  actions.transformSel("x", 50);
  check(r.x === 50, "x sets the left edge");
  actions.transformSel("w", 100, true);
  check(near(r.w, 100) && near(r.h, 50) && near(r.x + r.w / 2, 150), "w with keep proportions resizes about the centre");
  actions.transformSel("h", 80, false);
  check(near(r.w, 100) && near(r.h, 80), "h without keep proportions");
  actions.transformSel("rot", 370);
  check(near(r.rot, 10), "rotation is normalised");
  const c = { id: "c", type: "ellipse", x: 400, y: 100, w: 100, h: 100, rot: 0 };
  d.objects.push(c);
  model.resetHistory();
  model.setSelection(["r", "c"]);
  r.rot = 0;
  const b0 = model.selectionBox();
  actions.transformSel("w", b0.w * 2, true);
  const b1 = model.selectionBox();
  check(near(b1.w, b0.w * 2) && near(b1.h, b0.h * 2) && near(b1.x + b1.w / 2, b0.x + b0.w / 2), "multi: uniform scale about the centre");
  actions.transformSel("x", 0);
  check(near(model.selectionBox().x, 0), "multi: x moves the bounds");
  actions.transformSel("rotBy", 90);
  check(near(r.rot, 90) && near(c.rot, 90), "multi: rotate by an angle");
  check(model.canUndo(), "transform edits are undoable");
};

/** Paste at the right-click point. */
SCEN.paste = async () => {
  const { model, actions } = ui;
  const d = blankDoc();
  d.objects.push({ id: "a", type: "rect", x: 10, y: 10, w: 40, h: 20, rot: 0, fill: "#fff" });
  model.setSelection(["a"]);
  actions.copySel();
  check(actions.hasClip(), "copy fills the clipboard");
  actions.pasteClip(10, [300, 200]);
  const p = model.selectedObjs()[0];
  check(p && p.id !== "a" && near(p.x + p.w / 2, 300) && near(p.y + p.h / 2, 200), "paste centres the copy on the clicked point");
  actions.pasteClip();
  const q = model.selectedObjs()[0];
  check(near(q.x, p.x + 10) && near(q.y, p.y + 10), "Ctrl+V after that cascades from the pasted copy");
  // copies of locked objects are free to move
  d.objects.push({ id: "L", type: "rect", x: 100, y: 10, w: 40, h: 20, rot: 0, fill: "#fff", locked: true });
  model.setSelection(["L"]);
  actions.duplicateSel();
  const dup = model.selectedObjs()[0];
  check(dup && dup.id !== "L" && !dup.locked && model.getObj("L").locked, "Duplicate of a locked object is unlocked (the original stays locked)");
  model.setSelection(["L"]);
  actions.copySel();
  actions.pasteClip();
  const pl = model.selectedObjs()[0];
  check(pl && pl.id !== "L" && !pl.locked && model.getObj("L").locked, "Paste of a locked object is unlocked");
};

const STYLE_ICONS = [
  "biocanvas/macrophage", "nih/509-t-cell", "biocanvas/b-cell", "biocanvas/neutrophil", "biocanvas/mast-cell", "biocanvas/eosinophil",
  "biocanvas/dendritic-cell", "biocanvas/fibroblast", "nih/913-neutrophil", "servier/testtube-glass", "servier/antibody", "nih/352-mitochondria",
  "servier/platelet", "nih/967-virus", "biocanvas/neuron",
];

async function styleAssets(doc, ids = STYLE_ICONS) {
  const out = [];
  for (const id of ids) {
    try {
      doc.assets[id] = await icon(id);
      out.push(id);
    } catch (e) {
      console.log("  (skip " + id + ": " + e.message + ")");
    }
  }
  return out;
}

/** Style panel logic: part names, presets (a sheet of every preset on several icons), overlay and adjustments. */
SCEN.style = async () => {
  const { model, style, color } = ui;
  const doc = blankDoc(10, 10);
  const ids = await styleAssets(doc);
  for (const id of ids) {
    const a = doc.assets[id];
    const p = style.partInfo(id, a);
    console.log(`  ${id.padEnd(26)} ${p.parts.map((s) => `${s.name}[${s.role}${s.kind !== "color" ? "/" + s.kind : ""} ${a.slots[s.i].base} ${Math.round(s.weight * 100)}% n${s.n} a${s.aspect.toFixed(1)}]`).join("  ")}`);
  }
  const names = (id) => style.partInfo(id, doc.assets[id]).parts.map((s) => s.name);
  check(names("biocanvas/macrophage").includes("Nucleus") && names("biocanvas/macrophage")[0] === "Cell", "macrophage: cell body and nucleus named");
  check(names("biocanvas/b-cell").includes("Nucleus"), "B cell: nucleus named");
  check(names("servier/testtube-glass")[0] === "Body" && names("servier/testtube-glass").includes("Outline") && names("servier/testtube-glass").includes("Highlights"), "test tube: body, outline, highlights");
  check(ids.every((id) => new Set(names(id)).size === names(id).length), "part names are unique per icon");

  // presets sheet: one row per icon, one column per preset
  const S = 54, G = 8, cols = 30;
  const sheet = blankDoc(((cols + 1) * (S + G) + 40) / MMpx, ((ids.length + 1) * (S + G) + 30) / MMpx);
  Object.assign(sheet.assets, doc.assets);
  let maxN = 0;
  ids.forEach((id, r) => {
    const a = sheet.assets[id];
    const list = style.iconPresets(id, a);
    maxN = Math.max(maxN, list.length);
    const [, , vw, vh] = ui.render.assetParts(id, a).vb;
    list.forEach((p, c) => {
      const ar = vw / vh, w = ar >= 1 ? S : S * ar, h = ar >= 1 ? S / ar : S;
      const cx = 20 + c * (S + G) + S / 2, cy = 30 + r * (S + G) + S / 2;
      const o = { id: ui.util.uid(), type: "icon", asset: id, x: cx - w / 2, y: cy - h / 2, w, h, rot: 0, colors: {}, slotColors: [] };
      check(style.applyPreset(o, p.id, a), `${id}: preset ${p.id} applies`);
      sheet.objects.push(o);
      if (c === style.PRESETS_FIRST - 1) sheet.objects.push({ id: ui.util.uid(), type: "line", x1: cx + S / 2 + G / 2, y1: cy - S / 2, x2: cx + S / 2 + G / 2, y2: cy + S / 2, stroke: "#e0457b", strokeWidth: 1, dash: "dash", startHead: "none", endHead: "none" });
    });
    check(list[0].id === "original" && list.length >= 2, `${id}: ${list.length} presets, Original first`);
  });
  const head = style.iconPresets(ids[0], sheet.assets[ids[0]]);
  head.forEach((p, c) => sheet.objects.push(text(p.name.replace(" and ", "+"), 20 + c * (S + G) + S / 2, 6, 6.5)));
  check(maxN >= 25 && maxN <= 32, `about 30 presets for a two-part cell (${maxN})`);
  console.log("  wrote " + (await png(ui.render.documentSvg(sheet), join(OUT, "style-presets.png"))));

  // preset maths: body pastel, nucleus darker and more saturated, neutrals untouched
  {
    const id = "biocanvas/macrophage", a = doc.assets[id];
    const o = { id: "m", type: "icon", asset: id, x: 0, y: 0, w: 50, h: 50, colors: {}, slotColors: [] };
    style.applyPreset(o, "teal", a);
    const [bl, bc, bh] = color.toLch(color.parseHex(o.slotColors[0]));
    const [nl, nc] = color.toLch(color.parseHex(o.slotColors[1]));
    check(bl > 0.8 && bh > 170 && bh < 210 && nl < bl - 0.15 && nc > bc, "teal: pastel teal body, darker more saturated nucleus", o.slotColors.join(" "));
    check(o.slotColors[2] == null && !o.colors["#ffffff"], "teal: neutral highlights stay white");
    check(o.preset === "teal" && style.currentPreset(o) === "teal", "applied preset is recorded");
    style.applyPreset(o, "peach-purple", a);
    check(color.toLch(color.parseHex(o.slotColors[1]))[2] > 280, "two-tone: purple nucleus on a peach body");
    style.applyPreset(o, "gray", a);
    check(o.tint === "gray" && Object.values(o.colors).every((h) => color.toLch(color.parseHex(h))[1] < 0.01), "greyscale preset");
    style.applyPreset(o, "original", a);
    check(!Object.keys(o.colors).length && style.currentPreset(o) === "original", "original preset clears the colours");
    // thumbnails: a standalone SVG per preset, cached as an image URL
    const p = style.iconPresets(id, a).find((x) => x.id === "sky");
    const u1 = style.presetThumb(o, a, p), u2 = style.presetThumb(o, a, p);
    check(u1 === u2 && /^(blob|data):/.test(u1), "preset thumbnails are cached image URLs", u1.slice(0, 30));
    console.log("  wrote " + (await png(style.iconSvg(o, a, p.map), join(OUT, "style-thumb.png"), 96)));
  }

  // overlay, saturation, lightness, transparency, reset — and the adjustments survive part edits
  const ov = blankDoc(282, 60);
  Object.assign(ov.assets, doc.assets);
  const rows = ["biocanvas/macrophage", "nih/509-t-cell", "servier/testtube-glass"].filter((id) => ids.includes(id));
  const sw = style.OVERLAYS;
  rows.forEach((id, r) => {
    const a = ov.assets[id];
    const [, , vw, vh] = ui.render.assetParts(id, a).vb;
    const mk = (c) => {
      const s = 46, ar = vw / vh, w = ar >= 1 ? s : s * ar, h = ar >= 1 ? s / ar : s;
      const cx = 30 + c * 56, cy = 40 + r * 62;
      const o = { id: ui.util.uid(), type: "icon", asset: id, x: cx - w / 2, y: cy - h / 2, w, h, rot: 0, colors: {}, slotColors: [] };
      ov.objects.push(o);
      return o;
    };
    mk(0);
    sw.forEach(([hex], c) => style.applyOverlay(mk(c + 1), hex, a));
    const s0 = mk(13);
    style.setAdjust(s0, { saturation: 0 }, a);
    const s2 = mk(14);
    style.setAdjust(s2, { saturation: 200 }, a);
    const l1 = mk(15);
    style.setAdjust(l1, { lightness: 50 }, a);
    const l2 = mk(16);
    style.setAdjust(l2, { lightness: -50 }, a);
    const t = mk(17);
    t.opacity = 0.4;
  });
  ["", ...sw.map(([, n]) => n), "sat 0", "sat 200", "light +50", "light −50", "transp. 60"].forEach((n, c) => ov.objects.push(text(n, 30 + c * 56, 8, 6)));
  console.log("  wrote " + (await png(ui.render.documentSvg(ov), join(OUT, "style-overlay.png"))));
  {
    const id = "biocanvas/macrophage", a = doc.assets[id];
    const o = { id: "m2", type: "icon", asset: id, x: 0, y: 0, w: 50, h: 50, colors: {}, slotColors: [] };
    style.applyOverlay(o, "#2f6fd6", a);
    check(o.tint === "#2f6fd6" && color.toLch(color.parseHex(o.colors[a.slots[0].base]))[2] > 230, "overlay tints the body blue");
    style.setAdjust(o, { saturation: 0 }, a);
    check(Object.values(o.colors).every((h) => color.toLch(color.parseHex(h))[1] < 0.01) && o.baseColors, "saturation 0 makes every colour grey, keeping the recipe");
    style.setAdjust(o, { saturation: 100 }, a);
    check(o.saturation == null && !o.baseColors && o.colors[a.slots[0].base] === color.overlayMap(a.slots, "#2f6fd6")[a.slots[0].base], "saturation back to 100 restores the overlay exactly");
    style.setAdjust(o, { lightness: 40 }, a);
    const before = o.colors[a.slots[1].base];
    style.setPartColor(o, 1, "#d33b3b", a);
    check(o.lightness === 40 && o.colors[a.slots[1].base] !== before && color.toLch(color.parseHex(o.colors[a.slots[1].base]))[0] > color.toLch(color.parseHex("#d33b3b"))[0], "part colour picked under a lightness adjustment is lightened too");
    check(o.slotColors[0] && color.toLch(color.parseHex(o.slotColors[0]))[2] > 230, "picking a part keeps the overlay on the other parts");
    o.opacity = 0.5;
    style.resetStyle(o);
    check(!Object.keys(o.colors).length && !o.slotColors.length && o.tint == null && o.lightness == null && o.opacity == null, "reset styles");
  }
  void model;
};

/** Glow on icons, shapes and brushes: export through resvg, bounds, unique filter ids, copies, groups. */
SCEN.glow = async () => {
  const { model, render, style, actions } = ui;
  const A = "biocanvas/macrophage", N = "biocanvas/neuron";
  const doc = blankDoc(200, 150);
  await styleAssets(doc, [A, N]);
  const S = 26 * MMpx;
  const objs = [];
  const add = (o) => (objs.push(o), doc.objects.push(o), o);
  const fl = style.FLUORS;
  // row 1: icons (plain, rotated + flipped, recoloured), an icon brush
  const i1 = add(iconObj(A, doc.assets[A], 25 * MMpx, 25 * MMpx, S));
  i1.glow = style.defaultGlow(i1, fl[0][0]);
  const i2 = add(iconObj(A, doc.assets[A], 65 * MMpx, 25 * MMpx, S));
  Object.assign(i2, { rot: 35, flipX: true });
  style.applyPreset(i2, "vivid-red", doc.assets[A]);
  i2.glow = style.defaultGlow(i2, fl[1][0]);
  const i3 = add(iconObj(N, doc.assets[N], 110 * MMpx, 25 * MMpx, S * 1.4));
  i3.glow = { color: fl[3][0], size: 4 };
  const ib = add({ id: ui.util.uid(), type: "membrane", brush: "icon", asset: A, colors: {}, slotColors: [], pts: [[135 * MMpx, 30 * MMpx], [160 * MMpx, 15 * MMpx], [190 * MMpx, 30 * MMpx]], closed: false, thickness: 30, seed: 3 });
  ib.glow = style.defaultGlow(ib, fl[2][0]);
  // row 2: shapes and pattern brushes
  const r = add({ id: ui.util.uid(), type: "rect", x: 10 * MMpx, y: 55 * MMpx, w: 35 * MMpx, h: 22 * MMpx, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5, radius: 6 });
  r.glow = style.defaultGlow(r, fl[5][0]);
  const e = add({ id: ui.util.uid(), type: "ellipse", x: 55 * MMpx, y: 55 * MMpx, w: 30 * MMpx, h: 22 * MMpx, rot: 20, fill: "#fde7c8", stroke: "#c76b1f", strokeWidth: 1.5 });
  e.glow = { color: fl[4][0], size: 16 };
  const m = add({ id: ui.util.uid(), type: "membrane", brush: "bilayer", pts: [[100 * MMpx, 75 * MMpx], [130 * MMpx, 55 * MMpx], [160 * MMpx, 75 * MMpx], [190 * MMpx, 60 * MMpx]], closed: false, thickness: 14, headColor: "#f0a35c", tailColor: "#e9c88f", seed: 2 });
  m.glow = style.defaultGlow(m, fl[0][0]);
  // row 3: a group holding a glowing icon, and a copy of i1 (fresh id → its own filter)
  const gi = iconObj(A, doc.assets[A], 30 * MMpx, 110 * MMpx, S);
  gi.glow = { color: fl[1][0], size: 8 };
  const gt = text("grouped", 30 * MMpx, 125 * MMpx, 9);
  const g = add({ id: ui.util.uid(), type: "group", name: "Group", children: [gi, gt] });
  const c = add(model.cloneObj(i1));
  model.moveObj(c, 50 * MMpx, 85 * MMpx);
  c.glow = { color: fl[2][0], size: 20 };

  // bounds and hit areas ignore the glow; visualBox includes it
  const plain = (o) => {
    const x = JSON.parse(JSON.stringify(o));
    delete x.glow;
    return model.bbox(x);
  };
  check(objs.every((o) => JSON.stringify(model.bbox(o)) === JSON.stringify(plain(o))), "glow leaves bounding boxes unchanged");
  const vb = render.visualBox([i1]), bb = model.bbox(i1);
  check(near(bb.x - vb.x, render.glowReach(i1.glow)) && vb.w > bb.w, "visualBox reaches past the bounds by the glow");
  const hitMarkup = render.contentMarkup(i1, doc, true);
  check(hitMarkup.includes('class="hit"') && !hitMarkup.includes("filter"), "hit rectangle drawn without the filter");
  // markup: one filter per glowing object, unique ids, resvg-friendly primitives only
  const svg = render.documentSvg(doc);
  const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
  check(ids.length === new Set(ids).size, "no duplicate ids in the exported SVG", `${ids.length - new Set(ids).size} duplicates`);
  const glowing = [...objs.filter((o) => o.glow), gi];
  check(glowing.every((o) => svg.includes(`<filter id="${render.glowId(o)}"`) && svg.includes(`filter="url(#${render.glowId(o)})"`)), `a filter for each of the ${glowing.length} glowing objects`);
  check(render.glowId(c) !== render.glowId(i1), "a copy gets its own glow filter id");
  // only a copy goes through the filter (PDF rasterises filtered groups): the object itself is drawn after it
  const m1 = render.objectMarkup(i1, doc);
  check(m1.includes(`filter="url(#${render.glowId(i1)})"`) && m1.endsWith(`</g><g transform="${render.objTransform(i1, doc)}">${render.contentMarkup(i1, doc, false)}</g></g>`) && !m1.includes("<feMerge"), "exports draw the object unfiltered over a filtered copy");
  for (const format of ["pdf", "tiff"]) {
    try {
      const r = await api("export", { format, svg, dpi: 150 });
      check(r.base64.length > 1000, `${format} export with glows`);
    } catch (err) {
      check(false, `${format} export with glows`, err.message);
    }
  }
  const prims = new Set([...svg.matchAll(/<(fe\w+)/g)].map((x) => x[1]));
  check([...prims].every((p) => ["feGaussianBlur", "feComponentTransfer", "feFuncA", "feFlood", "feComposite", "feMerge", "feMergeNode"].includes(p)), "only blur/flood/composite/merge primitives", [...prims].join(","));
  // duplicate keeps the glow with a fresh id
  model.resetHistory();
  model.setSelection([i1.id]);
  actions.duplicateSel();
  const d = model.selectedObjs()[0];
  check(d.id !== i1.id && JSON.stringify(d.glow) === JSON.stringify(i1.glow), "duplicate keeps the glow");
  model.undo();
  check(!model.getObj(d.id), "duplicate undoes");
  // undo/redo of a glow change
  model.resetHistory();
  model.setSelection([r.id]);
  actions.updateSel((x) => delete x.glow);
  check(!model.getObj(r.id).glow, "glow off");
  model.undo();
  check(!!model.getObj(model.state.doc.objects.find((o) => o.type === "rect").id).glow, "undo brings the glow back");
  // a document without glows has no filters (old figures render exactly as before)
  const old = blankDoc(60, 40);
  old.assets[A] = doc.assets[A];
  old.objects.push(iconObj(A, doc.assets[A], 30 * MMpx, 20 * MMpx, S));
  check(!render.documentSvg(old).includes("<filter"), "figures without glow have no filters");

  // render on white and on black (fluorescence-style)
  const labels = [text("GFP", 25 * MMpx, 42 * MMpx, 8), text("RFP, rotated + flipped", 65 * MMpx, 46 * MMpx, 8), text("YFP, thin", 110 * MMpx, 46 * MMpx, 8), text("icon brush, DAPI", 162 * MMpx, 46 * MMpx, 8),
    text("rect, CFP", 27 * MMpx, 82 * MMpx, 8), text("ellipse, Cy5 16px", 70 * MMpx, 84 * MMpx, 8), text("bilayer brush", 145 * MMpx, 84 * MMpx, 8), text("copy, 20px", 75 * MMpx, 128 * MMpx, 8)];
  const sheet = doc;
  sheet.objects.push(...labels);
  for (const o of objs) sheet.objects.push(frame({ ...model.bbox(o), rot: 0 }, "#9aa3ad"));
  console.log("  wrote " + (await png(render.documentSvg(sheet), join(OUT, "glow.png"))));
  console.log("  wrote " + (await png(render.documentSvg(sheet, { background: "#000000" }), join(OUT, "glow-dark.png"))));
  void g;
};

/** Part names on a wider set of icons (Layers children and the Style panel's Parts). */
SCEN.parts = async () => {
  const { style } = ui;
  const doc = blankDoc(10, 10);
  // the style icons plus the first hits of a few searches across the library's sources
  const found = [];
  for (const q of ["plasma cell", "monocyte", "basophil", "osteoclast", "synovial", "mitochondria", "receptor", "bacteria", "mouse", "neuron", "tumour cell", "virus"]) {
    const r = await api("library.search", { q, limit: 2 });
    found.push(...r.items.map((it) => it.id));
  }
  const ids = await styleAssets(doc, [...new Set([...STYLE_ICONS, ...found])]);
  let fallback = 0, total = 0;
  for (const id of ids) {
    const p = style.partInfo(id, doc.assets[id]).parts;
    total += p.length;
    fallback += p.filter((s) => /^Part \d/.test(s.name)).length;
    console.log(`  ${id.padEnd(28)} ${p.map((s) => s.name).join(", ")}`);
    check(p.length === (doc.assets[id].slots || []).length && p.every((s) => s.name), `${id}: every part named`);
  }
  console.log(`  ${fallback} of ${total} parts fell back to "Part n"`);
};

/* ---------- connectors ---------- */

/**
 * How far a connected end sits outside its target's painted outline (stroke included), measured
 * along the ray from the target's centre (or `from`) through the end.
 */
function endGap(t, p, from = null) {
  const { model } = ui;
  const c = from || (model.isBox(t) ? [t.x + t.w / 2, t.y + t.h / 2] : (() => {
    const b = model.bbox(t);
    return [b.x + b.w / 2, b.y + b.h / 2];
  })());
  const on = model.outlinePoint(t, c, [p[0] - c[0], p[1] - c[1]], 0);
  return Math.hypot(p[0] - on[0], p[1] - on[1]) * Math.sign((p[0] - c[0]) * (p[0] - on[0]) + (p[1] - c[1]) * (p[1] - on[1]) || 1);
}

const lineObj = (o) => ({ id: ui.util.uid(), type: "line", x1: 0, y1: 0, x2: 1, y2: 1, stroke: "#2b3440", strokeWidth: 2, curve: 0, startHead: "none", endHead: "arrow", dash: "", ...o });

/** Connectors: ends on outlines, following moves/turns/resizes, elbows, detaching, copies, undo, export. */
SCEN.connectors = async () => {
  const { model, render, actions } = ui;
  const A = "biocanvas/macrophage", B = "nih/509-t-cell";
  const doc = blankDoc(200, 175);
  await styleAssets(doc, [A, B]);
  const mk = (o) => (doc.objects.push({ id: ui.util.uid(), rot: 0, ...o }), doc.objects[doc.objects.length - 1]);
  const X = (v) => v * MMpx, S = X(24);
  const box = (name, x, y, w, h, fill, stroke, extra = {}) => mk({ type: "rect", name, x: X(x), y: X(y), w: X(w), h: X(h), fill, stroke, strokeWidth: 1.5, radius: 4, ...extra });
  // row 1: straight and curved connectors between a rounded rect, a rotated ellipse, an icon and text
  const r1 = box("Receptor", 12, 12, 30, 18, "#d9ecf7", "#1d6fa5", { radius: 10 });
  const e1 = mk({ type: "ellipse", name: "Ligand", x: X(75), y: X(8), w: X(32), h: X(18), rot: 25, fill: "#fde7c8", stroke: "#c76b1f", strokeWidth: 1.5 });
  const i1 = mk(iconObj(A, doc.assets[A], X(165), X(22), S));
  const t1 = mk(text("Signal", X(120), X(50), 14));
  const L1 = mk(lineObj({ from: { id: r1.id }, to: { id: e1.id } }));
  const L2 = mk(lineObj({ from: { id: e1.id }, to: { id: i1.id }, endHead: "bar" }));
  const L3 = mk(lineObj({ from: { id: e1.id }, to: { id: t1.id }, curve: 25, pad: 6 }));
  const L4 = mk(lineObj({ from: { id: r1.id }, x2: X(30), y2: X(56), dash: "dash" })); // one free end
  // row 2: elbows — sideways (Z), up/down, an L, a straight drop, onto a freeform shape
  const i2 = mk(iconObj(B, doc.assets[B], X(22), X(95), S));
  const r2 = box("Nucleus", 62, 128, 30, 16, "#efe3f7", "#7d4ea8");
  const r3 = box("Gene", 64, 66, 26, 14, "#e3f4e6", "#2f8a4b");
  const r4 = box("mRNA", 118, 70, 24, 14, "#fff4cc", "#b08a12");
  const r5 = box("Protein", 136, 112, 40, 14, "#fde2e2", "#c0392b");
  const r6 = box("Complex", 160, 150, 30, 14, "#e6eef8", "#4a6b95");
  const free = mk({ type: "membrane", brush: "freeform", name: "Vesicle", closed: true, pts: [[X(100), X(140)], [X(114), X(130)], [X(128), X(140)], [X(122), X(160)], [X(104), X(158)]], thickness: 1.5, fill: "#f6d5e5", fillOpacity: 0.8, stroke: "#b0447a" });
  const E1 = mk(lineObj({ route: "elbow", axis: "h", bend: 0.5, from: { id: i2.id }, to: { id: r2.id } }));
  const E2 = mk(lineObj({ route: "elbow", axis: "v", bend: 0.5, from: { id: i2.id }, to: { id: r3.id }, startHead: "dot" }));
  const E3 = mk(lineObj({ route: "elbow", axis: "h", bend: 0.5, from: { id: r4.id }, to: { id: r5.id }, strokeWidth: 3 }));
  const E4 = mk(lineObj({ route: "elbow", axis: "h", bend: 0.5, from: { id: r5.id }, to: { id: r6.id }, endHead: "bar" }));
  const E6 = mk(lineObj({ route: "elbow", axis: "v", bend: 0.5, from: { id: r2.id }, to: { id: r4.id }, endHead: "open", stroke: "#7d4ea8" }));
  const E5 = mk(lineObj({ route: "elbow", axis: "h", bend: 0.5, from: { id: r3.id }, to: { id: r4.id }, dash: "dash" }));
  const C1 = mk(lineObj({ from: { id: r2.id }, to: { id: free.id }, endHead: "open" }));
  model.syncConnectors();
  doc.objects.push(text("straight · inhibition · curved (6 px padding) · one free end", X(100), X(60), 9), text("elbows: Z, up/down (purple), L, straight drop, onto a freeform shape", X(100), X(168), 9));
  const svg = render.documentSvg(doc);
  console.log("  wrote " + (await png(svg, join(OUT, "connectors.png"), 150)));
  try {
    const r = await api("export", { format: "pdf", svg, dpi: 150 });
    check(r.base64.length > 1000, "PDF export with connectors");
  } catch (err) {
    check(false, "PDF export with connectors", err.message);
  }

  // ends sit `pad` px off the painted outlines (stroke included)
  const gapOK = (t, p, pad = 2) => Math.abs(endGap(t, p) - pad) < 0.3;
  const g = (t, p) => endGap(t, p).toFixed(2);
  check(gapOK(r1, [L1.x1, L1.y1]) && gapOK(e1, [L1.x2, L1.y2]), "straight: both ends 2 px off the outlines (rounded rect, rotated ellipse)", `${g(r1, [L1.x1, L1.y1])} / ${g(e1, [L1.x2, L1.y2])}`);
  check(gapOK(i1, [L2.x2, L2.y2]), "icon end on the icon's box", g(i1, [L2.x2, L2.y2]));
  {
    const ca = [r1.x + r1.w / 2, r1.y + r1.h / 2], cb = [e1.x + e1.w / 2, e1.y + e1.h / 2];
    const cross = (p) => ((p[0] - ca[0]) * (cb[1] - ca[1]) - (p[1] - ca[1]) * (cb[0] - ca[0])) / Math.hypot(cb[0] - ca[0], cb[1] - ca[1]);
    check(Math.abs(cross([L1.x1, L1.y1])) < 1e-6 && Math.abs(cross([L1.x2, L1.y2])) < 1e-6, "straight: ends on the line between the centres");
  }
  {
    // a curve leaves along its tangent: the end aims at the control point
    const c = model.ctrlPt(L3), cE = [e1.x + e1.w / 2, e1.y + e1.h / 2];
    const a1 = Math.atan2(L3.y1 - cE[1], L3.x1 - cE[0]), a2 = Math.atan2(c[1] - cE[1], c[0] - cE[0]);
    check(Math.abs(endGap(t1, [L3.x2, L3.y2], [t1.x + t1.w / 2, t1.y + t1.h / 2]) - 6) < 0.3 && Math.abs(a1 - a2) < 0.02, "curved: 6 px padding, ends facing the control point", g(t1, [L3.x2, L3.y2]));
  }
  check(L4.x2 === X(30) && L4.y2 === X(56) && gapOK(r1, [L4.x1, L4.y1]), "a free end stays where it is; the connected end faces it");
  const square = (o) => {
    const p = model.elbowPts(o);
    return p.slice(1).every((q, i) => Math.abs(q[0] - p[i][0]) < 1e-6 || Math.abs(q[1] - p[i][1]) < 1e-6);
  };
  const P = (o) => JSON.stringify(model.elbowPts(o).map((p) => p.map((v) => +(v / MMpx).toFixed(1))));
  check([E1, E2, E3, E4, E5, E6].every(square), "elbows: all segments horizontal or vertical");
  check(near(E1.y1, i2.y + i2.h / 2) && E1.x1 > i2.x + i2.w && E1.x2 < r2.x && near(E1.y2, r2.y + r2.h / 2), "Z elbow: leaves the icon's right side, enters the box's left side", P(E1));
  check(E6.y1 < r2.y && E6.y2 > r4.y + r4.h && near(E6.x1, r2.x + r2.w / 2) && near(E6.x2, r4.x + r4.w / 2), "up/down elbow: leaves the top, enters the bottom", P(E6));
  check(E2.x1 > i2.x + i2.w && E2.y2 > r3.y + r3.h && near(E2.x2, r3.x + r3.w / 2), "up/down elbow with the bend beside the start: an L from the side into the bottom", P(E2));
  const m3 = model.elbowPts(E3);
  check(E3.x1 > r4.x + r4.w && near(E3.x2, m3[2][0]) && E3.y2 < r5.y && E3.x2 > r5.x && E3.x2 < r5.x + r5.w, "bend over the target: an L dropping onto its top", P(E3));
  check(near(E4.x1, E4.x2) && E4.y1 > r5.y + r5.h && E4.y2 < r6.y, "bend over both: a straight drop", P(E4));
  check(gapOK(free, [C1.x2, C1.y2]), "end on a freeform shape's curved outline", g(free, [C1.x2, C1.y2]));
  const ends = (o) => [[o.x1, o.y1], [o.x2, o.y2]];
  check(gapOK(r3, ends(E5)[0], 2) || E5.x1 > r3.x + r3.w, "sideways elbow between boxes at the same height", P(E5));

  // following: move, rotate, resize the targets (on a copy of the figure)
  model.moveObj(e1, X(10), X(20));
  model.syncConnectors();
  check(gapOK(e1, [L1.x2, L1.y2]) && gapOK(e1, [L2.x1, L2.y1]), "moving a target: its connectors follow");
  model.rotateObjAbout(r1, r1.x + r1.w / 2, r1.y + r1.h / 2, 40);
  model.scaleObjAbout(i1, i1.x, i1.y, 1.4, 1.4);
  model.moveObj(r5, X(-30), X(8));
  model.syncConnectors();
  check(gapOK(r1, [L1.x1, L1.y1]) && gapOK(i1, [L2.x2, L2.y2]), "rotating and resizing targets: ends stay on the outlines", `${g(r1, [L1.x1, L1.y1])} / ${g(i1, [L2.x2, L2.y2])}`);
  check([E3, E4].every(square) && E3.to && E4.from, "elbows re-route when their objects move");
  console.log("  wrote " + (await png(render.documentSvg(doc), join(OUT, "connectors-moved.png"), 110)));
  // moving a connector by itself lets it go; moving it with both its objects keeps it
  model.state.selection = [L1.id];
  actions.nudge(5, 0);
  check(!L1.from && !L1.to, "nudging a connector alone detaches it");
  model.state.selection = [L2.id, e1.id, i1.id];
  actions.nudge(5, 0);
  check(L2.from && L2.to, "moving a connector with both its objects keeps it connected");
  // deleting a target lets go of the end, leaving the line where it was
  const before = [L3.x2, L3.y2];
  doc.objects = doc.objects.filter((o) => o !== t1);
  model.state.doc = doc;
  model.syncConnectors();
  check(!L3.to && L3.from && L3.x2 === before[0] && L3.y2 === before[1], "deleting a target detaches that end in place");
  // copies: connected to copied targets, let go of the rest
  const [cL, cA, cB] = model.cloneObjs([E1, i2, r2]);
  check(cL.from.id === cA.id && cL.to.id === cB.id && cA.id !== i2.id, "copying a connector with its objects connects the copies");
  const [solo] = model.cloneObjs([E1]);
  check(!solo.from && !solo.to, "copying a connector alone lets go of both ends");
  // groups: a target inside a group is still found
  const grp = { id: ui.util.uid(), type: "group", children: [r6] };
  doc.objects = doc.objects.filter((o) => o !== r6);
  doc.objects.push(grp);
  model.moveObj(grp, X(6), 0);
  model.syncConnectors();
  check(E4.to?.id === r6.id && gapOK(r6, [E4.x2, E4.y2]), "a target inside a group keeps its connector");
  model.flipObj(E3, "h", X(100), 0);
  check(square(E3), "flipped elbow stays square");
  // what an end may join: not lines, locked or hidden objects, nor a background the line lies on
  {
    const bg = { id: "bg", type: "rect", x: 0, y: 0, w: 400, h: 300, rot: 0 };
    const el = { id: "el", type: "ellipse", x: 100, y: 100, w: 200, h: 60, rot: 90 };
    const cell = { id: "cell", type: "rect", x: 180, y: 130, w: 40, h: 40, rot: 0 };
    const free = (pt) => ({ pt, obj: null });
    check(model.canConnect(bg) && !model.canConnect(bg, free([200, 150])) && model.canConnect(bg, free([450, 150])), "an end can't join an object a free other end lies inside (lines across a background drawing stay free)");
    check(!model.canConnect(bg, { pt: [200, 150], obj: cell }), "nor a background many times the size of the object the other end is on (a cell on a tissue)");
    const C = { id: "C", type: "ellipse", x: 100, y: 100, w: 120, h: 120, rot: 0 }, N = { id: "N", type: "ellipse", x: 135, y: 135, w: 50, h: 50, rot: 0 };
    check(model.canConnect(C, { pt: [160, 160], obj: N }), "an end joins the cell the other end's nucleus sits in");
    const A1 = { id: "A1", type: "icon", x: 0, y: 0, w: 100, h: 100, rot: 0 }, B1 = { id: "B1", type: "icon", x: 80, y: 0, w: 100, h: 100, rot: 0 };
    check(model.canConnect(B1, { pt: [90, 50], obj: A1 }), "an end joins an icon whose box overlaps where the line starts on its neighbour");
    check(model.insideOutline(el, [200, 200]) && model.insideOutline(el, [200, 60]) && !model.insideOutline(el, [120, 130]), "inside test follows a rotated ellipse");
    check(!model.canConnect({ ...bg, locked: true }) && !model.canConnect({ ...bg, hidden: true }) && !model.canConnect(lineObj({})) && !model.canConnect(null), "locked, hidden objects and lines can't be joined");
    // a connector from a nucleus to its cell runs outwards from the nucleus to the cell's edge
    const d3 = blankDoc();
    const cellR = { id: "cr", type: "rect", x: 100, y: 100, w: 120, h: 120, rot: 0, fill: "#eee" }, nuc = { id: "nr", type: "rect", x: 180, y: 145, w: 30, h: 30, rot: 0, fill: "#99c" };
    const Ln = lineObj({ from: { id: "nr" }, to: { id: "cr" } }), Lc = lineObj({ from: { id: "cr" }, to: { id: "nr" } });
    d3.objects.push(cellR, nuc, Ln, Lc);
    model.syncConnectors();
    const out = (L, a, b) => L[a] > nuc.x + nuc.w && L[b] > cellR.x + cellR.w && near(L.y1, 160) && near(L.y2, 160);
    check(out(Ln, "x1", "x2") && Ln.x2 > Ln.x1, "nucleus → cell: from the nucleus's outer side to the cell's edge, not across the nucleus", `${Ln.x1.toFixed(1)} → ${Ln.x2.toFixed(1)}`);
    check(out(Lc, "x2", "x1") && Lc.x1 > Lc.x2, "cell → nucleus: the same line the other way", `${Lc.x1.toFixed(1)} → ${Lc.x2.toFixed(1)}`);
    check(model.isFurniture(null) === false && model.isFurniture(undefined) === false, "isFurniture copes with no object (double-click on blank paper)");
  }
  // documents without connectors are left exactly as they were
  const old = blankDoc(60, 40);
  old.objects.push(lineObj({ x1: 10, y1: 10, x2: 100, y2: 50, curve: 12 }), { id: "r", type: "rect", x: 0, y: 0, w: 5, h: 5, rot: 0 });
  const os = JSON.stringify(old.objects);
  model.syncConnectors();
  model.commit();
  check(JSON.stringify(old.objects) === os, "old figures: sync changes nothing");

  // undo/redo, copy/paste and duplicate through the real commands
  const d2 = blankDoc();
  d2.objects.push({ id: "ra", type: "rect", x: 20, y: 20, w: 60, h: 40, rot: 0, fill: "#ddd" }, { id: "rb", type: "rect", x: 300, y: 200, w: 60, h: 40, rot: 0, fill: "#ddd" }, lineObj({ id: "ln", from: { id: "ra" }, to: { id: "rb" } }));
  model.syncConnectors();
  model.resetHistory();
  model.setSelection(["rb"]);
  actions.deleteSel();
  check(!model.getObj("ln").to, "delete: the connector lets go");
  model.undo();
  check(model.getObj("ln").to?.id === "rb", "undo: connected again");
  model.redo();
  check(!model.getObj("ln").to, "redo: let go again");
  model.undo();
  model.setSelection(["ln", "ra", "rb"]);
  actions.copySel();
  actions.pasteClip();
  const pasted = model.selectedObjs();
  const pl = pasted.find((o) => o.type === "line"), pa = pasted.find((o) => o.x === 30);
  check(pl && pa && pl.from?.id === pa.id && pl.to?.id !== "rb" && pasted.some((o) => o.id === pl.to?.id), "paste: the copy joins the pasted boxes");
  model.setSelection(["ln"]);
  actions.duplicateSel();
  const dl = model.selectedObjs()[0];
  check(dl.id !== "ln" && !dl.from && !dl.to, "duplicating a connector alone gives a free copy");
  model.setSelection(["ra"]);
  actions.flipSel("h");
  check(model.getObj("ln").from?.id === "ra", "flipping a target keeps the connector");
};

/** New brushes: path arrows, presets, freeform shapes, blood vessels, axons — markup, bounds, export. */
SCEN.brushes = async () => {
  const { model, render, util } = ui;
  const canvas = await import(pathToFileURL(join(UI, "canvas.js")).href);
  const brush = await import(pathToFileURL(join(UI, "brush.js")).href);
  const doc = blankDoc(220, 200);
  const mk = (o) => (doc.objects.push({ id: util.uid(), type: "membrane", closed: false, fill: "none", seed: 5, ...o }), doc.objects[doc.objects.length - 1]);
  const wave = (x, y, w, a = 8) => [[x, y], [x + w * 0.33, y - a * MMpx], [x + w * 0.66, y + a * MMpx], [x + w, y]];
  const X = (v) => v * MMpx;
  // row 1: path arrows
  const a1 = mk({ brush: "arrow", name: "Path arrow", pts: wave(X(8), X(18), X(45)), thickness: 2.5, startHead: "none", endHead: "arrow" });
  mk({ brush: "arrow", pts: wave(X(62), X(18), X(45)), thickness: 3, startHead: "bar", endHead: "open", dash: "dash", palette: { line: "#c0392b" } });
  mk({ brush: "arrow", pts: [[X(118), X(26)], [X(128), X(8)], [X(146), X(10)], [X(150), X(26)]], thickness: 1.5, startHead: "dot", endHead: "diamond", headScale: 1.4, palette: { line: "#2f6db5" } });
  mk({ brush: "arrow", pts: [[X(165), X(8)], [X(195), X(10)], [X(200), X(28)], [X(170), X(28)]], closed: true, thickness: 2, endHead: "arrow", palette: { line: "#5b6675" } });
  // presets: circular arrows and a plasmid map
  doc.objects.push(...canvas.presetObjects("circular", { x: X(10), y: X(40), w: X(30), h: X(30) }));
  doc.objects.push(...canvas.presetObjects("circular", { x: X(48), y: X(44), w: X(44), h: X(24) }));
  const plasmid = canvas.presetObjects("plasmid", { x: X(100), y: X(34), w: X(60), h: X(60) })[0];
  doc.objects.push(plasmid);
  // freeform shapes
  const f1 = mk({ brush: "freeform", closed: true, pts: [[X(168), X(45)], [X(190), X(38)], [X(212), X(50)], [X(206), X(72)], [X(180), X(76)], [X(166), X(62)]], thickness: 1.5, fill: "#d9ecf7", fillOpacity: 1, stroke: "#1d6fa5" });
  mk({ brush: "freeform", closed: true, pts: [[X(12), X(84)], [X(40), X(78)], [X(60), X(92)], [X(36), X(104)], [X(14), X(98)]], thickness: 2, fill: "#f2b83d", fillOpacity: 0.35, stroke: "#b08a12", dash: "dash" });
  mk({ brush: "freeform", closed: true, pts: [[X(66), X(84)], [X(92), X(80)], [X(96), X(100)], [X(70), X(104)]], thickness: 0, fill: "#b07cd1", fillOpacity: 0.6, stroke: "none" });
  // blood vessels: open, thin, a closed loop
  const v1 = mk({ brush: "vessel", pts: [[X(10), X(125)], [X(45), X(112)], [X(80), X(128)], [X(115), X(115)]], thickness: 40, seed: 3 });
  mk({ brush: "vessel", pts: [[X(125), X(112)], [X(150), X(122)], [X(175), X(112)], [X(210), X(118)]], thickness: 18, seed: 8 });
  // axons
  const ax1 = mk({ brush: "axon", pts: [[X(10), X(160)], [X(60), X(150)], [X(110), X(165)], [X(150), X(152)]], thickness: 18 });
  mk({ brush: "axon", pts: [[X(160), X(150)], [X(185), X(160)], [X(210), X(150)]], thickness: 9, spacing: 0.7, palette: { myelin: "#fff6e0", sheath: "#c9a35d", axon: "#e98a8f" } });
  mk({ brush: "vessel", pts: [[X(20), X(178)], [X(55), X(172)], [X(90), X(186)], [X(55), X(196)], [X(22), X(192)]], closed: true, thickness: 12, seed: 4 });
  mk({ brush: "axon", pts: [[X(120), X(176)], [X(160), X(172)], [X(200), X(188)], [X(160), X(196)], [X(124), X(192)]], closed: true, thickness: 10 });

  // checks
  const svg = render.documentSvg(doc);
  check(!/NaN|undefined/.test(svg), "no NaN/undefined in the markup");
  const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
  check(ids.length === new Set(ids).size, "no duplicate ids");
  for (const k of ["arrow", "freeform", "vessel", "axon"]) {
    const o = doc.objects.find((x) => x.brush === k);
    const hit = render.contentMarkup(o, doc, true);
    check(hit.includes('class="hit"'), `${k}: has a hit area`);
    check(brush.brushPad(o) >= (o.thickness ?? brush.BRUSHES[k].T) / 2, `${k}: bounds pad covers the drawing`);
  }
  {
    // an arrow's bounds include its heads
    const b = model.bbox(a1), s = 2.5 * 4.2;
    check(b.x <= a1.pts[0][0] - 1 && b.x + b.w >= a1.pts[3][0] + 1 && b.h >= 16 * MMpx, "path arrow: bounds around the path and heads", JSON.stringify(b));
    void s;
  }
  check(plasmid.type === "group" && plasmid.children.filter((c) => c.brush === "arrow").length === 5 && plasmid.children.filter((c) => c.type === "text").length === 6, "plasmid: backbone, four features, six labels in a group");
  const back = plasmid.children[0];
  check(back.closed && back.endHead === "none", "plasmid backbone: a closed ring");
  const circ = doc.objects.find((o) => o.name === "Circular arrow");
  {
    const cx = X(25), cy = X(55), r = X(15);
    const poly = brush.smoothPolyline(circ.pts, false, 12);
    const dev = Math.max(...poly.map(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r)));
    const sweep = (() => {
      const a0 = Math.atan2(circ.pts[0][1] - cy, circ.pts[0][0] - cx), a1 = Math.atan2(circ.pts.at(-1)[1] - cy, circ.pts.at(-1)[0] - cx);
      return 360 - ((((a0 - a1) * 180) / Math.PI + 360) % 360);
    })();
    check(dev < r * 0.01 && Math.abs(sweep - 300) < 1, `circular arrow: a 300° arc (sweep ${sweep.toFixed(1)}°, max off-circle ${(dev / r * 100).toFixed(2)}%)`);
  }
  // transforms and copies
  const fc = model.cloneObj(f1);
  model.scaleObjAbout(fc, 0, 0, 2, 2);
  model.rotateObjAbout(fc, 0, 0, 30);
  model.flipObj(fc, "h");
  check(fc.id !== f1.id && fc.pts.length === f1.pts.length && fc.closed, "freeform: copy, scale, rotate, flip");
  const gb = model.bbox(plasmid);
  model.moveObj(plasmid, 10, 5);
  const gb2 = model.bbox(plasmid);
  check(near(gb2.x - gb.x, 10) && near(gb2.y - gb.y, 5), "plasmid group moves as one");
  model.moveObj(plasmid, -10, -5);
  void v1;
  void ax1;
  // a closed outline for connectors: a freeform shape's outline is its curve
  check(model.outline(f1).length > 20, "freeform shape: curved outline for connectors");

  doc.objects.push(text("path arrows (heads, dash, colour, closed)", X(110), X(3), 8), text("circular arrows · plasmid map · freeform shapes", X(110), X(33), 8), text("blood vessels", X(110), X(105), 8), text("myelinated axons · closed vessel and axon loops", X(110), X(143), 8));
  const out = render.documentSvg(doc);
  console.log("  wrote " + (await png(out, join(OUT, "brushes.png"), 150)));
  console.log("  wrote " + (await png(render.documentSvg(doc, { background: "#000000" }), join(OUT, "brushes-dark.png"), 96)));
  for (const format of ["pdf", "tiff"]) {
    try {
      const r = await api("export", { format, svg: out, dpi: 150 });
      check(r.base64.length > 1000, `${format} export with the new brushes`);
    } catch (err) {
      check(false, `${format} export with the new brushes`, err.message);
    }
  }
  // the brush picker previews render too
  const prev = ["arrow", "freeform", "vessel", "axon"].map((k) => brush.brushMarkup({ type: "membrane", brush: k, pts: [[6, 22], [28, 16], [52, 22], [76, 16]], thickness: 10, closed: k === "freeform", seed: 4, fill: "#d9ecf7", stroke: "#1d6fa5", endHead: "arrow" }, false));
  check(prev.every((s) => s.length > 50 && !/NaN/.test(s)), "picker previews draw");
};

/** Legends, scale bars and panel labels: building, editing, geometry, copies, undo and export. */
SCEN.furniture = async () => {
  const { model, render, actions, furniture: F, color } = ui;
  const T = "nih/509-t-cell", MAC = "biocanvas/macrophage", B = "biocanvas/b-cell", NEU = "biocanvas/neutrophil", FIB = "biocanvas/fibroblast";
  const doc = blankDoc(200, 150);
  await styleAssets(doc, [T, MAC, B, NEU, FIB]);
  const S = 22 * MMpx, X = (v) => v * MMpx;
  const A = (id) => doc.assets[id];
  // a figure: two plain T cells (one row), a red T cell (its own row), a macrophage, a grouped B cell,
  // a neutrophil brush, a hidden fibroblast (left out)
  const t1 = iconObj(T, A(T), X(20), X(25), S), t2 = iconObj(T, A(T), X(45), X(25), S);
  t2.rot = 30; // turning doesn't change what it is
  const t3 = iconObj(T, A(T), X(70), X(25), S);
  t3.colors = color.overlayMap(A(T).slots, "#d33b3b");
  t3.tint = "#d33b3b";
  t3.name = "Activated T cell";
  const mac = iconObj(MAC, A(MAC), X(95), X(25), S);
  const bc = iconObj(B, A(B), X(120), X(25), S);
  const grp = { id: ui.util.uid(), type: "group", name: "Group", children: [bc, text("B", X(120), X(38), 8)] };
  const brush = { id: ui.util.uid(), type: "membrane", brush: "icon", asset: NEU, colors: {}, slotColors: [], name: "Neutrophil (brush)", pts: [[X(140), X(30)], [X(160), X(18)], [X(185), X(28)]], closed: false, thickness: 26, seed: 3 };
  const hid = { ...iconObj(FIB, A(FIB), X(20), X(60), S), hidden: true };
  doc.objects.push(t1, t2, t3, mac, grp, brush, hid);
  model.resetHistory();

  // ---- legend rows from the figure
  const rows = F.figureLegendRows();
  check(rows.length === 5, "legend: one row per different icon (5)", rows.map((r) => r.label).join(", "));
  check(rows.map((r) => r.asset).join() === [T, T, MAC, B, NEU].join(), "legend: rows in the order the icons were added, groups and brushes included");
  check(rows[1].label === "Activated T cell" && rows[4].label === "Neutrophil", "legend: rows named after the object (brush suffix dropped)", rows.map((r) => r.label).join(" | "));
  check(!rows.some((r) => r.asset === FIB), "legend: hidden icons left out");
  check(F.legendKey(T, { "#AABBCC": "#112233", "#ffffff": "#FFFFFF" }) === F.legendKey(T, { "#aabbcc": "#112233" }), "legend: colour maps compared case-blind, unchanged colours ignored");
  check(JSON.stringify(rows[1].colors) === JSON.stringify(t3.colors), "legend: a row keeps the icon's colours");

  // ---- insert: centred, selected, one undo step
  const lg = F.insertLegend([X(150), X(100)]);
  check(lg.type === "legend" && lg.rows.length === 5 && model.state.selection[0] === lg.id, "insert legend: a legend of the figure's icons, selected");
  check(Math.abs(lg.x + lg.w / 2 - X(150)) < 0.01 && Math.abs(lg.y + lg.h / 2 - X(100)) < 0.01, "insert legend: centred on the view centre");
  check(lg.w > 50 && lg.h > lg.rows.length * 20, "insert legend: sized to its rows", `${lg.w.toFixed(1)}×${lg.h.toFixed(1)}`);
  model.undo();
  check(!model.state.doc.objects.some((o) => o.type === "legend"), "insert legend: one undo removes it");
  model.redo();
  const L1 = model.state.doc.objects.find((o) => o.type === "legend");
  check(!!L1 && L1.rows.length === 5, "insert legend: redo puts it back");
  // inserting again at the same spot steps down and right instead of covering the first one
  const lgAgain = F.insertLegend([X(150), X(100)]);
  check(Math.abs(lgAgain.x + lgAgain.w / 2 - X(156)) < 0.01 && Math.abs(lgAgain.y + lgAgain.h / 2 - X(106)) < 0.01, "insert legend again: 6 mm down and right of the first");
  model.undo();
  const sbA = F.insertScaleBar([X(40), X(130)]), sbB = F.insertScaleBar([X(40), X(130)]);
  check(sbA.type === "scalebar" && model.state.selection[0] === sbB.id && Math.abs(sbB.x - sbA.x - X(6)) < 0.01 && Math.abs(sbB.y - sbA.y - X(6)) < 0.01, "insert scale bar: selected; a second one steps down and right");
  model.undo();
  model.undo();
  check(!model.state.doc.objects.some((o) => o.type === "scalebar") && model.state.doc.objects.filter((o) => o.type === "legend").length === 1, "insert scale bar: one undo step each");

  // ---- natural layout = box; markup; hit area
  const lay = render.legendLayout(L1);
  check(Math.abs(lay.w - L1.w) < 1e-6 && Math.abs(lay.h - L1.h) < 1e-6, "legend: box = its content's size");
  const labelEnd = (i) => lay.cells[i].x + lay.S + lay.gap + L1.rows[i].label.length * L1.fontSize * 0.55; // (the stub's text width)
  const lastEnd = Math.max(...L1.rows.map((r, i) => labelEnd(i)));
  check(lastEnd < L1.w - 0.1 * L1.fontSize && lastEnd > L1.w - 0.2 * L1.fontSize, "legend: the longest label ends a little inside the box", `${lastEnd.toFixed(2)} in ${L1.w.toFixed(2)}`);
  const mk = render.contentMarkup(L1, doc, true);
  check(mk.includes(`id="${L1.id}-r0-`) || !A(T).svg.includes('id="'), "legend: icon ids prefixed per row (no clashes with the figure)");
  check(mk.includes('class="hit"') && !/NaN|undefined/.test(mk), "legend: hit area, no NaN");
  check((mk.match(/<text /g) || []).length === 5, "legend: one label per row");
  check(render.legendRowAt(L1, [L1.x + lay.cells[2].x + 4, L1.y + lay.cells[2].y + lay.cells[2].h / 2]) === 2, "legend: double-click finds the row under the pointer");
  check(render.legendRowAt(L1, [L1.x - 50, L1.y - 50]) === -1, "legend: no row outside it");

  // ---- columns, title, frame
  const L2 = F.newLegend(JSON.parse(JSON.stringify(rows)));
  const w1 = L2.w, h1 = L2.h;
  Object.assign(L2, { columns: 2, title: "Cell types", border: "#9aa5b1", fill: "#f6f8fa" });
  render.fitFurniture(L2);
  check(L2.w > w1 && L2.h < h1, "legend: two columns are wider and shorter", `${w1.toFixed(0)}×${h1.toFixed(0)} → ${L2.w.toFixed(0)}×${L2.h.toFixed(0)}`);
  check(render.legendLayout(L2).cells[3].x > render.legendLayout(L2).cells[0].x, "legend: rows fill the first column, then the next");
  // extra rows: colour square and arrows
  L2.rows.push(...F.EXTRA_ROWS.map(([, r]) => JSON.parse(JSON.stringify(r))));
  render.fitFurniture(L2);
  const mk2 = render.contentMarkup(L2, doc, false);
  check(mk2.includes('fill="#4aa9d0"') && (mk2.match(/<path/g) || []).length >= 3 && !/NaN/.test(mk2), "legend: colour square and arrow rows draw");

  // ---- editing keeps the top-left corner (also when turned)
  const ed = model.cloneObj(L1);
  ed.rot = 40;
  const at = render.furnitureAnchor(ed);
  const c0 = model.corners(ed)[0];
  ed.rows.splice(1, 1);
  ed.rows[0].label = "A much longer label for the first row";
  render.fitFurniture(ed, at);
  const c1 = model.corners(ed)[0];
  check(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) < 1e-6, "legend edit: the top-left corner stays put (turned 40°)");

  // ---- geometry: move, scale, rotate, flip
  const g = model.cloneObj(L1), b0 = model.bbox(g);
  model.moveObj(g, 10, -5);
  check(Math.abs(g.x - L1.x - 10) < 1e-9 && Math.abs(g.y - L1.y + 5) < 1e-9, "legend: moves");
  const fs0 = g.fontSize, is0 = g.iconSize, w0 = g.w;
  model.scaleObjAbout(g, g.x, g.y, 2, 2);
  check(Math.abs(g.fontSize - 2 * fs0) < 1e-9 && Math.abs(g.iconSize - 2 * is0) < 1e-9 && Math.abs(g.w - 2 * w0) < 1e-6, "legend: scaling scales its text and icons");
  check(Math.abs(render.legendLayout(g).w - g.w) < 1e-6, "legend: still its content's size after scaling");
  model.scaleObjAbout(g, 0, 0, 0.5, 3); // uneven: scales evenly
  check(Math.abs(g.w / g.h - w0 / L1.h) < 1e-6, "legend: uneven scaling keeps its proportions");
  model.rotateObjAbout(g, 0, 0, 90);
  check(g.rot === 90, "legend: turns");
  model.flipObj(g, "h");
  check(!g.flipX && !g.flipY && g.rot === 270, "legend: flipping mirrors its place, never its text");
  void b0;

  // ---- copy, paste, duplicate; credits
  model.setSelection([L1.id]);
  actions.copySel();
  actions.pasteClip(10);
  const pasted = model.state.doc.objects.at(-1);
  check(pasted.type === "legend" && pasted.id !== L1.id && JSON.stringify(pasted.rows) === JSON.stringify(L1.rows), "legend: copy and paste");
  actions.duplicateSel();
  const dup = model.state.doc.objects.at(-1);
  check(dup.type === "legend" && dup.id !== pasted.id && Math.abs(dup.x - pasted.x - 12) < 1e-9, "legend: duplicate");
  // the Transform panel's W field scales it evenly about its centre (keep proportions or not)
  model.setSelection([L1.id]);
  const tx0 = L1.x + L1.w / 2, ty0 = L1.y + L1.h / 2, tfs = L1.fontSize, th0 = L1.h;
  actions.transformSel("w", L1.w * 1.5, false);
  const Lt = model.getObj(L1.id);
  check(Math.abs(Lt.fontSize - tfs * 1.5) < 1e-9 && Math.abs(Lt.h - th0 * 1.5) < 1e-6 && Math.abs(Lt.x + Lt.w / 2 - tx0) < 1e-6 && Math.abs(Lt.y + Lt.h / 2 - ty0) < 1e-6, "legend: Transform W scales it evenly about its centre");
  model.undo();
  const only = [model.cloneObj(L1)];
  check([...model.assetsUsed(only)].sort().join() === [T, MAC, B, NEU].sort().join(), "legend: its icons count for credits and saving");

  // ---- scale bars
  const sb = F.newScaleBar();
  check(render.scaleLabel(sb) === "10 µm", "scale bar: 10 µm by default");
  const sl = render.scalebarLayout(sb);
  check(Math.abs(sl.bar.w - 15 * MMpx) < 1e-9 && Math.abs(sb.w - Math.max(sl.bar.w, 0)) < 1e-6 && sl.bar.y > 0, "scale bar: a 15 mm bar under its label");
  sb.x = X(50);
  sb.y = X(50);
  sb.rot = 30;
  const barMid = () => render.furnitureAnchor(sb);
  const m0 = barMid();
  const at2 = render.furnitureAnchor(sb);
  Object.assign(sb, { value: 250, unit: "nm", length: 4 * MMpx });
  render.fitFurniture(sb, at2);
  const m1 = barMid();
  check(render.scaleLabel(sb) === "250 nm" && Math.hypot(m1[0] - m0[0], m1[1] - m0[1]) < 1e-6, "scale bar: new value and shorter bar keep the bar's middle in place");
  check(sb.w > sb.length, "scale bar: a label wider than the bar widens the box");
  for (const pos of ["above", "below", "none"]) {
    const s = { ...F.newScaleBar(), labelPos: pos };
    render.fitFurniture(s);
    const l = render.scalebarLayout(s);
    const ok = pos === "above" ? l.bar.y > 0 && l.labelY === 0 : pos === "below" ? l.bar.y === 0 && l.labelY > l.bar.h : l.labelY == null && Math.abs(s.h - s.thickness) < 1e-9;
    check(ok, `scale bar: label ${pos}`);
  }
  check(sb.value === 250 && Number.isFinite(F.newScaleBar().value), "scale bar: value kept");
  const sc = model.cloneObj(sb);
  model.scaleObjAbout(sc, 0, 0, 0.5, 0.5);
  check(Math.abs(sc.thickness - sb.thickness / 2) < 1e-9 && Math.abs(sc.length - sb.length / 2) < 1e-9 && Math.abs(sc.fontSize - sb.fontSize / 2) < 1e-9, "scale bar: scaling scales bar and text");
  model.flipObj(sc, "v");
  check(!sc.flipX && !sc.flipY, "scale bar: never mirrored");
  const sbm = render.contentMarkup(sb, doc, true);
  check(sbm.includes("250 nm") && sbm.includes('class="hit"') && !/NaN/.test(sbm), "scale bar: markup with label and hit area");

  // ---- panel labels
  check([0, 1, 25, 26, 27, 51, 52, 701].every((i) => F.letterIndex(F.letterAt(i)) === i) && F.letterAt(0) === "A" && F.letterAt(26) === "AA" && F.letterAt(2, false) === "c", "panel labels: letters A…Z, AA… and back");
  check(F.letterIndex("(b)") === 1 && F.letterIndex("C.") === 2 && F.letterIndex("12") === -1, "panel labels: reads (b) and C.");
  const d3 = blankDoc(178, 120);
  const box = (x, y, w, h) => ({ id: ui.util.uid(), type: "rect", x: X(x), y: X(y), w: X(w), h: X(h), rot: 0, fill: "#eef3f8", stroke: "#9aa5b1", strokeWidth: 1, radius: 0 });
  // a 2 × 2 grid, slightly uneven, given out of order
  const p = { d: box(92, 63, 80, 50), a: box(6, 8, 80, 50), c: box(6, 62, 80, 52), b: box(92, 10, 80, 48) };
  d3.objects.push(p.d, p.a, p.c, p.b);
  model.resetHistory();
  model.setSelection([p.d.id, p.a.id, p.c.id, p.b.id]);
  const order = F.panelTargets().map((t) => t.o.id);
  check(order.join() === [p.a, p.b, p.c, p.d].map((o) => o.id).join(), "panel labels: reading order (top row first, left to right)");
  const made = F.addPanelLabels({ upper: true, size: 14, place: "inside", start: F.nextPanelIndex() });
  check(made.map((t) => t.text).join("") === "ABCD" && made.every((t) => t.type === "text" && t.bold && t.panelLabel), "panel labels: bold A–D as text objects");
  // each label at its object's left edge and the top of its row (the rows' tops differ by less than a label)
  const rowTop = [p.a.y, p.a.y, p.c.y, p.c.y];
  check(made.every((t, i) => { const b = model.bbox([p.a, p.b, p.c, p.d][i]); return Math.abs(t.x - b.x) < 1e-6 && Math.abs(t.y - rowTop[i]) < 1e-6; }), "panel labels: at each object's top-left corner, level along a row");
  check(Math.abs(made[0].fontSize * 0.75 - 14) < 1e-9, "panel labels: 14 pt");
  check(model.state.selection.join() === made.map((t) => t.id).join(), "panel labels: the new labels are selected");
  model.undo();
  check(!model.state.doc.objects.some((o) => o.panelLabel), "panel labels: one undo step");
  model.redo();
  check(F.nextPanelIndex() === 4, "panel labels: the next run continues at E");
  model.setSelection([p.c.id, p.d.id]);
  const above = F.addPanelLabels({ upper: false, size: 10, place: "above", start: F.nextPanelIndex() });
  check(above.map((t) => t.text).join("") === "ef" && above.every((t, i) => t.y + t.h < model.bbox([p.c, p.d][i]).y), "panel labels: lower case, above the corner");
  const edge = box(40, 2, 30, 20); // 2 mm from the top of the page
  d3.objects.push(edge);
  model.setSelection([edge.id]);
  const top = F.addPanelLabels({ place: "above", start: 0 })[0];
  check(Math.abs(top.y - edge.y) < 1e-6, "panel labels: no room above → inside the corner");
  model.setSelection([]);
  const one = F.addPanelLabels({ start: 7 }, F.panelTargets(), [X(90), X(60)])[0];
  check(one.text === "H" && Math.abs(one.x + one.w / 2 - X(90)) < 1e-6, "panel labels: nothing selected → one label at the view centre");
  const one2 = F.addPanelLabels({}, [], [X(90), X(60)])[0];
  check(one2.text === "I" && Math.abs(one2.x + one2.w / 2 - X(96)) < 1e-6 && Math.abs(one2.y + one2.h / 2 - X(66)) < 1e-6, "panel labels: the next one at the same spot steps down and right");
  model.setSelection(made.map((t) => t.id));
  check(F.panelTargets().length === 0, "panel labels: labels aren't labelled again");
  // a row whose second object starts well below the row's top: that label stays at its own corner
  const tall = box(10, 10, 40, 60), low = box(60, 30, 30, 20);
  d3.objects.push(tall, low);
  model.setSelection([low.id, tall.id]);
  const [lt, ll] = F.addPanelLabels({ place: "inside", start: 0 });
  check(lt.text === "A" && Math.abs(lt.y - tall.y) < 1e-6 && Math.abs(ll.y - low.y) < 1e-6 && Math.abs(ll.x - low.x) < 1e-6, "panel labels: an object well below its row's top keeps its own corner");

  // ---- a sheet to look at, and the exporters
  const sheet = blankDoc(200, 150);
  Object.assign(sheet.assets, doc.assets);
  const s1 = model.cloneObjs([t1, t2, t3, mac, grp, brush]);
  sheet.objects.push(...s1);
  const lgA = F.newLegend(F.figureLegendRows(s1, sheet));
  Object.assign(lgA, { x: X(8), y: X(48) });
  const lgB = F.newLegend([...F.figureLegendRows(s1, sheet).slice(0, 4), ...F.EXTRA_ROWS.map(([, r]) => JSON.parse(JSON.stringify(r)))]);
  Object.assign(lgB, { columns: 2, title: "Key", border: "#9aa5b1", fill: "#f6f8fa", fontSize: 11 });
  render.fitFurniture(lgB);
  Object.assign(lgB, { x: X(62), y: X(48) });
  const bars = ["above", "below", "none"].map((pos, i) => {
    const s = Object.assign(F.newScaleBar(), { labelPos: pos, value: [10, 500, 1][i], unit: ["µm", "nm", "mm"][i], thickness: [3, 2, 4][i] });
    render.fitFurniture(s);
    Object.assign(s, { x: X(18 + i * 30) - s.w / 2, y: X(118) });
    return s;
  });
  const turned = Object.assign(F.newScaleBar(), { rot: 90, color: "#c0392b", value: 50 });
  render.fitFurniture(turned);
  Object.assign(turned, { x: X(105) - turned.w / 2, y: X(120) - turned.h / 2 });
  sheet.objects.push(lgA, lgB, ...bars, turned);
  model.state.doc = sheet;
  model.setSelection(s1.slice(0, 4).map((o) => o.id));
  F.addPanelLabels({ upper: true, size: 12, place: "above", start: 0 });
  sheet.objects.push(text("legend from the figure · 2 columns, title, frame, extra rows · scale bars: above, below, none, turned", X(100), X(143), 8));
  const svg = render.documentSvg(sheet);
  console.log("  wrote " + (await png(svg, join(OUT, "furniture.png"), 150)));
  for (const format of ["pdf", "tiff", "svg"]) {
    try {
      const r = await api("export", { format, svg, dpi: 150 });
      check(r.base64.length > 1000, `${format} export with legends, scale bars and panel labels`);
    } catch (err) {
      check(false, `${format} export with legends, scale bars and panel labels`, err.message);
    }
  }
  // an old figure without the new types still renders the same way
  const old = blankDoc(50, 50);
  old.objects.push(text("old", X(25), X(25), 9));
  check(!/legend|scalebar/.test(render.documentSvg(old)), "old figures unchanged");
};

/** Shape colour styles (Presets / quick toolbar Style) and resizing brushes as a whole or path only. */
SCEN.shapes = async () => {
  const { model } = ui;
  const SS = await import(pathToFileURL(join(UI, "shapestyle.js")).href);
  const P = SS.SHAPE_PRESETS;
  check(P.length >= 30 && new Set(P.map((p) => p.id)).size === P.length, `${P.length} shape styles with unique ids`);
  const rect = { id: "r", type: "rect", x: 0, y: 0, w: 120, h: 70, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5, radius: 6 };
  const ell = { id: "e", type: "ellipse", x: 0, y: 0, w: 80, h: 80, rot: 0, fill: "#fde7c8", stroke: "#c76b1f", strokeWidth: 1.5 };
  const blob = { id: "f", type: "membrane", brush: "freeform", pts: [[0, 0], [60, -10], [110, 20], [50, 80]], thickness: 1.5, closed: true, fill: "#d9ecf7", stroke: "#1d6fa5" };
  check([rect, ell, blob].every(SS.isShape) && !SS.isShape({ type: "membrane", brush: "dna", pts: [] }), "isShape: rect, ellipse and freeform; not pattern brushes");
  const bad = [];
  for (const p of P) for (const o of [rect, ell, blob]) if ((SS.applyShapePreset(o, p), SS.currentShapePreset(o)) !== p.id) bad.push(o.type + ":" + p.id);
  check(!bad.length, "every style round-trips (apply → current) on rect, ellipse and freeform", bad.join(" "));
  const bare = { ...rect, stroke: "none", strokeWidth: 0 };
  SS.applyShapePreset(bare, P.find((p) => p.id === "teal-outline"));
  check(bare.fill === "none" && bare.strokeWidth === 1.5, "an outline style gives an outline-less shape a width");
  SS.applyShapePreset(bare, P.find((p) => p.dash));
  check(bare.dash === "dash", "a dashed region style sets dashes");
  SS.applyShapePreset(bare, P[0]);
  check(bare.dash === undefined, "a solid style clears the dashes");
  check(/<rect[^>]+rx=/.test(SS.shapeThumb(rect, P[0])) && /<ellipse/.test(SS.shapeThumb(ell, P[0])) && /<path d="M/.test(SS.shapeThumb(blob, P[0])), "thumbnails draw the shape itself");
  // brushes: the corner handles scale the pattern with the path; Alt (keepPattern) only the path
  const mk = (kind, T) => ({ id: kind, type: "membrane", brush: kind, pts: [[0, 0], [100, -20], [200, 0]], thickness: T, closed: false, fill: "none" });
  const dna = mk("dna", 22), keep = mk("dna", 22), arrow = mk("arrow", 2.5), ff = { ...blob, thickness: 1.5 };
  for (const o of [dna, arrow, ff]) model.scaleObjAbout(o, 0, 0, 0.5, 0.5);
  model.scaleObjAbout(keep, 0, 0, 0.5, 0.5, true);
  check(dna.thickness === 11 && dna.pts[2][0] === 100, "brush scaled to 50%: path and pattern both halve");
  check(keep.thickness === 22 && keep.pts[2][0] === 100, "Alt: only the path halves, the pattern keeps its size");
  check(arrow.thickness === 2.5 && ff.thickness === 1.5, "path arrows and freeform outlines keep their line width");
  const bil = { ...mk("bilayer", 16), headR: 3 };
  model.scaleObjAbout(bil, 0, 0, 2, 2);
  check(bil.thickness === 32 && bil.headR === 6, "a bilayer's own head size scales with it");
  const grp = { id: "g", type: "group", children: [mk("icon", 40)] };
  model.scaleObjAbout(grp, 0, 0, 0.5, 0.5, true);
  check(grp.children[0].thickness === 40, "groups pass keepPattern on");
  model.scaleObjAbout(grp, 0, 0, 2, 0.5);
  check(grp.children[0].thickness === 40, "non-uniform 2 × 0.5 scales the pattern by their geometric mean (1)");
  check(model.isPatternBrush(grp) && !model.isPatternBrush(arrow) && !model.isPatternBrush(ff), "isPatternBrush: groups with brushes yes; path arrows and freeform shapes no");
};

/**
 * Side panels (layout.js): open / collapsed, Focus mode, widths and their limits, the narrow-window
 * auto-collapse and the remembered state, in a pretend window (the page itself: tools/dev/shots/panels.js).
 */
SCEN.panels = async () => {
  const root = { style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, dataset: {} };
  document.documentElement = root;
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const resizers = [], addEv = globalThis.addEventListener;
  globalThis.addEventListener = (t, f) => (t === "resize" ? resizers.push(f) : addEv(t, f));
  globalThis.requestAnimationFrame ||= (f) => setTimeout(f, 0);
  globalThis.cancelAnimationFrame ||= (t) => clearTimeout(t);
  const win = async (w) => {
    globalThis.innerWidth = w;
    resizers.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 5));
  };
  const W0 = globalThis.innerWidth;
  globalThis.innerWidth = 1400;
  try {
    const L = await import(pathToFileURL(join(UI, "layout.js")).href);
    const saved = () => JSON.parse(store.get("biocraft.panels") || "null");
    const w = (k) => root.style.props[`--${k}-w`];
    L.initLayout();
    check(L.panelOpen("library") && L.panelOpen("inspector") && !root.dataset.library && !root.dataset.inspector, "both panels open at first");
    check(w("library") === "330px" && w("inspector") === "300px", "usual widths 330 and 300 px", `${w("library")} ${w("inspector")}`);
    L.togglePanel("library");
    check(root.dataset.library === "collapsed" && !L.panelOpen("library") && saved()?.library.open === false, "toggling collapses the library and remembers it");
    L.toggleFocus();
    check(L.focusMode() && root.dataset.inspector === "collapsed" && saved()?.before?.inspector === true, "Focus mode collapses both, remembering what was open");
    L.toggleFocus();
    check(!L.panelOpen("library") && L.panelOpen("inspector") && !L.focusMode(), "leaving Focus mode opens what was open before (the inspector only)");
    L.resetPanels();
    L.toggleFocus();
    L.toggleFocus();
    check(L.panelOpen("library") && L.panelOpen("inspector"), "Focus mode from both open and back: both open");
    L.setPanelWidth("library", 9999);
    check(w("library") === "560px", "library at most 560 px", w("library"));
    L.setPanelWidth("library", 10);
    check(w("library") === "220px", "library at least 220 px", w("library"));
    L.setPanelWidth("inspector", 9999);
    check(w("inspector") === "480px", "inspector at most 480 px", w("inspector"));
    L.setPanelWidth("inspector", 0);
    check(w("inspector") === "240px", "inspector at least 240 px", w("inspector"));
    L.resetPanels();
    await win(1200);
    L.setPanelWidth("library", 9999);
    check(w("library") === "540px", "the canvas keeps 360 px: library up to 1200 − 360 − 300", w("library"));
    L.setPanelWidth("library", 400);
    await win(1000);
    check(root.dataset.inspector === "collapsed" && saved()?.inspector.open === true, "a narrow window collapses the inspector without changing the saved choice");
    check(w("library") === "400px", "…and the library keeps its width beside the rail", w("library"));
    await win(1300);
    check(!root.dataset.inspector && L.panelOpen("inspector"), "wide again: the inspector comes back");
    await win(1000);
    L.togglePanel("inspector");
    check(L.panelOpen("inspector") && !root.dataset.inspector, "in a narrow window the inspector opens on demand");
    check(w("library") === "355px" && w("inspector") === "285px", "…and both panels narrow (to their minimum at most) to leave the canvas 360 px", `${w("library")} ${w("inspector")}`);
    await win(1300);
    check(L.panelOpen("inspector") && w("library") === "400px" && w("inspector") === "300px", "wide again: the chosen widths come back");
    await win(1000);
    L.toggleFocus();
    check(L.focusMode(), "Focus mode in a narrow window");
    L.toggleFocus();
    check(L.panelOpen("library") && !L.panelOpen("inspector") && saved()?.inspector.open === true, "…and back: the inspector is collapsed by the window again, not switched off");
    await win(1300);
    check(L.panelOpen("inspector"), "…so it opens when the window is wide");
    L.toggleFocus();
    L.togglePanel("library");
    check(!L.focusMode() && saved()?.before === null, "Focus mode left by opening a panel: nothing left to bring back");
    L.resetPanels();
    // a saved state, including nonsense, loads with its limits
    store.set("biocraft.panels", JSON.stringify({ library: { width: 999, open: false }, inspector: { width: "wide", open: true }, before: "x" }));
    L.initLayout();
    check(!L.panelOpen("library") && L.panelOpen("inspector") && w("inspector") === "300px", "a saved state loads (bad values fall back to the defaults)", w("inspector"));
    L.togglePanel("library");
    check(w("library") === "560px", "a saved width loads within its limits", w("library"));
    store.delete("biocraft.panels");
    L.initLayout();
    check(L.panelOpen("library") && L.panelOpen("inspector") && w("library") === "330px", "nothing saved (or no storage): the defaults");
  } finally {
    globalThis.innerWidth = W0;
    globalThis.addEventListener = addEv;
    delete globalThis.localStorage;
  }
};

/* ---------- main ---------- */

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await setup();
  const names = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] || "").startsWith("--"));
  for (const n of names.length ? names : Object.keys(SCEN)) {
    if (!SCEN[n]) {
      console.log(`unknown scenario ${n} (have: ${Object.keys(SCEN).join(", ")})`);
      process.exitCode = 2;
      continue;
    }
    console.log(`# ${n}`);
    try {
      await SCEN[n]();
    } catch (e) {
      check(false, `${n} threw`, e.stack);
    }
  }
  console.log(`\n${passes} passed, ${fails} failed`);
  if (fails) process.exitCode = 1;
}
