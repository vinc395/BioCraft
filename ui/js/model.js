// Document model, object geometry and undo history.
//
// Units: the document size is stored in millimetres; all geometry is in CSS pixels
// (96 per inch), which is also what the exported SVG viewBox uses.
//
// Object types
//   box objects  icon | text | rect | ellipse | image  — x, y, w, h, rot (deg, about centre), flipX, flipY
//                (icons also: asset, colors {from: to}, slotColors [], optional tint "#hex" | "gray", labels,
//                preset, saturation, lightness, baseColors — see style.js)
//   any object   optional glow {color, size px}: a fluorescence-style halo (render.js glowFilter)
//   line         x1, y1, x2, y2, curve (bulge in px), startHead, endHead; as a connector also
//                from / to {id} (the end sits on that object's outline, `pad` px off it — default 2;
//                x1…y2 are then computed by syncConnectors) and route "elbow" (right angles: axis
//                "h" | "v" = the direction it leaves the start, bend = where the middle segment sits,
//                0…1 from start to end; elbowAt is its computed position when an end is connected)
//   membrane     pts [[x,y]…], closed, brush — a pattern drawn along a smooth curve (lipid bilayer,
//                DNA, cell layer, filament, path arrow, freeform shape, blood vessel, axon… or a
//                library icon repeated: brush "icon", asset, colors)
//   group        children[] in document coordinates
//   legend       a box object (key): rows [{label, asset, colors, labels} (icon) | {label, color} (colour
//                square) | {label, color, line: {head, dash}} (line sample)], fontSize, fontFamily, color,
//                bold, iconSize, columns, title, border, fill. w/h follow the content (render.js
//                fitFurniture); scaling scales its sizes, like text, and flips never mirror it
//   scalebar     a box object: value + unit ("nm" | "µm" | "mm") for the label, length (the bar on the
//                page, px), thickness, color, fontSize, labelPos "above" | "below" | "none"

import { bus, rotPt, uid } from "./util.js";
import { BRUSHES, brushKind, brushPad, smoothPolyline } from "./brush.js";

export const MM = 96 / 25.4;

export const state = {
  doc: null,
  selection: [],
  tool: "select",
  view: { zoom: 1, x: 0, y: 0 },
  filePath: null,
  dirty: false,
  settings: { grid: false, gridSize: 5, snap: true, quickbar: true },
  brush: { kind: "bilayer", asset: null }, // what the brush tool (M) paints next
};

export function newDoc(wmm = 178, hmm = 120) {
  return { app: "BioCraft", version: 1, width: wmm, height: hmm, background: "#ffffff", objects: [], assets: {} };
}

export const docPx = (doc = state.doc) => ({ w: doc.width * MM, h: doc.height * MM });

export const BOX_TYPES = new Set(["icon", "text", "rect", "ellipse", "image", "legend", "scalebar"]);
export const isBox = (o) => BOX_TYPES.has(o.type);

/** Legends and scale bars: box objects sized by their content, which scale like text. */
export const isFurniture = (o) => o?.type === "legend" || o?.type === "scalebar";

/** Scale a legend's or scale bar's drawn sizes (text, icons, bar) by k; render.js fitFurniture then sizes its box. */
export function scaleFurniture(o, k) {
  k = Math.max(k, 1 / (o.fontSize || 12)); // text no smaller than 1 px
  for (const p of ["fontSize", "iconSize", "thickness", "length"]) if (Number.isFinite(o[p])) o[p] *= k;
}

export function getObj(id) {
  return state.doc.objects.find((o) => o.id === id);
}
/** An object anywhere in the figure, inside groups too. */
export function findObj(id, objs = state.doc.objects) {
  for (const o of objs) {
    if (o.id === id) return o;
    const c = o.children && findObj(id, o.children);
    if (c) return c;
  }
  return null;
}
export function selectedObjs() {
  return state.selection.map(getObj).filter(Boolean);
}
export function setSelection(ids) {
  state.selection = [...new Set(ids)].filter((id) => getObj(id));
  bus.emit("selection");
}

/* ---------- geometry ---------- */

export function corners(o) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  return [
    [o.x, o.y],
    [o.x + o.w, o.y],
    [o.x + o.w, o.y + o.h],
    [o.x, o.y + o.h],
  ].map(([x, y]) => rotPt(x, y, cx, cy, o.rot || 0));
}

