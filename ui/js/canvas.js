// The drawing surface: rendering, view (pan/zoom), selection overlay and pointer tools.

import {
  state, getObj, findObj, selectedObjs, setSelection, docPx, isBox, bbox, corners, selectionBox, lineMid,
  moveObj, rotateObjAbout, scaleObjAbout, commit, MM, isElbow, elbowAxis, connectorRefs, outline,
  canConnect, detachConnectors, syncConnectors, cloneObjs, isFurniture, scaleFurniture, isPatternBrush,
} from "./model.js";
import { contentKey, contentMarkup, objTransform, measureText, fontCss, glowFilter, glowId, fitFurniture, legendRowAt } from "./render.js";
import { $, bus, clamp, rotPt, uid, fmtNum, MOD } from "./util.js";
import { BRUSHES, BRUSH_PRESETS, smoothPolyline, arcPts } from "./brush.js";
import { headSize } from "./heads.js";

const SVGNS = "http://www.w3.org/2000/svg";
let stage, viewport, content, overlay, guidesG, paper, paperShadow, grid, wrap;
const cache = new Map(); // id → {g, inner, key}
export const keys = { space: false };

/* ---------- view ---------- */

export function applyView() {
  const { zoom, x, y } = state.view;
  viewport.setAttribute("transform", `translate(${x} ${y}) scale(${zoom})`);
  $("#zoom-label").textContent = Math.round(zoom * 100) + "%";
  placeEditor?.(); // the text being typed stays on its object
  drawOverlay();
  bus.emit("view");
}

export function screenToDoc(cx, cy) {
  const r = stage.getBoundingClientRect();
  const { zoom, x, y } = state.view;
  return [(cx - r.left - x) / zoom, (cy - r.top - y) / zoom];
}
export function docToScreen(x, y) {
  const { zoom, x: vx, y: vy } = state.view;
  return [x * zoom + vx, y * zoom + vy];
}

let fitted = null; // the view fitView() set, until something else moves it
let stageSize = null; // the stage's size the view was last kept in step with

export function fitView() {
  const r = stage.getBoundingClientRect();
  const { w, h } = docPx();
  const margin = 48;
  const zoom = clamp(Math.min((r.width - margin * 2) / w, (r.height - margin * 2 - 24) / h), 0.05, 8);
  state.view = { zoom, x: (r.width - w * zoom) / 2, y: (r.height - 24 - h * zoom) / 2 };
  fitted = { ...state.view };
  applyView();
}

/**
 * The stage changed size (a side panel resized or collapsed, the window resized): a page that was
 * fitted is fitted again, otherwise the point at the centre of the view stays at the centre.
 * Listeners of "layout" (menus and popovers) then follow their buttons.
 */
function stageResized() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  const old = stageSize;
  stageSize = { w, h };
  if (!old || (old.w === w && old.h === h)) return drawOverlay();
  const v = state.view;
  if (fitted && v.zoom === fitted.zoom && v.x === fitted.x && v.y === fitted.y) fitView();
  else {
    v.x += (w - old.w) / 2;
    v.y += (h - old.h) / 2;
    applyView();
  }
  bus.emit("layout");
}

export function zoomAt(factor, cx, cy) {
  const r = stage.getBoundingClientRect();
  cx ??= r.left + r.width / 2;
  cy ??= r.top + r.height / 2;
  const v = state.view;
  const z = clamp(v.zoom * factor, 0.05, 16);
  const px = cx - r.left, py = cy - r.top;
  v.x = px - ((px - v.x) * z) / v.zoom;
  v.y = py - ((py - v.y) * z) / v.zoom;
  v.zoom = z;
  applyView();
}

/** Document point at the centre of the visible area. */
export function viewCenter() {
  const r = stage.getBoundingClientRect();
  return screenToDoc(r.left + r.width / 2, r.top + (r.height - 24) / 2);
}

/* ---------- rendering ---------- */

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function renderDoc() {
  syncConnectors(); // connected line ends follow their objects
  if (!paper) return; // not mounted yet (or running headless in the dev harness)
  const doc = state.doc;
  const { w, h } = docPx(doc);
  for (const r of [paper, paperShadow, grid]) {
    r.setAttribute("width", w);
    r.setAttribute("height", h);
  }
  paper.setAttribute("fill", doc.background || "#ffffff");
  const gs = state.settings.gridSize * MM;
  const pat = $("#grid-pattern");
  pat.setAttribute("width", gs);
  pat.setAttribute("height", gs);
  pat.firstElementChild.setAttribute("d", `M${gs} 0H0V${gs}`);
  pat.firstElementChild.setAttribute("stroke-width", 0.6 / state.view.zoom);
  grid.style.display = state.settings.grid ? "" : "none";

  const seen = new Set();
  doc.objects.forEach((o, i) => {
    let c = cache.get(o.id);
    if (!c) {
      const g = svgEl("g", { class: "obj", "data-id": o.id });
      const inner = svgEl("g");
      g.appendChild(inner);
      c = { g, inner, key: null };
      cache.set(o.id, c);
    }
    const key = contentKey(o);
    if (c.key !== key) {
      c.inner.innerHTML = contentMarkup(o, doc, true);
      c.key = key;
    }
    const t = objTransform(o, doc);
    if (t) c.inner.setAttribute("transform", t);
    else c.inner.removeAttribute("transform");
    if (o.opacity != null && o.opacity < 1) c.g.setAttribute("opacity", o.opacity);
    else c.g.removeAttribute("opacity");
    // glow: a filter on the outer group (drawing the object over its glow), its region following the
    // object's bounds; exports draw the same picture as a filtered copy under the object (objectMarkup)
    const fx = o.glow && !o.hidden ? glowFilter(o, true) : "";
    if (fx !== (c.fx || "")) {
      if (fx) {
        if (!c.defs) c.defs = c.g.insertBefore(svgEl("defs"), c.inner);
        c.defs.innerHTML = fx;
        c.g.setAttribute("filter", `url(#${glowId(o)})`);
      } else {
        c.defs?.remove();
        c.defs = null;
        c.g.removeAttribute("filter");
      }
      c.fx = fx;
    }
    c.g.classList.toggle("locked", !!o.locked);
    c.g.style.display = o.hidden ? "none" : "";
    if (content.children[i] !== c.g) content.insertBefore(c.g, content.children[i] || null);
    seen.add(o.id);
  });
  for (const [id, c] of cache) {
    if (!seen.has(id)) {
      c.g.remove();
      cache.delete(id);
    }
  }
  drawOverlay();
}

let rafPending = false;
export function renderSoon() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderDoc();
  });
}

/* ---------- overlay ---------- */

const HS = 8; // handle size, px

