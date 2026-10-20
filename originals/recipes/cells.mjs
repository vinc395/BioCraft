// Non-immune cell types, Servier-like: pastel cytoplasm, mauve/purple nuclei, light from top left.
//
// Cells with long, thin processes (neurons, glia, fibroblasts…) are not shaded by the renderer's
// crescents: those scale with the part's bounding box, so on a long cell the rim gets far too thick
// and the inset highlight drifts off thin processes. For those, `softCell` builds the soft look
// itself: a shadow copy whose offset follows the local thickness (a thin dark rim along every
// bottom-right edge), the flat body, a light band inside the lit edge of the cell body and gloss dots.
import { blob, blobPts, circle, ellipse, rect, capsule, smoothClosed, smoothOpen, scatter, polygon, polyline, rotate, rng, f } from "../lib/geom.mjs";
import { assertInside, inFrame, unevenSpacing } from "../lib/organic.mjs";
import { shade, tint } from "../lib/style.mjs";

/* ---------- geometry helpers ---------- */

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dots = (pts, r) => pts.map(([x, y]) => circle(x, y, r));
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

function crPoint(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const q = (j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
  return [q(0), q(1)];
}

/** Evenly spaced points (≈ step apart) along a smooth open curve through pts. */
function along(pts, step = 5) {
  const dense = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    for (let k = 0; k < 30; k++) dense.push(crPoint(p0, p1, p2, p3, k / 30));
  }
  dense.push(pts[n - 1]);
  const out = [dense[0]];
  let acc = 0;
  for (let i = 1; i < dense.length; i++) {
    acc += dist(dense[i], dense[i - 1]);
    if (acc >= step) { out.push(dense[i]); acc = 0; }
  }
  const last = dense[dense.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.45) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Dense points along the closed smooth curve through pts (as smoothClosed draws it). */
function loop(pts, per = 10) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let k = 0; k < per; k++) out.push(crPoint(p0, p1, p2, p3, k / per));
  }
  return out;
}

/** Point, unit direction and angle (deg) at fraction t (by arc length) of a smooth curve through pts. */
function at(pts, t) {
  const c = along(pts, 1.5);
  const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + dist(c[i], c[i - 1]));
  const L = cum[cum.length - 1] * t;
  let i = cum.findIndex((v) => v >= L);
  if (i <= 0) i = 1;
  const a = c[i - 1], b = c[i], l = dist(a, b) || 1;
  return { p: b, dir: [(b[0] - a[0]) / l, (b[1] - a[1]) / l], ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
}

/** Translate absolute path data (M L H V C Q Z). */
function movePath(d, dx, dy) {
  const toks = d.match(/[MLHVCQZ]|-?\d*\.?\d+/gi) || [];
  let out = "", cmd = "", k = 0;
  for (const t of toks) {
    if (/^[A-Z]$/i.test(t)) { cmd = t.toUpperCase(); out += cmd; k = 0; continue; }
    const v = Number(t);
    const nv = cmd === "H" ? v + dx : cmd === "V" ? v + dy : v + (k % 2 === 0 ? dx : dy);
    out += (k ? " " : "") + f(nv);
    k++;
  }
  return out;
}

/**
 * Outline around a centreline `pts` with half-width w(t) (t = 0..1 by arc length), as closed points.
 * `shift(hw)` moves each sample diagonally (used for the soft-style shadow copy).
 */