/** Quadratic control point of a line from its bulge. */
export function ctrlPt(o) {
  const mx = (o.x1 + o.x2) / 2, my = (o.y1 + o.y2) / 2;
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1, len = Math.hypot(dx, dy) || 1;
  const c = o.curve || 0;
  return [mx + (-dy / len) * 2 * c, my + (dx / len) * 2 * c];
}

/** Point on a line's curve at t. */
export function linePoint(o, t) {
  const [cx, cy] = ctrlPt(o);
  const u = 1 - t;
  return [u * u * o.x1 + 2 * u * t * cx + t * t * o.x2, u * u * o.y1 + 2 * u * t * cy + t * t * o.y2];
}

export const isElbow = (o) => o.type === "line" && o.route === "elbow";

/** Which way an elbow line leaves its start: "h" (across, then down, then across) or "v". */
export const elbowAxis = (o) => (o.axis === "h" || o.axis === "v" ? o.axis : Math.abs(o.x2 - o.x1) >= Math.abs(o.y2 - o.y1) ? "h" : "v");

/** An elbow line's four corner points: start, the two bends, end. */
export function elbowPts(o) {
  const h = elbowAxis(o) === "h";
  const m = Number.isFinite(o.elbowAt) ? o.elbowAt : h ? o.x1 + (o.x2 - o.x1) * (o.bend ?? 0.5) : o.y1 + (o.y2 - o.y1) * (o.bend ?? 0.5);
  return h ? [[o.x1, o.y1], [m, o.y1], [m, o.y2], [o.x2, o.y2]] : [[o.x1, o.y1], [o.x1, m], [o.x2, m], [o.x2, o.y2]];
}

