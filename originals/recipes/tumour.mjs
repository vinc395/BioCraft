// Carcinoma progression and the tumour microenvironment (TME), Servier-style.
//  · three matched tissue sections (same 320 × 240 framing, same gland positions): normal glandular
//    epithelium → carcinoma in situ → invasive carcinoma with its microenvironment;
//  · a review-figure style TME overview (tumour mass surrounded by stromal and immune cells);
//  · components: cancer-associated fibroblast, tumour-associated macrophage, tumour cell in mitosis,
//    tertiary lymphoid structure (also found in RA synovium).
// Histology palette follows lib/histo.mjs (H&E-like pinks and purples); atypical/tumour cells in the
// sections are lilac with dark, hyperchromatic nuclei so they read apart from normal epithelium.
import { circle, ellipse, capsule, rect, blob, blobPts, rng, smoothClosed, smoothOpen, ribbon, scatter, f } from "../lib/geom.mjs";
import { shade, tint, flat } from "../lib/style.mjs";
import { catmull, roundPoly, spindle, fibre, rbc, packIn, packWhere, inside, polyD, lineD, centroid, area, lobes, clipConvex, offsetPts, offsetClosed, resample } from "../lib/tissue.mjs";
import { C, Layers, sw, defineLayers, vessel, capillaryAlong, mastCell } from "../lib/histo.mjs";

/* ===================== shared helpers ===================== */

/** Define a subset of the standard histology layers (vessels, immune cells…) at this point in the stack. */
function std(L, keys) {
  const t = new Layers();
  defineLayers(t, C.matrix);
  for (const k of keys) {
    const { ds, ...st } = t.map.get(k);
    L.def(k, st);
  }
}
const BLOOD = ["wall", "lumen", "rbc", "endo"];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
};
const polyDist = (p, poly) => {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  return m;
};
const lineDist = (p, pts) => {
  let m = Infinity;
  for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, segDist(p, pts[i], pts[i + 1]));
  return m;
};
/** Inside a polygon or within `pad` of its edge. */
const near = (p, poly, pad = 0) => inside(poly, p) || (pad > 0 && polyDist(p, poly) < pad);
const bbox = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

/** Points round an oval with smooth low-frequency wobble (dir −1 runs the other way so cellBand grows cells inward). */
function ovalPts(cx, cy, rx, ry, { rot = 0, n = 90, dir = 1, wobble = 0, seed = 1 } = {}) {
  const R = rng(seed);
  const waves = [R() * 6, R() * 6, R() * 6, R() * 6];
  const r0 = (rot * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => {
    const a = (dir * i * Math.PI * 2) / n;
    const k = 1 + wobble * (Math.sin(a * 2 + waves[0]) * 0.45 + Math.sin(a * 3 + waves[1]) * 0.3 + Math.sin(a * 5 + waves[2]) * 0.15 + Math.sin(a * 7 + waves[3]) * 0.1);
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    return [cx + x * Math.cos(r0) - y * Math.sin(r0), cy + x * Math.sin(r0) + y * Math.cos(r0)];
  });
}
const ring = (pts) => lineD([...pts, pts[0]]);

/** Keep the part of `poly` closer to s than to t (one Voronoi half-plane). */
function clipHalf(poly, s, t) {
  const m = [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2], nx = t[0] - s[0], ny = t[1] - s[1];
  const val = (p) => (p[0] - m[0]) * nx + (p[1] - m[1]) * ny;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const vp = val(p), vq = val(q);
    if (vp <= 0) out.push(p);
    if (vp <= 0 !== vq <= 0) {
      const k = vp / (vp - vq);
      out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]);
    }
  }
  return out;
}
/** Voronoi cells of `seeds`, cut to the outline `clip` (crowded polygonal tumour cells). */
function voronoi(seeds, clip, reach = 30) {
  return seeds.map((s, i) => {
    let poly = clip;
    for (let j = 0; j < seeds.length && poly.length >= 3; j++) {
      if (j === i || dist(s, seeds[j]) > reach) continue;
      poly = clipHalf(poly, s, seeds[j]);
    }
    return poly;
  });
}

/** Rounded-rectangle outline as points (clockwise on screen, as clipConvex expects). */
function roundRectPts(x, y, w, h, r) {
  const out = [];
  const corner = (cx, cy, a0) => {
    for (let k = 0; k <= 6; k++) {
      const a = ((a0 + (k / 6) * 90) * Math.PI) / 180;
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  corner(x + w - r, y + r, -90);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, 90);
  corner(x + r, y + r, 180);
  return out;
}

/** An irregular, pleomorphic nucleus (outline points / path). */
const pleoPts = (x, y, r, R, elong = 1, rot = null) =>
  blobPts(x, y, r * (0.95 + R() * 0.3) * elong, r * (0.78 + R() * 0.22), { n: 7, wobble: 0.13, seed: Math.round(x * 31 + y * 17), rot: rot ?? R() * 180 });
const pleoNuc = (x, y, r, R, elong = 1, rot = null) => smoothClosed(pleoPts(x, y, r, R, elong, rot));

/** Half-plane clip: keep the part of `poly` where (p − a)·u ≥ 0. */
function keepSide(poly, a, u) {
  const val = (p) => (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const vp = val(p), vq = val(q);
    if (vp >= 0) out.push(p);
    if (vp >= 0 !== vq >= 0) {
      const k = vp / (vp - vq);
      out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]);
    }
  }
  return out;
}
/**
 * Cut a round space (centre c, radius r — a number or a function of the angle) out of a convex cell
 * polygon, so the cell's edge follows the curve: cribriform lumens, comedo necrosis, a slot for an
 * intra-epithelial lymphocyte. Returns [] when the cell lies wholly inside the space.
 */
function cutDisc(poly, c, r) {
  const rAt = typeof r === "function" ? r : () => r;
  const rMax = typeof r === "function" ? Math.max(...Array.from({ length: 36 }, (_, i) => r((i * Math.PI) / 18))) : r;
  const ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const inD = (p) => dist(p, c) < rAt(ang(p));
  const onC = (a) => [c[0] + Math.cos(a) * rAt(a), c[1] + Math.sin(a) * rAt(a)];
  // densify only the edges that come near the space
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const n = segDist(c, p, q) < rMax ? Math.max(1, Math.ceil(dist(p, q) / 0.5)) : 1;
    for (let k = 0; k < n; k++) pts.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
  }
  const ins = pts.map(inD);
  if (!ins.includes(true)) {
    if (!inside(poly, c)) return poly;
    // the space lies wholly inside this cell: fall back to a tangent cut
    const s = centroid(poly), l = dist(s, c) || 1, u = [(s[0] - c[0]) / l, (s[1] - c[1]) / l];
    return keepSide(poly, [c[0] + u[0] * rAt(ang(s)), c[1] + u[1] * rAt(ang(s))], u);
  }
  if (!ins.includes(false)) return [];
  const N = pts.length, s0 = ins.indexOf(false);
  const P = Array.from({ length: N }, (_, k) => pts[(s0 + k) % N]), I = Array.from({ length: N }, (_, k) => ins[(s0 + k) % N]);
  const cross = (out, inn) => {
    let a = out, b = inn;
    for (let it = 0; it < 14; it++) {
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (inD(m)) b = m;
      else a = m;
    }
    return a;
  };
  const res = [];
  for (let i = 0; i < N; ) {
    if (!I[i]) {
      res.push(P[i++]);
      continue;
    }
    let j = i;
    while (j < N && I[j]) j++;
    const a = cross(P[i - 1], P[i]), b = cross(P[j % N], P[j - 1]);
    const a0 = ang(a), d = angDiff(ang(b), a0), alt = d - Math.sign(d || 1) * 2 * Math.PI;
    const ok = (sw) => inside(poly, onC(a0 + sw / 2));
    const sweep = ok(d) && !ok(alt) ? d : !ok(d) && ok(alt) ? alt : Math.abs(d) < Math.abs(alt) ? d : alt;
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) * rMax) / 0.6));
    res.push(a);
    for (let k = 1; k < steps; k++) res.push(onC(a0 + (sweep * k) / steps));
    res.push(b);
    i = j;
  }
  return res;
}
/** A gently irregular radius function (round necrosis, a slightly uneven punched-out space). */
const wobblyR = (r, amp, seed) => {
  const R = rng(seed), p1 = R() * 6, p2 = R() * 6;
  return (a) => r * (1 + amp * (Math.sin(a * 3 + p1) * 0.6 + Math.sin(a * 5 + p2) * 0.4));
};

/** A point deep inside a cell polygon (best of a small grid round its vertex mean). */
function innerCentre(poly) {
  const c = centroid(poly);
  let best = c, bd = inside(poly, c) ? polyDist(c, poly) : -1;
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
    const p = [c[0] + dx, c[1] + dy];
    if (!inside(poly, p)) continue;
    const d = polyDist(p, poly);
    if (d > bd) (bd = d), (best = p);
  }
  return best;
}
/**
 * Shrink a nucleus outline about its centre until it lies inside its cell `poly` with `margin` to spare
 * (and at least `edge` from `outline`, e.g. a basement membrane). Returns the points, or null if it can't fit.
 */
function fitInside(pts, c, poly, { margin = 0.7, outline = null, edge = 0, minK = 0.45, clear = null } = {}) {
  if (!inside(poly, c)) return null;
  let k = 1;
  for (let it = 0; it < 18 && k >= minK; it++, k *= 0.92) {
    const q = pts.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]);
    // test slightly outside the sample points: the smooth curve bulges a little between them
    const ok = q.every(([x, y]) => {
      const t = [c[0] + (x - c[0]) * 1.08, c[1] + (y - c[1]) * 1.08];
      return inside(poly, t) && polyDist(t, poly) > margin && (!outline || polyDist(t, outline) > edge) && (!clear || clear(t));
    });
    if (ok) return q;
  }
  return null;
}
/** Angular outline of an infiltrating gland: `corners` sharp corners joined by slightly bowed sides. */
function angularPts(cx, cy, rx, ry, { rot = 0, corners = 4, seed = 1, n = 110, bow = 0.07 } = {}) {
  const R = rng(seed);
  const a0 = R() * Math.PI * 2;
  const cs = Array.from({ length: corners }, (_, i) => {
    const a = a0 + (i + (R() - 0.5) * 0.45) * ((2 * Math.PI) / corners);
    const k = 0.94 + R() * 0.14;
    return [Math.cos(a) * rx * k, Math.sin(a) * ry * k];
  });
  const total = cs.reduce((s, p, i) => s + dist(p, cs[(i + 1) % corners]), 0);
  const out = [];
  cs.forEach((p, i) => {
    const q = cs[(i + 1) % corners], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], ml = Math.hypot(m[0], m[1]) || 1;
    const b = dist(p, q) * (bow + (R() - 0.5) * 0.05) * 2;
    const ctl = [m[0] + (m[0] / ml) * b, m[1] + (m[1] / ml) * b];
    const k = Math.max(4, Math.round((n * dist(p, q)) / total));
    for (let j = 0; j < k; j++) {
      const t = j / k, u = 1 - t;
      out.push([u * u * p[0] + 2 * u * t * ctl[0] + t * t * q[0], u * u * p[1] + 2 * u * t * ctl[1] + t * t * q[1]]);
    }
  });
  return xform(out, cx, cy, rot);
}

/** A mitotic figure sized and turned to fit inside a cell polygon (or null). */
function fitMitosis(poly, c, R) {
  const a0 = R() * Math.PI;
  for (const s of [1, 0.86, 0.72]) {
    for (const a of [a0, a0 + Math.PI / 2, a0 + Math.PI / 4]) {
      const ux = Math.cos(a), uy = Math.sin(a), half = 5 * s;
      const ends = [[c[0] + ux * half, c[1] + uy * half], [c[0] - ux * half, c[1] - uy * half], [c[0] - uy * 3 * s, c[1] + ux * 3 * s], [c[0] + uy * 3 * s, c[1] - ux * 3 * s]];
      if (ends.every((p) => inside(poly, p) && polyDist(p, poly) > 0.6)) return mitoticFigure(c[0], c[1], a, R, s);
    }
  }
  return null;
}

/**
 * A mitotic figure as a section shows it: the metaphase plate seen edge-on, one dark band (about
 * 7.6 × 2.3 at s 1) made knobbly by 6–9 short chromosome arms sticking out of both long sides — one
 * closed outline, so it reads as a hairy chromosome plate rather than separate strokes (letters).
 */
function mitoticFigure(cx, cy, ang, R, s = 1) {
  const half = 3.8 * s, hw = 1.15 * s, n = 6 + Math.floor(R() * 4);
  const knobs = Array.from({ length: n }, (_, k) => ({
    t: -half * 0.86 + (k + 0.5 + (R() - 0.5) * 0.7) * ((1.72 * half) / n),
    side: (k % 2 ? 1 : -1) * (R() < 0.25 ? -1 : 1),
    h: (0.8 + R() * 0.9) * s,
    w: (0.3 + R() * 0.14) * s,
  }));
  const bump = (t, side) => knobs.reduce((m, k) => (k.side === side ? Math.max(m, k.h * Math.exp(-((t - k.t) ** 2) / (2 * k.w * k.w))) : m), 0);
  const loc = [];
  const N = 48;
  for (let i = 0; i <= N; i++) { const t = -half + (2 * half * i) / N; loc.push([t, hw + bump(t, 1)]); }
  for (let i = 1; i < 9; i++) { const a = Math.PI / 2 - (i / 9) * Math.PI; loc.push([half + Math.cos(a) * hw * 0.9, Math.sin(a) * hw]); }
  for (let i = 0; i <= N; i++) { const t = half - (2 * half * i) / N; loc.push([t, -hw - bump(t, -1)]); }
  for (let i = 1; i < 9; i++) { const a = -Math.PI / 2 - (i / 9) * Math.PI; loc.push([-half + Math.cos(a) * hw * 0.9, Math.sin(a) * hw]); }
  const ux = Math.cos(ang), uy = Math.sin(ang);
  return [smoothClosed(loc.map(([t, nn]) => [cx + ux * t - uy * nn, cy + uy * t + ux * nn]))];
}

/**
 * A tumour cell in metaphase for the overview: rounded up (≈ 1.1 × its neighbours) and paler, with
 * 5–6 small X-shaped chromosomes staggered along the plate and two faint spindle poles whose fibres
 * reach the chromosomes (the visual language of the tumour-cell-mitosis icon). `ang` = plate axis.
 */
function metaphaseCell(O, [x, y], r, ang, R) {
  O.add("tumMit", blob(x, y, r, r * 0.96, { n: 9, wobble: 0.03, seed: Math.round(x * 3 + y) }));
  const ux = Math.cos(ang), uy = Math.sin(ang), at = (t, nn) => [x + ux * t - uy * nn, y + uy * t + ux * nn];
  const poles = [at(0, r * 0.66), at(0, -r * 0.66)];
  const n = 5, span = r * 0.58;
  const sites = Array.from({ length: n }, (_, k) => at(-span + ((2 * span) / (n - 1)) * k + (R() - 0.5) * 0.9, (R() - 0.5) * 1.3));
  O.add("spindle", poles.flatMap((p) => sites.map((q) => lineD([p, [lerpPt(p, q, 0.86)[0], lerpPt(p, q, 0.86)[1]]]))));
  O.add("pole", poles.map(([px, py]) => circle(px, py, r * 0.085)));
  for (const [cx, cy] of sites) {
    const l = r * (0.12 + R() * 0.07), w = r * 0.07, tilt = ang + (R() - 0.5) * 0.9;
    for (const a of [tilt + 1.0, tilt - 1.0]) O.add("chrom", capsule(cx - Math.cos(a) * l, cy - Math.sin(a) * l, cx + Math.cos(a) * l, cy + Math.sin(a) * l, w));
  }
}
const lerpPt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Small round cell (lymphocyte-like) on two layers. */
function roundCell(L, [x, y], r, body, nuc, R, nk = 0.68) {
  L.add(body, circle(x, y, r));
  L.add(nuc, circle(x + (R() - 0.5) * r * 0.3, y + (R() - 0.5) * r * 0.3, r * nk));
}
function neutro(L, [x, y], R, keys = ["neut", "neutNuc"], s = 1) {
  L.add(keys[0], circle(x, y, 4.2 * s));
  L.add(keys[1], lobes(x, y, 2.8 * s, 3, R() * 360));
}
/** Tumour-associated macrophage in a section: ruffled cell, eccentric kidney-shaped nucleus, phagocytic vacuoles. */
function tamCell(L, [x, y], seed, s = 1) {
  const R = rng(seed);
  const rot = R() * 180, a = (rot * Math.PI) / 180;
  // 4–6 short, irregular pseudopods round a plump body
  const nb = 4 + Math.floor(R() * 3);
  const bumps = Array.from({ length: nb }, (_, k) => [(k * 360) / nb + (R() - 0.5) * 36, (1.7 + R() * 1.9) * s, 8 + R() * 7]);
  L.add("tam", smoothClosed(starPts(x, y, 7.8 * s, 6.2 * s, bumps, { rot, wobble: 0.07, seed, n: 64 }), 0.9));
  L.add("tamVac", [circle(x + Math.cos(a) * 3.6 * s, y + Math.sin(a) * 3.6 * s, 1.5 * s), circle(x + Math.cos(a + 0.9) * 4.4 * s, y + Math.sin(a + 0.9) * 4.4 * s, 1.1 * s)]);
  const nx = x - Math.cos(a) * 2.4 * s, ny = y - Math.sin(a) * 2.4 * s;
  L.add("tamNuc", ellipse(nx, ny, 3.4 * s, 2.3 * s, rot + 90) + circle(nx + Math.cos(a + 1.6) * 1.8 * s, ny + Math.sin(a + 1.6) * 1.8 * s, 1.9 * s));
}

/* ===================== carcinoma progression: three matched sections ===================== */

const W = 320, H = 240;
const TMEM_SIDE = 1; // which side of the intravasating cell the TMEM macrophage sits on
const FRAME = roundRectPts(6, 6, W - 12, H - 12, 9);
const GLANDS = [
  { cx: 66, cy: 64, rx: 45, ry: 34, rot: -12 },
  { cx: 172, cy: 50, rx: 39, ry: 29, rot: 6 },
  { cx: 264, cy: 78, rx: 38, ry: 33, rot: 18 },
  { cx: 92, cy: 174, rx: 43, ry: 33, rot: 14 },
  { cx: 204, cy: 158, rx: 46, ry: 34, rot: -10 },
  { cx: 280, cy: 193, rx: 25, ry: 24, rot: 0 },
];
const P = {
  stroma: "#fbe6e3", desmo: "#f5d2d6", collagen: "#f0c4c5", collagenD: "#e7a9b3",
  epi: "#f5c5d0", epiNuc: "#7c4fa0", glandLumen: "#fffaf9",
  bm: "#b8569a",
  tum: "#ddb9e6", tumMit: "#f0e2f4", tumNuc: "#4a2a7b", nucleolus: "#d9688f", mitosis: "#33205f",
  necrosis: "#efc3cf", debris: "#7b5596", calc: "#8d6fb8", myoNuc: "#5a3f8a",
  caf: "#ef91b6", cafNuc: "#9a76bf",
  cd8: "#bfe5cf", cd8Nuc: "#3f69a8", treg: "#f6d9ab", tregNuc: "#8f63a8",
  tam: "#f6c09d", tamNuc: "#9a6aa9", tamVac: "#fde9da",
  angioWall: "#ee8f99", angioLumen: "#fdeceb",
};

