// Spatial transcriptomics — sequencing-based capture arrays (10x Visium v2 / CytAssist, Visium HD,
// STOmics Stereo-seq + StereoCell) and imaging-based in situ methods (10x Xenium: padlock probes,
// rolling-circle amplification, cyclic fluorescent decoding; generic MERFISH / CosMx barcode
// imaging; 10x Atera), overview strips and an expression map. Servier-like (soft) and NIH-like
// (line); light from the top left. Colours of recurring things (capture-oligo segments, mRNA,
// glass, fluorophores, cluster colours) are shared so the workflow strips match the single icons.
import { blobPts, circle, ellipse, rect, capsule, smoothClosed, smoothOpen, polyline, rng, f } from "../lib/geom.mjs";
import { shade, tint, pathBox } from "../lib/style.mjs";
import { catmull, arcLengths, roundPoly, clipConvex, rectPoly, packWhere, inside, polyD, offsetClosed, centroid, area, resample, signedArea } from "../lib/tissue.mjs";
import { clustered, assertInside } from "../lib/organic.mjs";

const DEG = Math.PI / 180;
const P = (x, y) => `${f(x)} ${f(y)}`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const add2 = (a, u, k) => [a[0] + u[0] * k, a[1] + u[1] * k];

/* ---------------- palette ---------------- */

const COL = {
  // glass slides
  glass: "#dff0fb", glassEdge: "#a9c6dc", frost: "#f4f6f9", frostLine: "#b9cbdc",
  // capture arrays
  area: "#c4d8ec", spot: "#8fa9c8", fid: "#5d6b7a", lawn: ["#b4cfeb", "#9fbfe3", "#c6dcf2", "#8fb2db"],
  // capture oligo segments (surface end → 3' end), as in the single-cell icons
  r1: "#4f86d0", bc: "#ef8f4a", umi: "#9a7bd0", polyT: "#f2c14e",
  mrna: "#d9609a", polyA: "#74c267", insert: "#d9609a",
  // library adapters, exactly as in methods-seq (P5 teal, Read 2 grey, i7 slate, P7 amber)
  p5: "#45b7b0", r2: "#8fa0b0", i7: "#4f6478", p7: "#a87038",
  // ligated probe pairs (FFPE / CytAssist chemistry)
  lhs: "#45b7b0", rhs: "#5b8bd9",
  // tissue (H&E-like)
  tissue: "#f2b6c8", tissueDeep: "#de8fb0", hema: "#8b63b3", cell: "#f6cfda", cyto: "#fbe6ee",
  // Stereo-seq chip
  // seven visible DNBs with seven coordinate IDs (none of them the UMI purple, poly(T) yellow or
  // poly(A) green); the DNB (and the RCA concatemer, which is the same kind of coiled DNA) is a deep
  // indigo, clearly darker than the UMI / MID purple
  dnb: "#6b55ab", chip: "#46505d", track: "#77879a",
  cid0: "#ef8f4a", cid1: "#45b7b0", cid2: "#e2606a", cid3: "#4e8fd6", cid4: "#b5835a", cid5: "#ec8fc0", cid6: "#62c4dd",
  // fluorescence images
  dark: "#1e2835", darkCell: "#2a3849", darkLine: "#8094ad", dapi: "#3f62a6",
  // binning
  bin8: "#f0a050", bin16: "#9b7fd1",
  // instruments
  body: "#e3eaf1", top: "#f2f5f8", side: "#c3cfdb", win: "#3f4c5c", screen: "#6fb2e6", bar: "#59c3e6", metal: "#8fa0b0", table: "#7d8a98",
  arrow: "#c3d2e1", lane: "#9fc9ea", rcp: "#f9e2b8",
};
/** Fluorophore channels (bright on dark) and decoded-gene colours. */
const FL = { g: "#5fe07a", r: "#ff5f7e", y: "#ffd54a", b: "#4fc8ff" };
const GENE = ["#f39c4a", "#b08cff", "#ff7fc8", "#3fd6c4", "#c8e65a"];
/** Categorical colours for clusters (shared with the single-cell charts). */
const CLU = ["#4e8fd6", "#f0a050", "#6cbf68", "#e2606a", "#9b7fd1", "#45b7b0", "#ec8fc0", "#d9b43a"];
const HI = "#f7fafc", SHADOW = "#24303c";

/* ---------------- path helpers (as in methods-seq) ---------------- */

/** Map every coordinate of absolute path data (M L H V C Q Z) through fn. */
function mapPath(d, fn) {
  const toks = d.match(/[MLHVCQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  let out = "", cmd = "M", cur = [0, 0], i = 0;
  const num = () => Number(toks[i++]);
  const put = (pt) => { const p = fn(pt); return `${f(p[0])} ${f(p[1])}`; };
  while (i < toks.length) {
    if (/[a-z]/i.test(toks[i])) {
      cmd = toks[i++].toUpperCase();
      if (cmd === "Z") { out += "Z"; continue; }
    }
    if (cmd === "H") { cur = [num(), cur[1]]; out += "L" + put(cur); continue; }
    if (cmd === "V") { cur = [cur[0], num()]; out += "L" + put(cur); continue; }
    const k = cmd === "C" ? 3 : cmd === "Q" ? 2 : 1;
    const pts = [];
    for (let j = 0; j < k; j++) { cur = [num(), num()]; pts.push(put(cur)); }
    out += cmd + pts.join(" ");
    if (cmd === "M") cmd = "L";
  }
  return out;
}

/** Local → world placement: scale s, rotation (degrees, clockwise on screen). */
function place({ x = 0, y = 0, s = 1, rot = 0 } = {}) {
  const c = Math.cos(rot * DEG), sn = Math.sin(rot * DEG);
  return { P: ([px, py]) => [x + (px * c - py * sn) * s, y + (px * sn + py * c) * s], s, rot };
}
/** Map parts through placement t (geometry, stroke widths and explicit outline widths). */
function xform(parts, t) {
  return parts.map((p) => {
    const q = { ...p };
    if (p.unite) q.unite = p.unite.map((d) => mapPath(d, t.P));
    if (p.d) q.d = Array.isArray(p.d) ? p.d.map((d) => mapPath(d, t.P)) : mapPath(p.d, t.P);
    if (p.stroke) q.stroke = { ...p.stroke, width: p.stroke.width * t.s, ...(p.stroke.dash ? { dash: p.stroke.dash.map((v) => v * t.s) } : {}) };
    if (p.lineStrokeWidth) q.lineStrokeWidth = p.lineStrokeWidth * t.s;
    if (p.lineWidth) q.lineWidth = Math.max(0.3, p.lineWidth * t.s);
    return q;
  });
}
/** Scale + move parts for strips (also sets an outline width for every part). */
function placeParts(parts, { dx = 0, dy = 0, s = 1, lw = 1.67 } = {}) {
  const fn = ([x, y]) => [dx + x * s, dy + y * s];
  return parts.map((p) => {
    const q = { ...p };
    if (p.unite) q.unite = p.unite.map((d) => mapPath(d, fn));
    if (p.d) q.d = Array.isArray(p.d) ? p.d.map((d) => mapPath(d, fn)) : mapPath(p.d, fn);
    if (p.stroke) q.stroke = { ...p.stroke, width: p.stroke.width * s, ...(p.stroke.dash ? { dash: p.stroke.dash.map((v) => v * s) } : {}) };
    q.lineWidth = Math.max(0.3, (p.lineWidth ?? (p.shade === "small" || p.thin ? lw * 0.7 : lw)) * s);
    if (p.lineStrokeWidth) q.lineStrokeWidth = p.lineStrokeWidth * s;
    return q;
  });
}
function boundsOf(parts) {
  return pathBox(parts.flatMap((p) => p.unite || (Array.isArray(p.d) ? p.d : [p.d])).filter(Boolean));
}
/** Centre parts in a W × H box (scale ≤ maxS). */
function fit(parts, W, H, { pad = 8, maxS = 1, dx = 0, dy = 0 } = {}) {
  const b = boundsOf(parts);
  const s = Math.min(maxS, (W - 2 * pad) / b.w, (H - 2 * pad) / b.h);
  return xform(parts, place({ x: W / 2 - (b.x + b.w / 2) * s + dx, y: H / 2 - (b.y + b.h / 2) * s + dy, s }));
}

const circPts = (cx, cy, r, n = 48, ry = r) => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * 2 * Math.PI) * r, cy + Math.sin((i / n) * 2 * Math.PI) * ry]);
const holeD = (pts) => polyD([...pts].reverse());
/** Rotated ellipse as 4 cubic segments (compact: ~4× shorter path data than geom's 16-point version). */
function ellR(cx, cy, rx, ry, rot = 0) {
  const K = 0.5522847498, c = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
  const T = (x, y) => `${f(cx + x * c - y * s)} ${f(cy + x * s + y * c)}`;
  return `M${T(rx, 0)}C${T(rx, ry * K)} ${T(rx * K, ry)} ${T(0, ry)}C${T(-rx * K, ry)} ${T(-rx, ry * K)} ${T(-rx, 0)}` +
    `C${T(-rx, -ry * K)} ${T(-rx * K, -ry)} ${T(0, -ry)}C${T(rx * K, -ry)} ${T(rx, -ry * K)} ${T(rx, 0)}Z`;
}
const ringD = (cx, cy, r0, r1) => polyD(circPts(cx, cy, r1, 72)) + holeD(circPts(cx, cy, r0, 72));
/** Convex rounded-rectangle outline as points (for clipping). */
function rrPts(x, y, w, h, r, k = 5) {
  const out = [];
  const corner = (cx, cy, a0) => { for (let i = 0; i <= k; i++) { const a = (a0 + (i / k) * 90) * DEG; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  corner(x + w - r, y + r, -90); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, 90); corner(x + r, y + r, 180);
  return out;
}
const clipD = (pts, clip, r = 0) => {
  const q = clipConvex(pts, clip);
  return q.length > 2 ? (r ? roundPoly(q, r) : polyD(q)) : "";
};

/**
 * Edge shading for a flat rounded-rectangle face, light from the top left: a crescent `bw` thick
 * hugging the right and bottom edges (or, with flip, the left and top edges).
 */
function edgeBand(x, y, w, h, r, bw, { from = r + 4, to = r + 4, flip = false } = {}) {
  const pts = [], nrm = [], R = Math.max(r, 0.01);
  const add = (p, n) => { pts.push(p); nrm.push(n); };
  for (let i = 0; i <= 20; i++) add([x + w, y + from + (i / 20) * (h - R - from)], [-1, 0]);
  for (let i = 1; i < 12; i++) {
    const a = (i / 12) * (Math.PI / 2);
    add([x + w - R + Math.cos(a) * R, y + h - R + Math.sin(a) * R], [-Math.cos(a), -Math.sin(a)]);
  }
  for (let i = 0; i <= 30; i++) add([x + w - R - (i / 30) * (w - R - to), y + h], [0, -1]);
  const s = arcLengths(pts), S = s.at(-1), sc = s[26];
  const sm = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  const inner = pts.map((p, i) => {
    const th = bw * Math.min(sm(s[i] / (sc * 0.8)), sm((S - s[i]) / ((S - sc) * 0.6)));
    return [p[0] + nrm[i][0] * th, p[1] + nrm[i][1] * th];
  });
  let out = [...pts, ...inner.reverse()];
  if (flip) out = out.map(([px, py]) => [2 * x + w - px, 2 * y + h - py]);
  return polyD(out);
}
const glow = (d, opacity = 0.6, extra = {}) => ({ d, fill: HI, opacity, line: false, ...extra });
const dim = (d, opacity = 0.14, extra = {}) => ({ d, fill: SHADOW, opacity, line: false, ...extra });
/** Flat face + dark crescent (bottom right) + light crescent (top left), soft style only. */
const faceShade = (x, y, w, h, r, fill, { bw = 3, hw = 2.4, dark = 0.1, light = 0.5 } = {}) => [
  { d: edgeBand(x, y, w, h, r, bw), fill: shade(fill, dark), line: false },
  glow(edgeBand(x, y, w, h, r, hw, { flip: true }), light),
];

/** Block arrow from a to b (shaft h thick, head `head` × h wide), softly rounded. */
function arrowAlong(a, b, h = 8, head = 1.9) {
  const L = dist(a, b), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-u[1], u[0]];
  const hh = (h * head) / 2, hl = Math.min(L * 0.55, h * 1.15);
  const loc = [[0, -h / 2], [L - hl, -h / 2], [L - hl, -hh], [L, 0], [L - hl, hh], [L - hl, h / 2], [0, h / 2]];
  return roundPoly(loc.map(([s, t]) => [a[0] + u[0] * s + n[0] * t, a[1] + u[1] * s + n[1] * t]), 1.4);
}
const arrowPart = (ds) => ({ d: [].concat(ds).join(""), fill: COL.arrow, shade: "rim", gloss: false, highlight: false, thin: true });

/** A rectangle along direction u from a (s0 → s1 along, w across) as points. */
function segPts(a, u, s0, s1, w) {
  const n = [-u[1], u[0]];
  const p0 = add2(a, u, s0), p1 = add2(a, u, s1);
  return [add2(p0, n, -w / 2), add2(p1, n, -w / 2), add2(p1, n, w / 2), add2(p0, n, w / 2)];
}