/** Where a line's middle handle sits: the curve's midpoint, or the middle of an elbow's bend. */
export function lineMid(o) {
  if (!isElbow(o)) return linePoint(o, 0.5);
  const [, a, b] = elbowPts(o);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function union(boxes) {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function ptsBox(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** Axis-aligned bounds in document coordinates. */
export function bbox(o) {
  if (o.type === "group") return union(o.children.map(bbox));
  if (o.type === "line") {
    if (isElbow(o)) return ptsBox(elbowPts(o), (o.strokeWidth || 2) / 2);
    const pts = [];
    for (let i = 0; i <= 16; i++) pts.push(linePoint(o, i / 16));
    return ptsBox(pts, (o.strokeWidth || 2) / 2);
  }
  if (o.type === "membrane") return ptsBox(o.pts.length > 1 ? smoothPolyline(o.pts, o.closed, 6) : o.pts, brushPad(o));
  return ptsBox(corners(o));
}
export const selectionBox = (objs = selectedObjs()) => union(objs.map(bbox));

/* ---------- transforms (mutate in place) ---------- */

export function moveObj(o, dx, dy) {
  if (o.type === "group") o.children.forEach((c) => moveObj(c, dx, dy));
  else if (o.type === "line") {
    o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
    if (Number.isFinite(o.elbowAt)) o.elbowAt += elbowAxis(o) === "h" ? dx : dy;
  } else if (o.type === "membrane") o.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
  else {
    o.x += dx;
    o.y += dy;
  }
}

export function rotateObjAbout(o, cx, cy, deg) {
  if (o.type === "group") o.children.forEach((c) => rotateObjAbout(c, cx, cy, deg));
  else if (o.type === "line") {
    // an elbow turned a quarter turn leaves its start the other way (it stays square to the page)
    const quarter = Math.abs((((deg % 180) + 180) % 180) - 90) < 1;
    if (isElbow(o) && quarter) o.axis = elbowAxis(o) === "h" ? "v" : "h";
    [o.x1, o.y1] = rotPt(o.x1, o.y1, cx, cy, deg);
    [o.x2, o.y2] = rotPt(o.x2, o.y2, cx, cy, deg);
    delete o.elbowAt; // recomputed by syncConnectors
  } else if (o.type === "membrane") o.pts = o.pts.map(([x, y]) => rotPt(x, y, cx, cy, deg));
  else {
    const [ncx, ncy] = rotPt(o.x + o.w / 2, o.y + o.h / 2, cx, cy, deg);
    o.x = ncx - o.w / 2;
    o.y = ncy - o.h / 2;
    o.rot = (((o.rot || 0) + deg) % 360 + 360) % 360;
  }
}

/** A brush that draws a pattern along its path (icons, cells, a helix…), not a line or a freeform shape. */
export function isPatternBrush(o) {
  if (o.type === "group") return o.children.some(isPatternBrush);
  const def = o.type === "membrane" && BRUSHES[brushKind(o)];
  return !!def && !def.line && !def.shape;
}

/**
 * Scale about (ox, oy). Rotated box objects keep their shape only under uniform scaling. A pattern
 * brush scales as a whole — its icons, cells or helix grow or shrink with the path, so it keeps the
 * same copies — unless `keepPattern`, when only the path changes and copies come or go to fill it.
 * Path arrows and freeform outlines keep their line width, as lines and shapes do.
 */
export function scaleObjAbout(o, ox, oy, sx, sy, keepPattern = false) {
  if (o.type === "group") return o.children.forEach((c) => scaleObjAbout(c, ox, oy, sx, sy, keepPattern));
  const sp = ([x, y]) => [ox + (x - ox) * sx, oy + (y - oy) * sy];
  if (o.type === "line") {
    if (Number.isFinite(o.elbowAt)) o.elbowAt = elbowAxis(o) === "h" ? ox + (o.elbowAt - ox) * sx : oy + (o.elbowAt - oy) * sy;
    [o.x1, o.y1] = sp([o.x1, o.y1]);
    [o.x2, o.y2] = sp([o.x2, o.y2]);
    o.curve = (o.curve || 0) * Math.sqrt(Math.abs(sx * sy));
  } else if (o.type === "membrane") {
    o.pts = o.pts.map(sp);
    if (!keepPattern && isPatternBrush(o)) {
      const k = Math.sqrt(Math.abs(sx * sy));
      o.thickness = Math.max(0.5, (o.thickness ?? BRUSHES[brushKind(o)].T) * k);
      if (Number.isFinite(o.headR)) o.headR *= k;
    }
  } else {
    const [ncx, ncy] = sp([o.x + o.w / 2, o.y + o.h / 2]);
    if (isFurniture(o)) {
      // legends and scale bars keep their proportions: everything in them scales alike
      const f0 = o.fontSize || 12;
      scaleFurniture(o, Math.sqrt(Math.abs(sx * sy)));
      const k = (o.fontSize || 12) / f0;
      o.w = Math.max(1, o.w * k);
      o.h = Math.max(1, o.h * k);
    } else {
      o.w = Math.max(1, o.w * Math.abs(sx));
      o.h = Math.max(1, o.h * Math.abs(sy));
    }
    if (o.type === "text") o.fontSize = Math.max(2, o.fontSize * Math.abs(sy));
    o.x = ncx - o.w / 2;
    o.y = ncy - o.h / 2;
  }
}

export function flipObj(o, axis, cx, cy) {
  const box = bbox(o);
  cx ??= box.x + box.w / 2;
  cy ??= box.y + box.h / 2;
  if (o.type === "group") return o.children.forEach((c) => flipObj(c, axis, cx, cy));
  const m = ([x, y]) => (axis === "h" ? [2 * cx - x, y] : [x, 2 * cy - y]);
  if (o.type === "line") {
    const ax = elbowAxis(o);
    if (Number.isFinite(o.elbowAt) && (ax === "h") === (axis === "h")) o.elbowAt = 2 * (axis === "h" ? cx : cy) - o.elbowAt;
    [o.x1, o.y1] = m([o.x1, o.y1]);
    [o.x2, o.y2] = m([o.x2, o.y2]);
    o.curve = -(o.curve || 0);
  } else if (o.type === "membrane") o.pts = o.pts.map(m);
  else {
    const [ncx, ncy] = m([o.x + o.w / 2, o.y + o.h / 2]);
    o.x = ncx - o.w / 2;
    o.y = ncy - o.h / 2;
    o.rot = (360 - (o.rot || 0)) % 360;
    if (o.type !== "text" && !isFurniture(o)) {
      if (axis === "h") o.flipX = !o.flipX;
      else o.flipY = !o.flipY;
    }
  }
}

/**
 * Deep copies with fresh ids. Connectors copied together with their targets stay connected to the
 * copies; ends connected to anything else are let go (the copy stays where it was put).
 */
export function cloneObjs(objs) {
  const ids = new Map();
  const fresh = (x) => {
    const id = uid();
    ids.set(x.id, id);
    x.id = id;
    if (x.children) x.children.forEach(fresh);
  };
  const relink = (x) => {
    for (const k of ["from", "to"]) {
      if (!x[k]) continue;
      if (ids.has(x[k].id)) x[k] = { ...x[k], id: ids.get(x[k].id) };
      else delete x[k];
    }
    if (x.children) x.children.forEach(relink);
  };
  const out = objs.map((o) => {
    const c = JSON.parse(JSON.stringify(o));
    fresh(c);
    return c;
  });
  out.forEach(relink);
  return out;
}
export const cloneObj = (o) => cloneObjs([o])[0];

/* ---------- connectors ---------- */

const ENDS = [["from", "x1", "y1"], ["to", "x2", "y2"]];

/** Every line in an object tree. */
function linesIn(objs, out = []) {
  for (const o of objs) {
    if (o.type === "line") out.push(o);
    if (o.children) linesIn(o.children, out);
  }
  return out;
}

/** How many times the area of the other end's object an object must be to count as its background. */
export const BACKDROP = 9;

/**
 * Whether a line end can attach to `o`: anything visible and unlocked except lines, legends and scale
 * bars. With `other`, the line's other end {pt: [x, y], obj: what it is attached to, or null}, also
 * not a background the line lies on: an object that end is inside, when that end is free or `o` holds
 * its object and is BACKDROP times its size. So a line drawn across a tissue drawing, or from a cell
 * to a spot on it, stays free, while one from a nucleus to its cell, or between overlapping icons,
 * connects. (Holding Ctrl while drawing passes no `other`: anything connects.)
 */
export function canConnect(o, other = null) {
  if (!o || o.type === "line" || isFurniture(o) || o.locked || o.hidden) return false;
  if (!other || !insideOutline(o, other.pt)) return true;
  const s = other.obj;
  if (!s) return false;
  const a = bbox(o), b = bbox(s);
  return !(a.w * a.h >= BACKDROP * b.w * b.h && insideOutline(o, [b.x + b.w / 2, b.y + b.h / 2]));
}

/** An object's outline as a polygon in document px (rotated boxes, ellipses, closed brushes; else its bounds). */
export function outline(o) {
  if (isBox(o)) {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2, hw = o.w / 2, hh = o.h / 2;
    let pts;
    if (o.type === "ellipse") {
      pts = [];
      for (let i = 0; i < 72; i++) pts.push([cx + hw * Math.cos((i * Math.PI) / 36), cy + hh * Math.sin((i * Math.PI) / 36)]);
    } else if (o.type === "rect" && o.radius > 0) {
      const r = Math.min(o.radius, hw, hh);
      pts = [];
      for (const [qx, qy, a0] of [[1, 1, 0], [-1, 1, 90], [-1, -1, 180], [1, -1, 270]]) {
        for (let k = 0; k <= 6; k++) {
          const a = ((a0 + k * 15) * Math.PI) / 180;
          pts.push([cx + qx * (hw - r) + r * Math.cos(a), cy + qy * (hh - r) + r * Math.sin(a)]);
        }
      }
    } else pts = [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]];
    return o.rot ? pts.map(([x, y]) => rotPt(x, y, cx, cy, o.rot)) : pts;
  }
  if (o.type === "membrane" && o.closed && o.pts.length > 2) return smoothPolyline(o.pts, true, 8);
  const b = bbox(o);
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
}

/** Whether a point lies inside an object's outline (even–odd rule). */
export function insideOutline(o, [px, py], poly = outline(o)) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[j];
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** How far an object's paint reaches past its outline polygon (half its stroke). */
function outlineReach(o) {
  if (o.type === "rect" || o.type === "ellipse") return o.stroke && o.stroke !== "none" ? (o.strokeWidth ?? 1.5) / 2 : 0;
  if (o.type === "membrane" && o.closed && o.pts.length > 2) {
    if (brushKind(o) === "freeform") return o.stroke === "none" ? 0 : (o.thickness ?? BRUSHES.freeform.T) / 2;
    return (o.thickness ?? BRUSHES[brushKind(o)].T) / 2;
  }
  return 0;
}

/** The centre a connector aims from: a box's centre, otherwise the middle of the bounds. */
function anchorCentre(o) {
  if (isBox(o)) return [o.x + o.w / 2, o.y + o.h / 2];
  const b = bbox(o);
  return [b.x + b.w / 2, b.y + b.h / 2];
}

/** Distance along the ray from (ox, oy) in unit direction (dx, dy) to the farthest crossing of a polygon (−1: none). */
function rayHit(poly, ox, oy, dx, dy) {
  let best = -1;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const s = ((ax - ox) * ey - (ay - oy) * ex) / den, u = ((ax - ox) * dy - (ay - oy) * dx) / den;
    if (s >= 0 && u >= -1e-9 && u <= 1 + 1e-9 && s > best) best = s;
  }
  return best;
}

/** Where a ray from inside `o` leaves its outline, `pad` px further out. */
export function outlinePoint(o, from, dir, pad = 0, poly = outline(o)) {
  let [dx, dy] = dir;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) [dx, dy] = [1, 0];
  else [dx, dy] = [dx / l, dy / l];
  let s = rayHit(poly, from[0], from[1], dx, dy);
  if (s < 0) s = 0;
  const r = s + outlineReach(o) + pad;
  return [from[0] + dx * r, from[1] + dy * r];
}