function sectionLayers(L, stage) {
  const inv = stage === "invasive";
  L.def("stroma", { fill: P.stroma, stroke: sw(shade(P.stroma, 0.1), 1), lineWidth: 1.2 })
    // the desmoplastic bed: no outline in line style (it is a change of stroma, not a cut edge)
    .def("desmo", { fill: P.desmo, lineColor: flat(P.desmo), lineWidth: 0.3 })
    .def("collagen", { fill: "none", stroke: { color: P.collagen, width: 1.15, cap: "round" }, lineColor: "#d99ea5", lineStrokeWidth: 0.6 })
    .def("bundle", { fill: "none", stroke: { color: P.collagenD, width: 2.2, cap: "round" }, lineColor: "#d48f9b", lineStrokeWidth: 1 });
  std(L, BLOOD);
  L.def("angioLumen", { fill: P.angioLumen, lineWidth: 0.4 })
    .def("angioWall", { fill: "none", stroke: { color: P.angioWall, width: 2.6, cap: "round" }, lineColor: "#c25d6c", lineStrokeWidth: 1.3 })
    .def("angioEndo", { fill: C.endo, lineWidth: 0.3 })
    .def("angioRbc", { fill: C.rbc, shade: "small", lineWidth: 0.4 });
  // resting fibroblasts: slender, thin dark nucleus; CAFs: plump, with side processes, pale nucleus, stress fibres
  L.def("fibro", { fill: C.fibro, stroke: sw(shade(C.fibro, 0.14), 0.5), shade: "small", lineWidth: 0.6 })
    .def("fibroNuc", { fill: "#6a4596", lineWidth: 0.3 })
    .def("caf", { fill: P.caf, stroke: sw(shade(P.caf, 0.14), 0.7), shade: "small", lineWidth: 0.8 })
    .def("cafFib", { fill: "none", stroke: { color: shade(P.caf, 0.13), width: 0.45, cap: "round" }, opacity: 0.75, lineColor: shade(P.caf, 0.3), lineStrokeWidth: 0.3 })
    .def("cafNuc", { fill: P.cafNuc, lineWidth: 0.4 });
  std(L, ["tcell", "tnuc", "bcell", "bnuc", "plasma", "plasmaNuc", "mast", "mastGran"]);
  L.def("cd8", { fill: P.cd8, shade: "small", lineWidth: 0.6 })
    .def("cd8Nuc", { fill: P.cd8Nuc, lineWidth: 0.4 })
    .def("treg", { fill: P.treg, shade: "small", lineWidth: 0.6 })
    .def("tregNuc", { fill: P.tregNuc, lineWidth: 0.4 })
    .def("tam", { fill: P.tam, stroke: sw(shade(P.tam, 0.14), 0.6), shade: "small", lineWidth: 0.7 })
    .def("tamVac", { fill: P.tamVac, lineWidth: 0.3 })
    .def("tamNuc", { fill: P.tamNuc, lineWidth: 0.4 });
  std(L, ["neut", "neutNuc"]);
  L.def("bm", { fill: "none", stroke: { color: P.bm, width: 3.4, cap: "round" }, lineColor: "#8a2f6f", lineStrokeWidth: 1.6 });
  L.def("epi", { fill: P.epi, stroke: sw(shade(P.epi, 0.16), 0.55), lineWidth: 0.6 })
    .def("epiNuc", { fill: P.epiNuc, shade: "small", lineWidth: 0.35 })
    .def("tumBg", { fill: shade(P.tum, 0.08), lineWidth: 0.4 })
    // lumens and necrosis lie beneath the cells, which stop at their edge (no half-covered nuclei)
    .def("glandLumen", { fill: P.glandLumen, stroke: sw(shade(P.epi, 0.12), 0.5), lineWidth: 0.5 })
    .def("necrosis", { fill: P.necrosis, stroke: sw(shade(P.necrosis, 0.12), 0.5), lineWidth: 0.6 })
    // necrosis contents: faint ghost-cell outlines, karyorrhectic dust, a laminated microcalcification
    .def("ghost", { fill: "none", stroke: { color: shade(P.necrosis, 0.1), width: 0.5, cap: "round" }, opacity: 0.8, lineColor: shade(P.necrosis, 0.2), lineStrokeWidth: 0.35 })
    .def("debris", { fill: P.debris, lineWidth: 0.2 })
    .def("calc", { fill: P.calc, shade: "small", lineWidth: 0.4 })
    .def("calcRing", { fill: "none", stroke: { color: tint(P.calc, 0.16), width: 0.45 }, lineColor: shade(P.calc, 0.2), lineStrokeWidth: 0.3 })
    .def("tum", { fill: P.tum, stroke: sw(shade(P.tum, 0.16), 0.55), lineWidth: 0.55 })
    .def("tumMit", { fill: P.tumMit, stroke: sw(shade(P.tumMit, 0.2), 0.55), lineWidth: 0.55 })
    .def("tumNuc", { fill: P.tumNuc, shade: "small", lineWidth: 0.35 })
    .def("nucleolus", { fill: P.nucleolus, lineWidth: 0.2 })
    .def("mitosis", { fill: P.mitosis, lineWidth: 0.25 })
    // flattened myoepithelial (basal) nuclei along the basement membrane of normal glands and in-situ ducts
    .def("myo", { fill: "#f6dce5", stroke: sw("#c48ea3", 0.5), lineWidth: 0.5 })
    .def("myoNuc", { fill: P.myoNuc, lineWidth: 0.3 })
    // cells that sit on top of the tumour (intra-tumoural T cells, neutrophils in necrosis, an intravasating cell)
    .def("cd8b", { fill: P.cd8, shade: "small", lineWidth: 0.6 })
    .def("cd8bNuc", { fill: P.cd8Nuc, lineWidth: 0.4 })
    .def("neutb", { fill: C.neut, shade: "small", lineWidth: 0.6 })
    .def("neutbNuc", { fill: C.neutNuc, lineWidth: 0.4 })
    .def("tumTop", { fill: P.tum, stroke: sw(shade(P.tum, 0.16), 0.55), shade: "small", lineWidth: 0.6 })
    .def("tumTopNuc", { fill: P.tumNuc, lineWidth: 0.35 });
  // the intravasating tumour cell and its hourglass nucleus, each merged into one shape
  if (inv) {
    L.def("intra", { fill: P.tum, stroke: sw(shade(P.tum, 0.16), 0.55), shade: "rim", lineWidth: 0.6, unite: [] })
      .def("intraNuc", { fill: P.tumNuc, lineWidth: 0.4, unite: [] });
  }
}

/**
 * A closed ring of cells lining the inside of `outer` (a gland or duct outline), seam-free:
 * `rows` rows, `th` thick, cells radiating toward the centre. Returns the cells
 * [{poly, base, apex, row}] (base on the basement-membrane side, apex toward the lumen) and the
 * innermost curve (the apical surface = lumen outline).
 */
function ringCells(outer, { rows = 1, th = 12, cellLen = 6, jitter = 0.15, seed = 1, minFrac = 0.14, lumenR = null } = {}) {
  const R = rng(seed);
  const n = outer.length;
  const c = centroid(outer);
  const radial = (p, d) => {
    const dx = p[0] - c[0], dy = p[1] - c[1], l = Math.hypot(dx, dy) || 1;
    const k = Math.max(minFrac, (l - d) / l);
    return [c[0] + dx * k, c[1] + dy * k];
  };
  // lumenR: the innermost curve is a circle of that radius (an open round lumen inside an angular gland)
  const toR = (p, d) => {
    const dx = p[0] - c[0], dy = p[1] - c[1], l = Math.hypot(dx, dy) || 1;
    return [c[0] + (dx / l) * d, c[1] + (dy / l) * d];
  };
  const curves = [outer];
  for (let r = 1; r <= rows; r++) curves.push(outer.map((p) => (lumenR && r === rows ? toR(p, lumenR) : radial(p, (th * r) / rows))));
  const at = (cv, u) => {
    const i = Math.floor(u), k = u - i, p = cv[((i % n) + n) % n], q = cv[(((i + 1) % n) + n) % n];
    return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
  };
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const top = curves[r], bot = curves[r + 1];
    const mid = top.map((p, i) => [(p[0] + bot[i][0]) / 2, (p[1] + bot[i][1]) / 2]);
    const s = [0];
    for (let i = 1; i <= n; i++) s.push(s[i - 1] + dist(mid[i % n], mid[i - 1]));
    const total = s[n], count = Math.max(4, Math.round(total / cellLen)), step = total / count;
    const uAt = (len) => {
      len = ((len % total) + total) % total;
      let i = 0;
      while (i < n - 1 && s[i + 1] <= len) i++;
      return i + (len - s[i]) / (s[i + 1] - s[i] || 1);
    };
    const off = (r % 2 ? 0.5 : 0) * step + R() * step * 0.3;
    const us = Array.from({ length: count }, (_, k) => uAt(off + (k + (R() - 0.5) * 2 * jitter) * step));
    for (let k = 0; k < count; k++) {
      const u0 = us[k];
      let u1 = k + 1 < count ? us[k + 1] : us[0] + n;
      while (u1 <= u0) u1 += n;
      const poly = [at(top, u0)];
      for (let i = Math.ceil(u0); i < u1; i++) poly.push(top[i % n]);
      poly.push(at(top, u1), at(bot, u1));
      for (let i = Math.floor(u1); i > u0; i--) poly.push(bot[i % n]);
      poly.push(at(bot, u0));
      cells.push({ poly, base: at(top, (u0 + u1) / 2), apex: at(bot, (u0 + u1) / 2), row: r });
    }
  }
  return { cells, inner: curves[rows] };
}

/** A normal gland in cross-section: basement membrane, polarised columnar cells with basal nuclei, open lumen. */
function normalGland(L, g, seed) {
  const R = rng(seed);
  const { cx, cy, rx, ry, rot } = g;
  const outer = ovalPts(cx, cy, rx, ry, { rot, wobble: 0.03, seed, n: 120 });
  L.add("bm", ring(outer.map(([x, y]) => [cx + (x - cx) * (1 + 1.3 / rx), cy + (y - cy) * (1 + 1.3 / ry)])));
  const th = Math.min(12.5, Math.min(rx, ry) * 0.46);
  const { cells, inner } = ringCells(outer, { rows: 1, th, cellLen: 6.1, jitter: 0.12, seed });
  for (const { poly, base, apex } of cells) {
    L.add("epi", roundPoly(poly, 1));
    const t = 0.44 + R() * 0.05;
    const ang = (Math.atan2(apex[1] - base[1], apex[0] - base[0]) * 180) / Math.PI;
    L.add("epiNuc", ellipse(base[0] + (apex[0] - base[0]) * t, base[1] + (apex[1] - base[1]) * t, 2.6, 1.35, ang));
  }
  L.add("glandLumen", polyD(inner));
  myoCells(L, outer, seed + 9);
}

/**
 * The myoepithelial layer: discontinuous flattened spindle cells (9–13 long, 2.2–2.6 thick, tapered
 * ends, 3–8 apart — about one per 1.5–2 luminal cells) along the inner face of the basement membrane,
 * each holding its own flattened nucleus. They are painted over the bases of the luminal or tumour
 * cells, which meet the basement membrane only in the gaps. skip(p) leaves a stretch out (a breach).
 */
function myoCells(L, outline, seed, skip = () => false) {
  const R = rng(seed);
  const c0 = centroid(outline);
  const pts = resample([...outline, outline[0]], 0.5);
  const S = [0];
  for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + dist(pts[i], pts[i - 1]));
  const total = S[S.length - 1];
  const at = (s0) => {
    const s = ((s0 % total) + total) % total;
    let i = S.findIndex((v) => v >= s);
    if (i <= 0) i = 1;
    const a = pts[i - 1], b = pts[i], t = (s - S[i - 1]) / (S[i] - S[i - 1] || 1);
    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    if ((c0[0] - q[0]) * nx + (c0[1] - q[1]) * ny < 0) (nx = -nx), (ny = -ny); // pointing inward
    return { p: q, n: [nx, ny] };
  };
  let s = R() * 6;
  const end = s + total - 3;
  while (s < end) {
    const len = 9 + R() * 4, th = 2.2 + R() * 0.4, off = 0.25 + th / 2;
    if (s + len > end) break;
    if ([0, 0.5, 1].some((u) => skip(at(s + u * len).p))) {
      s += 2.5;
      continue;
    }
    const top = [], bot = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12, q = at(s + u * len), w = th * Math.sin(Math.PI * u) ** 0.55;
      const c = [q.p[0] + q.n[0] * off, q.p[1] + q.n[1] * off];
      top.push([c[0] + (q.n[0] * w) / 2, c[1] + (q.n[1] * w) / 2]);
      bot.push([c[0] - (q.n[0] * w) / 2, c[1] - (q.n[1] * w) / 2]);
    }
    L.add("myo", smoothClosed([...top, ...bot.reverse()], 0.8));
    const m = at(s + len * (0.42 + R() * 0.16));
    L.add("myoNuc", ellipse(m.p[0] + m.n[0] * off, m.p[1] + m.n[1] * off, 1.7, 0.5, (Math.atan2(m.n[0], -m.n[1]) * 180) / Math.PI));
    s += len + 3 + R() * 5;
  }
}

/**
 * Crowded atypical cells filling `outline` (Voronoi cells): pleomorphic dark nuclei, random orientation, mitoses.
 * holes [[x, y, r, kind]] (cribriform lumens, necrosis, intra-epithelial lymphocytes): the cells stop at the hole's
 * edge (cut along its tangent), so nothing drawn in the hole covers a cell or nucleus. Every nucleus is fitted
 * inside its own cell and kept `edge` clear of the outline (the basement membrane).
 */
function atypicalCells(L, outline, { seed, spacing = 9.5, holes = [], mitoses = 0, nucR = 4.3, bg = true, keys = ["tum", "tumNuc"], edge = 1.3, fixed = [], edgeFree = null }) {
  const R = rng(seed);
  if (bg) L.add("tumBg", polyD(outline));
  const box = bbox(outline);
  // cribriform lumens: a ring of 6–9 cells radiating round each one, their nuclei pointing at the lumen
  const ring = [];
  for (const [x, y, r, kind] of holes) {
    if (kind !== "crib") continue;
    const rr = r + 3.9, n = Math.max(6, Math.min(9, Math.round((2 * Math.PI * rr) / 6.4)));
    const a0 = R() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const a = a0 + ((k + (R() - 0.5) * 0.2) * 2 * Math.PI) / n;
      const p = [x + Math.cos(a) * rr, y + Math.sin(a) * rr];
      if (inside(outline, p) && polyDist(p, outline) > 2.4) ring.push({ p, at: [x, y] });
    }
  }
  const pre = [...ring.map((q) => q.p), ...fixed];
  const count = Math.ceil(area(outline) / (spacing * spacing * 0.8)) - pre.length;
  const free = packWhere(box, Math.max(0, count), spacing, (p) => inside(outline, p) && polyDist(p, outline) > spacing * 0.3 &&
    !holes.some(([x, y, r, kind]) => dist(p, [x, y]) < r + (kind === "crib" ? 7.6 : spacing * 0.35)) && !pre.some((q) => dist(p, q) < spacing * 0.85), { seed, tries: 120 });
  const seeds = [...pre, ...free];
  // each hole is cut out along its own curve (round, punched-out spaces rather than straight cuts)
  const cells = voronoi(seeds, outline, spacing * 3).map((poly, i) =>
    holes.reduce((pg, [x, y, r, kind, rFn]) => (pg.length < 3 || dist(seeds[i], [x, y]) > r * 1.15 + spacing * 2.5 ? pg : cutDisc(pg, [x, y], rFn || r)), poly),
  );
  const clear = (t) => polyDist(t, outline) > edge || (edgeFree && edgeFree(t));
  let mits = 0;
  cells.forEach((poly, i) => {
    if (poly.length < 3 || area(poly) < 9) return;
    const ctr = innerCentre(poly);
    if (i < ring.length) {
      // a cell round a cribriform lumen: elongated nucleus aimed at the lumen
      L.add(keys[0], roundPoly(poly, 1.1));
      const at = ring[i].at, a = Math.atan2(ctr[1] - at[1], ctr[0] - at[0]);
      const p = [ctr[0] + Math.cos(a) * 0.5, ctr[1] + Math.sin(a) * 0.5];
      const fit = fitInside(pleoPts(p[0], p[1], nucR * (0.9 + R() * 0.25), R, 1.3, (a * 180) / Math.PI + (R() - 0.5) * 16), p, poly, { margin: 0.75, clear, minK: 0.35 });
      if (fit) L.add(keys[1], smoothClosed(fit));
      return;
    }
    if (mits < mitoses && i % 7 === 3 && polyDist(ctr, outline) > 3) {
      const fig = fitMitosis(poly, ctr, R);
      if (fig) {
        L.add("tumMit", roundPoly(poly, 3.2));
        L.add("mitosis", fig);
        mits++;
        return;
      }
    }
    L.add(keys[0], roundPoly(poly, 1.3));
    // enlarged, pleomorphic nuclei (≥ 1.7 × a lymphocyte nucleus, N:C ≈ 0.6–0.7); now and then a bizarre giant one
    const r = nucR * (R() < 0.025 ? 1.55 : 0.75 + R() * 0.7);
    const p = [ctr[0] + (R() - 0.5) * 1.2, ctr[1] + (R() - 0.5) * 1.2];
    const fit =
      fitInside(pleoPts(p[0], p[1], r, R, 1 + R() * 0.25), p, poly, { margin: 0.5, clear }) ||
      fitInside(pleoPts(ctr[0], ctr[1], r, R), ctr, poly, { margin: 0.5, clear, minK: 0.3 });
    if (!fit) return;
    L.add(keys[1], smoothClosed(fit));
    const nc = centroid(fit);
    if (R() < 0.35 && Math.min(...fit.map((q) => dist(q, nc))) > 1.7) L.add("nucleolus", circle(nc[0] + (R() - 0.5) * 0.8, nc[1] + (R() - 0.5) * 0.8, 0.7));
  });
}

/**
 * A duct outline (oval with a little wobble). With `breach` {toward, tongue, bulge} it bulges out as a
 * tongue of tumour toward breach.toward (±tongue degrees wide, bulge units high).
 */
function ductPts(g, { grow = 0, n = 72, seed, breach = null }) {
  const { cx, cy, rx, ry, rot } = g;
  const pts = ovalPts(cx, cy, rx + grow, ry + grow, { rot, wobble: 0.04, seed, n });
  if (!breach) return pts;
  const phi = Math.atan2(breach.toward[1] - cy, breach.toward[0] - cx);
  return pts.map((p) => {
    const d = Math.abs(angDiff(Math.atan2(p[1] - cy, p[0] - cx), phi)) / rad(breach.tongue);
    if (d >= 1) return p;
    const h = breach.bulge * Math.cos((d * Math.PI) / 2) ** 1.3, l = dist(p, [cx, cy]);
    return [p[0] + ((p[0] - cx) / l) * h, p[1] + ((p[1] - cy) / l) * h];
  });
}
/** The tip of a breached duct's tongue and the direction it points (for the stream of buds beyond it). */
function tongueTip(g, seed, breach) {
  const phi = Math.atan2(breach.toward[1] - g.cy, breach.toward[0] - g.cx), u = [Math.cos(phi), Math.sin(phi)];
  const pts = ductPts(g, { n: 240, seed, breach });
  const tip = pts.reduce((b, p) => ((p[0] - g.cx) * u[0] + (p[1] - g.cy) * u[1] > (b[0] - g.cx) * u[0] + (b[1] - g.cy) * u[1] ? p : b), pts[0]);
  return { tip, u, phi };
}