/** Keep the part of convex polygon `poly` nearer to a than to b (minus half a gap). */
function halfClip(poly, a, b, gap = 0) {
  const l = dist(a, b) || 1, u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const val = (p) => (p[0] - m[0]) * u[0] + (p[1] - m[1]) * u[1] + gap / 2;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], vp = val(p), vq = val(q);
    if (vp <= 0) out.push(p);
    if ((vp <= 0) !== (vq <= 0)) { const t = vp / (vp - vq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}
/** Voronoi-like cells around seeds, each limited to a radius (nucleus expansion), clipped to `clip`. */
function cellsAround(seeds, { radius = () => 14, clip = null, gap = 1, n = 28, seed = 3, wobble = 0.08 } = {}) {
  const R = rng(seed);
  return seeds.map((s, i) => {
    const r = radius(i);
    let poly = circPts(s[0], s[1], r, n).map(([x, y]) => { const k = 1 + (R() - 0.5) * 2 * wobble; return [s[0] + (x - s[0]) * k, s[1] + (y - s[1]) * k]; });
    for (let j = 0; j < seeds.length; j++) if (j !== i && dist(s, seeds[j]) < r * 2.4) poly = halfClip(poly, s, seeds[j], gap);
    if (clip) poly = clipConvex(poly, clip);
    return poly;
  });
}
/** Hexagonal lattice points inside a rectangle. */
function hexLattice(x0, y0, x1, y1, pitch, { odd = 0 } = {}) {
  const out = [], dy = pitch * Math.sqrt(3) / 2;
  for (let j = 0; y0 + j * dy <= y1 + 1e-6; j++) {
    const off = (j + odd) % 2 ? pitch / 2 : 0;
    for (let x = x0 + off; x <= x1 + 1e-6; x += pitch) out.push([x, y0 + j * dy, j]);
  }
  return out;
}

/* ---------------- slides ---------------- */

/** Thin division line at the inner edge of a frosted label end. */
const frostLine = (d) => ({ d, fill: "none", stroke: { color: COL.frostLine, width: 0.8, cap: "butt" }, lineColor: shade(COL.frostLine, 0.15), lineStrokeWidth: 0.8 });

/**
 * A glass slide seen from above: edge (thickness), glass face and a whiter, matte frosted label end
 * across the full width of the slide, set off by a division line (no glare on it). The frost shows
 * in both styles: in line style it is inset by 0.9 so it never covers the slide's outline, and its
 * own outline is invisible (same colour, hairline).
 */
function slideTop(x, y, w, h, { label = 0.26, r = 3, glare = null } = {}) {
  const parts = [
    { d: rect(x + 1.6, y + 3, w, h, r), fill: COL.glassEdge },
    { d: rect(x, y, w, h, r), fill: COL.glass },
  ];
  const lx = x + w * label;
  const frostD = (k) => clipD(rrPts(x + k, y + k, w - 2 * k, h - 2 * k, Math.max(0.6, r - k), 6), rectPoly(x - 1, y - 1, lx - x + 1, h + 2));
  if (label) parts.push({ d: frostD(0), fill: COL.frost, line: false }, { d: frostD(0.9), fill: COL.frost, soft: false, lineColor: COL.frost, lineWidth: 0.1 });
  parts.push(...faceShade(x, y, w, h, r, COL.glass, { bw: 2.2, hw: 2, light: 0.7 }));
  if (label) parts.push(frostLine(polyline([[lx, y + 0.4], [lx, y + h - 0.4]])));
  if (glare) parts.push(glow(polyD([[glare, y + 1], [glare + 12, y + 1], [glare - 14, y + h - 1], [glare - 26, y + h - 1]]), 0.5), glow(polyD([[glare + 17, y + 1], [glare + 21, y + 1], [glare - 5, y + h - 1], [glare - 9, y + h - 1]]), 0.4));
  return parts;
}

/**
 * Fiducial frame around a capture area: a square ring of dots with distinct corner markers
 * (hourglass top left, filled hexagon top right, triangle bottom left, open hexagon bottom right),
 * so that imaging software can find and orient the array.
 */
function fiducialD(cx, cy, half, { n = 12, dot = 0.8, mk = 2.2 } = {}) {
  const d = [];
  for (let i = 1; i < n; i++) {
    const t = -half + (2 * half * i) / n;
    d.push(circle(cx + t, cy - half, dot), circle(cx + t, cy + half, dot), circle(cx - half, cy + t, dot), circle(cx + half, cy + t, dot));
  }
  const x0 = cx - half, x1 = cx + half, y0 = cy - half, y1 = cy + half;
  d.push(polyD([[x0 - mk, y0 - mk], [x0 + mk, y0 - mk], [x0, y0]]), polyD([[x0 - mk, y0 + mk], [x0, y0], [x0 + mk, y0 + mk]]));
  d.push(polyD(circPts(x1, y0, mk * 0.95, 6)));
  d.push(polyD([[x0, y1 - mk], [x0 + mk, y1 + mk * 0.8], [x0 - mk, y1 + mk * 0.8]]));
  d.push(polyD(circPts(x1, y1, mk, 6)) + holeD(circPts(x1, y1, mk * 0.5, 6)));
  return d.join("");
}

/** Colour index (0–3) of every square of an n × n Visium HD lawn: [i = column][j = row]. */
function lawnIndex(seed, n) {
  const R = rng(seed);
  return Array.from({ length: n }, () => Array.from({ length: n }, () => Math.floor(R() * COL.lawn.length)));
}
const HD_N = 36;

/** Capture area of a Visium slide: barcoded spots (hexagonal) or, for Visium HD, a continuous lawn of 2 µm squares. */
function captureArea(cx, cy, half, { hd = false, seed = 4, spotR = 0.8, pitch = 2.5 } = {}) {
  const parts = [{ d: rect(cx - half, cy - half, 2 * half, 2 * half, 0.6), fill: COL.area, thin: true, lineWidth: 0.5 }];
  if (!hd) {
    const pts = hexLattice(cx - half + 1.3, cy - half + 1.3, cx + half - 1.3, cy + half - 1.3, pitch);
    parts.push({ d: pts.map(([x, y]) => circle(x, y, spotR)).join(""), fill: COL.spot, lineColor: shade(COL.spot, 0.2), lineWidth: 0.25 });
  } else {
    // a fine, continuous lawn of barcoded squares (36 × 36 drawn; the real area has ~3,250 × 3,250).
    // In line style the squares carry no visible outline (outline = their own colour, hairline), so
    // the lawn stays as light and mottled as in soft style.
    const idx = lawnIndex(seed, HD_N), p = (2 * half) / HD_N, g = 0.1, groups = COL.lawn.map(() => []);
    for (let i = 0; i < HD_N; i++) for (let j = 0; j < HD_N; j++) groups[idx[i][j]].push(rect(cx - half + i * p + g / 2, cy - half + j * p + g / 2, p - g, p - g));
    groups.forEach((gr, k) => parts.push({ d: gr.join(""), fill: COL.lawn[k], lineColor: tint(COL.lawn[k], 0.04), lineWidth: 0.05 }));
  }
  return parts;
}

/**
 * Visium CytAssist slide (v2, 6.5 mm) / Visium HD slide: 75 × 25 mm glass with a label end and two
 * capture areas at positions A1 and D1, each inside a fiducial frame (capture areas drawn ~1.5×
 * larger than true scale so the spots read).
 */
function visiumSlideParts({ hd = false, x = 12, y = 12 } = {}) {
  const w = 234, h = 78, cy = y + h / 2, half = 14.6;
  const parts = slideTop(x, y, w, h, { label: 0.26, glare: x + 150 });
  const centres = [x + 86, x + 204], seeds = [4, 5];
  const fid = [];
  // 6.5 mm capture area inside an 8 mm fiducial frame (ratio 1.23)
  centres.forEach((cx, i) => {
    parts.push(...captureArea(cx, cy, half, { hd, seed: seeds[i] }));
    fid.push(fiducialD(cx, cy, half * 1.233));
  });
  parts.push({ d: fid.join(""), fill: COL.fid, lineWidth: 0.3 });
  return { parts, centres, cy, half, seeds };
}

/**
 * Visium slide for direct tissue placement (Visium v1 / standard Spatial Gene Expression slide):
 * 75 × 25 mm glass, label end, then four 6.5 mm capture areas A1–D1 at an even ~13.75 mm pitch,
 * each inside its 8 mm fiducial frame (drawn ~1.4× true scale, like the CytAssist slide).
 */
function visiumDirectSlideParts({ x = 0, y = 0 } = {}) {
  const w = 234, h = 78, cy = y + h / 2, half = 12.2;
  const parts = slideTop(x, y, w, h, { label: 0.26, glare: x + 112 });
  const centres = [0, 1, 2, 3].map((k) => x + 80 + k * 42.5);
  const fid = [];
  centres.forEach((cx, i) => {
    parts.push(...captureArea(cx, cy, half, { seed: 4 + i, spotR: 0.75, pitch: 2.4 }));
    fid.push(fiducialD(cx, cy, half * 1.233, { n: 10, dot: 0.75, mk: 2 }));
  });
  parts.push({ d: fid.join(""), fill: COL.fid, lineWidth: 0.3 });
  return { parts, centres, cy, half };
}

/* ---------------- magnifier ---------------- */

/** Cone lines from a small square (selection) on the object to a lens or inset (behind everything). */
function coneLines(sq, target, { color = "#9fb0c0", w = 1.2 } = {}) {
  const [x, y, s] = sq;
  const corners = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  let a, b;
  if (target.r) {
    const [cx, cy] = target.c, th = Math.atan2(cy - (y + s / 2), cx - (x + s / 2)), n = [-Math.sin(th), Math.cos(th)];
    const key = (p) => (p[0] - x - s / 2) * n[0] + (p[1] - y - s / 2) * n[1];
    const sorted = [...corners].sort((p, q) => key(p) - key(q));
    const rr = target.r + 3;
    const tan = (q, sgn) => {
      const ph = Math.atan2(q[1] - cy, q[0] - cx), al = Math.acos(Math.min(1, rr / dist(q, target.c)));
      const c1 = [cx + rr * Math.cos(ph + al), cy + rr * Math.sin(ph + al)], c2 = [cx + rr * Math.cos(ph - al), cy + rr * Math.sin(ph - al)];
      const k = (p) => (p[0] - cx) * n[0] + (p[1] - cy) * n[1];
      return sgn * k(c1) > sgn * k(c2) ? c1 : c2;
    };
    a = polyline([sorted[0], tan(sorted[0], -1)]);
    b = polyline([sorted[3], tan(sorted[3], 1)]);
  } else {
    const [tx, ty, tw] = target.rect;
    a = polyline([corners[3], [tx, ty]]);
    b = polyline([corners[2], [tx + tw, ty]]);
  }
  return [
    { d: a + b, fill: "none", stroke: { color, width: w } },
    { d: rect(x, y, s, s, 1), fill: "none", stroke: { color: "#4f6478", width: 1.3 } },
  ];
}
/**
 * A band along an arc of radius rc, tapered to points at both ends (angles in degrees on screen:
 * clockwise from 3 o'clock, y down — so 180–270 is the upper-left quadrant).
 */
function arcBand(cx, cy, rc, a0, a1, w, n = 40) {
  const outer = [], inner = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = (a0 + (a1 - a0) * t) * DEG, h = (w / 2) * Math.pow(Math.sin(Math.PI * t), 0.7);
    outer.push([cx + Math.cos(a) * (rc + h), cy + Math.sin(a) * (rc + h)]);
    inner.push([cx + Math.cos(a) * (rc - h), cy + Math.sin(a) * (rc - h)]);
  }
  return polyD([...outer, ...inner.reverse()]);
}
/** Magnifier frame: one evenly coloured flat ring, a tapered light arc at the upper left and a faint shadow arc at the lower right. */
const lensRim = (cx, cy, r) => [
  { d: ringD(cx, cy, r - 0.5, r + 4.5), fill: "#b7c2cd" },
  glow(arcBand(cx, cy, r + 2, 192, 252, 2.2), 0.55),
  dim(arcBand(cx, cy, r + 2, 12, 72, 2), 0.15),
];

/* ---------------- capture chemistry, side view (inside a lens) ---------------- */

/** Group polygons by colour key → parts. */
function groupParts(groups, order, extra = {}) {
  return order.filter((k) => groups[k] && groups[k].length).map((k) => ({ d: groups[k].join(""), fill: COL[k] || k, thin: true, ...(extra[k] || {}) }));
}

/**
 * Visium lens (local coords, lens radius 52; the 55 µm spot is 62 units wide, ~1.13 units per µm):
 * four cells of the section side by side along y ≈ −30, each 22–28 units (20–25 µm) wide, packed
 * with straight shared borders (neighbouring outlines cut along their bisector, 1.6 apart), each
 * with a ~10 × 8 nucleus — so about three cells sit over one spot, as in real Visium data
 * (1–10 cells per spot). Returns the parts and the cell outlines (for routing the mRNAs).
 */
function visiumLensCells(clip) {
  const spec = [
    { c: [-38.5, -27.5], rx: 14.5, ry: 10.5, seed: 21, n: [-36.5, -28.5, 5.2, 4.1, 12] },
    { c: [-12.5, -25.6], rx: 14.2, ry: 10.8, seed: 23, n: [-14.6, -26.6, 5.1, 4.2, -18] },
    { c: [12.4, -28.8], rx: 13.4, ry: 9.8, seed: 25, n: [14.8, -30.2, 4.9, 3.9, 25] },
    { c: [38.2, -26.4], rx: 14.8, ry: 10.6, seed: 27, n: [36.4, -26.9, 5.3, 4.2, -8] },
  ];
  let cells = spec.map((s) => catmull(blobPts(s.c[0], s.c[1], s.rx, s.ry, { n: 9, wobble: 0.06, seed: s.seed }), 6, true));
  cells = cells.map((poly, i) => {
    let q = poly;
    if (i > 0) q = halfClip(q, spec[i].c, spec[i - 1].c, 1.6);
    if (i < spec.length - 1) q = halfClip(q, spec[i].c, spec[i + 1].c, 1.6);
    return q;
  });
  const nucs = spec.map((s) => catmull(blobPts(s.n[0], s.n[1], s.n[2], s.n[3], { n: 8, wobble: 0.07, seed: s.seed + 40, rot: s.n[4] }), 5, true));
  nucs.forEach((nu, i) => assertInside(`visium lens nucleus ${i}`, nu, cells[i], 1.5));
  // separate cells each get their own shadow rim (array d), not one rim across the row
  return {
    parts: [
      { d: cells.map((c) => clipD(c, clip)), fill: COL.cell, shade: "small", thin: true },
      { d: nucs.map((c) => clipD(c, clip)), fill: COL.hema, shade: "small", thin: true },
    ],
    cells, nucs,
  };
}

/**
 * Stereo-seq lens (local coords, lens radius 52): at a 500 nm DNB pitch the lens is only ~4 µm
 * wide, narrower than one cell — so it shows ONE cell spanning the whole view (no lateral borders):
 * its lower membrane a gentle arc at y ≈ −6, cytoplasm above, and only the bottom of its nucleus as
 * a broad cap at the top of the lens. Many nanoballs lie under this one cell.
 */
function stereoLensCell() {
  const Rl = 52, memY = (x) => -5.2 - 4.2 * (x / 50) ** 2 + 0.7 * Math.sin(x / 8.5 + 1.2);
  const xs = [];
  for (let x = -Rl; x <= Rl + 1e-6; x += 1) xs.push(x);
  const mem = xs.map((x) => [x, memY(x)]).filter(([x, y]) => Math.hypot(x, y) < Rl - 0.05);
  // the arc over the top: from the right end of the membrane (angle ≈ −10°) back through −90° (top) to its left end
  const aR = Math.atan2(mem.at(-1)[1], mem.at(-1)[0]), aL = Math.atan2(mem[0][1], mem[0][0]);
  const arc = [];
  for (let i = 1; i < 60; i++) { const a = aR + ((aL - aR) * i) / 60; arc.push([Math.cos(a) * Rl, Math.sin(a) * Rl]); }
  const cell = [...mem, ...arc];
  // the membrane: a slightly darker band along the lower outline, inside the cell
  const band = [...mem, ...mem.map(([x, y]) => [x, y - 1.7]).reverse()];
  const nuc = clipConvex(catmull(blobPts(-5, -67, 47, 29.5, { n: 10, wobble: 0.04, seed: 9 }), 6, true), circPts(0, 0, Rl, 96));
  return {
    parts: [
      { d: polyD(cell), fill: COL.cell, thin: true },
      { d: polyD(band), fill: shade(COL.cell, 0.07), line: false },
      { d: polyD(nuc), fill: COL.hema, shade: "rim", thin: true },
    ],
    memY,
  };
}

/** mRNA body from the top of its poly(A) tail up into a cell: a smooth wandering strand ending at `to`. */
function mrnaBody(from, to, { seed = 1, wander = 3.5 } = {}) {
  const R = rng(seed), pts = [from];
  for (let i = 1; i < 4; i++) {
    const t = i / 4;
    pts.push([from[0] + (to[0] - from[0]) * t + (R() - 0.5) * 2 * wander, from[1] + (to[1] - from[1]) * t]);
  }
  pts.push(to);
  return smoothOpen(pts);
}

/**
 * Side view of capture inside a lens (local coords, centre 0,0, radius 52):
 *  visium — one 55 µm spot: a pad of capture oligos [Read 1 | spatial barcode | UMI | poly(dT)]
 *           (all with the same spot barcode) under the cells of the section; released poly(A)
 *           mRNAs hybridise to the poly(dT) ends;
 *  stereo — DNA nanoballs (DNBs, ~220 nm) at 500 nm pitch on the chip, each carrying capture
 *           probes [CID coordinate barcode (one per DNB) | MID (UMI) | poly(T)].
 */