/** The points a connector's ends aim between: an attached end's target centre, a free end's own point. */
export function connectorRefs(o, find = findObj) {
  return ENDS.map(([k, x, y]) => {
    const t = o[k] && find(o[k].id);
    return t ? anchorCentre(t) : [o[x], o[y]];
  });
}

/**
 * Put connected line ends on their targets' outlines, facing the other end (straight lines aim at it,
 * curves at their control point, elbows leave square to the page). Ends whose target is gone, is the
 * line itself, or is also the other end's target are let go. Called before every render and commit.
 */
export function syncConnectors(objs = state.doc?.objects) {
  if (!objs) return;
  const lines = linesIn(objs);
  if (!lines.some((l) => l.from || l.to || Number.isFinite(l.elbowAt))) return;
  const index = new Map();
  const walk = (list) => list.forEach((o) => (index.set(o.id, o), o.children && walk(o.children)));
  walk(objs);
  const find = (id) => index.get(id) || null;
  for (const o of lines) {
    for (const [k] of ENDS) if (o[k] && (!find(o[k].id) || o[k].id === o.id)) delete o[k];
    if (o.from && o.to && o.from.id === o.to.id) delete o.to;
    if (!o.from && !o.to) {
      delete o.elbowAt;
      continue;
    }
    const pad = o.pad ?? 2;
    const T = ENDS.map(([k]) => (o[k] ? find(o[k].id) : null));
    const polys = T.map((t) => (t ? outline(t) : null));
    const refs = connectorRefs(o, find);
    if (isElbow(o)) {
      // the middle segment sits `bend` of the way between the two centres; each connected end
      // leaves from the side facing it, or straight up/down when the bend is within the object's width
      const h = elbowAxis(o) === "h", i = h ? 0 : 1, j = 1 - i;
      const m = refs[0][i] + (refs[1][i] - refs[0][i]) * (o.bend ?? 0.5);
      T.forEach((t, e) => {
        if (!t) return;
        const c = refs[e], other = refs[1 - e];
        const dPos = [0, 0], dNeg = [0, 0];
        dPos[i] = 1;
        dNeg[i] = -1;
        const lo = c[i] - Math.max(0, rayHit(polys[e], c[0], c[1], dNeg[0], dNeg[1]));
        const hi = c[i] + Math.max(0, rayHit(polys[e], c[0], c[1], dPos[0], dPos[1]));
        const from = [c[0], c[1]], dir = [0, 0];
        if (m > lo + 0.5 && m < hi - 0.5) {
          from[i] = m;
          dir[j] = Math.sign(other[j] - c[j]) || 1;
        } else dir[i] = Math.sign(m - c[i]) || 1;
        const p = outlinePoint(t, from, dir, pad, polys[e]);
        [o[ENDS[e][1]], o[ENDS[e][2]]] = p;
      });
      o.elbowAt = m;
      continue;
    }
    delete o.elbowAt;
    const place = (aims) => T.forEach((t, e) => {
      if (t) [o[ENDS[e][1]], o[ENDS[e][2]]] = outlinePoint(t, refs[e], [aims[e][0] - refs[e][0], aims[e][1] - refs[e][1]], pad, polys[e]);
    });
    place([refs[1], refs[0]]);
    // a curve leaves along its tangent: aim at the control point instead (a few times, as it moves with the ends)
    if (Math.abs(o.curve || 0) > 0.01) {
      for (let k = 0; k < 4; k++) {
        const c = ctrlPt(o);
        place([c, c]);
      }
    } else {
      // an end on an object inside the other one (a nucleus in its cell) faces where the other end
      // landed rather than that object's centre, so the line doesn't cross the inner object
      const e = T.findIndex((t, i) => t && T[1 - i] && insideOutline(T[1 - i], refs[i], polys[1 - i]));
      if (e >= 0) {
        const p = [o[ENDS[1 - e][1]], o[ENDS[1 - e][2]]];
        [o[ENDS[e][1]], o[ENDS[e][2]]] = outlinePoint(T[e], refs[e], [p[0] - refs[e][0], p[1] - refs[e][1]], pad, polys[e]);
      }
    }
  }
}