/**
 * Carcinoma in situ: an expanded duct filled with atypical cells, the basement membrane and a discontinuous
 * myoepithelial layer intact — or, with `breach`, torn open where a tongue of tumour cells pushes out.
 */
function cisDuct(L, g, seed, { pattern = "solid", breach = null, tils = [] } = {}) {
  const R = rng(seed);
  const { cx, cy, rx, ry } = g;
  const phi = breach ? Math.atan2(breach.toward[1] - cy, breach.toward[0] - cx) : 0;
  const inGap = (p, extra = 0) => !!breach && Math.abs(angDiff(Math.atan2(p[1] - cy, p[0] - cx), phi)) < rad(breach.half + extra);
  const bmPts = ductPts(g, { grow: 1.1, n: 120, seed });
  if (!breach) L.add("bm", ring(bmPts));
  else {
    // breached basement membrane: one arc whose two ends fray and curl outward along the flanks of the tongue
    const n = bmPts.length;
    const k0 = bmPts.findIndex((p, i) => !inGap(p) && inGap(bmPts[(i + n - 1) % n]));
    const arc = [];
    for (let k = 0; k < n; k++) {
      const p = bmPts[(k0 + k) % n];
      if (inGap(p)) break;
      arc.push(p);
    }
    const curl = (end, prev, adv, rise, steps) => {
      const tl = dist(end, prev), t = [(end[0] - prev[0]) / tl, (end[1] - prev[1]) / tl];
      const ol = dist(end, [cx, cy]), o = [(end[0] - cx) / ol, (end[1] - cy) / ol];
      return Array.from({ length: steps }, (_, j) => {
        const k = j + 1;
        return [end[0] + t[0] * adv * k + o[0] * rise * k * k, end[1] + t[1] * adv * k + o[1] * rise * k * k];
      });
    };
    const m = arc.length;
    // each torn end curls outward 4–5 units, part of the same stroke
    L.add("bm", smoothOpen([...curl(arc[0], arc[1], 0.95, 0.24, 4).reverse(), ...arc, ...curl(arc[m - 1], arc[m - 2], 0.95, 0.24, 4)]));
  }
  const outline = ductPts(g, { n: breach ? 150 : 72, seed, breach });
  const holes = [];
  if (pattern === "cribriform") {
    // 3–5 round, rigid, punched-out lumens spread across the duct, with cell bridges between them
    const lum = packWhere(bbox(outline), 5, 25, (q) => inside(outline, q) && polyDist(q, outline) > 13.5 && !inGap(q, 12) && !tils.some((t) => dist(q, t) < 14), { seed: seed + 1, tries: 3000 });
    for (const p of lum) holes.push([p[0], p[1], 4.2 + R() * 1.8, "crib"]);
  } else if (pattern === "comedo") {
    const r = Math.min(rx, ry) * 0.42;
    holes.push([cx + 2, cy, r, "comedo", wobblyR(r, 0.07, seed + 3)]);
  }
  for (const [x, y] of tils) holes.push([x, y, 4.2, "til"]);
  // a breached duct: two cells at the base of the tongue and a smaller one at its tip
  const fixed = [];
  if (breach) {
    const { tip, u } = tongueTip(g, seed, breach), v = [-u[1], u[0]];
    const b = [tip[0] - u[0] * (breach.bulge + 1.2), tip[1] - u[1] * (breach.bulge + 1.2)];
    fixed.push([b[0] + v[0] * 5.4, b[1] + v[1] * 5.4], [b[0] - v[0] * 5.4, b[1] - v[1] * 5.4], [tip[0] - u[0] * 4.2, tip[1] - u[1] * 4.2]);
  }
  // nuclei keep clear of the myoepithelial row (except in the tongue, where it is lost)
  atypicalCells(L, outline, { seed: seed + 2, holes, mitoses: pattern === "solid" ? 2 : 1, edge: 3.4, fixed, edgeFree: breach ? (t) => inGap(t, 2) : null });
  myoCells(L, ductPts(g, { n: 120, seed }), seed + 4, (q) => inGap(q, 6));
  for (const [x, y, r, kind, rFn] of holes) {
    // drawn beneath the cells: the round lumen (its thin rim shows at the cut) or the necrosis
    if (kind === "crib") L.add("glandLumen", circle(x, y, r + 0.2));
    else if (kind === "comedo") necroticFocus(L, [x, y], r, seed + 5, { calc: true, rFn });
  }
}

/**
 * Necrosis: eosinophilic debris with ghost-cell outlines and karyorrhectic nuclear dust (beneath the
 * surrounding cells); in comedo DCIS often with a laminated microcalcification.
 */
function necroticFocus(L, [x, y], r, seed, { neutrophils = 0, calc = false, rFn = null } = {}) {
  const R = rng(seed);
  L.add("necrosis", blob(x, y, r * 1.3, r * 1.22, { n: 10, wobble: 0.05, seed }));
  const cal = calc ? [x + (R() - 0.5) * r * 0.3, y + (R() - 0.5) * r * 0.25] : null;
  if (cal) {
    L.add("calc", circle(cal[0], cal[1], 2.1));
    L.add("calcRing", [circle(cal[0], cal[1], 1.3), circle(cal[0], cal[1], 0.6)]);
  }
  const avoid = cal ? [[cal[0], cal[1], 3.4]] : [];
  const neu = packIn(x, y, r * 0.5, r * 0.4, neutrophils, 8, { seed: seed + 2 });
  // faint ghost outlines of dead cells
  const ghosts = packIn(x, y, r * 0.62, r * 0.55, Math.min(4, Math.round(r / 3.5)), 7.4, { seed: seed + 3, avoid: [...avoid, ...neu.map(([a, b]) => [a, b, 7])] });
  for (const [gx, gy] of ghosts) L.add("ghost", blob(gx, gy, 3.3, 2.8, { n: 7, wobble: 0.12, seed: Math.round(gx * 5 + gy), rot: R() * 180 }));
  const inside0 = (p) => !rFn || dist(p, [x, y]) < rFn(Math.atan2(p[1] - y, p[0] - x)) - 1.2;
  for (const p of packIn(x, y, r * 0.78, r * 0.68, Math.round(r * 2.6), 1.75, { seed: seed + 1, avoid: [...avoid, ...neu.map(([a, b]) => [a, b, 5.2])] })) {
    if (!inside0(p)) continue;
    L.add("debris", R() < 0.6 ? circle(p[0], p[1], 0.45 + R() * 0.5) : capsule(p[0] - 0.8, p[1], p[0] + 0.8, p[1] + (R() - 0.5) * 1.4, 0.4));
  }
  for (const p of neu) neutro(L, p, R, ["neutb", "neutbNuc"], 0.8);
}

/**
 * An infiltrating malignant gland: angular outline, one row of tall atypical columnar cells with crowded,
 * stratified, elongated nuclei in their basal two-thirds, a slit-like lumen, no basement membrane.
 * tilAt (deg): leave one cell slot for an intra-epithelial lymphocyte and return its position.
 */
function invasiveGland(L, outer, seed, { dirty = false, tilAt = null, round = false } = {}) {
  const R = rng(seed);
  const c0 = centroid(outer);
  L.add("tumBg", polyD(outer));
  const lumenR = round ? Math.min(...outer.map((q) => dist(q, c0))) * 0.42 : null;
  const { cells, inner } = ringCells(outer, { rows: 1, th: 12, cellLen: 6.2, jitter: 0.16, seed, minFrac: 0.16, lumenR });
  L.add("glandLumen", polyD(inner));
  let tilK = -1;
  if (tilAt != null) {
    // the roomiest cell slot within 45° of the requested direction
    let best = -Infinity;
    cells.forEach(({ poly, base }, k) => {
      const d = Math.abs(angDiff(Math.atan2(base[1] - c0[1], base[0] - c0[0]), rad(tilAt)));
      const sc = d < rad(45) ? area(poly) : -d;
      if (sc > best) (best = sc), (tilK = k);
    });
  }
  let til = null;
  cells.forEach(({ poly, base, apex }, k) => {
    if (k === tilK) {
      til = [base[0] + (apex[0] - base[0]) * 0.5, base[1] + (apex[1] - base[1]) * 0.5];
      return;
    }
    L.add("tum", roundPoly(poly, 0.9));
    const h = dist(base, apex);
    const t = (k % 2 ? 0.4 : 0.3) + (R() - 0.5) * 0.06;
    const c = [base[0] + (apex[0] - base[0]) * t, base[1] + (apex[1] - base[1]) * t];
    const ang = (Math.atan2(apex[1] - base[1], apex[0] - base[0]) * 180) / Math.PI;
    const pts = blobPts(c[0], c[1], h * (0.27 + R() * 0.05), 1.75 + R() * 0.5, { n: 8, wobble: 0.1, seed: seed * 7 + k, rot: ang + (R() - 0.5) * 14 });
    const fit = fitInside(pts, c, poly, { margin: 0.55, minK: 0.4 });
    if (fit) L.add("tumNuc", smoothClosed(fit));
  });
  if (dirty) for (const p of packWhere(bbox(inner), 6, 2.4, (q) => inside(inner, q) && polyDist(q, inner) > 1.5, { seed })) L.add("debris", circle(p[0], p[1], 0.6 + R() * 0.3));
  return til;
}

/**
 * A capillary in cross-section for these panels (local, so the other library sections keep theirs): a thin
 * wall with 2–3 endothelial nuclei and one red cell nearly filling the lumen — a red cell is about the size
 * of a small lymphocyte.
 */
function capillary(L, { cx, cy, rx, ry, rot = 0, seed = 1 }) {
  const R = rng(seed);
  const wall = 1.6, rr = (rot * Math.PI) / 180;
  L.add("wall", ellipse(cx, cy, rx, ry, rot));
  L.add("lumen", ellipse(cx, cy, rx - wall, ry - wall, rot));
  L.add("rbc", rbc(cx + (R() - 0.5) * 0.5, cy + (R() - 0.5) * 0.5, (Math.min(rx, ry) - wall) * 0.9, rot + (R() - 0.5) * 30));
  const n = 2 + Math.floor(R() * 2), a0 = R() * 360;
  for (let k = 0; k < n; k++) {
    const a = ((a0 + (k * 360) / n + (R() - 0.5) * 40) * Math.PI) / 180;
    const lx = Math.cos(a) * (rx - wall * 0.55), ly = Math.sin(a) * (ry - wall * 0.55);
    L.add("endo", ellipse(cx + lx * Math.cos(rr) - ly * Math.sin(rr), cy + lx * Math.sin(rr) + ly * Math.cos(rr), 2.2, 0.95, (Math.atan2(ly, lx) * 180) / Math.PI + rot + 90));
  }
}

/** Stroma fibroblast (quiet: slender, thin dark nucleus) or CAF (plump, side processes, pale nucleus, stress fibres). */
function stromalCell(L, [x, y], ang, R, caf = false) {
  if (caf) {
    const s = 0.95 + R() * 0.15;
    const bumps = [[0, 8 * s, 9], [180, 7.5 * s, 9], [-70 + (R() - 0.5) * 30, 2.4 * s, 17], [110 + (R() - 0.5) * 30, 2.1 * s, 17]];
    if (R() < 0.6) bumps.push([R() < 0.5 ? -135 : 45, 2 * s, 15]);
    L.add("caf", smoothClosed(starPts(x, y, 6.6 * s, 3.1 * s, bumps, { rot: ang, seed: Math.round(x * 3 + y), bend: (R() - 0.5) * 4, n: 72 }), 0.9));
    L.add("cafFib", [-1, 1].map((k) => smoothOpen(xform([[-11 * s, k * 0.5], [-4, k * 1.4], [4, k * 1.4], [11 * s, k * 0.5]], x, y, ang))));
    L.add("cafNuc", ellipse(x + Math.cos(rad(ang)) * 0.8, y + Math.sin(rad(ang)) * 0.8, 3.9, 2.1, ang));
  } else {
    L.add("fibro", spindle(x, y, 20 + R() * 4, 2.2, ang, { bend: (R() - 0.5) * 0.6 }));
    L.add("fibroNuc", ellipse(x, y, 4, 0.8, ang));
  }
}

/** Angiogenic tumour vessel: irregular, dilated, thin-walled, with an endothelial gap (leaky). Returns {pts, leaked}. */
function angioVessel(L, { cx, cy, rx, ry, rot = 0, gap = null, seed, rbcs = 3, leak = 0 }) {
  const R = rng(seed);
  const pts = ovalPts(cx, cy, rx, ry, { rot, wobble: 0.3, seed, n: 70 });
  L.add("angioLumen", polyD(pts));
  if (gap) {
    const n = pts.length, i0 = Math.round(gap[0] * n), i1 = Math.round(gap[1] * n);
    const arc = [];
    for (let k = i1; k <= i0 + n; k++) arc.push(pts[k % n]);
    L.add("angioWall", lineD(arc));
  } else L.add("angioWall", ring(pts));
  for (let k = 0; k < 4; k++) {
    const i = Math.floor(((k + 0.2 + R() * 0.5) / 4) * pts.length), p = pts[i], q = pts[(i + 2) % pts.length];
    if (gap && i / pts.length > gap[0] - 0.04 && i / pts.length < gap[1] + 0.04) continue;
    L.add("angioEndo", ellipse(p[0], p[1], 2.6, 1, (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI));
  }
  for (const p of packIn(cx, cy, rx * 0.55, ry * 0.45, rbcs, 6.5, { seed })) L.add("angioRbc", rbc(p[0], p[1], 2.7, R() * 180));
  const leaked = [];
  if (gap && leak) {
    const i = Math.round(((gap[0] + gap[1]) / 2) * pts.length), p = pts[i % pts.length];
    const dx = p[0] - cx, dy = p[1] - cy, dl = Math.hypot(dx, dy) || 1;
    for (let k = 0; k < leak; k++) {
      const o = 3 + k * 4.6;
      const q = [p[0] + (dx / dl) * o + (R() - 0.5) * 3, p[1] + (dy / dl) * o + (R() - 0.5) * 3];
      L.add("angioRbc", rbc(q[0], q[1], 2.5, R() * 180));
      leaked.push(q);
    }
  }
  return { pts, leaked };
}

/** Walk `len` units along a closed outline from index i0 (dense points). */
function walkClosed(pts, i0, len) {
  const out = [pts[i0 % pts.length]];
  let acc = 0;
  for (let k = 1; k < pts.length && acc < len; k++) {
    const p = pts[(i0 + k) % pts.length];
    acc += dist(p, out[out.length - 1]);
    out.push(p);
  }
  return out;
}
/** Gentle sideways wave along a dense polyline (amplitude amp, wavelength wl). */
function waveLine(pts, amp, wl, phase = 0) {
  let acc = 0;
  return pts.map((p, i) => {
    if (i) acc += dist(p, pts[i - 1]);
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], l = dist(a, b) || 1;
    const w = Math.sin((acc / wl) * Math.PI * 2 + phase) * amp;
    return [p[0] - ((b[1] - a[1]) / l) * w, p[1] + ((b[0] - a[0]) / l) * w];
  });
}
const pathLen = (pts) => pts.reduce((s, p, i) => (i ? s + dist(p, pts[i - 1]) : 0), 0);