function captureLensLocal(kind = "visium") {
  const Rl = 52, clip = circPts(0, 0, Rl, 96);
  const parts = [{ d: circle(0, 0, Rl), fill: "#f8eef3" }];
  const g = {}, push = (k, d) => (g[k] = g[k] || []).push(d);
  const mr = { tail: [], body: [] };
  if (kind === "visium") {
    const cl = visiumLensCells(clip);
    parts.push(...cl.parts);
    // the spot (pad) and glass sit low in the lens, leaving room for the mRNAs between the cells and the oligo tips
    const yb = 32;
    parts.push({ d: clipD([[-60, yb + 3], [60, yb + 3], [60, 60], [-60, 60]], clip), fill: COL.glass });
    parts.push({ d: rect(-31, yb - 0.5, 62, 5, 2), fill: COL.spot, thin: true });
    const segs = [["r1", 10], ["bc", 8], ["umi", 5], ["polyT", 10]];
    // three captured mRNAs, each from a different cell (B, C, D), their poly(A) tails paired
    // alongside a poly(dT) end: probe index → [side of the tail, end point inside the cell]
    const capt = { 1: [1, [-9.5, -18.5]], 4: [1, [16.5, -22]], 6: [-1, [33.5, -19]] };
    for (let i = 0; i < 7; i++) {
      const x = -25.2 + i * 8.4, base = [x, yb], u = [0, -1];
      let s = 0;
      for (const [k, L] of segs) {
        const last = k === "polyT";
        push(k, last ? capsule(x, yb - s - 1, x, yb - s - L + 1.6, 1.8) : polyD(segPts(base, u, s, s + L + 0.15, 3.6)));
        s += L;
      }
      if (capt[i]) {
        const [side, to] = capt[i], a0 = [x + side * 3.4, yb - s - 0.5];
        mr.tail.push(capsule(a0[0], a0[1], a0[0], a0[1] + 9, 1.25));
        mr.body.push(mrnaBody(a0, to, { seed: 30 + i, wander: 2.5 }));
        assertInside(`mRNA end in cell (probe ${i})`, [to], cl.cells[i === 1 ? 1 : i === 4 ? 2 : 3], 2);
      }
    }
    // a fourth mRNA, released from cell A, still on its way down (poly(A) tail first)
    mr.body.push(mrnaBody([-37.6, -0.5], [-40.5, -20], { seed: 7, wander: 2.2 }));
    mr.tail.push(capsule(-37.6, -0.5, -37.2, 7.5, 1.25));
    parts.push(...groupParts(g, ["r1", "bc", "umi", "polyT"]));
    parts.push({ d: mr.body.join(""), fill: "none", stroke: { color: COL.mrna, width: 2.2, cap: "round" }, lineColor: shade(COL.mrna, 0.1) });
    parts.push({ d: mr.tail.join(""), fill: COL.polyA, thin: true });
    return parts;
  }
  // Stereo-seq: one cell over seven DNBs (~220 nm balls at a 500 nm pitch: 13 units), each carrying
  // three capture probes [CID coordinate barcode (one colour per DNB) | MID (UMI) | poly(T)], 1.8
  // wide, anchored at −40°, 0° and +40° on the ball and fanned so that no two probes touch. Where a
  // middle probe has captured an mRNA, its sibling on the tail side leans out a little further (13°)
  // and the facing probe of the next DNB leans in (5°), to keep the tail clear of both.
  const sc = stereoLensCell();
  parts.push(...sc.parts);
  parts.push({ d: clipD([[-60, 24], [60, 24], [60, 60], [-60, 60]], clip), fill: COL.chip });
  const ANG = [[-9, 0, 9], [-9, 0, 13], [-5, 0, 5], [-13, 0, 9], [-9, 0, 9], [-9, 0, 13], [-5, 0, 9]];
  const CAPT = { 1: [1, [-30, -17]], 3: [-1, [-5.5, -21]], 5: [1, [33, -15.5]] };
  const segs = [["cid", -1.2, 6], ["umi", 6, 10], ["polyT", 10, 17]], cy = 20.4, rB = 3.2, w = 1.8;
  const balls = [], axes = [];
  ANG.forEach((fan, j) => {
    const cx = -39 + 13 * j;
    balls.push(circle(cx, cy, rB));
    [-40, 0, 40].forEach((aa, m) => {
      const anchor = [cx + Math.sin(aa * DEG) * rB, cy - Math.cos(aa * DEG) * rB];
      const u = [Math.sin(fan[m] * DEG), -Math.cos(fan[m] * DEG)];
      for (const [k, s0, s1] of segs) {
        const key = k === "cid" ? `cid${j}` : k;
        if (k === "polyT") {
          const b0 = add2(anchor, u, s0 + w / 2), e = add2(anchor, u, s1 - w / 2);
          push(key, capsule(b0[0], b0[1], e[0], e[1], w / 2));
        } else push(key, polyD(segPts(anchor, u, s0, s1 + 0.15, w)));
      }
      axes.push([anchor, add2(anchor, u, 17)]);
      if (m === 1 && CAPT[j]) {
        const [side, to] = CAPT[j], n = [-u[1], u[0]];
        const t0 = add2(add2(anchor, u, 17.5 - 0.85), n, side * 2.6), t1 = add2(add2(anchor, u, 11 + 0.85), n, side * 2.6);
        mr.tail.push(capsule(t0[0], t0[1], t1[0], t1[1], 0.85));
        mr.body.push(mrnaBody(add2(add2(anchor, u, 17.5), n, side * 2.6), to, { seed: 50 + j, wander: 2.2 }));
      }
    });
  });
  // development check: probes on neighbouring axes keep ≥ 0.25 clear between their edges
  const segDist = (a, b, c, d) => {
    const pd = (p, q, r) => { const dx = r[0] - q[0], dy = r[1] - q[1], l2 = dx * dx + dy * dy; const t = Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / l2)); return Math.hypot(p[0] - q[0] - t * dx, p[1] - q[1] - t * dy); };
    return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b));
  };
  for (let i = 0; i + 1 < axes.length; i++) {
    const gap = segDist(add2(axes[i][0], [0, -1], 0.6), axes[i][1], add2(axes[i + 1][0], [0, -1], 0.6), axes[i + 1][1]) - w;
    if (gap < 0.25) console.warn(`  ! stereo lens: probes ${i} and ${i + 1} only ${gap.toFixed(2)} apart`);
  }
  parts.push(...groupParts(g, ["cid0", "cid1", "cid2", "cid3", "cid4", "cid5", "cid6", "umi", "polyT"], Object.fromEntries(["cid0", "cid1", "cid2", "cid3", "cid4", "cid5", "cid6", "umi", "polyT"].map((k) => [k, { lineWidth: 0.3 }]))));
  // the nanoballs on top of the probe bases, so every probe is anchored on its ball
  parts.push({ d: balls.join(""), fill: COL.dnb, shade: "small", lineWidth: 0.45 });
  parts.push({ d: mr.body.join(""), fill: "none", stroke: { color: COL.mrna, width: 1.6, cap: "round" }, lineColor: shade(COL.mrna, 0.1) });
  parts.push({ d: mr.tail.join(""), fill: COL.polyA, thin: true, lineWidth: 0.3 });
  return parts;
}
const captureLens = (cx, cy, r, kind) => [...xform(captureLensLocal(kind), place({ x: cx, y: cy, s: r / 52 })), ...lensRim(cx, cy, r)];

/* ---------------- Visium: spot array under a section ---------------- */

/** A tissue section outline (dense points), H&E-like fill colours handled by the caller. */
const sectionPts = (cx, cy, rx, ry, seed, n = 11, wobble = 0.12) => catmull(blobPts(cx, cy, rx, ry, { n, wobble, seed }), 8, true);

function visiumSpotArrayParts() {
  const parts = [];
  const X0 = 8, Y0 = 26, S = 128;
  const clip = rrPts(X0, Y0, S, S, 6);
  parts.push({ d: rect(X0, Y0, S, S, 6), fill: "#e6f2fa" }, ...faceShade(X0, Y0, S, S, 6, "#e6f2fa", { bw: 2.4, hw: 2, light: 0.6 }));
  const pitch = 11.6, sr = pitch * 0.275; // 55 µm spots at 100 µm centre-to-centre
  const spots = hexLattice(X0 + 7, Y0 + 7, X0 + S - 7, Y0 + S - 7, pitch);
  parts.push({ d: spots.map(([x, y]) => circle(x, y, sr)).join(""), fill: COL.spot, shade: "small", lineWidth: 0.6 });
  // the section covers most of the array (cut by the edge of the view, 2.5 units inside the frame
  // so the array's edge band stays visible); only whole nuclei are drawn
  const secClip = rrPts(X0 + 2.5, Y0 + 2.5, S - 5, S - 5, 4);
  const sec = sectionPts(X0 + 74, Y0 + 70, 66, 58, 8, 11, 0.13);
  const secIn = clipConvex(sec, secClip);
  parts.push({ d: polyD(secIn), fill: COL.tissue, opacity: 0.8, lineWidth: 0.9 });
  const deep = sectionPts(X0 + 50, Y0 + 92, 22, 16, 3, 8, 0.15);
  parts.push({ d: clipD(deep, secClip), fill: COL.tissueDeep, opacity: 0.55, line: false });
  // nuclei at true density: ~20 µm-sized marks (rx 1.0–1.3) at a minimum spacing of 4.2 (~36 µm),
  // i.e. 4–6 per 100 µm spot pitch, so every 55 µm spot sits under several cells; denser, clustered
  // in the darker deep patch (an infiltrate). Only whole nuclei are drawn.
  const R = rng(9), deepIn = (p) => inside(deep, p);
  const okNuc = (p) => inside(secIn, p) && minEdge(secIn, p) > 1.7;
  const dense = clustered(rng(14), { x: X0 + 26, y: Y0 + 74, w: 48, h: 36 }, 70, { clusters: 3, spread: 0.3, minDist: 3.1, test: (p) => okNuc(p) && deepIn(p) && minEdge(deep, p) > 1.2 });
  const sparse = packWhere({ x: X0, y: Y0, w: S, h: S }, 900, 4.2, (p) => okNuc(p) && !(deepIn(p) && minEdge(deep, p) > 1.2) && dense.every((q) => dist(p, q) > 3.4), { seed: 4, tries: 300 });
  const nuc = [...sparse, ...dense];
  parts.push({ d: nuc.map(([x, y]) => ellR(x, y, 1.0 + R() * 0.3, 0.75 + R() * 0.25, R() * 180)).join(""), fill: COL.hema, opacity: 0.8, lineWidth: 0.25 });
  // the magnified spot
  const pick = spots.filter(([x, y]) => inside(sec, [x, y])).sort((a, b) => dist(a, [X0 + 104, Y0 + 52]) - dist(b, [X0 + 104, Y0 + 52]))[0];
  const L = [186, 114], lr = 50;
  const cone = coneLines([pick[0] - 6.5, pick[1] - 6.5, 13], { c: L, r: lr });
  return [...parts, ...cone, ...captureLens(L[0], L[1], lr, "visium")];
}

/* ---------------- Visium HD ---------------- */

/**
 * 2 µm squares (unique barcodes → random tints) with bin outlines. idx: optional colour-index grid
 * ([column][row]) so an inset can repeat exactly the squares under a selection box.
 */
function hdGrid(x, y, n, p, { seed = 6, gap = 0.4, idx = null } = {}) {
  const R = rng(seed), groups = COL.lawn.map(() => []);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) groups[idx ? idx[i][j] : Math.floor(R() * groups.length)].push(rect(x + i * p + gap / 2, y + j * p + gap / 2, p - gap, p - gap, 0.6));
  return groups.map((g, k) => ({ d: g.join(""), fill: COL.lawn[k], lineWidth: 0.45 }));
}
const binBox = (x, y, s, color, w = 2) => ({ d: rect(x, y, s, s, 1.2), fill: "none", stroke: { color, width: w }, lineColor: shade(color, 0.12), lineStrokeWidth: w });

function visiumHdParts() {
  const { parts, centres, cy, half: capHalf, seeds } = visiumSlideParts({ hd: true });
  const p = 6.8, n = 12, ix = 158, iy = 110, side = n * p, m = 2.5;
  // the selection box on D1 covers exactly 12 × 12 lawn squares, the same squares (and colours)
  // that the inset shows
  const lp = (2 * capHalf) / HD_N, i0 = 22, j0 = 8;
  const sq = [centres[1] - capHalf + i0 * lp, cy - capHalf + j0 * lp, n * lp];
  const lawn = lawnIndex(seeds[1], HD_N), sub = Array.from({ length: n }, (_, i) => lawn[i0 + i].slice(j0, j0 + n));
  const pane = [ix - m, iy - m, side + 2 * m];
  const cone = coneLines(sq, { rect: pane });
  // magnifier lines drawn over the slide so they visibly leave the selector box on D1
  const out = [...parts, cone[0], cone[1]];
  // inset: the continuous grid of 2 × 2 µm barcoded squares, with an 8 µm bin (4 × 4 squares)
  // and a 16 µm bin (8 × 8 squares) outlined; an even 2.5-unit margin all round holds the
  // pane's edge shading, outside the grid
  out.push({ d: rect(pane[0], pane[1], pane[2], pane[2], 3), fill: "#e8f1f9" }, ...faceShade(pane[0], pane[1], pane[2], pane[2], 3, "#e8f1f9", { bw: 1.8, hw: 1.5, dark: 0.12, light: 0.7 }));
  out.push(...hdGrid(ix, iy, n, p, { idx: sub }));
  out.push(binBox(ix + 8 * p, iy, 4 * p, COL.bin8), binBox(ix, iy + 4 * p, 8 * p, COL.bin16));
  // binning ladder on one baseline, at the inset's scale: one 2 µm square → an 8 µm bin (4 × 4
  // squares) → a 16 µm bin (8 × 8 squares)
  const yb = iy + side, k = [], gapK = 15, wK = p + gapK + 4 * p + gapK + 8 * p;
  const k0 = 12 + (ix - 12 - 10 - wK) / 2, k1 = k0 + p + gapK, k2 = k1 + 4 * p + gapK;
  k.push(...hdGrid(k0, yb - p, 1, p, { seed: 2 }), binBox(k0, yb - p, p, "#7d8c9c", 1.2));
  k.push(...hdGrid(k1, yb - 4 * p, 4, p, { seed: 3 }), binBox(k1, yb - 4 * p, 4 * p, COL.bin8));
  k.push(...hdGrid(k2, yb - 8 * p, 8, p, { seed: 5 }), binBox(k2, yb - 8 * p, 8 * p, COL.bin16));
  const ay = yb - p / 2;
  k.push(arrowPart([arrowAlong([k0 + p + 3, ay], [k1 - 3, ay], 3.4, 2), arrowAlong([k1 + 4 * p + 3, ay], [k2 - 3, ay], 3.4, 2)]));
  // merge the key's squares into the inset's colour parts (one part per colour)
  const merged = out.concat(k);
  return mergeByFill(merged);
}
/** Merge consecutive-or-not parts that share fill and style into one (keeps first position). */
function mergeByFill(parts) {
  const out = [], seen = new Map();
  for (const p of parts) {
    // shading overlays (line: false) stay where they are, above the face they shade
    if (p.unite || p.stroke || Array.isArray(p.d) || p.fill === "none" || p.line === false) { out.push(p); continue; }
    const key = JSON.stringify({ ...p, d: 0 });
    if (seen.has(key)) seen.get(key).d += p.d;
    else { const q = { ...p }; seen.set(key, q); out.push(q); }
  }
  return out;
}

