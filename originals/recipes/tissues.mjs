// Synovium and knee joint, healthy and diseased, drawn as histology-style sections in the Servier
// look. Paired states share the same framing so they sit side by side in a figure.
//
// SYNOVIUM (360 × 260). Plan, bottom → top (definition order = paint order):
//   matrix (sublining stroma) → fat → collagen bundles → lymphatic → vessels (wall, lumen, RBC,
//   endothelial + mural nuclei) → fibroblasts → germinal-centre zone → B, T, plasma, macrophage,
//   mast cells → lining cells (FLS, MLS) → lining nuclei → fibrin → neutrophils.
//   Healthy: lining 1–2 loosely arranged cells (no basement membrane), capillaries right under it,
//   loose areolar sublining with a venule, arteriole and lymphatic, adipose lobule below.
//   RA (same villous outline in all three pathotypes, so only the composition differs):
//     lining hyperplasia (4 rows, Krenn grade 2; 3 rows in the fibroid type), villi of different
//     shape and height (club-shaped, tall and leaning, bilobed), neoangiogenesis in villus cores.
//     Pathotypes after Pitzalis/Humby (Lewis et al. 2019, Humby et al. 2019):
//       lympho-myeloid  — an irregular perivascular B/T aggregate: an off-centre B follicle with a
//                         polarised germinal centre, a broader T zone with HEVs (plump endothelium,
//                         a lymphocyte crossing), a lopsided perivascular cuff, clustered plasma cells;
//       diffuse-myeloid — sublining sheets of macrophages, scattered T and plasma cells, no aggregates;
//       pauci-immune fibroid — long collagen bundles with aligned fibroblasts, scant immune cells.
//   Lining cells are soft rounded shapes of uneven size (loose, gappy in health), not epithelial bricks.
//   Variation: seeded packing, warped-lattice dense packing (no rows), uneven spacing, size ±15–25 %,
//   clustered infiltrates. Every scene is clamped to its frame (clampScene).
//
// KNEE (300 × 344), coronal section seen from the front, medial on the left. Plan:
//   fluid → synovial membrane (ring + reflections over the bare bone areas) → fibrous capsule (ring)
//   → fibula → femur/tibia cortex (+ osteophytes united in OA) → cancellous bone → medullary cavity
//   → pores → epiphyseal scars → sclerosis/cysts (OA) → cruciate ligaments → articular cartilage →
//   menisci (attached to the capsule) → collateral ligaments (MCL on the capsule, LCL to the fibular
//   head) → pannus and erosions (RA).
import { circle, ellipse, blob, rng, smoothClosed, smoothOpen, armsPts, blobPts, ribbon } from "../lib/geom.mjs";
import { shade } from "../lib/style.mjs";
import {
  catmull, resample, normals, cellBand, honeycomb, clipConvex, rectPoly, roundPoly, spindle,
  packIn, packWhere, inside, polyD, lineD, centroid, area, offsetClosed, strip, lobes, signedArea,
} from "../lib/tissue.mjs";
import { C, Layers, sw } from "../lib/histo.mjs";
import { fitInside, checkInside, assertInside, edgeDistance, unevenSpacing, clustered, vary } from "../lib/organic.mjs";

const R2D = 180 / Math.PI;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* ---------- small local helpers ---------- */

/**
 * Clip a scene to its axis-aligned frame by clamping every coordinate into [x0, x1] × [y0, y1]: the parts of a
 * shape beyond the frame collapse onto the frame edge (a straight cut), so nothing pokes out of the art box.
 */
function clampD(d, [x0, y0, x1, y1]) {
  let cmd = "M", idx = 0;
  return d.replace(/([MLHVCQZ])|(-?\d*\.?\d+(?:e-?\d+)?)/gi, (tok, c, num) => {
    if (c) {
      cmd = c.toUpperCase();
      idx = 0;
      return c;
    }
    const isX = cmd === "H" ? true : cmd === "V" ? false : idx % 2 === 0;
    idx++;
    const v = isX ? Math.min(x1, Math.max(x0, Number(num))) : Math.min(y1, Math.max(y0, Number(num)));
    return (Math.round(v * 100) / 100).toString();
  });
}
function clampScene(scene, box) {
  scene.parts = scene.parts.map((p) => ({
    ...p,
    ...(p.d ? { d: Array.isArray(p.d) ? p.d.map((x) => clampD(x, box)) : clampD(p.d, box) } : {}),
    ...(p.unite ? { unite: p.unite.map((x) => clampD(x, box)) } : {}),
  }));
  return scene;
}


/** Closed outline offset by a per-point distance t(i) (positive = inward), whatever its winding. */
function offsetVar(pts, t) {
  const n = pts.length, sgn = signedArea(pts) > 0 ? 1 : -1;
  return pts.map((p, i) => {
    const a = pts[(i - 2 + n) % n], b = pts[(i + 2) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, d = -t(i);
    return [p[0] + (dy / l) * d * sgn, p[1] - (dx / l) * d * sgn];
  });
}
/** A ring (outer minus inner) as one compound path. */
const ringD = (outer, inner) => {
  const sa = signedArea(outer) > 0, sb = signedArea(inner) > 0;
  return polyD(outer) + polyD(sa === sb ? inner.slice().reverse() : inner);
};
/** y where a polyline crosses x (pick = Math.min for the upper crossing, Math.max for the lower). */
function yAt(pts, x, pick = Math.min, closed = false) {
  const ys = [];
  const n = pts.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) ys.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
  }
  return ys.length ? pick(...ys) : null;
}
/** Split a point list into runs where test(p) holds; keep runs of at least `minPts` points. */
function runs(pts, test, minPts = 5) {
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (test(p)) cur.push(p);
    else {
      if (cur.length >= minPts) out.push(cur);
      cur = [];
    }
  }
  if (cur.length >= minPts) out.push(cur);
  return out;
}
/** Points on a jittered hexagonal lattice inside a box that pass test(p): dense, cell-to-cell packing. */
function hexFill(box, d, R, test) {
  const out = [];
  for (let row = 0, y = box.y; y <= box.y + box.h; row++, y += d * 0.866) {
    for (let x = box.x + (row % 2 ? d / 2 : 0); x <= box.x + box.w; x += d) {
      const p = [x + (R() - 0.5) * d * 0.26, y + (R() - 0.5) * d * 0.26];
      if (test(p)) out.push(p);
    }
  }
  return out;
}
/**
 * Dense, touching packing without lattice rows: a hexagonal lattice turned to a random angle, bent by a
 * smooth warp field and jittered, so rows wander and break like cells in a lymphoid aggregate.
 */
function warpFill(box, d, R, test, { warp = 0.34, jit = 0.2 } = {}) {
  const rot = R() * Math.PI, c = Math.cos(rot), s = Math.sin(rot);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, half = Math.hypot(box.w, box.h) / 2 + d;
  const ph = [R() * 6, R() * 6, R() * 6, R() * 6];
  const out = [];
  for (let row = 0, v = -half; v <= half; row++, v += d * 0.866) {
    for (let u = -half + (row % 2 ? d / 2 : 0); u <= half; u += d) {
      let x = cx + u * c - v * s, y = cy + u * s + v * c;
      x += warp * d * Math.sin(y / (2.6 * d) + ph[0]) + 0.08 * d * Math.sin(y / (1.3 * d) + ph[2]);
      y += warp * d * Math.sin(x / (3 * d) + ph[1]) + 0.08 * d * Math.sin(x / (1.4 * d) + ph[3]);
      const p = [x + (R() - 0.5) * d * jit * 2, y + (R() - 0.5) * d * jit * 2];
      if (test(p) && !out.some((q) => dist(q, p) < d * 0.72)) out.push(p);
    }
  }
  return out;
}

/** Offset an open polyline by d along its left normal. */
const offsetOpen = (pts, d) => {
  const ns = normals(pts);
  return pts.map((p, i) => [p[0] + ns[i][0] * d, p[1] + ns[i][1] * d]);
};
/** Perimeter of a polygon resampled to n points spaced evenly by arc length. */
function perim(poly, n) {
  const closed = [...poly, poly[0]], s = arcLengthsOf(closed), total = s[s.length - 1], out = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * total;
    let i = 0;
    while (i < s.length - 2 && s[i + 1] < t) i++;
    const u = (t - s[i]) / ((s[i + 1] - s[i]) || 1);
    out.push([closed[i][0] + (closed[i + 1][0] - closed[i][0]) * u, closed[i][1] + (closed[i + 1][1] - closed[i][1]) * u]);
  }
  return out;
}
function arcLengthsOf(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i], pts[i - 1]));
  return s;
}
/** A soft, slightly irregular cell outline from a packing polygon: rounded, shrunk toward its centre, jittered. */
function softCell(poly, R, k = 0.88, jit = 0.45, n = 10) {
  const c = centroid(poly);
  return perim(poly, n).map(([x, y]) => [c[0] + (x - c[0]) * k + (R() - 0.5) * jit * 2, c[1] + (y - c[1]) * k + (R() - 0.5) * jit * 2]);
}

/* ---------- cells (sizes in sublining units; a lymphocyte is ~8 units across) ---------- */

function lymph(L, [x, y], kind, R, s = 1) {
  const r = vary(R, 3.9, 0.12) * s;
  L.add(kind === "B" ? "bcell" : "tcell", circle(x, y, r));
  L.add(kind === "B" ? "bnuc" : "tnuc", circle(x + (R() - 0.5) * r * 0.28, y + (R() - 0.5) * r * 0.28, r * 0.66));
}
function plasma(L, [x, y], R) {
  const a = R() * 180, ar = a / R2D, rx = vary(R, 6, 0.1), ry = rx * 0.7;
  L.add("plasma", ellipse(x, y, rx, ry, a));
  L.add("plasmaNuc", circle(x + Math.cos(ar) * (rx - 3.9), y + Math.sin(ar) * (rx - 3.9), 2.45));
}
function macro(L, [x, y], R, s = 1) {
  const r = vary(R, 6.4, 0.18) * s, seed = Math.floor(R() * 1e6);
  const pts = armsPts(x, y, r, { arms: 4 + Math.floor(R() * 3), reach: 0.16 + R() * 0.16, width: 0.55, seed, n: 5, rot: R() * 360 });
  L.add("mac", smoothClosed(pts, 0.9));
  const a = R() * Math.PI * 2;
  let nuc = blobPts(x + Math.cos(a) * r * 0.18, y + Math.sin(a) * r * 0.18, r * 0.42, r * 0.3, { n: 8, wobble: 0.12, seed: seed + 1, rot: R() * 180 });
  nuc = fitInside(nuc, pts, 1) ?? nuc;
  L.add("macNuc", smoothClosed(nuc));
}
function neutro(L, [x, y], R, s = 1) {
  L.add("neut", circle(x, y, 5 * s));
  L.add("neutNuc", lobes(x, y, 3.7 * s, R() < 0.5 ? 3 : 4, R() * 360));
}
function mast(L, [x, y], R) {
  const seed = Math.floor(R() * 1e5);
  L.add("mast", blob(x, y, vary(R, 8.5, 0.1), vary(R, 6.6, 0.1), { n: 8, wobble: 0.12, seed, rot: R() * 180 }));
  for (const [gx, gy] of packIn(x, y, 6.2, 4.6, 13, 2.4, { seed })) L.add("mastGran", circle(gx, gy, 0.9));
}

