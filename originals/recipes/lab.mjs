// Lab equipment, Servier-like: light translucent-looking plastics and glass (very light blue-greys),
// coloured caps and liquids, light from the top left. Mostly front or slight 3/4 views.
import { circle, ellipse, rect, capsule, ribbon, smoothClosed, smoothOpen, polygon, polyline, rotatePts, scatter, rng, f } from "../lib/geom.mjs";
import { shade, tint } from "../lib/style.mjs";

/* ---------------- palette ---------------- */

const PLASTIC = "#e3edf4"; // clear polypropylene / polystyrene
const PLASTIC_D = "#cadbe7"; // thicker plastic: collars, rims, skirts
const GLASS = "#e0eff6";
const HI = "#f7fafc"; // highlight overlays (used with opacity)
const SHADOW = "#24303c"; // texture/shadow overlays (used with opacity)
const MARK = "#7f9db4"; // graduation marks
const FROST = "#f4f6f8"; // frosted writing areas, labels

/* ---------------- path helpers ---------------- */

const P = (x, y) => `${f(x)} ${f(y)}`;

/** Elliptical arc from angle a0 to a1 (degrees, y down: 90 = bottom) as cubic segments (no leading M). */
function arc(cx, cy, rx, ry, a0, a1) {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90));
  const da = (a1 - a0) / n;
  let s = "";
  for (let i = 0; i < n; i++) {
    const t0 = ((a0 + da * i) * Math.PI) / 180, t1 = ((a0 + da * (i + 1)) * Math.PI) / 180;
    const k = (4 / 3) * Math.tan((t1 - t0) / 4);
    const p0 = [cx + rx * Math.cos(t0), cy + ry * Math.sin(t0)];
    const p1 = [cx + rx * Math.cos(t1), cy + ry * Math.sin(t1)];
    s += `C${P(p0[0] - k * rx * Math.sin(t0), p0[1] + k * ry * Math.cos(t0))} ${P(p1[0] + k * rx * Math.sin(t1), p1[1] - k * ry * Math.cos(t1))} ${P(p1[0], p1[1])}`;
  }
  return s;
}

/** Silhouette of an upright cylinder seen slightly from above (top ellipse at y0, bottom at y1). */
const cyl = (cx, y0, y1, rx, ry) =>
  `M${P(cx - rx, y0)}L${P(cx - rx, y1)}` + arc(cx, y1, rx, ry, 180, 0) + `L${P(cx + rx, y0)}` + arc(cx, y0, rx, ry, 0, -180) + "Z";

/** The visible front wall of that cylinder (between the front halves of both ellipses). */
const band = (cx, y0, y1, rx, ry) =>
  `M${P(cx - rx, y0)}L${P(cx - rx, y1)}` + arc(cx, y1, rx, ry, 180, 0) + `L${P(cx + rx, y0)}` + arc(cx, y0, rx, ry, 0, 180) + "Z";