/* ---------------- CytAssist: probe transfer between two slides (oblique view) ---------------- */

const OB = { kx: 0.5, ky: 0.44 };
const ob = (o, u, v, z = 0) => [o[0] + u + v * OB.kx, o[1] - v * OB.ky - z];
/** Slide slab in oblique view: right side, front edge, top face (draw in that order). */
function slab(o, U, V, T, fill, { topOpacity, sideOpacity } = {}) {
  const c = (u, v, z) => ob(o, u, v, z), so = sideOpacity ? { opacity: sideOpacity } : {};
  return [
    { d: polyD([c(U, 0, 0), c(U, V, 0), c(U, V, T), c(U, 0, T)]), fill: shade(fill, 0.2), thin: true, ...so },
    { d: polyD([c(0, 0, 0), c(U, 0, 0), c(U, 0, T), c(0, 0, T)]), fill: shade(fill, 0.1), thin: true, ...so },
    { d: polyD([c(0, 0, T), c(U, 0, T), c(U, V, T), c(0, V, T)]), fill, ...(topOpacity ? { opacity: topOpacity } : {}) },
  ];
}
const obPoly = (o, pts, z) => polyD(pts.map(([u, v]) => ob(o, u, v, z)));

/** A ligated probe pair (left probe | right probe | poly(A)) as three shapes along a direction. */
function probePair(c, ang, s = 1) {
  const u = [Math.cos(ang * DEG), Math.sin(ang * DEG)], a = add2(c, u, -8 * s);
  return {
    lhs: polyD(segPts(a, u, 0, 6.2 * s, 3 * s)),
    rhs: polyD(segPts(a, u, 6.2 * s, 12.4 * s, 3 * s)),
    tail: (() => { const p0 = add2(a, u, 13 * s), p1 = add2(a, u, 16.5 * s); return capsule(p0[0], p0[1], p1[0], p1[1], 1.1 * s); })(),
  };
}

function cytassistParts() {
  const U = 150, V = 50, T = 3.5, oT = [22, 40], oB = [22, 150];
  // D1 (and the section above it) sit well back from the front edge (v 15–45 of 50), so the film's
  // projected outline stays clear of the slide's front-face band. The tissue slide is shifted 25
  // units (12.5 mm) along u, so the section over D1 lies in its middle: ≥ 15 mm (30 units) from both
  // short ends and ≥ 5 mm (10 units) from both long edges, as CytAssist requires; that slide
  // overhangs the Visium slide's right end. (u, v of the section are in the Visium slide's frame.)
  const cu = 124, cv = 29.5, half = 13, fh = 16, SH = 25, oTs = [oT[0] + SH, oT[1]];
  const parts = [];
  const frostEnd = (o) => [
    { d: obPoly(o, [[0.8, 0.8], [36, 0.8], [36, V - 0.8], [0.8, V - 0.8]], T), fill: COL.frost, lineColor: COL.frost, lineWidth: 0.1 },
    frostLine(polyline([ob(o, 36, 0.6, T), ob(o, 36, V - 0.6, T)])),
  ];
  // bottom: the Visium CytAssist slide, face up — label end and capture areas A1 / D1
  parts.push(...slab(oB, U, V, T, COL.glass));
  parts.push(...frostEnd(oB));
  const fidB = [];
  for (const u0 of [58, cu]) {
    parts.push({ d: obPoly(oB, [[u0 - half, cv - half], [u0 + half, cv - half], [u0 + half, cv + half], [u0 - half, cv + half]], T), fill: COL.area, thin: true });
    const dots = hexLattice(u0 - half + 1.5, cv - half + 1.5, u0 + half - 1.5, cv + half - 1.5, 2.6).map(([u, v]) => ob(oB, u, v, T));
    parts.push({ d: dots.map(([x, y]) => ellipse(x, y, 0.8, 0.6)).join(""), fill: COL.spot, lineColor: shade(COL.spot, 0.2), lineWidth: 0.2 });
    for (let i = 0; i <= 10; i++) {
      const t = -fh + (2 * fh * i) / 10;
      for (const [u, v] of [[u0 + t, cv - fh], [u0 + t, cv + fh], [u0 - fh, cv + t], [u0 + fh, cv + t]]) { const [x, y] = ob(oB, u, v, T); fidB.push(ellipse(x, y, 0.75, 0.6)); }
    }
  }
  parts.push({ d: fidB.join(""), fill: COL.fid, lineWidth: 0.2 });
  // the section hangs under the top slide as a thin film (5–10 µm on 1 mm glass): its underside is
  // at z = -ZS, well inside the slide's footprint; 31 × 22 units (15.5 × 11 mm)
  const ZS = 1;
  const sec = sectionPts(cu, 28, 15.5, 10.6, 6, 9, 0.1);
  // alignment guides from the section's extreme points (leftmost, rightmost, front-most, back-most,
  // on its projected underside) down to the matching edges of capture area D1 below it
  const ext = [
    sec.reduce((a, p) => (p[0] < a[0] ? p : a)), sec.reduce((a, p) => (p[0] > a[0] ? p : a)),
    sec.reduce((a, p) => (p[1] < a[1] ? p : a)), sec.reduce((a, p) => (p[1] > a[1] ? p : a)),
  ];
  const cV = (v) => Math.max(cv - half + 2, Math.min(cv + half - 2, v)), cU = (u) => Math.max(cu - half + 2, Math.min(cu + half - 2, u));
  const ends = [[cu - half, cV(ext[0][1])], [cu + half, cV(ext[1][1])], [cU(ext[2][0]), cv - half], [cU(ext[3][0]), cv + half]];
  const guides = ext.map((p, i) => polyline([ob(oT, p[0], p[1], -ZS), ob(oB, ends[i][0], ends[i][1], T)]));
  parts.push({ d: guides.join(""), fill: "none", stroke: { color: "#9fb0c0", width: 0.9, dash: [3, 3] }, lineStrokeWidth: 0.8 });
  // probes released from the section (RNase + permeabilisation) drifting down onto the spots
  const top = ob(oT, cu, cv, -ZS), bot = ob(oB, cu, cv, T);
  const R = rng(5), pr = { lhs: [], rhs: [], tail: [] };
  const addProbe = (p, ang) => { const q = probePair(p, ang, 1); pr.lhs.push(q.lhs); pr.rhs.push(q.rhs); pr.tail.push(q.tail); };
  const pts = packWhere({ x: top[0] - 16, y: top[1] + 22, w: 32, h: bot[1] - top[1] - 32 }, 9, 12, () => true, { seed: 12 });
  for (const p of pts) addProbe(p, 60 + R() * 60 + (R() < 0.5 ? 180 : 0));
  parts.push({ d: pr.lhs.join(""), fill: COL.lhs, thin: true }, { d: pr.rhs.join(""), fill: COL.rhs, thin: true }, { d: pr.tail.join(""), fill: COL.polyA, thin: true });
  parts.push(arrowPart([arrowAlong([top[0] - 34, top[1] + 24], [top[0] - 34, bot[1] - 24], 6, 2), arrowAlong([top[0] + 36, top[1] + 24], [top[0] + 36, bot[1] - 24], 6, 2)]));
  // top: the tissue slide turned face down — the section is a thin film on the glass underside,
  // seen through the glass; probe pairs leave its underside
  // the film's own (slight) thickness: a sliver of side wall along its front edge
  parts.push({ unite: [polyD(sec.map(([u, v]) => ob(oT, u, v, -ZS))), ...sec.map((p, i) => { const q = sec[(i + 1) % sec.length]; return polyD([ob(oT, p[0], p[1], -ZS), ob(oT, q[0], q[1], -ZS), ob(oT, q[0], q[1], 0), ob(oT, p[0], p[1], 0)]); })], fill: COL.tissue, lineWidth: 0.8 });
  parts.push({ d: polyD(sec.map(([u, v]) => ob(oT, u, v, 0))), fill: COL.tissue, lineWidth: 0.8 });
  const Rn = rng(3), nuc = packWhere({ x: cu - 18, y: 15, w: 36, h: 26 }, 30, 3.5, (p) => inside(sec, p) && minEdge(sec, p) > 1.5, { seed: 6 }).map(([u, v]) => ob(oT, u, v, 0));
  parts.push({ d: nuc.map(([x, y]) => ellipse(x, y, 1.1 + Rn() * 0.4, 0.8)).join(""), fill: COL.hema, opacity: 0.85, lineWidth: 0.25 });
  // probe pairs leaving the film's lower outline (front edge); their first few units are seen
  // through the glass edge, so they are drawn before the slide
  const leave = { lhs: [], rhs: [], tail: [] };
  [[cu - 10, 76], [cu - 1, 98], [cu + 9, 84]].forEach(([u, ang]) => {
    const front = sec.filter((p) => Math.abs(p[0] - u) < 2.5).sort((a, b) => a[1] - b[1])[0];
    const o = ob(oT, u, front[1], -ZS), dir = [Math.cos(ang * DEG), Math.sin(ang * DEG)];
    const q = probePair(add2(o, dir, 7.2), ang, 0.9);
    leave.lhs.push(q.lhs); leave.rhs.push(q.rhs); leave.tail.push(q.tail);
  });
  parts.push({ d: leave.lhs.join(""), fill: COL.lhs, thin: true }, { d: leave.rhs.join(""), fill: COL.rhs, thin: true }, { d: leave.tail.join(""), fill: COL.polyA, thin: true });
  // the glass of the tissue slide lies over the section. Soft: its tint has the film's projected
  // footprint cut out, so the section shows in true H&E colours under clear glass; line: a faint
  // tint over everything. Glare stripes on the glass on either side of the section.
  const [sideF, frontF, topF] = slab(oTs, U, V, T, COL.glass, { sideOpacity: 0.7 });
  const foot = sec.map(([u, v]) => ob(oT, u, v, v < 28 ? -ZS : 0));
  const facePts = [[0, 0], [U, 0], [U, V], [0, V]].map(([u, v]) => ob(oTs, u, v, T));
  // the hole winds against the face (nonzero fill)
  const hole = Math.sign(signedArea(foot)) === Math.sign(signedArea(facePts)) ? [...foot].reverse() : foot;
  parts.push(sideF, frontF);
  parts.push({ ...topF, d: polyD(facePts) + polyD(hole), opacity: 0.6, line: false });
  parts.push({ ...topF, opacity: 0.3, soft: false });
  parts.push(...frostEnd(oTs));
  parts.push(glow(obPoly(oT, [[72, 2], [82, 2], [92, V - 2], [82, V - 2]], T), 0.5));
  parts.push(glow(obPoly(oT, [[cu + 18, 2], [cu + 26, 2], [cu + 36, V - 2], [cu + 28, V - 2]], T), 0.5));
  parts.push(glow(obPoly(oT, [[cu + 30, 2], [cu + 33, 2], [cu + 43, V - 2], [cu + 40, V - 2]], T), 0.42));
  return parts;
}

/* ---------------- Xenium: padlock probes, RCA, puncta ---------------- */

/** Points of a closed curve split into runs by class → band polygons (outer/inner offsets). */
function bandRuns(pts, cls, w) {
  const outer = offsetClosed(pts, w / 2), inner = offsetClosed(pts, -w / 2), n = pts.length;
  let s0 = 0;
  while (s0 < n && cls(pts[s0]) === cls(pts[(s0 - 1 + n) % n])) s0++;
  if (s0 === n) s0 = 0;
  const runs = {};
  let cur = [s0], c = cls(pts[s0]);
  for (let k = 1; k <= n; k++) {
    const i = (s0 + k) % n, ci = cls(pts[i]);
    cur.push(i);
    if (ci !== c || k === n) {
      (runs[c] = runs[c] || []).push(polyD([...cur.map((j) => outer[j]), ...cur.map((j) => inner[j]).reverse()]));
      cur = [i];
      c = ci;
    }
  }
  return runs;
}

/**
 * Padlock probe on its target (local: mRNA top at y = 0, centred at x = 0): two target-binding arms
 * (blue) lying on the mRNA, joined at the bottom centre by the ligation that closes the circle (a
 * narrow nick bridged by a dark-teal ligation dot), backbone (grey) and gene-specific code (orange).
 * Returns { back, arm, code, nick } path data, so several padlocks can share one part per colour.
 * sealed: the circle after ligation (no nick), as the RCA template.
 */
function padlockD(t = place(), { sealed = false } = {}) {
  const ctrl = [[-11, -1.6], [0, -1.4], [11, -1.6], [16, -9], [11, -21], [0, -25], [-11, -21], [-16, -9]];
  const c = catmull(ctrl, 8, true);
  const pts = resample([...c, c[0]], 0.25).slice(0, -1);
  const runs = bandRuns(pts, ([x, y]) => (y > -4.6 ? (!sealed && Math.abs(x) < 0.85 ? "gap" : "arm") : y < -19 ? "code" : "back"), 3.4);
  const m = (ds) => ds.map((d) => mapPath(d, t.P)).join("");
  return { back: m(runs.back), arm: m(runs.arm), code: m(runs.code), nick: mapPath(circle(0, -1.5, 1), t.P) };
}
/** Padlock parts (one per colour); lw sets the line-style outline width for small (scaled-down) padlocks. */
const padlockParts = (ps, lw = null) => [
  { d: ps.map((p) => p.back).join(""), fill: "#9db3c9", thin: true, ...(lw ? { lineWidth: lw } : {}) },
  { d: ps.map((p) => p.arm).join(""), fill: COL.r1, thin: true, ...(lw ? { lineWidth: lw } : {}) },
  { d: ps.map((p) => p.code).join(""), fill: COL.bc, thin: true, ...(lw ? { lineWidth: lw } : {}) },
  { d: ps.map((p) => p.nick).join(""), fill: "#2f7f86", thin: true, lineWidth: 0.3 },
];

/** Rolling-circle product: a ball of coiled concatemer with fluorescent detection probes (local, centre 0,0). */
function rcpLocal(r = 21, { seed = 5, fl = FL.g, probes = 11, start = [-r * 0.2, r * 0.9], avoid = () => false } = {}) {
  const R = rng(seed);
  const pts = [start];
  const bad = (q) => Math.hypot(q[0], q[1]) > r - 2.5 || avoid(q);
  let p = start, a = -80 * DEG;
  for (let i = 0; i < 70; i++) {
    a += (R() - 0.5) * 2.2;
    let q = add2(p, [Math.cos(a), Math.sin(a)], 3.4);
    if (bad(q)) { a += Math.PI * (0.6 + R() * 0.3); q = add2(p, [Math.cos(a), Math.sin(a)], 3.4); }
    if (bad(q)) continue;
    p = q;
    pts.push(p);
  }
  const dots = pts.filter((_, i) => i % Math.floor(pts.length / probes) === 3).slice(0, probes);
  return {
    ball: { d: circle(0, 0, r), fill: COL.rcp, opacity: 0.85, shade: "small", gloss: false },
    coil: { d: smoothOpen(pts), fill: "none", stroke: { color: COL.dnb, width: 1.6, cap: "round" } },
    lit: [
      { d: dots.map(([x, y]) => circle(x, y, 3.3)).join(""), fill: fl, opacity: 0.35, line: false },
      { d: dots.map(([x, y]) => circle(x, y, 1.8)).join(""), fill: fl, shade: "small", lineWidth: 0.5 },
    ],
  };
}