/* ---------- vessels ---------- */

/** A vessel cut across: wall, lumen, RBCs, flat endothelial nuclei at uneven angles, mural nuclei for arterioles. */
function vesselX(L, { cx, cy, rx, ry = rx, rot = 0, kind = "cap", seed = 1 }) {
  const R = rng(seed);
  if (kind === "lymph") {
    L.add("lymphWall", blob(cx, cy, rx, ry, { n: 9, wobble: 0.12, seed, rot }));
    L.add("lymphLumen", blob(cx, cy, rx - 1.6, ry - 1.6, { n: 9, wobble: 0.14, seed: seed + 1, rot }));
    const a = R() * Math.PI * 2;
    L.add("endo", ellipse(cx + Math.cos(a) * (rx - 2.2), cy + Math.sin(a) * (ry - 2.2), 2.2, 0.8, a * R2D + 90));
    return;
  }
  const wall = kind === "art" ? Math.max(3.6, Math.min(rx, ry) * 0.45) : Math.max(1.7, Math.min(rx, ry) * 0.22);
  const outerD = ellipse(cx, cy, rx, ry, rot);
  L.add(kind === "art" ? "artWall" : "wall", outerD);
  const lx = rx - wall, ly = ry - wall;
  const lumenD = ellipse(cx, cy, lx, ly, rot);
  L.add("lumen", lumenD);
  const ir = Math.min(lx, ly);
  const n = kind === "cap" ? 1 : Math.max(1, Math.min(5, Math.round((lx * ly) / 26)));
  const pts = n > 1 ? packIn(cx, cy, lx * 0.5, ly * 0.5, n, Math.min(5.6, ir * 0.8), { seed }) : [[cx + (R() - 0.5), cy + (R() - 0.5)]];
  for (const [x, y] of pts) L.add("rbc", ellipse(x, y, Math.min(3.3, ir * 0.62), Math.min(3.3, ir * 0.62) * 0.78, R() * 180));
  const rr = rot / R2D;
  const angs = unevenSpacing(kind === "cap" ? 2 : 3, 360, R, { cv: 0.4 }).map((a) => a + R() * 360);
  for (const deg of angs) {
    const a = deg / R2D, ex = Math.cos(a) * (lx - 0.8), ey = Math.sin(a) * (ly - 0.8);
    L.add("endo", ellipse(cx + ex * Math.cos(rr) - ey * Math.sin(rr), cy + ex * Math.sin(rr) + ey * Math.cos(rr), 2.2, 0.85, deg + rot + 90));
  }
  if (kind === "art") {
    const m = Math.round((rx + ry) * 0.45);
    for (const deg of unevenSpacing(m, 360, R, { cv: 0.3 })) {
      const a = deg / R2D, mx = Math.cos(a) * (rx - wall / 2), my = Math.sin(a) * (ry - wall / 2);
      L.add("smcNuc", ellipse(cx + mx * Math.cos(rr) - my * Math.sin(rr), cy + mx * Math.sin(rr) + my * Math.cos(rr), 2, 0.7, deg + rot + 90));
    }
  }
}

/** High endothelial venule cut across: plump cuboidal endothelial cells round a small lumen, a lymphocyte crossing the wall. */
function hev(L, cx, cy, rx, ry, rot, R) {
  const rr = rot / R2D;
  const P = (a, k) => {
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    return [cx + x * Math.cos(rr) - y * Math.sin(rr), cy + x * Math.sin(rr) + y * Math.cos(rr)];
  };
  L.add("wall", ellipse(cx, cy, rx + 1.5, ry + 1.5, rot));
  const n = 6 + Math.floor(R() * 2), a0 = R() * Math.PI * 2;
  const b = unevenSpacing(n, Math.PI * 2, R, { cv: 0.22 }).map((a) => a + a0);
  for (let k = 0; k < n; k++) {
    const s = b[k], e = k + 1 < n ? b[k + 1] : b[0] + Math.PI * 2;
    const poly = [];
    for (let i = 0; i <= 4; i++) poly.push(P(s + ((e - s) * i) / 4, 1));
    for (let i = 4; i >= 0; i--) poly.push(P(s + ((e - s) * i) / 4, 0.46));
    const cell = softCell(poly, R, 0.9, 0.15, 10);
    L.add("hevEndo", smoothClosed(cell, 0.9));
    const m = (s + e) / 2;
    let nuc = blobPts(...P(m, 0.66), 1.9, 1.5, { n: 7, wobble: 0.08, seed: Math.floor(R() * 1e5), rot: m * R2D });
    nuc = fitInside(nuc, cell, 0.4) ?? nuc;
    L.add("hevNuc", smoothClosed(nuc));
  }
  L.add("lumen", ellipse(cx, cy, rx * 0.4, ry * 0.4, rot));
  const ta = a0 + 1.3;
  lymph(L, P(ta, 1.02), "T", R, 0.82);
}

/* ===================== synovium ===================== */

const SW = 360, SH = 260, X0 = 8, X1 = 352, YB = 252, YT = 8;
// healthy: a gently folded surface (normal synovium has low folds), one broad fold and one low ridge
const SURF_H = [[X0, 68], [32, 64], [60, 69], [86, 62], [104, 50], [118, 40], [134, 35], [150, 39], [162, 50], [176, 62], [204, 68], [232, 61], [252, 51], [268, 47], [286, 52], [302, 62], [326, 65], [X1, 61]];
const SURF_RA = [
  [X0, 126], [14, 125],
  // villus 1: slimmer and shorter, its head turned slightly left
  [20, 116], [22, 100], [20, 84], [22, 68], [30, 56], [42, 48], [56, 47], [68, 53], [76, 66], [80, 84], [82, 102], [86, 116],
  [96, 125], [108, 128], [120, 127],
  // villus 2: tall and slender, leaning right
  [126, 118], [130, 100], [136, 78], [144, 56], [156, 36], [172, 24], [190, 22], [204, 30], [210, 46], [210, 68], [206, 90], [207, 108], [213, 121],
  [224, 127], [236, 128], [246, 126],
  // villus 3: broad and low, with a bilobed head
  [250, 116], [252, 100], [253, 86], [258, 72], [268, 63], [281, 60], [291, 65], [297, 72], [304, 66], [316, 61], [329, 65], [338, 78], [341, 96], [343, 110], [347, 120], [X1, 124],
];

// collagen bundles (and, in the fibroid type, a few fibroblasts) run up the villus cores
const VILLUS_AXES = [[[52, 150], [51, 118], [50, 90], [49, 66]], [[178, 150], [176, 112], [178, 80], [184, 48]], [[298, 150], [298, 118], [298, 100], [296, 86]]];

/** A slender, gently wavy spindle cell (aspect ~10:1) centred at (cx, cy), long axis at `deg`. Returns {d, nuc}. */
function slender(cx, cy, len, wid, deg, wave = 1, ph = 0) {
  const n = 12, top = [], bot = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = (t - 0.5) * len, hw = (Math.pow(Math.sin(Math.PI * t), 0.8) * wid) / 2, y0 = wave * Math.sin(2 * Math.PI * t + ph);
    top.push([x, y0 - hw]);
    bot.push([x, y0 + hw]);
  }
  const r = deg / R2D, c = Math.cos(r), s = Math.sin(r), T = ([x, y]) => [cx + x * c - y * s, cy + x * s + y * c];
  const pts = [...top, ...bot.reverse().slice(1, -1)].map(T);
  return { d: smoothClosed(pts, 0.8), pts, nuc: T([0, wave * Math.sin(Math.PI + ph)]) };
}
/** A vessel cut lengthwise that leaves the plane of section obliquely at both ends (walls offset, lumen tapering). */
function obliqueVessel(path, wOut, wIn, slant = 5) {
  const pts = resample(path, 1), s = arcLengthsOf(pts), tot = s[s.length - 1], ns = normals(pts);
  const edge = (k, w, a, b) => pts.map((p, i) => (s[i] >= a && s[i] <= b ? [p[0] + (ns[i][0] * k * w(s[i])) / 2, p[1] + (ns[i][1] * k * w(s[i])) / 2] : null)).filter(Boolean);
  const wall = [...edge(1, wOut, 0, tot - slant), ...edge(-1, wOut, slant, tot).reverse()];
  const s0 = slant * 0.8, lw = (x) => wIn(x) * Math.sqrt(Math.max(0, Math.min(1, (x - s0) / 8, (tot - s0 - x) / 8)));
  const lumen = [...edge(1, lw, s0, tot - s0), ...edge(-1, lw, s0, tot - s0).reverse()];
  return { wall, lumen, pts, s, ns, tot, lw };
}

function synLayers(L, matrixFill) {
  // a faint synovial-fluid tint over the joint cavity above the lining (no outline)
  L.def("fluid", { fill: "#fdf6ee", lineWidth: 0 })
    .def("matrix", { fill: matrixFill, stroke: sw(shade(matrixFill, 0.1), 1), lineWidth: 1.2 })
    .def("fat", { fill: C.fat, stroke: sw(C.fatBorder, 1.3), lineWidth: 1 })
    .def("fatNuc", { fill: C.fatNuc, lineWidth: 0.5 })
    .def("collagen", { fill: "none", stroke: { color: C.collagen, width: 1.25, cap: "round" }, lineColor: "#dca5a8", lineStrokeWidth: 0.8 })
    .def("lymphWall", { fill: C.lymph, stroke: sw(shade(C.lymph, 0.2), 0.8), lineWidth: 0.9 })
    .def("lymphLumen", { fill: C.lymphLumen, lineWidth: 0.5 })
    .def("artWall", { fill: C.artWall, stroke: sw(shade(C.artWall, 0.16)), shade: "small", lineWidth: 1 })
    .def("wall", { fill: C.wall, stroke: sw(shade(C.wall, 0.16)), shade: "small", lineWidth: 0.9 })
    .def("lumen", { fill: C.lumen, lineWidth: 0.5 })
    .def("rbc", { fill: C.rbc, shade: "small", lineWidth: 0.5 })
    .def("endo", { fill: C.endo, lineWidth: 0.4 })
    .def("smcNuc", { fill: "#86589f", lineWidth: 0.35 })
    .def("hevEndo", { fill: "#f7bcbf", stroke: sw(shade("#f7bcbf", 0.16), 0.5), shade: "small", lineWidth: 0.5 })
    .def("hevNuc", { fill: C.endo, lineWidth: 0.35 })
    .def("fibro", { fill: C.fibro, stroke: sw(shade(C.fibro, 0.14), 0.7), shade: "small", lineWidth: 0.8 })
    .def("fibroNuc", { fill: C.nucleus, lineWidth: 0.5 })
    .def("gc", { fill: C.gc, opacity: 0.95, lineWidth: 0.8, line: true })
    .def("bcell", { fill: C.bcell, shade: "small", lineWidth: 0.6 })
    .def("bnuc", { fill: C.bnuc, lineWidth: 0.4 })
    .def("tcell", { fill: C.tcell, shade: "small", lineWidth: 0.6 })
    .def("tnuc", { fill: C.tnuc, lineWidth: 0.4 })
    .def("plasma", { fill: C.plasma, shade: "small", lineWidth: 0.6 })
    .def("plasmaNuc", { fill: C.plasmaNuc, lineWidth: 0.4 })
    .def("mac", { fill: C.mac, stroke: sw(shade(C.mac, 0.14), 0.6), shade: "small", lineWidth: 0.7 })
    .def("macNuc", { fill: C.macNuc, lineWidth: 0.4 })
    .def("mast", { fill: C.mast, shade: "small", lineWidth: 0.7 })
    .def("mastGran", { fill: C.mastGran, lineWidth: 0.3 })
    .def("fls", { fill: C.fls, stroke: sw(shade(C.fls, 0.16)), lineWidth: 0.75 })
    .def("mls", { fill: C.mls, stroke: sw(shade(C.mls, 0.16)), lineWidth: 0.75 })
    .def("liningNuc", { fill: C.nucleus, shade: "small", lineWidth: 0.45 })
    .def("fibrin", { fill: C.fibrin, stroke: sw(shade(C.fibrin, 0.14), 0.8), shade: "small", lineWidth: 0.9 })
    .def("neut", { fill: C.neut, shade: "small", lineWidth: 0.6 })
    .def("neutNuc", { fill: C.neutNuc, lineWidth: 0.4 });
}