function tubePts(pts, w, { step = 5, shift = null } = {}) {
  const c = along(pts, step);
  const n = c.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(c[i], c[i - 1]));
  const total = cum[n - 1] || 1;
  const hw = (i) => (typeof w === "function" ? w(cum[i] / total) : w);
  const s = (i) => (shift ? shift(hw(i)) : 0);
  const left = [], right = [], hl = [], hr = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    left.push([c[i][0] - (dy / l) * hw(i) + s(i), c[i][1] + (dx / l) * hw(i) + s(i)]);
    right.push([c[i][0] + (dy / l) * hw(i) + s(i), c[i][1] - (dx / l) * hw(i) + s(i)]);
    hl.push(hw(i));
  }
  const u = (a, b) => { const l = dist(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const ue = u(c[n - 2], c[n - 1]), us = u(c[1], c[0]);
  const tip = [c[n - 1][0] + ue[0] * hw(n - 1) * 0.9 + s(n - 1), c[n - 1][1] + ue[1] * hw(n - 1) * 0.9 + s(n - 1)];
  const base = [c[0][0] + us[0] * hw(0) * 0.9 + s(0), c[0][1] + us[1] * hw(0) * 0.9 + s(0)];
  const outline = [...left, tip, ...right.reverse(), base];
  const hws = [...hl, hl[n - 1], ...hl.slice().reverse(), hl[0]];
  return { outline, hws };
}
const tube = (pts, w, o = {}) => smoothClosed(tubePts(pts, w, o).outline);

/** Half-width profile: `base` at the root falling to `tip`, faster near the root when p > 1 (a flared process). */
const taper = (base, tip, p = 1.6) => (t) => tip + (base - tip) * Math.pow(1 - t, p);

/* ---------- soft-style pieces: each has a shape `d` and its shadow copy `sd` ---------- */

const SH = { max: 3, k: 0.32 }; // shadow offset: min(max, k × local half-width) — 3 matches the blob pieces' offset
const shadowShift = (max = SH.max, k = SH.k) => (hw) => Math.min(max, k * hw);

/**
 * A tapered process (dendrite, filopodium, canaliculus) from (x0,y0) heading `ang`°, `len` long, bending `bend`°.
 * `flare` adds a short widening (over `flareU` units) where the process meets its cell body.
 * The piece carries hw(t) (its half-width profile) and seg, so side branches can be sized from their parent.
 */
function proc(x0, y0, ang, len, { bend = 0, base = 6, tip = 1, p = 1.8, seg = 4, wave = 0, seed = 1, flare = 0, flareU = 9 } = {}) {
  const pts = [[x0, y0]];
  const R = rng(seed);
  let a = (ang * Math.PI) / 180, x = x0, y = y0;
  const da = ((bend * Math.PI) / 180) / seg;
  for (let i = 0; i < seg; i++) {
    x += Math.cos(a) * (len / seg);
    y += Math.sin(a) * (len / seg);
    pts.push([x, y]);
    a += da + (wave ? ((R() - 0.5) * wave * Math.PI) / 180 : 0);
  }
  const tp = taper(base, tip, p);
  const hw = flare ? (t) => tp(t) + flare * Math.pow(Math.max(0, 1 - (t * len) / flareU), 2) : tp;
  return { ...piece(pts, hw), hw, seg };
}

/** Root for a side branch at q.pts[k], moved `back` units back along the parent (so the joint is buried in it). */
function rootBack(q, k, back = 2.5) {
  const p = q.pts[k], a = q.pts[k - 1], l = dist(p, a) || 1;
  return [p[0] + ((a[0] - p[0]) / l) * back, p[1] + ((a[1] - p[1]) / l) * back];
}
/** Direction (deg) of process q at its point k. */
const dirAt = (q, k) => {
  const a = q.pts[Math.max(0, k - 1)], b = q.pts[Math.min(q.pts.length - 1, k + 1)];
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
};

/** A tube piece through `pts` with half-width w(t). */
function piece(pts, w, o = {}) {
  return { pts, d: tube(pts, w, o), sd: smoothClosed(tubePts(pts, w, { ...o, shift: shadowShift() }).outline), geo: tubePts(pts, w, o) };
}

/** Outline round a centreline with separate half-widths for the upper (−n) and lower (+n) side (irregular cell bodies). */
function tubeSides(pts, wTop, wBot, { step = 4, shift = null } = {}) {
  const c = along(pts, step), n = c.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(c[i], c[i - 1]));
  const T = cum[n - 1] || 1;
  const bot = [], top = [], hb = [], ht = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const t = cum[i] / T, wb = wBot(t), wt = wTop(t);
    const sb = shift ? shift(wb) : 0, st = shift ? shift(wt) : 0;
    bot.push([c[i][0] - (dy / l) * wb + sb, c[i][1] + (dx / l) * wb + sb]);
    top.push([c[i][0] + (dy / l) * wt + st, c[i][1] - (dx / l) * wt + st]);
    hb.push(wb);
    ht.push(wt);
  }
  const u = (a, b) => { const l = dist(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const ue = u(c[n - 2], c[n - 1]), us = u(c[1], c[0]);
  const he = (hb[n - 1] + ht[n - 1]) / 2, hs = (hb[0] + ht[0]) / 2;
  const se = shift ? shift(he) : 0, ss = shift ? shift(hs) : 0;
  const tip = [c[n - 1][0] + ue[0] * he * 0.9 + se, c[n - 1][1] + ue[1] * he * 0.9 + se];
  const base = [c[0][0] + us[0] * hs * 0.9 + ss, c[0][1] + us[1] * hs * 0.9 + ss];
  return { outline: [...bot, tip, ...top.reverse(), base], hws: [...hb, he, ...ht.slice().reverse(), hs] };
}
function sidedPiece(pts, wTop, wBot, o = {}) {
  const geo = tubeSides(pts, wTop, wBot, o);
  return { pts, d: smoothClosed(geo.outline), sd: smoothClosed(tubeSides(pts, wTop, wBot, { ...o, shift: shadowShift() }).outline), geo };
}

/**
 * A sheet-like lobe (lamellipodium, dendritic-cell veil) from `origin` heading `ang`°: neck half-width hw0,
 * `len` long, front half-width hw1, with a wavy, bulging free edge. P(u, v) maps local → page coordinates.
 */
function fanPiece(origin, ang, len, hw0, hw1, { seed = 1, wav = 0.12, sh = 2.8, bulge = 0.22, m = 7 } = {}) {
  const R = rng(seed), a = (ang * Math.PI) / 180, U = [Math.cos(a), Math.sin(a)], V = [-U[1], U[0]];
  const P = (u, v) => [origin[0] + U[0] * u + V[0] * v, origin[1] + U[1] * u + V[1] * v];
  const pts = [P(0, hw0), P(len * 0.45, hw0 + (hw1 - hw0) * 0.55)];
  for (let k = 0; k <= m; k++) {
    const s = 1 - (2 * k) / m; // +1 → −1 across the free edge
    pts.push(P(len * (0.8 + bulge * Math.sqrt(1 - s * s)) * (1 + (R() - 0.5) * wav), hw1 * s * (1 + (R() - 0.5) * wav * 0.6)));
  }
  pts.push(P(len * 0.45, -(hw0 + (hw1 - hw0) * 0.55)), P(0, -hw0));
  const d = smoothClosed(pts);
  return { d, sd: movePath(d, sh, sh), outline: loop(pts, 10), P, edgeU: (s) => len * (0.8 + bulge * Math.sqrt(Math.max(0, 1 - s * s))) };
}

/** Concave fillet of radius r in the corner at C between two edges leaving C along unit vectors d1, d2 (unite it). */
function filletPoly(C, d1, d2, r, n = 10) {
  const th = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
  const t = r / Math.tan(th / 2), h = r / Math.sin(th / 2);
  const T1 = [C[0] + d1[0] * t, C[1] + d1[1] * t], T2 = [C[0] + d2[0] * t, C[1] + d2[1] * t];
  const bl = Math.hypot(d1[0] + d2[0], d1[1] + d2[1]) || 1;
  const O = [C[0] + ((d1[0] + d2[0]) / bl) * h, C[1] + ((d1[1] + d2[1]) / bl) * h];
  const a1 = Math.atan2(T1[1] - O[1], T1[0] - O[0]);
  let da = Math.atan2(T2[1] - O[1], T2[0] - O[0]) - a1;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const arcPts = [];
  for (let k = 0; k <= n; k++) arcPts.push([O[0] + r * Math.cos(a1 + (da * k) / n), O[1] + r * Math.sin(a1 + (da * k) / n)]);
  return polygon([C, ...arcPts]);
}

/** Intersection of the lines a + s·da and b + t·db. */
function meet(a, da, b, db) {
  const den = da[0] * db[1] - da[1] * db[0];
  const s = ((b[0] - a[0]) * db[1] - (b[1] - a[1]) * db[0]) / den;
  return [a[0] + da[0] * s, a[1] + da[1] * s];
}
const unit = (a, b) => { const l = dist(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };

/** A blob piece (cell body, soma). */
function blobPiece(cx, cy, rx, ry, o = {}, sh = 3) {
  const pts = blobPts(cx, cy, rx, ry, o);
  return { d: smoothClosed(pts, o.tension ?? 1), sd: movePath(smoothClosed(pts, o.tension ?? 1), sh, sh), outline: loop(pts, 10) };
}

/** Light band just inside the lit (top-left) edge of a closed outline given as dense points. */
function litBand(outline, { inset = 2.5, width = 8, min = 0.15, pow = 0.85, weight = null } = {}) {
  const n = outline.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = outline[i], b = outline[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sg = area > 0 ? 1 : -1;
  const g = [], N = [];
  for (let i = 0; i < n; i++) {
    const a = outline[(i - 1 + n) % n], b = outline[(i + 1) % n];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    const nx = (sg * ty) / l, ny = (-sg * tx) / l;
    N.push([nx, ny]);
    const lit = -(nx + ny) * Math.SQRT1_2;
    let v = lit > min ? Math.pow((lit - min) / (1 - min), pow) : 0;
    if (weight) v *= weight(i);
    g.push(v);
  }
  // longest cyclic run of lit points
  let start = g.findIndex((v) => v <= 0.02);
  if (start < 0) start = 0;
  let best = [], cur = [];
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (g[i] > 0.02) cur.push(i);
    else { if (cur.length > best.length) best = cur; cur = []; }
  }
  if (cur.length > best.length) best = cur;
  if (best.length < 3) return null;
  const outer = best.map((i) => [outline[i][0] - N[i][0] * inset, outline[i][1] - N[i][1] * inset]);
  const inner = best.map((i) => [outline[i][0] - N[i][0] * (inset + width * g[i]), outline[i][1] - N[i][1] * (inset + width * g[i])]);
  return smoothClosed([...outer, ...inner.reverse()]);
}

/** Servier-style specular dots: an oval and a small dot up-right of it. */
function glossDots(cx, cy, r) {
  return [ellipse(cx, cy, r, r * 0.62, -38), circle(cx + r * 2, cy - r * 0.9, r * 0.38)];
}

/**
 * Parts for a cell drawn as one silhouette (body + processes) with hand-made soft shading.
 * pieces: [{d, sd}] · band: path or null · gloss: [cx, cy, r] or null.
 */
function softCell(pieces, fill, { band = null, gloss = null, rim = 0.1 } = {}) {
  const parts = [
    { unite: pieces.map((p) => p.sd), fill: shade(fill, rim), line: false },
    { unite: pieces.map((p) => p.d), fill },
  ];
  if (band) parts.push({ d: band, fill: tint(fill, 0.12), opacity: 0.85, line: false });
  if (gloss) parts.push({ unite: glossDots(...gloss), fill: "#ffffff", opacity: 0.8, line: false });
  return parts;
}

/** Rounded polygon: corners cut with radius r (one radius, or one per corner). */
function roundPoly(pts, r) {
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const rr = Array.isArray(r) ? r[i] : r;
    const la = dist(p, a), lb = dist(p, b);
    const ra = Math.min(rr, la / 2), rb = Math.min(rr, lb / 2);
    const p1 = [p[0] + ((a[0] - p[0]) / la) * ra, p[1] + ((a[1] - p[1]) / la) * ra];
    const p2 = [p[0] + ((b[0] - p[0]) / lb) * rb, p[1] + ((b[1] - p[1]) / lb) * rb];
    const k = 0.55;
    d += `${i ? "L" : "M"}${f(p1[0])} ${f(p1[1])}C${f(p1[0] + (p[0] - p1[0]) * k)} ${f(p1[1] + (p[1] - p1[1]) * k)} ${f(p2[0] + (p[0] - p2[0]) * k)} ${f(p2[1] + (p[1] - p2[1]) * k)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

/** Vertical segments (path data): for each x in xs, from top(x) to bottom(x). */
function vlines(xs, top, bottom) {
  return xs.map((x) => `M${f(x)} ${f(top(x))}L${f(x)} ${f(bottom(x))}`).join("");
}

/* ---------- frame / containment checks (warn in the build output) ---------- */

function checkFrame(label, pieces, W, H, margin = 4) {
  for (const [i, p] of pieces.entries()) {
    if (!inFrame(p.d ?? p, [0, 0, W, H], margin)) console.warn(`  ! frame: ${label} piece ${i} pokes out of the ${W}×${H} art box`);
  }
}

/** proc() shortened (and its base kept) until the whole process lies inside the [W, H] art box with `margin`. */
function procFit(x0, y0, ang, len, o, [W, H, margin = 4]) {
  let q;
  for (let k = 0; k < 14; k++, len *= 0.9) {
    q = proc(x0, y0, ang, len, o);
    if (inFrame(q.d, [0, 0, W, H], margin)) return q;
  }
  console.warn(`  ! frame: process at ${x0},${y0} → ${ang}° does not fit`);
  return q;
}

/** Local frame of a rod from P0 to P1: W([u, v]) → page, u along the rod, v across (+v = right of travel). */
function rodFrame(P0, P1) {
  const L = dist(P0, P1), u = [(P1[0] - P0[0]) / L, (P1[1] - P0[1]) / L], v = [-u[1], u[0]];
  return { L, W: ([a, b]) => [P0[0] + u[0] * a + v[0] * b, P0[1] + u[1] * a + v[1] * b] };
}

/* ---------- icons ---------- */

export const icons = [
  {
    slug: "fibroblast", name: "Fibroblast", category: "cells",
    tags: ["fibroblast", "fibroblasts", "fibrocyte", "connective tissue", "stromal cell", "stroma", "mesenchymal cell", "spindle cell", "stellate cell",
      "collagen", "ECM", "extracellular matrix", "myofibroblast", "vimentin", "PDGFRA", "PDGFRB", "PDPN", "podoplanin", "THY1", "CD90", "FAP", "COL1A1", "DCN",
      "wound healing", "fibrosis", "CAF", "cancer-associated fibroblast", "synovial fibroblast", "FLS"],
    scene: () => {
      // 300 × 150. Migrating fibroblast after Servier fibroblast-1/-3, with the leading pole on the right.
      // Paint order: shadow copy (rim) → united cell (body + tail + lateral processes + lamellipodium + filopodia) →
      // lit band → gloss → nucleus.
      // Body: an irregular spindle about 170 × 44. Each long edge has three shallow concavities between the processes,
      // so the margin is scalloped rather than a smooth lens. A thin, sinuous trailing tail (≈ 65) runs off the left
      // pole. The front widens into a fan-shaped lamellipodium (≈ 33 wide) with a wavy free edge and three short
      // filopodia. Five lateral processes of uneven length (17–54) leave 34–48° off the body axis, never perpendicular.
      // They are wavy and blunt-tipped, with bases ≤ 0.58× the local body half-width, rooted 9 units inside the edge.
      const W = 300, H = 150, fill = "#ef9fbf";
      const spine = [[14, 120], [31, 109], [49, 109], [68, 100], [102, 89], [142, 79], [182, 71], [216, 64], [240, 59]].map(([x, y]) => [x + 12, y]);
      const prof = (t) => 1.9 + 3.4 * smooth(0, 0.3, t) + 17 * Math.pow(Math.sin(Math.PI * clamp((t - 0.24) / 0.72)), 1.1);
      const dips = (list) => (t) => prof(t) * (1 - list.reduce((a, [c, dep, s]) => a + dep * Math.exp(-(((t - c) / s) ** 2)), 0));
      const wTop = dips([[0.34, 0.16, 0.045], [0.58, 0.14, 0.05], [0.84, 0.2, 0.04]]);
      const wBot = dips([[0.39, 0.18, 0.045], [0.59, 0.15, 0.04], [0.79, 0.18, 0.04]]);
      const body = sidedPiece(spine, wTop, wBot, { step: 3 });
      const box = [W, H, 4];
      const lateral = [ // side (−1 upper, +1 lower), t on the spine, angle off the axis°, length, bend°, seed
        [-1, 0.45, -138, 50, -24, 3],
        [-1, 0.63, -44, 34, 18, 4],
        [1, 0.49, 140, 54, 20, 5],
        [1, 0.69, 44, 27, -32, 6],
        [1, 0.8, 36, 18, 14, 7],
      ];
      const roots = [];
      const ps = lateral.map(([side, t, off, len, bend, seed]) => {
        const A = at(spine, t), n = [-A.dir[1], A.dir[0]], ws = (side < 0 ? wTop : wBot)(t);
        roots.push([A.p[0] + side * n[0] * ws, A.p[1] + side * n[1] * ws]);
        return procFit(A.p[0] + side * n[0] * (ws - 9), A.p[1] + side * n[1] * (ws - 9), A.ang + off, len + 9,
          { bend, base: Math.min(0.58 * ws, 11), tip: 1.8, p: 1.5, seg: 5, wave: 24, seed }, box);
      });
      // leading lamellipodium with filopodia
      const Lp = at(spine, 0.84);
      // The fan starts where the body is still broad (t 0.84) and flares gently, so the front widens into the
      // lamellipodium instead of narrowing to a neck and opening into a "hand"; short filopodia spread along its front.
      const fanW = 16.5;
      const fan = fanPiece(Lp.p, Lp.ang, 44, 10, fanW, { seed: 9, wav: 0.1, sh: 2.6, bulge: 0.24, m: 9 });
      const spikes = [[-0.55, -12, 6], [0.05, 3, 9], [0.62, 18, 5]].map(([s, da, len], i) =>
        procFit(...fan.P(fan.edgeU(s) - 4, fanW * s), Lp.ang + da, len + 4, { base: 2, tip: 1.1, p: 1.2, seg: 3, wave: 12, seed: 20 + i }, box));
      const geo = body.geo;
      const band = litBand(geo.outline, { inset: 2.6, width: 8.5, weight: (i) => smooth(9, 17, geo.hws[i]) * Math.min(...roots.map((r) => smooth(7, 14, dist(geo.outline[i], r)))) });
      const N = at(spine, 0.6);
      const nuc = ellipse(N.p[0], N.p[1] + 1, 23, 10.5, N.ang + 4);
      assertInside("fibroblast nucleus", nuc, body.d, 3);
      const G = at(spine, 0.5), gn = [-G.dir[1], G.dir[0]], gw = wTop(0.5) * 0.55;
      checkFrame("fibroblast", [body, ...ps, fan, ...spikes], W, H, 3);
      return {
        size: [W, H],
        parts: [
          ...softCell([body, ...ps, fan, ...spikes], fill, { band, gloss: [G.p[0] - gn[0] * gw - 8, G.p[1] - gn[1] * gw, 3.8], rim: 0.13 }),
          { d: nuc, fill: "#8a5fb3", shade: "organelle", glossAt: [0.3, 0.3] },
        ],
      };
    },
  },
  {
    slug: "neuron", name: "Neuron", category: "cells",
    tags: ["neuron", "neurone", "nerve cell", "multipolar neuron", "motor neuron", "soma", "perikaryon", "cell body", "dendrite", "dendrites", "axon", "axon hillock",
      "myelin", "myelin sheath", "myelinated axon", "node of Ranvier", "internode", "Schwann cell", "oligodendrocyte", "synapse", "axon terminal", "synaptic bouton",
      "terminal bouton", "nervous system", "CNS", "PNS", "brain", "neuroscience", "NeuN", "RBFOX3", "MAP2", "Tuj1", "neurofilament"],
    scene: () => {
      // 300 × 190. Multipolar neuron, Servier-like.
      // Paint order: shadow copy → neuron silhouette (soma + tapered, branching dendrites + hillock/axon + terminal
      // arbor + boutons, united) → lit band on the soma → gloss → myelin internodes (separate parts: each is its own
      // sheath) → nucleus → nucleolus.
      // Variation: uneven dendrite angles (gaps 24–62°), lengths 44–72, one or two branch orders.
      const W = 300, H = 190, fill = "#f5cf7f";
      const sx = 76, sy = 96;
      const soma = blobPiece(sx, sy, 31, 29, { n: 7, wobble: 0.07, seed: 44, rot: 10 }, 3);
      const D = [ // primary dendrites: angle°, length, base half-width, bend°
        // (the upper-left arc of the soma, ≈ 215–245°, stays free of dendrites so its lit band can run along it)
        [62, 46, 8.5, 22], [118, 60, 10, -14], [154, 56, 9.5, 18], [198, 70, 10.5, -16], [262, 54, 9, 20], [302, 58, 9.5, 24],
      ];
      const dends = [], br = [];
      const R = rng(7);
      const box = [W, H, 5];
      D.forEach(([a, len, base, bend]) => {
        const r0 = 22; // root inside the soma
        const x0 = sx + Math.cos((a * Math.PI) / 180) * r0, y0 = sy + Math.sin((a * Math.PI) / 180) * r0;
        const q = procFit(x0, y0, a, len + r0 * 0.6, { bend, base, tip: 1.1, p: 1.5, seg: 5 }, box);
        dends.push(q);
        // secondary branch at 2/5, angled away from the bend; the parent runs on ≥ 1.6× as far (no "snake-tongue" forks).
        // Its base is 0.8× the parent's half-width there, and its root sits 2.5 units back inside the parent.
        const side = bend > 0 ? -1 : 1;
        br.push(procFit(...rootBack(q, 2), dirAt(q, 2) + side * (32 + R() * 14), len * (0.3 + R() * 0.07), { bend: side * -12, base: 0.8 * q.hw(2 / 5), tip: 0.8, p: 1.4, seg: 3 }, box));
        // a short tertiary twig on the longer dendrites, from 3/5, on the other side
        if (len > 55) br.push(procFit(...rootBack(q, 3), dirAt(q, 3) - side * (30 + R() * 10), len * 0.2 * (0.9 + R() * 0.2), { base: 0.8 * q.hw(3 / 5), tip: 0.7, p: 1.2, seg: 3 }, box));
      });
      // axon: hillock (cone) → initial segment → myelinated axon → terminal arbor with boutons
      const axonPts = [[sx + 20, sy + 4], [124, 104], [160, 102], [198, 94], [232, 96], [254, 102]];
      const axon = piece(axonPts, (t) => 2.7 + 9.5 * Math.pow(Math.max(0, 1 - t * 6.5), 1.7));
      const ends = [[[252, 102], [268, 84], [276, 66]], [[252, 102], [272, 100], [286, 106]], [[252, 102], [262, 120], [266, 138]], [[257, 111], [272, 118], [286, 128]]];
      const termP = ends.map((t) => piece(t, taper(2.3, 1.7, 1)));
      const bR = [5.6, 5, 6, 4.6];
      const boutons = ends.map((t, i) => blobPiece(t[2][0], t[2][1], bR[i], bR[i] * 0.92, { n: 8, wobble: 0.04, seed: 60 + i }, 1.5));
      // myelin internodes with nodes of Ranvier between them
      const myelin = [];
      const nodes = [[0.2, 0.36], [0.4, 0.56], [0.6, 0.76], [0.8, 0.93]];
      for (const [a, b] of nodes) {
        const seg = [];
        for (let k = 0; k <= 8; k++) seg.push(at(axonPts, a + ((b - a) * k) / 8).p);
        const sg = along(seg, 3);
        myelin.push([tube(sg.slice(1, -1), 6.4, { step: 3 }), circle(...sg[1], 6.4), circle(...sg[sg.length - 2], 6.4)]);
      }
      // light band on the lit edge of the soma, interrupted where dendrites leave it
      const roots = D.map(([a]) => [sx + Math.cos((a * Math.PI) / 180) * 30, sy + Math.sin((a * Math.PI) / 180) * 30]);
      // (clearance 6–11 round the dendrite roots leaves a band ≈ 20 units long on the free upper-left arc, not a shard)
      const band = litBand(soma.outline, { inset: 2.4, width: 7, weight: (i) => Math.min(...roots.map((r) => smooth(6, 11, dist(soma.outline[i], r)))) });
      const nuc = ellipse(sx + 3, sy + 1, 14.5, 13, 20);
      assertInside("neuron nucleus", nuc, soma.d, 4);
      checkFrame("neuron", [soma, axon, ...dends, ...br, ...termP, ...boutons, ...myelin.flat()], W, H, 3);
      return {
        size: [W, H],
        parts: [
          ...softCell([soma, axon, ...dends, ...br, ...termP, ...boutons], fill, { band, gloss: [62, 80, 3.8], rim: 0.11 }),
          ...myelin.map((u) => ({ unite: u, fill: "#b9e0f2", shade: "organelle", gloss: false, highlight: false, thin: true })),
          { d: nuc, fill: "#a98bd0", shade: "organelle", glossAt: [0.28, 0.26] },
          { d: circle(sx + 6, sy - 1, 4.6), fill: "#5f3f86", thin: true },
        ],
      };
    },
  },
  {
    slug: "osteocyte", name: "Osteocyte", category: "cells",
    tags: ["osteocyte", "bone cell", "bone", "mature osteoblast", "canaliculi", "canalicular network", "dendritic processes", "lacuna", "lacunocanalicular",
      "mechanosensing", "mechanotransduction", "sclerostin", "SOST", "DMP1", "FGF23", "RANKL", "PHEX", "bone remodelling"],
    scene: () => {
      // 200 × 200. A flattened, ellipsoid cell body with many dendritic processes that leave mostly from its
      // two long faces (towards the bone surface and the vessels), fewer from the ends; processes branch,
      // wave slightly and differ in length. Paint order: shadow copy → united cell → lit band → gloss → nucleus.
      // Polarised, not radial: the processes are slender and of nearly even calibre (half-width 3.3 → 1.2, a short
      // flare where they meet the body), and wavy. Each long face carries 6 of them within ±40° of the face normal,
      // fanning outwards towards the poles. Two on the lower (vascular) face and one on the upper face are clearly longer
      // (the cell reads as polarised, not as a radial sun or a jellyfish). Each pole has only one short process. Side branches
      // start at 0.8× the parent's half-width, rooted 2.5 units back inside the parent, so the joints have no knobs.
      const W = 200, H = 200, fill = "#efd7a8";
      const cx = 100, cy = 99, rx = 38, ry = 20, rot = -8;
      const R = rng(53);
      const body = blobPiece(cx, cy, rx, ry, { n: 10, wobble: 0.05, seed: 52, rot }, 2.6);
      const rr = (rot * Math.PI) / 180, ax = [Math.cos(rr), Math.sin(rr)], nm = [-ax[1], ax[0]]; // nm: normal of the lower face
      const box = [W, H, 5];
      const ps = [];
      const faces = [
        { side: -1, n: 6, long: [2], len: [20, 36] }, // upper face (towards the bone surface)
        { side: 1, n: 6, long: [1, 4], len: [22, 34] }, // lower face (towards the vessel): two clearly longer processes
      ];
      let seed = 70;
      for (const f of faces) {
        const us = unevenSpacing(f.n, rx * 1.64, R, { cv: 0.35 }).map((u) => u - rx * 0.82);
        const nAng = (Math.atan2(f.side * nm[1], f.side * nm[0]) * 180) / Math.PI;
        us.forEach((u, j) => {
          const v = f.side * (ry * Math.sqrt(Math.max(0, 1 - (u / rx) ** 2)) - 6);
          const x0 = cx + ax[0] * u + nm[0] * v, y0 = cy + ax[1] * u + nm[1] * v;
          const lean = Math.max(-40, Math.min(40, -f.side * (u / rx) * 46 + (R() - 0.5) * 18)); // fan outwards towards the poles
          const long = f.long.includes(j);
          const len = long ? (f.side > 0 ? 50 : 42) + R() * 10 : f.len[0] + R() * (f.len[1] - f.len[0]);
          const q = procFit(x0, y0, nAng + lean, len + 6, { bend: (R() - 0.5) * 34, base: 3.1 + R() * 0.4, tip: 1.2, p: 1, seg: 6, wave: 20, seed: seed++, flare: 2.2 }, box);
          ps.push(q);
          // side branches: none on short processes, 1–2 on long ones
          const nb = len < 30 ? 0 : long ? 1 + (R() < 0.5 ? 1 : 0) : R() < 0.5 ? 1 : 0;
          for (let b = 0; b < nb; b++) {
            const k = 2 + b * 2 + (R() < 0.5 ? 1 : 0);
            if (k >= q.seg) continue;
            ps.push(procFit(...rootBack(q, k), dirAt(q, k) + (R() < 0.5 ? 1 : -1) * (26 + R() * 14), 10 + R() * 9,
              { base: 0.8 * q.hw(k / q.seg), tip: 0.9, p: 1, seg: 3, wave: 16, seed: seed++ }, box));
          }
        });
      }
      // one short process at each pole
      for (const s of [-1, 1]) {
        const x0 = cx + ax[0] * s * (rx - 7), y0 = cy + ax[1] * s * (rx - 7);
        ps.push(procFit(x0, y0, rot + (s < 0 ? 180 : 0) + (R() - 0.5) * 20, 20 + R() * 5, { bend: (R() - 0.5) * 30, base: 3.2, tip: 1.2, p: 1, seg: 4, wave: 18, seed: seed++, flare: 2.2 }, box));
      }
      const band = litBand(body.outline, { inset: 2.2, width: 6.5 });
      const nuc = ellipse(cx + 2, cy + 1, 20, 10.5, rot);
      assertInside("osteocyte nucleus", nuc, body.d, 3);
      checkFrame("osteocyte", [body, ...ps], W, H, 4);
      return {
        size: [W, H],
        parts: [
          ...softCell([body, ...ps], fill, { band, gloss: [cx - 20, cy - 8, 3.4], rim: 0.12 }),
          { d: nuc, fill: "#9877bd", shade: "organelle" },
        ],
      };
    },
  },
  {
    slug: "cardiomyocyte", name: "Cardiomyocyte (cardiac muscle cell)", category: "cells",
    tags: ["cardiomyocyte", "cardiac myocyte", "cardiac muscle cell", "heart muscle cell", "myocardium", "heart", "striated muscle", "cross-striations",
      "sarcomere", "myofibril", "intercalated disc", "intercalated disk", "gap junction", "desmosome", "branched cell", "binucleate",
      "troponin", "cTnT", "TNNT2", "ACTN2", "MYH6", "MYH7", "NPPA", "iPSC-CM", "contractile cell"],
    scene: () => {
      // 300 × 102. An isolated adult ventricular cardiomyocyte, after Servier adult-cardiomyocytes: a rod about 6× longer
      // than wide whose trunk runs straight on into one arm. A shorter side branch (w 13.5, 30° off the axis, ≈ 0.6× the
      // arm beyond the fork) leaves it, with concave fillets in both junction corners. All three ends are step-shaped where
      // intercalated discs join the neighbours. Two central oval nuclei sit in a myofibril-free perinuclear zone. Cross-
      // striations (Z-lines, ~2 µm sarcomeres) are regular but slightly out of register across the myofibrils, with faint
      // longitudinal myofibril lines between them.
      // Paint order: shadow copy → united cell (main rod + branch + 2 fillets) → one continuous lit band → gloss →
      // myofibril lines → Z-lines → intercalated discs → nuclei.
      const W = 300, H = 102, fill = "#f1a2a8";
      const s = 9, sb = 7; // step heights of the intercalated discs (main rod, branch)
      const F = rodFrame([14, 40], [286, 29]), L = F.L, angM = (Math.atan2(29 - 40, 286 - 14) * 180) / Math.PI;
      const wM = (u) => 24.5 + ((19.5 - 24.5) * u) / L; // slight taper towards the arm
      const mainLoc = [[s, -wM(s)], [L, -wM(L)], [L, 0], [L - s, 0], [L - s, wM(L - s)], [0, wM(0)], [0, 0], [s, 0]];
      const mainD = roundPoly(mainLoc.map(F.W), [5, 6, 2.5, 2.5, 5, 6, 2.5, 2.5]);
      // side branch, rooted on the trunk's centre line so its inner corners are buried
      const aB = ((angM + 30) * Math.PI) / 180, Lb = 100, wb = 13.5;
      const B0 = F.W([116, 0]), FB = rodFrame(B0, [B0[0] + Math.cos(aB) * Lb, B0[1] + Math.sin(aB) * Lb]);
      const brD = roundPoly([[0, -wb], [Lb, -wb], [Lb, 0], [Lb - sb, 0], [Lb - sb, wb], [0, wb]].map(FB.W), [3, 5, 2.5, 2.5, 4.5, 3]);
      // concave fillets: the acute crotch (r 6) and the obtuse outer corner (r 12)
      const Ma = F.W([0, wM(0)]), dMain = unit(Ma, F.W([L - s, wM(L - s)]));
      const dBr = unit(FB.W([0, 0]), FB.W([Lb, 0]));
      const C1 = meet(Ma, dMain, FB.W([0, -wb]), dBr), C2 = meet(Ma, dMain, FB.W([0, wb]), dBr);
      const fil = [filletPoly(C1, dMain, dBr, 4.5), filletPoly(C2, [-dMain[0], -dMain[1]], dBr, 12)];
      const shapes = [mainD, brD, ...fil];
      const shadow = shapes.map((d) => movePath(d, 2.6, 2.6));
      // main-rod local coordinates of a page point (to keep the branch's lines off the trunk)
      const mainV = (P) => { const q = [P[0] - 14, P[1] - 40], ux = [Math.cos((angM * Math.PI) / 180), Math.sin((angM * Math.PI) / 180)]; return [q[0] * ux[0] + q[1] * ux[1], -q[0] * ux[1] + q[1] * ux[0]]; };
      const outsideMain = (P) => { const [u, v] = mainV(P); return v > wM(u) + 1.5; };
      // Z-lines: a line crosses several myofibrils that are slightly out of register, hence small steps along it
      const ZR = rng(81), stri = [];
      const zline = (Fr, u, a, b) => {
        if (b - a <= 4) return;
        const n = Math.max(1, Math.round((b - a) / 11)), pts = [];
        for (let k = 0; k <= n; k++) pts.push(Fr.W([u + (k % 2 ? 0.7 : -0.5) * (0.6 + ZR()), a + ((b - a) * k) / n]));
        stri.push(smoothOpen(pts, 0.6));
      };
      const nucU = [80, 118];
      for (let u = s + 8; u <= L - s - 7; u += 6.2) {
        const w = wM(u) - 3.5;
        if (u > 58 && u < 140) {
          const c = u < 99 ? nucU[0] : nucU[1];
          const half = 12.5 * Math.sqrt(Math.max(0, 1 - Math.pow((u - c) / 24, 2))) + 3.5; // clear zone round the nuclei
          zline(F, u, -w, -half);
          zline(F, u, half, w);
        } else zline(F, u, -w, w);
      }
      for (let u = 40; u <= Lb - sb - 6; u += 6.2) {
        // only the part of each branch Z-line that lies outside the trunk
        let a = -wb + 3;
        while (a < wb - 3 && !outsideMain(FB.W([u, a]))) a += 1;
        zline(FB, u, a, wb - 3);
      }
      // faint longitudinal myofibril lines (outside the perinuclear zone)
      const fibr = [-0.7, 0.7].map((k) => smoothOpen([s + 6, 70, 140, 210, L - s - 6].map((u) => F.W([u, k * wM(u)]))));
      { let u = 40; while (u < Lb - sb - 4 && !outsideMain(FB.W([u, 0]))) u += 1; fibr.push(smoothOpen([FB.W([u + 2, 0]), FB.W([Lb - sb - 4, 0])])); }
      // intercalated discs: dark stepped lines just inside each stepped end
      const o = 2.6;
      const discs = [
        polyline([[s + o, -wM(s) + 3], [s + o, o], [o, o], [o, wM(0) - 3]].map(F.W)),
        polyline([[L - o, -wM(L) + 3], [L - o, -o], [L - s - o, -o], [L - s - o, wM(L - s) - 3]].map(F.W)),
        polyline([[Lb - o, -wb + 3], [Lb - o, -o], [Lb - sb - o, -o], [Lb - sb - o, wb - 3]].map(FB.W)),
      ];
      // one continuous light band inside the lit (upper) edge of trunk and arm
      const b0 = s + 5, b1 = L - 10;
      const band = roundPoly([[b0, -wM(b0) + 2.4], [b1, -wM(b1) + 2.4], [b1, -wM(b1) + 7.5], [b0, -wM(b0) + 7.5]].map(F.W), 2.5);
      const nuclei = [ellipse(...F.W([nucU[0], 1]), 15, 8, angM - 2), ellipse(...F.W([nucU[1], 0]), 14, 7.6, angM + 3)];
      for (const n of nuclei) assertInside("cardiomyocyte nucleus", n, mainD, 6);
      checkFrame("cardiomyocyte", [...shapes, ...shadow], W, H, 3);
      const zc = shade(fill, 0.22);
      return {
        size: [W, H],
        parts: [
          { unite: shadow, fill: shade(fill, 0.13), line: false },
          { unite: shapes, fill },
          { d: band, fill: tint(fill, 0.12), opacity: 0.85, line: false },
          { unite: glossDots(...F.W([40, -wM(40) + 9.5]), 3.4), fill: "#ffffff", opacity: 0.8, line: false },
          { d: fibr.join(""), fill: "none", stroke: { color: zc, width: 1.3 }, opacity: 0.3, lineStrokeWidth: 0.7, lineColor: shade(fill, 0.3) },
          { d: stri.join(""), fill: "none", stroke: { color: zc, width: 2.1, cap: "butt" }, opacity: 0.55, lineStrokeWidth: 1, lineColor: "#b65a69" },
          { d: discs.join(""), fill: "none", stroke: { color: shade(fill, 0.35), width: 2.2, cap: "round" }, lineStrokeWidth: 2 },
          { d: nuclei, fill: "#9467b4", shade: "organelle", glossAt: [0.3, 0.3] },
        ],
      };
    },
  },
];

/** Hand-made soft shading kit for cells with long processes — shared with immune.mjs (dendritic cell). */
export const kit = { dist, clamp, smooth, along, at, loop, movePath, tube, tubePts, taper, proc, procFit, rootBack, dirAt, piece, sidedPiece, fanPiece, filletPoly, meet, unit, blobPiece, litBand, glossDots, softCell, checkFrame };