function carcinoma(stage, seed = 301) {
  const R = rng(seed), L = new Layers();
  sectionLayers(L, stage);
  L.add("stroma", polyD(FRAME));
  const inFrame = (p, m = 0) => inside(FRAME, p) && polyDist(p, FRAME) > m;

  if (stage !== "invasive") {
    const cis = stage === "cis";
    const scale = (i) => (cis && [0, 3, 4].includes(i) ? 1.1 : cis && i === 2 ? 1.04 : 1);
    const gl = GLANDS.map((g, i) => ({ ...g, rx: g.rx * scale(i), ry: g.ry * scale(i) }));
    const inGland = (p, pad) => gl.some((g) => {
      const a = (-g.rot * Math.PI) / 180, dx = p[0] - g.cx, dy = p[1] - g.cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      return (lx / (g.rx + pad)) ** 2 + (ly / (g.ry + pad)) ** 2 < 1;
    });
    const box = { x: 8, y: 8, w: W - 16, h: H - 16 };
    const free = (p, pad) => inFrame(p, pad) && !inGland(p, pad);
    // quiet stroma: slender fibroblasts, capillaries, a few immune cells, then the collagen (below)
    const caps = packWhere(box, 7, 34, (q) => free(q, 12), { seed: seed + 2 });
    caps.forEach((p, k) => capillary(L, { cx: p[0], cy: p[1], rx: 6 + R(), ry: 5 + R(), rot: R() * 180, seed: seed + 10 + k }));
    const taken = caps.map((c) => [c[0], c[1], 8]);
    const busy = (q, pad) => taken.some(([x, y, r]) => dist(q, [x, y]) < r + pad);
    // periglandular fibroblasts run parallel to the nearest gland
    const tangent = (p) => {
      const g = gl.reduce((b, c) => (dist(p, [c.cx, c.cy]) - c.rx < dist(p, [b.cx, b.cy]) - b.rx ? c : b), gl[0]);
      return (Math.atan2(p[1] - g.cy, p[0] - g.cx) * 180) / Math.PI + 90 + (R() - 0.5) * 30;
    };
    for (const p of packWhere(box, 11, 24, (q) => free(q, 7) && !busy(q, 10), { seed: seed + 3 })) {
      stromalCell(L, p, tangent(p), R);
      taken.push([p[0], p[1], 6]);
    }
    // a few resident immune cells, incl. plasma cells (more lymphocytes round the ducts in carcinoma in situ)
    const imm = packWhere(box, cis ? 14 : 5, 12, (q) => free(q, 7) && !busy(q, 5) && (!cis || inGland(q, 18)), { seed: seed + 4 });
    imm.forEach((p, k) => {
      if (k % 5 === 4 || (!cis && k === 1)) L.add("plasma", ellipse(p[0], p[1], 5.6, 4, R() * 180)), L.add("plasmaNuc", circle(p[0] + 1.6, p[1], 2.2));
      else roundCell(L, p, 3.8, "tcell", "tnuc", R);
      taken.push([p[0], p[1], 5]);
    });
    if (!cis) {
      const mc = packWhere(box, 1, 0, (q) => free(q, 13) && !busy(q, 10), { seed: seed + 5 })[0];
      mastCell(L, mc, seed + 6);
      taken.push([mc[0], mc[1], 7]);
    }
    // collagen: long bundles of 2–3 parallel wavy strands wrapping round the glands 4–14 units out (some
    // converging between neighbouring glands), plus a few long single fibres across the open stroma.
    // Every strand is cut where it would cross a gland, a cell or a capillary.
    {
      const RC = rng(seed + 8);
      const clearOf = (q) => inFrame(q, 4) && !inGland(q, 2.2) && !taken.some(([x, y, r]) => dist(q, [x, y]) < r + 2.2);
      const strandRuns = (pts, minLen) => {
        let cur = [];
        const out = [];
        const flush = () => {
          if (cur.length > 2 && pathLen(cur) >= minLen) out.push(cur);
          cur = [];
        };
        for (const q of pts) (clearOf(q) ? cur.push(q) : flush());
        flush();
        return out;
      };
      let made = 0;
      for (let pass = 0; pass < 3 && made < 11; pass++) {
        gl.forEach((g, gi) => {
          if (made >= 11 || (pass === 2 && RC() < 0.5)) return;
          const O = ovalPts(g.cx, g.cy, g.rx, g.ry, { rot: g.rot, n: 160 });
          const d0 = pass === 0 ? 4.5 + RC() * 2.5 : pass === 1 ? 8 + RC() * 3 : 11 + RC() * 3;
          const ns = RC() < 0.4 ? 3 : 2, sp = 2.5 + RC() * 1, len = 40 + RC() * 60, i0 = Math.floor(RC() * O.length);
          const amp = 0.6 + RC() * 0.6, wl = 18 + RC() * 8, ph = RC() * 6;
          let any = false;
          for (let k = 0; k < ns; k++) {
            for (const run of strandRuns(waveLine(resample(walkClosed(offsetClosed(O, d0 + k * sp), i0, len), 1.4), amp, wl, ph), 14)) {
              L.add("collagen", smoothOpen(run));
              any = true;
            }
          }
          if (any) made++;
        });
      }
      // long single fibres crossing the open stroma, unevenly spaced
      for (let k = 0, got = 0; k < 40 && got < 4; k++) {
        const a = RC() * Math.PI, c = [24 + RC() * (W - 48), 24 + RC() * (H - 48)];
        if (!clearOf(c)) continue;
        const l = 40 + RC() * 50, u = [Math.cos(a), Math.sin(a)];
        const line = resample([[c[0] - u[0] * l, c[1] - u[1] * l], [c[0] + u[0] * l, c[1] + u[1] * l]], 1.4);
        const runs = strandRuns(waveLine(line, 0.9 + RC() * 0.5, 20 + RC() * 8, RC() * 6), 24);
        runs.forEach((r) => L.add("collagen", smoothOpen(r)));
        if (runs.length) got++;
      }
    }
    gl.forEach((g, i) => {
      if (cis && i === 0) cisDuct(L, g, seed + 20, { pattern: "cribriform" });
      else if (cis && i === 2) cisDuct(L, g, seed + 22, { pattern: "solid" });
      else if (cis && i === 3) cisDuct(L, g, seed + 23, { pattern: "cribriform" });
      else if (cis && i === 4) cisDuct(L, g, seed + 24, { pattern: "comedo" });
      else normalGland(L, g, seed + 30 + i);
    });
    return { size: [W, H], lineWidth: 1.2, parts: L.parts() };
  }

  /* ---------- invasive carcinoma ---------- */
  // The invasive front hugs the outermost tumour (a small nest, two buds, two glands); the desmoplastic
  // tumour bed lies on its left, the looser host stroma on its right.
  const front = catmull([[247, 0], [249, 14], [254, 30], [254, 44], [250, 52], [258, 60], [268, 70], [266, 82], [263, 92], [266, 104], [264, 118], [254, 130], [244, 141], [250, 154], [268, 166], [271, 178], [258, 189], [261, 202], [264, 216], [256, 230], [262, 246]], 8);
  L.add("desmo", polyD(clipConvex([[0, 0], ...front, [0, 246]], roundRectPts(6.6, 6.6, W - 13.2, H - 13.2, 8.6))));
  const frontX = (y) => {
    let best = front[0];
    for (const p of front) if (Math.abs(p[1] - y) < Math.abs(best[1] - y)) best = p;
    return best[0];
  };
  const inBed = (p) => p[0] < frontX(p[1]);
  const sFront = (q) => (inBed(q) ? -1 : 1) * lineDist(q, front);

  // tumour elements
  const D = { cx: 68, cy: 64, rx: 46, ry: 35, rot: -12 }; // residual in-situ component, now breached
  // the breach faces lower right (about 4–5 o'clock): a tongue of tumour pushes out through it, then buds
  const BR = { toward: [116, 95], half: 37, tongue: 30, bulge: 19 };
  const Dpoly = ductPts(D, { grow: 2, n: 90, seed: seed + 20, breach: BR });
  const TT = tongueTip(D, seed + 20, BR);
  const streamAt = (o) => [TT.tip[0] + TT.u[0] * o, TT.tip[1] + TT.u[1] * o];
  const NC = [166, 158];
  const nestN = ovalPts(NC[0], NC[1], 38, 28, { rot: 8, wobble: 0.2, seed: seed + 40, n: 80 });
  // four different infiltrating structures, sizes varying ~1.5×: a large tubule with a slit lumen and dirty
  // necrosis, a smaller angulated tubule with an open round lumen, a branched gland (two lumens, the branch
  // budding off the lower left one) and a solid cord 3–4 cells wide without a lumen (lower right)
  const glands = [
    { cx: 180, cy: 52, rx: 26, ry: 16, rot: 16, corners: 5, dirty: true },
    { cx: 238, cy: 106, rx: 17.5, ry: 14.5, rot: -32, corners: 5, tilAt: 150, round: true },
    { cx: 96, cy: 204, rx: 18, ry: 11.5, rot: -12, corners: 4 },
    { cx: 0, cy: 0, rx: 11.5, ry: 8.5, rot: 38, corners: 4 },
  ];
  const gOut = glands.map((g, i) => angularPts(g.cx, g.cy, g.rx, g.ry, { rot: g.rot, corners: g.corners, seed: seed + 50 + i }));
  {
    // the branch: set against the lower-left gland so the two just touch, budding off toward the lower right
    const u = [Math.cos(rad(22)), Math.sin(rad(22))], A = gOut[2], B = gOut[3];
    const ca = centroid(A), cb = centroid(B);
    const ra = Math.max(...A.map((q) => (q[0] - ca[0]) * u[0] + (q[1] - ca[1]) * u[1]));
    const rb = Math.max(...B.map((q) => -((q[0] - cb[0]) * u[0] + (q[1] - cb[1]) * u[1])));
    const to = [ca[0] + u[0] * (ra + rb + 0.6), ca[1] + u[1] * (ra + rb + 0.6)];
    gOut[3] = B.map((q) => [q[0] - cb[0] + to[0], q[1] - cb[1] + to[1]]);
    Object.assign(glands[3], { cx: to[0], cy: to[1] });
  }
  const solidCord = ovalPts(232, 206, 22, 14.5, { rot: 24, wobble: 0.13, seed: seed + 55, n: 60 });
  const small = [
    ovalPts(232, 36, 12, 8.5, { rot: 20, wobble: 0.2, seed: seed + 60, n: 40 }),
    ovalPts(58, 128, 12, 9, { rot: -10, wobble: 0.2, seed: seed + 61, n: 40 }),
    ovalPts(122, 136, 7.5, 6, { rot: 30, wobble: 0.15, seed: seed + 62, n: 30 }),
  ];
  // tumour buds and single cells streaming out of the breach (smaller and more spindle-shaped the further
  // they go: [x, y, r, elongation, rotation]) and at the front
  // [distance from the tip, sideways offset, r, elongation, turn]: unevenly spaced, the track bending slightly
  const cord = [[6, 0, 4.5, 1.15, 0], [14.4, 1.2, 4.1, 1.3, 6], [22.1, 0.6, 3.8, 1.45, -4], [31.6, 2.4, 3.4, 1.7, 12], [41.2, 3.4, 3.2, 1.95, 16]]
    .map(([o, sd, r, e, da]) => { const q = streamAt(o); return [q[0] - TT.u[1] * sd, q[1] + TT.u[0] * sd, r, e, TT.phi + rad(da)]; });
  const buds = [...cord, [252, 66, 4.8], [256, 170, 4.6], [144, 214, 4.6]].map(([x, y, r, e = 1, a = null]) => [x, y, r, e, a == null ? null : (a * 180) / Math.PI]);
  const vessels = [
    { cx: 52, cy: 194, rx: 27, ry: 11, rot: -14, gap: [0.83, 0.88], seed: seed + 70, rbcs: 4 },
    { cx: 202, cy: 98, rx: 13, ry: 8, rot: 20, gap: [0.2, 0.27], seed: seed + 71, rbcs: 2, leak: 3 },
    { cx: 98, cy: 150, rx: 9, ry: 6.5, rot: 60, seed: seed + 72, rbcs: 1 },
  ];
  // where the tumour cell crosses the wall of the big vessel (the middle of its endothelial gap): gp, wall
  // tangent t and outward normal n; the TMEM macrophage touches the cell's outer half
  const intra = (() => {
    const v = vessels[0], pts = ovalPts(v.cx, v.cy, v.rx, v.ry, { rot: v.rot, wobble: 0.3, seed: v.seed, n: 70 }), n = pts.length, gi = Math.round(0.855 * n), gp = pts[gi];
    const a = pts[(gi + n - 2) % n], b = pts[(gi + 2) % n], tl = dist(a, b);
    const t = [(b[0] - a[0]) / tl, (b[1] - a[1]) / tl];
    let nn = [t[1], -t[0]];
    if ((gp[0] - vessels[0].cx) * nn[0] + (gp[1] - vessels[0].cy) * nn[1] < 0) nn = [-nn[0], -nn[1]];
    return { gp, t, n: nn, at: (lx, ly) => [gp[0] + nn[0] * lx + t[0] * ly, gp[1] + nn[1] * lx + t[1] * ly] };
  })();
  const tmemTam = intra.at(9.5, TMEM_SIDE * 12.8);
  const tumourPolys = [Dpoly, nestN, ...gOut, solidCord, ...small];
  const vPolys = vessels.map((v) => ovalPts(v.cx, v.cy, v.rx + 2, v.ry + 2, { rot: v.rot, wobble: 0.3, seed: v.seed, n: 40 }));
  const occupied = (p, pad) => tumourPolys.some((q) => near(p, q, pad)) || vPolys.some((q) => near(p, q, pad)) || buds.some(([x, y, r, e]) => dist(p, [x, y]) < r * e + pad) ||
    [[...intra.at(6.8, 0), 7.5], [...tmemTam, 8]].some(([x, y, r]) => dist(p, [x, y]) < r + pad);
  const box = { x: 8, y: 8, w: W - 16, h: H - 16 };
  const centres = [[D.cx, D.cy], NC, ...glands.map((g) => [g.cx, g.cy]), [232, 206], [232, 36], [58, 128], [122, 136]];
  const nearestCentre = (p) => centres.reduce((b, c) => (dist(p, c) < dist(p, b) ? c : b), centres[0]);
  const capAt = [[292, 54], [300, 132]];
  const capOcc = (q, pad) => capAt.some((c) => dist(q, c) < 9 + pad);

  // host stroma beyond the front: loose, thin, wavy collagen
  for (const [dx, amp, wl, ph] of [[13, 0.9, 22, 0.4], [21.5, 1.1, 26, 2.1], [30, 0.8, 19, 4.2], [40, 1.2, 24, 1.3]]) {
    const run = waveLine(resample(front.map(([x, y]) => [x + dx + Math.sin(y * 0.031 + ph) * 2.2, y]), 1.6), amp, wl, ph);
    let cur = [];
    const flush = () => {
      if (cur.length > 8) L.add("collagen", smoothOpen(cur));
      cur = [];
    };
    for (const q of run) (inFrame(q, 4) && sFront(q) > 4 && !capOcc(q, 2.5) ? cur.push(q) : flush());
    flush();
  }

  // desmoplasia: thick collagen bundles in parallel runs of 2–3 strands
  const bundlePts = [];
  const bundleOk = (p) => inFrame(p, 4) && sFront(p) < -2 && !occupied(p, 2.6) && !capOcc(p, 3);
  const freeOfBundles = (p) => !bundlePts.some((b) => Math.abs(b[0] - p[0]) < 2.8 && Math.abs(b[1] - p[1]) < 2.8);
  const addBundle = (strands, minLen) => {
    const all = [];
    for (const s of strands) {
      let cur = [];
      const flush = () => {
        if (cur.length > 1 && pathLen(cur) >= minLen) L.add("bundle", smoothOpen(cur)), all.push(...cur);
        cur = [];
      };
      for (const p of s) (bundleOk(p) && freeOfBundles(p) ? cur.push(p) : flush());
      flush();
    }
    bundlePts.push(...all);
    return all.length > 0;
  };
  // at the invasive front: straight bundles running out perpendicular to the tumour edge beside the buds (TACS-3)
  for (const [bx, by, br] of [[...streamAt(14), 6], [...streamAt(32), 5], [252, 66, 4.8], [256, 170, 4.6]]) {
    const c = nearestCentre([bx, by]), l = dist([bx, by], c), u = [(bx - c[0]) / l, (by - c[1]) / l], nn = [-u[1], u[0]];
    addBundle([-1, 1].map((sd) => {
      const o = br + 3.4 + R() * 1.2;
      const a = [bx + nn[0] * o * sd - u[0] * 11, by + nn[1] * o * sd - u[1] * 11];
      return Array.from({ length: 18 }, (_, i) => [a[0] + u[0] * i * 1.6, a[1] + u[1] * i * 1.6]);
    }), 12);
  }
  // round the nests: bundles following each outline 4–12 units out (a looser outer ring round the big ones)
  {
    const RB = rng(seed + 7);
    let made = 0;
    for (let pass = 0; pass < 3; pass++) {
      tumourPolys.forEach((O, oi) => {
        if (pass === 2 && oi > 1) return;
        const per = pathLen([...O, O[0]]);
        const nb = Math.max(1, Math.round(per / 70));
        for (let j = 0; j < nb && made < 44; j++) {
          const d0 = pass === 0 ? 4 + RB() * 3 : pass === 1 ? 8 + RB() * 4 : 14 + RB() * 5;
          const ns = RB() < 0.45 ? 3 : 2, len = 30 + RB() * 25, i0 = Math.floor(RB() * O.length);
          const strands = [];
          const ph = RB() * 6;
          for (let s = 0; s < ns; s++) strands.push(waveLine(resample(walkClosed(offsetClosed(O, d0 + s * 3.2), i0, len), 1.5), 0.5, 15, ph));
          if (addBundle(strands, 16)) made++;
        }
      });
    }
  }

  // vessels: angiogenic in the tumour bed, normal capillaries in the host stroma
  const vs = vessels.map((v) => angioVessel(L, v));
  capAt.forEach(([x, y], k) => capillary(L, { cx: x, cy: y, rx: 6.8 - k * 0.5, ry: 5.8 - k * 0.5, rot: k ? 100 : 30, seed: seed + 73 + k }));

  // CAFs aligned with the collagen round the nests; slender fibroblasts beyond the front
  const spindles = [];
  const tams = [tmemTam, [134, 140], [204, 128], [150, 84], [96, 116], [214, 58], [288, 100]];
  for (const p of packWhere(box, 17, 21, (q) => inFrame(q, 8) && !occupied(q, 8) && !capOcc(q, 4) && !tams.some((t) => dist(q, t) < 16), { seed: seed + 2, tries: 1500 })) {
    const bed = inBed(p), c = nearestCentre(p);
    const a = bed ? (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI + 90 + (R() - 0.5) * 25 : R() * 180;
    const ux = Math.cos(rad(a)) * 15, uy = Math.sin(rad(a)) * 15;
    const e0 = [p[0] - ux, p[1] - uy], e1 = [p[0] + ux, p[1] + uy];
    if (!inFrame(e0, 3) || !inFrame(e1, 3) || occupied(e0, 2) || occupied(e1, 2)) continue;
    stromalCell(L, p, a, R, bed);
    spindles.push([e0, e1]);
  }
  // everything placed so far that later cells must keep clear of: [x, y, r]
  const placed = [...tams.map(([x, y]) => [x, y, 9]), ...vs.flatMap((v) => v.leaked.map(([x, y]) => [x, y, 3]))];
  const clear = (q, r) => !placed.some(([x, y, pr]) => dist(q, [x, y]) < pr + r + 0.8) && !spindles.some(([a, b]) => segDist(q, a, b) < r + 3);
  // TAMs: perivascular (with the intravasating cell, a TMEM doorway), round nests and necrosis
  tams.forEach((p, k) => tamCell(L, p, seed + 80 + k, 0.95));

  // the invasive margin: an irregular band of lymphocytes along the tumour–host interface, densest right
  // against the tumour and thinning out into the host stroma (mostly CD8, some CD4 and B cells)
  const edgeT = [small[0], gOut[1], solidCord], edgeB = [buds[2], buds[3]];
  const dTum = (q) => Math.min(...edgeT.map((pg) => (inside(pg, q) ? 0 : polyDist(q, pg))), ...edgeB.map(([x, y, r]) => Math.max(0, dist(q, [x, y]) - r)));
  const RW = rng(seed + 9);
  const lym = [];
  const okCell = (q, r) => inFrame(q, 5) && !occupied(q, r + 0.5) && !capOcc(q, r + 1) && clear(q, r) && lym.every(([x, y, r2]) => dist(q, [x, y]) > r + r2 + 0.5);
  // [centre, radius, cells]: round the small nest, the right gland's corner, the bud and the lower gland
  for (const [c, rc, n] of [[[249, 30], 13, 8], [[261, 100], 15, 10], [[265, 162], 12, 8], [[253, 200], 12, 7]]) {
    for (let t = 0, got = 0; t < 6000 && got < n; t++) {
      // tried nearest the core first, so each core fills in densely before it spreads
      const a = RW() * Math.PI * 2, d = rc * Math.sqrt(RW()) * Math.min(1, 0.45 + t / 2500);
      const q = [c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d], r = 3.45 * (0.88 + RW() * 0.24);
      if (!okCell(q, r)) continue;
      lym.push([q[0], q[1], r]);
      got++;
    }
  }
  for (let t = 0, got = 0; t < 4000 && got < 6; t++) {
    const q = [box.x + RW() * box.w, box.y + RW() * box.h], sf = sFront(q), r = 3.3 * (0.9 + RW() * 0.2);
    if (sf < 10 || sf > 30 || !okCell(q, r) || lym.some(([x, y]) => dist(q, [x, y]) < 18)) continue;
    lym.push([q[0], q[1], r]);
    got++;
  }
  for (const [x, y, r] of lym) {
    const u = RW(), [b, nu] = u < 0.7 ? ["cd8", "cd8Nuc"] : u < 0.9 ? ["tcell", "tnuc"] : ["bcell", "bnuc"];
    roundCell(L, [x, y], r, b, nu, R, 0.62 + RW() * 0.12);
    placed.push([x, y, r]);
  }
  if (lym.length < 33) console.warn("  ! invasive margin: only", lym.length, "lymphocytes placed");
  // Tregs, more CD8 cells and neutrophils scattered through the tumour bed
  const strew = (n, r, s, pred = () => true) => {
    const pts = packWhere(box, n, 30, (q) => inFrame(q, 6) && sFront(q) < -16 && !occupied(q, r + 1) && clear(q, r) && pred(q), { seed: s });
    pts.forEach(([x, y]) => placed.push([x, y, r]));
    return pts;
  };
  for (const p of strew(6, 3.7, seed + 4)) roundCell(L, p, 3.7, "treg", "tregNuc", R);
  for (const p of strew(5, 3.6, seed + 5)) roundCell(L, p, 3.6, "cd8", "cd8Nuc", R);
  for (const p of strew(3, 5.4, seed + 6, (q) => dist(q, NC) < 60)) neutro(L, p, R);

  // tumour: breached in-situ duct, a solid nest with central necrosis, infiltrating glands, small nests and buds;
  // intra-epithelial CD8 T cells sit in slots between the tumour cells
  const tilsN = [[146, 150], [190, 168], [178, 140]], tilD = [72, 50];
  const necR = wobblyR(11, 0.08, seed + 43);
  cisDuct(L, D, seed + 20, { pattern: "cribriform", breach: BR, tils: [tilD] });
  atypicalCells(L, nestN, { seed: seed + 41, holes: [[168, 160, 11, "necrosis", necR], ...tilsN.map(([x, y]) => [x, y, 4.2, "til"])], mitoses: 2 });
  const tilG = glands.map((g, i) => invasiveGland(L, gOut[i], seed + 50 + i, { dirty: g.dirty, tilAt: g.tilAt, round: g.round })).filter(Boolean);
  atypicalCells(L, solidCord, { seed: seed + 56, spacing: 9.6, nucR: 4.2, mitoses: 1 });
  small.forEach((s, i) => atypicalCells(L, s, { seed: seed + 63 + i, spacing: 9.8, nucR: 4.1, mitoses: i === 1 ? 1 : 0 }));
  for (const [x, y, r, e, a] of buds) {
    const o = ovalPts(x, y, r * e, (r * 0.85) / Math.sqrt(e), { rot: a ?? 0, wobble: e > 1 ? 0.08 : 0.15, seed: Math.round(x + y), n: 28 });
    L.add("tum", smoothClosed(o.filter((_, i) => i % 2 === 0), 0.9));
    const fit = fitInside(pleoPts(x, y, r * 0.55, R, e > 1 ? 1 + (e - 1) * 0.8 : 1, a ?? null), [x, y], o, { margin: 0.6, minK: 0.3 });
    if (fit) L.add("tumNuc", smoothClosed(fit));
  }
  necroticFocus(L, [168, 160], 11, seed + 42, { neutrophils: 3, rFn: necR });
  for (const p of [...tilsN, tilD]) roundCell(L, p, 3.7, "cd8b", "cd8bNuc", R);
  for (const p of tilG) roundCell(L, p, 3.2, "cd8b", "cd8bNuc", R);

  // intravasation: a tumour cell squeezing through a gap in the wall of the angiogenic vessel — the larger
  // half still in the stroma (irregular trailing edge), a small bleb already in the lumen, an hourglass
  // nucleus pinched at the wall; the endothelial ends part round its waist. One cell already in the lumen.
  {
    const I = intra;
    const W2 = (lx, ly) => [I.gp[0] + I.n[0] * lx + I.t[0] * ly, I.gp[1] + I.n[1] * lx + I.t[1] * ly];
    const deg = (Math.atan2(I.n[1], I.n[0]) * 180) / Math.PI;
    const uni = L.map.get("intra").unite, nuni = L.map.get("intraNuc").unite;
    const oc = W2(6.6, 0), bc = W2(-3.3, 0);
    uni.push(smoothClosed(starPts(oc[0], oc[1], 6.2, 5.6, [[14, 1.3, 24], [-46, 1.6, 15], [64, 0.9, 17]], { rot: deg, wobble: 0.07, seed: 11, n: 60 }), 0.9));
    uni.push(circle(bc[0], bc[1], 3.5), capsule(...W2(-1.8, 0), ...W2(2.4, 0), 1.25));
    const n1 = W2(4.3, 0), n2 = W2(-2.6, 0);
    nuni.push(ellipse(n1[0], n1[1], 2.9, 2.5, deg), circle(n2[0], n2[1], 1.65), capsule(...W2(-1.6, 0), ...W2(2, 0), 0.6));
    // the two parted endothelial cells, their nuclei bulging at the ends of the gap
    for (const s of [-1, 1]) {
      const e = W2(-0.2, s * 4.1);
      L.add("angioEndo", ellipse(e[0], e[1], 2, 1.15, deg + 90));
    }
  }
  L.add("tumTop", circle(vessels[0].cx - 12, vessels[0].cy + 2, 4.4));
  L.add("tumTopNuc", pleoNuc(vessels[0].cx - 12, vessels[0].cy + 2, 2.4, R));
  return { size: [W, H], lineWidth: 1.2, parts: L.parts() };
}

/* ===================== schematic (object-style) helpers ===================== */

/**
 * Collects shapes per part. Several shapes in one part are drawn one by one with full shading
 * (a `d` array) — or joined into one compound path when the part is defined with `join: true`
 * (fibres, granules) — or merged into one shape when it has `unite: []`.
 */
class Objs {
  constructor() {
    this.keys = [];
    this.map = new Map();
  }
  def(key, style) {
    if (!this.map.has(key)) {
      this.keys.push(key);
      this.map.set(key, { ...style, ds: [] });
    }
    return this;
  }
  add(key, d) {
    const p = this.map.get(key), list = [].concat(d).filter(Boolean);
    (p.unite || p.ds).push(...list);
  }
  parts() {
    return this.keys
      .map((k) => {
        const { ds, join, ...st } = this.map.get(k);
        if (st.unite) return st.unite.length ? st : null;
        if (!ds.length) return null;
        return { ...st, d: join ? ds.join("") : ds.length === 1 ? ds[0] : ds };
      })
      .filter(Boolean);
  }
}

const rad = (deg) => (deg * Math.PI) / 180;
const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};
const xform = (pts, cx, cy, rot) => {
  const c = Math.cos(rad(rot)), s = Math.sin(rad(rot));
  return pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
};
const move = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);