function handle(x, y, h, cls = "handle", cursor = "") {
  if (cls.includes("rot") || cls.includes("pt") || cls.includes("curve")) {
    return svgEl("circle", { class: cls, cx: x, cy: y, r: cls.includes("rot") ? 5.5 : 5, "data-h": h, style: cursor ? `cursor:${cursor}` : "" });
  }
  return svgEl("rect", { class: cls, x: x - HS / 2, y: y - HS / 2, width: HS, height: HS, rx: 1.5, "data-h": h, style: `cursor:${cursor}` });
}

const CURSORS = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
function cursorFor(h, rot) {
  // pick the cursor of the direction the handle actually faces after rotation
  const dirs = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  const i = dirs.indexOf(h);
  if (i < 0) return "";
  const j = (i + Math.round(((rot % 360) + 360) % 360 / 45)) % 8;
  return CURSORS[dirs[j]];
}

let marquee = null;
let editingId = null;

/** Redraw the selection overlay; listeners of "overlay" (the quick toolbar) follow it. */
export function drawOverlay() {
  if (!overlay) return;
  paintOverlay();
  bus.emit("overlay");
}

function paintOverlay() {
  overlay.replaceChildren();
  if (marquee) {
    const [x0, y0] = docToScreen(marquee.x, marquee.y);
    overlay.appendChild(svgEl("rect", { class: "marquee", x: x0, y: y0, width: marquee.w * state.view.zoom, height: marquee.h * state.view.zoom }));
  }
  // the objects a line being drawn or an end being dragged will connect to (before drawing: where it starts)
  for (const t of drag ? drag.hint || [] : hover ? [hover] : []) {
    if (!getObj(t.id)) continue;
    const pts = outline(t).map(([x, y]) => docToScreen(x, y).map((v) => Math.round(v * 10) / 10).join(","));
    overlay.appendChild(svgEl("polygon", { class: "conn-target", points: pts.join(" ") }));
  }
  const objs = selectedObjs().filter((o) => !o.hidden);
  if (!objs.length || editingId) return;
  if (objs.length === 1) {
    const o = objs[0];
    if (isBox(o)) {
      const pts = corners(o).map(([x, y]) => docToScreen(x, y));
      overlay.appendChild(svgEl("polygon", { class: "sel-box", points: pts.map((p) => p.join(",")).join(" ") }));
      if (o.locked) return;
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [tl, tr, br, bl] = pts;
      const hs = { nw: tl, n: mid(tl, tr), ne: tr, e: mid(tr, br), se: br, s: mid(br, bl), sw: bl, w: mid(bl, tl) };
      const small = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) < 36 || Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) < 36;
      // a scale bar always shows its side handles (they set the bar's length), and only those when thin
      const bar = o.type === "scalebar", thin = bar && Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) < 30;
      // rotation handle above the top edge
      const top = hs.n, rad = ((o.rot || 0) * Math.PI) / 180;
      const rx = top[0] + Math.sin(rad) * 24, ry = top[1] - Math.cos(rad) * 24;
      overlay.appendChild(svgEl("line", { class: "rot-line", x1: top[0], y1: top[1], x2: rx, y2: ry }));
      overlay.appendChild(handle(rx, ry, "rot", "handle rot"));
      for (const [k, [x, y]] of Object.entries(hs)) {
        const side = k === "e" || k === "w";
        if (bar ? (thin && !side) || (small && !side && k.length === 1) : small && k.length === 1) continue;
        overlay.appendChild(handle(x, y, k, "handle" + (bar && side ? " len" : ""), cursorFor(k, o.rot || 0)));
      }
      return;
    }
    if (o.type === "line") {
      const [ax, ay] = docToScreen(o.x1, o.y1), [bx, by] = docToScreen(o.x2, o.y2);
      const [mx, my] = docToScreen(...lineMid(o));
      if (o.locked) return;
      // elbows: the middle segment slides; curves: the bulge; connected ends are drawn filled
      if (isElbow(o)) overlay.appendChild(handle(mx, my, "bend", "handle curve", elbowAxis(o) === "h" ? "ew-resize" : "ns-resize"));
      else overlay.appendChild(handle(mx, my, "curve", "handle curve"));
      overlay.appendChild(handle(ax, ay, "p1", "handle pt" + (o.from ? " attached" : "")));
      overlay.appendChild(handle(bx, by, "p2", "handle pt" + (o.to ? " attached" : "")));
      return;
    }
  }
  // groups, membranes, multiple objects: axis-aligned box
  const b = selectionBox(objs);
  for (const o of objs.length > 1 ? objs : []) {
    const ob = bbox(o);
    const [x, y] = docToScreen(ob.x, ob.y);
    overlay.appendChild(svgEl("rect", { class: "sel-outline", x, y, width: ob.w * state.view.zoom, height: ob.h * state.view.zoom }));
  }
  const [x0, y0] = docToScreen(b.x, b.y), [x1, y1] = docToScreen(b.x + b.w, b.y + b.h);
  overlay.appendChild(svgEl("rect", { class: "sel-box", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
  if (objs.some((o) => o.locked)) return;
  if (objs.length === 1 && objs[0].type === "membrane") brushHandles(objs[0]);
  const cx = (x0 + x1) / 2;
  overlay.appendChild(svgEl("line", { class: "rot-line", x1: cx, y1: y0, x2: cx, y2: y0 - 24 }));
  overlay.appendChild(handle(cx, y0 - 24, "rot", "handle rot"));
  for (const [k, x, y] of [["nw", x0, y0], ["ne", x1, y0], ["se", x1, y1], ["sw", x0, y1]]) {
    overlay.appendChild(handle(x, y, "b" + k, "handle", CURSORS[k]));
  }
}

/** Editing aids for a brush: its centre line and a round handle on every control point. */
function brushHandles(o) {
  const poly = smoothPolyline(o.pts, o.closed, 8).map(([x, y]) => docToScreen(x, y));
  overlay.appendChild(svgEl("path", { class: "spine", d: "M" + poly.map((p) => p.join(" ")).join("L") + (o.closed ? "Z" : "") }));
  o.pts.forEach(([x, y], i) => {
    const [sx, sy] = docToScreen(x, y);
    const end = !o.closed && (i === 0 || i === o.pts.length - 1);
    overlay.appendChild(handle(sx, sy, "pt" + i, "handle pt" + (end ? " end" : ""), "move"));
  });
}

/** Remove control point i of the selected brush (double-click on its handle); keeps 2 (3 when closed). */
function removeBrushPoint(i) {
  const o = selectedObjs()[0];
  if (o?.type !== "membrane" || o.locked || !(o.pts.length > (o.closed ? 3 : 2)) || !o.pts[i]) return false;
  o.pts.splice(i, 1);
  renderDoc();
  commit();
  return true;
}

/** Add a control point where the curve passes nearest to p. */
function insertBrushPoint(o, p) {
  const steps = 12;
  const poly = smoothPolyline(o.pts, o.closed, steps);
  let best = 0, bd = Infinity;
  for (let j = 0; j < poly.length - 1; j++) {
    const d = Math.hypot(poly[j][0] - p[0], poly[j][1] - p[1]);
    if (d < bd) {
      bd = d;
      best = j;
    }
  }
  const segs = o.closed ? o.pts.length : o.pts.length - 1;
  const seg = Math.min(Math.floor(best / steps), segs - 1);
  o.pts.splice(seg + 1, 0, [poly[best][0], poly[best][1]]);
}

/* ---------- snapping & guides ---------- */

function snapLines(exclude) {
  const { w, h } = docPx();
  const xs = [0, w / 2, w], ys = [0, h / 2, h];
  for (const o of state.doc.objects) {
    if (exclude.has(o.id) || o.hidden) continue;
    const b = bbox(o);
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

function drawGuides(gx, gy) {
  guidesG.replaceChildren();
  const { w, h } = docPx();
  const ext = 4000;
  for (const x of gx) guidesG.appendChild(svgEl("line", { x1: x, y1: -ext, x2: x, y2: h + ext }));
  for (const y of gy) guidesG.appendChild(svgEl("line", { x1: -ext, y1: y, x2: w + ext, y2: y }));
}

/** Snap a moving box; returns the adjusted delta and the guide lines that matched. */
function snapMove(box, dx, dy, lines, disable) {
  if (disable || !state.settings.snap) return { dx, dy, gx: [], gy: [] };
  const tol = 6 / state.view.zoom;
  const best = (vals, cands) => {
    let bd = Infinity, at = null;
    for (const v of vals) for (const c of cands) {
      const d = c - v;
      if (Math.abs(d) < Math.abs(bd) && Math.abs(d) <= tol) {
        bd = d;
        at = c;
      }
    }
    return [bd === Infinity ? 0 : bd, at];
  };
  const bx = box.x + dx, by = box.y + dy;
  const [sx, gx] = best([bx, bx + box.w / 2, bx + box.w], lines.xs);
  const [sy, gy] = best([by, by + box.h / 2, by + box.h], lines.ys);
  let rdx = dx + sx, rdy = dy + sy;
  if (state.settings.grid && gx == null) {
    const gs = state.settings.gridSize * MM;
    rdx = Math.round((box.x + dx) / gs) * gs - box.x;
  }
  if (state.settings.grid && gy == null) {
    const gs = state.settings.gridSize * MM;
    rdy = Math.round((box.y + dy) / gs) * gs - box.y;
  }
  return { dx: rdx, dy: rdy, gx: gx != null ? [gx] : [], gy: gy != null ? [gy] : [] };
}

/* ---------- pointer tools ---------- */

let drag = null;
let lastPress = null; // the last press on a brush point {h, t, x, y}, for double-clicks on points
let dblDone = -1e9; // when a double press on a point was handled (the browser's own dblclick is then ignored)

/** True while the pointer moves, resizes or rotates objects or draws a marquee (not while panning). */
export const isDragging = () => !!drag && drag.mode !== "pan" && (drag.mode !== "move" || drag.moved);

const snap = (o) => JSON.parse(JSON.stringify(o));
function restore(o, s) {
  for (const k of Object.keys(o)) delete o[k];
  Object.assign(o, snap(s));
}

function hitId(target) {
  const g = target?.closest?.("#content > g.obj");
  return g?.dataset.id || null;
}

/**
 * The object a line end would connect to at a screen point: the topmost one drawn there that is
 * unlocked, visible, not a line, not in `skip` and not a background to `other` (the line's other end,
 * see canConnect). `blocked` is the first object passed over only for being that background (holding
 * Ctrl connects to it). Returns {target, blocked}.
 */
function connectTargetAt(cx, cy, skip = new Set(), other = null) {
  const seen = new Set();
  let blocked = null;
  for (const t of document.elementsFromPoint?.(cx, cy) || []) {
    const id = hitId(t);
    if (!id || skip.has(id) || seen.has(id)) continue;
    seen.add(id);
    const o = getObj(id);
    if (canConnect(o, other)) return { target: o, blocked };
    if (!blocked && other && canConnect(o)) blocked = o;
  }
  return { target: null, blocked };
}

/** Ctrl (⌘ on a Mac) while drawing a line or dragging an end: connect even to a background the line lies on. */
const forceKey = (e) => e.ctrlKey || e.metaKey;
const FORCE_KEY = MOD.replace(/\+$/, "");

/** The status-bar hint while an end passes over a background it won't join on its own. */
function connectHint(blocked) {
  const nm = blocked && (blocked.name || { rect: "rectangle", membrane: "brush", image: "picture", group: "group" }[blocked.type] || blocked.type);
  $("#status-msg").textContent = blocked ? `Not connected to “${nm}” (the line lies on it) · hold ${FORCE_KEY} to connect` : "";
}

const LINE_TOOLS = new Set(["line", "arrow", "inhibit"]);
let hover = null; // with a line tool: the object a line drawn from the pointer would start on

/** Locked objects ignore the pointer; find the one drawn at a screen point (for the right-click menu). */
function lockedHitId(cx, cy) {
  stage.classList.add("hit-locked");
  const t = document.elementFromPoint(cx, cy);
  stage.classList.remove("hit-locked");
  const id = hitId(t);
  return id && getObj(id)?.locked ? id : null;
}

/** Right-click: select what is under the pointer (keeping a selection clicked inside), then ask for the menu. */
function onContextMenu(e) {
  e.preventDefault();
  if (drag) return;
  if (editingId) finishTextEdit();
  const p = screenToDoc(e.clientX, e.clientY);
  const id = hitId(e.target) || lockedHitId(e.clientX, e.clientY);
  if (id) {
    if (!state.selection.includes(id)) setSelection([id]);
  } else if (state.selection.length) {
    const b = selectionBox();
    const inside = p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h;
    if (!inside && !e.target?.dataset?.h) setSelection([]);
  }
  bus.emit("context-menu", { x: e.clientX, y: e.clientY, at: p });
}

export function setTool(t) {
  state.tool = t;
  if (hover) {
    hover = null;
    drawOverlay();
  }
  stage.setAttribute("class", "tool-" + t);
  for (const b of document.querySelectorAll("#tools [data-tool]")) b.classList.toggle("active", b.dataset.tool === t);
  bus.emit("tool");
}

/** A new brush object with the pattern chosen for the brush tool. */
function newBrush(p) {
  const b = state.brush || { kind: "bilayer" };
  const kind = BRUSHES[b.kind] ? b.kind : "bilayer";
  const o = { id: uid(), type: "membrane", brush: kind, pts: [p], closed: false, thickness: BRUSHES[kind].T, fill: "none" };
  if (kind === "bilayer") Object.assign(o, { headColor: "#f0a35c", tailColor: "#e9c88f" });
  if (kind === "arrow") Object.assign(o, { startHead: "none", endHead: "arrow" });
  if (kind === "freeform") Object.assign(o, { closed: true, fill: "#d9ecf7", fillOpacity: 1, stroke: "#1d6fa5" });
  if (kind === "icon") {
    const a = state.doc.assets[b.asset];
    Object.assign(o, { asset: b.asset, colors: {}, slotColors: [], name: a ? a.meta.name + " (brush)" : "Icon brush" });
  } else o.name = BRUSHES[kind].name;
  o.seed = Math.floor(Math.random() * 1e6);
  return o;
}

/** A path arrow brush through `pts`. */
function pathArrow(pts, extra = {}) {
  return { id: uid(), type: "membrane", brush: "arrow", pts, closed: false, thickness: BRUSHES.arrow.T, fill: "none", startHead: "none", endHead: "arrow", seed: 1, ...extra };
}

function label(text, x, y, size, align, extra = {}) {
  const o = { id: uid(), type: "text", text, x, y, w: 10, h: 10, rot: 0, fontSize: size, fontFamily: "Arial", color: "#3a4452", align, bold: false, italic: false, ...extra };
  measureText(o);
  o.x = align === "right" ? x - o.w : align === "center" ? x - o.w / 2 : x;
  o.y = y - o.h / 2;
  return o;
}

/**
 * The objects a brush preset places in a box: a circular arrow (a 300° arc of a path arrow) or a
 * plasmid map (a closed backbone, gene arcs with arrowheads and labels, grouped).
 */
export function presetObjects(name, { x, y, w, h }) {
  const cx = x + w / 2, cy = y + h / 2;
  if (name === "circular") {
    const rx = w / 2, ry = h / 2;
    const T = clamp(Math.min(rx, ry) * 0.07, 1.5, 8);
    return [pathArrow(arcPts(cx, cy, rx, ry, -60, 240, 20), { thickness: T, name: "Circular arrow" })];
  }
  // plasmid: room around the ring for the labels
  const R = Math.min(w, h) / 2 * 0.6;
  const band = Math.max(3, R * 0.15), fs = clamp(R * 0.14, 6, 28);
  const backbone = pathArrow(arcPts(cx, cy, R, R, 0, 330, 30), {
    closed: true, startHead: "none", endHead: "none", thickness: Math.max(1.2, R * 0.04), palette: { line: "#5b6675" }, name: "Backbone",
  });
  const hs = (band * 1.9) / headSize(band);
  const FEATURES = [
    ["Promoter", -84, -58, "#7cc36e", 1],
    ["Gene of interest", -48, 62, "#2f6db5", 1],
    ["ori", 92, 132, "#f2b83d", 0],
    ["AmpR", 158, 236, "#e0634f", -1],
  ];
  const kids = [backbone];
  for (const [nm, a0, a1, c, dir] of FEATURES) {
    kids.push(pathArrow(arcPts(cx, cy, R, R, a0, a1, 12), {
      thickness: band, palette: { line: c }, headScale: hs, startHead: dir < 0 ? "arrow" : "none", endHead: dir > 0 ? "arrow" : "none", name: nm,
    }));
    const a = (((a0 + a1) / 2) * Math.PI) / 180, rr = R + band * 0.9 + fs * 0.45;
    const lx = cx + Math.cos(a) * rr, ly = cy + Math.sin(a) * rr;
    kids.push(label(nm, lx, ly, fs, Math.cos(a) > 0.25 ? "left" : Math.cos(a) < -0.25 ? "right" : "center"));
  }
  kids.push(label("Plasmid", cx, cy - fs * 0.62, fs * 1.15, "center", { bold: true }), label("5.0 kb", cx, cy + fs * 0.68, fs, "center", { color: "#6b7480" }));
  return [{ id: uid(), type: "group", name: "Plasmid map", children: kids }];
}

/** A rough, smooth blob around (x, y): what a click with the freeform shape brush makes. */
function blobPts(x, y, r, seed) {
  const pts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const k = 1 + 0.14 * Math.sin(3 * a + seed) + 0.06 * Math.cos(5 * a + seed * 1.7);
    pts.push([x + Math.cos(a) * r * k, y + Math.sin(a) * r * k * 0.8]);
  }
  return pts;
}

const DEFAULT_LINE = { stroke: "#2b3440", strokeWidth: 2, curve: 0, startHead: "none", endHead: "none", dash: "" };

function newObjectFor(tool, p) {
  const id = uid();
  if (tool === "rect") return { id, type: "rect", x: p[0], y: p[1], w: 1, h: 1, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5, radius: 6 };
  if (tool === "ellipse") return { id, type: "ellipse", x: p[0], y: p[1], w: 1, h: 1, rot: 0, fill: "#fde7c8", stroke: "#c76b1f", strokeWidth: 1.5 };
  const head = tool === "arrow" ? "arrow" : tool === "inhibit" ? "bar" : "none";
  return { id, type: "line", x1: p[0], y1: p[1], x2: p[0], y2: p[1], ...DEFAULT_LINE, endHead: head };
}

/**
 * Insert › Text, Rectangle, Ellipse or Arrow: a default-sized object centred at `at` (the middle of
 * the view), selected; new text opens for typing.
 */
export function insertObject(tool, at = viewCenter()) {
  if (editingId) finishTextEdit();
  const [cx, cy] = at;
  let o;
  if (tool === "text") {
    o = { id: uid(), type: "text", x: cx, y: cy, w: 10, h: 10, rot: 0, text: "Text", fontSize: 16, fontFamily: "Arial", color: "#1c2733", align: "left", bold: false, italic: false };
    measureText(o);
    o.x = cx - o.w / 2;
    o.y = cy - o.h / 2;
  } else {
    o = newObjectFor(tool, at);
    if (o.type === "line") Object.assign(o, { x1: cx - 15 * MM, x2: cx + 15 * MM });
    else Object.assign(o, { x: cx - 15 * MM, y: cy - 10 * MM, w: 30 * MM, h: 20 * MM });
  }
  state.doc.objects.push(o);
  setSelection([o.id]);
  setTool("select");
  renderDoc();
  if (tool === "text") startTextEdit(o, true); // commits when the typing ends
  else commit();
  return o;
}

function onDown(e) {
  if (editingId) finishTextEdit();
  const p = screenToDoc(e.clientX, e.clientY);
  if (e.button === 1 || (e.button === 0 && (keys.space || state.tool === "hand"))) {
    drag = { mode: "pan", sx: e.clientX, sy: e.clientY, v0: { ...state.view } };
    stage.classList.add("panning", "dragging");
    stage.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  stage.setPointerCapture(e.pointerId);
  const h = e.target?.dataset?.h;
  const objs = selectedObjs();
  // a second press on the same brush point straight after the first is a double-click: remove the
  // point (handles are redrawn on release, so the browser never sends a dblclick for them)
  const now = performance.now(), prev = lastPress;
  lastPress = h?.startsWith("pt") ? { h, t: now, x: e.clientX, y: e.clientY } : null;
  if (prev && prev.h === h && now - prev.t < 500 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 6) {
    lastPress = null;
    dblDone = now;
    removeBrushPoint(+h.slice(2));
    return;
  }
  if (h) {
    drag = { mode: "handle", h, start: p, orig: objs.map((o) => [o, snap(o)]), box0: selectionBox(objs) };
    return;
  }
  const tool = state.tool;
  if (tool === "select") {
    const id = hitId(e.target);
    if (id) {
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      if (add) {
        if (state.selection.includes(id)) {
          setSelection(state.selection.filter((s) => s !== id));
          drag = null;
          return;
        }
        setSelection([...state.selection, id]);
      } else if (!state.selection.includes(id)) setSelection([id]);
      const sel = selectedObjs().filter((o) => !o.locked);
      drag = { mode: "move", start: p, sx: e.clientX, sy: e.clientY, orig: sel.map((o) => [o, snap(o)]), box0: selectionBox(sel), copy: e.altKey, moved: false, lines: null };
    } else {
      if (!(e.shiftKey || e.ctrlKey || e.metaKey)) setSelection([]);
      drag = { mode: "marquee", start: p, base: [...state.selection] };
    }
    return;
  }
  if (tool === "text") {
    const o = { id: uid(), type: "text", x: p[0], y: p[1] - 10, w: 10, h: 10, rot: 0, text: "Text", fontSize: 16, fontFamily: "Arial", color: "#1c2733", align: "left", bold: false, italic: false };
    measureText(o);
    state.doc.objects.push(o);
    setSelection([o.id]);
    renderDoc();
    setTool("select");
    startTextEdit(o, true);
    return;
  }
  if (tool === "membrane") {
    const preset = BRUSH_PRESETS[state.brush?.preset] ? state.brush.preset : null;
    if (preset) drag = { mode: "stamp", preset, start: p, sx: e.clientX, sy: e.clientY, objs: null };
    else drag = { mode: "membrane", obj: newBrush(p), raw: [p], added: false };
    return;
  }
  // rect / ellipse / line / arrow / inhibit; a line started on an object connects to it (not with Alt)
  const from = LINE_TOOLS.has(tool) && !e.altKey ? connectTargetAt(e.clientX, e.clientY).target : null;
  drag = { mode: "create", tool, start: p, obj: null, sx: e.clientX, sy: e.clientY, from };
}

function onMove(e) {
  const p = screenToDoc(e.clientX, e.clientY);
  $("#status-pos").textContent = `${fmtNum(p[0] / MM)}, ${fmtNum(p[1] / MM)} mm`;
  if (!drag) {
    // with a line tool, outline the object a line drawn from here would start on
    const t = LINE_TOOLS.has(state.tool) && !e.altKey && e.target?.closest?.("#stage") ? connectTargetAt(e.clientX, e.clientY).target : null;
    if (t !== hover) {
      hover = t;
      drawOverlay();
    }
    return;
  }
  const m = drag.mode;
  if (m === "pan") {
    state.view.x = drag.v0.x + (e.clientX - drag.sx);
    state.view.y = drag.v0.y + (e.clientY - drag.sy);
    applyView();
    return;
  }
  if (m === "marquee") {
    const [x0, y0] = drag.start;
    marquee = { x: Math.min(x0, p[0]), y: Math.min(y0, p[1]), w: Math.abs(p[0] - x0), h: Math.abs(p[1] - y0) };
    const hits = state.doc.objects
      .filter((o) => !o.hidden && !o.locked)
      .filter((o) => {
        const b = bbox(o);
        return b.x < marquee.x + marquee.w && b.x + b.w > marquee.x && b.y < marquee.y + marquee.h && b.y + b.h > marquee.y;
      })
      .map((o) => o.id);
    state.selection = [...new Set([...drag.base, ...hits])];
    drawOverlay();
    return;
  }
  if (m === "move") {
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
    if (!drag.orig.length) return;
    if (!drag.moved) {
      drag.moved = true;
      if (drag.copy) {
        // Alt-drag leaves the originals and moves copies
        const copies = cloneObjs(drag.orig.map(([, s]) => s));
        state.doc.objects.push(...copies);
        drag.orig = copies.map((c) => [c, snap(c)]);
        setSelection(copies.map((c) => c.id));
      }
      // connectors moved without their objects let go of them
      if (detachConnectors(drag.orig.map(([o]) => o))) drag.orig = drag.orig.map(([o]) => [o, snap(o)]);
      // don't snap to the connectors that follow the moving objects
      const moving = new Set(drag.orig.map(([o]) => o.id));
      for (const o of state.doc.objects) if (o.type === "line" && [o.from, o.to].some((e) => e && moving.has(e.id))) moving.add(o.id);
      drag.lines = snapLines(moving);
    }
    const res = snapMove(drag.box0, p[0] - drag.start[0], p[1] - drag.start[1], drag.lines, e.altKey && !drag.copy);
    for (const [o, s] of drag.orig) {
      restore(o, s);
      moveObj(o, res.dx, res.dy);
    }
    drawGuides(res.gx, res.gy);
    $("#status-msg").textContent = `Δ ${fmtNum(res.dx / MM)}, ${fmtNum(res.dy / MM)} mm`;
    renderSoon();
    return;
  }
  if (m === "handle") return dragHandle(p, e);
  if (m === "create") {
    if (!drag.obj) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
      drag.obj = newObjectFor(drag.tool, drag.start);
      state.doc.objects.push(drag.obj);
      setSelection([drag.obj.id]);
    }
    const o = drag.obj;
    if (o.type === "line") {
      let [x, y] = p;
      if (e.shiftKey) [x, y] = snapAngle(drag.start, p);
      [o.x1, o.y1] = drag.start;
      o.x2 = x;
      o.y2 = y;
      // connect the start to the object it began on and the end to the one under the pointer, but
      // neither to a background the line lies on (canConnect: a line across a tissue drawing stays
      // free); Alt draws without connecting, Ctrl connects to backgrounds too
      const force = forceKey(e), start = e.altKey ? null : drag.from;
      const hit = e.altKey ? { target: null, blocked: null } : connectTargetAt(e.clientX, e.clientY, new Set([o.id, start?.id]), force ? null : { pt: drag.start, obj: start });
      const to = hit.target;
      const from = start && (force || canConnect(start, { pt: [x, y], obj: to })) ? start : null;
      for (const [k, t] of [["from", from], ["to", to]]) {
        if (t) o[k] = { id: t.id };
        else delete o[k];
      }
      drag.hint = [from, to].filter(Boolean);
      connectHint(!to && hit.blocked);
    } else {
      let [x0, y0] = drag.start;
      let w = p[0] - x0, h = p[1] - y0;
      if (e.shiftKey) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      if (e.altKey) {
        x0 -= w;
        y0 -= h;
        w *= 2;
        h *= 2;
      }
      Object.assign(o, { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.max(1, Math.abs(w)), h: Math.max(1, Math.abs(h)) });
    }
    renderSoon();
    return;
  }
  if (m === "stamp") {
    if (!drag.objs && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
    const [x0, y0] = drag.start;
    let w = p[0] - x0, h = p[1] - y0;
    if (e.shiftKey || drag.preset === "plasmid") {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    const box = { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.max(4, Math.abs(w)), h: Math.max(4, Math.abs(h)) };
    stampObjects(drag, presetObjects(drag.preset, box));
    renderSoon();
    return;
  }
  if (m === "membrane") {
    const last = drag.raw[drag.raw.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 3 / state.view.zoom) return;
    drag.raw.push(p);
    const o = drag.obj;
    o.pts = decimate(drag.raw, 7 / state.view.zoom);
    if (!drag.added && o.pts.length >= 2) {
      state.doc.objects.push(o);
      drag.added = true;
    }
    if (drag.added) renderSoon();
  }
}

/** Swap the objects a preset drag is placing for a new set (each pointer move re-makes them). */
function stampObjects(d, objs) {
  const old = new Set((d.objs || []).map((o) => o.id));
  state.doc.objects = state.doc.objects.filter((o) => !old.has(o.id));
  state.doc.objects.push(...objs);
  d.objs = objs;
}

function snapAngle([x0, y0], [x, y]) {
  const a = Math.atan2(y - y0, x - x0), d = Math.hypot(x - x0, y - y0);
  const s = (Math.round(a / (Math.PI / 12)) * Math.PI) / 12;
  return [x0 + Math.cos(s) * d, y0 + Math.sin(s) * d];
}

/** Keep points at least `min` apart (always keeping the last). */
function decimate(pts, min) {
  const out = [pts[0]];
  for (const q of pts.slice(1)) {
    const l = out[out.length - 1];
    if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= min) out.push(q);
  }
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last && out.length > 1) out[out.length - 1] = last;
  return out;
}

function dragHandle(p, e) {
  if ((drag.h === "rot" || /^b(nw|ne|se|sw)$/.test(drag.h)) && !drag.detached) {
    // connectors turned or scaled without their objects let go of them
    drag.detached = true;
    if (detachConnectors(drag.orig.map(([o]) => o))) drag.orig = drag.orig.map(([o]) => [o, snap(o)]);
  }
  const { h, orig, box0 } = drag;
  if (h === "rot") {
    const single = orig.length === 1 && isBox(orig[0][1]) ? orig[0][1] : null;
    const cx = single ? single.x + single.w / 2 : box0.x + box0.w / 2;
    const cy = single ? single.y + single.h / 2 : box0.y + box0.h / 2;
    const a0 = Math.atan2(drag.start[1] - cy, drag.start[0] - cx), a1 = Math.atan2(p[1] - cy, p[0] - cx);
    let d = ((a1 - a0) * 180) / Math.PI;
    if (single) {
      let r = (single.rot || 0) + d;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      d = r - (single.rot || 0);
    } else if (e.shiftKey) d = Math.round(d / 15) * 15;
    for (const [o, s] of orig) {
      restore(o, s);
      rotateObjAbout(o, cx, cy, d);
    }
    $("#status-msg").textContent = single ? `${fmtNum(((single.rot || 0) + d + 360) % 360)}°` : `${fmtNum(d)}°`;
    return renderSoon();
  }
  if (h.startsWith("pt")) {
    // dragging a point away is not the first half of a double-click
    if (lastPress && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) > 4) lastPress = null;
    const [o, s] = orig[0];
    restore(o, s);
    const i = +h.slice(2);
    const ref = o.pts[i > 0 ? i - 1 : 1];
    o.pts[i] = e.shiftKey && ref ? snapAngle(ref, p) : [p[0], p[1]];
    return renderSoon();
  }
  if (h === "p1" || h === "p2" || h === "curve" || h === "bend") {
    const [o, s] = orig[0];
    restore(o, s);
    if (h === "curve") {
      const mx = (o.x1 + o.x2) / 2, my = (o.y1 + o.y2) / 2;
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1, len = Math.hypot(dx, dy) || 1;
      let c = (p[0] - mx) * (-dy / len) + (p[1] - my) * (dx / len);
      if (Math.abs(c) < 4 / state.view.zoom) c = 0;
      o.curve = c;
    } else if (h === "bend") {
      // slide an elbow's middle segment; it snaps to the middle and to either end (an L)
      const [a, b] = connectorRefs(o), i = elbowAxis(o) === "h" ? 0 : 1, span = b[i] - a[i];
      if (Math.abs(span) > 0.5) {
        let t = (p[i] - a[i]) / span;
        for (const k of [0.5, 0, 1]) if (Math.abs((t - k) * span) < 5 / state.view.zoom) t = k;
        o.bend = clamp(t, -4, 5);
      }
    } else {
      // drag an end onto an object to connect it there, off any object (or with Alt) to let go; not
      // onto a background the line lies on, unless with Ctrl
      const [end, other] = h === "p1" ? ["from", "to"] : ["to", "from"];
      const fixed = h === "p1" ? [o.x2, o.y2] : [o.x1, o.y1];
      const hit = e.altKey ? { target: null, blocked: null }
        : connectTargetAt(e.clientX, e.clientY, new Set([o.id, o[other]?.id]), forceKey(e) ? null : { pt: fixed, obj: o[other] ? findObj(o[other].id) : null });
      const target = hit.target;
      const [x, y] = e.shiftKey && !target ? snapAngle(fixed, p) : p;
      if (h === "p1") [o.x1, o.y1] = [x, y];
      else [o.x2, o.y2] = [x, y];
      if (target) o[end] = { id: target.id };
      else delete o[end];
      drag.hint = target ? [target] : [];
      connectHint(!target && hit.blocked);
    }
    return renderSoon();
  }
  if (/^b(nw|ne|se|sw)$/.test(h)) {
    // bounding-box corner of a group / membrane / multi-selection: scale about the opposite corner
    const k = h.slice(1);
    const ax = k.includes("w") ? box0.x + box0.w : box0.x, ay = k.includes("n") ? box0.y + box0.h : box0.y;
    const fx = k.includes("w") ? box0.x : box0.x + box0.w, fy = k.includes("n") ? box0.y : box0.y + box0.h;
    let sx = (p[0] - ax) / (fx - ax || 1), sy = (p[1] - ay) / (fy - ay || 1);
    const rotated = orig.some(([, s]) => isBox(s) && s.rot);
    if (!e.shiftKey || rotated) sx = sy = Math.max(sx, sy);
    sx = Math.max(0.02, sx);
    sy = Math.max(0.02, sy);
    // brushes scale their pattern with the path; with Alt only the path changes
    for (const [o, s] of orig) {
      restore(o, s);
      scaleObjAbout(o, ax, ay, sx, sy, e.altKey);
    }
    const brushes = orig.some(([, s]) => isPatternBrush(s));
    $("#status-msg").textContent = `${Math.round(sx * 100)}% × ${Math.round(sy * 100)}%`
      + (!brushes ? "" : e.altKey ? " · path only: the pattern keeps its size" : " · hold Alt to resize only the path");
    return renderSoon();
  }
  // resize a single box object in its own rotated frame
  const [o, s] = orig[0];
  if (s.type === "scalebar" && (h === "e" || h === "w")) {
    // a scale bar's side handles change the length of the bar: the other end stays (both move with Alt)
    const r = resizeBox(s, h, p, false, e.altKey);
    restore(o, s);
    const len = s.length ?? 15 * MM, d = Math.max(r.w - s.w, 2 - len);
    o.length = len + d;
    fitFurniture(o);
    const [dx, dy] = rotPt(e.altKey ? 0 : h === "e" ? d / 2 : -d / 2, 0, 0, 0, s.rot || 0);
    o.x = s.x + s.w / 2 + dx - o.w / 2;
    o.y = s.y + s.h / 2 + dy - o.h / 2;
    $("#status-msg").textContent = `Bar ${fmtNum(o.length / MM)} mm`;
    return renderSoon();
  }
  const keep = s.type === "text" || isFurniture(s) || ((s.type === "icon" || s.type === "image") !== e.shiftKey);
  const r = resizeBox(s, h, p, keep, e.altKey);
  restore(o, s);
  if (o.type === "text" || isFurniture(o)) {
    if (o.type === "text") {
      o.fontSize = Math.max(2, s.fontSize * (r.h / s.h));
      measureText(o);
    } else {
      // legends and scale bars scale everything in them, like text
      scaleFurniture(o, r.h / s.h);
      fitFurniture(o);
    }
    // keep the dragged box's centre
    o.x = r.x + r.w / 2 - o.w / 2;
    o.y = r.y + r.h / 2 - o.h / 2;
  } else Object.assign(o, r);
  $("#status-msg").textContent = `${fmtNum(o.w / MM)} × ${fmtNum(o.h / MM)} mm`;
  renderSoon();
}

function resizeBox(s, h, p, keep, fromCenter) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2, rot = s.rot || 0;
  const [lx, ly] = rotPt(p[0], p[1], cx, cy, -rot);
  let L = s.x, R = s.x + s.w, T = s.y, B = s.y + s.h;
  if (h.includes("e")) R = Math.max(lx, L + 2);
  if (h.includes("w")) L = Math.min(lx, R - 2);
  if (h.includes("s")) B = Math.max(ly, T + 2);
  if (h.includes("n")) T = Math.min(ly, B - 2);
  if (fromCenter) {
    if (h.includes("e")) L = cx - (R - cx);
    if (h.includes("w")) R = cx + (cx - L);
    if (h.includes("s")) T = cy - (B - cy);
    if (h.includes("n")) B = cy + (cy - T);
  }
  if (keep) {
    const ar = s.w / s.h;
    if (h.length === 2) {
      let w = R - L, hh = B - T;
      if (w / hh > ar) w = hh * ar;
      else hh = w / ar;
      if (fromCenter) {
        L = cx - w / 2; R = cx + w / 2; T = cy - hh / 2; B = cy + hh / 2;
      } else {
        if (h.includes("e")) R = L + w; else L = R - w;
        if (h.includes("s")) B = T + hh; else T = B - hh;
      }
    } else if (h === "e" || h === "w") {
      const hh = (R - L) / ar;
      T = cy - hh / 2;
      B = cy + hh / 2;
    } else {
      const w = (B - T) * ar;
      L = cx - w / 2;
      R = cx + w / 2;
    }
  }
  const [gx, gy] = rotPt((L + R) / 2, (T + B) / 2, cx, cy, rot);
  const w = R - L, hh = B - T;
  return { x: gx - w / 2, y: gy - hh / 2, w, h: hh };
}

/**
 * A hand-drawn loop as points spaced evenly round it (about every 24 screen px, 6–32 of them), the
 * jitter of the hand smoothed out first; the smooth curve through them is the freeform shape.
 */
function loopPts(raw, z) {
  let pts = raw.slice();
  const [a, b] = [pts[0], pts[pts.length - 1]];
  if (pts.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) pts.pop();
  const m = pts.length;
  for (let pass = 0; pass < 2; pass++) {
    pts = pts.map((q, i) => {
      const p = pts[(i - 1 + m) % m], r = pts[(i + 1) % m];
      return [(p[0] + 2 * q[0] + r[0]) / 4, (p[1] + 2 * q[1] + r[1]) / 4];
    });
  }
  const ring = [...pts, pts[0]];
  const cum = [0];
  for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
  const L = cum[cum.length - 1];
  const n = clamp(Math.round(L / (24 / z)), 6, 32);
  const out = [];
  for (let k = 0, j = 1; k < n; k++) {
    const s = (k * L) / n;
    while (j < ring.length - 1 && cum[j] < s) j++;
    const t = (s - cum[j - 1]) / (cum[j] - cum[j - 1] || 1);
    out.push([ring[j - 1][0] + (ring[j][0] - ring[j - 1][0]) * t, ring[j - 1][1] + (ring[j][1] - ring[j - 1][1]) * t]);
  }
  return out;
}

/** Ramer–Douglas–Peucker simplification. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let idx = -1, max = 0;
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  for (let i = 1; i < pts.length - 1; i++) {
    // a loop's chord has no length: measure from its start point instead
    const d = len > 1e-6 ? Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / len : Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (max <= tol) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

function onUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  guidesG.replaceChildren();
  $("#status-msg").textContent = "";
  stage.classList.remove("panning", "dragging");
  try {
    stage.releasePointerCapture(e.pointerId);
  } catch {}
  if (d.mode === "pan") return;
  if (d.mode === "marquee") {
    marquee = null;
    setSelection(state.selection);
    drawOverlay();
    return;
  }
  if (d.mode === "create") {
    if (!d.obj) {
      // a click without dragging makes a default-sized shape
      const o = newObjectFor(d.tool, d.start);
      if (o.type === "line") {
        o.x2 = o.x1 + 30 * MM;
      } else {
        Object.assign(o, { x: d.start[0] - 15 * MM, y: d.start[1] - 10 * MM, w: 30 * MM, h: 20 * MM });
      }
      state.doc.objects.push(o);
      setSelection([o.id]);
    } else if (d.obj.type === "line" && Math.hypot(d.obj.x2 - d.obj.x1, d.obj.y2 - d.obj.y1) < 2) {
      d.obj.x2 = d.obj.x1 + 30 * MM;
      delete d.obj.to;
    }
    setTool("select");
    renderDoc();
    commit();
    return;
  }
  if (d.mode === "stamp") {
    if (!d.objs) {
      // a click places the preset at a default size
      const s = (d.preset === "plasmid" ? 50 : 24) * MM;
      stampObjects(d, presetObjects(d.preset, { x: d.start[0] - s / 2, y: d.start[1] - s / 2, w: s, h: s }));
    }
    setSelection(d.objs.map((o) => o.id));
    setTool("select");
    renderDoc();
    commit();
    return;
  }
  if (d.mode === "membrane") {
    const o = d.obj;
    const shape = o.brush === "freeform";
    if (!d.added) {
      // a click without dragging: a straight brush, ready to bend (a freeform shape: a round blob)
      const [x, y] = d.raw[0];
      o.pts = shape ? blobPts(x, y, 12 * MM, o.seed % 7) : [[x - 20 * MM, y], [x, y], [x + 20 * MM, y]];
      state.doc.objects.push(o);
      setSelection([o.id]);
      setTool("select");
      renderDoc();
      commit();
      return;
    }
    const z = state.view.zoom, raw = d.raw;
    const [first, last] = [raw[0], raw[raw.length - 1]];
    const extent = Math.max(...raw.map((p) => Math.hypot(p[0] - first[0], p[1] - first[1])));
    // freeform shapes always close; path arrows never close by themselves
    o.closed = shape || (o.brush !== "arrow" && raw.length > 8 && extent > 30 / z && Math.hypot(first[0] - last[0], first[1] - last[1]) < 16 / z);
    if (shape) {
      // a blob: points spaced evenly round the loop keep its outline smooth
      o.pts = extent > 6 / z ? loopPts(raw, z) : blobPts(first[0], first[1], 4 * MM, o.seed % 7);
    } else {
      let pts = simplify(o.closed ? raw.slice(0, -1) : raw, 2.4 / z);
      if (o.closed && pts.length > 3) {
        const [p0, pn] = [pts[0], pts[pts.length - 1]];
        if (Math.hypot(p0[0] - pn[0], p0[1] - pn[1]) < 16 / z) pts = pts.slice(0, -1);
      }
      // fewer, evenly spaced points keep the curve smooth and easy to edit
      o.pts = decimate(pts, 9 / z);
    }
    if (o.pts.length < 2) {
      state.doc.objects = state.doc.objects.filter((x) => x !== o);
      setTool("select");
      renderDoc();
      return;
    }
    setSelection([o.id]);
    setTool("select");
    renderDoc();
    commit();
    return;
  }
  renderDoc();
  commit();
}

/* ---------- text editing ---------- */

let placeEditor = null; // puts the text box back on the text being edited (after the view moves)

export function startTextEdit(o, isNew = false) {
  const ta = $("#text-editor");
  editingId = o.id;
  const c = cache.get(o.id);
  if (c) c.g.style.visibility = "hidden";
  const place = () => {
    const z = state.view.zoom;
    const [sx, sy] = docToScreen(o.x, o.y);
    Object.assign(ta.style, {
      display: "block",
      left: sx + "px",
      top: sy + "px",
      width: Math.max(40, o.w * z + 24) + "px",
      height: Math.max(20, o.h * z + 4) + "px",
      font: fontCss(o, o.fontSize * z),
      lineHeight: String(o.lineHeight || 1.25),
      textAlign: o.align || "left",
      color: o.color || "#1c2733",
      transform: o.rot ? `rotate(${o.rot}deg)` : "",
      transformOrigin: `${(o.w * z) / 2}px ${(o.h * z) / 2}px`,
    });
  };
  ta.value = o.text;
  place();
  placeEditor = place;
  drawOverlay();
  ta.oninput = () => {
    o.text = ta.value;
    measureText(o);
    place();
    bus.emit("doc-live");
  };
  ta.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape" || (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey))) {
      ev.preventDefault();
      finishTextEdit();
    }
  };
  ta.onblur = () => finishTextEdit();
  setTimeout(() => {
    ta.focus();
    if (isNew) ta.select();
  }, 0);
}