/** Let go of connector ends among `objs` whose targets are not moving with them; returns how many. */
export function detachConnectors(objs) {
  const ids = new Set();
  const walk = (o) => (ids.add(o.id), o.children?.forEach(walk));
  objs.forEach(walk);
  let n = 0;
  for (const l of linesIn(objs)) {
    for (const [k] of ENDS) {
      if (l[k] && !ids.has(l[k].id)) {
        delete l[k];
        n++;
      }
    }
  }
  return n;
}

/** Every icon asset id an object tree uses. */
export function assetsUsed(objs, out = new Set()) {
  for (const o of objs) {
    if (o.type === "icon" || (o.type === "membrane" && o.brush === "icon" && o.asset)) out.add(o.asset);
    if (o.type === "legend") for (const r of o.rows || []) if (r.asset) out.add(r.asset);
    if (o.children) assetsUsed(o.children, out);
  }
  return out;
}

/* ---------- history ---------- */

const hist = { stack: [], i: -1, max: 200 };

function snapshot() {
  const d = state.doc;
  return JSON.stringify({ w: d.width, h: d.height, bg: d.background, objects: d.objects });
}

export function resetHistory() {
  hist.stack = [snapshot()];
  hist.i = 0;
  state.dirty = false;
  bus.emit("history");
}