/**
 * Outline of an ellipse with tapering processes (pseudopods, dendrites, the poles of a spindle
 * cell): bumps [[angleDeg, length, halfWidthDeg]] in the cell's own frame; `bend` curves the long axis.
 */
function starPts(cx, cy, rx, ry, bumps, { rot = 0, n = 144, wobble = 0, seed = 1, bend = 0 } = {}) {
  const R = rng(seed);
  const wv = [R() * 6, R() * 6];
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    let r = 1 / Math.sqrt((Math.cos(a) / rx) ** 2 + (Math.sin(a) / ry) ** 2);
    r *= 1 + wobble * (Math.sin(a * 3 + wv[0]) * 0.6 + Math.sin(a * 5 + wv[1]) * 0.4);
    for (const [deg, len, w] of bumps) {
      const d = angDiff(a, rad(deg)) / rad(w);
      r += len * Math.exp(-d * d);
    }
    const x = Math.cos(a) * r;
    return [x, Math.sin(a) * r + (bend * x * x) / 1000];
  });
  return xform(pts, cx, cy, rot);
}

/** Kidney/bean outline (macrophage and monocyte nuclei): an ellipse dented on its +y side. */
function beanPts(cx, cy, rx, ry, rot = 0, dent = 0.55, n = 20) {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, s = Math.sin(a);
    return [Math.cos(a) * rx, s * ry - (s > 0 ? dent * 2 * ry * s ** 4 : 0)];
  });
  return xform(pts, cx, cy, rot);
}

/** A band along an open polyline whose width runs from w0 to w1 (sprouts, filopodia, cell processes). */
function taperBand(pts, w0, w1) {
  const n = pts.length, L = [], Rr = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const w = (w0 + (w1 - w0) * (i / (n - 1))) / 2;
    L.push([pts[i][0] - (dy / l) * w, pts[i][1] + (dx / l) * w]);
    Rr.push([pts[i][0] + (dy / l) * w, pts[i][1] - (dx / l) * w]);
  }
  return [...L, ...Rr.reverse()];
}

/**
 * Soft look for cells with long thin processes (the renderer's crescents scale with the bounding
 * box, too thick for a spindle cell): a shadow copy offset to the bottom right under a flat body,
 * then a light band and gloss dots (soft style only). Parts: key+"Sh", key, key+"Band", key+"Gloss".
 */
function defSoftCell(O, key, fill, { lineWidth = 1 } = {}) {
  O.def(key + "Sh", { fill: shade(fill, 0.11), line: false })
    .def(key, { fill, lineWidth })
    .def(key + "Band", { fill: tint(fill, 0.13), opacity: 0.85, line: false })
    .def(key + "Gloss", { fill: "#ffffff", opacity: 0.8, line: false, join: true });
}
function softCell(O, key, pts, { off = 1.3, band = null, bandW = 3, gloss = null } = {}) {
  O.add(key + "Sh", smoothClosed(move(pts, off, off), 0.85));
  O.add(key, smoothClosed(pts, 0.85));
  if (band) O.add(key + "Band", ribbon(band, bandW, { taper: 1 }));
  if (gloss) {
    const [x, y, s] = gloss;
    O.add(key + "Gloss", [ellipse(x, y, s, s * 0.62, 38), circle(x + s * 1.5, y - s * 0.75, s * 0.42)]);
  }
}
/** Points along an elliptical arc (for light bands). */
const arcPts = (cx, cy, rx, ry, a0, a1, rot = 0, n = 12) =>
  xform(Array.from({ length: n }, (_, i) => {
    const a = rad(a0 + ((a1 - a0) * i) / (n - 1));
    return [Math.cos(a) * rx, Math.sin(a) * ry];
  }), cx, cy, rot);

/** Lymphocyte-like round cell: body, big round nucleus, optional cytotoxic granules polarised toward `toward` (deg). */
function lympho(O, key, [x, y], r, seed, { nk = 0.7, gran = 0, toward = 0 } = {}) {
  const R = rng(seed);
  O.add(key, blob(x, y, r, r * 0.95, { n: 9, wobble: 0.04, seed, rot: R() * 180 }));
  const nx = x - Math.cos(rad(toward)) * r * 0.1 + r * 0.04, ny = y - Math.sin(rad(toward)) * r * 0.1 + r * 0.04;
  O.add(key + "Nuc", blob(nx, ny, r * nk, r * nk * 0.94, { n: 8, wobble: 0.06, seed: seed + 1, rot: R() * 180 }));
  if (gran) {
    const g = [];
    for (let k = 0; k < gran; k++) {
      const a = rad(toward) + (k / Math.max(1, gran - 1) - 0.5) * 2.1 + (R() - 0.5) * 0.25;
      const rr = r * (0.45 + R() * 0.2);
      g.push(circle(x + Math.cos(a) * rr, y + Math.sin(a) * rr, r * 0.1));
    }
    O.add(key + "Gran", g);
  }
}