export function finishTextEdit() {
  if (!editingId) return;
  const ta = $("#text-editor");
  const o = getObj(editingId);
  const c = cache.get(editingId);
  editingId = null;
  placeEditor = null;
  ta.onblur = null;
  ta.style.display = "none";
  if (c) c.g.style.visibility = "";
  if (o && !o.text.trim()) {
    state.doc.objects = state.doc.objects.filter((x) => x !== o);
    setSelection([]);
  }
  renderDoc();
  commit();
}

export const isEditingText = () => !!editingId;

/* ---------- setup ---------- */

export function initCanvas() {
  stage = $("#stage");
  viewport = $("#viewport");
  content = $("#content");
  overlay = $("#overlay");
  guidesG = $("#guides");
  paper = $("#paper");
  paperShadow = $("#paper-shadow-rect");
  grid = $("#grid");
  wrap = $("#stage-wrap");
  stage.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  stage.addEventListener("dblclick", (e) => {
    if (performance.now() - dblDone < 700) return; // a double press on a point, already handled in onDown
    // the stage captures the pointer on pointerdown, so a real double-click is aimed at the stage
    // itself: look up what is under the pointer
    const tgt = e.target === stage ? document.elementFromPoint(e.clientX, e.clientY) || stage : e.target;
    const h = tgt?.dataset?.h;
    if (h?.startsWith("pt")) {
      removeBrushPoint(+h.slice(2));
      return;
    }
    const id = hitId(tgt);
    const o = id ? getObj(id) : null; // (blank paper, a handle: nothing)
    if (o?.type === "text" && !o.locked) startTextEdit(o);
    else if (o && isFurniture(o) && !o.locked) {
      // legends and scale bars are edited in the inspector: go to the row (or field) under the pointer
      setSelection([o.id]);
      bus.emit("edit-furniture", { id: o.id, row: o.type === "legend" ? legendRowAt(o, screenToDoc(e.clientX, e.clientY)) : -1 });
    }
    else if (o?.type === "membrane" && !o.locked && state.selection.includes(o.id)) {
      insertBrushPoint(o, screenToDoc(e.clientX, e.clientY));
      renderDoc();
      commit();
    }
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0018)), e.clientX, e.clientY);
      else {
        const k = e.deltaMode ? 30 : 1;
        state.view.x -= (e.shiftKey ? e.deltaY : e.deltaX) * k;
        state.view.y -= (e.shiftKey ? 0 : e.deltaY) * k;
        applyView();
      }
    },
    { passive: false }
  );
  stage.addEventListener("contextmenu", onContextMenu);
  // (called before the next paint, so the page keeps its place while a panel is dragged)
  new ResizeObserver(stageResized).observe(wrap);
  bus.on("selection", drawOverlay);
  // undo/redo replace the objects without drawing them: catch up on the next frame
  bus.on("doc", renderSoon);
}