/**
 * Lens content: mRNA with a ligated padlock probe → (RCA) → rolling-circle product lit by fluorescent
 * probes. The RCP still holds its circular template — the same padlock, small, on the mRNA at the
 * ball's base — and the concatemer (purple) starts from it.
 */
function xeniumLensLocal({ fl = FL.g } = {}) {
  const parts = [{ d: circle(0, 0, 56), fill: COL.cyto }];
  const m1 = smoothOpen([[-50, 17], [-42, 14.5], [-29, 14], [-16, 14.5], [-7, 17.5]]);
  const m2 = smoothOpen([[7, 26], [18, 23.5], [30, 23], [40, 24], [47, 26.5]]);
  const bc = [28.5, -1.5], rr = 24, ts = 0.35, ty = 21.6;
  const rcp = xform(Object.values((() => {
    const o = rcpLocal(rr, {
      probes: 13, fl,
      start: [0.6, ty - bc[1] - 25 * ts - 0.4],
      avoid: ([x, y]) => Math.abs(x) < 7.5 && y > ty - bc[1] - 25 * ts - 2.5,
    });
    return { ball: o.ball, coil: o.coil, lit0: o.lit[0], lit1: o.lit[1] };
  })()), place({ x: bc[0], y: bc[1] }));
  parts.push(rcp[0]);
  parts.push({ d: m1 + m2, fill: "none", stroke: { color: COL.mrna, width: 3.4, cap: "round" } });
  parts.push(...padlockParts([padlockD(place({ x: -29, y: 13.7, s: 1.3 }))]));
  // the circular template inside the RCP: the same padlock, small and sealed (ligated, no nick),
  // with outlines to match its size
  parts.push(...padlockParts([padlockD(place({ x: bc[0], y: ty, s: ts }), { sealed: true })], 0.35).slice(0, 3));
  parts.push(...rcp.slice(1));
  parts.push(arrowPart(arrowAlong([-6, -4], [4, -4], 5, 2)));
  return parts;
}