function synovium({ ra = false, pathotype = "lympho-myeloid", seed = 11 } = {}) {
  const R = rng(seed);
  const L = new Layers();
  const LM = ra && pathotype === "lympho-myeloid", DM = ra && pathotype === "diffuse-myeloid", PI = ra && pathotype === "pauci-immune";
  synLayers(L, !ra ? C.matrix : PI ? C.matrixFib : C.matrixRA);

  const surface = resample(catmull(ra ? SURF_RA : SURF_H, 12), 1.5);
  const ns = normals(surface);
  L.add("fluid", polyD([[X0, YT], [X1, YT], ...surface.slice().reverse()]));
  L.add("matrix", polyD([...surface, [X1, YB], [X0, YB]]));

  // lining: 1–2 loose cells when healthy; hyperplastic in RA (thicker over villus tips)
  const rows = !ra ? 2 : PI ? 3 : 4;
  const T = (u) => (!ra ? 11 + 3 * Math.sin(u * 23 + 1) : (PI ? 16 : 22) + 3 * Math.sin(u * 17 + 2) * Math.sin(u * 5));
  const lining = cellBand(surface, { rows, thickness: T, cellLen: ra ? 6.8 : 12.5, jitter: 0.38, seed, nucleus: 0.3 });
  const deep = surface.map((p, i) => {
    const t = T(i / (surface.length - 1)) + 2.5;
    return [p[0] + ns[i][0] * t, p[1] + ns[i][1] * t];
  });
  const stroma = [...deep, [X1, YB], [X0, YB]];
  const fatTop = (x) => (PI ? 230 : 196) + 8 * Math.sin(x / 37) + 5 * Math.sin(x / 13);
  const hasFat = !ra || PI;
  const inStroma = (p, m = 0) =>
    inside(stroma, p) && p[0] > X0 + m && p[0] < X1 - m && p[1] < YB - m &&
    Math.min(...deep.map((q) => dist(q, p))) > m && (!hasFat || p[1] < fatTop(p[0]) - m - 3);
  const fits = (d, m = 1) => checkInside(d, stroma, m).ok && checkInside(d, rectPoly(X0 + 2, 0, X1 - X0 - 4, YB - 2), 0).ok;

  const busy = [];
  const free = (p, r) => busy.every(([x, y, rr]) => Math.hypot(x - p[0], y - p[1]) > r + rr);
  const box = { x: X0, y: 20, w: X1 - X0, h: YB - 20 };
  // healthy: a capillary running in the plane of the section just under the lining, leaving the plane obliquely
  // at both ends; its room is reserved before the other vessels are placed
  const capL = !ra ? obliqueVessel(catmull([[174, 97], [194, 101], [216, 102], [240, 97]], 8), () => 9.4, () => 6, 5) : null;
  if (capL) for (const p of capL.pts.filter((_, i) => i % 6 === 0)) busy.push([p[0], p[1], 8.5]);

  // --- adipose lobule at the base (healthy; a remnant under the fibrosis in the fibroid type) ---
  if (hasFat) {
    for (const c of honeycomb(X0, PI ? 214 : 182, SW, 90, PI ? 9.5 : 11.5, { seed: seed + 5, jitter: 0.3 })) {
      if (c.poly.some(([x, y]) => y < fatTop(x) - 3)) continue;
      const poly = clipConvex(c.poly, rectPoly(X0, 0, X1 - X0, YB));
      if (poly.length < 3 || area(poly) < 30) continue;
      L.add("fat", roundPoly(poly, 3));
      const ctr = centroid(poly);
      if (R() < 0.3 && area(poly) > 120) {
        const v = poly[Math.floor(R() * poly.length)], a = Math.atan2(v[1] - ctr[1], v[0] - ctr[0]);
        L.add("fatNuc", ellipse(ctr[0] + (v[0] - ctr[0]) * 0.7, ctr[1] + (v[1] - ctr[1]) * 0.7, 3.2, 1.3, a * R2D + 90));
      }
    }
  }

  // --- vessels: capillaries hug the lining; venules, an arteriole and a lymphatic deeper ---
  const vessels = [];
  const tryVessel = (v) => {
    const d = ellipse(v.cx, v.cy, v.rx, v.ry ?? v.rx, v.rot || 0);
    if (!fits(d, 2) || !free([v.cx, v.cy], Math.max(v.rx, v.ry ?? v.rx) + 2)) return false;
    vessels.push(v);
    busy.push([v.cx, v.cy, Math.max(v.rx, v.ry ?? v.rx) + 3]);
    return true;
  };
  // subsynovial capillaries: just beneath the lining, unevenly spaced along the surface
  const capDepth = (!ra ? 15 : PI ? 22 : 27);
  const nCap = !ra ? 7 : PI ? 5 : 11;
  for (const s of unevenSpacing(nCap, surface.length - 1, R, { cv: 0.45 })) {
    const i = Math.round(s), d = T(i / (surface.length - 1)) + capDepth - T(0.5) + R() * 6;
    const p = [surface[i][0] + ns[i][0] * d, surface[i][1] + ns[i][1] * d];
    const rx = vary(R, ra && !PI ? 5.2 : 4.4, 0.2);
    tryVessel({ cx: p[0], cy: p[1], rx, ry: rx * vary(R, 0.85, 0.12), rot: R() * 180, kind: ra && !PI && R() < 0.4 ? "ven" : "cap" });
  }
  const deepV = !ra
    ? [{ cx: 214, cy: 160, rx: 17, ry: 10, rot: -8, kind: "ven" }, { cx: 98, cy: 160, rx: 11.5, kind: "art" }, { cx: 300, cy: 146, rx: 13, ry: 7.5, rot: 14, kind: "lymph" }, { cx: 150, cy: 128, rx: 6.5, ry: 5, rot: 20, kind: "ven" }]
    : LM
      ? [{ cx: 136, cy: 214, rx: 9.5, ry: 7, rot: 25, kind: "ven" }, { cx: 300, cy: 202, rx: 8.5, ry: 6.5, rot: -10, kind: "ven" }, { cx: 42, cy: 212, rx: 10, kind: "art" }, { cx: 82, cy: 166, rx: 10, ry: 6.5, rot: 10, kind: "ven" }, { cx: 336, cy: 236, rx: 9, ry: 5.5, kind: "lymph" }, { cx: 238, cy: 160, rx: 7, ry: 5.5, kind: "ven" }]
      : DM
        ? [{ cx: 132, cy: 196, rx: 13, ry: 8.5, rot: 18, kind: "ven" }, { cx: 254, cy: 214, rx: 11, ry: 7.5, rot: -12, kind: "ven" }, { cx: 52, cy: 222, rx: 10, kind: "art" }, { cx: 318, cy: 170, rx: 8, ry: 6, kind: "ven" }, { cx: 196, cy: 164, rx: 7, ry: 5, kind: "ven" }, { cx: 330, cy: 236, rx: 9, ry: 5.5, kind: "lymph" }]
        : [{ cx: 120, cy: 196, rx: 9, ry: 6.5, rot: 12, kind: "ven" }, { cx: 262, cy: 206, rx: 9.5, kind: "art" }];
  for (const v of deepV) tryVessel(v);
  if (capL) {
    L.add("wall", polyD(capL.wall));
    L.add("lumen", polyD(capL.lumen));
    const { pts, s, ns, tot, lw } = capL;
    const iAt = (x) => s.findIndex((v) => v >= x);
    // red cells in single file, flat endothelial nuclei lying against the inner wall on alternate sides
    for (const x of [tot * 0.27, tot * 0.5, tot * 0.74]) {
      const i = iAt(x), a = Math.atan2(ns[i][1], ns[i][0]) * R2D;
      L.add("rbc", ellipse(pts[i][0], pts[i][1], 2.2, 1.6, a));
    }
    [[tot * 0.17, 1], [tot * 0.62, -1], [tot * 0.88, 1]].forEach(([x, k]) => {
      const i = iAt(x), o = k * (lw(x) / 2 - 0.55), a = Math.atan2(ns[i][1], ns[i][0]) * R2D + 90;
      L.add("endo", ellipse(pts[i][0] + ns[i][0] * o, pts[i][1] + ns[i][1] * o, 2.3, 0.55, a));
    });
  }
  vessels.forEach((v, i) => vesselX(L, { ...v, seed: seed + 31 * i + 3 }));

  // --- lymphoid aggregates (lympho-myeloid): perivascular, B-cell follicle with a GC, T zone outside ---
  if (LM) {
    const bbox = (poly) => {
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    // An irregular aggregate, not a target: the B follicle sits off-centre (toward the lining), its germinal
    // centre is polarised (eccentric, toward the deep pole), the T zone is broader on the deep side and
    // frays into the stroma; HEVs sit in the T zone. Cells are packed by random sequential adsorption, so
    // there are no lattice rows.
    const aggPoly = blobPts(184, 201, 77, 47, { n: 13, wobble: 0.13, seed: seed + 2, rot: -8 });
    const fol = blobPts(174, 192, 35, 26, { n: 10, wobble: 0.09, seed: seed + 5, rot: 14 }); // B-cell follicle
    const gcPoly = blobPts(167, 197, 16, 12, { n: 9, wobble: 0.11, seed: seed + 3, rot: 20 }); // germinal centre
    L.add("gc", smoothClosed(gcPoly));
    // HEVs in the T zone (plump endothelium, a lymphocyte crossing the wall)
    for (const [hx, hy, hr, ha] of [[224, 206, 6.2, 20], [194, 229, 5.4, -30]]) {
      hev(L, hx, hy, hr, hr * 0.78, ha, R);
      busy.push([hx, hy, hr + 2.5]);
    }
    const tooClose = (q, r) => busy.some(([x, y, rr]) => Math.hypot(x - q[0], y - q[1]) < rr + r);
    // germinal centre: larger centroblasts/centrocytes sitting loosely on the pale GC zone
    for (const p of packWhere(bbox(gcPoly), 16, 7.4, (q) => checkInside([q], gcPoly, 3.6).ok, { seed: seed + 4 })) lymph(L, p, "B", R, 1.1);
    // mantle zone: densely packed small B cells round the GC, thickest over the lining-facing pole
    for (const p of warpFill(bbox(fol), 6.9, R, (q) => checkInside([q], fol, 2.8).ok && !checkInside([q], gcPoly, -2.6).ok)) lymph(L, p, R() < 0.94 ? "B" : "T", R, 0.88);
    // T-cell zone: dense next to the follicle, thinning toward the aggregate edge
    const tz = warpFill(bbox(aggPoly), 7.2, R,
      (q) => checkInside([q], aggPoly, 3.4).ok && !checkInside([q], fol, -3.8).ok && inStroma(q, 4) && !tooClose(q, 4));
    for (const p of tz) {
      // density falls off toward the aggregate border: keep fewer cells near the edge
      if (!checkInside([p], aggPoly, 8).ok && R() < 0.35) continue;
      lymph(L, p, R() < 0.9 ? "T" : "B", R, 0.92);
    }
    // stragglers: small T-cell clusters leaving the aggregate into the stroma
    for (const p of clustered(R, { x: 100, y: 140, w: 170, h: 110 }, 22, { clusters: 5, spread: 0.15, minDist: 8.4, test: (q) => !checkInside([q], aggPoly, -4).ok && inStroma(q, 5) && free(q, 4) })) lymph(L, p, "T", R, 0.92);
    busy.push([184, 200, 70]);
    // perivascular lymphocyte cuff round a venule (no germinal centre): a lopsided mantle, denser on one side
    const cuff = [300, 202];
    for (const p of warpFill({ x: cuff[0] - 32, y: cuff[1] - 26, w: 64, h: 52 }, 7.3, R, (q) => {
      const a = Math.atan2(q[1] - cuff[1], q[0] - cuff[0]);
      const reach = 1 - 0.34 * (0.5 + 0.5 * Math.cos(a - 2.4));
      return Math.hypot((q[0] - cuff[0]) / 27, (q[1] - cuff[1]) / 21) < reach && dist(q, cuff) > 12.5 && inStroma(q, 4);
    })) if (R() > 0.12) lymph(L, p, R() < 0.7 ? "T" : "B", R, 0.92);
    busy.push([cuff[0], cuff[1], 26]);
  }

  // --- collagen: long bundles of 2–3 strands that follow the surface, the villus axes and the vessels ---
  const bundle = (base, { strands = 2, gap = 2.3, amp = 1.2, waves = 3 }) => {
    const len = base.length;
    for (let k = 0; k < strands; k++) {
      const off = offsetOpen(base, (k - (strands - 1) / 2) * gap + (R() - 0.5) * 0.8);
      const ph = R() * 6;
      const wob = off.map((p, i) => {
        const w = Math.sin((i / len) * waves * Math.PI * 2 + ph) * amp;
        return [p[0], p[1] + w];
      });
      for (const r of runs(wob, (p) => inStroma(p, 2.5) && free(p, 0), 6)) L.add("collagen", smoothOpen(r.filter((_, i) => i % 3 === 0 || i === r.length - 1)));
    }
  };
  // sublining bundles run roughly parallel to the surface, at uneven depths, gently undulating
  const bundleLines = [];
  const nB = !ra ? 6 : PI ? 13 : 5;
  const yTop = ra ? 146 : 108, yBot = hasFat ? (PI ? 222 : 184) : 242;
  for (const y0 of unevenSpacing(nB, yBot - yTop, R, { cv: 0.35 }).map((v) => v + yTop)) {
    const x0 = X0 - 10 + R() * (PI ? 70 : 170), len = (PI ? 190 : 90) + R() * (PI ? 150 : 110);
    const tilt = (R() - 0.5) * (PI ? 0.12 : 0.4), ph = R() * 6, amp = PI ? 3 : 5;
    const pts = [];
    for (let x = x0; x <= Math.min(X1 + 8, x0 + len); x += 1.5) pts.push([x, y0 + (x - x0) * tilt + amp * Math.sin(x / 41 + ph)]);
    bundleLines.push(pts);
    bundle(pts, { strands: PI ? 3 : 2, gap: PI ? 2.2 : 2.6, amp: PI ? 0.7 : 1.4, waves: PI ? 5 : 4 });
  }
  if (ra) {
    // bundles running up the villus cores
    for (const axis of VILLUS_AXES) {
      const pts = resample(catmull(axis, 8), 1.5);
      bundleLines.push(pts);
      bundle(pts, { strands: PI ? 3 : 2, gap: 2.4, amp: 0.8, waves: 3 });
    }
  }

  // --- fibroblasts: spindles lying along the bundles (aligned with them in the fibroid type) ---
  const nFb = !ra ? 9 : PI ? 26 : LM ? 6 : 7;
  let made = 0;
  // fibroid type: slender cells strung along the sublining bundles (angle within ±15° of the bundle), plus one or
  // two off-centre cells in each villus core
  const along = (line, off) => {
    const i = 2 + Math.floor(R() * (line.length - 4));
    const a = Math.atan2(line[i + 1][1] - line[i - 1][1], line[i + 1][0] - line[i - 1][0]);
    const o = off();
    return [line[i][0] - Math.sin(a) * o, line[i][1] + Math.cos(a) * o, a * R2D + (R() - 0.5) * 30];
  };
  const fbSpots = PI
    ? [
        ...bundleLines.slice(nB).flatMap((line) => Array.from({ length: 6 }, () => along(line.slice(Math.floor(line.length * 0.25)), () => (R() < 0.5 ? -1 : 1) * (4.5 + R() * 4)))),
        ...Array.from({ length: nFb * 6 }, () => along(bundleLines[Math.floor(R() * nB)], () => (R() - 0.5) * 8)),
      ]
    : packWhere(box, nFb * 3, 26, (q) => inStroma(q, 10) && free(q, 9), { seed: seed + 13 }).map((p) => [p[0], p[1], -35 + R() * 70]);
  for (const [px, py, a] of fbSpots) {
    const p = [px, py];
    if (made >= nFb || !inStroma(p, 9) || !free(p, 9)) continue;
    const len = PI ? vary(R, 35, 0.25) : vary(R, 32, 0.2), wid = PI ? vary(R, 3.5, 0.12) : vary(R, 6.4, 0.15);
    const sl = PI ? slender(p[0], p[1], len, wid, a, 0.5 + R() * 0.9, R() * 6) : null;
    const d = sl ? sl.d : spindle(p[0], p[1], len, wid, a, { bend: (R() - 0.5) * 0.5 });
    // keep spindles from stacking end-to-end: test the whole cell axis, not just its centre
    const ax = Math.cos(a / R2D) * len * 0.36, ay = Math.sin(a / R2D) * len * 0.36;
    if (!free([p[0] + ax, p[1] + ay], 5) || !free([p[0] - ax, p[1] - ay], 5)) continue;
    if (!fits(d, 1.5)) continue;
    L.add("fibro", d);
    L.add("fibroNuc", sl ? ellipse(sl.nuc[0], sl.nuc[1], vary(R, 3.8, 0.12), 0.95, a) : ellipse(p[0], p[1], vary(R, 4.4, 0.12), 1.9, a));
    busy.push([p[0], p[1], 9], [p[0] + ax, p[1] + ay, 6], [p[0] - ax, p[1] - ay, 6]);
    made++;
  }

  // --- scattered immune cells ---
  const counts = !ra ? { mac: 3, T: 0, B: 0, plasma: 0, mast: 1 }
    : LM ? { mac: 10, T: 8, B: 0, plasma: 16, mast: 1 }
    : DM ? { mac: 54, T: 14, B: 2, plasma: 6, mast: 2 }
    : { mac: 3, T: 3, B: 0, plasma: 1, mast: 1 };
  if (DM) {
    // sheets of sublining macrophages, densest under the lining and round vessels
    for (const p of clustered(R, box, counts.mac, { clusters: 7, spread: 0.2, minDist: 13.5, test: (q) => inStroma(q, 8) && free(q, 7) })) {
      macro(L, p, R);
      busy.push([p[0], p[1], 7.5]);
    }
  } else {
    for (const p of packWhere(box, counts.mac, 24, (q) => inStroma(q, 8) && free(q, 8), { seed: seed + 17 })) {
      macro(L, p, R);
      busy.push([p[0], p[1], 7.5]);
    }
  }
  const plasmaPts = LM
    ? clustered(R, box, counts.plasma, { clusters: 4, spread: 0.12, minDist: 13, test: (q) => inStroma(q, 7) && free(q, 7) })
    : packWhere(box, counts.plasma, 18, (q) => inStroma(q, 7) && free(q, 7), { seed: seed + 19 });
  for (const p of plasmaPts) {
    plasma(L, p, R);
    busy.push([p[0], p[1], 6.5]);
  }
  for (const p of packWhere(box, counts.T, 16, (q) => inStroma(q, 6) && free(q, 5), { seed: seed + 23 })) {
    lymph(L, p, "T", R);
    busy.push([p[0], p[1], 4.5]);
  }
  for (const p of packWhere(box, counts.B, 16, (q) => inStroma(q, 6) && free(q, 5), { seed: seed + 25 })) {
    lymph(L, p, "B", R);
    busy.push([p[0], p[1], 4.5]);
  }
  for (const p of packWhere(box, counts.mast, 40, (q) => inStroma(q, 11) && free(q, 10), { seed: seed + 29 })) {
    mast(L, p, R);
    busy.push([p[0], p[1], 9]);
  }

  // --- lining cells: loosely packed, MLS commoner in the superficial rows (and in RA) ---
  const pMLS = (row) => (!ra ? 0.36 : DM ? [0.62, 0.5, 0.38, 0.3][row] : PI ? [0.4, 0.3, 0.2][row] : [0.55, 0.42, 0.3, 0.22][row]);
  // cells are soft, unevenly sized rounded shapes (not epithelial bricks); the healthy lining is loose,
  // with gaps in the second row
  // RA: palisading cells (FLS taller than wide, MLS rounder), nuclei long axis perpendicular to the surface; a
  // ragged basal edge with some cells trailing into the sublining (no basement membrane)
  const meanOf = (pts) => pts.reduce((m, p) => [m[0] + p[0] / pts.length, m[1] + p[1] / pts.length], [0, 0]);
  const drawLining = (cpoly, row, i, c, trailing = false) => {
    const isM = R() < pMLS(Math.min(row, rows - 1)) * (trailing ? 0.8 : 1);
    const n2 = cpoly.length / 2, topM = meanOf(cpoly.slice(0, n2)), botM = meanOf(cpoly.slice(n2));
    const th = dist(topM, botM) || 1, nu = [(botM[0] - topM[0]) / th, (botM[1] - topM[1]) / th];
    const k = !ra ? vary(R, 0.84, 0.07) : vary(R, 0.9, 0.05);
    let poly = softCell(cpoly, R, k, !ra ? 0.55 : 0.38, 10);
    const ctr = centroid(poly);
    if (ra && isM) {
      const rm = poly.reduce((acc, p) => acc + dist(p, ctr), 0) / poly.length;
      poly = poly.map((p) => {
        const d = dist(p, ctr) || 1, g = 0.45 + (0.55 * rm) / d;
        return [ctr[0] + (p[0] - ctr[0]) * g, ctr[1] + (p[1] - ctr[1]) * g];
      });
    } else if (ra) {
      poly = poly.map((p) => {
        const dx = p[0] - ctr[0], dy = p[1] - ctr[1], al = dx * nu[0] + dy * nu[1], ac = -dx * nu[1] + dy * nu[0];
        return [ctr[0] + nu[0] * al * 1.06 - nu[1] * ac * 0.8, ctr[1] + nu[1] * al * 1.06 + nu[0] * ac * 0.8];
      });
    }
    L.add(isM ? "mls" : "fls", smoothClosed(poly, 0.85));
    let nuc;
    if (ra) nuc = blobPts(ctr[0] + (R() - 0.5) * 0.8, ctr[1] + (R() - 0.5) * 0.8, isM ? 1.6 : Math.min(2.3, th * 0.4), isM ? 1.35 : 1.1, { n: 8, wobble: 0.08, seed: seed + i, rot: Math.atan2(nu[1], nu[0]) * R2D });
    else {
      const n = c.nucleus;
      nuc = blobPts(n.cx + (R() - 0.5) * 1.2, n.cy + (R() - 0.5) * 1.2, isM ? n.rx * 0.8 : n.rx, isM ? n.rx * 0.68 : n.ry, { n: 8, wobble: 0.08, seed: seed + i, rot: n.rot });
    }
    nuc = fitInside(nuc, poly, 0.7) ?? nuc;
    L.add("liningNuc", smoothClosed(nuc));
    return { nu, th };
  };
  for (const c of lining) {
    if (!ra && R() < (c.row === 0 ? 0.06 : 0.36)) continue;
    const deepest = c.row === rows - 1;
    if (ra && deepest && R() < 0.28) continue;
    const { nu, th } = drawLining(c.poly, c.row, c.i, c);
    if (ra && deepest && R() < 0.26) {
      const shift = th + 0.8 + R() * 1.6, side = (R() - 0.5) * 4;
      const tp = c.poly.map(([x, y]) => [x + nu[0] * shift - nu[1] * side, y + nu[1] * shift + nu[0] * side]);
      const tc = centroid(tp);
      if (inStroma(tc, 0.5) && free(tc, 4.5) && fits(polyD(tp), 0.5)) {
        drawLining(tp, rows, c.i + 5000, c, true);
        busy.push([tc[0], tc[1], 5]);
      }
    }
  }

  // --- RA (not fibroid): fibrin on the surface, neutrophils in the synovial fluid ---
  if (ra && !PI) {
    for (const [x, y, rx, ry, rot] of [[108, 126, 12, 6, 4], [235, 126, 11, 5.5, -6]]) {
      L.add("fibrin", blob(x, y, rx, ry, { n: 9, wobble: 0.24, seed: seed + Math.round(x), rot }));
    }
    // neutrophils trapped in the fibrin and adhering to the surface
    for (const p of [[102, 125], [114, 126], [230, 125], [241, 125]]) neutro(L, p, R, 0.82);
    for (const u of [0.07, 0.33, 0.61, 0.9]) {
      const i = Math.round(u * (surface.length - 1));
      neutro(L, [surface[i][0] - ns[i][0] * 5.4, surface[i][1] - ns[i][1] * 5.4], R, 0.82);
    }
  }
  return clampScene({ size: [SW, SH], lineWidth: 1.4, parts: L.parts() }, [X0, 0, X1, YB]);
}

/* ---------- raster field → smooth outline (for masses built as unions of discs) ---------- */

/** Separable box blur of a row-major nx × ny field, radius r cells. */
function boxBlur(val, nx, ny, r) {
  const tmp = new Float32Array(nx * ny), out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0, c = 0;
    for (let k = -r; k <= r; k++) if (i + k >= 0 && i + k < nx) { s += val[j * nx + i + k]; c++; }
    tmp[j * nx + i] = s / c;
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0, c = 0;
    for (let k = -r; k <= r; k++) if (j + k >= 0 && j + k < ny) { s += tmp[(j + k) * nx + i]; c++; }
    out[j * nx + i] = s / c;
  }
  return out;
}