/** The figure's undo history, kept while another figure is open (adoptHistory brings it back). */
export const takeHistory = () => ({ stack: hist.stack, i: hist.i });

/** Use a figure's kept undo history again, if the figure is just as the history left it. */
export function adoptHistory(h) {
  if (!h?.stack?.length || h.stack[h.i] !== snapshot()) return false;
  hist.stack = h.stack;
  hist.i = h.i;
  bus.emit("history");
  return true;
}

/* ---------- style previews ---------- */

const previewEnds = new Set();
/**
 * A hovered style thumbnail shows its style on the real objects and registers here how to put them
 * back. Anything that records, saves, copies or exports the figure ends every preview first, so a
 * style the user only hovered over never reaches undo, a file or the clipboard.
 */
export function onPreviewEnd(fn) {
  previewEnds.add(fn);
}
export function endPreviews() {
  for (const fn of previewEnds) fn();
}

/** Record the current state as an undo step (no-op when nothing changed). */
export function commit() {
  endPreviews();
  syncConnectors();
  const s = snapshot();
  if (hist.stack[hist.i] === s) return false;
  hist.stack.splice(hist.i + 1);
  hist.stack.push(s);
  if (hist.stack.length > hist.max) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  state.dirty = true;
  bus.emit("history");
  bus.emit("doc");
  return true;
}

function restore(s) {
  const o = JSON.parse(s);
  Object.assign(state.doc, { width: o.w, height: o.h, background: o.bg, objects: o.objects });
  state.selection = state.selection.filter((id) => getObj(id));
  state.dirty = true;
  bus.emit("doc");
  bus.emit("selection");
  bus.emit("history");
}

export const canUndo = () => hist.i > 0;
export const canRedo = () => hist.i < hist.stack.length - 1;
export function undo() {
  if (canUndo()) restore(hist.stack[--hist.i]);
}
export function redo() {
  if (canRedo()) restore(hist.stack[++hist.i]);
}