/** Field of tissue: polygonal cells with nuclei and bright RCP puncta (fluorescent colours). */
function xeniumFieldParts(X0, Y0, W, H, { seed = 4, puncta = 5, halo = true } = {}) {
  const parts = [];
  const clip = rrPts(X0, Y0, W, H, 6);
  parts.push({ d: rect(X0, Y0, W, H, 6), fill: "#f3dbe4" });
  const seeds = packWhere({ x: X0 - 8, y: Y0 - 8, w: W + 16, h: H + 16 }, 14, 34, () => true, { seed });
  const R = rng(seed + 1);
  const cells = cellsAround(seeds, { radius: () => 26, clip, gap: 2.4, seed });
  parts.push({ d: cells.filter((c) => c.length > 2).map((c) => roundPoly(c, 4)).join(""), fill: COL.cell, stroke: { color: shade(COL.cell, 0.14), width: 0.9 }, lineWidth: 0.9 });
  const nucs = [], dots = { g: [], r: [], y: [], b: [] }, halos = { g: [], r: [], y: [], b: [] }, all = [];
  seeds.forEach((s, i) => {
    const c = cells[i];
    if (c.length < 3 || area(c) < 140) return;
    const ctr = centroid(c), rx = 6.5 + R() * 2, ry = 5 + R() * 1.5;
    const nuc = catmull(blobPts(ctr[0], ctr[1], rx, ry, { n: 7, wobble: 0.08, seed: seed + i, rot: R() * 180 }), 5, true);
    const nc = clipConvex(nuc, clip);
    if (nc.length > 2) nucs.push(polyD(nc));
    const pts = packWhere({ x: ctr[0] - 26, y: ctr[1] - 26, w: 52, h: 52 }, puncta, 6.5, (p) => inside(c, p) && !inside(nuc, p) && dist(p, ctr) > Math.max(rx, ry) + 2 && minEdge(c, p) > 3, { seed: seed + 10 + i });
    pts.forEach((p) => {
      const k = "gryb"[Math.floor(R() * 4)];
      dots[k].push(circle(p[0], p[1], 1.7));
      halos[k].push(circle(p[0], p[1], 3.4));
      all.push({ p, k });
    });
  });
  parts.push({ d: nucs.join(""), fill: COL.hema, shade: "small", lineWidth: 0.8 });
  if (halo) for (const k of "gryb") parts.push({ d: halos[k].join(""), fill: FL[k], opacity: 0.32, line: false });
  for (const k of "gryb") parts.push({ d: dots[k].join(""), fill: FL[k], stroke: { color: shade(FL[k], 0.18), width: 0.5 }, lineWidth: 0.55 });
  return { parts, puncta: all };
}
/** Distance from p to the nearest edge of polygon c. */
function minEdge(c, p) {
  let m = Infinity;
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    m = Math.min(m, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return m;
}

function xeniumChemistryParts() {
  const field = xeniumFieldParts(8, 16, 132, 150, { seed: 4 });
  const L = [212, 92], lr = 56;
  // the boxed punctum and the magnified rolling-circle product are lit in the same channel
  const { p: pick, k } = field.puncta.slice().sort((a, b) => dist(a.p, [118, 64]) - dist(b.p, [118, 64]))[0];
  const cone = coneLines([pick[0] - 5.5, pick[1] - 5.5, 11], { c: L, r: lr });
  return [...field.parts, ...cone, ...xform(xeniumLensLocal({ fl: FL[k] }), place({ x: L[0], y: L[1] })), ...lensRim(L[0], L[1], lr)];
}

/* ---------------- fluorescence image tiles (Xenium output, cyclic imaging) ---------------- */

/** Segmented cells with transcripts coloured by gene on a dark field (Xenium Explorer-like). */
function transcriptMapParts(X0 = 8, Y0 = 8, W = 184, H = 184, { seed = 11, nCells = 34, perArea = 30, dotR = 1.6, cellR = 19, minD = 27 } = {}) {
  const parts = [];
  const clip = rrPts(X0, Y0, W, H, 8);
  parts.push({ d: rect(X0, Y0, W, H, 8), fill: COL.dark, lineWidth: 1.2 });
  const seeds = packWhere({ x: X0 - 6, y: Y0 - 6, w: W + 12, h: H + 12 }, nCells, minD, () => true, { seed });
  const R = rng(seed + 2);
  const cells = cellsAround(seeds, { radius: () => cellR + R() * 3, clip, gap: 2.2, seed });
  // cell types laid out in space: a band of one type, a cluster of another, the rest mixed
  const typeOf = ([x, y]) => {
    const u = (x - X0) / W, v = (y - Y0) / H;
    if (Math.abs(v - (0.25 + u * 0.35)) < 0.13) return 0;
    if (Math.hypot(u - 0.72, v - 0.75) < 0.2) return 1;
    if (u < 0.4 && v > 0.62) return 2;
    return R() < 0.5 ? 3 : 4;
  };
  const cellD = [], nucD = [], dots = GENE.map(() => []);
  // transcript load differs from cell to cell (0.5–1.6× the mean; a few cells only ~40%)
  const live = seeds.map((_, i) => i).filter((i) => cells[i].length > 2 && area(cells[i]) >= 120);
  const Rq = rng(seed + 7), low = new Set();
  const nLow = Math.max(2, Math.round(live.length / 8));
  while (low.size < nLow) low.add(live[Math.floor(Rq() * live.length)]);
  const sep = dotR * 2.05;
  let nAssigned = 0;
  live.forEach((i) => {
    const c = cells[i];
    cellD.push(roundPoly(c, 3.5));
    const ctr = centroid(c), t = typeOf(ctr);
    const nuc = catmull(blobPts(ctr[0], ctr[1], 6.4, 5.2, { n: 7, wobble: 0.1, seed: seed + i, rot: R() * 180 }), 5, true);
    const nc = clipConvex(nuc, clip);
    if (nc.length > 2) nucD.push(polyD(nc));
    const k = Math.max(3, Math.round((area(c) / perArea) * (low.has(i) ? 0.4 : 0.5 + Rq() * 1.1)));
    const inCell = (p) => inside(c, p) && minEdge(c, p) > dotR + 0.6;
    const free = (pts, p) => pts.every((o) => dist(o, p) > sep);
    // ~60% in the perinuclear cytoplasm: clustered on two or three sides of the nucleus, 2–6 units
    // outside its outline; the rest anywhere in the cell (over the nucleus too, as in a 2D projection)
    const peri = (p) => inCell(p) && !inside(nuc, p) && minEdge(nuc, p) >= 2 && minEdge(nuc, p) <= 6;
    const pts = clustered(Rq, { x: ctr[0] - 16, y: ctr[1] - 16, w: 32, h: 32 }, Math.round(k * 0.6), { clusters: 2 + Math.floor(Rq() * 2), spread: 0.3, minDist: sep, test: peri, tries: 900 });
    for (let tr = 0; pts.length < k && tr < k * 120; tr++) {
      const p = [ctr[0] + (Rq() - 0.5) * 50, ctr[1] + (Rq() - 0.5) * 50];
      if (inCell(p) && free(pts, p)) pts.push(p);
    }
    nAssigned += pts.length;
    pts.forEach((p) => {
      const g = R() < 0.82 ? t : Math.floor(R() * GENE.length);
      dots[g].push(circle(p[0], p[1], dotR));
    });
  });
  // a few unassigned transcripts (~4%) in the dark gaps between segmented cells, mixed genes, smaller
  const rU = dotR * 0.85;
  const gapOk = (p) => inside(clip, p) && minEdge(clip, p) > rU + 2 && live.every((i) => !inside(cells[i], p) && minEdge(cells[i], p) > rU * 0.6);
  packWhere({ x: X0, y: Y0, w: W, h: H }, Math.round(nAssigned * 0.04), rU * 4, gapOk, { seed: seed + 99, tries: 3000 })
    .forEach((p) => dots[Math.floor(Rq() * GENE.length)].push(circle(p[0], p[1], rU)));
  parts.push({ d: cellD.join(""), fill: COL.darkCell, stroke: { color: COL.darkLine, width: 0.9 }, lineColor: "#9fb2c8", lineWidth: 0.9 });
  parts.push({ d: nucD.join(""), fill: COL.dapi, opacity: 0.85, lineWidth: 0.6 });
  dots.forEach((ds, g) => parts.push({ d: ds.join(""), fill: GENE[g], lineWidth: 0.35 }));
  return parts;
}

/**
 * Cyclic barcode imaging (MERFISH / CosMx / Xenium-like): the same puncta imaged in four rounds;
 * in each round a punctum lights up in one colour (or stays dark) — the sequence of colours is its
 * barcode, decoded into the gene identity on the right.
 */
function cyclesParts({ decoded = true } = {}) {
  const parts = [];
  const tile = 60, gap = 6, X = 8, Y = 10;
  const origins = [[X, Y], [X + tile + gap, Y], [X, Y + tile + gap], [X + tile + gap, Y + tile + gap]];
  const dec = [X + 2 * tile + gap + 34, Y + tile + gap / 2];
  const D = 70;
  // one shared field: two neighbouring cells (sharing a straight border with a gap, as segmented
  // cells do) with nuclei, and 9 large puncta in the cytoplasm, clear of membranes and nuclei (big
  // enough that the colour change per round survives at thumbnail size)
  const cA = [19, 22], cB = [41, 40];
  const cellsL = [
    halfClip(catmull(blobPts(cA[0], cA[1], 16, 14.5, { n: 8, wobble: 0.08, seed: 2 }), 6, true), cA, cB, 2.6),
    halfClip(catmull(blobPts(cB[0], cB[1], 14.5, 15, { n: 8, wobble: 0.08, seed: 5 }), 6, true), cB, cA, 2.6),
  ];
  const nucL = [catmull(blobPts(15, 23.5, 5.4, 4.8, { n: 7, wobble: 0.08, seed: 3 }), 5, true), catmull(blobPts(43.5, 42.5, 5.1, 5, { n: 7, wobble: 0.08, seed: 4 }), 5, true)];
  const R = rng(17);
  const PR = 2.8, OFF = 1.4, RING = 5.2;
  const okSpot = (p) => {
    const ci = cellsL.findIndex((c) => inside(c, p));
    if (ci < 0 || minEdge(cellsL[ci], p) < PR + 1.3) return false;
    return nucL.every((n) => !inside(n, p) && minEdge(n, p) > PR + 0.9);
  };
  // the ringed punctum (whose colour sequence is followed): left cell, right of its nucleus
  const hiSpot = [27, 16.5];
  const spots = [hiSpot, ...packWhere({ x: 3, y: 5, w: 54, h: 52 }, 8, 8.5, (p) => okSpot(p) && dist(p, hiSpot) > 9.5, { seed: 13, tries: 4000 })];
  // codebook: 4 rounds; 0 = dark, else a channel
  const CH = ["", "g", "r", "y", "b"];
  const code = [[1, 0, 2, 3], [2, 3, 0, 4], [4, 1, 3, 0], [0, 4, 1, 2]];
  const gene = spots.map((_, i) => (i * 7 + Math.floor(R() * 3)) % 4);
  const hiIdx = 0;
  const tiles = [], cellD = [], nucD = [], ch = { g: [], r: [], y: [], b: [] }, off = [], rings = [];
  const at = (o, s, k = 1) => [o[0] + s[0] * k, o[1] + s[1] * k];
  origins.forEach((o, r) => {
    tiles.push(rect(o[0], o[1], tile, tile, 4));
    cellsL.forEach((c) => cellD.push(polyD(c.map((p) => at(o, p)))));
    nucL.forEach((c) => nucD.push(polyD(c.map((p) => at(o, p)))));
    spots.forEach((s, i) => {
      const c = CH[code[gene[i]][r]], p = at(o, s);
      if (c) ch[c].push(circle(p[0], p[1], PR));
      else off.push(circle(p[0], p[1], OFF));
      if (i === hiIdx) rings.push(circle(p[0], p[1], RING));
    });
  });
  const gd = GENE.slice(0, 4).map(() => []);
  if (decoded) {
    const k = D / tile, o = [dec[0], dec[1] - D / 2];
    tiles.push(rect(o[0], o[1], D, D, 4.5));
    cellsL.forEach((c) => cellD.push(polyD(c.map((p) => at(o, p, k)))));
    nucL.forEach((c) => nucD.push(polyD(c.map((p) => at(o, p, k)))));
    spots.forEach((s, i) => {
      const p = at(o, s, k);
      gd[gene[i]].push(circle(p[0], p[1], 3.2));
      if (i === hiIdx) rings.push(circle(p[0], p[1], RING * k));
    });
  }
  parts.push({ d: tiles.join(""), fill: COL.dark, lineWidth: 1.1 });
  parts.push({ d: cellD.join(""), fill: COL.darkCell, stroke: { color: COL.darkLine, width: 0.8 }, lineColor: "#9fb2c8", lineWidth: 0.8 });
  parts.push({ d: nucD.join(""), fill: COL.dapi, opacity: 0.8, lineWidth: 0.5 });
  parts.push({ d: off.join(""), fill: "#56667a", lineWidth: 0.3 });
  for (const c of "gryb") parts.push({ d: ch[c].join(""), fill: FL[c], lineWidth: 0.4 });
  if (decoded) {
    gd.forEach((ds, g) => parts.push({ d: ds.join(""), fill: GENE[g], lineWidth: 0.4 }));
    parts.push(arrowPart(arrowAlong([X + 2 * tile + gap + 6, dec[1]], [dec[0] - 6, dec[1]], 7, 2)));
  }
  parts.push({ d: rings.join(""), fill: "none", stroke: { color: "#f4f6f8", width: 1.3 }, lineColor: "#f4f6f8", lineStrokeWidth: 1.2 });
  return parts;
}

/* ---------------- Stereo-seq ---------------- */

function stereoChipParts() {
  const parts = [];
  const X0 = 10, Y0 = 12, S = 104;
  // the chip: a silicon square with a light frame, the DNB array inside and track lines every ~1.5 mm
  parts.push({ d: rect(X0 + 1.6, Y0 + 3, S, S, 5), fill: "#2f363f" });
  parts.push({ d: rect(X0, Y0, S, S, 5), fill: "#8c97a4" }, ...faceShade(X0, Y0, S, S, 5, "#8c97a4", { bw: 2.4, hw: 2, light: 0.55 }));
  const A = [X0 + 6, Y0 + 6, S - 12];
  parts.push({ d: rect(A[0], A[1], A[2], A[2], 2), fill: COL.chip });
  const tr = [];
  for (let k = 1; k < 6; k++) {
    const t = A[0] + (k * A[2]) / 6, tY = A[1] + (k * A[2]) / 6;
    tr.push(polyline([[t, A[1] + 1], [t, A[1] + A[2] - 1]]), polyline([[A[0] + 1, tY], [A[0] + A[2] - 1, tY]]));
  }
  parts.push({ d: tr.join(""), fill: "none", stroke: { color: COL.track, width: 0.7 }, lineStrokeWidth: 0.6 });
  const sec = sectionPts(X0 + 56, Y0 + 54, 38, 33, 13, 10, 0.12);
  parts.push({ d: polyD(sec), fill: COL.tissue, opacity: 0.88, lineWidth: 0.9 });
  const R = rng(5);
  const nuc = packWhere({ x: X0, y: Y0, w: S, h: S }, 46, 6.6, (p) => inside(sec, p) && minEdge(sec, p) > 2.2, { seed: 8 });
  parts.push({ d: nuc.map(([x, y]) => ellR(x, y, 1.5 + R() * 0.5, 1.1 + R() * 0.4, R() * 180)).join(""), fill: COL.hema, opacity: 0.8, lineWidth: 0.3 });
  parts.push(glow(polyD([[X0 + 18, Y0 + 2], [X0 + 30, Y0 + 2], [X0 + 2, Y0 + 40], [X0 + 2, Y0 + 24]]), 0.25));
  const L = [168, 130], lr = 52;
  // the selection box sits fully on tissue (~0.5 of the section radius from its centre)
  const pick = [X0 + 74, Y0 + 62];
  const cone = coneLines([pick[0] - 5, pick[1] - 5, 10], { c: L, r: lr });
  return [...parts, ...cone, ...captureLens(L[0], L[1], lr, "stereo")];
}

/** StereoCell: ssDNA image → nucleus/cell masks registered on the bin grid (track lines) → cell bins. */
function stereoCellParts() {
  const parts = [];
  const S = 84, Y = 10, xs = [8, 116, 224], bin = 4.2;
  const R = rng(14);
  const seeds = packWhere({ x: 6, y: 6, w: S - 12, h: S - 12 }, 13, 18.5, () => true, { seed: 31 });
  const nuc = seeds.map((s, i) => catmull(blobPts(s[0], s[1], 5.2 + R() * 1.6, 4.4 + R() * 1.2, { n: 7, wobble: 0.1, seed: 40 + i, rot: R() * 180 }), 5, true));
  const box = rectPoly(0, 0, S, S);
  const masks = cellsAround(seeds, { radius: () => 11.5, clip: box, gap: 1.6, seed: 9 });
  // every cell gets its own colour: greedy colouring so that touching cells always differ
  // (least-used free colour first, so the six colours spread evenly)
  const pal = [CLU[0], CLU[1], CLU[2], CLU[3], CLU[4], CLU[5]];
  const kind = [], used = pal.map(() => 0);
  seeds.forEach((s, i) => {
    const taken = new Set(seeds.slice(0, i).map((q, j) => (dist(s, q) < 2.4 * 11.5 ? kind[j] : -1)));
    const free = pal.map((_, k) => k).filter((k) => !taken.has(k));
    const k = free.sort((a, b) => used[a] - used[b] || a - b)[0];
    kind.push(k);
    used[k]++;
  });
  const mv = (pts, x) => pts.map(([a, b]) => [a + x, b + Y]);
  const trackX = 54, trackY = 30;
  // panel 1: ssDNA-stained nuclei (fluorescence), track lines visible as dark lines
  parts.push({ d: rect(xs[0], Y, S, S, 4), fill: "#16202b", lineWidth: 1.1 });
  parts.push({ d: polyline([[xs[0] + trackX, Y + 1], [xs[0] + trackX, Y + S - 1]]) + polyline([[xs[0] + 1, Y + trackY], [xs[0] + S - 1, Y + trackY]]), fill: "none", stroke: { color: "#3b4b5e", width: 1.4, cap: "butt" }, lineStrokeWidth: 1 });
  parts.push({ d: nuc.map((n) => polyD(mv(n, xs[0]))).join(""), fill: "#a8ecd9", lineWidth: 0.6 });
  // panels 2 and 3: the bin grid (light), track lines on it
  const grid = (x0) => {
    let d = "";
    for (let k = 1; k < S / bin; k++) d += polyline([[x0 + k * bin, Y + 0.5], [x0 + k * bin, Y + S - 0.5]]) + polyline([[x0 + 0.5, Y + k * bin], [x0 + S - 0.5, Y + k * bin]]);
    return d;
  };
  parts.push({ d: rect(xs[1], Y, S, S, 4) + rect(xs[2], Y, S, S, 4), fill: "#eef2f6", lineWidth: 1.1 });
  parts.push({ d: grid(xs[1]) + grid(xs[2]), fill: "none", stroke: { color: "#d2dbe5", width: 0.6, cap: "butt" }, lineColor: "#b9c5d2", lineStrokeWidth: 0.45 });
  // panel 2: masks (cells expanded from the nuclei) and nuclei
  const mk = pal.map(() => []), mkFill = pal.map(() => []);
  masks.forEach((m, i) => { if (m.length > 2) { mk[kind[i]].push(roundPoly(mv(m, xs[1]), 2.5)); } });
  pal.forEach((c, k) => parts.push({ d: mk[k].join(""), fill: tint(c, 0.22), opacity: 0.55, stroke: { color: c, width: 1.1 }, lineColor: shade(c, 0.12), lineWidth: 0.9 }));
  parts.push({ d: nuc.map((n) => polyD(mv(n, xs[1]))).join(""), fill: "#8f86c4", opacity: 0.85, lineWidth: 0.5 });
  // panel 3: bins whose centre falls well inside a mask become that cell's bins (a bin on the
  // border is left out, so neighbouring cells stay apart); each cell is one pixelated shape,
  // the bin grid shows through as thin light lines
  const cellBins = pal.map(() => []), inner = [];
  masks.forEach((m, i) => {
    if (m.length < 3) return;
    const on = new Set();
    for (let bx = 0; bx < S / bin; bx++) for (let by = 0; by < S / bin; by++) {
      const c = [bx * bin + bin / 2, by * bin + bin / 2];
      if (inside(m, c) && minEdge(m, c) > bin * 0.3) on.add(`${bx},${by}`);
    }
    for (const key of on) {
      const [bx, by] = key.split(",").map(Number), x0 = xs[2] + bx * bin, y0 = Y + by * bin;
      cellBins[kind[i]].push(rect(x0, y0, bin, bin));
      if (on.has(`${bx + 1},${by}`)) inner.push(polyline([[x0 + bin, y0 + 0.4], [x0 + bin, y0 + bin - 0.4]]));
      if (on.has(`${bx},${by + 1}`)) inner.push(polyline([[x0 + 0.4, y0 + bin], [x0 + bin - 0.4, y0 + bin]]));
    }
  });
  pal.forEach((c, k) => cellBins[k].length && parts.push({ unite: cellBins[k], fill: c, lineColor: shade(c, 0.2), lineWidth: 0.8 }));
  parts.push({ d: inner.join(""), fill: "none", stroke: { color: "#f4f6f8", width: 0.6, cap: "butt" }, opacity: 0.75, lineColor: "#f4f6f8", lineStrokeWidth: 0.6 });
  const trk = (x0) => polyline([[x0 + trackX, Y + 1], [x0 + trackX, Y + S - 1]]) + polyline([[x0 + 1, Y + trackY], [x0 + S - 1, Y + trackY]]);
  parts.push({ d: trk(xs[1]) + trk(xs[2]), fill: "none", stroke: { color: "#93a3b5", width: 1.3, cap: "butt" }, lineStrokeWidth: 1 });
  parts.push(arrowPart([arrowAlong([xs[0] + S + 4, Y + S / 2], [xs[1] - 4, Y + S / 2], 7, 2), arrowAlong([xs[1] + S + 4, Y + S / 2], [xs[2] - 4, Y + S / 2], 7, 2)]));
  return parts;
}

/* ---------------- instruments ---------------- */

/** Box in 3/4 view: front face (x, y, W, H), depth D = [dx, dy] towards the top right. */
function boxFaces(x, y, W, H, D, { body = COL.body, top = COL.top, side = COL.side, r = 3 } = {}) {
  const a = [x, y], b = [x + W, y], c = [x + W, y + H], d = [x, y + H], t = (p) => [p[0] + D[0], p[1] + D[1]];
  return [
    { d: roundPoly([a, t(a), t(b), t(c), c, d], r), fill: side },
    { d: roundPoly([a, t(a), t(b), b], r), fill: top },
    { d: rect(x, y, W, H, r), fill: body }, ...faceShade(x, y, W, H, r, body, { bw: 3, light: 0.7 }),
  ];
}

/** Xenium-class in situ analyzer (unbranded): wide benchtop box on a vibration-isolation table,
 *  lift-up front door with a tinted window onto the slide stage (2 slides), touchscreen, reagent drawer. */
function analyzerParts() {
  const parts = [];
  // vibration-isolation table (four legs; the back-left one is hidden behind the front edge)
  parts.push({ d: rect(22, 150, 9, 34, 1.5) + rect(166, 150, 9, 34, 1.5) + rect(198, 128, 9, 32, 1.5), fill: "#5e6a78" });
  parts.push({ d: roundPoly([[8, 150], [44, 126], [222, 126], [186, 150]], 2), fill: "#aeb9c5" });
  parts.push({ d: rect(8, 150, 178, 8, 2), fill: COL.table });
  // instrument (its back edge stays on the tabletop)
  const x = 22, y = 68, W = 146, H = 80, D = [32, -21];
  parts.push(...boxFaces(x, y, W, H, D));
  parts.push({ d: [0, 1, 2, 3].map((i) => polyline([[x + W + 8, y + 26 + i * 9], [x + W + 26, y + 14 + i * 9]])).join(""), fill: "none", stroke: { color: "#9fb0c0", width: 2.2, cap: "round" } });
  // status light along the top edge
  parts.push({ d: capsule(x + 7, y + 5.5, x + W - 7, y + 5.5, 1.8), fill: COL.bar, shade: "small", gloss: false });
  // lift-up door: tinted window onto the stage with two slides
  parts.push({ d: rect(x + 8, y + 12, 98, 42, 4), fill: "#c9d3dd", shade: "rim" });
  parts.push({ d: rect(x + 11, y + 15, 92, 36, 3), fill: COL.win });
  parts.push({ d: rect(x + 17, y + 36, 80, 10, 1.5), fill: "#59687a", thin: true });
  parts.push({ d: rect(x + 23, y + 25, 30, 13, 1.2) + rect(x + 60, y + 25, 30, 13, 1.2), fill: COL.glass, thin: true });
  parts.push({ d: ellipse(x + 42, y + 31.5, 7, 4.2) + ellipse(x + 79, y + 31.5, 6.5, 4.4), fill: COL.tissue, lineWidth: 0.5 });
  parts.push(glow(polyD([[x + 30, y + 15], [x + 44, y + 15], [x + 30, y + 51], [x + 16, y + 51]]), 0.18), glow(polyD([[x + 50, y + 15], [x + 55, y + 15], [x + 41, y + 51], [x + 36, y + 51]]), 0.14));
  // touchscreen, tilted back slightly (its top edge seen as a darker strip), run view: tissue with transcripts
  parts.push({ d: roundPoly([[x + 113.5, y + 9.5], [x + 141.5, y + 9.5], [x + 140, y + 12.5], [x + 112, y + 12.5]], 0.8), fill: "#2c3642", thin: true });
  parts.push({ d: rect(x + 112, y + 12, 28, 36, 3), fill: "#3f4c5c", shade: "small" });
  parts.push({ d: rect(x + 114.5, y + 14, 23, 30.5, 1.6), fill: "#2b3a4c" });
  parts.push({ d: ellipse(x + 126, y + 29.5, 8.5, 11), fill: "#6a4e74", lineWidth: 0.5 });
  // transcripts of two genes, each dot on its own (no two-tone doublets), as on the Atera screen
  const R = rng(3);
  const dots = packWhere({ x: x + 117, y: y + 18.5, w: 18, h: 22 }, 18, 2.4, (p) => ((p[0] - x - 126) / 7.4) ** 2 + ((p[1] - y - 29.5) / 9.9) ** 2 < 1, { seed: 3 }).map((p) => [p, R() < 0.58]);
  parts.push({ d: dots.filter((q) => q[1]).map(([[px, py]]) => circle(px, py, 0.9)).join(""), fill: FL.g, lineWidth: 0.2 });
  parts.push({ d: dots.filter((q) => !q[1]).map(([[px, py]]) => circle(px, py, 0.9)).join(""), fill: FL.r, lineWidth: 0.2 });
  // reagent / buffer drawer with a blue-accented handle
  parts.push({ d: rect(x + 8, y + 59, 132, 16, 3), fill: "#cfd9e3", shade: "rim" });
  parts.push({ d: capsule(x + 56, y + 67, x + 92, y + 67, 2), fill: COL.metal, shade: "small", gloss: false, thin: true });
  parts.push({ d: capsule(x + 66, y + 67, x + 82, y + 67, 1.1), fill: COL.bar, gloss: false, highlight: false, thin: true });
  return parts;
}

/** Floor-standing whole-transcriptome in situ platform (Atera-class, unbranded): tall cabinet,
 *  imaging bay with four standard slides behind a tinted door, touchscreen, reagent cabinet below. */
function ateraParts() {
  const parts = [];
  const x = 30, y = 46, W = 112, H = 136, D = [34, -24];
  parts.push(dim(polyD([[x - 4, y + H + 2], [x + W + 4, y + H + 2], [x + W + D[0] + 6, y + H + D[1] + 2], [x + D[0], y + H + D[1] + 2]]), 0.12));
  parts.push(...boxFaces(x, y, W, H, D));
  parts.push({ d: rect(x, y + H - 7, W, 7, 2), fill: "#7d8a98" });
  parts.push({ d: polyD([[x + W, y + H - 7], [x + W + D[0], y + H - 7 + D[1]], [x + W + D[0], y + H + D[1]], [x + W, y + H]]), fill: "#66727f" });
  parts.push({ d: capsule(x + 7, y + 6, x + W - 7, y + 6, 1.8), fill: COL.bar, shade: "small", gloss: false });
  // imaging bay door with a tinted window: four standard slides on the stage
  parts.push({ d: rect(x + 8, y + 13, W - 16, 52, 4), fill: "#c9d3dd", shade: "rim" });
  parts.push({ d: rect(x + 11, y + 16, W - 22, 46, 3), fill: COL.win });
  parts.push({ d: rect(x + 15, y + 52, W - 30, 6, 1.5), fill: "#59687a", thin: true });
  // four standard slides, each with its own irregular H&E section (different seeds, sizes, tilt)
  const sl = [], tis = [], hem = [], Rs = rng(41);
  for (let i = 0; i < 4; i++) {
    const sx = x + 19 + i * 19.5, scx = sx + 6.5, scy = y + 37 + (i % 2 ? 1 : -0.5);
    sl.push(rect(sx, y + 20, 13, 32, 1.2));
    const sec = catmull(blobPts(scx, scy, 4.6 + Rs() * 0.6, 6.3 + Rs() * 1.2, { n: 9, wobble: 0.18, seed: 11 + i * 7, rot: (Rs() - 0.5) * 30 }), 6, true);
    tis.push(polyD(sec));
    packWhere({ x: scx - 6, y: scy - 8, w: 12, h: 16 }, 7, 2.6, (p) => inside(sec, p) && minEdge(sec, p) > 1.3, { seed: 50 + i }).forEach(([hx, hy]) => hem.push(circle(hx, hy, 0.55)));
  }
  parts.push({ d: sl.join(""), fill: COL.glass, thin: true });
  parts.push({ d: tis.join(""), fill: COL.tissue, lineWidth: 0.5 });
  parts.push({ d: hem.join(""), fill: COL.hema, gloss: false, lineWidth: 0.2 });
  parts.push(glow(polyD([[x + 30, y + 16], [x + 44, y + 16], [x + 26, y + 62], [x + 12, y + 62]]), 0.16));
  // touchscreen on the right of the middle band, status panel left; the run view shows the same
  // output cue as the Xenium-class analyzer: a dark tile with a tissue section and transcript dots
  parts.push({ d: rect(x + 60, y + 70, 42, 26, 3), fill: "#3f4c5c", shade: "small" });
  parts.push({ d: rect(x + 62.5, y + 72.5, 37, 21, 1.6), fill: "#2b3a4c" });
  const tcx = x + 81, tcy = y + 83;
  const scr = catmull(blobPts(tcx, tcy, 13.5, 7.4, { n: 9, wobble: 0.1, seed: 8, rot: -6 }), 6, true);
  parts.push({ d: polyD(scr), fill: "#6a4e74", lineWidth: 0.5 });
  const Rd = rng(9);
  const sdots = packWhere({ x: tcx - 15, y: tcy - 9, w: 30, h: 18 }, 24, 2.5, (p) => inside(scr, p) && minEdge(scr, p) > 1.3, { seed: 9 });
  const sg = sdots.map((p) => [p, Rd() < 0.58]);
  parts.push({ d: sg.filter((q) => q[1]).map(([[px, py]]) => circle(px, py, 0.9)).join(""), fill: FL.g, lineWidth: 0.2 });
  parts.push({ d: sg.filter((q) => !q[1]).map(([[px, py]]) => circle(px, py, 0.9)).join(""), fill: FL.r, lineWidth: 0.2 });
  parts.push({ d: circle(x + 18, y + 80, 3.2), fill: COL.metal, shade: "small", thin: true });
  // reagent cabinet: two doors with handles
  parts.push({ d: rect(x + 8, y + 102, (W - 20) / 2, 25, 3) + rect(x + 12 + (W - 20) / 2, y + 102, (W - 20) / 2, 25, 3), fill: "#cfd9e3", shade: "rim" });
  parts.push({ d: capsule(x + 8 + (W - 20) / 2 - 7, y + 108, x + 8 + (W - 20) / 2 - 7, y + 121, 1.8) + capsule(x + 12 + (W - 20) / 2 + 7, y + 108, x + 12 + (W - 20) / 2 + 7, y + 121, 1.8), fill: COL.metal, shade: "small", gloss: false, thin: true });
  parts.push({ d: [0, 1, 2, 3, 4].map((i) => polyline([[x + W + 9, y + 98 + i * 8], [x + W + 27, y + 85 + i * 8]])).join(""), fill: "none", stroke: { color: "#9fb0c0", width: 2.2, cap: "round" } });
  return parts;
}

/** Generic NGS sequencer (as in methods-seq, so the strips match). */
function sequencerParts() {
  const parts = [];
  const a = [26, 66], b = [142, 66], c = [142, 174], d = [26, 174], D = [42, -28];
  const t = (p) => add2(p, D, 1);
  parts.push({ d: roundPoly([a, t(a), t(b), t(c), c, d], 2.5), fill: "#c3cfdb" });
  parts.push({ d: roundPoly([a, t(a), t(b), b], 2.5), fill: "#f1f4f7" });
  parts.push({ d: roundPoly([a, b, c, d], 2.5), fill: "#dfe7ef" }, ...faceShade(26, 66, 116, 108, 2.5, "#dfe7ef", { bw: 3.2, light: 0.7 }));
  parts.push({ d: [0, 1, 2, 3].map((i) => polyline([[152, 122 + i * 8], [174, 108 + i * 8]])).join(""), fill: "none", stroke: { color: "#9fb0c0", width: 2.2, cap: "round" } });
  parts.push({ d: polyD([[70, 56], [118, 56], [134, 45.5], [86, 45.5]]), fill: "#d5dee7", thin: true });
  parts.push({ d: capsule(33, 72, 135, 72, 2.2), fill: "#59c3e6", shade: "small", gloss: false });
  parts.push({ d: rect(80, 79, 56, 39, 3.5), fill: "#3f4c5c", shade: "small" });
  parts.push({ d: rect(83.5, 82.5, 49, 32, 2), fill: "#6fb2e6" });
  const bars = [0.55, 0.8, 0.7, 0.92, 0.85, 0.62, 0.88];
  parts.push({ d: [...bars.map((h, i) => rect(88.5 + i * 6, 109 - h * 19, 3.6, h * 19, 1)), rect(88, 87, 40, 2.6, 1.3)].join(""), fill: "#e3f1fb", thin: true, lineWidth: 0.5 });
  parts.push({ d: circle(37.5, 84, 3.2), fill: "#8fa0b0", shade: "small", thin: true });
  parts.push({ d: rect(32, 123, 104, 45, 4), fill: "#6f7f92" }, ...faceShade(32, 123, 104, 45, 4, "#6f7f92", { bw: 2.6, hw: 2, dark: 0.08, light: 0.3 }));
  parts.push({ d: rect(42, 129.5, 84, 25, 3), fill: "#4b5867", thin: true });
  parts.push({ d: rect(47, 133, 74, 18, 2.5), fill: COL.glass, shade: "small", thin: true });
  parts.push({ d: [137.5, 142, 146.5].map((yy) => capsule(55, yy, 113, yy, 1.6)).join(""), fill: COL.lane, thin: true, lineWidth: 0.5 });
  parts.push({ d: capsule(68, 161, 100, 161, 2), fill: "#c9d4df", shade: "small", gloss: false, thin: true });
  return parts;
}

/* ---------------- spatial expression map ---------------- */

/**
 * A synovial-biopsy-like section covered by capture spots, each coloured by its cluster: lining
 * along the villous surface, lymphoid aggregates with a T-cell/perivascular rim, sublining stroma
 * and a deeper fibrous zone.
 */
function spatialMapParts({ pitch = 7.4, spotR = 3.05, outline = true } = {}) {
  const parts = [];
  const ctrl = [[16, 70], [30, 44], [44, 50], [56, 28], [72, 36], [86, 22], [104, 34], [120, 24], [136, 40], [152, 30], [170, 48], [186, 70], [184, 110], [176, 146], [150, 172], [110, 180], [70, 176], [36, 160], [18, 128], [12, 98]];
  const sec = catmull(ctrl, 8, true);
  // the surface (lining) runs along the top edge, from the first to the twelfth key point
  const surf = catmull(ctrl.slice(0, 12), 8, false);
  const dSurf = (p) => Math.min(...surf.map((q) => dist(p, q)));
  if (outline) parts.push({ d: polyD(sec), fill: "#f1e4ea", stroke: { color: "#d9bfcc", width: 1.2 }, lineWidth: 1.2 });
  const vessels = [[100, 70], [158, 82], [52, 132], [112, 150]];
  // lymphoid aggregates: irregular, elongated cores pointing at their nearest vessel, with an uneven
  // T-cell / perivascular rim — about two spots thick on the vessel side, one spot at the flanks,
  // absent on the far side (~35% of the perimeter), its edge broken by seeded noise
  const aggs = [[72, 96, 18, 11], [134, 118, 16, 10]].map(([cx, cy, rx, ry], i) => {
    const v = [...vessels].sort((a, b) => dist(a, [cx, cy]) - dist(b, [cx, cy]))[0];
    const ang = Math.atan2(v[1] - cy, v[0] - cx), Rr = rng(61 + i), ph1 = Rr() * 6.28, ph2 = Rr() * 6.28;
    const core = catmull(blobPts(cx, cy, rx, ry, { n: 9, wobble: 0.25, seed: 31 + i * 7, rot: ang / DEG }), 6, true);
    const rim = (phi) => {
      let D = Math.abs(phi - ang) % (2 * Math.PI);
      if (D > Math.PI) D = 2 * Math.PI - D;
      const base = D < 55 * DEG ? 12.5 : D < 116 * DEG ? 6.3 : 0;
      return base ? Math.max(0, base + 2.3 * Math.sin(3 * phi + ph1) + 1.5 * Math.sin(5 * phi + ph2)) : 0;
    };
    return { c: [cx, cy], core, rim };
  });
  const R = rng(19);
  const spots = hexLattice(8, 16, 192, 186, pitch).filter(([x, y]) => inside(sec, [x, y]) && minEdge(sec, [x, y]) > spotR + 0.4);
  // the sublining / deep fibrous boundary is irregular, as tissue domains are: two sines (periods
  // ~70 and ~25) plus seeded noise of ±4 for every column of spots
  const Rb = rng(23), ph1 = Rb() * 6.28, ph2 = Rb() * 6.28;
  const colNoise = Array.from({ length: 80 }, () => (Rb() * 2 - 1) * 4);
  const deepAt = (x) => 130 + 10 * Math.sin((2 * Math.PI * x) / 70 + ph1) + 5 * Math.sin((2 * Math.PI * x) / 25 + ph2) + colNoise[Math.max(0, Math.min(79, Math.round(x / (pitch / 2))))];
  const lab = (p) => {
    const s = dSurf(p);
    if (s < 11) return 0; // the outermost row of spots along the villous surface: lining
    for (const a of aggs) {
      if (inside(a.core, p)) return 1;
      if (minEdge(a.core, p) < a.rim(Math.atan2(p[1] - a.c[1], p[0] - a.c[0]))) return 2;
    }
    for (const v of vessels) if (dist(p, v) < 8.5) return 2;
    if (p[1] > deepAt(p[0])) return 4;
    return 3;
  };
  const MAPC = [CLU[0], CLU[3], CLU[2], CLU[1], CLU[4]];
  const groups = MAPC.map(() => []);
  const labels = spots.map(([x, y]) => {
    let k = lab([x, y]);
    if (R() < 0.06) k = lab([x + (R() - 0.5) * 22, y + (R() - 0.5) * 22]);
    return k;
  });
  // a few spots cross the boundary: 3 deep-zone spots in the sublining, 2 sublining spots in the deep zone
  const cross = (from, to, n, side) => {
    const cand = spots.map((p, i) => [p, i]).filter(([p, i]) => labels[i] === from && side * (p[1] - deepAt(p[0])) > 0 && Math.abs(p[1] - deepAt(p[0])) < pitch * 1.6);
    const chosen = [];
    for (let t = 0; chosen.length < n && t < 200 && cand.length; t++) {
      const [p, i] = cand[Math.floor(R() * cand.length)];
      if (chosen.every(([q]) => dist(p, q) > 24)) chosen.push([p, i]);
    }
    chosen.forEach(([, i]) => (labels[i] = to));
  };
  cross(3, 4, 3, -1);
  cross(4, 3, 2, 1);
  spots.forEach(([x, y], i) => groups[labels[i]].push(circle(x, y, spotR)));
  const mark = (d, fill) => ({ d, fill, stroke: { color: shade(fill, 0.12), width: 0.5 }, lineColor: shade(fill, 0.2), lineWidth: 0.5 });
  groups.forEach((g, k) => g.length && parts.push(mark(g.join(""), MAPC[k])));
  return parts;
}

/* ---------------- workflow minis ---------------- */

/** Standard slide with an H&E section. */
function sectionSlideMini() {
  const parts = slideTop(0, 0, 150, 50, { label: 0.24, glare: 136 });
  const sec = sectionPts(92, 25, 40, 18, 4, 10, 0.12);
  parts.push({ d: polyD(sec), fill: COL.tissue, lineWidth: 1 });
  parts.push({ d: polyD(sectionPts(80, 30, 15, 8, 6, 8, 0.15)), fill: COL.tissueDeep, opacity: 0.6, line: false });
  const R = rng(2);
  const nuc = packWhere({ x: 50, y: 5, w: 84, h: 40 }, 46, 4.6, (p) => inside(sec, p) && minEdge(sec, p) > 1.8, { seed: 5 });
  parts.push({ d: nuc.map(([x, y]) => ellR(x, y, 1.3 + R() * 0.5, 1 + R() * 0.3, R() * 180)).join(""), fill: COL.hema, opacity: 0.85, lineWidth: 0.3 });
  return parts;
}
/**
 * Spatially barcoded library molecules, with the same segment table and colours as the final library
 * in methods-seq: P5 | Read 1 | spatial barcode | UMI | poly(dT) | cDNA insert | Read 2 | i7 | P7.
 * Each molecule is ONE rounded bar cut into flat colour segments with square inner joins (the oligo
 * part in exactly the fills of the capture-oligo segments in the lens), with a single light band
 * along the top of the whole bar (soft style only).
 */
function libraryMini({ inserts = [36, 22, 46, 28] } = {}) {
  const S = [["p5", 6], ["r1", 14], ["bc", 9], ["umi", 7], ["polyT", 8], ["insert", 0], ["r2", 10], ["i7", 7], ["p7", 6]];
  const by = {}, bands = [], h = 8.5, r = 2.5;
  inserts.forEach((L, k) => {
    const x0 = 4 + (k % 2) * 3, y0 = 6 + k * 15;
    const tot = S.reduce((a, [key, w0]) => a + (key === "insert" ? L : w0), 0);
    const bar = rrPts(x0, y0, tot, h, r, 6);
    let x = x0;
    for (const [key, w0] of S) {
      const w = key === "insert" ? L : w0;
      (by[key] = by[key] || []).push(clipD(bar, rectPoly(x, y0 - 1, w, h + 2)));
      x += w;
    }
    bands.push(capsule(x0 + 3.6, y0 + 2.2, x0 + tot - 3.6, y0 + 2.2, 0.9));
  });
  return [...Object.entries(by).map(([k, ds]) => ({ d: ds.join(""), fill: COL[k], thin: true })), glow(bands.join(""), 0.35)];
}
/**
 * Step 1 of the sequencing-based strip: tissue placed directly on a Visium slide (the direct-
 * placement workflow that step 2's capture lens shows: poly(A) mRNA released from cells lying on
 * the spot). The slide has its label end and four capture areas A1–D1 in fiducial frames, an H&E
 * section on D1, and a magnifier above D1 showing the section lying on the hexagonal spot lattice,
 * with spots visible around its edge.
 */
function visiumSectionMini() {
  const { parts, centres, cy, half } = visiumDirectSlideParts();
  const cx = centres[3];
  const sec = sectionPts(cx + 0.3, cy, 10.6, 9.6, 4, 10, 0.1);
  parts.push({ d: polyD(sec), fill: COL.tissue, opacity: 0.92, lineWidth: 0.8 });
  const R = rng(2);
  const nuc = packWhere({ x: cx - 12, y: cy - 12, w: 24, h: 24 }, 22, 3.6, (p) => inside(sec, p) && minEdge(sec, p) > 1.6, { seed: 5 });
  parts.push({ d: nuc.map(([x, y]) => ellR(x, y, 1.05 + R() * 0.3, 0.8 + R() * 0.2, R() * 180)).join(""), fill: COL.hema, opacity: 0.85, lineWidth: 0.3 });
  // the magnifier: centred above the slide, left of D1 so it stays within the slide's length
  const lr = 63, L = [155, -lr - 18];
  const fr = half * 1.233 + 3.2;
  const cone = coneLines([cx - fr, cy - fr, 2 * fr], { c: L, r: lr, w: 1.6 });
  // lens content: part of D1 seen from above — capture area with 55 µm spots on a hexagonal lattice,
  // the section covering ~65% of the view (H&E pink with nuclei), the spots showing around its edge
  // and faintly through it
  // (spot lattice drawn coarser than true scale so it reads; ~3 nuclei per spot pitch)
  const Rl = lr;
  const lens = [{ d: circle(0, 0, Rl), fill: COL.area }];
  const sp = hexLattice(-Rl - 4, -Rl - 4, Rl + 4, Rl + 4, 8.5).filter(([x, y]) => Math.hypot(x, y) < Rl - 3);
  lens.push({ d: sp.map(([x, y]) => circle(x, y, 2.35)).join(""), fill: COL.spot, shade: "small", lineWidth: 0.45 });
  const ls = catmull(blobPts(2, 3, 52, 47, { n: 11, wobble: 0.1, seed: 12 }), 8, true);
  lens.push({ d: polyD(ls), fill: COL.tissue, opacity: 0.84, lineWidth: 1 });
  const deep = catmull(blobPts(-16, 20, 19, 13, { n: 8, wobble: 0.16, seed: 3 }), 6, true);
  lens.push({ d: polyD(deep), fill: COL.tissueDeep, opacity: 0.55, line: false });
  const Rn = rng(4);
  const ln = packWhere({ x: -Rl, y: -Rl, w: 2 * Rl, h: 2 * Rl }, 700, 3.7, (p) => inside(ls, p) && minEdge(ls, p) > 1.8, { seed: 8, tries: 200 });
  lens.push({ d: ln.map(([x, y]) => ellR(x, y, 0.95 + Rn() * 0.3, 0.72 + Rn() * 0.22, Rn() * 180)).join(""), fill: COL.hema, opacity: 0.85, lineWidth: 0.3 });
  return [...parts, ...cone, ...xform(lens, place({ x: L[0], y: L[1] })), ...lensRim(L[0], L[1], lr)];
}
/** Padlock + RCA lens content without the magnifier (for the imaging strip). */
const chemistryMini = () => [...xeniumLensLocal(), ...lensRim(0, 0, 56)];
const captureMini = () => [...captureLensLocal("visium"), ...lensRim(0, 0, 52)];

/**
 * Lay out workflow steps left → right, each scaled to fit a cell, with block arrows between.
 * steps: [{ parts, w? (relative cell width), maxS?, dy? }]
 */
function strip(steps, { W = 520, H = 170, aw = 16, pad = 6, ch = 132, vpad = 10 } = {}) {
  const gap = 5, n = steps.length;
  const wsum = steps.reduce((a, st) => a + (st.w || 1), 0);
  const unit = (W - 2 * pad - (n - 1) * (aw + 2 * gap)) / wsum;
  const parts = [], arrows = [];
  let x = pad;
  steps.forEach((st, i) => {
    const cw = unit * (st.w || 1), b = boundsOf(st.parts);
    const s = Math.min(cw / b.w, ch / b.h, st.maxS ?? Infinity);
    const dx = x + cw / 2 - (b.x + b.w / 2) * s, dy = H / 2 - (b.y + b.h / 2) * s + (st.dy || 0);
    parts.push(...placeParts(st.parts, { dx, dy, s, lw: 1.15 / s }));
    x += cw;
    if (i < n - 1) { arrows.push(arrowAlong([x + gap, H / 2], [x + gap + aw, H / 2], 7.5, 2)); x += aw + 2 * gap; }
  });
  parts.push(arrowPart(arrows));
  const b = boundsOf(parts), H2 = Math.ceil(Math.min(H, b.h + 2 * vpad));
  const moved = placeParts(parts, { dy: (H2 - b.h) / 2 - b.y, s: 1 }).map((q, i) => ({ ...q, lineWidth: parts[i].lineWidth }));
  return { size: [W, H2], lineWidth: 1.6, parts: moved };
}

/* ---------------- icons ---------------- */

const ST = ["spatial transcriptomics", "spatial omics", "spatial gene expression", "spatially resolved transcriptomics", "SRT", "ST", "tissue section", "transcriptome", "gene expression"];
const SEQB = ["sequencing-based spatial", "spatial barcoding", "capture array", "spatial barcode", "next-generation sequencing", "NGS"];
const IMGB = ["imaging-based spatial", "in situ", "in situ hybridization", "ISH", "smFISH", "single-molecule", "subcellular", "fluorescence microscopy", "imaging"];
const TENX = ["10x Genomics", "10x"];

export const icons = [
  // ---------- Visium ----------
  {
    slug: "visium-slide", name: "Visium slide (CytAssist v2, 6.5 mm) — capture areas A1 and D1 in fiducial frames", category: "lab",
    tags: [...ST, ...SEQB, ...TENX, "Visium", "Visium v2", "Visium CytAssist", "CytAssist slide", "capture area", "fiducial frame", "fiducials", "spots", "55 µm spots", "glass slide", "slide", "Space Ranger", "spatial slide"],
    scene: () => ({ size: [258, 100], parts: fit(visiumSlideParts().parts, 258, 100, { pad: 8 }) }),
  },
  {
    slug: "visium-spot-array", name: "Visium spot array — 55 µm barcoded spots under a tissue section (magnified spot)", category: "methods",
    tags: [...ST, ...SEQB, ...TENX, "Visium", "spot", "spots", "55 µm", "100 µm centre-to-centre", "hexagonal array", "capture oligo", "spatial barcode", "UMI", "poly(dT)", "Read 1", "mRNA capture", "permeabilization", "tissue section", "H&E", "barcoded spots", "ST array", "Spatial Transcriptomics (Ståhl 2016)"],
    scene: () => ({ size: [250, 160], parts: fit(visiumSpotArrayParts(), 250, 160, { pad: 8 }) }),
  },
  {
    slug: "visium-hd-slide", name: "Visium HD slide — continuous 2 µm barcoded squares, binned to 8 and 16 µm (inset)", category: "lab",
    tags: [...ST, ...SEQB, ...TENX, "Visium HD", "Visium HD 3'", "HD", "high definition", "2 µm", "2 x 2 µm squares", "barcoded squares", "8 µm bin", "16 µm bin", "binning", "bins", "single-cell scale", "subcellular", "CytAssist", "capture area", "fiducial frame", "Space Ranger", "cell segmentation", "glass slide"],
    scene: () => ({ size: [258, 200], parts: fit(visiumHdParts(), 258, 200, { pad: 8 }) }),
  },
  {
    slug: "cytassist-transfer", name: "CytAssist probe transfer — probes released from a section on a standard slide onto the Visium capture area", category: "methods",
    tags: [...ST, ...SEQB, ...TENX, "CytAssist", "Visium CytAssist", "probe transfer", "probe release", "probe-based", "FFPE", "whole transcriptome probes", "probe pair", "ligation", "RNA templated ligation", "RTL", "poly(A)", "sandwich", "slide alignment", "standard glass slide", "H&E", "IF", "Visium HD", "Visium v2"],
    scene: () => ({ size: [222, 158], parts: fit(cytassistParts(), 222, 158, { pad: 8, maxS: 1.2 }) }),
  },
  // ---------- Xenium / imaging ----------
  {
    slug: "xenium-in-situ-chemistry", name: "Xenium in situ chemistry — padlock probe on mRNA, rolling-circle product lit as a punctum", category: "methods",
    tags: [...ST, ...IMGB, ...TENX, "Xenium", "Xenium Prime 5K", "padlock probe", "circularization", "ligation", "rolling circle amplification", "RCA", "rolling circle product", "RCP", "amplicon", "puncta", "gene-specific barcode", "fluorescent probes", "cyclic imaging", "decoding", "in situ sequencing", "ISS", "FFPE", "fresh frozen"],
    scene: () => ({ size: [280, 168], parts: fit(xeniumChemistryParts(), 280, 168, { pad: 8 }) }),
  },
  {
    slug: "xenium-transcript-map", name: "Transcript map — segmented cells with transcripts coloured by gene (Xenium output)", category: "charts",
    tags: [...ST, ...IMGB, ...TENX, "Xenium", "Xenium Explorer", "Xenium Ranger", "transcript map", "transcripts", "decoded transcripts", "cell segmentation", "cell boundaries", "nucleus expansion", "DAPI", "single-cell resolution", "subcellular", "CosMx", "MERFISH", "MERSCOPE", "spatial map", "cell types"],
    scene: () => ({ size: [200, 200], parts: transcriptMapParts() }),
  },
  {
    slug: "xenium-analyzer", name: "In situ analyzer (Xenium-class) — benchtop imaging instrument on its vibration-isolation table", category: "lab",
    tags: [...ST, ...IMGB, ...TENX, "Xenium", "Xenium Analyzer", "in situ analyzer", "instrument", "imaging instrument", "fluorescence imager", "cyclic imaging", "slide stage", "2 slides", "touchscreen", "vibration isolation table", "MERSCOPE", "CosMx SMI", "spatial imager", "machine"],
    scene: () => ({ size: [220, 149], parts: fit(analyzerParts(), 220, 149, { pad: 8 }) }),
  },
  {
    slug: "imaging-ish-merfish-cosmx", name: "Barcode imaging in rounds — the same puncta lit in different colours per cycle, decoded to genes", category: "methods",
    tags: [...ST, ...IMGB, "MERFISH", "MERSCOPE", "Vizgen", "CosMx", "CosMx SMI", "Bruker", "NanoString", "seqFISH", "Xenium", "cyclic imaging", "imaging rounds", "hybridization cycles", "barcode", "codebook", "combinatorial barcoding", "decoding", "readout probes", "reporter probes", "fluorescence channels", "puncta"],
    scene: () => ({ size: [252, 148], parts: fit(cyclesParts(), 252, 148, { pad: 6 }) }),
  },
  // ---------- Stereo-seq ----------
  {
    slug: "stereo-seq-chip", name: "Stereo-seq chip — DNA nanoball array (500 nm pitch) with capture probes under a section (magnified)", category: "lab",
    tags: [...ST, ...SEQB, "Stereo-seq", "STOmics", "BGI", "MGI", "Complete Genomics", "DNA nanoball", "DNB", "patterned array", "500 nm", "220 nm", "chip", "track lines", "CID", "coordinate ID", "MID", "poly(T)", "capture probe", "spatial barcode", "bin", "bin50", "subcellular", "large field of view", "Stereo-seq OMNI"],
    scene: () => ({ size: [228, 190], parts: fit(stereoChipParts(), 228, 190, { pad: 8 }) }),
  },
  {
    slug: "stereocell-segmentation", name: "StereoCell — ssDNA image, cell masks registered to the bin grid, cell bins", category: "methods",
    tags: [...ST, ...SEQB, "Stereo-seq", "STOmics", "StereoCell", "cell segmentation", "nucleus segmentation", "ssDNA", "ssDNA staining", "image registration", "track lines", "bin grid", "cell bin", "cellbin", "molecule labeling", "SAW", "StereoMap", "single-cell spatial", "deep learning segmentation"],
    scene: () => ({ size: [316, 104], parts: stereoCellParts() }),
  },
  // ---------- Atera ----------
  {
    slug: "atera-in-situ-platform", name: "Whole-transcriptome in situ platform (Atera-class) — floor-standing, four standard slides", category: "lab",
    tags: [...ST, ...IMGB, ...TENX, "Atera", "Atera Select", "whole transcriptome in situ", "WTA", "18,000 genes", "high throughput", "four slides", "standard glass slides", "floor-standing", "instrument", "in situ platform", "spatial imager", "Atera Whole Transcriptome Assay", "Atera Instrument", "machine"],
    scene: () => ({ size: [200, 200], parts: fit(ateraParts(), 200, 200, { pad: 8, maxS: 1.25 }) }),
  },
  // ---------- overview strips ----------
  {
    slug: "spatial-transcriptomics-sequencing-based-workflow", name: "Sequencing-based spatial transcriptomics workflow — section, barcoded capture, library, sequencing, map", category: "methods",
    tags: [...ST, ...SEQB, ...TENX, "workflow", "overview", "pipeline", "schematic", "graphical abstract", "Visium", "Visium HD", "Stereo-seq", "Slide-seq", "Curio Seeker", "tissue section", "capture", "library preparation", "sequencing", "spatial clusters", "Space Ranger"],
    scene: () => strip([
      { parts: visiumSectionMini(), w: 1.45 },
      { parts: captureMini(), w: 0.86 },
      { parts: libraryMini(), w: 0.86 },
      { parts: sequencerParts(), w: 0.78 },
      { parts: spatialMapParts(), w: 0.9 },
    ], { W: 520, H: 170 }),
  },
  {
    slug: "spatial-transcriptomics-imaging-based-workflow", name: "Imaging-based spatial transcriptomics workflow — section, padlock probes + RCA, cyclic imaging, decoded transcripts", category: "methods",
    tags: [...ST, ...IMGB, ...TENX, "workflow", "overview", "pipeline", "schematic", "graphical abstract", "Xenium", "Atera", "MERFISH", "CosMx", "padlock probe", "RCA", "cyclic imaging", "decoding", "cell segmentation", "transcript map"],
    scene: () => strip([
      { parts: sectionSlideMini(), w: 1.15 },
      { parts: chemistryMini(), w: 0.9 },
      { parts: analyzerParts(), w: 0.95 },
      { parts: cyclesParts({ decoded: false }), w: 0.85 },
      { parts: transcriptMapParts(8, 8, 124, 124, { nCells: 18, perArea: 58, dotR: 2.4, seed: 5 }), w: 0.9 },
    ], { W: 520, H: 170 }),
  },
  // ---------- chart ----------
  {
    slug: "spatial-gene-expression-map", name: "Spatial gene-expression map — tissue section with spots coloured by cluster", category: "charts",
    tags: [...ST, "spatial map", "spatial clusters", "spatial domains", "spot clusters", "Visium", "Visium HD", "Stereo-seq", "Seurat SpatialDimPlot", "Squidpy", "Scanpy", "BayesSpace", "GraphST", "spatial plot", "synovium", "lining layer", "lymphoid aggregate", "rheumatoid arthritis", "tissue niches"],
    scene: () => ({ size: [194, 178], parts: fit(spatialMapParts(), 194, 178, { pad: 9 }) }),
  },
];