/** Parse absolute path data (M L H V C Z) into subpaths of segments. */
function parse(d) {
  const toks = d.match(/[MLHVCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const subs = [];
  let cur = null, pt = [0, 0], cmd = "M";
  for (let i = 0; i < toks.length; ) {
    if (/[a-z]/i.test(toks[i])) {
      cmd = toks[i++].toUpperCase();
      if (cmd === "Z") { if (cur) cur.closed = true; continue; }
    }
    const take = (k) => toks.slice(i, (i += k)).map(Number);
    if (cmd === "M") { pt = take(2); cur = { start: pt, segs: [], closed: false }; subs.push(cur); cmd = "L"; }
    else if (cmd === "L") { const p = take(2); cur.segs.push({ c: null, p }); pt = p; }
    else if (cmd === "H") { const p = [take(1)[0], pt[1]]; cur.segs.push({ c: null, p }); pt = p; }
    else if (cmd === "V") { const p = [pt[0], take(1)[0]]; cur.segs.push({ c: null, p }); pt = p; }
    else if (cmd === "C") { const v = take(6); const p = [v[4], v[5]]; cur.segs.push({ c: [[v[0], v[1]], [v[2], v[3]]], p }); pt = p; }
    else i++;
  }
  return subs;
}
const write = (subs) =>
  subs.map((s) => `M${P(...s.start)}` + s.segs.map((g) => (g.c ? `C${P(...g.c[0])} ${P(...g.c[1])} ${P(...g.p)}` : `L${P(...g.p)}`)).join("") + (s.closed ? "Z" : "")).join("");

/** Map every point of a path through fn([x,y]) → [x,y]. */
function mapPath(d, fn) {
  return write(parse(d).map((s) => ({ start: fn(s.start), closed: s.closed, segs: s.segs.map((g) => ({ c: g.c && g.c.map(fn), p: fn(g.p) })) })));
}
/** Scale (about cx,cy), rotate (deg, about cx,cy), then move. */
function tf(d, { rot = 0, cx = 0, cy = 0, sx = 1, sy = sx, dx = 0, dy = 0 } = {}) {
  const r = (rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return mapPath(d, ([x, y]) => {
    const X = (x - cx) * sx, Y = (y - cy) * sy;
    return [cx + X * c - Y * s + dx, cy + X * s + Y * c + dy];
  });
}
const tfAll = (ds, o) => ds.map((d) => tf(d, o));

/** Reverse the direction of every subpath (so it cuts a hole when appended to an outer path). */
function rev(d) {
  return write(parse(d).map((s) => {
    const pts = [s.start, ...s.segs.map((g) => g.p)];
    const segs = [];
    for (let k = s.segs.length - 1; k >= 0; k--) {
      const g = s.segs[k];
      segs.push({ c: g.c ? [g.c[1], g.c[0]] : null, p: pts[k] });
    }
    return { start: pts[pts.length - 1], segs, closed: s.closed };
  }));
}
/** Outer shape with holes. */
const holed = (outer, ...holes) => outer + holes.map(rev).join("");

/* ---------------- exact tube profiles ----------------
 * A tube seen from the front is built from exact pieces, never from a spline through sparse knots
 * (a Catmull–Rom through an 8-unit shoulder after a 200-unit wall overshoots into fangs):
 * walls from (ytop, ±hwTop) to the shoulder (ys, ±hw) → a fillet of radius rf → straight cone lines →
 * a round tip of radius rt whose lowest point is yb. */

/** Geometry of such a profile: apex of the cone lines, half-angle phi, tip-circle centre yc, wAt(y). */
function coneGeom({ cx, ytop, hwTop, hw, ys, yb, rt, rf = 4 }) {
  hwTop = hwTop ?? hw;
  let ya = yb + rt * 4;
  for (let i = 0; i < 60; i++) ya = yb + rt / Math.sin(Math.atan(hw / (ya - ys))) - rt;
  const phi = Math.atan(hw / (ya - ys));
  const yc = ya - rt / Math.sin(phi);
  const tl = [cx - rt * Math.cos(phi), yc + rt * Math.sin(phi)]; // tangent point of the tip circle (left)
  const wAt = (y) => {
    if (y <= ys) return hwTop + ((hw - hwTop) * (y - ytop)) / (ys - ytop);
    if (y <= tl[1]) return (hw * (ya - y)) / (ya - ys);
    const dy = y - yc;
    return Math.sqrt(Math.max(0, rt * rt - dy * dy));
  };
  return { cx, ytop, hwTop, hw, ys, yb, rt, rf, ya, phi, yc, tl, wAt };
}

/** The inside of a profile with walls `wall` thick (concentric tip, so the bottom wall is `wall` too). */
function innerGeom(g, wall) {
  const s = Math.sin(g.phi);
  const ya = g.ya - wall / s, hw = g.hw - wall;
  const rt = Math.max(1, g.rt - wall);
  return coneGeom({ cx: g.cx, ytop: g.ytop, hwTop: g.hwTop - wall, hw, ys: ya - hw / Math.tan(g.phi), yb: ya - rt / s + rt, rt, rf: Math.max(1.5, g.rf - wall) });
}

/** Closed outline of the profile below yFrom (the whole tube, or the liquid/pellet inside it); `top` = ry of a meniscus arc. */
function conePath(g, yFrom = g.ytop, { top = 0 } = {}) {
  const { cx, ys, rt, rf, ya, phi, yc, tl } = g;
  const nrm = (v) => { const l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; };
  const A = [cx - g.hw, ys];
  const dW = nrm([g.hwTop - g.hw, ys - g.ytop]), dC = nrm([g.hw, ya - ys]);
  const delta = Math.acos(Math.min(1, dW[0] * dC[0] + dW[1] * dC[1]));
  const t = rf * Math.tan(delta / 2), h = (4 / 3) * Math.tan(delta / 4) * rf;
  const F1 = [A[0] - dW[0] * t, A[1] - dW[1] * t], F2 = [A[0] + dC[0] * t, A[1] + dC[1] * t];
  const c1 = [F1[0] + dW[0] * h, F1[1] + dW[1] * h], c2 = [F2[0] - dC[0] * h, F2[1] - dC[1] * h];
  const mir = ([x, y]) => [2 * cx - x, y];
  const L0 = [cx - g.wAt(yFrom), yFrom];
  let aStart = 180 - (phi * 180) / Math.PI;
  let d = `M${P(...L0)}`;
  const full = yFrom < F1[1];
  if (full) d += `L${P(...F1)}C${P(...c1)} ${P(...c2)} ${P(...F2)}L${P(...tl)}`;
  else if (yFrom < tl[1]) d += `L${P(...tl)}`;
  else aStart = 180 - (Math.asin(Math.min(1, (yFrom - yc) / rt)) * 180) / Math.PI;
  d += arc(cx, yc, rt, rt, aStart, 180 - aStart);
  if (full) d += `L${P(...mir(F2))}C${P(...mir(c2))} ${P(...mir(c1))} ${P(...mir(F1))}L${P(...mir(L0))}`;
  else if (yFrom < tl[1]) d += `L${P(...mir(L0))}`;
  if (top) d += arc(cx, yFrom, g.wAt(yFrom), top, 0, -180);
  return d + "Z";
}

/** Volume scale of an inner profile drawn at K units/mm: ml → y of the liquid surface. */
function volumeScale(gi, K) {
  const rows = [];
  let v = 0;
  for (let y = gi.yb; y >= gi.ytop; y -= 0.2) {
    const w = gi.wAt(y) / K;
    v += (Math.PI * w * w * (0.2 / K)) / 1000;
    rows.push([y, v]);
  }
  return (ml) => (rows.find(([, vv]) => vv >= ml) || [gi.ytop])[0];
}

/** Horizontal graduation ticks running in from the right wall of profile g. */
function ticks(g, ys, len, inset = 2.4) {
  let d = "";
  for (const y of ys) {
    const w = g.wAt(y) - inset, l = Math.min(len, w * 0.6);
    d += `M${P(g.cx + w, y)}L${P(g.cx + w - l, y)}`;
  }
  return d;
}

/** Highlight streak down the lit (left) wall of profile g, `sw` wide, ending at y1 (may run into the cone). */
function wallStreak(g, y0, y1, sw, opacity = 0.7) {
  const pts = [];
  for (let k = 0; k <= 6; k++) {
    const y = y0 + ((y1 - y0) * k) / 6;
    pts.push([g.cx - g.wAt(y) + sw / 2 + 1.6, y]);
  }
  return streak(pts, sw, opacity, 0.7);
}

/** Overlay parts (recolour-proof): white highlight / dark shadow with opacity, soft style only. */
const glow = (d, opacity = 0.6, extra = {}) => ({ d, fill: HI, opacity, line: false, ...extra });
const dim = (d, opacity = 0.14, extra = {}) => ({ d, fill: SHADOW, opacity, line: false, ...extra });

/** A soft highlight streak along a polyline (left side of tubes, bottles). */
const streak = (pts, w, opacity = 0.65, taper = 0.7) => glow(ribbon(pts, w, { taper }), opacity);

/** Vertical grip ridges on a screw cap: soft (subtle dark overlay) + line (thin dark lines). */
function ridges(x0, x1, y0, y1, n) {
  let d = "";
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
    d += `M${P(x, y0)}L${P(x, y1)}`;
  }
  return [
    { d, fill: "none", stroke: { color: SHADOW, width: 1.6 }, opacity: 0.16, line: false },
    { d, fill: "none", stroke: { color: "#556677", width: 0.8 }, soft: false },
  ];
}

/* ---------------- tubes ---------------- */

/**
 * 1.5 mL microcentrifuge tube (front view), closed or with the lid hinged open.
 * To scale (≈3.3 units/mm): body Ø 10.8 mm × 39 mm — an 18 mm cylinder, then a 21 mm cone to a
 * rounded tip; collar Ø 13 mm; snap lid with a hinge strap on one side and an opening tab on the other.
 */
function microtube({ open = false, cap = "#5b9fe0", liquid = "#ab8fdd" } = {}) {
  const K = 3.3; // units per mm
  const cx = open ? 84 : 48;
  const y0 = open ? 74 : 25; // collar top
  // 18 mm slightly tapered cylinder, then a straight cone to a blunt rounded tip (Ø ≈ 3 mm)
  const g = coneGeom({ cx, ytop: y0 + 4, hwTop: 18.4, hw: 17.6, ys: y0 + 56, yb: y0 + 133, rt: 5, rf: 14 });
  const gi = innerGeom(g, 2.4);
  const yOf = volumeScale(gi, K);
  const parts = [];
  // body
  parts.push({ d: conePath(g), fill: PLASTIC, shade: "body", gloss: false, highlight: false });
  // liquid (0.4 mL)
  const lv = yOf(0.4);
  parts.push({ d: conePath(gi, lv, { top: 2.6 }), fill: liquid, shade: "body", gloss: false, lineWidth: 1 });
  parts.push(glow(ellipse(cx, lv, gi.wAt(lv), 2.6), 0.45));
  // graduation rings 0.1 / 0.5 / 1.0 / 1.5 mL, placed from the real volume of the drawn profile
  parts.push({ d: ticks(g, [0.1, 0.5, 1, 1.5].map(yOf), 6.5, 2.6), fill: "none", stroke: { color: MARK, width: 1.2 } });
  // frosted writing area
  parts.push({ d: rect(cx - 13.5, y0 + 12, 16, 26, 4), fill: FROST, opacity: 0.85, thin: true });
  // highlight streak
  parts.push(wallStreak(g, y0 + 10, y0 + 112, 3.6));
  if (!open) {
    // collar
    parts.push({ d: rect(cx - 23, y0 - 3, 46, 10, 3.5), fill: PLASTIC_D, shade: "rim" });
    // hinge strap (left) and a low snap lid (≈ 4 mm) with its opening tab (right)
    parts.push({ d: `M${P(cx - 22, y0 + 2)}C${P(cx - 31, y0 + 2)} ${P(cx - 31, y0 - 9)} ${P(cx - 21, y0 - 10)}`, fill: "none", stroke: { color: shade(cap, 0.08), width: 3.6, cap: "round" } });
    parts.push({ unite: [rect(cx - 21.5, y0 - 15, 43, 13, 5), capsule(cx + 19, y0 - 9, cx + 31, y0 - 9, 4)], fill: cap, shade: "body", glossAt: [0.2, 0.3], glossSize: 0.045 });
    parts.push(glow(rect(cx - 16, y0 - 12.6, 25, 2.8, 1.4), 0.55));
    return { size: [90, 168], parts };
  }
  // open: collar as a ring seen slightly from above, the opening, and the lid hinged up to the left
  parts.push({ d: cyl(cx, y0, y0 + 6, 23, 5), fill: PLASTIC_D, shade: "rim" });
  parts.push({ d: ellipse(cx, y0, 18.5, 3.6), fill: "#c3d5e2", shade: "dip", gloss: false });
  const hx = cx - 23, hy = y0 + 1, ang = -122;
  const lid = [rect(hx + 2, hy - 14, 44, 14, 5.5), rect(hx + 6.5, hy - 3, 35, 7.5, 2.5), capsule(hx + 44, hy - 7.5, hx + 56, hy - 7.5, 4.2)];
  parts.push({ d: `M${P(hx + 1, hy + 4)}C${P(hx - 8, hy + 4)} ${P(hx - 11, hy - 4)} ${P(hx - 6, hy - 9)}`, fill: "none", stroke: { color: shade(cap, 0.08), width: 3.6, cap: "round" } });
  parts.push({ unite: tfAll(lid, { rot: ang, cx: hx - 4, cy: hy - 6 }), fill: cap, shade: "body", glossAt: [0.3, 0.3], glossSize: 0.045 });
  return { size: [124, 214], parts };
}

/**
 * Conical centrifuge tube (Falcon type), drawn to scale at K units per mm so the 15 and 50 mL tubes
 * match each other:
 *   50 mL — Ø 30 × 115 mm, 20 mm cone, cap Ø 34.5 × 14 mm, graduations 5–50 mL every 2.5 mL;
 *   15 mL — Ø 17 × 120 mm, 22 mm cone, cap Ø 21 × 14 mm, graduations 0.5–15 mL every 0.5 mL.
 * Graduation heights come from the real volume of the cone + cylinder (1 mm wall).
 * Paint order: shadow copy → flat body → right-wall shade band → liquid → pellet → graduations → writing area →
 * highlight streak → cap.
 */
function conical({ dia, len, coneL, capD, capH, cap, grads, liquid = null, pellet = null, rt = 2.8, rf = 5 }) {
  const K = 1.9, m = 9;
  const hw = (dia * K) / 2, capW = capD * K, cH = capH * K;
  const W = Math.ceil(capW + 2 * m), H = Math.ceil(len * K + 2 * m);
  const cx = W / 2, yb = H - m, ytop = m + cH - 5, cone = coneL * K;
  // straight wall → filleted shoulder → straight cone → round tip (rt ≈ 1.5 mm)
  const g = coneGeom({ cx, ytop, hw, ys: yb - cone, yb, rt, rf });
  const gi = innerGeom(g, 2.2); // ≈ 1.2 mm polypropylene wall
  const yOf = volumeScale(gi, K); // volume (mL) → liquid level, from the real cone + cylinder
  const parts = [];
  // Soft look made by hand: the renderer's rim scales with the tube's height (≈ 7 units), which on the narrow cone
  // of the 15 mL tube becomes a dark wedge over half its width. Instead: a thin shadow copy offset to the bottom
  // right, the flat body, and a narrow shade band inside the right wall that follows the cone into the tip.
  parts.push({ d: tf(conePath(g), { dx: 1.8, dy: 1.4 }), fill: shade(PLASTIC, 0.12), line: false });
  parts.push({ d: conePath(g), fill: PLASTIC });
  {
    const sw0 = Math.max(3, hw * 0.3), outer = [], inner = [];
    for (let y = ytop + 3; y <= g.tl[1]; y += 1.5) {
      const w = g.wAt(y), sw = Math.min(sw0, w * 0.42);
      outer.push([cx + w - 0.8, y]);
      inner.push([cx + w - 0.8 - sw, y]);
    }
    parts.push(dim(polygon([...outer, ...inner.reverse()]), 0.1));
  }
  if (liquid) {
    const lv = yOf(liquid.ml);
    parts.push({ d: conePath(gi, lv, { top: 3 }), fill: liquid.color, shade: "body", gloss: false, lineWidth: 1 });
    parts.push(glow(ellipse(cx, lv, gi.wAt(lv), 3), 0.42));
  }
  if (pellet) {
    const gp = innerGeom(g, 2.8), py = gp.yb - 9;
    parts.push({ d: conePath(gp, py, { top: 1.8 }), fill: pellet, shade: "small", gloss: false, lineWidth: 1 });
  }
  // graduations on the right: long ticks every `major` mL, short ones between
  const [from, to, step, major] = grads;
  const longs = [], shorts = [];
  for (let v = from; v <= to + 1e-6; v += step) (Math.abs(v / major - Math.round(v / major)) < 1e-6 ? longs : shorts).push(yOf(v));
  parts.push({ d: ticks(g, longs, hw * 0.5), fill: "none", stroke: { color: MARK, width: 1.2 } });
  parts.push({ d: ticks(g, shorts, hw * 0.26), fill: "none", stroke: { color: MARK, width: 0.9 } });
  // frosted writing area (front left), highlight streak along the lit side, ending just into the cone
  const yTop50 = yOf(to);
  parts.push({ d: rect(cx - hw + 3.2, yTop50 + 6, hw * 0.62, (yOf(from) - yTop50) * 0.46, 2.5), fill: FROST, opacity: 0.85, thin: true });
  parts.push(wallStreak(g, ytop + 8, g.ys + cone * 0.3, Math.max(3, hw * 0.2)));
  // ridged screw cap, slightly wider than the tube
  parts.push({ d: rect(cx - capW / 2, m, capW, cH, 3.5), fill: cap, shade: "body", gloss: false });
  parts.push(...ridges(cx - capW / 2 + 3, cx + capW / 2 - 3, m + 5, m + cH - 4, Math.round(capW / 4.4)));
  parts.push(glow(rect(cx - capW / 2 + 3, m + 2.4, capW - 6, 3, 1.5), 0.5));
  return { size: [W, H], parts };
}

/** Cryogenic vial: external-thread ridged cap, writing area, self-standing skirt. */
function cryovial({ cap = "#8c6cc4", liquid = "#f2a9bd" } = {}) {
  const cx = 50, hw = 21, yt = 58, yb = 190;
  const parts = [];
  // body with a flat, slightly rounded foot
  const k = 0.55;
  parts.push({
    d: `M${P(cx - hw, yt)}L${P(cx - hw, yb - 5)}C${P(cx - hw, yb - 5 + 5 * k)} ${P(cx - hw + 5 - 5 * k, yb)} ${P(cx - hw + 5, yb)}` +
      `L${P(cx + hw - 5, yb)}C${P(cx + hw - 5 + 5 * k, yb)} ${P(cx + hw, yb - 5 + 5 * k)} ${P(cx + hw, yb - 5)}L${P(cx + hw, yt)}Z`,
    fill: PLASTIC, shade: "body", gloss: false,
  });
  // inner rounded bottom (where the tube ends inside the skirt)
  const ib = yb - 20;
  const gl = coneGeom({ cx, ytop: 100, hw: hw - 2.6, ys: ib - 12, yb: ib, rt: 7, rf: 6 });
  parts.push({ d: conePath(gl, 100, { top: 3.2 }), fill: liquid, shade: "body", gloss: false, lineWidth: 1 });
  parts.push(glow(ellipse(cx, 100, hw - 2.6, 3.2), 0.42));
  // the skirt (foot) seen through the plastic
  parts.push({ d: `M${P(cx - hw + 2, ib + 2)}C${P(cx - 8, ib + 6)} ${P(cx + 8, ib + 6)} ${P(cx + hw - 2, ib + 2)}`, fill: "none", stroke: { color: MARK, width: 1.2 }, opacity: 0.8 });
  // writing area + graduations
  parts.push({ d: rect(cx - hw + 3, yt + 10, 22, 70, 3), fill: FROST, opacity: 0.9, thin: true });
  parts.push({ d: [112, 124, 136, 148, 160].map((y, i) => `M${P(cx + hw - 3, y)}L${P(cx + hw - 3 - (i % 2 ? 5 : 8), y)}`).join(""), fill: "none", stroke: { color: MARK, width: 1.2 } });
  parts.push(streak([[cx - hw + 3, yt + 6], [cx - hw + 3, yb - 8]], 3.6, 0.55, 0.4));
  // cap
  parts.push({ d: rect(cx - hw - 4, 12, (hw + 4) * 2, 50, 6), fill: cap, shade: "body", gloss: false });
  parts.push(...ridges(cx - hw - 1, cx + hw + 1, 20, 58, 9));
  parts.push(glow(rect(cx - hw, 14.5, (hw) * 2, 3.4, 1.7), 0.5));
  return { size: [100, 200], parts };
}

/** Strip of 8 PCR tubes with an attached strip of domed caps. */
function pcrStrip({ cap = "#9fd38e", liquid = "#8fc0ea" } = {}) {
  const parts = [];
  const xs = Array.from({ length: 8 }, (_, i) => 31 + i * 34);
  // 0.2 mL tube: short cylinder, a filleted shoulder, a long cone to a small round tip
  const geo = xs.map((x) => coneGeom({ cx: x, ytop: 48, hwTop: 13, hw: 12.4, ys: 74, yb: 136, rt: 1.8, rf: 9 }));
  parts.push({ d: geo.map((g) => conePath(g)), fill: PLASTIC, shade: "body", gloss: false });
  parts.push({ d: geo.map((g) => conePath(innerGeom(g, 2.2), 104, { top: 2 })), fill: liquid, shade: "rim", gloss: false, lineWidth: 1 });
  parts.push({ d: geo.map((g) => wallStreak(g, 52, 112, 3).d), fill: HI, opacity: 0.7, line: false });
  // the connecting web between tubes
  parts.push({ d: rect(14, 42, 272, 8, 3), fill: PLASTIC_D });
  parts.push(dim(rect(16, 47, 268, 3, 1.5), 0.08));
  // caps
  parts.push({ d: rect(18, 34, 264, 5, 2.5), fill: cap });
  parts.push({ d: xs.map((x) => rect(x - 14, 20, 28, 22, 8)), fill: cap, shade: "body", gloss: false });
  parts.push({ d: xs.map((x) => rect(x - 9, 23, 13, 3, 1.5)), fill: HI, opacity: 0.6, line: false });
  return { size: [300, 146], parts };
}

/* ---------------- icon list ---------------- */

export const icons = [
  {
    slug: "microcentrifuge-tube", name: "Microcentrifuge tube (closed)", category: "lab",
    tags: ["Eppendorf tube", "microtube", "1.5 mL tube", "1.5 ml", "2 mL tube", "microfuge tube", "microcentrifuge", "snap-cap tube", "safe-lock tube", "sample tube", "centrifuge tube", "reaction tube", "closed"],
    scene: () => microtube(),
  },
  {
    slug: "microcentrifuge-tube-open", name: "Microcentrifuge tube (open lid)", category: "lab",
    tags: ["Eppendorf tube", "microtube", "1.5 mL tube", "1.5 ml", "microfuge tube", "microcentrifuge", "open", "hinged lid", "flip cap", "snap-cap tube", "sample tube", "reaction tube"],
    scene: () => microtube({ open: true }),
  },
  {
    slug: "conical-tube-15ml", name: "Conical tube, 15 mL", category: "lab",
    tags: ["Falcon tube", "15 mL", "15 ml", "conical", "centrifuge tube", "screw cap", "graduated tube", "polypropylene tube", "Corning", "Greiner", "sample preparation"],
    scene: () => conical({ dia: 17, len: 120, coneL: 22, capD: 21, capH: 14, cap: "#f0a03c", grads: [0.5, 15, 0.5, 1] }),
  },
  {
    slug: "conical-tube-50ml", name: "Conical tube, 50 mL (supernatant and pellet)", category: "lab",
    tags: ["Falcon tube", "50 mL", "50 ml", "conical", "centrifuge tube", "pellet", "supernatant", "centrifugation", "cell pellet", "polypropylene tube", "screw cap", "graduated tube", "Corning", "Greiner", "sample preparation", "cell suspension"],
    scene: () => conical({ dia: 30, len: 115, coneL: 20, capD: 34.5, capH: 14, cap: "#3f80cc", grads: [5, 50, 2.5, 5], liquid: { ml: 30, color: "#f4a3bf" }, pellet: "#c9566f" }),
  },
  {
    slug: "cryovial", name: "Cryovial", category: "lab",
    tags: ["cryotube", "cryogenic vial", "freezing vial", "cryopreservation", "liquid nitrogen", "LN2", "-80", "screw cap", "external thread", "2 mL vial", "biobank", "biobanking", "sample storage", "frozen cells", "DMSO"],
    scene: () => cryovial(),
  },
  {
    slug: "pcr-tube-strip", name: "PCR tube strip (8 tubes)", category: "lab",
    tags: ["PCR tubes", "8-strip", "8-tube strip", "0.2 mL tubes", "0.2 ml", "strip tubes", "strip caps", "qPCR", "RT-qPCR", "thermocycler", "thermal cycler", "PCR", "amplification", "library prep"],
    scene: () => pcrStrip(),
  },
];