/** Marching squares: closed iso-lines at `lev` of a field whose border lies below `lev`. */
function contourLoops(val, nx, ny, x0, y0, h, lev = 0.5) {
  const V = (i, j) => val[j * nx + i];
  const pt = new Map(), adj = new Map();
  const edge = (t, i, j) => {
    const k = `${t}${i},${j}`;
    if (!pt.has(k)) {
      const [i2, j2] = t === "h" ? [i + 1, j] : [i, j + 1];
      const a = V(i, j), b = V(i2, j2), u = (lev - a) / (b - a || 1e-9);
      pt.set(k, [x0 + (i + (i2 - i) * u) * h, y0 + (j + (j2 - j) * u) * h]);
    }
    return k;
  };
  const link = (a, b) => {
    for (const [p, q] of [[a, b], [b, a]]) {
      if (!adj.has(p)) adj.set(p, []);
      adj.get(p).push(q);
    }
  };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = V(i, j) >= lev, b = V(i + 1, j) >= lev, c = V(i + 1, j + 1) >= lev, d = V(i, j + 1) >= lev;
    const e = [];
    if (a !== b) e.push(edge("h", i, j));
    if (b !== c) e.push(edge("v", i + 1, j));
    if (c !== d) e.push(edge("h", i, j + 1));
    if (d !== a) e.push(edge("v", i, j));
    if (e.length === 2) link(e[0], e[1]);
    else if (e.length === 4) {
      const mid = (V(i, j) + V(i + 1, j) + V(i + 1, j + 1) + V(i, j + 1)) / 4 >= lev;
      if (mid === a) { link(e[0], e[1]); link(e[2], e[3]); } else { link(e[0], e[3]); link(e[1], e[2]); }
    }
  }
  const seen = new Set(), loops = [];
  for (const k0 of adj.keys()) {
    if (seen.has(k0)) continue;
    const loop = [];
    let cur = k0;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(pt.get(cur));
      cur = adj.get(cur).find((k) => !seen.has(k));
    }
    if (loop.length > 8) loops.push(loop);
  }
  return loops;
}