/** Short receptor sticks round a round cell (tipR > 0: ball tips at their ends instead). */
function spikes([x, y], r, n, len, seed, tipR = 0) {
  const R = rng(seed);
  return Array.from({ length: n }, (_, k) => {
    const a = ((k + 0.5 + (R() - 0.5) * 0.3) / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    if (tipR) return circle(x + c * (r + len + tipR * 0.6), y + s * (r + len + tipR * 0.6), tipR);
    return lineD([[x + c * (r - 0.8), y + s * (r - 0.8)], [x + c * (r + len), y + s * (r + len)]]);
  });
}

/** Macrophage: ruffled body with short pseudopods, eccentric kidney-shaped nucleus, a few vacuoles. */
function macro(O, key, [x, y], r, seed, { rot = 0, sx = 1.15, arms = 6, vac = 2 } = {}) {
  const R = rng(seed);
  const bumps = Array.from({ length: arms }, (_, k) => [(k * 360) / arms + (R() - 0.5) * 34, r * (0.22 + R() * 0.3), 13 + R() * 8]);
  O.add(key, smoothClosed(starPts(x, y, r * sx, r / sx, bumps, { rot, wobble: 0.05, seed }), 0.9));
  const nx = x - Math.cos(rad(rot)) * r * 0.22, ny = y - Math.sin(rad(rot)) * r * 0.22 + r * 0.06;
  O.add(key + "Nuc", smoothClosed(beanPts(nx, ny, r * 0.5, r * 0.36, rot + 90 + (R() - 0.5) * 40, 0.45)));
  const v = [];
  for (let k = 0; k < vac; k++) {
    const a = rad(rot) + (k - (vac - 1) / 2) * 0.9;
    v.push(circle(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.5, r * (0.13 + R() * 0.05)));
  }
  if (vac) O.add(key + "Vac", v);
}

/* ===================== tumour microenvironment overview ===================== */

const TME = {
  niche: "#fcefea", ecm: "#eebaba",
  tum: "#ddb9e6", tumNuc: "#4a2a7b", chrom: "#3d2668",
  caf: "#ee8fb7", cafNuc: "#7a4ea3",
  // M1 vs M2 contrast: M2-like TAMs in the library's M2 sage, the M1 salmon like the library M1
  tamM2: "#b8dcc4", m2Nuc: "#7d76b8", m2Vac: "#e1f2e7", tamM1: "#ee8f8c", macNuc: "#8f61a8", macVac: "#fde3dc",
  cd8: "#bfe5cf", cd8Nuc: "#4f6fb5", gran: "#cc3d4c",
  cd4: "#a9d6ee", cd4Nuc: "#7068c0",
  treg: "#f6d9ab", tregNuc: "#9c6fb5", tregRec: "#b9772a",
  bcell: "#cde8a3", bNuc: "#7c6bc0",
  nk: "#f8eaa6", nkNuc: "#8a72bf", nkRec: "#b0892a",
  dc: "#bfe4da", dcNuc: "#5f86c2",
  mdsc: "#d5d7ea", mdscNuc: "#6f5aa8",
  wall: "#f29aa1", lumen: "#fde4e2", rbc: "#e04b4f", endoNuc: "#a974b9",
  peri: "#93bfd0", periNuc: "#4f6fa5",
};

function tmeOverview(seed = 501) {
  const R = rng(seed);
  const W2 = 320, H2 = 260;
  const O = new Objs();
  // the niche: a convex squircle (vessel ends are clipped to it), clockwise on screen
  const bg = Array.from({ length: 160 }, (_, i) => {
    const a = (i / 160) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), e = 2 / 2.8;
    return [160 + 152 * Math.sign(c) * Math.abs(c) ** e, 130 + 122 * Math.sign(s) * Math.abs(s) ** e];
  });
  O.def("niche", { fill: TME.niche, stroke: sw(shade(TME.niche, 0.06), 1), lineWidth: 1.2 })
    .def("ecm", { fill: "none", stroke: { color: TME.ecm, width: 2.3, cap: "round" }, lineColor: "#dca5a8", lineStrokeWidth: 1.1, join: true })
    .def("wallSh", { fill: shade(TME.wall, 0.11), line: false, unite: [] })
    .def("wall", { fill: TME.wall, lineWidth: 1.1, unite: [] })
    .def("wallBand", { fill: tint(TME.wall, 0.13), opacity: 0.85, line: false })
    .def("lumen", { fill: TME.lumen, lineWidth: 0.8 })
    .def("endoNuc", { fill: TME.endoNuc, join: true, lineWidth: 0.6 })
    .def("rbc", { fill: TME.rbc, shade: "small", gloss: false, lineWidth: 0.8 })
    .def("peri", { fill: TME.peri, shade: "rim", lineWidth: 0.9 })
    .def("periNuc", { fill: TME.periNuc, lineWidth: 0.6 });
  defSoftCell(O, "caf", TME.caf);
  O.def("cafNuc", { fill: TME.cafNuc, shade: "small", gloss: false, lineWidth: 0.7 })
    .def("tum", { fill: TME.tum, shade: "body", glossAt: [0.36, 0.34], lineWidth: 1 })
    .def("tumNuc", { fill: TME.tumNuc, shade: "organelle", lineWidth: 0.8 })
    .def("tumMit", { fill: "#f0e2f4", shade: "body", glossAt: [0.36, 0.34], lineWidth: 1 })
    .def("spindle", { fill: "none", stroke: { color: "#a58bd0", width: 0.55, cap: "round" }, opacity: 0.6, lineColor: "#a58bd0", lineStrokeWidth: 0.4, join: true })
    .def("pole", { fill: "#8f72c2", shade: "small", gloss: false, lineWidth: 0.5, join: true })
    .def("chrom", { fill: TME.chrom, lineWidth: 0.5, unite: [] });
  // surface receptors (as on the library Treg and NK icons): sticks for Tregs, ball-tipped for NK cells
  O.def("tregRec", { fill: "none", stroke: { color: TME.tregRec, width: 1.3, cap: "round" }, lineColor: shade(TME.tregRec, 0.12), lineStrokeWidth: 1, join: true })
    .def("nkRec", { fill: "none", stroke: { color: TME.nkRec, width: 1.2, cap: "round" }, lineColor: shade(TME.nkRec, 0.12), lineStrokeWidth: 0.9, join: true })
    .def("nkTip", { fill: TME.nkRec, shade: "small", gloss: false, lineWidth: 0.5, join: true });
  const cellDefs = [
    ["tamM2", TME.tamM2, TME.m2Nuc], ["tamM1", TME.tamM1, TME.macNuc], ["cd8", TME.cd8, TME.cd8Nuc], ["cd4", TME.cd4, TME.cd4Nuc],
    ["treg", TME.treg, TME.tregNuc], ["bcell", TME.bcell, TME.bNuc], ["nk", TME.nk, TME.nkNuc], ["mdsc", TME.mdsc, TME.mdscNuc],
  ];
  for (const [k, body, nuc] of cellDefs) {
    O.def(k, { fill: body, shade: "body", lineWidth: 1, ...(k.startsWith("tam") ? { glossAt: [0.36, 0.33] } : {}) }).def(k + "Nuc", { fill: nuc, shade: "organelle", lineWidth: 0.8, ...(k === "mdsc" ? { gloss: false, highlight: false } : k.startsWith("tam") ? { gloss: false } : {}) });
    if (k.startsWith("tam")) O.def(k + "Vac", { fill: k === "tamM2" ? TME.m2Vac : TME.macVac, shade: "small", gloss: false, lineWidth: 0.5 });
    if (k === "cd8" || k === "nk") O.def(k + "Gran", { fill: TME.gran, shade: "small", gloss: false, lineWidth: 0.4 });
    if (k === "mdsc") O.def("mdscGran", { fill: "#b8a5d8", gloss: false, highlight: false, lineWidth: 0.3 });
  }
  // the dendritic cell is one shape merged from its body, dendrites and veil (soft look as defSoftCell)
  O.def("dcSh", { fill: shade(TME.dc, 0.11), line: false, unite: [] })
    .def("dc", { fill: TME.dc, lineWidth: 1, unite: [] })
    .def("dcBand", { fill: tint(TME.dc, 0.13), opacity: 0.85, line: false })
    .def("dcGloss", { fill: "#ffffff", opacity: 0.8, line: false, join: true })
    .def("dcNuc", { fill: TME.dcNuc, shade: "organelle", lineWidth: 0.8 })
    .def("hevCell", { fill: "#f5bccb", shade: "small", gloss: false, lineWidth: 0.6 })
    .def("hevNuc", { fill: TME.endoNuc, lineWidth: 0.4, join: true });

  O.add("niche", smoothClosed(bg, 1));

  // tumour mass: crowded, irregular malignant cells with large dark pleomorphic nuclei
  const MC = [184, 116];
  const mass = ovalPts(MC[0], MC[1], 66, 54, { wobble: 0.07, seed: seed + 1, n: 90 });
  const seeds = packWhere(bbox(mass), 19, 21, (q) => inside(mass, q) && polyDist(q, mass) > 7, { seed: seed + 2, tries: 2000 });
  const cells = voronoi(seeds, mass, 80);

  const inNiche = (p, m) => inside(bg, p) && polyDist(p, bg) > m;

  // blood vessel crossing the lower-left corner, with an angiogenic sprout (tip cell) heading for the tumour
  const cl = catmull([[-14, 92], [22, 128], [46, 174], [84, 212], [138, 238], [196, 268]], 12);
  const band = (w) => clipConvex([...offsetPts(cl, w), ...offsetPts(cl, -w).reverse()], bg);
  const wallD = polyD(band(11));
  const ib = cl.reduce((b, p, i) => (dist(p, [64, 196]) < dist(cl[b], [64, 196]) ? i : b), 0);
  const base = cl[ib], dir = [MC[0] - 40 - base[0], MC[1] + 20 - base[1]], dl = Math.hypot(...dir);
  const ux = dir[0] / dl, uy = dir[1] / dl;
  const sproutLine = Array.from({ length: 9 }, (_, i) => {
    const t = i / 8, s = 4 + t * 38, w = Math.sin(t * Math.PI) * 3;
    return [base[0] + ux * s - uy * w, base[1] + uy * s + ux * w];
  });
  const tip = sproutLine[8];
  const sprout = [polyD(taperBand(sproutLine, 10, 3.2))];
  for (const da of [-38, 0, 34]) {
    const a = Math.atan2(uy, ux) + rad(da), l = da ? 7 : 9;
    sprout.push(polyD(taperBand([tip, [tip[0] + Math.cos(a) * l * 0.5, tip[1] + Math.sin(a) * l * 0.5], [tip[0] + Math.cos(a) * l, tip[1] + Math.sin(a) * l]], 1.6, 0.5)));
  }
  O.add("wall", [wallD, ...sprout]);
  O.add("wallSh", [polyD(clipConvex(move(band(11), 1.4, 1.4), bg)), polyD(move(taperBand(sproutLine, 10, 3.2), 1.4, 1.4))]);
  O.add("wallBand", ribbon(offsetPts(cl.slice(18, 50), -8.6), 2.4, { taper: 1 }));
  O.add("lumen", polyD(band(6.8)));
  // endothelial nuclei along both walls, the tip-cell nucleus in the sprout
  const en = [];
  for (let i = 6; i < cl.length - 4; i += 9) {
    const side = (i / 9) % 2 ? 8.9 : -8.9;
    const p = offsetPts(cl, side)[i], q = cl[Math.min(cl.length - 1, i + 1)], pp = cl[i];
    if (inNiche(p, 4)) en.push(ellipse(p[0], p[1], 3.4, 1.15, (Math.atan2(q[1] - pp[1], q[0] - pp[0]) * 180) / Math.PI));
  }
  const sm = sproutLine[4];
  en.push(ellipse(sm[0], sm[1], 3.4, 1.6, (Math.atan2(uy, ux) * 180) / Math.PI));
  O.add("endoNuc", en);
  // red cells in the lumen
  for (let i = 8; i < cl.length - 4; i += 11) {
    const p = cl[i];
    if (inNiche(p, 6)) O.add("rbc", ellipse(p[0] + (R() - 0.5) * 3, p[1] + (R() - 0.5) * 3, 4.3, 3, R() * 180));
  }
  // pericytes hugging the outer wall
  // (the outer one sits well inside the niche's rounded corner, not across its edge)
  for (const [i0, side] of [[15, -1], [27, 1]]) {
    const seg = offsetPts(cl, side * 12.6).slice(i0, i0 + 9);
    O.add("peri", ribbon(seg, 4.6, { taper: 0.95 }));
    const m = seg[4], q = seg[5];
    O.add("periNuc", ellipse(m[0], m[1], 3.4, 1.7, (Math.atan2(q[1] - m[1], q[0] - m[0]) * 180) / Math.PI));
  }

  // ECM: long smooth collagen bundles (2–3 parallel strands) arcing round the tumour mass 6–20 units out,
  // and a few loose single fibres in the outer niche — all kept clear of the cells
  {
    const RE = rng(seed + 3);
    const keepOut = [[60, 58, 44], [102, 98, 21], [152, 206, 21], [242, 38, 20], [254, 142, 12], [197, 180, 12], [296, 178, 11], [272, 70, 11],
      [120, 186, 11], [200, 30, 13], [98, 126, 10], [293, 83, 10], [150, 32, 22]];
    const cafSegs = [[286, 118, 96, 1.05], [240, 213, -16, 1.05], [64, 124, 80, 0.9]].map(([x, y, r, k]) => [[x - Math.cos(rad(r)) * 29 * k, y - Math.sin(rad(r)) * 29 * k], [x + Math.cos(rad(r)) * 29 * k, y + Math.sin(rad(r)) * 29 * k]]);
    const vZone = band(16);
    const ok = (p) => inNiche(p, 8) && !near(p, mass, 4) && !inside(vZone, p) && lineDist(p, sproutLine) > 9 &&
      !keepOut.some(([x, y, r]) => dist(p, [x, y]) < r + 3) && !cafSegs.some(([a, b]) => segDist(p, a, b) < 8);
    const runs = (pts, minLen) => {
      const out = [];
      let cur = [];
      for (const p of [...pts, null]) {
        if (p && ok(p)) cur.push(p);
        else {
          if (cur.length > 1 && pathLen(cur) >= minLen) out.push(cur);
          cur = [];
        }
      }
      return out;
    };
    let made = 0;
    for (const [d0, n, ph] of [[7, 7, 0.1], [16, 7, 0.55]]) {
      for (let k = 0; k < n && made < 12; k++) {
        const i0 = Math.round(((k + ph + RE() * 0.3) / n) * mass.length) % mass.length;
        const len = 45 + RE() * 35, ns = RE() < 0.4 ? 3 : 2, wph = RE() * 6;
        const got = [];
        for (let s2 = 0; s2 < ns; s2++) got.push(...runs(waveLine(resample(walkClosed(offsetClosed(mass, d0 + s2 * 3.4), i0, len), 1.6), 0.6, 24, wph), 22));
        if (got.length) {
          O.add("ecm", got.map((r) => smoothOpen(r)));
          made++;
        }
      }
    }
    let loose = 0;
    for (const p of packWhere({ x: 14, y: 14, w: W2 - 28, h: H2 - 28 }, 30, 30, (q) => ok(q) && polyDist(q, mass) > 30, { seed: seed + 4 })) {
      if (loose >= 4) break;
      const a = RE() * Math.PI, l = 17;
      const line = Array.from({ length: 22 }, (_, i) => [p[0] + Math.cos(a) * (i / 21 - 0.5) * 2 * l, p[1] + Math.sin(a) * (i / 21 - 0.5) * 2 * l]);
      const pts = waveLine(line, 1.6, 22, RE() * 6);
      if (pts.every(ok)) O.add("ecm", smoothOpen(pts)), loose++;
    }
  }

  // CAFs lying along the ECM round the tumour, three different shapes: a long bipolar spindle with one
  // forked end, a cell with three processes at uneven angles, and one curving along the ECM arc with
  // two short side processes on the same side. The light band and gloss stay on the screen's upper
  // left whatever the cell's angle.
  const caf = ([x, y], rot, s, bumps, bend = 0) => {
    const pts = starPts(x, y, 10 * s, 5.2 * s, bumps.map(([d, l, w]) => [d, l * s, w]), { rot, seed: Math.round(x + y), bend });
    const th = 225 - rot; // the screen's upper left in the cell's own frame
    const lx = Math.cos(rad(th)) * 5 * s, ly = Math.sin(rad(th)) * 2.4 * s;
    const g = [x + Math.cos(rad(rot)) * lx - Math.sin(rad(rot)) * ly, y + Math.sin(rad(rot)) * lx + Math.cos(rad(rot)) * ly];
    softCell(O, "caf", pts, { off: 1.1, band: arcPts(x, y, 7 * s, 3.3 * s, th - 42, th + 42, rot, 8), bandW: 1.5, gloss: [g[0], g[1], 1.3] });
    O.add("cafNuc", ellipse(x + Math.cos(rad(rot)) * 1, y + Math.sin(rad(rot)) * 1, 5.4 * s, 2.5 * s, rot));
  };
  caf([286, 118], 96, 1.05, [[0, 20, 6], [171, 13, 5], [198, 12, 5]]);
  caf([240, 213], -16, 1.05, [[8, 18, 7], [131, 9, 8], [232, 6, 9]]);
  caf([64, 124], 80, 0.9, [[0, 15, 7], [180, 14, 7], [-60, 5, 9], [-114, 4.5, 9]], 9);

  // tumour cells (one in mitosis)
  cells.forEach((poly, i) => {
    if (poly.length < 3) return;
    const c = centroid(poly);
    const k = Math.max(0.6, 1 - 1.5 / Math.sqrt(area(poly) / Math.PI));
    if (i === 7) {
      metaphaseCell(O, c, Math.sqrt(area(poly) / Math.PI) * k * 1.1, rad(70), R);
      return;
    }
    O.add("tum", roundPoly(poly.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]), 5));
    const r = Math.sqrt(area(poly) / Math.PI) * 0.46;
    O.add("tumNuc", blob(c[0] + (R() - 0.5) * 2, c[1] + (R() - 0.5) * 2, r * (1 + R() * 0.2), r * (0.82 + R() * 0.15), { n: 8, wobble: 0.14, seed: seed + 40 + i, rot: R() * 180 }));
  });

  // the TLS: a loose cluster of B cells of varied size (no ring or radial order), a looser cap of CD4
  // T cells on the tumour-facing side at uneven spacing, and a high endothelial venule at its edge
  {
    const TL = [58, 60], RB = rng(seed + 59), H = [90, 30];
    const bs = [];
    // densely packed from the centre outward (candidates nearest the centre first), so the follicle is compact
    const cand = Array.from({ length: 900 }, () => {
      const a = RB() * Math.PI * 2, d = Math.sqrt(RB()) * 27;
      return [[TL[0] + Math.cos(a) * d * 1.08, TL[1] + Math.sin(a) * d * 0.92], 7 + RB() * 1.6];
    }).sort((u, v) => dist(u[0], TL) - dist(v[0], TL));
    for (const [q, r] of cand) {
      if (bs.length >= 12) break;
      if (dist(q, H) > r + 12.5 && bs.every(([q2, r2]) => dist(q, q2) > (r + r2) * 0.9)) bs.push([q, r]);
    }
    bs.forEach(([q, r], k) => lympho(O, "bcell", q, r, seed + 61 + k));
    [[-18, 34], [3, 41], [21, 33], [48, 39.5], [67, 32.5], [92, 38]].forEach(([a, d], k) => {
      const aa = rad(a + (RB() - 0.5) * 6);
      lympho(O, "cd4", [TL[0] + Math.cos(aa) * d, TL[1] + Math.sin(aa) * d], 7.8 + RB(), seed + 70 + k);
    });
    // HEV: 7 plump cuboidal endothelial cells round a lumen holding one lymphocyte
    O.add("lumen", circle(H[0], H[1], 4.7));
    lympho(O, "cd4", H, 3.3, seed + 78, { nk: 0.74 });
    // unequal, plump cells (no even ring): spans, heights and nucleus positions vary
    const n = 7, a0 = RB() * 360, wts = Array.from({ length: n }, () => 0.7 + RB() * 0.6), tot = wts.reduce((a, b) => a + b, 0);
    const cum = wts.map((w, k) => (wts.slice(0, k).reduce((a, b) => a + b, 0) / tot) * 360);
    const arc = (rr, from, to) => Array.from({ length: 7 }, (_, i) => {
      const a = rad(from + ((to - from) * i) / 6);
      return [H[0] + Math.cos(a) * rr, H[1] + Math.sin(a) * rr];
    });
    for (let k = 0; k < n; k++) {
      const a1 = a0 + cum[k] + 3, a2 = a0 + (k + 1 < n ? cum[k + 1] : 360) - 3, am = rad((a1 + a2) / 2 + (RB() - 0.5) * 8);
      const ro = 8.7 + RB() * 1.5, rn = 6.6 + RB() * 1.1;
      O.add("hevCell", roundPoly([...arc(ro, a1, a2), ...arc(4.9 + RB() * 0.5, a2, a1)], 1.4));
      O.add("hevNuc", ellipse(H[0] + Math.cos(am) * rn, H[1] + Math.sin(am) * rn, 1.6 + RB() * 0.3, 1.2, (am * 180) / Math.PI + 90));
    }
  }

  // immune and myeloid cells round the tumour
  macro(O, "tamM2", [99, 100], 12.6, seed + 80, { rot: 20 });
  macro(O, "tamM2", [152, 206], 13.5, seed + 81, { rot: -30 });
  macro(O, "tamM1", [242, 38], 12.5, seed + 82, { rot: 10, sx: 1.1 });
  lympho(O, "cd8", [254, 142], 9, seed + 90, { gran: 5, toward: 190, nk: 0.64 });
  lympho(O, "cd8", [197, 180], 9, seed + 91, { gran: 5, toward: -95, nk: 0.64 });
  lympho(O, "cd8", [204, 98], 8.6, seed + 92, { gran: 4, toward: 160, nk: 0.64 });
  lympho(O, "cd4", [296, 178], 8.6, seed + 93);
  for (const [p, r, sd] of [[[272, 70], 8.8, seed + 94], [[120, 186], 8.6, seed + 95]]) {
    lympho(O, "treg", p, r, sd);
    O.add("tregRec", spikes(p, r, 10, 3.4, sd));
  }
  lympho(O, "nk", [200, 30], 10, seed + 96, { gran: 7, toward: 90, nk: 0.6 });
  O.add("nkRec", spikes([200, 30], 10, 10, 3.2, seed + 97));
  O.add("nkTip", spikes([200, 30], 10, 10, 3.2, seed + 97, 1.05));
  // MDSCs, one of each subset: a monocytic MDSC (round, kidney nucleus, a few faint granules) and a
  // polymorphonuclear MDSC (smaller, 2–3 linked lobes like a small neutrophil)
  {
    const [x, y] = [98, 126];
    O.add("mdsc", blob(x, y, 7.5, 7.2, { n: 8, wobble: 0.05, seed: x + y }));
    O.add("mdscNuc", smoothClosed(beanPts(x + 1.1, y + 0.6, 4.6, 3.3, 118, 0.5, 18)));
    O.add("mdscGran", [[-4.6, -3.2, 0.75], [-2.2, -5.2, 0.6], [-5.6, 0.4, 0.65], [1.6, -5.4, 0.55], [-3.6, 3.8, 0.6], [3.9, 4.4, 0.5]].map(([dx, dy, r]) => circle(x + dx, y + dy, r)));
  }
  {
    const [x, y] = [293, 83];
    O.add("mdsc", blob(x, y, 6.6, 6.3, { n: 8, wobble: 0.05, seed: x + y }));
    O.add("mdscNuc", lobes(x + 0.3, y + 0.2, 3.5, 3, 205));
  }
  // dendritic cell: four long, gently wavy dendrites of unequal length (one branching) and a thin
  // ruffled veil on one side; the nucleus sits toward the veil-free side
  {
    const [x, y] = [150, 34];
    const dendrite = (a, len, w0, w1, from = [x, y], r0 = 5) => {
      const ux = Math.cos(rad(a)), uy = Math.sin(rad(a)), n = 14;
      const pts = Array.from({ length: n + 1 }, (_, i) => {
        const t = i / n, d = r0 + len * t, off = Math.sin(t * Math.PI * 2.2 + a * 0.05) * 1.1 * t;
        return [from[0] + ux * d - uy * off, from[1] + uy * d + ux * off];
      });
      return { pts, outline: taperBand(pts, w0, w1) };
    };
    const ds = [[-30, 23, 3.4, 0.8], [58, 12, 3, 0.8], [160, 19, 3.2, 0.8], [238, 10, 2.8, 0.8]].map(([a, len, w0, w1]) => dendrite(a, len, w0, w1));
    const branch = dendrite(8, 8, 1.9, 0.6, ds[0].pts[8], 0);
    const veil = blobPts(x + Math.cos(rad(110)) * 6, y + Math.sin(rad(110)) * 6, 8.6, 2.9, { n: 18, wobble: 0.2, seed: seed + 97, rot: 200 });
    const body = blobPts(x, y, 6.4, 6, { n: 10, wobble: 0.06, seed: seed + 96 });
    for (const sh of [body, veil, ...ds.map((d) => d.outline), branch.outline]) {
      O.add("dcSh", smoothClosed(move(sh, 1, 1), 0.85));
      O.add("dc", smoothClosed(sh, 0.85));
    }
    O.add("dcBand", ribbon(arcPts(x, y, 4.6, 4.2, 195, 285, 0, 8), 1.4, { taper: 1 }));
    O.add("dcGloss", [ellipse(x - 3, y - 3.3, 1.2, 0.74, 38), circle(x - 1.1, y - 4.3, 0.5)]);
    O.add("dcNuc", blob(x + Math.cos(rad(290)) * 1.5, y + Math.sin(rad(290)) * 1.5, 3.9, 3.4, { n: 8, wobble: 0.08, seed: seed + 99 }));
  }
  return { size: [W2, H2], lineWidth: 1.2, parts: O.parts() };
}

/* ===================== components ===================== */

/** Cancer-associated fibroblast: plump activated (myofibroblastic) spindle cell, α-SMA stress fibres, aligned collagen. */
function cafScene() {
  const O = new Objs();
  const fill = "#ee8fb7";
  O.def("collagen", { fill: "none", stroke: { color: "#eebaba", width: 5.5, cap: "round" }, lineColor: "#dca5a8", lineStrokeWidth: 1.3, join: true });
  defSoftCell(O, "caf", fill, { lineWidth: 1.6 });
  O.def("fibres", { fill: "none", stroke: { color: "#d4609a", width: 1.4, cap: "round" }, lineColor: "#a3376e", lineStrokeWidth: 0.9, opacity: 0.85, join: true })
    .def("nuc", { fill: "#7a4ea3", shade: "organelle", lineWidth: 1.2 })
    .def("nucleolus", { fill: "#55307f", shade: "small", gloss: false, lineWidth: 0.8 })
    .def("secr", { fill: "#f2b443", shade: "small", gloss: false, lineWidth: 0.8 });
  // drawn about (120, 86) at 1.25× — a plump activated cell, larger than the resting fibroblast icon
  const S = 1.25, cx = 140, cy = 95, rot = -7;
  const T = (x, y) => [cx + (x - 120) * S, cy + (y - 86) * S];
  // collagen bundles aligned with the cell (CAFs lay down and align the matrix)
  const R = rng(17);
  for (const [y0, x0, x1, ph] of [[28, 22, 214, 0.5], [46, 60, 226, 2.1], [128, 14, 186, 1.2], [146, 50, 222, 3.3], [36, 120, 200, 4.1], [140, 110, 160, 0.3]]) {
    const yy0 = y0 + (x0 - 120) * Math.tan(rad(rot)), yy1 = y0 + (x1 - 120) * Math.tan(rad(rot));
    const a = T(x0, yy0), b = T(x1, yy1);
    a[0] = Math.max(12, a[0]), b[0] = Math.min(268, b[0]);
    O.add("collagen", fibre(a[0], a[1], b[0], b[1], { amp: (2.4 + R()) * S, waves: (x1 - x0) / 46, phase: ph }));
  }
  const bumps = [[0, 66, 7.5], [-13, 40, 5.5], [180, 66, 7.5], [195, 26, 6], [-64, 17, 12], [-124, 20, 12], [62, 14, 12], [134, 12, 12]].map(([a, l, w]) => [a, l * S, w]);
  const pts = starPts(cx, cy, 36 * S, 18 * S, bumps, { rot, seed: 5, bend: 1.2 / S, n: 240 });
  // α-SMA stress fibres along the long axis (under the nucleus)
  const fibresD = [];
  for (const [off, ext] of [[-10, 26], [-5, 52], [0, 76], [5, 50], [10, 24]]) {
    const line = [];
    for (let i = 0; i <= 12; i++) {
      const x = -ext + (2 * ext * i) / 12;
      line.push([x * S, (off * (1 - (Math.abs(x) / (ext + 8)) ** 2) + (1.2 * x * x) / 1000) * S]);
    }
    fibresD.push(smoothOpen(xform(line, cx, cy, rot)));
  }
  softCell(O, "caf", pts, { off: 2.6, band: arcPts(cx - 4 * S, cy, 30 * S, 13 * S, 196, 292, rot, 12), bandW: 4.2, gloss: [112, 88, 4] });
  O.add("fibres", fibresD);
  O.add("nuc", smoothClosed(starPts(cx + 4 * S, cy + 1 * S, 23 * S, 10.5 * S, [], { rot: rot + 2, seed: 8, wobble: 0.03, n: 16 })));
  O.add("nucleolus", [circle(...T(118, 85), 2.6 * S), circle(...T(133, 88), 2.1 * S)]);
  // secretory vesicles (TGF-β, IL-6, CXCL12…) budding off the surface
  O.add("secr", [[150, 70, 2.6], [160, 76, 2.2], [84, 98, 2.4], [168, 58, 2.6], [178, 50, 2.3], [190, 60, 2], [70, 112, 2.4], [62, 124, 2]].map(([x, y, r]) => circle(...T(x, y), r * S)));
  return { size: [280, 190], lineWidth: 1.6, parts: O.parts() };
}