/* ===================== knee joint (coronal section) ===================== */

const J = {
  cortex: "#ead09a", cancellous: "#f6e5bc", cancRA: "#f8ecd2", pore: "#dcbd80", marrow: "#f1d496", physis: "#e3c68b",
  cart: "#cfe6f3", chondro: "#9ec5dd", meniscus: "#a9c3d8", ligament: "#efdccb",
  capsule: "#cdbddb", synovium: "#f2a5b1", synoviumRA: "#d95d6c", pannus: "#c94d62", fluid: "#fdf2cf", fluidRA: "#fbe3ab",
  sclerosis: "#bf934f", cyst: "#fbf0d8", fluidCell: "#f6d3df",
};

const FEMUR_KEY = [
  [118, -6], [118, 58], [116, 82], [109, 104], [95, 122], [79, 136], [68, 150], [61, 165], [58, 181], [60, 196], [68, 207], [82, 214], [100, 217], [116, 214], [127, 207],
  [133, 196], [137, 184], [143, 176], [150, 174], [157, 176], [163, 184], [167, 196],
  [173, 207], [184, 214], [200, 217], [218, 214], [232, 207], [240, 196], [242, 181], [239, 165], [232, 150], [221, 136], [205, 122], [191, 104], [184, 82], [182, 58], [182, -6],
];
const tibiaKey = (dzM, dzL) => [
  [60, 232], [63, 224 - dzM], [80, 221 - dzM], [100, 221 - dzM], [118, 222 - dzM], [128, 220], [135, 212], [140, 206], [145, 213], [150, 216], [155, 213], [160, 206], [165, 212], [172, 220],
  [182, 222 - dzL], [200, 221 - dzL], [220, 221 - dzL], [237, 224 - dzL], [241, 232], [242, 244], [237, 256], [225, 270], [210, 284], [198, 300], [192, 320], [190, 352],
  [110, 352], [108, 320], [102, 300], [90, 284], [75, 270], [63, 256], [58, 244],
];
const FIBULA_KEY = [[241, 263], [249, 254], [262, 249], [272, 243], [279, 251], [281, 265], [275, 280], [270, 294], [268, 352], [246, 352], [246, 298], [241, 284], [237, 272]];