/** Tumour-associated macrophage: large ruffled cell, kidney nucleus, an engulfed apoptotic tumour cell, secreted factors. */
function tamScene() {
  const O = new Objs();
  O.def("body", { fill: "#f6c09d", shade: "body", glossAt: [0.31, 0.25], lineWidth: 1.6 })
    .def("lipid", { fill: "#fbe7a4", shade: "small", gloss: false, lineWidth: 0.9 })
    .def("lyso", { fill: "#e9876b", shade: "small", gloss: false, lineWidth: 0.8 })
    .def("phago", { fill: "#fdeee3", shade: "dip", lineWidth: 1 })
    .def("prey", { fill: "#ddb9e6", shade: "small", gloss: false, lineWidth: 0.9 })
    .def("preyNuc", { fill: "#5b3a8e", lineWidth: 0.5 })
    .def("nuc", { fill: "#8f61a8", shade: "organelle", lineWidth: 1.2 })
    .def("secr", { fill: "#6fa8dc", shade: "small", gloss: false, lineWidth: 0.8 });
  // broad ruffled lobes plus 9 small pointed pseudopods / filopodia (none where the secreted factors leave)
  const bumps = [[-150, 12, 14], [-100, 9, 12], [-45, 10, 13], [100, 12, 13], [150, 10, 12], [205, 8, 12], [66, 6, 12],
    [-172, 14, 5], [-128, 16, 4.6], [-95, 10, 3.6], [-72, 14, 5], [-20, 12, 4.6], [84, 13, 4.6], [124, 15, 5], [178, 10, 4], [230, 13, 5]];
  O.add("body", smoothClosed(starPts(92, 100, 64, 56, bumps, { rot: -8, wobble: 0.05, seed: 3, n: 260 }), 0.9));
  O.add("phago", circle(118, 78, 19));
  O.add("prey", blob(119, 79, 12.5, 11.5, { n: 9, wobble: 0.1, seed: 4 }));
  O.add("preyNuc", [circle(114, 76, 3), circle(122, 82, 2.6), circle(121, 72, 1.9), circle(113, 84, 1.6)]);
  // reniform nucleus (~30% of the cell width), off-centre, its shallow notch facing the phagosome
  O.add("nuc", smoothClosed(beanPts(74, 112, 18, 12, 232, 0.22, 24)));
  O.add("lipid", [circle(50, 82, 6), circle(126, 136, 5.4), circle(44, 128, 4.6)]);
  O.add("lyso", [circle(80, 64, 3.6), circle(98, 54, 3.2), circle(146, 104, 3.6), circle(104, 146, 3.3), circle(140, 124, 3), circle(64, 88, 3), circle(141, 86, 2.8)]);
  // secreted factors (IL-10, TGF-β, VEGF…) leaving from the right-hand surface
  O.add("secr", [circle(150, 146, 3), circle(162, 138, 3.4), circle(174, 148, 3), circle(170, 162, 3.4), circle(184, 156, 3), circle(158, 158, 2.6), circle(160, 118, 2.6)]);
  return { size: [200, 200], lineWidth: 1.6, parts: O.parts() };
}

/** Shared parts of the mitotic tumour cells: a rounded, slightly blebbing cell, spindle microtubules, centrosomes, chromosomes. */
function mitoticKit(O, blebs, { cx = 100, cy = 101, rx = 84, ry = 82, seed = 11 } = {}) {
  // line style: one outline round cell and blebs; soft style: blebs beneath the shaded body (so its light band
  // does not repeat them inside the cell)
  O.def("cell", { fill: "#ddb9e6", lineWidth: 1.6, soft: false, unite: [] })
    .def("bleb", { fill: "#ddb9e6", shade: "small", gloss: false, line: false })
    .def("cellBody", { fill: "#ddb9e6", shade: "body", line: false })
    .def("mt", { fill: "none", stroke: { color: "#93acd6", width: 1.15, cap: "round" }, lineColor: "#56709e", lineStrokeWidth: 0.8, join: true })
    .def("pcm", { fill: "#fbe0a8", shade: "small", gloss: false, lineWidth: 0.9 })
    .def("centriole", { fill: "#e58a2b", lineWidth: 0.6 })
    .def("centLumen", { fill: "none", stroke: { color: "#f8c98f", width: 0.55, cap: "round" }, lineColor: "#f3c48a", lineStrokeWidth: 0.5, join: true })
    .def("chrom", { fill: "#7a4aa6", shade: "small", gloss: false, lineWidth: 0.9, unite: [] });
  // a rounded mitotic cell, its outline a little uneven, with a few small surface blebs
  const out = starPts(cx, cy, rx, ry, [], { wobble: 0.03, seed, n: 220 });
  O.add("cell", smoothClosed(out, 0.9));
  O.add("cellBody", smoothClosed(out, 0.9));
  // blebs: small round blisters sitting on the membrane ([angle, radius])
  for (const [a, br] of blebs) {
    const p = out.reduce((b, q) => (Math.abs(angDiff(Math.atan2(q[1] - cy, q[0] - cx), rad(a))) < Math.abs(angDiff(Math.atan2(b[1] - cy, b[0] - cx), rad(a))) ? q : b), out[0]);
    const l = dist(p, [cx, cy]);
    const bd = circle(p[0] + ((p[0] - cx) / l) * br * 0.35, p[1] + ((p[1] - cy) / l) * br * 0.35, br);
    O.add("cell", bd);
    O.add("bleb", bd);
  }
  /** An X-shaped metaphase chromosome (two sister chromatids joined at the centromere), long axis at `ang`. */
  const chromosome = ({ x, y, ang }, L, w = 2) => {
    for (const s of [-1, 1]) {
      const a = rad(ang + s * 27);
      O.add("chrom", capsule(x - Math.cos(a) * L, y - Math.sin(a) * L, x + Math.cos(a) * L, y + Math.sin(a) * L, w));
    }
  };
  /** Pericentriolar material round a pair of centrioles set at right angles (with a gap). */
  const centrosome = ([x, y]) => {
    O.add("pcm", circle(x, y, 7.4));
    O.add("centriole", [rect(x - 4, y - 2.9, 4.6, 2.2, 0.9), rect(x + 1.1, y - 0.3, 2.2, 4.6, 0.9)]);
    O.add("centLumen", [lineD([[x - 3, y - 1.8], [x - 0.4, y - 1.8]]), lineD([[x + 2.2, y + 0.7], [x + 2.2, y + 3.3]])]);
  };
  return { chromosome, centrosome };
}
/** A kinetochore fibre from pole P to the side of the centromere at (x, y) that faces it. */
function kFibre(mt, P, x, y, R) {
  const dx = P[0] - x, dy = P[1] - y, l = Math.hypot(dx, dy);
  const end = [x + (dx / l) * 1.6, y + (dy / l) * 1.6];
  const m = [(P[0] + end[0]) / 2 + (R() - 0.5) * 2, (P[1] + end[1]) / 2 + (R() - 0.5) * 2];
  mt.push(smoothOpen([[P[0] - (dx / l) * 4, P[1] - (dy / l) * 4], m, end]));
}
/** Astral microtubules radiating from pole P round direction `dir` (deg), skipping directions skip(a). */
function asters(mt, P, dir, R, skip = () => false) {
  for (let k = 0; k < 7; k++) {
    const da = dir + (k - 3) * 26;
    if (skip(da)) continue;
    const a = rad(da), l = 12 + R() * 6;
    mt.push(lineD([[P[0] + Math.cos(a) * 7.6, P[1] + Math.sin(a) * 7.6], [P[0] + Math.cos(a) * l, P[1] + Math.sin(a) * l]]));
  }
}

/** Tumour cell in mitosis: a bipolar metaphase spindle with one misaligned (polar) chromosome — a common atypical touch. */
function mitosisBipolarScene() {
  const O = new Objs();
  const R = rng(21);
  const c = [100, 100];
  const { chromosome, centrosome } = mitoticKit(O, [[-128, 6], [58, 5], [203, 5.5]], { cx: 100, cy: 100, rx: 82, ry: 75, seed: 23 });
  const poles = [[c[0] - 57, c[1]], [c[0] + 57, c[1]]];
  // metaphase plate: 8 chromosomes on the equator, centromeres on the plate, sister kinetochores facing the two poles
  // [gap to the previous one, sideways offset from the plate, arm length, tilt]: arms from 2.6 to 5.6 (the two
  // shortest read as small acrocentric chromosomes), gaps of 8–15 units, ±2.5 off the plate, tilts up to ±25°
  const spec = [[0, -1.6, 5.4, 14], [12.6, 2.1, 4.2, -9], [9.4, -0.6, 2.7, 22], [13.8, 1.4, 5.6, -18], [8.1, -2.4, 4.6, 6], [11.2, 2.5, 2.6, -24], [14.6, -1.1, 4.9, 11], [9.9, 0.9, 3.6, -5]];
  let yy = 0;
  const chroms = spec.map(([gap, off, arm, tilt]) => {
    yy += gap;
    return { x: c[0] + off, y: yy, ang: 90 + tilt, arm };
  });
  const mid = (chroms[0].y + chroms[chroms.length - 1].y) / 2;
  for (const ch of chroms) ch.y = c[1] + ch.y - mid;
  // a misaligned chromosome near the left pole, attached to that pole only (mono-oriented)
  const mis = { x: poles[0][0] + 14, y: poles[0][1] - 14, ang: 52 };
  for (const ch of chroms) chromosome(ch, ch.arm, ch.arm < 3 ? 1.5 : 1.85);
  chromosome(mis, 4.4, 1.85);
  const mt = [];
  for (const P of poles) for (const ch of chroms) kFibre(mt, P, ch.x, ch.y, R);
  kFibre(mt, poles[0], mis.x, mis.y, R);
  // interpolar microtubules overlapping antiparallel beyond the ends of the plate
  for (const [i, P] of poles.entries()) {
    const sx = i ? -1 : 1;
    for (const sy of [-1, 1]) {
      for (const [reach, bow] of [[14, 50], [6, 55]]) {
        const end = [c[0] + sx * reach, c[1] + sy * (bow + 4)];
        mt.push(smoothOpen([[P[0] + sx * 5.5, P[1] + sy * 3], [c[0] - sx * 26, c[1] + sy * (bow - 4)], end]));
      }
    }
  }
  asters(mt, poles[0], 180, R);
  asters(mt, poles[1], 0, R);
  O.add("mt", mt);
  poles.forEach(centrosome);
  return { size: [200, 200], lineWidth: 1.6, parts: O.parts() };
}

/** Tumour cell in an atypical tripolar mitosis (centrosome amplification → chromosomal instability). */
function mitosisScene() {
  const O = new Objs();
  const R = rng(9);
  const { chromosome, centrosome } = mitoticKit(O, [[-30, 5.5], [88, 5], [212, 5.8]]);
  const c = [100, 109];
  const poleAng = [-98, 24, 154], poleR = [50, 58, 63];
  const poles = poleAng.map((a, i) => [c[0] + Math.cos(rad(a)) * poleR[i], c[1] + Math.sin(rad(a)) * poleR[i] * 0.97]);
  // three-armed (Y-shaped) metaphase plate: each arm lies between two poles; the arms are unequal and carry
  // 2, 3 and 4 chromosomes at uneven distances
  const arms = [-37, 89, 205], along = [[13, 31], [10, 24, 41], [9, 20, 33, 45]];
  const chroms = [];
  for (const [ai, a] of arms.entries()) {
    for (const t of along[ai]) {
      const x = c[0] + Math.cos(rad(a)) * t + (R() - 0.5) * 3, y = c[1] + Math.sin(rad(a)) * t + (R() - 0.5) * 3;
      // long axis in the plate, so the two sister kinetochores face the poles either side of the arm
      chroms.push({ x, y, ang: a + (R() - 0.5) * 24, arm: a });
    }
  }
  // a misaligned, mono-oriented chromosome lying next to the top pole
  const top = poles[0], mis = { x: top[0] + Math.cos(rad(16)) * 15.5, y: top[1] + Math.sin(rad(16)) * 15.5, ang: 106, arm: null };
  for (const ch of [...chroms, mis]) chromosome(ch, 3 + R() * 2.4);
  // kinetochore fibres: each pole fans out to the chromosomes on the two arms beside it (±60°),
  // ending at the centromere on the side that faces it — three half-spindles, none crossing the plate
  const mt = [];
  poles.forEach((P, i) => {
    const pa = poleAng[i];
    for (const ch of chroms) if (Math.abs(angDiff(rad(ch.arm), rad(pa))) < rad(90)) kFibre(mt, P, ch.x, ch.y, R);
    // astral microtubules (none toward the misaligned chromosome)
    asters(mt, P, pa, R, (da) => i === 0 && Math.abs(angDiff(rad(da), rad(16))) < rad(35));
  });
  kFibre(mt, top, mis.x, mis.y, R);
  O.add("mt", mt);
  poles.forEach(centrosome);
  return { size: [200, 200], lineWidth: 1.6, parts: O.parts() };
}

/* ===================== tertiary lymphoid structure ===================== */