function joint(state = "healthy", seed = 31) {
  const R = rng(seed);
  const ra = state === "ra", oa = state === "oa";
  const L = new Layers();
  const s2 = (c, w = 1, a = 0.18) => ({ color: shade(c, a), width: w });
  const synCol = ra ? J.synoviumRA : J.synovium;
  L.def("fluid", { fill: ra ? J.fluidRA : J.fluid, lineWidth: 0.8 })
    .def("fluidCells", { fill: J.fluidCell, shade: "small", lineWidth: 0.4 })
    .def("synovium", { fill: synCol, stroke: s2(synCol, 0.7), ...(ra ? {} : { shade: "rim" }), lineWidth: 1, unite: [] })
    .def("capsule", { fill: J.capsule, stroke: s2(J.capsule, 0.9), shade: "rim", lineWidth: 1.3 })
    .def("fibula", { fill: J.cortex, stroke: s2(J.cortex, 1.1), shade: "rim", lineWidth: 1.4 })
    .def("cortex", { fill: J.cortex, stroke: s2(J.cortex, 1.2), shade: "rim", lineWidth: 1.5 })
    .def("cortexT", { fill: J.cortex, stroke: s2(J.cortex, 1.2), shade: "rim", lineWidth: 1.5 })
    .def("cancellous", { fill: ra ? J.cancRA : J.cancellous, lineWidth: 0.6 })
    .def("sclerosis", { fill: J.sclerosis, opacity: 0.95, lineWidth: 0.5, line: false })
    .def("pore", { fill: J.pore, lineWidth: 0.35 })
    .def("physis", { fill: "none", stroke: { color: J.physis, width: 1.6, cap: "round" }, lineColor: "#cfb176", lineStrokeWidth: 0.8 })
    .def("cyst", { fill: J.cyst, stroke: s2(J.pore, 0.8), lineWidth: 0.7 })
    // cruciates: PCL behind, ACL in front (frontal view); each a band united with its two bony footprints
    .def("pcl", { fill: J.ligament, stroke: s2(J.ligament, 0.7), shade: "rim", lineWidth: 1 })
    .def("pclFibre", { fill: "none", stroke: { color: shade(J.ligament, 0.1), width: 0.7, cap: "round" }, lineColor: shade(J.ligament, 0.32), lineStrokeWidth: 0.5 })
    .def("acl", { fill: J.ligament, stroke: s2(J.ligament, 0.7), shade: "rim", lineWidth: 1 })
    .def("aclFibre", { fill: "none", stroke: { color: shade(J.ligament, 0.1), width: 0.7, cap: "round" }, lineColor: shade(J.ligament, 0.32), lineStrokeWidth: 0.5 })
    .def("cart", { fill: J.cart, stroke: s2(J.cart, 0.9), shade: "rim", lineWidth: 1.1 })
    .def("chondro", { fill: J.chondro, lineWidth: 0.3 })
    // pannus: one lumpy mass per joint margin, rim shading only in soft (no stroke), outlined in line style
    .def("pannus", { fill: J.pannus, lineWidth: 1, ...(ra ? { unite: [] } : {}) })
    // the pannus is vascular granulation tissue: small vessel profiles inside the mass
    .def("panWall", { fill: "#e7949d", lineWidth: 0.45 })
    .def("panLumen", { fill: "#fbe4e2", lineWidth: 0.3 })
    .def("panRbc", { fill: "#d9434b", lineWidth: 0.3 })
    .def("meniscus", { fill: J.meniscus, stroke: s2(J.meniscus, 0.9), shade: "small", lineWidth: 1.1 })
    .def("tear", { fill: oa ? J.fluid : J.fluid, lineWidth: 0.4 })
    .def("collateral", { fill: J.ligament, stroke: s2(J.ligament, 0.8), shade: "rim", lineWidth: 1.1 });

  /* --- bone outlines --- */
  const femurLine = catmull(FEMUR_KEY, 8);
  const femur = [...femurLine, [182, -8], [118, -8]];
  // joint-space narrowing: OA medial compartment, RA both compartments
  const tibia = catmull(tibiaKey(oa ? 4.5 : ra ? 2.2 : 0, ra ? 2.2 : 0.6 * (oa ? 1 : 0)), 8, true);
  const fibula = catmull(FIBULA_KEY, 6, true);
  const femBottom = (x) => yAt(femurLine, x, Math.max);
  const tibTop = (x) => yAt(tibia, x, Math.min, true);

  /* --- capsule, synovial membrane, synovial fluid (effusion distends the capsule in RA) --- */
  // the capsule is tied to the outer rim of each meniscus (a waist at the joint line) and bulges into
  // supra- and inframeniscal recesses; an effusion distends it (RA), an extruded meniscus pushes it out (OA)
  const bM = ra ? 19 : oa ? 15 : 0, bL = ra ? 19 : oa ? 8 : 0, ex = oa ? 7 : 0;
  // RA: the effusion also distends the upper and lower recesses over the bare areas, where the pannus grows
  const dU = ra ? 9 : 0, dL = ra ? 8 : 0;
  const capKey = [
    [86, 140], [64 - dU * 0.4, 150], [50 - dU, 166], [45 - bM * 0.8, 186], [46 - bM, 204], [52 - bM * 0.5 - ex, 220], [51 - bM * 0.4 - ex * 0.6 - dL, 234], [55 - dL * 0.9, 246], [68 - dL * 0.3, 251],
    [100, 254], [150, 256], [200, 254],
    [232 + dL * 0.3, 251], [245 + dL * 0.9, 246], [249 + bL * 0.4 + dL, 234], [248 + bL * 0.5, 220], [254 + bL, 204], [255 + bL * 0.8, 186], [250 + dU, 166], [236 + dU * 0.4, 150], [214, 140], [150, 138],
  ];
  const capOuter = catmull(capKey, 10, true);
  const capT = 5, synT = ra ? 7.5 : oa ? 4 : 2.8;
  const capInner = offsetClosed(capOuter, -capT);
  const synInner = offsetClosed(capInner, -synT);
  L.add("fluid", polyD(offsetClosed(capInner, -synT * 0.6)));
  const synU = L.map.get("synovium").unite;
  synU.push(ringD(capInner, synInner));
  L.add("capsule", ringD(capOuter, capInner));
  const inCavity = (q) => inside(synInner, q) && !inside(femur, q) && !inside(tibia, q);
  if (ra) {
    // hypertrophic synovium: villi of uneven length and spacing project into the effusion
    const inward = offsetClosed(synInner, -1);
    const nP = synInner.length;
    for (const s of unevenSpacing(22, nP, R, { cv: 0.4 })) {
      const i = Math.floor(s) % nP, p = synInner[i];
      const n = [inward[i][0] - p[0], inward[i][1] - p[1]];
      const len = vary(R, 7.5, 0.3), r = vary(R, 2.2, 0.2), tilt = (R() - 0.5) * 0.6;
      const dx = n[0] * Math.cos(tilt) - n[1] * Math.sin(tilt), dy = n[0] * Math.sin(tilt) + n[1] * Math.cos(tilt);
      const tip = [p[0] + dx * len, p[1] + dy * len];
      // only where the villus lies free in the fluid (not hidden in bone or over the cartilage gap)
      if (!inCavity(tip) || !inCavity([p[0] + dx * len * 0.5, p[1] + dy * len * 0.5])) continue;
      synU.push(circle(tip[0], tip[1], r * 1.15));
      synU.push(polyD([[p[0] - dy * r - dx * 2, p[1] + dx * r - dy * 2], [tip[0] - dy * r, tip[1] + dx * r], [tip[0] + dy * r, tip[1] - dx * r], [p[0] + dy * r - dx * 2, p[1] - dx * r - dy * 2]]));
    }
  }

  /* --- bones: cortex (thick in the shafts, thin subchondral plate), cancellous bone, medullary cavity --- */
  L.add("fibula", polyD(fibula));
  const osteo = [];
  if (oa) {
    // marginal osteophytes: bony beaks at the cartilage margins, largest medially (enlarged ×1.3 about a centre
    // set 3 units inside the bone, so the base stays buried in the condyle/plateau)
    const beak = (inward, pts, k = 1.3) => {
      const c = [(pts[0][0] + pts[pts.length - 1][0]) / 2 + 3 * inward, (pts[0][1] + pts[pts.length - 1][1]) / 2];
      return pts.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]);
    };
    osteo.push(smoothClosed(beak(1, [[61, 172], [51, 179], [44.5, 189], [41.5, 199.5], [46, 204.5], [54, 201], [62, 199]]), 0.8));
    osteo.push(smoothClosed(beak(1, [[64, 227], [53, 223], [46, 216.5], [42.5, 219], [44.5, 229], [53, 238], [62, 241]]), 0.8));
    osteo.push(smoothClosed(beak(-1, [[240, 182], [247, 189], [251, 197], [246, 200], [240, 199]]), 0.8));
    osteo.push(smoothClosed(beak(-1, [[238, 228], [246, 225], [252, 222], [251, 229], [244, 236], [240, 238]]), 0.8));
    L.map.get("cortex").unite = [polyD(femur), osteo[0], osteo[2]];
    L.map.get("cortexT").unite = [polyD(tibia), osteo[1], osteo[3]];
  } else {
    L.add("cortex", polyD(femur));
    L.add("cortexT", polyD(tibia));
  }
  // cortical thickness: ~11 in the shafts, tapering to a 3.5-unit subchondral plate
  // (the closing edges beyond the canvas are pushed outward so no cortex band shows at the frame edge)
  const femIn = offsetVar(femur, (i) => (femur[i][1] <= -7 ? -6 : 3.5 + 8 * Math.max(0, Math.min(1, (110 - femur[i][1]) / 60))));
  const tibIn = offsetVar(tibia, (i) => (tibia[i][1] >= 350 ? -6 : 3.5 + 8 * Math.max(0, Math.min(1, (tibia[i][1] - 268) / 50))));
  const fibIn = offsetVar(fibula, (i) => (fibula[i][1] >= 350 ? -6 : 2.5 + 3.5 * Math.max(0, Math.min(1, (fibula[i][1] - 290) / 30))));
  L.add("cancellous", polyD(femIn) + polyD(tibIn) + polyD(fibIn));
  const femCanal = smoothClosed([[130, -8], [170, -8], [169, 30], [164, 58], [156, 76], [150, 80], [144, 76], [136, 58], [131, 30]], 0.8);
  const tibCanal = smoothClosed([[121, 352], [179, 352], [178, 324], [172, 302], [162, 290], [150, 287], [138, 290], [128, 302], [122, 324]], 0.8);
  // the medullary cavity is marrow, like the trabecular spaces: one part, one colour
  L.add("pore", femCanal + tibCanal);
  const canals = [[[130, -8], [170, -8], [169, 30], [164, 58], [156, 76], [150, 82], [144, 76], [136, 58], [131, 30]], [[121, 352], [179, 352], [178, 324], [172, 302], [162, 290], [150, 285], [138, 290], [128, 302], [122, 324]]];

  // subchondral sclerosis (OA): a dense band under the denuded medial cartilage
  const sclerosis = [];
  if (oa) {
    const fm = femurLine.filter(([x, y]) => x > 64 && x < 126 && y > 196);
    const tm = tibia.filter(([x, y]) => x > 64 && x < 126 && y < 228);
    sclerosis.push(strip(fm.slice().reverse(), (u) => 4 + 7 * Math.sin(Math.PI * u)));
    sclerosis.push(strip(tm.sort((a, b) => a[0] - b[0]), (u) => 4 + 9 * Math.sin(Math.PI * u)));
    for (const s of sclerosis) L.add("sclerosis", polyD(s));
  }
  const cysts = oa ? [[96, 238, 6, 4.6], [112, 236, 3.4, 2.8], [92, 203, 3.6, 2.8]] : [];

  // trabecular pores: irregular, uneven size, densest near the joint; larger and more numerous in RA
  // (juxta-articular osteopenia); excluded from sclerotic bone and cysts
  const poreIn = (poly, n, seedP, nearY) => {
    const RP = rng(seedP), out = [];
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const bx = Math.min(...xs), by = Math.max(0, Math.min(...ys)), bw = Math.max(...xs) - bx, bh = Math.min(344, Math.max(...ys)) - by;
    for (let t = 0; out.length < n && t < n * 80; t++) {
      const p = [bx + RP() * bw, by + RP() * bh];
      const near = Math.max(0, 1 - Math.abs(p[1] - nearY) / 90);
      const r = (ra ? 2.2 + 2.6 * near : 1.6 + 1.6 * near) * (0.6 + RP() * 0.8);
      if (RP() > 0.35 + 0.65 * near) continue;
      if (!checkInside([p], poly, r + 1.4).ok) continue;
      if (canals.some((c) => checkInside([p], c, -r - 1).ok)) continue;
      if (sclerosis.some((s) => checkInside([p], s, -r - 1.5).ok)) continue;
      if (cysts.some(([cx, cy, rx]) => Math.hypot(p[0] - cx, p[1] - cy) < rx + r + 2)) continue;
      if (out.some(([x, y, rr]) => Math.hypot(x - p[0], y - p[1]) < rr + r + 1.6)) continue;
      out.push([p[0], p[1], r]);
    }
    for (const [x, y, r] of out) L.add("pore", blob(x, y, r, r * (0.55 + RP() * 0.4), { n: 7, wobble: 0.22, seed: Math.round(x * 31 + y), rot: RP() * 180 }));
  };
  poreIn(femIn, ra ? 230 : 300, seed + 1, 200);
  poreIn(tibIn, ra ? 160 : 210, seed + 2, 236);
  poreIn(fibIn, 22, seed + 3, 262);
  // epiphyseal scars (closed growth plates)
  for (const [y0, x0, x1, ph] of [[146, 74, 226, 0.4], [270, 82, 218, 1.7]]) {
    const pts = [];
    for (let x = x0; x <= x1; x += 4) pts.push([x, y0 + 2.2 * Math.sin(x / 13 + ph) + 1.2 * Math.sin(x / 5.3)]);
    for (const r of runs(pts, (p) => checkInside([p], y0 < 200 ? femIn : tibIn, 3).ok, 3)) L.add("physis", smoothOpen(r));
  }
  for (const [cx, cy, rx, ry] of cysts) L.add("cyst", blob(cx, cy, rx, ry, { n: 8, wobble: 0.1, seed: Math.round(cx) }));

  /* --- cruciate ligaments in the notch, crossing in this frontal view. ACL: inner wall of the lateral condyle
     → anterior intercondylar area; PCL: inner wall of the medial condyle → posterior intercondylar area. Each
     band (8–9 wide mid-substance) fans out into a footprint 10–12 long on the bone surface, its edge set
     1.6 units into the bone so the attachment overlaps the bone outline. --- */
  const tibTopLine = tibia.slice(0, Math.floor(tibia.length / 2));
  const footRun = (line, q, half) => {
    const i = line.reduce((b, p, k) => (dist(p, q) < dist(line[b], q) ? k : b), 0);
    let a = i, b = i, la = 0, lb = 0;
    while (a > 0 && la < half) la += dist(line[a], line[--a]);
    while (b < line.length - 1 && lb < half) lb += dist(line[b], line[++b]);
    return line.slice(a, b + 1);
  };
  // orient a run of a bone outline so that its left normal points away from the bone
  const outward = (run, bone) => {
    const ns = normals(run), k = Math.floor(run.length / 2);
    return inside(bone, [run[k][0] + ns[k][0] * 1.5, run[k][1] + ns[k][1] * 1.5]) ? run.slice().reverse() : run;
  };
  const cruciate = (key, fq, tq, wMid, bow) => {
    const ends = [outward(footRun(femurLine, fq, 5.6), femur), outward(footRun(tibTopLine, tq, 5.3), tibia)].map((r) => {
      const k = Math.floor(r.length / 2), n = normals(r)[k];
      return { run: offsetOpen(r, -1.6), p: r[k], n };
    });
    const [F, T] = ends, mid = [(F.p[0] + T.p[0]) / 2, (F.p[1] + T.p[1]) / 2], ax = [T.p[0] - F.p[0], T.p[1] - F.p[1]], al = Math.hypot(...ax);
    const axis = resample(catmull([F.p, [F.p[0] + F.n[0] * 5, F.p[1] + F.n[1] * 5], [mid[0] - (ax[1] / al) * bow, mid[1] + (ax[0] / al) * bow], [T.p[0] + T.n[0] * 5, T.p[1] + T.n[1] * 5], T.p], 10), 1);
    const n = axis.length - 1, ns = normals(axis);
    const side = (k, u) => {
      const i = Math.round(u * n);
      return [axis[i][0] + (ns[i][0] * k * wMid) / 2, axis[i][1] + (ns[i][1] * k * wMid) / 2];
    };
    // pair each footprint end with the band edge on its side, so the edges never cross
    const pick = (E, q) => (dist(E.run[0], q) < dist(E.run[E.run.length - 1], q) ? [E.run[0], E.run[E.run.length - 1], E.run] : [E.run[E.run.length - 1], E.run[0], E.run.slice().reverse()]);
    const [fL, fR, fRun] = pick(F, side(1, 0.3)), [tL, tR, tRun] = pick(T, side(1, 0.7));
    const off = (p, E, d) => [p[0] + E.n[0] * d, p[1] + E.n[1] * d];
    const edgeL = catmull([fL, off(fL, F, 3.6), side(1, 0.3), side(1, 0.5), side(1, 0.7), off(tL, T, 3.6), tL], 6);
    const edgeR = catmull([fR, off(fR, F, 3.6), side(-1, 0.3), side(-1, 0.5), side(-1, 0.7), off(tR, T, 3.6), tR], 6);
    // fRun runs fL → fR, tRun runs tL → tR
    L.add(key, polyD([...fRun, ...edgeR, ...tRun.slice().reverse(), ...edgeL.slice().reverse()]));
    // two fibre lines following the band
    for (const k of [-0.24, 0.24]) L.add(key + "Fibre", smoothOpen(axis.map((p, i) => [p[0] + ns[i][0] * k * wMid, p[1] + ns[i][1] * k * wMid]).slice(Math.round(n * 0.14), Math.round(n * 0.86)).filter((_, i) => i % 3 === 0)));
  };
  cruciate("pcl", [138.5, 180], [156, 212], 9, -2.5);
  cruciate("acl", [163.5, 184], [145, 213], 8.4, 2.5);

  /* --- articular cartilage (blue hyaline): thick on the condyles and plateaux, worn in OA, thinned in RA --- */
  const ct = ra ? 4.6 : 6.6;
  const cartPolys = [];
  const femCart = (x0, x1) => femurLine.filter(([x, y]) => x >= x0 && x <= x1 && y > 176);
  const tibCart = (x0, x1) => tibia.slice(0, Math.floor(tibia.length / 2)).filter(([x, y]) => x >= x0 && x <= x1 && y < 232);
  // femoral condyles (strip laid into the bone: the outline runs medial→lateral, reversed so "left" is inward)
  for (const [x0, x1, side] of [[58, 132, "m"], [168, 242, "l"]]) {
    const line = femCart(x0, x1);
    if (oa && side === "m") {
      // worn through in the weight-bearing zone, thin and frayed at its edges
      cartPolys.push(strip(line.filter(([x]) => x < 74).reverse(), (u) => 1.5 + 2.6 * u));
      cartPolys.push(strip(line.filter(([x]) => x > 110).reverse(), (u) => 4.2 - 2.6 * u));
    } else cartPolys.push(strip(line.slice().reverse(), (u) => ct * Math.min(1, Math.sin(Math.PI * Math.min(1, Math.max(0, u))) * 3)));
  }
  for (const [x0, x1, side] of [[61, 130, "m"], [170, 239, "l"]]) {
    const line = tibCart(x0, x1);
    if (oa && side === "m") {
      const RJ = rng(seed + 9);
      const jag = line.map(([x, y]) => [x, y + (RJ() < 0.3 ? 0.6 + RJ() * 1.2 : 0)]);
      cartPolys.push(strip(jag, (u) => 1.2 + 1.6 * Math.abs(Math.sin(u * 7.3)) + 1.2 * u));
    } else cartPolys.push(strip(line, (u) => ct * Math.min(1, Math.sin(Math.PI * u) * 3)));
  }
  L.add("cart", cartPolys.filter((p) => p.length > 4).map((p) => smoothClosed(p.filter((_, i) => i % 2 === 0), 0.6)));
  for (const poly of cartPolys.filter((p) => p.length > 12)) {
    for (const p of packWhere({ x: 40, y: 168, w: 220, h: 70 }, oa ? 3 : 6, 10, (q) => checkInside([q], poly, 1.4).ok, { seed: seed + Math.round(poly[0][0]) })) L.add("chondro", ellipse(p[0], p[1], 1.4, 0.9, R() * 30 - 15));
  }

  /* --- menisci: fibrocartilage wedges, attached to the capsule at the periphery --- */
  // wedge: flat underside on the tibial cartilage, concave top under the condyle, thick outer rim
  const meniscus = (xIn, xOut, hMax, blunt = false) => {
    const top = [], bot = [];
    const dir = Math.sign(xOut - xIn);
    for (let k = 0; k <= 14; k++) {
      const u = k / 14, x = xIn + (xOut - xIn) * u;
      const b = tibTop(Math.max(63, Math.min(237, x))) - 0.9 + Math.max(0, 63 - x, x - 237) * 0.35;
      const fb = femBottom(x);
      const avail = fb == null ? hMax : b - fb - 1.8;
      const h = Math.max(0.8, Math.min(avail, hMax * (blunt ? 0.45 + 0.55 * u : Math.pow(u, 0.75))));
      top.push([x, b - h]);
      bot.push([x, b]);
    }
    const outer = [[xOut + dir * 2.5, top[14][1] + 1.5], [xOut + dir * 3, bot[14][1] - 1]];
    return { d: smoothClosed([...top, ...outer, ...bot.slice().reverse()], 0.7), top, bot, rim: [top[14], ...outer, bot[14]] };
  };
  const xAt = (pts, y, pick) => {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    return xs.length ? pick(...xs) : null;
  };
  const mOutM = xAt(synInner, 214, Math.min) + 2, mOutL = xAt(synInner, 214, Math.max) - 2;
  // OA: the medial meniscus is degenerate — extruded past the tibial margin, its free edge worn blunt
  const menM = oa ? meniscus(80, mOutM, 10, true) : meniscus(88, mOutM, 14), menL = meniscus(212, mOutL, 13);
  L.add("meniscus", menM.d);
  L.add("meniscus", menL.d);
  if (oa) {
    // degenerate medial meniscus: a horizontal cleavage tear opening at its free (inner) edge
    const n = 9, upper = [], lower = [];
    for (let k = 0; k <= n; k++) {
      const u = (k / n) * 0.62, j = u * 14, j0 = Math.floor(j), fr = j - j0, at = (arr) => [arr[j0][0] + (arr[Math.min(14, j0 + 1)][0] - arr[j0][0]) * fr, arr[j0][1] + (arr[Math.min(14, j0 + 1)][1] - arr[j0][1]) * fr];
      const tp = at(menM.top), bt = at(menM.bot), m = [(tp[0] + bt[0]) / 2, (tp[1] + bt[1]) * 0.5 + 0.2], t = 0.8 * Math.pow(1 - u / 0.62, 0.7) * Math.min(1, (bt[1] - tp[1]) / 4);
      upper.push([m[0], m[1] - t]);
      lower.push([m[0], m[1] + t]);
    }
    upper[0][0] += 0.9;
    lower[0][0] += 0.9;
    L.add("tear", smoothClosed([...upper, ...lower.reverse()], 0.6));
  }

  /* --- collateral ligaments --- */
  // MCL: a flat band over the medial capsule, from the medial epicondyle to the tibia well below the joint line
  const mcl = [
    ...[130, 142].map((y) => [xAt(femur, y, Math.min) - 2.6, y]),
    ...[164, 180, 196, 212, 226, 240].map((y) => [xAt(capOuter, y, Math.min) - 2.8, y]),
    ...[258, 278, 300, 324, 348].map((y) => [xAt(tibia, y, Math.min) - 2.8, y]),
  ];
  L.add("collateral", ribbon(catmull(mcl, 6), 6, { taper: 0.12 }));
  // LCL: a cord from the lateral epicondyle to the fibular head, standing off the capsule
  const lcl = [[xAt(femur, 132, Math.max) + 2.4, 132], ...[160, 188, 214].map((y) => [xAt(capOuter, y, Math.max) + 5.5, y]), [271, 236], [272, 247]];
  L.add("collateral", ribbon(catmull(lcl, 6), 5.4, { taper: 0.2 }));

  /* --- synovial membrane over the bare bone inside the capsule (from attachment to cartilage margin) --- */
  // free room from a bone-surface point along its outward normal to the inside of the capsule
  const room = (p, n) => {
    let d = 0;
    while (d < 30 && inside(capInner, [p[0] + n[0] * d, p[1] + n[1] * d])) d += 0.5;
    return d;
  };
  // the contiguous run of a closed outline whose points pass test (handles the wrap-around at index 0)
  const closedRun = (poly, test) => {
    const s0 = Math.max(0, poly.findIndex((p) => !test(p)));
    const out = [];
    for (const p of [...poly.slice(s0), ...poly.slice(0, s0)]) {
      if (test(p)) out.push(p);
      else if (out.length) break;
    }
    return out;
  };
  // a band laid outward on a run of bone outline, thickness prof(y) but never reaching the capsule
  const boneBand = (run, bone, prof, margin = 1.2, lumps = null) => {
    if (run.length < 4) return null;
    run = bone ? outward(run, bone) : run;
    const ns = normals(run);
    const t0 = run.map((p, i) => Math.max(0, Math.min(prof(p[1]) * (lumps ? lumps(p[1]) : 1), room(p, ns[i]) - margin)));
    // erode then average over a few points so a stepped room limit gives no saw-teeth
    const tE = t0.map((_, i) => Math.min(...t0.slice(Math.max(0, i - 3), i + 4)));
    const t = tE.map((_, i) => { const w = tE.slice(Math.max(0, i - 3), i + 4); return w.reduce((a, b) => a + b, 0) / w.length; });
    return [...run, ...run.map((p, i) => [p[0] + ns[i][0] * t[i], p[1] + ns[i][1] * t[i]]).reverse()];
  };
  const bw = synT * 0.8 + 0.8;
  const femRun = (side, y0, y1) => femurLine.filter(([x, y]) => y > y0 && y < y1 && (side < 0 ? x < 100 : x > 200));
  const tibRun = (side, y0, y1) => closedRun(tibia, ([x, y]) => y > y0 && y < y1 && (side < 0 ? x < 75 : x > 225));
  const taper = (y0, y1, th) => (y) => th * Math.max(0, Math.min(1, (y - y0) / 4, (y1 - y) / 4));
  for (const side of [-1, 1]) {
    for (const band of [boneBand(femRun(side, 148, 184), femur, taper(148, 184, bw)), boneBand(tibRun(side, 228, 252), tibia, taper(228, 252, bw))]) {
      if (band) synU.push(polyD(band));
    }
  }

  /* --- RA: pannus. At each joint margin ONE lumpy vascular mass: thick (10–14) over the bare area of the
     femur and tibia in the recess, filling the recess corner and covering the meniscal periphery, a thin tongue
     (≈20 long, 3 → 1 thick) creeping over the femoral cartilage, and filling two marginal erosions (cups ≈7
     deep, ≈9 wide) bitten into the bare bone just outside the cartilage edge, where the cortex is gone. The
     mass is built as a field (union of discs laid on the bone surface, clipped to the joint cavity inside the
     capsule and outside the bone except in the cups), blurred and contoured — one smooth outline per side. --- */
  const panPolys = [];
  if (ra) {
    const pan = L.map.get("pannus").unite;
    const capIn = offsetClosed(capInner, -1.1);
    const femCore = offsetClosed(femur, -0.8), tibCore = offsetClosed(tibia, -0.8);
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    for (const side of [-1, 1]) {
      const R3 = rng(seed + (side < 0 ? 3 : 4)), ph = [R3() * 6, R3() * 6];
      const lump = (k) => 1 + 0.17 * Math.sin(k * 0.29 + ph[0]) * Math.sin(k * 0.11 + ph[1]);
      const discs = [];
      const lay = (run, tOf) => run.forEach((p, k) => discs.push([p[0], p[1], tOf(p[1], k)]));
      const fBare = resample(outward(femRun(side, 149, 176.5), femur), 1.2);
      const fTongue = resample(outward(femRun(side, 176.5, 199), femur), 1.2);
      const tBare = resample(outward(tibRun(side, 222, 252), tibia), 1.2);
      // femoral bare area: 6 at the capsular attachment, 13 near the cartilage margin
      lay(fBare, (y, k) => (8 + 10 * clamp01((y - 150) / 13)) * lump(k));
      // tongue over the femoral cartilage, tapering away from the margin
      lay(fTongue, (y) => 3.4 - 2.4 * clamp01((y - 176.5) / 22.5));
      // tibial margin: thin over the rim next to the cartilage, thick over the bare area
      lay(tBare, (y, k) => (y < 230 ? 3.2 : y < 235 ? 3.2 + ((y - 230) / 5) * 10 : y < 246 ? 13.2 : 13.2 - ((y - 246) / 6) * 7) * lump(k + 40));
      // recess corner between the condyle, the meniscus and the synovium, and the meniscal periphery
      const men = side < 0 ? menM : menL;
      const fn = normals(fTongue), kc = fTongue.reduce((b, p, k) => (Math.abs(p[1] - 187) < Math.abs(fTongue[b][1] - 187) ? k : b), 0);
      const P1 = [fTongue[kc][0] + fn[kc][0] * 6, fTongue[kc][1] + fn[kc][1] * 6], P2 = men.top[12];
      for (let k = 0; k <= 12; k++) discs.push([P1[0] + ((P2[0] - P1[0]) * k) / 12, P1[1] + ((P2[1] - P1[1]) * k) / 12, 6.5 - k * 0.15]);
      for (const p of [...men.top.slice(9), ...men.rim]) discs.push([p[0], p[1], 4.2]);
      // marginal erosions: cups centred 2.6 units inside the bare bone surface, radius ≈5.5 (≈8 deep, ≈10 wide)
      const cupAt = (run, y, r) => {
        const ns = normals(run), k = run.reduce((b, p, i) => (Math.abs(p[1] - y) < Math.abs(run[b][1] - y) ? i : b), 0);
        return [run[k][0] - ns[k][0] * 2.6, run[k][1] - ns[k][1] * 2.6, r];
      };
      const cups = [cupAt(fBare, 169, 5.6), cupAt(tBare, 239, 5.3)];
      for (const c of cups) discs.push([c[0], c[1], c[2] + 2.5]);
      const inCup = (p) => cups.some(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) < r);
      const mask = (p) =>
        discs.some(([x, y, r]) => Math.abs(p[0] - x) < r && Math.abs(p[1] - y) < r && Math.hypot(p[0] - x, p[1] - y) < r) &&
        inside(capIn, p) && (inCup(p) || (!inside(femCore, p) && !inside(tibCore, p)));
      // rasterise (0.5-unit grid), blur, contour at 0.5
      const h = 0.5, gx0 = side < 0 ? 18 : 186, gy0 = 138, nx = 200, ny = 250;
      let val = new Float32Array(nx * ny);
      for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) val[j * nx + i] = mask([gx0 + i * h, gy0 + j * h]) ? 1 : 0;
      val = boxBlur(boxBlur(val, nx, ny, 2), nx, ny, 2);
      for (let i = 0; i < nx; i++) val[i] = val[(ny - 1) * nx + i] = 0;
      for (let j = 0; j < ny; j++) val[j * nx] = val[j * nx + nx - 1] = 0;
      for (const loop of contourLoops(val, nx, ny, gx0, gy0, h, 0.5)) {
        if (Math.abs(signedArea(loop)) < 20) continue;
        let pts = resample([...loop, loop[0]], 0.9);
        for (let pass = 0; pass < 2; pass++) pts = pts.map((q, i) => {
          const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
          return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
        });
        pan.push(polyD(pts));
        panPolys.push(pts);
        // a few capillary/venule profiles in the mass, clear of its edge and of the meniscus
        const menPoly = [...men.top, ...men.bot.slice().reverse()];
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const bb = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        for (const q of packWhere(bb, 7, 9, (p) => checkInside([p], pts, 3.6).ok && !checkInside([p], menPoly, -3.5).ok, { seed: seed + Math.round(bb.x) })) {
          const r = vary(R3, 2.3, 0.2), a = R3() * 180;
          L.add("panWall", ellipse(q[0], q[1], r, r * 0.8, a));
          L.add("panLumen", ellipse(q[0], q[1], r - 0.75, r * 0.8 - 0.75, a));
          L.add("panRbc", ellipse(q[0] + 0.2, q[1], 0.95, 0.75, a));
        }
      }
    }
    // effusion: inflammatory cells floating in the fluid
    const inPannus = (q) => panPolys.some((pp) => inside(pp, q) || edgeDistance([pp], q) < 2.4);
    for (const p of packWhere({ x: 26, y: 150, w: 248, h: 110 }, 30, 7, (q) => (q[0] < 72 || q[0] > 228) && inCavity(q) && checkInside([q], synInner, 3).ok && !inside(femur, [q[0], q[1] - 3]) && !inside(tibia, [q[0], q[1] + 3]) && !inPannus(q), { seed: seed + 5 })) {
      L.add("fluidCells", circle(p[0], p[1], vary(R, 1.9, 0.2)));
    }
  }
  return clampScene({ size: [300, 344], lineWidth: 1.6, parts: L.parts() }, [0, 0, 300, 344]);
}