function tlsScene(seed = 701) {
  const R = rng(seed), L = new Layers();
  const W3 = 260, H3 = 220;
  const frame = roundRectPts(6, 6, W3 - 12, H3 - 12, 9);
  const inF = (p, m = 0) => inside(frame, p) && polyDist(p, frame) > m;
  L.def("matrix", { fill: C.matrix, stroke: sw(shade(C.matrix, 0.1), 1), lineWidth: 1.2 })
    .def("collagen", { fill: "none", stroke: { color: C.collagen, width: 1.3, cap: "round" }, lineColor: "#dca5a8", lineStrokeWidth: 0.7 })
    .def("tzone", { fill: "#e4eefa", lineColor: flat("#e4eefa"), lineWidth: 0.3 })
    .def("mantle", { fill: "#e6f2d8", lineColor: flat("#e6f2d8"), lineWidth: 0.3 })
    .def("gcBg", { fill: "#f5f8f1", lineColor: flat("#f5f8f1"), lineWidth: 0.3 })
    // the dark zone: a darker tint under the lower-left part of the germinal centre, with a soft edge
    .def("dzSoft", { fill: "#dcebc9", opacity: 0.5, line: false })
    .def("dz", { fill: "#dcebc9", lineColor: flat("#dcebc9"), lineWidth: 0.3 })
    .def("fdc", { fill: "none", stroke: { color: "#cdb3dc", width: 1, cap: "round" }, lineColor: "#9b7bb0", lineStrokeWidth: 0.55 })
    .def("fdcNuc", { fill: "#b79bd0", lineWidth: 0.4 })
    // fibroblastic reticular cell (FRC) strands: the faint conduit network under the T cells
    .def("frc", { fill: "none", stroke: { color: "#c3d2e8", width: 0.9, cap: "round" }, opacity: 0.85, lineColor: "#a9bbd6", lineStrokeWidth: 0.5 });
  std(L, ["fibro", "fibroNuc", "wall", "lumen", "rbc", "endo"]);
  L.def("hev", { fill: "#f5bccb", stroke: sw(shade("#f5bccb", 0.16), 0.5), lineWidth: 0.6 })
    .def("hevNuc", { fill: "#8b63b3", lineWidth: 0.35 })
    .def("hevLumen", { fill: "#fdf0ee", lineWidth: 0.4 });
  std(L, ["tcell", "tnuc", "bcell", "bnuc", "plasma", "plasmaNuc", "mac", "macNuc"]);
  // centroblasts (dark zone): large, scant basophilic cytoplasm, dark nucleus with nucleoli at its rim;
  // centrocytes (light zone): smaller, paler, with a cleaved mid-toned nucleus
  L.def("cb", { fill: "#cfe6b3", shade: "small", lineWidth: 0.55 })
    .def("cbNuc", { fill: "#5d8a43", lineWidth: 0.4 })
    .def("cbNucl", { fill: "#2f5323", lineWidth: 0.2 })
    .def("cc", { fill: "#e4f2d4", shade: "small", lineWidth: 0.5 })
    .def("ccNuc", { fill: "#6f9a55", lineWidth: 0.35 })
    .def("tbm", { fill: "#fbe1cd", stroke: sw("#ebbfa1", 0.6), lineWidth: 0.6 })
    .def("tbmNuc", { fill: "#a77cb5", lineWidth: 0.4 })
    .def("tbmVac", { fill: "#fff6ee", lineWidth: 0.3 })
    .def("apo", { fill: "#3f2c6b", lineWidth: 0.3 })
    .def("idc", { fill: "#bfe4da", stroke: sw("#9fcdbf", 0.5), lineWidth: 0.6 })
    .def("idcNuc", { fill: "#6f8cc4", lineWidth: 0.35 });
  L.add("matrix", polyD(frame));

  const outer = ovalPts(128, 112, 108, 88, { wobble: 0.05, seed: seed + 1, n: 100 });
  const foll = ovalPts(116, 100, 62, 50, { rot: -8, wobble: 0.04, seed: seed + 2, n: 90 });
  // germinal centre set toward the dark-zone side (lower left): the mantle forms a thick cap over the light zone
  const gc = ovalPts(108, 104, 45, 35, { rot: -8, wobble: 0.05, seed: seed + 3, n: 80 });
  const box = { x: 8, y: 8, w: W3 - 16, h: H3 - 16 };

  // surrounding stroma: capillaries and fibroblasts, then collagen as long bundles round the aggregate
  const strom = packWhere(box, 7, 26, (q) => inF(q, 12) && !near(q, outer, 12), { seed: seed + 5 });
  {
    const RC = rng(seed + 13);
    const clearOf = (q) => inF(q, 4) && !near(q, outer, 2) && !strom.some((t) => dist(q, t) < 9);
    const runs = (pts, minLen) => {
      const out = [];
      let cur = [];
      const flush = () => {
        if (cur.length > 2 && pathLen(cur) >= minLen) out.push(cur);
        cur = [];
      };
      for (const q of pts) (clearOf(q) ? cur.push(q) : flush());
      flush();
      return out;
    };
    for (let k = 0; k < 9; k++) {
      const d0 = 5 + RC() * 14, ns = RC() < 0.45 ? 3 : 2, sp = 2.6 + RC() * 0.9, len = 50 + RC() * 60, i0 = Math.floor(RC() * outer.length);
      const amp = 0.6 + RC() * 0.6, wl = 18 + RC() * 8, ph = RC() * 6;
      for (let j = 0; j < ns; j++) for (const r of runs(waveLine(resample(walkClosed(offsetClosed(outer, d0 + j * sp), i0, len), 1.4), amp, wl, ph), 14)) L.add("collagen", smoothOpen(r));
    }
  }
  strom.forEach((p, k) => {
    if (k < 2) capillary(L, { cx: p[0], cy: p[1], rx: 6.4, ry: 5.4, rot: R() * 180, seed: seed + 6 + k });
    else {
      const a = (Math.atan2(p[1] - 112, p[0] - 128) * 180) / Math.PI + 90;
      L.add("fibro", spindle(p[0], p[1], 20, 3.4, a));
      L.add("fibroNuc", ellipse(p[0], p[1], 3.6, 1.1, a));
    }
  });

  L.add("tzone", polyD(outer));
  L.add("mantle", polyD(foll));
  L.add("gcBg", polyD(gc));
  // dark zone (lower left, ~45% of the GC) bounded by a gentle curve: inside a large circle centred far down-left
  const gcC = centroid(gc);
  const dzR = 70, dzC = [gcC[0] - 0.625 * (dzR + 3), gcC[1] + 0.78 * (dzR + 3)];
  const circ = (r) => Array.from({ length: 120 }, (_, i) => [dzC[0] + Math.cos((i / 120) * Math.PI * 2) * r, dzC[1] + Math.sin((i / 120) * Math.PI * 2) * r]);
  L.add("dzSoft", polyD(clipConvex(gc, circ(dzR + 3.5))));
  L.add("dz", polyD(clipConvex(gc, circ(dzR))));
  const lightZone = (q) => dist(q, dzC) > dzR + 1.5;

  // high endothelial venules in the T-cell zone: plump cuboidal endothelium, lymphocytes crossing
  const hevs = [[44, 150, 10, 8, 30], [212, 70, 9.5, 8, -20], [200, 172, 10.5, 8, 15], [148, 182, 8.5, 7, 0]];
  const hevPolys = [];
  for (const [x, y, rx, ry, rot] of hevs) {
    const o = ovalPts(x, y, rx, ry, { rot, wobble: 0.04, seed: x + y, n: 48 });
    hevPolys.push(o);
    const { cells, inner } = ringCells(o, { rows: 1, th: Math.min(rx, ry) * 0.58, cellLen: 4.8, jitter: 0.1, seed: x });
    for (const { poly, base, apex } of cells) {
      L.add("hev", roundPoly(poly, 0.8));
      L.add("hevNuc", circle(base[0] + (apex[0] - base[0]) * 0.45, base[1] + (apex[1] - base[1]) * 0.45, 1.55));
    }
    L.add("hevLumen", polyD(inner));
  }

  // T-cell zone: densely packed small T cells, a few interdigitating dendritic cells
  const idcs = packWhere(box, 5, 40, (q) => inside(outer, q) && polyDist(q, outer) > 6 && !near(q, foll, 7) && !hevPolys.some((h) => near(q, h, 8)), { seed: seed + 7 });
  for (const p of idcs) {
    L.add("idc", blob(p[0], p[1], 6.8, 5.4, { n: 9, wobble: 0.22, seed: Math.round(p[0] * 7 + p[1]), rot: R() * 180 }));
    L.add("idcNuc", blob(p[0], p[1], 3, 2.2, { n: 7, wobble: 0.15, seed: Math.round(p[0] + p[1]), rot: R() * 180 }));
  }
  // reticular (FRC) strands meandering through the T zone, under the T cells
  {
    const RF = rng(seed + 14);
    const inTz = (q) => inside(outer, q) && polyDist(q, outer) > 4 && !near(q, foll, 4) && !hevPolys.some((h) => near(q, h, 2));
    for (let k = 0, got = 0; k < 60 && got < 5; k++) {
      let q = [box.x + RF() * box.w, box.y + RF() * box.h];
      if (!inTz(q)) continue;
      let a = RF() * Math.PI * 2;
      const pts = [q];
      for (let i = 0; i < 26; i++) {
        a += (RF() - 0.5) * 0.7;
        const nq = [q[0] + Math.cos(a) * 4, q[1] + Math.sin(a) * 4];
        if (!inTz(nq)) break;
        pts.push((q = nq));
      }
      if (pts.length >= 9) {
        L.add("frc", smoothOpen(pts));
        got++;
      }
    }
  }
  const tz = packWhere(box, 460, 7.3, (q) => inside(outer, q) && polyDist(q, outer) > 3 && !near(q, foll, 3.6) && !hevPolys.some((h) => near(q, h, 3.6)) && !idcs.some((d) => dist(q, d) < 9.5), { seed: seed + 8, tries: 300 });
  for (const p of tz) roundCell(L, p, 2.9 + R() * 0.65, "tcell", "tnuc", R, 0.7 + R() * 0.06);
  // lymphocytes in the HEV lumens and squeezing through the wall
  hevs.forEach(([x, y], k) => {
    roundCell(L, [x - 1, y], 2.6, "tcell", "tnuc", R, 0.72);
    if (k % 2 === 0) roundCell(L, [x + hevs[k][2] * 0.85, y - hevs[k][3] * 0.4], 2.8, "bcell", "bnuc", R, 0.72);
  });

  // mantle zone: small, tightly packed naive B cells
  for (const p of packWhere(box, 220, 6.4, (q) => inside(foll, q) && polyDist(q, foll) > 2.6 && !near(q, gc, 2.8), { seed: seed + 9, tries: 300 })) roundCell(L, p, 2.9, "bcell", "bnuc", R, 0.74);

  // germinal centre: tingible-body macrophages, an FDC meshwork across the light zone (upper right),
  // centroblasts packed in the dark zone (lower left), looser centrocytes in the light zone
  const tbms = [[gcC[0] - 14, gcC[1] + 8], [gcC[0] + 16, gcC[1] - 4]];
  tbms.forEach(([x, y], ti) => {
    const RT = rng(seed + 20 + ti);
    L.add("tbm", blob(x, y, 7.4, 6.4, { n: 8, wobble: 0.1, seed: Math.round(x + y) }));
    // 4–6 phagocytosed apoptotic fragments of different sizes, each in its own pale vacuole, clustered on the
    // side away from the nucleus
    const n = 4 + Math.floor(RT() * 3), placed = [];
    for (let t = 0; t < 1500 && placed.length < n; t++) {
      const a = rad(165 + (RT() - 0.5) * 190), d = RT() * 4.8, r = 0.55 + RT() * (placed.length < 2 ? 1.05 : 0.6);
      const q = [x - 1 + Math.cos(a) * d, y + 0.9 + Math.sin(a) * d];
      if (dist(q, [x, y]) + r + 0.9 > 6.1 || dist(q, [x + 2.9, y - 2.7]) < r + 3.1 || placed.some(([q2, r2]) => dist(q, q2) < r + r2 + 0.85)) continue;
      placed.push([q, r]);
    }
    L.add("tbmVac", placed.map(([q, r]) => circle(q[0], q[1], r + 0.75)));
    L.add("apo", placed.map(([q, r]) => blob(q[0], q[1], r, r * (0.8 + RT() * 0.2), { n: 7, wobble: 0.18, seed: Math.round(q[0] * 13 + q[1]) })));
    // its own pale kidney-shaped nucleus, pushed to the edge
    L.add("tbmNuc", smoothClosed(beanPts(x + 2.9, y - 2.7, 2.9, 2, 35, 0.3, 16)));
  });
  const fdcs = packWhere(box, 6, 11.5, (q) => inside(gc, q) && polyDist(q, gc) > 6.5 && dist(q, dzC) > dzR + 5 && !tbms.some((t) => dist(q, t) < 10), { seed: seed + 10, tries: 3000 });
  const inGC = (q) => inside(gc, q) && polyDist(q, gc) > 2;
  const links = new Set();
  fdcs.forEach((p, i) => {
    // long, gently wavy dendrites joining each FDC to its nearest neighbours: one continuous mesh
    fdcs.map((q, j) => [j, dist(p, q)]).filter(([j, d]) => j !== i && d < 26).sort((x, y) => x[1] - y[1]).slice(0, 3).forEach(([j]) => {
      const key = Math.min(i, j) + "-" + Math.max(i, j);
      if (links.has(key)) return;
      links.add(key);
      const q = fdcs[j], l = dist(p, q), nx = -(q[1] - p[1]) / l, ny = (q[0] - p[0]) / l, w = (R() - 0.5) * 5;
      L.add("fdc", smoothOpen([p, [p[0] + (q[0] - p[0]) * 0.33 + nx * w, p[1] + (q[1] - p[1]) * 0.33 + ny * w], [p[0] + (q[0] - p[0]) * 0.66 - nx * w * 0.6, p[1] + (q[1] - p[1]) * 0.66 - ny * w * 0.6], q]));
    });
    // and a few short free processes
    for (let k = 0; k < 3; k++) {
      const a = R() * Math.PI * 2, l = 5 + R() * 4;
      const e = [p[0] + Math.cos(a) * l, p[1] + Math.sin(a) * l];
      if (inGC(e)) L.add("fdc", smoothOpen([p, [p[0] + Math.cos(a + 0.3) * l * 0.5, p[1] + Math.sin(a + 0.3) * l * 0.5], e]));
    }
    L.add("fdcNuc", [ellipse(p[0] - 1.6, p[1], 2.1, 1.6, 20), ellipse(p[0] + 1.7, p[1] + 0.4, 2.1, 1.6, -20)]);
  });
  const freeOf = (q) => !tbms.some((t) => dist(q, t) < 10.5) && !fdcs.some((t) => dist(q, t) < 5.2);
  const dzCells = packWhere(box, 140, 7.4, (q) => inside(gc, q) && polyDist(q, gc) > 3.8 && !lightZone(q) && freeOf(q), { seed: seed + 11, tries: 900 });
  for (const p of dzCells) {
    L.add("cb", circle(p[0], p[1], 3.9));
    L.add("cbNuc", circle(p[0] + 0.2, p[1] + 0.2, 3.2));
    // 1–2 small nucleoli against the nuclear membrane
    const a = R() * Math.PI * 2;
    L.add("cbNucl", circle(p[0] + 0.2 + Math.cos(a) * 2.3, p[1] + 0.2 + Math.sin(a) * 2.3, 0.55));
    if (R() < 0.5) L.add("cbNucl", circle(p[0] + 0.2 + Math.cos(a + 2.4) * 2.3, p[1] + 0.2 + Math.sin(a + 2.4) * 2.3, 0.45));
  }
  const lzCells = packWhere(box, 90, 7.7, (q) => inside(gc, q) && polyDist(q, gc) > 3.6 && lightZone(q) && freeOf(q) && !dzCells.some((d) => dist(q, d) < 7.6), { seed: seed + 12, tries: 900 });
  // (looser than the dark zone: the FDC meshwork shows between the centrocytes)
  for (const p of lzCells) {
    L.add("cc", circle(p[0], p[1], 3.4));
    L.add("ccNuc", smoothClosed(beanPts(p[0], p[1], 2.4, 1.8, R() * 360, 0.2, 14)));
  }
  // plasma cells and a macrophage at the edge of the aggregate
  for (const p of packWhere(box, 7, 12, (q) => inF(q, 8) && polyDist(q, outer) < 9 && !inside(outer, q) && !strom.some((s) => dist(q, s) < 14), { seed: seed + 12 })) {
    const a = R() * 180, ar = rad(a);
    L.add("plasma", ellipse(p[0], p[1], 5.2, 3.8, a));
    L.add("plasmaNuc", circle(p[0] + Math.cos(ar) * 1.9, p[1] + Math.sin(ar) * 1.9, 2.1));
  }
  return { size: [W3, H3], lineWidth: 1.2, parts: L.parts() };
}

/* ===================== icons ===================== */

const SECTION = ["histology", "tissue section", "H&E", "pathology", "oncology", "cancer", "tumour", "tumor", "glandular epithelium", "adenocarcinoma", "carcinoma progression", "breast", "colorectal", "prostate", "pancreas"];

export const icons = [
  {
    slug: "tumour-normal-glandular-epithelium",
    name: "Glandular tissue — normal (before carcinoma)",
    category: "tissues",
    tags: [...SECTION, "normal", "healthy", "gland", "acinus", "duct", "columnar epithelium", "polarised epithelium", "basal nuclei", "basement membrane", "myoepithelial cells", "basal cell layer", "stroma", "fibroblasts", "capillaries", "carcinoma progression stage 1"],
    scene: () => carcinoma("normal"),
  },
  {
    slug: "tumour-carcinoma-in-situ",
    name: "Carcinoma in situ — atypical cells within an intact basement membrane",
    category: "tissues",
    tags: [...SECTION, "carcinoma in situ", "CIS", "DCIS", "ductal carcinoma in situ", "high-grade dysplasia", "intraepithelial neoplasia", "PIN", "atypia", "pleomorphism", "hyperchromasia", "loss of polarity", "mitoses", "cribriform", "comedo necrosis", "microcalcification", "calcification", "intact basement membrane", "myoepithelial cells", "basal cell layer", "pre-invasive", "neoplasia"],
    scene: () => carcinoma("cis"),
  },
  {
    slug: "tumour-invasive-carcinoma",
    name: "Invasive carcinoma with its tumour microenvironment",
    category: "tissues",
    tags: [...SECTION, "invasive carcinoma", "invasion", "basement membrane breach", "loss of myoepithelial layer", "DCIS with invasion", "cribriform", "infiltrating glands", "tumour nests", "tumour budding", "desmoplasia", "desmoplastic stroma", "CAF", "cancer-associated fibroblasts", "TAM", "tumour-associated macrophages", "CD8 T cells", "tumour-infiltrating lymphocytes", "TILs", "invasive margin", "Treg", "neutrophils", "angiogenesis", "leaky vessels", "intravasation", "TMEM doorway", "metastasis", "necrosis", "tumour microenvironment", "TME", "malignant"],
    scene: () => carcinoma("invasive"),
  },
  {
    slug: "tumour-microenvironment-overview",
    name: "Tumour microenvironment (TME) — overview schematic",
    category: "tissues",
    tags: ["tumour microenvironment", "tumor microenvironment", "TME", "cancer", "oncology", "tumour", "tumor", "immuno-oncology", "IO", "cancer immunology", "review figure", "schematic",
      "tumour cells", "cancer cells", "CAF", "cancer-associated fibroblasts", "ECM", "extracellular matrix", "collagen", "desmoplasia",
      "TAM", "tumour-associated macrophages", "M1 macrophage", "M2 macrophage", "CD8 T cell", "cytotoxic T lymphocyte", "CTL", "CD4 T cell", "helper T cell", "Treg", "regulatory T cell", "FOXP3",
      "B cells", "tertiary lymphoid structure", "TLS", "NK cell", "natural killer", "MDSC", "myeloid-derived suppressor cells", "dendritic cell", "DC", "cDC1",
      "blood vessel", "endothelium", "endothelial cells", "pericytes", "angiogenesis", "sprouting", "tip cell", "VEGF", "hot tumour", "immune infiltrate", "single-cell", "spatial omics"],
    scene: () => tmeOverview(),
  },
  {
    slug: "cancer-associated-fibroblast",
    name: "Cancer-associated fibroblast (CAF)",
    category: "cells",
    tags: ["CAF", "cancer-associated fibroblast", "carcinoma-associated fibroblast", "tumour stroma", "tumor stroma", "myCAF", "myofibroblastic CAF", "iCAF", "inflammatory CAF", "apCAF", "LRRC15", "FAP", "fibroblast activation protein",
      "α-SMA", "alpha-SMA", "ACTA2", "stress fibres", "PDGFRβ", "PDPN", "podoplanin", "vimentin", "activated fibroblast", "myofibroblast", "desmoplasia", "ECM remodelling", "collagen", "TGF-β", "IL-6", "CXCL12",
      "secretory vesicles", "stromal cell", "mesenchymal", "tumour microenvironment", "TME", "fibroblast-like synoviocyte", "FLS"],
    scene: () => cafScene(),
  },
  {
    slug: "tumour-associated-macrophage",
    name: "Tumour-associated macrophage (TAM)",
    category: "immune-cells",
    tags: ["TAM", "tumour-associated macrophage", "tumor-associated macrophage", "macrophage", "M2-like", "alternatively activated", "CD163", "CD206", "MRC1", "SPP1", "TREM2", "C1Q", "lipid-associated macrophage",
      "efferocytosis", "phagocytosis", "phagosome", "apoptotic cell", "lysosomes", "lipid droplets", "IL-10", "TGF-β", "VEGF", "immunosuppression", "angiogenesis", "tumour microenvironment", "TME", "myeloid cell", "innate immunity"],
    scene: () => tamScene(),
  },
  {
    slug: "tumour-cell-mitosis",
    name: "Tumour cell in mitosis — metaphase spindle with a misaligned chromosome",
    category: "cells",
    tags: ["mitosis", "tumour cell", "tumor cell", "cancer cell", "cell division", "dividing cell", "metaphase", "bipolar spindle", "mitotic spindle", "metaphase plate", "spindle microtubules", "kinetochore fibres", "k-fibres",
      "interpolar microtubules", "astral microtubules", "centrosome", "centrioles", "chromosomes", "misaligned chromosome", "polar chromosome", "chromosome missegregation", "chromosomal instability", "CIN", "aneuploidy",
      "proliferation", "Ki-67", "PHH3", "phospho-histone H3", "mitotic figure", "mitotic index", "antimitotic", "taxane", "oncology", "cancer"],
    scene: () => mitosisBipolarScene(),
  },
  {
    slug: "tumour-cell-multipolar-mitosis",
    name: "Tumour cell in multipolar mitosis — atypical tripolar spindle",
    category: "cells",
    tags: ["mitosis", "tumour cell", "tumor cell", "cancer cell", "cell division", "metaphase", "atypical mitosis", "multipolar mitosis", "tripolar spindle", "mitotic spindle", "spindle microtubules", "kinetochore",
      "centrosome", "centrosome amplification", "centrioles", "chromosomes", "chromosomal instability", "CIN", "aneuploidy", "misaligned chromosome", "proliferation", "Ki-67", "PHH3", "mitotic figure", "oncology", "cancer"],
    scene: () => mitosisScene(),
  },
  {
    slug: "tertiary-lymphoid-structure",
    name: "Tertiary lymphoid structure (TLS) — follicle, germinal centre, T-cell zone and HEVs",
    category: "tissues",
    tags: ["tertiary lymphoid structure", "TLS", "ectopic lymphoid structure", "ELS", "lymphoid aggregate", "lymphoid neogenesis", "B-cell follicle", "germinal centre", "germinal center", "GC", "dark zone", "light zone",
      "centroblasts", "centrocytes", "follicular dendritic cells", "FDC", "tingible-body macrophage", "mantle zone", "T-cell zone", "T cells", "B cells", "plasma cells", "high endothelial venule", "HEV", "PNAd", "MECA-79",
      "interdigitating dendritic cells", "histology", "H&E", "tissue section", "rheumatoid arthritis", "RA synovium", "lympho-myeloid", "Sjögren's", "cancer", "tumour", "tumor", "immunotherapy response", "mature TLS", "spatial omics"],
    scene: () => tlsScene(),
  },
];