const SYN_TAGS = ["synovium", "synovial membrane", "synovial tissue", "synoviocytes", "FLS", "fibroblast-like synoviocyte", "MLS", "macrophage-like synoviocyte", "lining layer", "sublining", "intima", "subintima", "histology", "tissue section", "H&E"];
const RA_TAGS = ["rheumatoid arthritis", "RA", "synovitis", "inflammation", "disease", "lining hyperplasia", "villous hypertrophy", "Krenn synovitis score", "pathotype", "Pitzalis", "Humby", "PEAC", "R4RA"];

export const icons = [
  {
    slug: "synovium-healthy", name: "Synovium — healthy (tissue section)", category: "tissues",
    tags: [...SYN_TAGS, "healthy", "normal", "adipose", "joint", "capillaries", "areolar"],
    scene: () => synovium({ ra: false, seed: 11 }),
  },
  {
    slug: "synovium-rheumatoid-arthritis", name: "Synovium — rheumatoid arthritis (lympho-myeloid)", category: "tissues",
    tags: [...SYN_TAGS, ...RA_TAGS, "lympho-myeloid", "lymphoid aggregate", "ectopic lymphoid structure", "ELS", "tertiary lymphoid structure", "TLS", "germinal centre", "follicle", "B cells", "T cells", "plasma cells", "perivascular cuff", "HEV", "high endothelial venule", "lymphoid aggregate"],
    scene: () => synovium({ ra: true, pathotype: "lympho-myeloid", seed: 12 }),
  },
  {
    slug: "synovium-ra-diffuse-myeloid", name: "Synovium — RA diffuse-myeloid pathotype", category: "tissues",
    tags: [...SYN_TAGS, ...RA_TAGS, "diffuse-myeloid", "macrophages", "CD68", "myeloid", "sublining macrophages"],
    scene: () => synovium({ ra: true, pathotype: "diffuse-myeloid", seed: 13 }),
  },
  {
    slug: "synovium-ra-pauci-immune", name: "Synovium — RA pauci-immune fibroid pathotype", category: "tissues",
    tags: [...SYN_TAGS, ...RA_TAGS, "pauci-immune", "fibroid", "fibroblasts", "stroma", "fibrosis", "collagen"],
    scene: () => synovium({ ra: true, pathotype: "pauci-immune", seed: 14 }),
  },
  {
    slug: "knee-joint-healthy", name: "Knee joint — healthy (coronal section)", category: "anatomy",
    tags: ["synovial joint", "knee", "joint", "articular cartilage", "meniscus", "menisci", "joint capsule", "synovial membrane", "synovial fluid", "cruciate ligaments", "ACL", "PCL", "collateral ligaments", "MCL", "LCL", "femur", "tibia", "fibula", "coronal section", "healthy", "normal"],
    scene: () => joint("healthy"),
  },
  {
    slug: "knee-joint-rheumatoid-arthritis", name: "Knee joint — rheumatoid arthritis", category: "anatomy",
    tags: ["synovial joint", "knee", "joint", "rheumatoid arthritis", "RA", "synovitis", "synovial hypertrophy", "pannus", "marginal erosion", "bone erosion", "cartilage loss", "joint space narrowing", "effusion", "juxta-articular osteopenia", "inflammatory arthritis", "disease"],
    scene: () => joint("ra"),
  },
  {
    slug: "knee-joint-osteoarthritis", name: "Knee joint — osteoarthritis", category: "anatomy",
    tags: ["synovial joint", "knee", "joint", "osteoarthritis", "OA", "osteophyte", "cartilage degeneration", "cartilage loss", "subchondral sclerosis", "subchondral cyst", "joint space narrowing", "medial compartment", "meniscal tear", "meniscal extrusion", "degenerative joint disease", "disease"],
    scene: () => joint("oa"),
  },
];
