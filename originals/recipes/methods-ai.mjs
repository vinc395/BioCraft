// AI and digital pathology (computational pathology), Servier/NIH-like:
// H&E glass slide, whole-slide scanner, tiling of a whole-slide image (WSI) into patches,
// realistic H&E patches (tumour, stroma, lymphocytes, mosaic), a pathology foundation model
// (Vision Transformer), transformer block, patch embeddings, attention-based multiple-instance
// learning (ABMIL), attention heatmap, neural networks, GPU server, evaluation charts
// (loss curves, UMAP, confusion matrix, ROC) and two overview strips.
//
// H&E scale: in a 200-unit patch 1 unit ≈ 0.56 µm (a 224 px tile at 20×, 0.5 µm/px, is ~112 µm):
// lymphocyte nuclei ~10 units across, red cells ~13, columnar tumour nuclei ~20 × 6.
import { circle, ellipse, rect, capsule, ribbon, smoothClosed, smoothOpen, polygon, polyline, rotate, rng, f } from "../lib/geom.mjs";
import { shade, tint, pathBox } from "../lib/style.mjs";
import { catmull, resample, roundPoly, clipConvex, rectPoly, inside, polyD, lineD, packWhere, offsetClosed, honeycomb, shrink, area, signedArea, arcLengths, centroid } from "../lib/tissue.mjs";
import { Layers } from "../lib/histo.mjs";
import { fitInside, clustered, unevenAngles } from "../lib/organic.mjs";
import { parseHex, toHex, toLch, fromLch } from "../../ui/js/color.js";

const DEG = Math.PI / 180;
/** The fill whose line-style flat() version is `hex` (so a line-art part can show an exact colour). */
const unflat = (hex) => { const [L, C, H] = toLch(parseHex(hex)); return toHex(fromLch(Math.max(0, (L - 0.18) / 0.82), C / 0.85, H)); };

/* ============================== palettes ============================== */

// H&E: eosin pinks, haematoxylin purples (kept a little pastel, Servier-like)
const HE = {
  stromaBg: "#f7d3e0", // loose / desmoplastic stroma, clefts between collagen
  collagen: "#eda9c3", // collagen bundles (eosin)
  fibre: "#e597b6", // thin collagen fibres (strokes)
  tumCyto: "#dfa0c9", // tumour epithelium (amphophilic cytoplasm)
  tumNuc: "#68479f", // tumour nuclei: large, elongated, crowded
  nucPale: "#a38bcb", // open (vesicular) chromatin of a pleomorphic nucleus
  nucleolus: "#7e2b70", // prominent nucleolus
  dfibre: "#e391b3", // desmoplastic collagen bundles round the tumour glands
  cleavNuc: "#6a51a6", // cleaved (centrocyte-like) nuclei, paler than small lymphocytes
  lumen: "#fcf1f6",
  debris: "#e895b5", // intraluminal 'dirty' necrosis
  dust: "#5a3b8f", // nuclear dust (karyorrhexis)
  fibNuc: "#5f4196", // fibroblast / endothelial / smooth-muscle nuclei
  lymBg: "#e9bfd8", // lymphoid tissue between the cells
  lymNuc: "#4a2f84", // small dark lymphocyte nuclei
  histCyto: "#efb9d3", // macrophage cytoplasm (paler)
  histNuc: "#937abf", // vesicular macrophage / centroblast nucleus
  vessel: "#e88aa9", // vessel wall
  rbc: "#df4f69",
  fatMem: "#e9a3c0", // adipocyte membranes
  fat: "#fdf7fa", // adipocyte vacuole
  mucin: "#d9d7ee", // extracellular mucin (pale blue-grey)
  mucStrand: "#b9b6dd",
  muscle: "#ea9cba", // smooth muscle
  musCleft: "#f8dce7",
  lp: "#f3c3d6", // lamina propria
  cryptCyto: "#e4b1d2", // normal crypt epithelium
  goblet: "#e3e5f3", // goblet-cell mucin
  epiNuc: "#5d3f95",
  necro: "#f0b0c7", // necrotic debris background
  ghost: "#f7d3e1", // ghost cells in necrosis
  slideBg: "#fbf8fb",
};

// Diagram palette (models, vectors, charts)
const D = {
  axis: "#5b6675",
  grid: "#dde3ea",
  token: "#8fc3ea", // patch tokens
  cls: "#f29a63", // CLS token
  pos: "#c9b3e6", // positional embedding
  block: "#e6eef6", // transformer block background
  attn: "#f7b27a", // multi-head attention
  mlp: "#8cc7e8", // MLP
  norm: "#f6dc87", // layer norm
  add: "#bfe0a8", // residual add
  enc: "#b7a6e0", // encoder slabs
  head: "#f39bb1", // prediction head
  arrow: "#7f8c9c",
  backprop: "#e3685f",
  // class colours (Kather-like tissue classes)
  cTum: "#e2536b",
  cStr: "#f2a6c1",
  cLym: "#6f55b3",
  cNorm: "#4f9fd8",
  cAdi: "#f2cf5b",
  cMus: "#f08d4f",
  cMuc: "#69c4c0",
  cDeb: "#a5785c",
};
// sequential heat levels (low → high), and a diverging feature palette
const HEAT = ["#3f6fc4", "#58a9df", "#78d0c0", "#e9e27a", "#f6a04d", "#e2483f"];
const DIV = ["#3d6db5", "#73a3d6", "#b4d1ec", "#dde1e7", "#f6c3a6", "#ea8a68", "#c94a45"];
const BLUES = ["#f1f6fb", "#d3e4f3", "#a6c9e8", "#72a6d6", "#4282c0", "#245d9c"];

// Glass, instruments and image frames (shared with the spatial / sequencing icons)
const COL = {
  glass: "#dff0fb", glassEdge: "#a9c6dc", frost: "#eef2f6", cover: "#e9f6fd", label: "#f7f9fb", code: "#3e4955",
  body: "#e3eaf1", top: "#f2f5f8", side: "#c3cfdb", win: "#3f4c5c", screen: "#eef4fa", bar: "#59c3e6", metal: "#8fa0b0",
  rack: "#4d5866", door: "#c9d3dd", drawer: "#cfd9e3",
  canvas: "#f4f6f8", mask: "#3fae72", grid: "#4f5b68", sel: "#f08a3c", arrow: "#c3d2e1",
};
// Low-power H&E (a whole section seen on the slide / as a WSI thumbnail)
const SEC = { tissue: "#f2bdd3", muscle: "#e690b4", mucosa: "#b486c4", tumour: "#8a5aae", agg: "#5f3f96", hole: "#fcf2f6", rbc: "#d9566e" };
const HI = "#f7fafc", SHADOW = "#24303c";
/** Categorical colours shared with the single-cell charts. */
const CLU = ["#4e8fd6", "#f0a050", "#6cbf68", "#e2606a", "#9b7fd1", "#45b7b0", "#ec8fc0", "#d9b43a"];

/* ============================== geometry helpers ============================== */

const P = (x, y) => `${f(x)} ${f(y)}`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a, b, t) => a + (b - a) * t;

/** Points of an ellipse (rotation in degrees). */
function ellPts(cx, cy, rx, ry, rot = 0, n = 18) {
  const r = (rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    return [cx + x * c - y * s, cy + x * s + y * c];
  });
}

/** Smooth wobbly closed outline (sum of low harmonics) — glands, tissue fragments, clusters. */
function wobbly(cx, cy, rx, ry, { rot = 0, n = 72, wobble = 0.1, seed = 1, harmonics = [2, 3, 5], bumps = [] } = {}) {
  const R = rng(seed);
  const ph = harmonics.map(() => R() * 6.28), amp = harmonics.map((_, i) => 1 / (i + 1.4));
  const tot = amp.reduce((a, b) => a + b, 0);
  const r0 = (rot * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    let k = 0;
    harmonics.forEach((h, j) => (k += Math.sin(a * h + ph[j]) * amp[j]));
    k = 1 + (wobble * k) / tot;
    // local outpouchings: [angle (degrees, in the shape's own frame), relative height, angular half-width (rad)]
    for (const [ba, bh, bw] of bumps) {
      const da = Math.atan2(Math.sin(a - ba * DEG), Math.cos(a - ba * DEG));
      k *= 1 + bh * Math.exp(-((da / bw) ** 2));
    }
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    return [cx + x * Math.cos(r0) - y * Math.sin(r0), cy + x * Math.sin(r0) + y * Math.cos(r0)];
  });
}

/** Liang–Barsky: the part of segment a→b inside box, or null. */
function clipSeg([x0, y0], [x1, y1], b) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy], q = [x0 - b.x, b.x + b.w - x0, y0 - b.y, b.y + b.h - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[x0 + t0 * dx, y0 + t0 * dy], [x0 + t1 * dx, y0 + t1 * dy]];
}
/** Clip a polyline to a box: runs of points. */
function clipLine(pts, b) {
  const runs = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const s = clipSeg(pts[i - 1], pts[i], b);
    if (!s) { if (cur) runs.push(cur); cur = null; continue; }
    if (cur && dist(cur[cur.length - 1], s[0]) < 1e-6) cur.push(s[1]);
    else { if (cur) runs.push(cur); cur = [s[0], s[1]]; }
    if (dist(s[1], pts[i]) > 1e-6) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}
const inBox = (b, [x, y], pad = 0) => x >= b.x + pad && x <= b.x + b.w - pad && y >= b.y + pad && y <= b.y + b.h - pad;

/** Arrow: a shaft (stroke) and a filled head. Returns [shaftPart, headPart]. */
function arrow(x0, y0, x1, y1, { color = D.arrow, width = 2.6, head = 8, curve = null, dash = null, opacity } = {}) {
  const a = curve ? Math.atan2(y1 - curve[1], x1 - curve[0]) : Math.atan2(y1 - y0, x1 - x0);
  const hx = x1 - Math.cos(a) * head * 0.8, hy = y1 - Math.sin(a) * head * 0.8;
  const shaft = curve ? `M${P(x0, y0)}Q${P(curve[0], curve[1])} ${P(hx, hy)}` : `M${P(x0, y0)}L${P(hx, hy)}`;
  const w = head * 0.62;
  const tip = [[x1, y1], [x1 - Math.cos(a) * head - Math.sin(a) * w, y1 - Math.sin(a) * head + Math.cos(a) * w], [x1 - Math.cos(a) * head + Math.sin(a) * w, y1 - Math.sin(a) * head - Math.cos(a) * w]];
  return { shaft, head: roundPoly(tip, 1) , color, width, dash, opacity };
}
/** Collect arrows into two parts (all shafts, all heads) of one colour. */
function arrowParts(list, { color = D.arrow, width = 2.6, dash = null, lineWidth } = {}) {
  return [
    { d: list.map((a) => a.shaft).join(""), fill: "none", stroke: { color, width, cap: "round", ...(dash ? { dash } : {}) }, ...(lineWidth ? { lineStrokeWidth: lineWidth } : {}) },
    { d: list.map((a) => a.head).join(""), fill: color, thin: true },
  ];
}

/* ============================== H&E patches ============================== */

/** All H&E layers, bottom → top. Unused ones are dropped by Layers.parts(). */
function heLayers(L, lw = 1) {
  const W = (v) => +(v * lw).toFixed(2);
  const def = (k, o) => L.def(k, o);
  def("tileStroma", { fill: HE.stromaBg, lineWidth: W(1.2) });
  def("tileLym", { fill: HE.lymBg, lineWidth: W(1.2) });
  def("tileFat", { fill: HE.fatMem, lineWidth: W(1.2) });
  def("tileMuc", { fill: HE.mucin, lineWidth: W(1.2) });
  def("tileMus", { fill: HE.muscle, lineWidth: W(1.2) });
  def("tileLp", { fill: HE.lp, lineWidth: W(1.2) });
  def("tileNec", { fill: HE.necro, lineWidth: W(1.2) });
  def("collagen", { fill: HE.collagen, lineWidth: W(0.6) });
  def("musCleft", { fill: "none", stroke: { color: HE.musCleft, width: W(2.2), cap: "round" }, lineColor: shade(HE.muscle, 0.12), lineStrokeWidth: W(0.6) });
  def("fat", { fill: HE.fat, lineWidth: W(0.7) });
  def("mucStrand", { fill: "none", stroke: { color: HE.mucStrand, width: W(1.6), cap: "round" }, lineStrokeWidth: W(0.6) });
  def("ghost", { fill: HE.ghost, lineWidth: W(0.4) });
  // desmoplastic collagen is diffuse: pale eosin and thin in the line style too (no dark outline)
  def("dfibre", { fill: "none", stroke: { color: HE.dfibre, width: W(1.25), cap: "round" }, lineColor: "#e3a1bf", lineStrokeWidth: W(0.7) });
  def("cryptCyto", { fill: HE.cryptCyto, lineWidth: W(0.7) });
  def("goblet", { fill: HE.goblet, lineWidth: W(0.4) });
  def("tumCyto", { fill: HE.tumCyto, lineWidth: W(0.8) });
  def("lumen", { fill: HE.lumen, lineWidth: W(0.6) });
  def("debris", { fill: HE.debris, lineWidth: W(0.5) });
  def("vessel", { fill: HE.vessel, lineWidth: W(0.6) });
  def("vLumen", { fill: HE.lumen, lineWidth: W(0.4) });
  def("rbc", { fill: HE.rbc, shade: "small", lineWidth: W(0.4) });
  def("fibre", { fill: "none", stroke: { color: HE.fibre, width: W(1.3), cap: "round" }, lineStrokeWidth: W(0.55) });
  def("histCyto", { fill: HE.histCyto, lineWidth: W(0.5) });
  def("fibNuc", { fill: HE.fibNuc, shade: "small", lineWidth: W(0.4) });
  def("epiNuc", { fill: HE.epiNuc, shade: "small", lineWidth: W(0.4) });
  def("tumNuc", { fill: HE.tumNuc, shade: "small", lineWidth: W(0.4) }); // packed without overlap, so a rim is safe
  def("histNuc", { fill: HE.histNuc, shade: "small", lineWidth: W(0.4) });
  def("lymNuc", { fill: HE.lymNuc, shade: "small", lineWidth: W(0.4) });
  def("cleavNuc", { fill: HE.cleavNuc, shade: "small", lineWidth: W(0.4) });
  def("nucPale", { fill: HE.nucPale, lineWidth: 0.01 });
  def("nucleolus", { fill: HE.nucleolus, lineWidth: W(0.2) });
  def("dust", { fill: HE.dust, lineWidth: W(0.3) });
}

/** Nearest point on a closed polyline, and the distance to it. */
function nearest(poly, p) {
  let best = Infinity, q = poly[0];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(p[0] - x, p[1] - y);
    if (d < best) { best = d; q = [x, y]; }
  }
  return { d: best, q };
}
/** Average each point with its neighbours (closed outline), `passes` times. */
function smoothPts(pts, passes = 1) {
  let p = pts;
  for (let k = 0; k < passes; k++) p = p.map((q, i) => { const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length]; return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4]; });
  return p;
}
/** Irregular, angulated gland outline: low-harmonic wobble plus 1–2 tent-shaped (pointed) corners. Star-shaped about (cx, cy). */
function glandOutline(cx, cy, rx, ry, { rot = 0, seed = 1, wobble = 0.27, corners = 2, n = 96 } = {}) {
  const R = rng(seed * 7 + 3);
  const pts = wobbly(cx, cy, rx, ry, { rot, wobble, seed, n, harmonics: [2, 3, 4, 6] });
  const tents = Array.from({ length: corners }, () => ({ i: Math.floor(R() * n), h: 0.15 + R() * 0.13, w: 5 + Math.floor(R() * 4) }));
  return pts.map((p, i) => {
    let k = 1;
    for (const t of tents) { let di = Math.abs(i - t.i); di = Math.min(di, n - di); if (di < t.w) k += t.h * (1 - di / t.w); }
    return [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k];
  });
}
/** The region at least th (± a low-harmonic irregularity) inside a star-shaped outline, traced along rays from c. */
function innerOffset(out, c, th, { n = 64, seed = 1, irregular = 0.2 } = {}) {
  const R = rng(seed);
  const ph = [R() * 6.28, R() * 6.28];
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, ux = Math.cos(a), uy = Math.sin(a);
    const t = th * (1 + irregular * (0.6 * Math.sin(2 * a + ph[0]) + 0.4 * Math.sin(3 * a + ph[1])));
    const at = (m) => [c[0] + ux * m, c[1] + uy * m];
    let hi = 1;
    while (hi < 400 && inside(out, at(hi))) hi += 2;
    let lo = 0;
    for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (inside(out, at(m)) && nearest(out, at(m)).d >= t) lo = m; else hi = m; }
    pts.push(at(Math.max(lo, 2)));
  }
  return smoothPts(pts, 2);
}
/** Spatial hash for nearby-item queries. */
function spatial(cell = 16) {
  const g = new Map();
  const key = (i, j) => i * 73856093 + j;
  return {
    near(p, rad = 2) {
      const out = [], i0 = Math.floor(p[0] / cell), j0 = Math.floor(p[1] / cell);
      for (let i = i0 - rad; i <= i0 + rad; i++) for (let j = j0 - rad; j <= j0 + rad; j++) { const b = g.get(key(i, j)); if (b) out.push(...b); }
      return out;
    },
    add(p, item) { const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell)); if (!g.has(k)) g.set(k, []); g.get(k).push(item); },
  };
}
/** Non-overlapping nuclei: ellipses (half-axes a × b, angle t in radians), tested by boundary samples, with a spatial hash. */
function nucPacker() {
  const S = spatial(16);
  const ring = (c, t, a, b) => Array.from({ length: 16 }, (_, i) => { const th = (i / 16) * Math.PI * 2, x = Math.cos(th) * a, y = Math.sin(th) * b; return [c[0] + x * Math.cos(t) - y * Math.sin(t), c[1] + x * Math.sin(t) + y * Math.cos(t)]; });
  const inE = (p, e, g) => { const dx = p[0] - e.c[0], dy = p[1] - e.c[1], u = (dx * Math.cos(e.t) + dy * Math.sin(e.t)) / (e.a + g), v = (-dx * Math.sin(e.t) + dy * Math.cos(e.t)) / (e.b + g); return u * u + v * v < 1; };
  return {
    fits(c, t, a, b, gap = 0.4) {
      const me = { c, t, a, b }, mine = ring(c, t, a, b);
      return S.near(c).every((e) => dist(c, e.c) > a + e.a + gap || (!mine.some((p) => inE(p, e, gap)) && !e.pts.some((p) => inE(p, me, gap))));
    },
    add(c, t, a, b) { S.add(c, { c, t, a, b, pts: ring(c, t, a, b) }); },
  };
}
/**
 * Invasive adenocarcinoma (colorectal type) in a V × V field, laid out from the seed: 2–4 irregular,
 * angulated glands (one may be a cribriform nest with punched-out lumina); crowded, pseudostratified,
 * pleomorphic nuclei in the basal half of the epithelium (a few vesicular with a nucleolus, polarity lost
 * here and there); dirty necrosis in the largest lumen; a tumour bud in the stroma; desmoplastic stroma
 * with a few long collagen bundles hugging the glands, plump CAF nuclei on them and scattered lymphocytes.
 */
function tumourField(V, seed, { poly, line, nucleus, stellate }) {
  const G = rng(seed * 13 + 5);
  const vary = (v, fr) => v * (1 + (G() * 2 - 1) * fr);
  const NP = nucPacker();
  const sizeK = Math.min(1, V / 150);
  // ---------- glands: count, centres, size, rotation and cribriform-or-not all come from the seed
  const nG = V < 110 ? 2 : 2 + Math.floor(G() * 2.6);
  const cribAt = G() < 0.6 ? Math.floor(G() * Math.min(nG, 2)) : -1;
  const glands = [];
  for (let t = 0; glands.length < nG && t < 600; t++) {
    const first = !glands.length, crib = glands.length === cribAt;
    const rx = (crib ? 54 : 80) * sizeK * vary(1, 0.22), ry = rx * (0.62 + G() * 0.26), rot = G() * 180;
    const [lo, hi] = first ? [0.32, 0.68] : [-0.12, 1.12];
    const c = [V * (lo + G() * (hi - lo)), V * (lo + G() * (hi - lo))];
    const out = glandOutline(c[0], c[1], rx, ry, { rot, seed: seed * 31 + t, corners: G() < 0.6 ? 2 : 1 });
    const pad = offsetClosed(out, 10);
    if (glands.some((g) => g.out.some((p) => inside(pad, p)) || out.some((p) => inside(g.pad, p)))) continue;
    const vis = out.filter(([px, py]) => px > 6 && px < V - 6 && py > 6 && py < V - 6).length / out.length;
    if (vis < (first ? 0.5 : 0.22)) continue;
    glands.push({ out, pad, pad3: offsetClosed(out, 3), c, rx, ry, crib });
  }
  for (const [gi, g] of glands.entries()) {
    g.dC = nearest(g.out, g.c).d;
    if (g.crib) {
      // cribriform nest: solid epithelium with 2–4 round punched-out lumina
      g.lumens = [];
      const want = 2 + Math.floor(G() * 2.6);
      for (let t = 0; g.lumens.length < want && t < 400; t++) {
        const r = vary(6.4, 0.3) * (0.75 + 0.25 * sizeK), p = [g.c[0] + (G() * 2 - 1) * g.rx, g.c[1] + (G() * 2 - 1) * g.rx];
        if (!inside(g.out, p) || nearest(g.out, p).d < r + 10) continue;
        if (g.lumens.some((q) => dist(p, q.c) < r + q.r + 9)) continue;
        g.lumens.push({ c: p, r, pts: wobbly(p[0], p[1], r, r * (0.84 + G() * 0.2), { rot: G() * 180, wobble: 0.1, seed: seed + t, n: 24, harmonics: [2, 3] }) });
      }
    } else {
      g.th = Math.min(vary(42, 0.12) * (0.7 + 0.3 * sizeK), Math.max(g.dC - 13, g.dC * 0.72));
      g.lumens = [{ c: g.c, pts: innerOffset(g.out, g.c, g.th, { seed: seed * 3 + gi, irregular: 0.24 }) }];
    }
  }
  const gapToGlands = (p) => Math.min(...glands.map((g) => (inside(g.out, p) ? -1 : nearest(g.out, p).d)));
  // ---------- a tumour bud (a detached cluster of ≤ 4 cells) in the stroma ahead of a gland
  const bc = packWhere({ x: 20, y: 20, w: V - 40, h: V - 40 }, 1, 0, (p) => { const d = gapToGlands(p); return d > 17 && d < 36; }, { seed: seed * 5 + 9 })[0];
  const bud = bc ? { c: bc, pts: wobbly(bc[0], bc[1], vary(15, 0.08), vary(11.5, 0.08), { rot: G() * 180, wobble: 0.2, seed: seed + 77, n: 30, harmonics: [2, 3, 5] }) } : null;
  // ---------- desmoplastic stroma: 3–5 long bundles of 2–3 parallel strands following the gland contours
  const fibrePts = [], bundles = [];
  const nB = 3 + Math.floor(G() * 2.6);
  const order = glands.map((g, i) => [i, g.out.filter(([x, y]) => x > 0 && x < V && y > 0 && y < V).length]).filter((a) => a[1] > 10).sort((a, b) => b[1] - a[1]).map((a) => a[0]);
  for (let pass = 0; bundles.length < nB && pass < 3 && order.length; pass++) {
    for (const gi of order) {
      if (bundles.length >= nB) break;
      const g = glands[gi], n = g.out.length;
      const i0 = Math.floor(G() * n), span = Math.floor(n * (0.3 + G() * 0.25)), strands = G() < 0.5 ? 3 : 2, gap0 = 3.2 + G() * 2.5;
      let mid = null;
      for (let s = 0; s < strands; s++) {
        const off = offsetClosed(g.out, gap0 + s * 2.6);
        const a = i0 + Math.floor(G() * 5), b = i0 + span - Math.floor(G() * 5);
        let run = [];
        const flush = () => {
          if (run.length >= 6) { const sm = run.map((p, i) => (i && i < run.length - 1 ? [(run[i - 1][0] + 2 * p[0] + run[i + 1][0]) / 4, (run[i - 1][1] + 2 * p[1] + run[i + 1][1]) / 4] : p)); line("dfibre", sm); fibrePts.push(...sm); if (s === 1 || (!mid && s === 0)) mid = sm; }
          run = [];
        };
        for (let i = a; i <= b; i++) {
          const p = off[i % n];
          const ok = p[0] > -8 && p[0] < V + 8 && p[1] > -8 && p[1] < V + 8 && glands.every((h) => h === g || !inside(h.pad3, p)) && (!bud || dist(p, bud.c) > 17);
          if (ok) run.push(p); else flush();
        }
        flush();
      }
      if (mid) bundles.push(mid);
    }
  }
  // ---------- paint: epithelium, lumina, necrosis
  for (const g of glands) { poly("tumCyto", g.out, false); for (const l of g.lumens) poly("lumen", l.pts, false); }
  if (bud) poly("tumCyto", bud.pts, false);
  const big = glands.filter((g) => !g.crib && inside(g.out, g.c)).sort((a, b) => area(b.lumens[0].pts) - area(a.lumens[0].pts))[0];
  if (big && area(big.lumens[0].pts) > 380) {
    const lum = big.lumens[0].pts, ph = G() * 6.28, ph2 = G() * 6.28;
    const deb = lum.map((p, i) => { const a = (i / lum.length) * 6.28, k = 0.55 + 0.12 * Math.sin(3 * a + ph) + 0.06 * Math.sin(5 * a + ph2); return [big.c[0] + (p[0] - big.c[0]) * k, big.c[1] + (p[1] - big.c[1]) * k]; });
    poly("debris", deb, false);
    const din = offsetClosed(deb, -1.6);
    for (const p of packWhere(boxOfPts(deb), 9 + Math.floor(G() * 6), 4.6, (q) => inside(din, q), { seed: seed + 10 })) nucleus("dust", p[0], p[1], 1.1 + G() * 1.2, 0.9 + G() * 0.9, G() * 180, 0.2);
  }
  // ---------- tumour nuclei: crowded, staggered, pleomorphic; never overlapping
  const drawNuc = (c, t, len, wid, ves) => {
    nucleus("tumNuc", c[0], c[1], len, wid, t / DEG, 0.07);
    if (ves) {
      nucleus("nucPale", c[0] + 0.25, c[1] + 0.25, len * 0.58, wid * 0.55, t / DEG, 0.08);
      const a = G() * 6.28;
      nucleus("nucleolus", c[0] + Math.cos(a) * len * 0.18, c[1] + Math.sin(a) * wid * 0.18, 1.05, 0.95, 0, 0);
    }
  };
  for (const g of glands) {
    const bb = boxOfPts(g.out);
    const x0 = Math.max(bb.x, -14), x1 = Math.min(bb.x + bb.w, V + 14), y0 = Math.max(bb.y, -14), y1 = Math.min(bb.y + bb.h, V + 14);
    if (x1 <= x0 || y1 <= y0) continue;
    const lumPads = g.lumens.map((l) => offsetClosed(l.pts, 3));
    const band = g.crib ? Infinity : g.th * (0.6 + G() * 0.08);
    const tries = Math.round((g.crib ? 9000 : 9000) * ((x1 - x0) * (y1 - y0)) / (bb.w * bb.h));
    const n = g.out.length, sgn = signedArea(g.out) > 0 ? 1 : -1;
    for (let k = 0; k < tries; k++) {
      const ves = G() < 0.13, lost = G() < 0.08;
      const len = ves ? vary(5.4, 0.15) : vary(7.4, 0.3), wid = ves ? vary(4.2, 0.12) : vary(2.75, 0.28);
      let p;
      if (g.crib) p = [x0 + G() * (x1 - x0), y0 + G() * (y1 - y0)];
      else {
        // a point in the basal band, measured in from a random point of the basement membrane, deep enough for the whole nucleus
        const i = Math.floor(G() * n), f = G(), a = g.out[i], b = g.out[(i + 1) % n];
        const lo = len + 1.2, hi = band + 1.5 - len * 0.9;
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, dep = lo + G() * Math.max(0, hi - lo);
        p = [a[0] + dx * f - (dy / l) * sgn * dep, a[1] + dy * f + (dx / l) * sgn * dep];
      }
      if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
      if (!inside(g.out, p) || lumPads.some((lp) => inside(lp, p))) continue;
      let { d, q } = nearest(g.out, p);
      if (d > band) continue;
      if (g.crib) for (const l of g.lumens) { const dl = dist(p, l.c), e = dl - l.r; if (e < d) { d = e; q = [l.c[0] + ((p[0] - l.c[0]) * l.r) / dl, l.c[1] + ((p[1] - l.c[1]) * l.r) / dl]; } }
      const t = lost ? G() * Math.PI : Math.atan2(p[1] - q[1], p[0] - q[0]) + (G() - 0.5) * 0.7;
      const ct = Math.cos(t), st = Math.sin(t);
      const probe = [[p[0] - ct * len, p[1] - st * len], [p[0] + ct * len, p[1] + st * len], [p[0] - st * wid, p[1] + ct * wid], [p[0] + st * wid, p[1] - ct * wid]];
      if (probe.some((e) => !inside(g.out, e) || lumPads.some((lp) => inside(lp, e)))) continue;
      const pd = probe.map((e) => nearest(g.out, e).d);
      if (pd.some((v) => v < 1.1) || (!g.crib && pd.some((v) => v > band + 1.5))) continue;
      if (!NP.fits(p, t, len, wid, 0.45)) continue;
      NP.add(p, t, len, wid);
      drawNuc(p, t, len, wid, ves);
    }
  }
  if (bud) {
    const inner = offsetClosed(bud.pts, -1.4), bb = boxOfPts(bud.pts);
    for (let k = 0, m = 0; k < 500 && m < 4; k++) {
      const p = [bb.x + G() * bb.w, bb.y + G() * bb.h], len = vary(4.6, 0.15), wid = vary(3.4, 0.12), t = G() * Math.PI;
      const probe = [[p[0] - Math.cos(t) * len, p[1] - Math.sin(t) * len], [p[0] + Math.cos(t) * len, p[1] + Math.sin(t) * len], [p[0] - Math.sin(t) * wid, p[1] + Math.cos(t) * wid], [p[0] + Math.sin(t) * wid, p[1] - Math.cos(t) * wid]];
      if (!probe.every((e) => inside(inner, e)) || !NP.fits(p, t, len, wid, 0.6)) continue;
      NP.add(p, t, len, wid);
      drawNuc(p, t, len, wid, m === 0 || G() < 0.35);
      m++;
    }
  }
  // ---------- stroma cells: plump, slightly stellate CAF nuclei on the bundles; lymphocytes clear of the fibres
  for (let k = 0, m = 0; k < 60 && m < 3 + (G() < 0.5 ? 1 : 0) && bundles.length; k++) {
    const run = bundles[Math.floor(G() * bundles.length)], j = Math.floor((0.2 + G() * 0.6) * (run.length - 1));
    const p = run[j], q = run[Math.min(run.length - 1, j + 2)], t = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const len = vary(7.2, 0.18), wid = vary(3.1, 0.15);
    if (p[0] < 4 || p[0] > V - 4 || p[1] < 4 || p[1] > V - 4) continue;
    if (gapToGlands(p) < wid + 3 || !NP.fits(p, t, len, wid, 2)) continue;
    NP.add(p, t, len, wid);
    stellate("fibNuc", p[0], p[1], len, wid, t / DEG, seed * 3 + k);
    m++;
  }
  const lymR = 4.5;
  const lyms = packWhere({ x: -3, y: -3, w: V + 6, h: V + 6 }, 4 + Math.floor(G() * 4), 20, (p) => gapToGlands(p) > lymR + 3 && (!bud || dist(p, bud.c) > 20) && fibrePts.every((f) => dist(p, f) > lymR + 3.2) && NP.fits(p, 0, lymR, lymR, 1.5), { seed: seed * 7 + 1 });
  for (const p of lyms) { const r = vary(lymR, 0.12); NP.add(p, 0, r, r); nucleus("lymNuc", p[0], p[1], r, r * 0.93, G() * 180, 0.05); }
}

/**
 * Draw one H&E patch of `kind` into layers L, filling the square (x, y, s). The content is laid
 * out in a virtual V × V field (V = 200 is a ~112 µm tile; smaller V zooms in, for small tiles).
 * The layout comes from the seed; `orient` also turns/mirrors it (and tilts fibrous textures), so
 * tiles of one class in a mosaic never repeat a landmark.
 */
function hePatch(L, kind, { x, y, s, V = 200, seed = 1, radius = 0, orient = false, clip = null }) {
  const k = s / V;
  const o = orient ? Math.floor(rng(seed * 17 + 1)() * 8) : 0;
  const spin = orient && (kind === "stroma" || kind === "muscle") ? (rng(seed * 3 + 7)() - 0.5) * 60 : 0;
  const O = ([px, py]) => {
    let [u, v] = spin ? rotate([px, py], V / 2, V / 2, spin) : [px, py];
    u -= V / 2; v -= V / 2;
    if (o & 4) u = -u;
    for (let r = 0; r < (o & 3); r++) [u, v] = [-v, u];
    return [u + V / 2, v + V / 2];
  };
  const T = (p) => { const [px, py] = O(p); return [x + px * k, y + py * k]; };
  // clip: show only this window of the placed field (a crop of a larger tile)
  const box = clip ?? { x, y, w: s, h: s };
  const R = rng(seed);
  const add = (key, d) => d && L.add(key, d);
  /** closed shape in V-space → clipped path in place. */
  const poly = (key, pts, smooth = true) => {
    const q = pts.map(T);
    if (q.every((p) => inBox(box, p))) return add(key, smooth ? smoothClosed(q, smooth === true ? 1 : smooth) : polyD(q));
    const c = clipConvex(q, rectPoly(box.x, box.y, box.w, box.h));
    if (c.length >= 3 && area(c) > 0.3) add(key, polyD(c));
  };
  const line = (key, pts) => {
    for (const run of clipLine(pts.map(T), box)) add(key, run.length > 2 ? smoothOpen(run) : lineD(run));
  };
  const nucleus = (key, cx, cy, rx, ry, rot, wob = 0.08) => {
    const pts = ellPts(cx, cy, rx, ry, rot, 16).map(([px, py]) => {
      const w = 1 + (R() - 0.5) * 2 * wob;
      return [cx + (px - cx) * w, cy + (py - cy) * w];
    });
    poly(key, pts);
  };
  const spindleNuc = (key, cx, cy, len, wid, deg, bend = 0.3) => {
    const pts = [];
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const t = i / n, h = Math.pow(Math.sin(Math.PI * t), 0.6) * wid / 2;
      pts.push([(t - 0.5) * len, -h + bend * Math.sin(Math.PI * t) * wid]);
    }
    for (let i = n - 1; i >= 1; i--) {
      const t = i / n, h = Math.pow(Math.sin(Math.PI * t), 0.6) * wid / 2;
      pts.push([(t - 0.5) * len, h + bend * Math.sin(Math.PI * t) * wid]);
    }
    const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    poly(key, pts.map(([u, v]) => [cx + u * c - v * sn, cy + u * sn + v * c]), 0.85);
  };
  /** plump, slightly stellate nucleus (activated fibroblast / CAF): pointed ends and one or two short stubs. */
  const stellate = (key, cx, cy, len, wid, deg, sd) => {
    const S = rng(sd), n = 16, bump = Math.floor(S() * n), pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      let rr = 1 + 0.24 * Math.abs(ca) ** 8 + (S() - 0.5) * 0.12;
      if (i === bump || i === (bump + 9) % n) rr += 0.32;
      pts.push([ca * len * rr, sa * wid * rr]);
    }
    const r = deg * DEG, c = Math.cos(r), sn = Math.sin(r);
    poly(key, pts.map(([u, v]) => [cx + u * c - v * sn, cy + u * sn + v * c]), 0.8);
  };
  const tile = (key) => add(key, radius ? rect(box.x, box.y, box.w, box.h, radius) : polyD(rectPoly(box.x, box.y, box.w, box.h)));
  // generation margin: wide enough that a tilted (spun) field still has content in its corners
  const M = spin ? 0.24 * V : 12;
  const pack = (count, minD, test, sd, pad = -M) =>
    packWhere({ x: pad, y: pad, w: V - 2 * pad, h: V - 2 * pad }, count, minD, test, { seed: sd });

  /**
   * A capillary along a curve: red cells edge-on in single file — uneven spacing, a few short rouleaux,
   * an empty stretch or two, each tilted a little — and flat endothelial nuclei in the wall. Returns the centreline.
   */
  const capillary = (pts, r = 6.5) => {
    const c = catmull(pts, 8);
    poly("vessel", ribbonPts(c, r * 2), false);
    poly("vLumen", ribbonPts(c, r * 2 - 3.4), false);
    const rs = resample(c, 1);
    const at = (u) => { const i = clamp(Math.round(u), 1, rs.length - 2); const a = rs[i - 1], b = rs[i + 1]; return { p: rs[i], a: Math.atan2(b[1] - a[1], b[0] - a[0]) }; };
    for (let u = 3 + R() * 6; u < rs.length - 4; ) {
      if (R() < 0.12) { u += 13 + R() * 10; continue; }
      const stack = R() < 0.3 ? 3 + Math.floor(R() * 2) : 1, tilt = (R() - 0.5) * 50;
      for (let j = 0; j < stack && u < rs.length - 4; j++) {
        const { p, a } = at(u), sz = 0.88 + R() * 0.12;
        nucleus("rbc", p[0], p[1], stack > 1 ? 1.55 : 2.3, (r - 2.1) * sz, a / DEG + tilt + (R() - 0.5) * 8, 0.03);
        u += stack > 1 && j < stack - 1 ? 3.5 : 6.5 + R() * 7;
      }
    }
    let side = R() < 0.5 ? 1 : -1;
    for (let u = 6 + R() * 10; u < rs.length - 6; u += 18 + R() * 22) {
      const { p, a } = at(u);
      spindleNuc("fibNuc", p[0] - Math.sin(a) * (r - 0.6) * side, p[1] + Math.cos(a) * (r - 0.6) * side, 11 + R() * 3, 2.3, a / DEG, 0);
      if (R() < 0.7) side = -side;
    }
    return rs;
  };
  const lineDist = (pl, p) => pl.reduce((m, q) => Math.min(m, dist(p, q)), Infinity);

  if (kind === "tumour") {
    tile("tileStroma");
    tumourField(V, seed, { poly, line, nucleus, stellate });
  } else if (kind === "stroma") {
    tile("tileStroma");
    const G = rng(seed * 5 + 3), lo = -Math.max(30, M);
    // collagen bundles in wavy, roughly parallel streams with pale clefts between them (uneven widths and gaps)
    const flows = [];
    for (let y0 = lo - 70 + G() * 12; y0 < V - lo; y0 += 22 + G() * 16) {
      const w = 12 + G() * 12, ph = G() * 6, pts = [];
      for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push([lo + t * (V - 2 * lo), y0 + t * 70 + Math.sin(t * 5 + ph) * 7]); }
      flows.push({ pts, w });
      poly("collagen", ribbonPts(catmull(pts, 6), w, 0.18), false);
    }
    for (const fl of flows) {
      const c = catmull(fl.pts, 6);
      for (const off of [-fl.w * 0.22, fl.w * 0.2]) line("fibre", offsetOpen(c, off).filter((_, i) => i % 2 === 0));
    }
    // a capillary across (present in most tiles)
    let cap = null;
    const capR = 6.5;
    if (!orient || G() < 0.7) {
      const yb = V * (0.7 + (G() - 0.5) * 0.3);
      cap = capillary([[lo, yb + 6], [V * 0.25, yb - 10 + G() * 6], [V * 0.55, yb + 2], [V * 0.8, yb - 12 + G() * 6], [V - lo, yb - 2]], capR);
    }
    const clearOfCap = (pts, gap) => !cap || pts.every((p) => lineDist(cap, p) > capR + gap);
    // wavy fibroblast nuclei along the bundles, each clear of the capillary wall
    for (const fl of flows) {
      const c = catmull(fl.pts, 6);
      for (let m = 0; m < 2; m++) {
        const idx = Math.floor((0.15 + R() * 0.7) * (c.length - 1));
        const p = c[idx], q = c[Math.min(c.length - 1, idx + 2)], a = Math.atan2(q[1] - p[1], q[0] - p[0]);
        const len = 26 + R() * 12, cy = p[1] + (R() - 0.5) * fl.w * 0.4;
        const ends = [-0.5, -0.25, 0, 0.25, 0.5].map((t) => [p[0] + Math.cos(a) * len * t, cy + Math.sin(a) * len * t]);
        if (R() < 0.75 && clearOfCap(ends, 3 + 2.5)) spindleNuc("fibNuc", p[0], cy, len, 3.6 + R() * 0.8, a / DEG, (R() - 0.5) * 1.2);
      }
    }
    for (const p of pack(3, 40, (q) => clearOfCap([q], 8) && q[0] > 4 && q[0] < V - 4 && q[1] > 4 && q[1] < V - 4, seed + 7)) nucleus("lymNuc", p[0], p[1], 4.5, 4.2, 0);
  } else if (kind === "lymph") {
    tile("tileLym");
    const G = rng(seed * 11 + 4), NP = nucPacker();
    const vr = (v, fr) => v * (1 + (G() * 2 - 1) * fr);
    const discs = []; // [x, y, r] kept clear of the small lymphocytes
    if (!orient || G() < 0.65) {
      // high endothelial venule: plump cuboidal endothelium round a slit-like lumen (one red cell), lymphocytes crossing the wall
      const hc = [V * (0.3 + G() * 0.4), V * (0.28 + G() * 0.4)], rot = G() * 180, rx = 19 + G() * 4, ry = 14 + G() * 3;
      const cr = Math.cos(rot * DEG), sr = Math.sin(rot * DEG), loc = (u, v) => [hc[0] + u * cr - v * sr, hc[1] + u * sr + v * cr];
      poly("vessel", wobbly(hc[0], hc[1], rx, ry, { rot, wobble: 0.1, seed: seed + 3, n: 40 }), false);
      const srx = rx * 0.46, sry = 2.5 + G() * 1.1;
      poly("vLumen", wobbly(hc[0], hc[1], srx, sry, { rot, wobble: 0.26, seed: seed + 4, n: 30, harmonics: [2, 3, 4] }), false);
      const rb = loc(srx * 0.2, 0);
      nucleus("rbc", rb[0], rb[1], 3.2, Math.min(2.2, sry * 0.72), rot, 0.03);
      const angs = unevenAngles(5 + Math.floor(G() * 3), G, { cv: 0.3 });
      for (const a of angs) {
        const ca = Math.cos(a * DEG), sa = Math.sin(a * DEG), rs = 1 / Math.hypot(ca / srx, sa / sry), sz = vr(1, 0.25);
        const p = loc(ca * (rs + 4.1 * sz), sa * (rs + 4.1 * sz));
        const t = Math.atan2(p[1] - hc[1], p[0] - hc[0]) + Math.PI / 2, len = 5 * sz, wid = 3.7 * sz;
        if (!NP.fits(p, t, len, wid, 0.3)) continue;
        NP.add(p, t, len, wid);
        nucleus("histNuc", p[0], p[1], len, wid, t / DEG, 0.08);
      }
      // 1–2 lymphocytes squeezing through the wall, in the widest gaps between endothelial nuclei
      const sorted = [...angs].sort((p, q) => p - q), gaps = sorted.map((a, i) => [a, ((sorted[(i + 1) % sorted.length] - a + 360) % 360)]).sort((p, q) => q[1] - p[1]);
      for (const [a, g] of gaps.slice(0, 1 + (G() < 0.6 ? 1 : 0))) {
        const m = (a + g / 2) * DEG, ca = Math.cos(m), sa = Math.sin(m), rw = 1 / Math.hypot(ca / rx, sa / ry);
        const p = loc(ca * rw * 0.93, sa * rw * 0.93), t = Math.atan2(p[1] - hc[1], p[0] - hc[0]);
        if (!NP.fits(p, t, 4.9, 3.4, 0.3)) continue;
        NP.add(p, t, 4.9, 3.4);
        nucleus("lymNuc", p[0], p[1], 4.9, 3.4, t / DEG, 0.06);
      }
      discs.push([hc[0], hc[1], Math.max(rx, ry) + 1.5]);
    }
    // large pale cells (tingible-body macrophages / centroblasts): vesicular nucleus with a nucleolus
    const nBig = 2 + Math.floor(G() * 3);
    for (const p of packWhere({ x: 12, y: 12, w: V - 24, h: V - 24 }, nBig, 46, (q) => discs.every(([dx, dy, r]) => Math.hypot(q[0] - dx, q[1] - dy) > r + 16), { seed: seed * 3 + 1 })) {
      const rc = vr(13, 0.12);
      poly("histCyto", wobbly(p[0], p[1], rc, rc * 0.86, { rot: G() * 180, wobble: 0.12, seed: (seed + p[0]) | 0, n: 24 }), false);
      const nr = vr(7.4, 0.1);
      nucleus("histNuc", p[0] + 0.8, p[1], nr, nr * 0.86, G() * 180, 0.07);
      nucleus("nucleolus", p[0] + (G() - 0.5) * 4, p[1] + (G() - 0.5) * 4, 1.3, 1.2, 0, 0);
      discs.push([p[0], p[1], rc + 0.5]);
    }
    // a few larger, paler, cleaved (centrocyte-like) nuclei
    for (const p of packWhere({ x: 6, y: 6, w: V - 12, h: V - 12 }, 3 + Math.floor(G() * 3), 30, (q) => discs.every(([dx, dy, r]) => Math.hypot(q[0] - dx, q[1] - dy) > r + 7), { seed: seed * 5 + 2 })) {
      const r = vr(5.6, 0.1), pts = ellPts(p[0], p[1], r, r * 0.8, G() * 180, 20), ci = Math.floor(G() * 20);
      poly("cleavNuc", pts.map((pt, i) => { let di = Math.abs(i - ci); di = Math.min(di, 20 - di); const f2 = di < 3 ? 1 - 0.36 * (1 - di / 3) : 1; return [p[0] + (pt[0] - p[0]) * f2, p[1] + (pt[1] - p[1]) * f2]; }), 0.9);
      NP.add(p, 0, r, r);
    }
    // small lymphocytes: densely packed, many touching, sizes ±15%
    const want = Math.round((V + 12) ** 2 / 128);
    for (let t = 0, m = 0; t < want * 40 && m < want; t++) {
      const p = [-6 + G() * (V + 12), -6 + G() * (V + 12)], r = vr(4.6, 0.15);
      if (discs.some(([dx, dy, rr]) => Math.hypot(p[0] - dx, p[1] - dy) < rr + r + 0.3)) continue;
      if (!NP.fits(p, 0, r, r, G() < 0.4 ? 0.05 : 1.3 + G() * 1.6)) continue;
      NP.add(p, 0, r, r);
      nucleus("lymNuc", p[0], p[1], r, r * (0.88 + G() * 0.1), G() * 180, 0.05);
      m++;
    }
  } else if (kind === "fat") {
    tile("tileFat");
    for (const c of honeycomb(-30, -30, V + 60, V + 60, 46, { jitter: 0.24, seed })) {
      const p = shrink(c.poly, 0.86 + R() * 0.03);
      poly("fat", catmull(p, 3, true), false);
    }
    for (const p of pack(4, 60, () => true, seed + 3)) spindleNuc("fibNuc", p[0], p[1], 16, 3, R() * 180, 0.4);
  } else if (kind === "mucus") {
    tile("tileMuc");
    for (let j = 0; j < 9; j++) {
      const y0 = j * 24 + R() * 8;
      const pts = [];
      for (let i = 0; i <= 8; i++) pts.push([-10 + i * 28, y0 + Math.sin(i * 0.9 + j + R()) * 9 + i * 3]);
      line("mucStrand", catmull(pts, 4));
    }
    for (const p of pack(3, 60, () => true, seed + 2, 30)) {
      poly("ghost", ellPts(p[0], p[1], 9, 7, R() * 180, 16));
      nucleus("epiNuc", p[0], p[1], 3.6, 3.2, 0);
    }
  } else if (kind === "muscle") {
    tile("tileMus");
    const G = rng(seed * 23 + 1), lo = -Math.max(20, M);
    for (let y0 = lo - 30 + G() * 10; y0 < V - lo + 20; y0 += 24 + G() * 12) {
      const pts = [], ph = G() * 6;
      for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push([lo + t * (V - 2 * lo), y0 + Math.sin(t * 5.6 + ph) * 5 - t * 16]); }
      line("musCleft", catmull(pts, 4));
    }
    for (const p of pack(Math.round(26 * ((V + 2 * M) / (V + 24)) ** 2), 18, () => true, seed + 4)) {
      // cigar-shaped nuclei with blunt ends, all along the fibres
      const len = 20 + R() * 10, a = -4 + (R() - 0.5) * 10;
      poly("fibNuc", capsulePts(p[0], p[1], len, 3.3, a));
    }
  } else if (kind === "normal") {
    tile("tileLp");
    // colonic crypts in cross-section: goblet cells, basal nuclei, small central lumen; positions from the seed
    const crypts = packWhere({ x: -0.12 * V, y: -0.12 * V, w: 1.24 * V, h: 1.24 * V }, 9, 70, () => true, { seed: seed * 7 + 3 });
    const pts = crypts.map(([cx, cy], i) => wobbly(cx, cy, 31 + R() * 5, 27 + R() * 5, { rot: R() * 180, wobble: 0.07, seed: seed + i, n: 48 }));
    const nearCrypt = (p) => crypts.some(([cx, cy]) => Math.hypot(p[0] - cx, p[1] - cy) < 40);
    for (const p of pack(30, 9.5, (q) => !nearCrypt(q), seed + 5)) nucleus("lymNuc", p[0], p[1], 4.2, 3.9, 0);
    crypts.forEach(([cx, cy], i) => {
      poly("cryptCyto", pts[i], false);
      const ring = resample([...pts[i], pts[i][0]], 13);
      ring.slice(0, -1).forEach((p) => {
        const dx = cx - p[0], dy = cy - p[1], l = Math.hypot(dx, dy);
        const ux = dx / l, uy = dy / l;
        if (R() < 0.55) poly("goblet", ellPts(p[0] + ux * (13 + R() * 4), p[1] + uy * (13 + R() * 4), 5 + R() * 2.5, 3.6 + R() * 1.6, (Math.atan2(uy, ux) * 180) / Math.PI + (R() - 0.5) * 30, 14));
        nucleus("epiNuc", p[0] + ux * (5 + R() * 1.5), p[1] + uy * (5 + R() * 1.5), 3.8 + R() * 0.9, 2.4 + R() * 0.5, (Math.atan2(uy, ux) * 180) / Math.PI, 0.08);
      });
      poly("lumen", ellPts(cx, cy, 5.5, 4.5, 0, 12));
    });
  } else if (kind === "debris") {
    tile("tileNec");
    for (const p of pack(9, 34, () => true, seed + 1)) poly("ghost", wobbly(p[0], p[1], 14, 11, { rot: R() * 180, wobble: 0.2, seed: Math.round(p[0] + p[1]), n: 24 }), false);
    for (const p of pack(70, 7, () => true, seed + 2, -4)) nucleus("dust", p[0], p[1], 1.3 + R() * 1.8, 1 + R() * 1.4, R() * 180, 0.25);
    for (const p of pack(6, 30, () => true, seed + 3, 10)) {
      // neutrophils: segmented nuclei
      for (let m = 0; m < 3; m++) nucleus("lymNuc", p[0] + Math.cos(m * 2.1) * 3.4, p[1] + Math.sin(m * 2.1) * 3.4, 2.4, 2.1, 0);
    }
  }
}

/** Closed outline of a band of width w along an open polyline (points, not path). */
function ribbonPts(c, w, taper = 0) {
  const left = [], right = [];
  for (let i = 0; i < c.length; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const t = i / (c.length - 1);
    const hw = (w / 2) * (1 - taper * Math.abs(t - 0.5) * 2) * (1 + 0.12 * Math.sin(t * 9));
    left.push([c[i][0] - (dy / l) * hw, c[i][1] + (dx / l) * hw]);
    right.push([c[i][0] + (dy / l) * hw, c[i][1] - (dx / l) * hw]);
  }
  return [...left, ...right.reverse()];
}
function offsetOpen(c, d) {
  return c.map((p, i) => {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / l) * d, p[1] + (dx / l) * d];
  });
}
function capsulePts(cx, cy, len, r, deg) {
  const pts = [];
  for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + (i / 8) * Math.PI; pts.push([len / 2 - r + Math.cos(a) * r, Math.sin(a) * r]); }
  for (let i = 0; i <= 8; i++) { const a = Math.PI / 2 + (i / 8) * Math.PI; pts.push([-len / 2 + r + Math.cos(a) * r, Math.sin(a) * r]); }
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return pts.map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
}

/** A single large H&E patch icon. */
function patchScene(kind, seed) {
  const L = new Layers();
  heLayers(L, 1);
  hePatch(L, kind, { x: 8, y: 8, s: 184, V: 200, seed, radius: 0 });
  return { size: [200, 200], lineWidth: 1.4, parts: L.parts() };
}

/** Mosaic of patches (a training set / tile dataset): every tile has its own seeded layout and orientation. */
function patchGrid() {
  const L = new Layers();
  heLayers(L, 0.7);
  const n = 4, gap = 5, s = (184 - gap * (n - 1)) / n;
  const kinds = ["tumour", "stroma", "lymph", "fat", "normal", "debris", "muscle", "tumour", "lymph", "mucus", "tumour", "stroma", "muscle", "normal", "fat", "lymph"];
  kinds.forEach((kind, i) => {
    const r = Math.floor(i / n), c = i % n;
    hePatch(L, kind, { x: 8 + c * (s + gap), y: 8 + r * (s + gap), s, V: kind === "lymph" ? 100 : kind === "fat" ? 100 : 120, seed: GRID_SEEDS[i] ?? 11 + i * 7, orient: true });
  });
  return { size: [200, 200], lineWidth: 1, parts: L.parts() };
}
/** Per-tile seed overrides, chosen so same-class tiles differ (muscle: one near-horizontal, one near-vertical; one lymph tile without a venule). */
const GRID_SEEDS = { 6: 126, 8: 111, 12: 130, 15: 103 };

/* ============================== placement, shading, arrows (as in methods-seq / -spatial) ============================== */

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
/** Map parts built in local coordinates through placement t (geometry, stroke and outline widths). */
function xform(parts, t) {
  return parts.map((p) => {
    const q = { ...p };
    if (p.unite) q.unite = p.unite.map((d) => mapPath(d, t.P));
    if (p.d) q.d = Array.isArray(p.d) ? p.d.map((d) => mapPath(d, t.P)) : mapPath(p.d, t.P);
    if (p.stroke) q.stroke = { ...p.stroke, width: p.stroke.width * t.s, ...(p.stroke.dash ? { dash: p.stroke.dash.map((v) => v * t.s) } : {}) };
    if (p.lineStrokeWidth) q.lineStrokeWidth = p.lineStrokeWidth * t.s;
    if (p.lineWidth) q.lineWidth = p.lineWidth * t.s;
    return q;
  });
}

/** Overlay highlight / shadow parts (soft style only). */
const glow = (d, opacity = 0.6, extra = {}) => ({ d, fill: HI, opacity, line: false, ...extra });
const dim = (d, opacity = 0.14, extra = {}) => ({ d, fill: SHADOW, opacity, line: false, ...extra });

/** Edge crescent for a flat rounded-rectangle face (bottom/right dark; flip: top/left light). */
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
/** Flat face + dark crescent (bottom right) + light crescent (top left), soft style only. */
const faceShade = (x, y, w, h, r, fill, { bw = 3, hw = 2.4, dark = 0.1, light = 0.5 } = {}) => [
  { d: edgeBand(x, y, w, h, r, bw), fill: shade(fill, dark), line: false },
  glow(edgeBand(x, y, w, h, r, hw, { flip: true }), light),
];
/** Instrument box in 3/4 view: side face (shadow), top face (lit), front face. */
function boxFaces(x, y, W, H, D, { body = COL.body, top = COL.top, side = COL.side, r = 3 } = {}) {
  const a = [x, y], b = [x + W, y], c = [x + W, y + H], d = [x, y + H], t = (p) => [p[0] + D[0], p[1] + D[1]];
  return [
    { d: roundPoly([a, t(a), t(b), t(c), c, d], r), fill: side },
    { d: roundPoly([a, t(a), t(b), b], r), fill: top },
    { d: rect(x, y, W, H, r), fill: body }, ...faceShade(x, y, W, H, r, body, { bw: 3, light: 0.7 }),
  ];
}

/** Block arrow pointing right from x0 to x1 at height y (Servier-like, rounded corners). */
function arrowD(x0, x1, y, h = 12, head = 1.9) {
  const hh = (h * head) / 2, hl = Math.min((x1 - x0) * 0.55, h * 1.15);
  return roundPoly([[x0, y - h / 2], [x1 - hl, y - h / 2], [x1 - hl, y - hh], [x1, y], [x1 - hl, y + hh], [x1 - hl, y + h / 2], [x0, y + h / 2]], 1.6);
}
const arrowPart = (ds, fill = COL.arrow) => ({ d: [].concat(ds).join(""), fill, shade: "rim", gloss: false, highlight: false, thin: true });

function boundsOf(parts) {
  return pathBox(parts.flatMap((p) => p.unite || (Array.isArray(p.d) ? p.d : [p.d])).filter(Boolean));
}
/** Scale + move parts (path data, stroke widths, outline widths). */
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
/** Thin line arrows (diagram connectors): [shaft, head] in one colour. */
function lineArrows(list, { color = D.arrow, width = 1.8, head = 6.5, dash = null } = {}) {
  return arrowParts(list.map(([x0, y0, x1, y1, curve]) => arrow(x0, y0, x1, y1, { head, curve })), { color, width, dash });
}

/* ============================== H&E sections and patches at icon scale ============================== */

const PATCH_V = { tumour: 120, stroma: 130, lymph: 90, fat: 100, mucus: 120, muscle: 120, normal: 130, debris: 110 };
/** Several H&E patches in one Layers set (each stain colour is one compound part). list: [{kind, x, y, s, V?, seed?}] */
function hePatches(list, lw = 0.6) {
  const L = new Layers();
  heLayers(L, lw);
  for (const p of list) hePatch(L, p.kind, { x: p.x, y: p.y, s: p.s, V: p.V ?? PATCH_V[p.kind] * (p.s < 30 ? 0.75 : 1), seed: p.seed ?? 5, orient: p.orient ?? true, clip: p.clip });
  return L.parts();
}
/** Thin frames round squares [x, y, s]. */
const frames = (list, { color = "#6f7d8c", width = 1.2 } = {}) => ({ d: list.map(([x, y, s]) => rect(x, y, s, s)).join(""), fill: "none", stroke: { color, width, cap: "butt" }, lineStrokeWidth: width * 0.9 });

/**
 * A whole H&E section at low power (on the slide / as a WSI thumbnail): eosinophilic tissue, a purple
 * mucosal band along part of the edge, an invasive tumour (dense haematoxylin) growing in from it with
 * a few satellite nests at its front, lymphoid aggregates (Crohn-like reaction) in the deep tissue round the
 * invasive front, fat vacuoles and vessel lumina, a few vessels. Returns { parts, out, tumAll, aggs, holes, s }.
 * aggR: [min, max] aggregate radius; bigAgg: radius of one large aggregate just beyond the tumour's deep edge
 * (first in .aggs), its centre passed through snap(c) (e.g. onto a patch-grid cell).
 */
function section(cx, cy, rx, ry, { seed = 5, rot = 0, band = [0.56, 0.42], tumAt = 0.45, tumSize = 0.34, holes = 24, aggs = 5, aggR = null, bigAgg = 0, snap = null, vessels = 4, lw = 1, wobble = 0.2, harmonics = [2, 3, 5, 7, 11] } = {}) {
  const s = Math.sqrt(rx * ry) / 64;
  const R = rng(seed + 17);
  const out = catmull(wobbly(cx, cy, rx, ry, { rot, wobble, seed, n: 44, harmonics }), 6, true);
  const n = out.length;
  const sgn = signedArea(out) > 0 ? 1 : -1;
  const nin = (i) => {
    const a = out[(i - 3 + n) % n], b = out[(i + 3) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [(-dy / l) * sgn, (dx / l) * sgn];
  };
  // mucosa: a band of varying thickness along part of the edge, tapering into it at both ends
  // (a gut-wall-like layering: mucosa, submucosa, muscularis propria, then fat)
  const i0 = Math.floor(n * band[0]), m = Math.floor(n * band[1]);
  const bo = [], bi = [], mo = [], mi = [];
  for (let k = 0; k <= m; k++) {
    const i = (i0 + k) % n, t = k / m, taper = Math.pow(Math.sin(Math.PI * t), 0.3), taper2 = Math.pow(Math.sin(Math.PI * t), 0.55);
    const th = s * (8.5 + 2.5 * Math.sin(t * 11 + seed) + 1.5 * Math.sin(t * 29 + 2 * seed)) * taper;
    const d1 = th + s * (6 + 2 * Math.sin(t * 7 + seed)) * taper2, d2 = d1 + s * (8.5 + 2.5 * Math.sin(t * 5 + 3 * seed)) * taper2;
    const [nx, ny] = nin(i), p = out[i];
    bo.push(p);
    bi.push([p[0] + nx * th, p[1] + ny * th]);
    mo.push([p[0] + nx * d1, p[1] + ny * d1]);
    mi.push([p[0] + nx * d2, p[1] + ny * d2]);
  }
  const bandPoly = [...bo, ...[...bi].reverse()];
  const musPoly = [...mo.slice(1, -1), ...[...mi].reverse().slice(1, -1)];
  const inner = offsetClosed(out, -3 * s);
  // tumour: grows in from the mucosa towards the centre
  const im = (i0 + Math.floor(m * tumAt)) % n, [nx, ny] = nin(im);
  const tc = [out[im][0] + nx * ry * 0.42, out[im][1] + ny * ry * 0.42];
  let tum = wobbly(tc[0], tc[1], rx * tumSize, ry * tumSize * 1.05, { rot: rot + 20, wobble: 0.28, seed: seed + 3, n: 60, harmonics: [2, 3, 5, 8] });
  tum = fitInside(tum, inner, 1.5 * s) ?? tum;
  const tcen = centroid(tum);
  const sat = [];
  for (const k of [0.15, -0.55, 0.75]) {
    const a = Math.atan2(cy - tcen[1], cx - tcen[0]) + k;
    let best = tum[0], bv = -1e9;
    for (const p of tum) { const v = (p[0] - tcen[0]) * Math.cos(a) + (p[1] - tcen[1]) * Math.sin(a); if (v > bv) { bv = v; best = p; } }
    const r = s * (2.6 + R() * 2.2);
    const c = [best[0] + Math.cos(a) * (r + 3.2 * s), best[1] + Math.sin(a) * (r + 3.2 * s)];
    const pts = wobbly(c[0], c[1], r, r * 0.8, { rot: R() * 180, wobble: 0.25, seed: seed + 30 + sat.length, n: 20 });
    if (pts.every((p) => inside(inner, p))) sat.push(pts);
  }
  const tumAll = [tum, ...sat];
  const tumPad = offsetClosed(tum, 5 * s);
  // lymphoid aggregates (Crohn-like lymphoid reaction): deep to the mucosa, round the tumour's invasive front
  const depth = (p) => (p[0] - out[im][0]) * nx + (p[1] - out[im][1]) * ny;
  const tumDeep = Math.max(...tum.map(depth)), secDeep = Math.max(...out.map(depth));
  const tumPts = tumAll.flat();
  const tumD = (p) => tumPts.reduce((a, q) => Math.min(a, dist(p, q)), Infinity);
  const okAgg = (c, r, pts) => pts.every((p) => inside(inner, p)) && !tumAll.some((t) => inside(t, c)) && tumD(c) > r + 2.2 * s && !inside(bandPoly, c) && !inside(musPoly, c);
  const ag = [];
  if (bigAgg) {
    const deepest = tum.reduce((a, p) => (depth(p) > depth(a) ? p : a));
    for (let k = 0; k < 10 && !ag.length; k++) {
      const off = bigAgg + (2.5 + k * 2.5) * s;
      let c = [deepest[0] + nx * off, deepest[1] + ny * off];
      if (snap) c = snap(c);
      const pts = wobbly(c[0], c[1], bigAgg, bigAgg * 0.97, { wobble: 0.05, seed: seed + 41, n: 36, harmonics: [2, 3, 5] });
      if (okAgg(c, bigAgg, pts)) ag.push([c[0], c[1], bigAgg, pts]);
    }
  }
  const [r0, r1] = aggR || [4 * s, 5.5 * s];
  const cand = packWhere(boxOfPts(out), 80, 5 * s, (p) => inside(inner, p) && depth(p) > Math.min(tumDeep * 0.7, secDeep * 0.5), { seed: seed + 9 })
    .map((p) => [p, Math.abs(tumD(p) - 12 * s) + R() * 10 * s]).sort((a, b) => a[1] - b[1]).map((a) => a[0]);
  for (const c of cand) {
    if (ag.length >= aggs + (bigAgg ? 1 : 0)) break;
    const r = r0 + R() * (r1 - r0);
    if (ag.some(([x, y, rr]) => Math.hypot(c[0] - x, c[1] - y) < r + rr + 7 * s)) continue;
    const pts = wobbly(c[0], c[1], r, r * (0.8 + R() * 0.15), { rot: R() * 180, wobble: 0.14, seed: seed + 50 + ag.length, n: 22, harmonics: [2, 3] });
    if (okAgg(c, r, pts)) ag.push([c[0], c[1], r, pts]);
  }
  // fat vacuoles / lumina in clusters (submucosa, subserosal fat), and small vessels
  const deep = offsetClosed(out, -6 * s);
  const bb = boxOfPts(out);
  const clear = (p, gap) => inside(deep, p) && !inside(bandPoly, p) && !inside(musPoly, p) && !tumAll.some((t) => inside(offsetClosed(t, gap), p)) && bi.every((q) => dist(p, q) > gap) && mi.every((q) => dist(p, q) > gap) && mo.every((q) => dist(p, q) > gap) && ag.every(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) > r + gap);
  const hs = holes ? clustered(R, bb, holes, { clusters: 3, spread: 0.12, minDist: 5.6 * s, test: (p) => clear(p, 5 * s) }) : [];
  const vs = vessels ? packWhere(bb, vessels, 16 * s, (p) => clear(p, 4 * s) && hs.every((q) => dist(p, q) > 5 * s), { seed: seed + 5 }) : [];
  const holeD = hs.map(([x, y]) => { const r = s * (1.3 + R() * 2.1); return ellipse(x, y, r, r * (0.68 + R() * 0.3), R() * 180); }).join("");
  const parts = [
    { d: polyD(out), fill: SEC.tissue, shade: "body", gloss: false, highlight: false, lineWidth: 1 * lw },
    { d: polyD(musPoly), fill: SEC.muscle, thin: true, lineWidth: 0.5 * lw },
    { d: polyD(bandPoly), fill: SEC.mucosa, thin: true, lineWidth: 0.7 * lw },
    { d: tumAll.map(polyD).join(""), fill: SEC.tumour, thin: true, lineWidth: 0.7 * lw },
  ];
  if (ag.length) parts.push({ d: ag.map((a) => smoothClosed(a[3])).join(""), fill: SEC.agg, shade: "small", lineWidth: 0.5 * lw });
  if (hs.length) parts.push({ d: holeD, fill: SEC.hole, lineWidth: 0.45 * lw });
  if (vs.length) parts.push({ d: vs.map(([x, y]) => ellipse(x, y, 1.5 * s, 1.15 * s, R() * 180)).join(""), fill: SEC.rbc, lineWidth: 0.4 * lw });
  return { parts, out, tumAll, aggs: ag, holes: hs, band: bandPoly, s };
}
function boxOfPts(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Attention / prediction heatmap over a section: patch squares whose centre lies on tissue, coloured by score. */
function heatSquares(sec, { p = 7, seed = 9, opacity = 0.42, lw = 0.25 } = {}) {
  const R = rng(seed);
  const bb = boxOfPts(sec.out);
  const levels = HEAT.map(() => []);
  const tumPts = sec.tumAll.flat();
  for (let y = Math.floor(bb.y / p) * p; y < bb.y + bb.h; y += p) {
    for (let x = Math.floor(bb.x / p) * p; x < bb.x + bb.w; x += p) {
      const c = [x + p / 2, y + p / 2], corners = [[x, y], [x + p, y], [x + p, y + p], [x, y + p]];
      const nIn = corners.filter((q) => inside(sec.out, q)).length;
      if (!nIn && !inside(sec.out, c)) continue;
      // squares on the tissue edge are clipped to the section, so the overlay follows the tissue
      const piece = nIn === 4 ? null : clipConvex(sec.out, corners);
      if (piece && (piece.length < 3 || area(piece) < 1.2)) continue;
      const inT = sec.tumAll.some((t) => inside(t, c));
      const d = inT ? 0 : Math.min(...tumPts.map((q) => dist(c, q)));
      // smooth falloff from the tumour plus a little low-frequency variation (no salt-and-pepper speckle)
      const wave = 0.05 * Math.sin(c[0] * 0.11 + seed) * Math.cos(c[1] * 0.13 - seed);
      let v = inT ? 0.88 + R() * 0.12 : 0.8 * Math.exp(-(d * d) / (2 * (14 * sec.s) ** 2)) + 0.06 + wave + R() * 0.06;
      for (const [ax, ay, ar] of sec.aggs) if (Math.hypot(c[0] - ax, c[1] - ay) < ar + p * 0.6) v = Math.max(v, 0.36 + R() * 0.1);
      levels[Math.max(0, Math.min(HEAT.length - 1, Math.floor(v * HEAT.length)))].push(piece ? polyD(piece) : rect(x, y, p, p));
    }
  }
  // one opacity for every level (as in CLAM / ABMIL overlays), so the H&E shows through evenly
  return levels.map((ds, i) => ds.length && { d: ds.join(""), fill: HEAT[i], opacity, lineWidth: lw }).filter(Boolean);
}
/** Vertical colour bar (low at the bottom). */
function colourBar(x, y, w, h, colors = HEAT) {
  const k = h / colors.length;
  return [
    ...colors.map((c, i) => ({ d: rect(x, y + h - (i + 1) * k, w, k + 0.01), fill: c, lineWidth: 0.3 })),
    { d: rect(x, y, w, h, 0.5), fill: "none", stroke: { color: "#8b97a5", width: 0.8 }, lineStrokeWidth: 0.8 },
  ];
}

/* ============================== slides and scanner ============================== */

/** A glass slide seen from above: edge (thickness), glass face and a frosted label end. */
function slideTop(x, y, w, h, { label = 0.26, r = 3 } = {}) {
  const parts = [
    { d: rect(x + 1.6, y + 3, w, h, r), fill: COL.glassEdge },
    { d: rect(x, y, w, h, r), fill: COL.glass }, ...faceShade(x, y, w, h, r, COL.glass, { bw: 2.2, hw: 2, light: 0.7 }),
  ];
  if (label) parts.push({ d: rect(x + 2.5, y + 2.5, w * label, h - 5, 2), fill: COL.frost, lineWidth: 0.9 });
  return parts;
}
const glare = (x0, y0, h, k = 1, a = 0.42) => [
  glow(polyD([[x0, y0], [x0 + 12 * k, y0], [x0 - 14 * k, y0 + h], [x0 - 26 * k, y0 + h]]), a),
  glow(polyD([[x0 + 17 * k, y0], [x0 + 21 * k, y0], [x0 - 5 * k, y0 + h], [x0 - 9 * k, y0 + h]]), a * 0.8),
];
/** 2-D (Data Matrix-like) barcode: solid L finder on the left and bottom, clock track on top and right. */
function datamatrix(x, y, mod, n = 10, seed = 3) {
  const R = rng(seed), d = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const on = i === 0 || j === n - 1 ? true : j === 0 ? i % 2 === 0 : i === n - 1 ? j % 2 === 1 : R() < 0.5;
    if (on) d.push(rect(x + i * mod - 0.06, y + j * mod - 0.06, mod + 0.12, mod + 0.12));
  }
  return d;
}

/** Standard 75 × 25 mm slide: barcode label, coverslip (24 × 50 mm) over an H&E-stained resection section. */
function heSlideParts({ x = 10, y = 12, w = 228, h = 76, seed = 8 } = {}) {
  const k = w / 75; // units per mm
  const parts = slideTop(x, y, w, h, { label: 0.26 });
  const lx = x + 6, ly = y + 7, lw = w * 0.26 - 7.5, lh = h - 14;
  parts.push({ d: rect(lx, ly, lw, lh, 2.5), fill: COL.label, lineWidth: 0.8 });
  const mod = Math.min(lw, lh) * 0.05;
  // the dark modules merged into one shape (no seams between modules); the line-art copy shows the same flat dark grey
  const dm = datamatrix(lx + (lw - 10 * mod) / 2, ly + lh * 0.16, mod, 10, seed);
  parts.push({ unite: dm, fill: COL.code, line: false }, { unite: dm, fill: unflat(COL.code), lineColor: COL.code, lineWidth: 0.15, soft: false });
  parts.push({ d: rect(lx + lw * 0.16, ly + lh * 0.72, lw * 0.68, lh * 0.12, 1.2), fill: "#f2a3c0", thin: true, lineWidth: 0.5 });
  const cw = 50 * k, ch = 24 * k * (h / (25 * k));
  const cx0 = x + w - 3 * k - cw;
  parts.push({ d: rect(cx0, y + (h - ch * 0.96) / 2, cw, ch * 0.96, 1.2), fill: COL.cover, thin: true, lineWidth: 0.6 });
  const sec = section(cx0 + cw / 2, y + h / 2, cw * 0.4, h * 0.36, { seed, rot: -5, holes: 18, aggs: 4, aggR: [3.5, 4.7], vessels: 3 });
  parts.push(...sec.parts);
  parts.push(...glare(cx0 + cw * 0.36, y + 1, h - 2, h / 76, 0.32));
  return parts;
}

/**
 * Whole-slide scanner (brightfield, unbranded — Aperio GT 450 / NanoZoomer / VENTANA DP 600 class):
 * benchtop box in 3/4 view, front loading bay with racks of slides (label ends facing out), touchscreen
 * showing the scanned H&E section, status light, drawer, side vents.
 */
function scannerParts() {
  const parts = [];
  const x = 14, y = 40, W = 150, H = 106, D = [36, -26];
  parts.push(dim(polyD([[x - 3, y + H + 2], [x + W + 3, y + H + 2], [x + W + D[0] + 5, y + H + D[1] + 2], [x + D[0], y + H + D[1] + 2]]), 0.12));
  parts.push(...boxFaces(x, y, W, H, D));
  parts.push({ d: [0, 1, 2, 3, 4].map((i) => polyline([[x + W + 9, y + 34 + i * 9], [x + W + 28, y + 34 + i * 9 - 13.7]])).join(""), fill: "none", stroke: { color: "#9fb0c0", width: 2.2, cap: "round" } });
  parts.push({ d: capsule(x + 8, y + 6.5, x + W - 8, y + 6.5, 1.9), fill: COL.bar, shade: "small", gloss: false });
  // loading bay: tinted door onto three slide racks (slides stacked flat, label ends facing out)
  const bx = x + 8, by = y + 14, bw = 94, bh = 60;
  parts.push({ d: rect(bx, by, bw, bh, 4), fill: COL.door, shade: "rim" });
  parts.push({ d: rect(bx + 3, by + 3, bw - 6, bh - 6, 3), fill: COL.win });
  // each slide: a pale glass bar with its label end (mostly white, a few coloured frosted ends) on the left
  const R = rng(4), labels = ["#f7f9fb", "#f7f9fb", "#f7f9fb", "#f6d48a", "#f4b6c8", "#a9d6ee"];
  const rackD = [], glassD = [], slideD = labels.map(() => []);
  for (let r = 0; r < 3; r++) {
    const rx = bx + 8 + r * 27.5, ry = by + 8;
    rackD.push(rect(rx, ry, 24, 44, 1.5));
    const filled = [9, 7, 8][r];
    for (let j = 0; j < 9; j++) {
      if (j >= filled) break;
      glassD.push(rect(rx + 2.2, ry + 2.6 + j * 4.6, 19.6, 2.6, 0.6));
      slideD[Math.floor(R() * labels.length)].push(rect(rx + 2.2, ry + 2.6 + j * 4.6, 6.2, 2.6, 0.6));
    }
  }
  parts.push({ d: rackD.join(""), fill: "#6f7f92", thin: true });
  parts.push({ d: glassD.join(""), fill: "#b9d3e6", lineWidth: 0.4 });
  const lab = new Map();
  slideD.forEach((ds, i) => lab.set(labels[i], [...(lab.get(labels[i]) || []), ...ds]));
  for (const [c, ds] of lab) if (ds.length) parts.push({ d: ds.join(""), fill: c, lineWidth: 0.4 });
  parts.push(glow(polyD([[bx + 30, by + 3], [bx + 44, by + 3], [bx + 26, by + bh - 3], [bx + 12, by + bh - 3]]), 0.13), glow(polyD([[bx + 50, by + 3], [bx + 55, by + 3], [bx + 37, by + bh - 3], [bx + 32, by + bh - 3]]), 0.1));
  // touchscreen: WSI viewer with the scanned section
  const sx = x + 109, sy = y + 14;
  parts.push({ d: rect(sx, sy, 34, 47, 3), fill: "#3f4c5c", shade: "small" });
  parts.push({ d: rect(sx + 2.6, sy + 2.6, 28.8, 41.8, 1.6), fill: COL.screen, thin: true });
  const sec = section(sx + 17, sy + 25, 10.5, 15.5, { seed: 21, rot: 15, holes: 6, aggs: 2, vessels: 0, lw: 0.5 });
  parts.push(...sec.parts.map((p) => ({ ...p, shade: p.shade === "body" ? undefined : p.shade })));
  parts.push({ d: rect(sx + 5, sy + 5.5, 7, 5, 0.6), fill: "none", stroke: { color: "#5b6675", width: 0.7 }, lineStrokeWidth: 0.6 });
  parts.push({ d: circle(sx + 17, sy + 54, 2.6), fill: COL.metal, shade: "small", thin: true });
  // slide-rack drawer
  parts.push({ d: rect(x + 8, y + 82, W - 16, 17, 3), fill: COL.drawer, shade: "rim" });
  parts.push({ d: capsule(x + 56, y + 90.5, x + 94, y + 90.5, 2), fill: COL.metal, shade: "small", gloss: false, thin: true });
  return parts;
}

/**
 * Tiling a whole-slide image: the section on the image canvas, the tissue mask (Otsu-style contour), a
 * grid of square patches kept where they lie on tissue, and three patches pulled out at full resolution
 * (tumour, a lymphoid aggregate, stroma).
 */
function tilingParts() {
  const parts = [];
  const F = { x: 8, y: 8, s: 184 };
  parts.push({ d: rect(F.x, F.y, F.s, F.s, 4), fill: COL.canvas, lineWidth: 0.9 });
  const p = 13, g0 = F.x + 3 + p / 2;
  // one large lymphoid aggregate just deep to the tumour, centred on a grid cell so that a whole patch lies inside it
  const snap = (c) => c.map((v) => g0 + p * Math.round((v - g0) / p));
  const sec = section(100, 101, 76, 62, { seed: 7, rot: -14, holes: 26, aggs: 4, aggR: [4.3, 5.3], bigAgg: 10.6, snap, vessels: 4 });
  parts.push(...sec.parts);
  const mask = offsetClosed(sec.out, 3.2);
  parts.push({ d: polyD(mask), fill: "none", stroke: { color: COL.mask, width: 1.8 }, lineStrokeWidth: 1.5 });
  const sq = [];
  for (let y = F.y + 3; y + p <= F.y + F.s - 3; y += p) for (let x = F.x + 3; x + p <= F.x + F.s - 3; x += p) if (inside(sec.out, [x + p / 2, y + p / 2]) && [[x, y], [x + p, y], [x, y + p], [x + p, y + p]].filter((c) => inside(mask, c)).length >= 3) sq.push([x, y, p]);
  parts.push({ ...frames(sq, { color: COL.grid, width: 0.6 }), opacity: 0.6 });
  // three source patches: tumour core, a lymphoid aggregate, plain stroma
  const cen = (q) => [q[0] + p / 2, q[1] + p / 2];
  const tc = centroid(sec.tumAll[0]);
  const pick = [
    { kind: "tumour", q: sq.reduce((a, q) => (dist(cen(q), tc) < dist(cen(a), tc) ? q : a)) },
    { kind: "lymph", q: ((ag) => sq.reduce((a, q) => (dist(cen(q), ag) < dist(cen(a), ag) ? q : a)))(sec.aggs[0]) },
    { kind: "stroma", q: sq.filter((q) => !sec.tumAll.some((t) => inside(offsetClosed(t, 8), cen(q))) && !inside(sec.band, cen(q)) && sec.holes.every((h) => dist(h, cen(q)) > 12) && sec.aggs.every((a) => dist(a, cen(q)) > a[2] + 10) && inside(offsetClosed(sec.out, -10), cen(q))).sort((a, b) => b[0] - a[0])[2] },
  ].sort((a, b) => a.q[1] - b.q[1]);
  const S = 56, X = 216, Y0 = 8, gap = (F.s - 3 * S) / 2;
  const tiles = pick.map((t, i) => ({ ...t, x: X, y: Y0 + i * (S + gap) }));
  parts.push({ d: tiles.map((t) => polyline([[t.q[0] + p, t.q[1] + p / 2], [t.x, t.y + S / 2]])).join(""), fill: "none", stroke: { color: COL.sel, width: 1.1, dash: [3, 2.4], cap: "butt" }, lineStrokeWidth: 1 });
  // call-out seeds per class (the lymphoid one without a venule, so it reads as a dense lymphocyte field)
  const cs = { tumour: 31, stroma: 40, lymph: 112 };
  parts.push(...hePatches(tiles.map((t) => ({ kind: t.kind, x: t.x, y: t.y, s: S, seed: cs[t.kind] })), 0.7));
  parts.push(frames(pick.map((t) => t.q), { color: COL.sel, width: 1.8 }));
  parts.push(frames(tiles.map((t) => [t.x, t.y, S]), { color: COL.sel, width: 1.8 }));
  return parts;
}

/** Attention heatmap over a section (CLAM-style patch-level scores) with a colour bar. */
function heatmapWsiParts() {
  const sec = section(98, 98, 84, 72, { seed: 12, rot: 24, holes: 26, aggs: 5, vessels: 4 });
  return [...sec.parts, ...heatSquares(sec, { p: 7, seed: 9, opacity: 0.55 }), ...colourBar(204, 38, 9, 120)];
}

/* ============================== models ============================== */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hashStr = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
/** Feature vectors (values −1..1): rows of the same tissue class share a base pattern plus noise. */
function embRows(kinds, dims, seed = 3, noise = 0.45) {
  const R = rng(seed);
  const base = (k) => { const B = rng(hashStr(k)); return Array.from({ length: dims }, () => B() * 2 - 1); };
  return kinds.map((k) => base(k).map((v) => clamp(v * 1.15 + (R() * 2 - 1) * noise, -1, 1)));
}
/** Vector cells as flat parts, one per colour level. cells: [{x, y, w, h, v}] (v −1..1, diverging). */
function cellParts(cells, { pal = DIV, lw = 0.3 } = {}) {
  const g = pal.map(() => []);
  for (const c of cells) g[clamp(Math.round(((c.v + 1) / 2) * (pal.length - 1)), 0, pal.length - 1)].push(rect(c.x, c.y, c.w, c.h, c.r ?? 0));
  return g.map((ds, i) => ds.length && { d: ds.join(""), fill: pal[i], lineWidth: lw }).filter(Boolean);
}
/** A vertical or horizontal embedding vector of values vs. */
function vecCells(x, y, vs, { cw = 10, ch = 9, gap = 0.8, vertical = true } = {}) {
  return vs.map((v, i) => (vertical ? { x, y: y + i * (ch + gap), w: cw, h: ch, v } : { x: x + i * (cw + gap), y, w: cw, h: ch, v }));
}
/** A 3-D slab / cuboid: front face (x, y, w, h), receding by depth vector D (top and right faces). */
function cuboid(x, y, w, h, D, fill, { r = 2, front = true } = {}) {
  const a = [x, y], b = [x + w, y], c = [x + w, y + h], t = (p) => [p[0] + D[0], p[1] + D[1]];
  const parts = [
    { d: roundPoly([b, t(b), t(c), c], r * 0.6), fill: shade(fill, 0.12), thin: true },
    { d: roundPoly([a, t(a), t(b), b], r * 0.6), fill: tint(fill, 0.1), thin: true },
  ];
  if (front) parts.push({ d: rect(x, y, w, h, r), fill, thin: true });
  return parts;
}

/**
 * Pathology foundation model (ViT encoder pretrained self-supervised, DINOv2-style, on millions of tiles):
 * a stack of H&E tiles; the front tile cut into a 4 × 4 grid of patches → patch tokens (+ position
 * embeddings) and a CLS token → a stack of transformer blocks (attention + MLP) → the CLS embedding.
 */
function foundationParts() {
  const parts = [];
  // tile stack (the pretraining corpus): two cards behind the front tile
  const T = { x: 12, y: 64, s: 64 };
  parts.push({ d: rect(T.x + 14, T.y - 14, T.s, T.s, 1.5), fill: "#e7b0cb", shade: "rim", gloss: false });
  parts.push({ d: rect(T.x + 7, T.y - 7, T.s, T.s, 1.5), fill: "#efc0d5", shade: "rim", gloss: false });
  parts.push(...hePatches([{ kind: "tumour", x: T.x, y: T.y, s: T.s, V: 140, seed: 41 }], 0.6));
  const g = [1, 2, 3].map((i) => T.x + (T.s * i) / 4);
  parts.push({ d: g.map((v) => polyline([[v, T.y], [v, T.y + T.s]]) + polyline([[T.x, T.y - T.x + v], [T.x + T.s, T.y - T.x + v]])).join(""), fill: "none", stroke: { color: "#f7fafc", width: 1.7, cap: "butt" }, lineColor: "#f7fafc", lineStrokeWidth: 1.7 });
  // self-supervised pretraining (DINOv2 / iBOT masked image modelling): two patches are masked out
  const q = T.s / 4, masked = [[2, 0], [1, 1]];
  parts.push({ d: masked.map(([c, r]) => rect(T.x + c * q + 0.9, T.y + r * q + 0.9, q - 1.8, q - 1.8, 1)).join(""), fill: "#dde3ea", opacity: 0.94, thin: true, lineWidth: 0.5 });
  parts.push(frames([[T.x, T.y, T.s]], { color: "#8b97a5", width: 1 }));
  // tokens: CLS on top, then patch tokens (two of them mask tokens), each with its position embedding on the left
  // slots: CLS, patches 1–6 (3 and 6 masked, as in the raster above), a vertical ellipsis, patch 16
  const tx = 106, ts = 12.5, pitch = 15.2, nS = 9, ty = 96 - ((nS - 1) * pitch + ts) / 2, maskAt = [3, 6], dots = 7;
  const pos = [], tok = [], mtok = [];
  for (let i = 0; i < nS; i++) {
    const y = ty + i * pitch;
    if (i === dots) continue;
    pos.push(rect(tx, y, 5, ts, 1.6));
    if (i > 0) (maskAt.includes(i) ? mtok : tok).push(rect(tx + 5.8, y, ts, ts, 2.2));
  }
  parts.push({ d: pos.join(""), fill: D.pos, thin: true });
  // each token its own shape, so each gets its own rim (flat body, darker right/bottom lip) like the CLS token
  parts.push({ d: tok, fill: D.token, shade: "small", thin: true });
  parts.push({ d: mtok, fill: "#d3dae2", shade: "small", thin: true });
  parts.push({ d: rect(tx + 5.8, ty, ts, ts, 2.2), fill: D.cls, shade: "small", thin: true });
  parts.push({ d: [-4.2, 0, 4.2].map((o) => circle(tx + 5.8 + ts / 2, ty + dots * pitch + ts / 2 + o, 1.5)).join(""), fill: "#6f7d8c", thin: true });
  // encoder: transformer blocks in sequence, each attention (orange) over MLP (blue)
  const ex = 144, ey = 28, eh = 136;
  parts.push({ d: rect(ex - 5, ey - 14, 118, eh + 24, 8), fill: "#ecebf7", thin: true }, ...faceShade(ex - 5, ey - 14, 118, eh + 24, 8, "#ecebf7", { bw: 2.4, hw: 2, light: 0.6 }));
  for (let k = 0; k < 4; k++) {
    const x = ex + 4 + k * 24;
    parts.push(...cuboid(x, ey, 15, eh, [8, -6.5], D.enc));
  }
  parts.push({ d: [0, 1, 2, 3].map((k) => rect(ex + 7 + k * 24, ey + 6, 9, 56, 3)).join(""), fill: D.attn, thin: true });
  parts.push({ d: [0, 1, 2, 3].map((k) => rect(ex + 7 + k * 24, ey + 70, 9, 58, 3)).join(""), fill: D.mlp, thin: true });
  // output: CLS embedding (slide-agnostic tile representation)
  const vx = 274, R = rng(17);
  parts.push({ d: rect(vx, 26, 12.5, 12.5, 2.2), fill: shade(D.cls, 0.05), shade: "small", thin: true });
  parts.push(...cellParts(vecCells(vx + 1, 44, Array.from({ length: 11 }, () => R() * 2 - 1), { cw: 10.5, ch: 9.6 })));
  parts.push(...lineArrows([[82, 96, 101, 96], [127, 96, 137.5, 96], [260, 96, 270, 96]], { width: 1.8, head: 6 }));
  return parts;
}

/** One transformer (encoder) block, pre-norm ViT style: LN → multi-head self-attention → add; LN → MLP → add. */
function transformerBlockParts() {
  const parts = [];
  const cx = 100;
  parts.push({ d: rect(44, 28, 112, 204, 10), fill: D.block, thin: true }, ...faceShade(44, 28, 112, 204, 10, D.block, { bw: 2.6, hw: 2.2, light: 0.7 }));
  // residual (skip) connections on the left
  const skip = (y0, y1) => `M${P(cx, y0)}L${P(60, y0)}Q${P(54, y0)} ${P(54, y0 - 6)}L${P(54, y1 + 6)}Q${P(54, y1)} ${P(60, y1)}L${P(cx - 9, y1)}`;
  parts.push({ d: skip(214, 126) + skip(116, 44), fill: "none", stroke: { color: "#7f8c9c", width: 1.8, cap: "round", join: "round" }, lineStrokeWidth: 1.6 });
  // flow arrows (bottom → top)
  parts.push(...lineArrows([[cx, 241, cx, 206], [cx, 196, 83, 185], [cx, 196, cx, 185], [cx, 196, 117, 185], [cx, 143, cx, 134], [cx, 119, cx, 111], [cx, 101, cx, 95], [cx, 61, cx, 52], [cx, 37, cx, 19]], { width: 1.7, head: 5.5 }));
  parts.push(...lineArrows([[56, 126, 93, 126], [56, 44, 93, 44]].map(([a, b, c, d]) => [a + 30, b, c, d]), { width: 1.7, head: 5.5 }));
  // layer norms
  parts.push({ d: rect(66, 196, 68, 9, 3) + rect(66, 101, 68, 9, 3), fill: D.norm, shade: "small", thin: true });
  // multi-head attention: three heads (cards), the front one with an attention map
  parts.push({ d: rect(72, 144, 72, 34, 5), fill: shade(D.attn, 0.14), thin: true });
  parts.push({ d: rect(67, 147.5, 72, 34, 5), fill: shade(D.attn, 0.07), thin: true });
  parts.push({ d: rect(62, 151, 72, 34, 5), fill: D.attn }, ...faceShade(62, 151, 72, 34, 5, D.attn, { bw: 2, hw: 1.8, light: 0.5 }));
  const AM = ["#fde9d6", "#f8c8a0", "#ee9a5c", "#c8692e"], R = rng(5), am = AM.map(() => []);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const v = i === j ? 2 + (R() < 0.5 ? 1 : 0) : R() < 0.22 ? 2 : R() < 0.5 ? 1 : 0;
    am[v].push(rect(84 + j * 5.6, 154.5 + i * 5.6, 5, 5, 0.6));
  }
  am.forEach((ds, i) => ds.length && parts.push({ d: ds.join(""), fill: AM[i], lineWidth: 0.3 }));
  // MLP: expand (×4) then project back
  parts.push({ d: rect(62, 62, 76, 32, 5), fill: D.mlp }, ...faceShade(62, 62, 76, 32, 5, D.mlp, { bw: 2, hw: 1.8, light: 0.5 }));
  parts.push({ d: roundPoly([[92, 89], [108, 89], [122, 78], [108, 67], [92, 67], [78, 78]], 2), fill: tint(D.mlp, 0.12), thin: true });
  // residual adds
  parts.push({ d: circle(cx, 126, 7) + circle(cx, 44, 7), fill: D.add, shade: "small", thin: true });
  parts.push({ d: [126, 44].map((y) => polyline([[cx - 3.8, y], [cx + 3.8, y]]) + polyline([[cx, y - 3.8], [cx, y + 3.8]])).join(""), fill: "none", stroke: { color: "#3e6b30", width: 1.6, cap: "round" }, lineStrokeWidth: 1.6 });
  // tokens in and out
  const row = (y) => [0, 1, 2, 3, 4].map((i) => rect(cx - 36 + i * 15, y, 12, 12, 2.2)).join("");
  parts.push({ d: row(242), fill: D.token, shade: "small", thin: true });
  parts.push({ d: row(6), fill: "#9fb2e6", shade: "small", thin: true });
  return parts;
}

/** Patch embeddings: each H&E patch → its feature vector (a row of a heat strip); same-class rows look alike. */
function embeddingsParts() {
  const kinds = ["tumour", "tumour", "lymph", "stroma", "stroma", "lymph", "fat"];
  const n = kinds.length, rh = 18, gap = 5, y0 = 8, px = 8, vx = 50, dims = 13, cw = 12.4;
  const vals = embRows(kinds, dims, 5, 0.42);
  const parts = hePatches(kinds.map((k, i) => ({ kind: k, x: px, y: y0 + i * (rh + gap), s: rh, seed: 50 + i * 7 })), 0.4);
  parts.push(frames(kinds.map((_, i) => [px, y0 + i * (rh + gap), rh]), { color: "#8b97a5", width: 0.8 }));
  parts.push(...lineArrows(kinds.map((_, i) => [px + rh + 4, y0 + i * (rh + gap) + rh / 2, vx - 4, y0 + i * (rh + gap) + rh / 2]), { width: 1.3, head: 4.6 }));
  const cells = [];
  vals.forEach((row, i) => cells.push(...vecCells(vx, y0 + i * (rh + gap), row, { cw, ch: rh, gap: 0.9, vertical: false })));
  parts.push(...cellParts(cells));
  return parts;
}

/**
 * Attention-based multiple-instance learning (ABMIL): a bag of patch embeddings → attention scores a_k
 * → attention-weighted sum → slide embedding → classifier → slide-level prediction.
 */
function abmilParts() {
  const parts = [];
  const kinds = ["stroma", "tumour", "lymph", "fat", "tumour", "stroma"];
  const att = [0.05, 0.36, 0.11, 0.02, 0.33, 0.13];
  const n = kinds.length, rh = 15, gap = 8.5, y0 = 18, px = 12, vx = 34, dims = 7, cw = 8;
  const vals = embRows(kinds, dims, 9, 0.4);
  // the bag
  parts.push({ d: rect(4, y0 - 9, 96, n * (rh + gap) - gap + 18, 7), fill: "#eef2f6", thin: true }, ...faceShade(4, y0 - 9, 96, n * (rh + gap) - gap + 18, 7, "#eef2f6", { bw: 2, hw: 1.8, light: 0.6 }));
  parts.push(...hePatches(kinds.map((k, i) => ({ kind: k, x: px, y: y0 + i * (rh + gap), s: rh, seed: 70 + i * 5 })), 0.35));
  parts.push(frames(kinds.map((_, i) => [px, y0 + i * (rh + gap), rh]), { color: "#8b97a5", width: 0.7 }));
  const cells = [];
  vals.forEach((row, i) => cells.push(...vecCells(vx, y0 + i * (rh + gap), row, { cw, ch: rh, gap: 0.8, vertical: false })));
  // attention scores: bars, coloured on the heat scale
  const ax = 116, amax = Math.max(...att);
  const bars = HEAT.map(() => []);
  att.forEach((a, i) => bars[clamp(Math.round((a / amax) * (HEAT.length - 1)), 0, HEAT.length - 1)].push(rect(ax, y0 + i * (rh + gap) + 2.5, 4 + (a / amax) * 26, rh - 5, 1.5)));
  parts.push({ d: polyline([[ax, y0 - 4], [ax, y0 + n * (rh + gap) - gap + 4]]), fill: "none", stroke: { color: "#6f7d8c", width: 1.2 }, lineStrokeWidth: 1.2 });
  parts.push(...lineArrows(kinds.map((_, i) => [vx + dims * (cw + 0.8) + 3, y0 + i * (rh + gap) + rh / 2, ax - 3, y0 + i * (rh + gap) + rh / 2]), { width: 1.2, head: 4.4 }));
  // weighted sum: connectors whose width follows the attention, converging on the pooling node
  // each connector runs straight to a common x just past the longest bar, then eases into the node on a cubic
  // with horizontal tangents at both ends, so the bundle converges without hooks or crossings
  const node = [198, y0 + (n * (rh + gap) - gap) / 2], cx0 = ax + 34, xe = node[0] - 5, run = xe - cx0;
  parts.push(...att.map((a, i) => {
    const y = y0 + i * (rh + gap) + rh / 2, x0 = ax + 4 + (a / amax) * 26 + 1.5, ye = node[1] + (y - node[1]) * 0.12;
    return { d: `M${P(x0, y)}L${P(cx0, y)}C${P(cx0 + run / 2, y)} ${P(xe - run / 2, ye)} ${P(xe, ye)}`, fill: "none", stroke: { color: "#a3afbd", width: 0.7 + (a / amax) * 3.4, cap: "round" }, lineColor: "#8e9bab", lineStrokeWidth: 0.5 + (a / amax) * 2.4 };
  }));
  parts.push(...bars.map((ds, i) => ds.length && { d: ds.join(""), fill: HEAT[i], lineWidth: 0.6 }).filter(Boolean));
  parts.push(...cellParts(cells));
  parts.push({ d: circle(node[0], node[1], 8.5), fill: D.enc, shade: "organelle", thin: true });
  // slide embedding = attention-weighted mean of the instance embeddings
  const sum = att.reduce((a, b) => a + b, 0);
  const slide = Array.from({ length: dims }, (_, j) => clamp((vals.reduce((acc, row, i) => acc + row[j] * att[i], 0) / sum) * 1.4, -1, 1));
  const sx = 220, sy = node[1] - (dims * 9.8) / 2;
  parts.push(...cellParts(vecCells(sx, sy, slide, { cw: 10, ch: 9 })));
  // classifier → class probabilities
  const bx = 256, base = node[1] + 30, probs = [0.78, 0.15, 0.07], pc = [CLU[3], CLU[0], CLU[2]];
  parts.push(...lineArrows([[node[0] + 9, node[1], sx - 3, node[1]], [sx + 13, node[1], bx - 4, node[1]]], { width: 1.6, head: 5.5 }));
  probs.forEach((p, i) => parts.push({ d: rect(bx + 2 + i * 13, base - p * 62, 10, p * 62, 1), fill: pc[i], lineWidth: 0.7 }));
  parts.push({ d: polyline([[bx, base - 66], [bx, base], [bx + 42, base]]), fill: "none", stroke: { color: "#6f7d8c", width: 1.3, cap: "round" }, lineStrokeWidth: 1.2 });
  return parts;
}

/** Fully connected neural network (multilayer perceptron): input, two hidden layers, output. */
function neuralNetParts() {
  const xs = [28, 82, 138, 192], counts = [3, 5, 5, 2], r = 10, pitch = 32, cy = 88;
  const layers = counts.map((c, k) => Array.from({ length: c }, (_, i) => [xs[k], cy + (i - (c - 1) / 2) * pitch]));
  const R = rng(12), weak = [], strong = [];
  for (let k = 0; k < 3; k++) for (const a of layers[k]) for (const b of layers[k + 1]) (R() < 0.27 ? strong : weak).push(polyline([a, b]));
  const fills = [D.token, D.enc, D.enc, D.head];
  return [
    { d: weak.join(""), fill: "none", stroke: { color: "#b9c3ce", width: 1.1, cap: "round" }, lineStrokeWidth: 0.8 },
    { d: strong.join(""), fill: "none", stroke: { color: "#6f7d8c", width: 1.7, cap: "round" }, lineStrokeWidth: 1.3 },
    ...layers.map((L, k) => L.map(([x, y]) => ({ d: circle(x, y, r), fill: fills[k], shade: "organelle", glossSize: 0.07 }))).flat(),
  ];
}

/**
 * Convolutional neural network: an H&E tile, a convolution kernel's receptive field, feature-map
 * volumes (spatial size shrinks, channels grow), a flattened vector and a fully connected classifier.
 */
function cnnParts() {
  const parts = [];
  const T = { x: 8, y: 54, s: 66 };
  parts.push(...hePatches([{ kind: "tumour", x: T.x, y: T.y, s: T.s, V: 140, seed: 61 }], 0.6));
  parts.push(frames([[T.x, T.y, T.s]], { color: "#8b97a5", width: 1 }));
  // volumes: [x, front width (channels), front height (spatial), depth (spatial), colour]
  const V = [[92, 9, 72, 46, "#8cc7e8"], [140, 16, 52, 33, "#b7a6e0"], [184, 22, 34, 18, "#f2a9c4"]];
  const cy = 98, dv = (dp) => [dp * 0.62, -dp * 0.5];
  const sideAt = (v, u, w) => { // point on the side (spatial) face: u along depth 0..1, w down 0..1
    const [x, fw, fh, dp] = v, D0 = dv(dp), y = cy - fh / 2;
    return [x + fw + D0[0] * u, y + fh * w + D0[1] * u];
  };
  // receptive-field cones (behind the volumes)
  const k = { x: T.x + 40, y: T.y + 14, s: 13 };
  const kc = [[k.x, k.y], [k.x + k.s, k.y], [k.x + k.s, k.y + k.s], [k.x, k.y + k.s]];
  const t1 = sideAt(V[0], 0.45, 0.3), t2 = sideAt(V[1], 0.5, 0.42);
  const src2 = [sideAt(V[0], 0.62, 0.55), sideAt(V[0], 0.82, 0.55), sideAt(V[0], 0.82, 0.72), sideAt(V[0], 0.62, 0.72)];
  for (const v of V) parts.push(...cuboid(v[0], cy - v[2] / 2, v[1], v[2], dv(v[3]), v[4]));
  parts.push({ d: polyD(kc) + polyD(src2), fill: "none", stroke: { color: COL.sel, width: 1.5 }, lineStrokeWidth: 1.3 });
  parts.push({ d: [kc[1], kc[2]].map((c) => polyline([c, t1])).join("") + [src2[1], src2[2]].map((c) => polyline([c, t2])).join(""), fill: "none", stroke: { color: COL.sel, width: 1, dash: [2.5, 2], cap: "butt" }, lineStrokeWidth: 0.9 });
  parts.push({ d: circle(...t1, 1.8) + circle(...t2, 1.8), fill: COL.sel, lineWidth: 0.4 });
  // flatten → fully connected → class scores
  const fx = 238, R = rng(8), fv = Array.from({ length: 8 }, () => R() * 2 - 1);
  const fy0 = cy - (8 * 8.6) / 2;
  const outs = [[280, cy - 22, D.cTum], [280, cy, D.cStr], [280, cy + 22, D.cLym]];
  parts.push({ d: fv.map((_, i) => outs.map(([ox, oy]) => polyline([[fx + 8, fy0 + i * 8.6 + 3.8], [ox, oy]])).join("")).join(""), fill: "none", stroke: { color: "#b9c3ce", width: 0.8 }, lineStrokeWidth: 0.6 });
  parts.push(...cellParts(vecCells(fx, fy0, fv, { cw: 8, ch: 7.6, gap: 1 })));
  outs.forEach(([x, y, c]) => parts.push({ d: circle(x, y, 7), fill: c, shade: "organelle", glossSize: 0.08 }));
  parts.push(...lineArrows([[220, cy, 234, cy]], { width: 1.5, head: 5 }));
  return parts;
}

/**
 * GPU compute: a server rack (1U/2U nodes with drive bays, grilles and status lights) and a
 * datacentre / workstation GPU card (blower fan, heatsink fins, PCIe edge connector, bracket).
 */
function gpuServerParts() {
  const parts = [];
  const x = 14, y = 34, W = 104, H = 150, Dp = [30, -20];
  parts.push(dim(polyD([[x - 2, y + H + 2], [x + W + 2, y + H + 2], [x + W + Dp[0] + 4, y + H + Dp[1] + 2], [x + Dp[0], y + H + Dp[1] + 2]]), 0.12));
  parts.push(...boxFaces(x, y, W, H, Dp, { body: COL.rack, top: "#6b7786", side: "#3b4552", r: 3 }));
  const hs = [19, 19, 34, 19, 19], R = rng(31);
  let uy = y + 8;
  const face = [], bays = [], grille = [], ledG = [], ledB = [];
  hs.forEach((h, i) => {
    const ux = x + 7, uw = W - 14;
    face.push(rect(ux, uy, uw, h, 2));
    const nb = h > 25 ? 2 : 4;
    for (let b = 0; b < nb; b++) bays.push(rect(ux + 4 + b * 7, uy + 3, 5, h - 6, 1));
    const gx0 = ux + 4 + nb * 7 + 4, gx1 = ux + uw - 12;
    if (h > 25) { // GPU node: honeycomb-like intake grille
      for (let gy = uy + 5; gy < uy + h - 4; gy += 4.2) for (let gx = gx0 + ((gy - uy) % 8.4 > 4 ? 2.1 : 0); gx < gx1; gx += 4.2) grille.push(circle(gx, gy, 1.25));
    } else for (let gx = gx0; gx < gx1; gx += 3.6) grille.push(capsule(gx, uy + 5, gx, uy + h - 5, 0.75));
    ledG.push(circle(ux + uw - 6, uy + 5 + R() * 3, 1.5));
    if (R() < 0.7) ledB.push(circle(ux + uw - 6, uy + h - 5, 1.5));
    uy += h + 5;
  });
  parts.push({ d: face.join(""), fill: "#d5dee7", thin: true });
  parts.push({ d: bays.join(""), fill: "#9fb0c0", thin: true, lineWidth: 0.5 });
  parts.push({ d: grille.join(""), fill: "#7d8a98", lineWidth: 0.3 });
  parts.push({ d: ledG.join(""), fill: "#5fd07a", lineWidth: 0.4 }, { d: ledB.join(""), fill: "#59c3e6", lineWidth: 0.4 });
  // PCIe blower GPU card in front (fan side up): I/O bracket on the left with exhaust vents, heatsink fins next
  // to the bracket and the blower fan at the far end (it pushes air through the fins and out of the bracket);
  // PCB tongue with gold edge-connector pads below, starting ~15% along, ~33% long, key notch ~13% into it
  const gx = 96, gy = 118, CL = 110;
  parts.push({ d: rect(gx - 7, gy - 4, 7, 60, 1), fill: "#b8c4cf", thin: true });
  parts.push({ d: [0, 1, 2, 3, 4].map((i) => capsule(gx - 3.5, gy + 6 + i * 6.5, gx - 3.5, gy + 9.5 + i * 6.5, 1)).join(""), fill: "#6f7f92", lineWidth: 0.35 });
  const c0 = gx + CL * 0.15, cl = CL * 0.33, notch = c0 + cl * 0.13;
  parts.push({ unite: [rect(gx + 2, gy + 45, CL - 6, 8, 1.5), rect(c0, gy + 50, notch - 0.9 - c0, 6.2, 0.8), rect(notch + 0.9, gy + 50, c0 + cl - notch - 0.9, 6.2, 0.8)], fill: "#4f9a6a", thin: true });
  const pads = [];
  for (let px = c0 + 0.9; px + 1.6 <= c0 + cl - 0.6; px += 2.55) if (Math.abs(px + 0.8 - notch) > 1.6) pads.push(rect(px, gy + 53.3, 1.6, 2.5, 0.4));
  parts.push({ d: pads.join(""), fill: "#e0b04a", lineWidth: 0.3 });
  parts.push({ d: rect(gx, gy, CL, 47, 5), fill: "#46525f" }, ...faceShade(gx, gy, CL, 47, 5, "#46525f", { bw: 2.2, hw: 1.8, dark: 0.08, light: 0.3 }));
  parts.push({ d: rect(gx + 6, gy + 7, 62, 33, 3), fill: "#2f3a46", thin: true });
  parts.push({ d: Array.from({ length: 11 }, (_, i) => rect(gx + 10 + i * 5.3, gy + 10, 2.2, 27, 1)).join(""), fill: "#a9b6c3", thin: true, lineWidth: 0.4 });
  const fan = [gx + CL - 21, gy + 23.5];
  parts.push({ d: circle(fan[0], fan[1], 16.5), fill: "#2f3a46", thin: true });
  const blades = [];
  for (let i = 0; i < 9; i++) {
    const a = i * 40 + 8;
    blades.push(ellipse(fan[0] + Math.cos(a * DEG) * 9.5, fan[1] + Math.sin(a * DEG) * 9.5, 7, 2.6, a + 62));
  }
  parts.push({ d: blades.join(""), fill: "#6f7f92", lineWidth: 0.4 });
  parts.push({ d: circle(fan[0], fan[1], 5), fill: COL.metal, shade: "small", thin: true });
  return parts;
}

/**
 * DINOv2-style self-distillation, the pretraining behind most pathology foundation models (UNI, Virchow,
 * Prov-GigaPath, H-optimus): an H&E tile → augmented crops. The student ViT sees a global crop with masked
 * patches (iBOT) and small local crops (one colour-jittered to grey); the teacher ViT sees two global crops.
 * Teacher weights are an exponential moving average (EMA) of the student's (dashed teal arrow); the student
 * is trained to match the teacher's centred, sharpened prototype scores (cross-entropy at the pink node),
 * with a stop-gradient (two slashes) on the teacher side.
 * Layout (≈ 330 × 216): tile left; student row on top, teacher row below; ViT boxes; score histograms; loss.
 */
function dinoParts() {
  const parts = [];
  const S = { x: 6, y: 82, s: 58 };
  parts.push(...hePatches([{ kind: "tumour", x: S.x, y: S.y, s: S.s, V: 170, seed: 47, orient: false }], 0.6));
  parts.push(frames([[S.x, S.y, S.s]], { color: "#8b97a5", width: 1 }));
  // crops: student (top) = one global crop with two masked patches + two local crops; teacher (bottom) = two global crops
  const G = 36, Lc = 17, yS = 18, yT = 168;
  // every crop is a window of the same tile: [u, v, size] in the tile's 170-unit field, shown at (x, y, s)
  const crop = ([u, v, w], x, y, s) => ({ kind: "tumour", seed: 47, V: 170, orient: false, x: x - (u * s) / w, y: y - (v * s) / w, s: (170 * s) / w, clip: { x, y, w: s, h: s }, cs: s });
  const g1 = [16, 22, 104], g2 = [58, 56, 104];
  const crops = [crop(g1, 84, yS, G), crop([104, 8, 52], 126, yS, Lc), crop([18, 112, 50], 126, yS + G - Lc, Lc), crop(g1, 84, yT, G), crop(g2, 124, yT, G)];
  parts.push(...hePatches(crops, 0.45));
  const q = G / 3;
  parts.push({ d: [1, 2].map((i) => polyline([[84 + i * q, yS], [84 + i * q, yS + G]]) + polyline([[84, yS + i * q], [84 + G, yS + i * q]])).join(""), fill: "none", stroke: { color: "#f7fafc", width: 1.2, cap: "butt" }, lineColor: "#f7fafc", lineStrokeWidth: 1.2 });
  parts.push({ d: [[1, 0], [0, 2]].map(([c, r]) => rect(84 + c * q + 0.8, yS + r * q + 0.8, q - 1.6, q - 1.6, 0.8)).join(""), fill: "#dde3ea", opacity: 0.94, thin: true, lineWidth: 0.5 });
  parts.push({ d: rect(126, yS + G - Lc, Lc, Lc), fill: "#c9ced6", opacity: 0.55, lineWidth: 0.01 });
  parts.push(frames(crops.map((c) => [c.clip.x, c.clip.y, c.cs]), { color: "#8b97a5", width: 0.8 }));
  // the two ViTs: same architecture (three blocks shown); teacher blocks in blue
  const vit = (x, y, fill) => {
    const out = [{ d: rect(x, y, 70, 62, 7), fill: "#ecebf7", thin: true }, ...faceShade(x, y, 70, 62, 7, "#ecebf7", { bw: 2, hw: 1.8, light: 0.6 })];
    for (let k = 0; k < 3; k++) out.push(...cuboid(x + 8 + k * 18, y + 12, 11, 42, [6, -5], fill));
    out.push({ d: [0, 1, 2].map((k) => rect(x + 10.5 + k * 18, y + 16, 6, 16, 2.2)).join(""), fill: D.attn, thin: true });
    out.push({ d: [0, 1, 2].map((k) => rect(x + 10.5 + k * 18, y + 35, 6, 16, 2.2)).join(""), fill: D.mlp, thin: true });
    return out;
  };
  const vx = 178, vS = yS + G / 2 - 31, vT = yT + G / 2 - 31;
  parts.push(...vit(vx, vS, D.enc), ...vit(vx, vT, "#9db8e2"));
  // EMA update: student → teacher
  parts.push(...lineArrows([[vx + 35, vS + 66, vx + 35, vT - 5]], { color: "#3f9f97", width: 2.4, head: 7, dash: [5, 3] }));
  // prototype-score histograms: student (soft), teacher (centred and sharpened → one dominant prototype)
  const hist = (x, yb, vals, fill) => ({ d: vals.map((v, i) => rect(x + i * 6.6, yb - v * 28, 5, v * 28, 0.8)).join(""), fill, lineWidth: 0.6 });
  const hx = 266, hS = yS + G / 2 + 14, hT = yT + G / 2 + 14;
  parts.push(hist(hx, hS, [0.32, 0.55, 0.86, 0.46, 0.24, 0.38], "#9a83cf"), hist(hx, hT, [0.1, 0.16, 1, 0.18, 0.07, 0.09], "#5f8fd0"));
  parts.push({ d: polyline([[hx - 2, hS], [hx + 40, hS]]) + polyline([[hx - 2, hT], [hx + 40, hT]]), fill: "none", stroke: { color: "#6f7d8c", width: 1.3, cap: "round" }, lineStrokeWidth: 1.2 });
  // loss: student scores vs teacher scores (cross-entropy); stop-gradient on the teacher branch
  const L = [336, 111];
  parts.push(...lineArrows([[hx + 44, hS - 12, L[0] - 6, L[1] - 11, [L[0] - 4, hS - 12]], [hx + 44, hT - 12, L[0] - 6, L[1] + 11, [L[0] - 4, hT - 12]]], { width: 1.8, head: 6 }));
  const qb = (t, a, c, b) => (1 - t) ** 2 * a + 2 * t * (1 - t) * c + t * t * b;
  const sg = [qb(0.55, hx + 44, L[0] - 4, L[0] - 6), qb(0.55, hT - 12, hT - 12, L[1] + 11)];
  parts.push({ d: [-2.2, 2.2].map((o) => polyline([[sg[0] - 5, sg[1] + o + 2.4], [sg[0] + 5, sg[1] + o - 2.4]])).join(""), fill: "none", stroke: { color: "#3e4955", width: 1.5, cap: "round" }, lineStrokeWidth: 1.4 });
  parts.push({ d: circle(L[0], L[1], 9), fill: D.head, shade: "organelle", glossSize: 0.07 });
  // views → models → scores
  parts.push(...lineArrows([[S.x + S.s + 3, S.y + 14, 80, yS + G / 2, [70, yS + G / 2]], [S.x + S.s + 3, S.y + S.s - 14, 80, yT + G / 2, [70, yT + G / 2]], [146, yS + G / 2, vx - 4, yS + G / 2], [163, yT + G / 2, vx - 4, yT + G / 2], [vx + 74, yS + G / 2, hx - 6, yS + G / 2], [vx + 74, yT + G / 2, hx - 6, yT + G / 2]], { width: 1.6, head: 5.5 }));
  return parts;
}

/* ============================== charts (flat data marks) ============================== */

/** L-shaped axes with ticks (no labels). */
function axes(x0, y0, x1, y1, { xt = [], yt = [], color = "#6f7d8c", w = 1.6 } = {}) {
  let d = polyline([[x0, y1], [x0, y0], [x1, y0]]);
  for (const x of xt) d += polyline([[x, y0], [x, y0 + 4.5]]);
  for (const y of yt) d += polyline([[x0, y], [x0 - 4.5, y]]);
  return { d, fill: "none", stroke: { color, width: w, cap: "round" }, lineStrokeWidth: w };
}
const gridLines = (ds) => ({ d: ds.map(polyline).join(""), fill: "none", stroke: { color: "#e1e6ec", width: 0.9 }, lineColor: "#d3dae2", lineStrokeWidth: 0.7 });
const curve = (pts, color, width = 2.2, extra = {}) => ({ d: smoothOpen(pts, 0.6), fill: "none", stroke: { color, width, cap: "round" }, lineColor: shade(color, 0.12), lineStrokeWidth: width * 0.9, ...extra });

/** Training and validation loss against epochs: validation bottoms out, then rises (overfitting); early stop marked. */
function lossCurveParts() {
  const x0 = 24, y0 = 152, x1 = 208, y1 = 12;
  const X = (t) => x0 + 6 + t * (x1 - x0 - 12), Y = (L) => y0 - 6 - (L / 1.2) * (y0 - y1 - 10);
  const R = rng(23);
  const train = [], val = [];
  for (let t = 0; t <= 1.0001; t += 0.0125) train.push([X(t), Y(0.08 + 1.02 * Math.exp(-t / 0.16) + (R() - 0.5) * 0.06 * (1 - 0.6 * t))]);
  for (let t = 0; t <= 1.0001; t += 0.05) val.push([X(t), Y(0.25 + 0.84 * Math.exp(-t / 0.19) + 0.5 * Math.pow(Math.max(0, t - 0.4), 1.6) + (R() - 0.5) * 0.035)]);
  const best = val.reduce((a, p) => (p[1] > a[1] ? p : a));
  return [
    gridLines([0.3, 0.6, 0.9].map((L) => [[x0 + 2, Y(L)], [x1, Y(L)]])),
    axes(x0, y0, x1, y1, { xt: [0.25, 0.5, 0.75, 1].map(X), yt: [0.3, 0.6, 0.9].map(Y) }),
    { d: polyline([[best[0], y0 - 1], [best[0], best[1] + 5]]), fill: "none", stroke: { color: "#8b97a5", width: 1.3, dash: [3.5, 2.5], cap: "butt" }, lineStrokeWidth: 1.2 },
    { d: polyline(train), fill: "none", stroke: { color: CLU[0], width: 2.1, cap: "round", join: "round" }, lineColor: shade(CLU[0], 0.12), lineStrokeWidth: 1.9 },
    curve(val, CLU[1], 2.3),
    { d: val.map(([x, y]) => circle(x, y, 2.3)).join(""), fill: CLU[1], lineWidth: 0.5 },
    { d: circle(best[0], best[1], 5.2), fill: "none", stroke: { color: "#3e4955", width: 1.5 }, lineStrokeWidth: 1.4 },
  ];
}

/** Tissue classes (Kather / NCT-CRC-HE-100K style) — colour, H&E kind. */
const CLASSES = [
  ["TUM", D.cTum, "tumour"], ["STR", D.cStr, "stroma"], ["LYM", D.cLym, "lymph"], ["NORM", D.cNorm, "normal"],
  ["ADI", D.cAdi, "fat"], ["MUS", D.cMus, "muscle"], ["MUC", D.cMuc, "mucus"], ["DEB", D.cDeb, "debris"],
];
/**
 * UMAP of patch embeddings coloured by tissue class, with a legend of class colours and example patches.
 * Clusters have UMAP-like shapes, not round blobs: tumour a large comma with two sub-lobes; normal mucosa a
 * crescent curving towards it with a bridge of ambiguous patches; stroma and muscle one curved band whose
 * colour switches part-way (mixed points at the junction); lymphocytes compact and dense; a few outliers.
 * Points overlap in dense cores (minimum spacing ~1.1, point radius 2).
 */
function umapTissueParts() {
  const parts = [];
  const x0 = 20, y0 = 186, x1 = 196, y1 = 12;
  parts.push(axes(x0, y0, x1, y1, { xt: [70, 120, 170], yt: [136, 86, 36] }));
  const R = rng(64);
  const gauss = () => { const u = Math.max(1e-6, R()), v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const groups = Object.fromEntries(CLASSES.map(([k]) => [k, []]));
  const placed = spatial(6);
  const put = (k, p) => {
    if (!(p[0] > x0 + 6 && p[0] < x1 - 3 && p[1] > y1 + 4 && p[1] < y0 - 6)) return false;
    if (placed.near(p, 1).some((q) => dist(p, q) < 1.1)) return false;
    groups[k].push(p);
    placed.add(p, p);
    return true;
  };
  /** n points along a curved centreline, spread sd(u) across it; label(u) picks the class. */
  const along = (ctrl, n, sd, label, dens = () => 1) => {
    const ln = resample(catmull(ctrl, 12), 1);
    for (let t = 0, m = 0; m < n && t < n * 50; t++) {
      const u = R();
      if (R() > dens(u)) continue;
      const i = Math.min(ln.length - 2, Math.floor(u * (ln.length - 1))), a = ln[i], b = ln[i + 1], l = dist(a, b) || 1, g = gauss() * sd(u);
      if (put(label(u), [a[0] - ((b[1] - a[1]) / l) * g + gauss() * 0.7, a[1] + ((b[0] - a[0]) / l) * g + gauss() * 0.7])) m++;
    }
  };
  const blobAt = (k, c, n, sx, sy, rot = 0) => {
    for (let t = 0, m = 0; m < n && t < n * 50; t++) if (put(k, rotate([c[0] + gauss() * sx, c[1] + gauss() * sy], c[0], c[1], rot))) m++;
  };
  // tumour: comma — a two-lobed head and a tail curving down
  blobAt("TUM", [60, 46], 70, 7.5, 5.8, 25);
  blobAt("TUM", [80, 58], 62, 6.6, 5.4, -15);
  along([[84, 62], [92, 76], [90, 92], [80, 104], [70, 108]], 52, (u) => 5.2 * (1 - 0.65 * u), () => "TUM", (u) => 1 - 0.55 * u);
  // normal mucosa: a crescent arcing round the tumour head, joined to it by a thin bridge
  along([[100, 24], [118, 26], [132, 38], [138, 56], [132, 74]], 92, (u) => 2.6 + 2.6 * Math.sin(Math.PI * u), () => "NORM");
  along([[88, 52], [96, 44], [104, 36], [110, 30]], 14, () => 1.4, (u) => (R() < u ? "NORM" : "TUM"));
  // lymphocytes: compact and dense
  blobAt("LYM", [106, 132], 112, 4.8, 4.2, 20);
  // stroma → smooth muscle: one curved band, colour switching part-way with a mixed junction
  along([[148, 82], [158, 100], [162, 120], [168, 142], [180, 162]], 165, (u) => 4.4 - 1.2 * u, (u) => (R() < 1 / (1 + Math.exp(-(u - 0.64) / 0.035)) ? "MUS" : "STR"));
  // debris (near tumour), mucus, adipose
  blobAt("DEB", [40, 118], 32, 4.6, 3.6, 10);
  along([[48, 150], [62, 160], [78, 164]], 46, (u) => 3.6 + 1.4 * Math.sin(Math.PI * u), () => "MUC");
  blobAt("ADI", [176, 46], 40, 4.4, 3.8, -20);
  // outliers
  for (const [k, p] of [["STR", [130, 156]], ["TUM", [46, 86]], ["LYM", [86, 150]], ["MUS", [146, 170]], ["DEB", [72, 128]], ["NORM", [152, 30]], ["ADI", [158, 66]]]) put(k, p);
  for (const [k, c] of CLASSES) parts.push({ d: groups[k].map(([x, y]) => circle(x, y, 2.05)).join(""), fill: c, lineWidth: 0.4 });
  // legend: class colour + example patch
  const lx = 214, ly = 12, pitch = 22, ps = 17;
  CLASSES.forEach(([, c], i) => parts.push({ d: circle(lx, ly + i * pitch + ps / 2, 3.6), fill: c, lineWidth: 0.5 }));
  parts.push(...hePatches(CLASSES.map(([, , kind], i) => ({ kind, x: lx + 8, y: ly + i * pitch, s: ps, seed: 90 + i * 3 })), 0.35));
  parts.push(frames(CLASSES.map((_, i) => [lx + 8, ly + i * pitch, ps]), { color: "#8b97a5", width: 0.7 }));
  return parts;
}

/** Confusion matrix (row-normalised) of a patch classifier: strong diagonal, stroma ↔ muscle and tumour ↔ normal confusion. */
function confusionParts() {
  const parts = [];
  const M = [
    [0.91, 0.02, 0.01, 0.05, 0, 0.01],
    [0.03, 0.8, 0.02, 0.01, 0.01, 0.13],
    [0.02, 0.01, 0.95, 0.01, 0, 0.01],
    [0.08, 0.01, 0.01, 0.89, 0, 0.01],
    [0, 0.02, 0, 0, 0.97, 0.01],
    [0.01, 0.15, 0, 0.01, 0, 0.83],
  ];
  const cls = [CLASSES[0], CLASSES[1], CLASSES[2], CLASSES[3], CLASSES[4], CLASSES[5]];
  const x0 = 30, y0 = 10, c = 24, g = 1.4;
  const lv = (v) => (v < 0.025 ? 0 : v < 0.07 ? 1 : v < 0.12 ? 2 : v < 0.5 ? 3 : v < 0.9 ? 4 : 5);
  const groups = BLUES.map(() => []);
  M.forEach((row, i) => row.forEach((v, j) => groups[lv(v)].push(rect(x0 + j * c + g / 2, y0 + i * c + g / 2, c - g, c - g, 1.4))));
  groups.forEach((ds, i) => ds.length && parts.push({ d: ds.join(""), fill: BLUES[i], lineWidth: 0.5 }));
  // class keys: true class (rows, left), predicted class (columns, below)
  cls.forEach(([, col], i) => parts.push({ d: circle(x0 - 9, y0 + i * c + c / 2, 4) + circle(x0 + i * c + c / 2, y0 + 6 * c + 9, 4), fill: col, lineWidth: 0.5 }));
  parts.push(...colourBar(x0 + 6 * c + 10, y0, 8, 6 * c, BLUES));
  return parts;
}

/** ROC curves: a strong and a weaker classifier (empirical staircases), chance diagonal, AUC shaded, operating point. */
function rocParts() {
  const x0 = 26, y0 = 178, x1 = 190, y1 = 14, Wd = x1 - x0 - 4;
  const X = (u) => x0 + u * Wd, Y = (v) => y0 - v * (y0 - y1 - 4);
  const stairs = (a, seed, n = 26) => {
    const R = rng(seed);
    const us = Array.from({ length: n }, () => Math.pow(R(), 1.7)).sort((p, q) => p - q);
    const pts = [[0, 0]];
    let v = 0;
    for (const u of us) {
      const nv = clamp(1 - Math.pow(1 - u, a) + (R() - 0.5) * 0.04, v, 1);
      pts.push([pts.at(-1)[0], nv], [u, nv]);
      v = nv;
    }
    pts.push([pts.at(-1)[0], 1], [1, 1]);
    return pts;
  };
  const A = stairs(9, 3), B = stairs(3.2, 8, 22);
  const op = A.reduce((best, p) => (p[1] - p[0] > best[1] - best[0] ? p : best));
  const auc = polyD([...A.map(([u, v]) => [X(u), Y(v)]), [X(1), Y(0)]]);
  return [
    // AUC shading: line art gets the same pale fill (flat, no outline), painted behind gridlines and curves
    { d: auc, fill: unflat("#f8e1e5"), lineColor: "#f8e1e5", lineWidth: 0.01, soft: false },
    gridLines([0.5, 1].flatMap((v) => [[[x0 + 2, Y(v)], [X(1), Y(v)]], [[X(v), y0 - 2], [X(v), Y(1)]]])),
    { d: auc, fill: CLU[3], opacity: 0.1, lineWidth: 0.01, line: false },
    { d: polyline([[X(0), Y(0)], [X(1), Y(1)]]), fill: "none", stroke: { color: "#9aa6b3", width: 1.4, dash: [4, 3], cap: "butt" }, lineStrokeWidth: 1.2 },
    axes(x0, y0, x1, y1, { xt: [0.25, 0.5, 0.75, 1].map(X), yt: [0.25, 0.5, 0.75, 1].map(Y) }),
    { d: polyline(B.map(([u, v]) => [X(u), Y(v)])), fill: "none", stroke: { color: CLU[0], width: 2.1, join: "round", cap: "round" }, lineColor: shade(CLU[0], 0.12), lineStrokeWidth: 1.9 },
    { d: polyline(A.map(([u, v]) => [X(u), Y(v)])), fill: "none", stroke: { color: CLU[3], width: 2.3, join: "round", cap: "round" }, lineColor: shade(CLU[3], 0.12), lineStrokeWidth: 2 },
    { d: circle(X(op[0]), Y(op[1]), 3.8), fill: CLU[3], lineWidth: 0.8 },
  ];
}

/* ============================== overview strips ============================== */

const pipeSection = (o = {}) => section(62, 60, 52, 42, { seed: 7, rot: -14, holes: 16, aggs: 4, vessels: 3, ...o });

/** Affine map of the 124 × 120 image canvas onto a receding plane: front-left corner (x0, y0), width w, depth h. */
const planeMap = (x0, y0, w, h, dv) => ([px, py]) => { const v = (120 - py) / 120; return [x0 + (px / 124) * w + v * h * dv[0], y0 + v * h * dv[1]]; };

/**
 * WSI resolution pyramid: three image planes (full, ½ and ¼ resolution) stacked upward, each smaller and
 * centred over the one below, joined by dashed frustum edges; the H&E section on every level.
 */
function wsiPyramid() {
  const parts = [], dv = [0.34, -0.58], cx = 50, gap = 12, thick = 2.6;
  const levels = [[70, 50], [52, 37], [36, 26]];
  const geo = [];
  let yF = 120;
  for (const [w, h] of levels) {
    const sw = w + h * dv[0];
    geo.push({ x0: cx - sw / 2, y0: yF, w, h });
    yF -= -h * dv[1] + gap + thick;
  }
  const corners = (g) => [[g.x0, g.y0], [g.x0 + g.w, g.y0], [g.x0 + g.w + g.h * dv[0], g.y0 + g.h * dv[1]], [g.x0 + g.h * dv[0], g.y0 + g.h * dv[1]]];
  const edges = [];
  for (let k = 0; k < geo.length - 1; k++) { const a = corners(geo[k]), b = corners(geo[k + 1]); for (let j = 0; j < 4; j++) edges.push(polyline([a[j], b[j]])); }
  parts.push({ d: edges.join(""), fill: "none", stroke: { color: "#9aa6b3", width: 0.9, dash: [2.4, 2], cap: "butt" }, lineStrokeWidth: 0.8 });
  // bottom level first; each is a thin slab: front and right side faces, then the image plane with the section
  geo.forEach((g, k) => {
    const [FL, FR, BR, BL] = corners(g);
    parts.push({ d: polyD([FL, FR, [FR[0], FR[1] + thick], [FL[0], FL[1] + thick]]), fill: COL.side, thin: true });
    parts.push({ d: polyD([FR, BR, [BR[0], BR[1] + thick], [FR[0], FR[1] + thick]]), fill: shade(COL.side, 0.08), thin: true });
    parts.push({ d: polyD([FL, FR, BR, BL]), fill: COL.canvas, thin: true });
    const map = planeMap(g.x0, g.y0, g.w, g.h, dv);
    const sec = pipeSection({ lw: 0.5, holes: [16, 10, 6][k], aggs: [4, 3, 2][k], vessels: [3, 1, 0][k] });
    parts.push(...sec.parts.map((p) => ({ ...p, shade: undefined, d: mapPath(p.d, map) })));
  });
  return parts;
}
/** Tiling: tissue mask and patch grid, three patches selected. */
function tilingMini() {
  const sec = pipeSection();
  const mask = offsetClosed(sec.out, 3);
  const p = 11, sq = [];
  for (let y = 3; y + p <= 117; y += p) for (let x = 3; x + p <= 121; x += p) if (inside(sec.out, [x + p / 2, y + p / 2]) && [[x, y], [x + p, y], [x, y + p], [x + p, y + p]].filter((c) => inside(mask, c)).length >= 3) sq.push([x, y, p]);
  const pick = [sq[Math.floor(sq.length * 0.3)], sq[Math.floor(sq.length * 0.55)], sq[Math.floor(sq.length * 0.82)]];
  return [
    { d: rect(0, 0, 124, 120, 5), fill: COL.canvas, lineWidth: 1 },
    ...sec.parts,
    { d: polyD(mask), fill: "none", stroke: { color: COL.mask, width: 2 }, lineStrokeWidth: 1.6 },
    { ...frames(sq, { color: COL.grid, width: 0.7 }), opacity: 0.6 },
    frames(pick, { color: COL.sel, width: 2.2 }),
  ];
}
/** Foundation-model encoder (drawn at strip size, 76 × 112): CLS + 4 patch tokens, three transformer blocks. */
function encoderMini() {
  const parts = [], ts = 10, tp = 15, ty0 = 56 - (4 * tp + ts) / 2;
  parts.push({ d: [1, 2, 3, 4].map((i) => rect(0, ty0 + i * tp, ts, ts, 2)), fill: D.token, shade: "small", thin: true });
  parts.push({ d: rect(0, ty0, ts, ts, 2), fill: D.cls, shade: "small", thin: true });
  const bx = 16, bw = 60, bh = 112;
  parts.push({ d: rect(bx, 0, bw, bh, 7), fill: "#ecebf7", thin: true }, ...faceShade(bx, 0, bw, bh, 7, "#ecebf7", { bw: 2.2, hw: 2, light: 0.6 }));
  for (let k = 0; k < 3; k++) parts.push(...cuboid(bx + 5 + k * 17, 13, 11, 92, [6, -5], D.enc));
  parts.push({ d: [0, 1, 2].map((k) => rect(bx + 7.5 + k * 17, 18, 6, 38, 2.4)).join(""), fill: D.attn, thin: true });
  parts.push({ d: [0, 1, 2].map((k) => rect(bx + 7.5 + k * 17, 61, 6, 39, 2.4)).join(""), fill: D.mlp, thin: true });
  return parts;
}
/** Embeddings: one feature vector per patch (7 rows, matching the 7 attention scores of the next step). */
function embMini() {
  const vals = embRows(["tumour", "stroma", "tumour", "lymph", "fat", "tumour", "stroma"], 7, 13, 0.4);
  const cells = [];
  vals.forEach((row, i) => cells.push(...vecCells(0, i * 14, row, { cw: 9, ch: 11, gap: 0.8, vertical: false })));
  return cellParts(cells, { lw: 0.5 });
}
/** Attention-MIL: 7 attention scores → connectors easing into the pooling node → slide embedding. */
function milMini() {
  const parts = [];
  const att = [0.05, 0.34, 0.1, 0.03, 0.3, 0.12, 0.06], amax = 0.34, pitch = 14, n = att.length, bh = 10;
  const node = [66, ((n - 1) * pitch + bh) / 2], cx0 = 26, xe = node[0] - 3, run = xe - cx0;
  parts.push(...att.map((a, i) => {
    const y = i * pitch + bh / 2, x0 = 2 + (a / amax) * 20 + 1, ye = node[1] + (y - node[1]) * 0.12;
    return { d: `M${P(x0, y)}L${P(cx0, y)}C${P(cx0 + run / 2, y)} ${P(xe - run / 2, ye)} ${P(xe, ye)}`, fill: "none", stroke: { color: "#a3afbd", width: 0.9 + (a / amax) * 3.2, cap: "round" }, lineColor: "#8e9bab", lineStrokeWidth: 0.7 + (a / amax) * 2.2 };
  }));
  const bars = HEAT.map(() => []);
  att.forEach((a, i) => bars[clamp(Math.round((a / amax) * (HEAT.length - 1)), 0, HEAT.length - 1)].push(rect(0, i * pitch, 2 + (a / amax) * 20, bh, 1.5)));
  parts.push(...bars.map((ds, i) => ds.length && { d: ds.join(""), fill: HEAT[i], lineWidth: 0.7 }).filter(Boolean));
  parts.push({ d: circle(node[0], node[1], 7), fill: D.enc, shade: "organelle", thin: true });
  const R = rng(4);
  parts.push(...lineArrows([[node[0] + 8, node[1], 81.5, node[1]]], { width: 1.5, head: 4.8 }));
  parts.push(...cellParts(vecCells(84, node[1] - (7 * 9.4 - 0.8) / 2, Array.from({ length: 7 }, () => R() * 2 - 1), { cw: 8, ch: 8.6, gap: 0.8 }), { lw: 0.5 }));
  return parts;
}
/** Output: attention heatmap over the section. */
function heatMini() {
  const sec = pipeSection();
  return [...sec.parts, ...heatSquares(sec, { p: 6, seed: 9, opacity: 0.55, lw: 0.3 })];
}
/** Output: slide-level class probabilities. */
function predMini() {
  const base = 40, H = 40, probs = [0.8, 0.14, 0.06], pc = [CLU[3], CLU[0], CLU[2]];
  return [
    ...probs.map((p, i) => ({ d: rect(6 + i * 15, base - p * H, 11, p * H, 1.2), fill: pc[i], lineWidth: 0.9 })),
    { d: polyline([[1, -2], [1, base], [52, base]]), fill: "none", stroke: { color: "#6f7d8c", width: 1.5, cap: "round" }, lineStrokeWidth: 1.3 },
  ];
}
/** Fit parts into a box (contain, centred). */
function fitInto(parts, { x, y, w, h }, maxS = Infinity) {
  const b = boundsOf(parts), s = Math.min(w / b.w, h / b.h, maxS);
  return placeParts(parts, { dx: x + w / 2 - (b.x + b.w / 2) * s, dy: y + h / 2 - (b.y + b.h / 2) * s, s, lw: 1.15 / s });
}
/**
 * Computational pathology pipeline, 560 × 170: six stage columns joined by 14-unit block arrows —
 * WSI pyramid → tiling (mask + grid) → ViT encoder → patch embeddings (7) → attention-MIL pooling (7 scores)
 * → attention heatmap over the slide-level prediction bars. Every key object is ≥ 52 units across.
 */
function pipelineScene() {
  const W = 560, H = 170, cyA = 85, aw = 14, m = 6;
  const cols = [
    { w: 76, boxes: [[wsiPyramid(), 0, 24, 122]] },
    { w: 76, boxes: [[tilingMini(), 0, 47, 76]] },
    { w: 76, boxes: [[encoderMini(), 0, 29, 112]] },
    { w: 64, boxes: [[embMini(), 0, 37, 96]] },
    { w: 92, boxes: [[milMini(), 0, 36, 98]] },
    { w: 72, boxes: [[heatMini(), 0, 18, 64], [predMini(), 14, 94, 48]] },
  ];
  const gap = (W - 2 * m - cols.reduce((a, c) => a + c.w, 0) - (cols.length - 1) * aw) / (2 * (cols.length - 1));
  const parts = [], arrows = [];
  let x = m;
  cols.forEach((c, i) => {
    for (const [ps, dx, y, h] of c.boxes) parts.push(...fitInto(ps, { x: x + dx, y, w: c.w - 2 * dx, h }));
    x += c.w;
    if (i < cols.length - 1) { arrows.push(arrowD(x + gap, x + gap + aw, cyA, 8, 2)); x += aw + 2 * gap; }
  });
  parts.push(arrowPart(arrows));
  return { size: [W, H], lineWidth: 1.6, parts };
}

/**
 * Model training loop: labelled H&E tiles → network (forward pass) → predictions vs. targets → loss →
 * backpropagation (red, returning under the strip) with the gradient that updates the weights.
 */
function trainingLoopParts() {
  const parts = [];
  // 1. training data: labelled tiles
  const tiles = [[32, 22, D.cStr], [24, 30, D.cLym], [16, 38, D.cTum]], s = 60;
  parts.push({ d: rect(32, 22, s, s, 1.5), fill: "#e7b0cb", shade: "rim", gloss: false });
  parts.push({ d: rect(24, 30, s, s, 1.5), fill: "#efc0d5", shade: "rim", gloss: false });
  parts.push(...hePatches([{ kind: "tumour", x: 16, y: 38, s, V: 140, seed: 44 }], 0.6));
  parts.push(frames([[16, 38, s]], { color: "#8b97a5", width: 1 }));
  tiles.forEach(([x, y, c]) => parts.push({ d: rect(x + s - 8, y + s - 7, 15, 10, 2.5), fill: c, shade: "small", thin: true }));
  // 2. model (forward pass)
  const xs = [150, 182, 214, 246], counts = [3, 4, 4, 3], pitch = 22, cy = 68, r = 7.5;
  const layers = counts.map((c, k) => Array.from({ length: c }, (_, i) => [xs[k], cy + (i - (c - 1) / 2) * pitch]));
  const R = rng(19), weak = [], upd = [];
  for (let k = 0; k < 3; k++) for (const a of layers[k]) for (const b of layers[k + 1]) (R() < 0.24 ? upd : weak).push(polyline([a, b]));
  parts.push({ d: weak.join(""), fill: "none", stroke: { color: "#b9c3ce", width: 1, cap: "round" }, lineStrokeWidth: 0.8 });
  parts.push({ d: upd.join(""), fill: "none", stroke: { color: D.backprop, width: 1.5, cap: "round" }, lineColor: shade(D.backprop, 0.08), lineStrokeWidth: 1.2, opacity: 0.85 });
  const fills = [D.token, D.enc, D.enc, D.head];
  layers.forEach((L, k) => parts.push({ d: L.map(([x, y]) => circle(x, y, r)), fill: fills[k], shade: "organelle", glossSize: 0.08 }));
  // 3. predictions (filled) vs. one-hot target (dashed)
  const bx = 300, base = 100, H = 60, probs = [0.6, 0.29, 0.11], pc = [D.cTum, D.cLym, D.cStr];
  probs.forEach((p, i) => parts.push({ d: rect(bx + i * 17, base - p * H, 12, p * H, 1), fill: pc[i], lineWidth: 0.8 }));
  parts.push({ d: rect(bx - 1.5, base - H - 1.5, 15, H + 1.5, 1), fill: "none", stroke: { color: "#3e4955", width: 1.3, dash: [3, 2.2], cap: "butt" }, lineStrokeWidth: 1.2 });
  parts.push({ d: polyline([[bx - 6, base - H - 4], [bx - 6, base], [bx + 50, base]]), fill: "none", stroke: { color: "#6f7d8c", width: 1.4, cap: "round" }, lineStrokeWidth: 1.3 });
  // 4. loss
  const lx0 = 402, ly0 = 100, lx1 = 486, ly1 = 36;
  const LX = (t) => lx0 + 5 + t * (lx1 - lx0 - 8), LY = (v) => ly0 - 4 - v * (ly0 - ly1 - 8);
  const lc = Array.from({ length: 21 }, (_, i) => { const t = i / 20; return [LX(t), LY(0.08 + 0.9 * Math.exp(-t / 0.22) + (R() - 0.5) * 0.05)]; });
  parts.push(axes(lx0, ly0, lx1, ly1, { xt: [LX(0.5), LX(1)], yt: [LY(0.5)] }));
  parts.push({ d: polyline(lc.slice(0, 13)), fill: "none", stroke: { color: CLU[0], width: 2, cap: "round", join: "round" }, lineColor: shade(CLU[0], 0.12), lineStrokeWidth: 1.8 });
  parts.push({ d: polyline(lc.slice(12)), fill: "none", stroke: { color: "#b9c3ce", width: 1.6, dash: [3, 2.5], cap: "butt" }, lineStrokeWidth: 1.2 });
  parts.push({ d: circle(...lc[12], 3.6), fill: D.backprop, lineWidth: 0.8 });
  // forward arrows
  parts.push(arrowPart([arrowD(104, 130, cy, 9, 2), arrowD(262, 288, cy, 9, 2), arrowD(362, 388, cy, 9, 2)]));
  // 5. backpropagation: loss → gradients → weights
  const by = 152;
  parts.push({ d: `M${P(444, 112)}C${P(444, by)} ${P(444, by)} ${P(416, by)}L${P(226, by)}C${P(200, by)} ${P(198, by)} ${P(198, 120)}`, fill: "none", stroke: { color: D.backprop, width: 3, cap: "round" }, lineColor: shade(D.backprop, 0.1), lineStrokeWidth: 2.4 });
  parts.push({ d: roundPoly([[198, 108], [205, 121], [191, 121]], 1), fill: D.backprop, thin: true });
  const gx = 302, gs = 36;
  parts.push({ d: rect(gx, by - gs / 2, gs, gs, 4), fill: "#f4f6f8", shade: "rim", gloss: false, highlight: false, lineWidth: 1 });
  const gcells = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) gcells.push({ x: gx + 3 + j * 7.6, y: by - gs / 2 + 3 + i * 7.6, w: 7, h: 7, v: R() * 2 - 1, r: 0.8 });
  parts.push(...cellParts(gcells, { lw: 0.4 }));
  return parts;
}

/* ============================== icon list ============================== */

/** Crop a scene to its content plus a margin (content centred). */
function fitted(parts, { m = 9, lineWidth = 1.3 } = {}) {
  const all = parts.map((p) => { const pb = pathBox(p.unite || p.d), w = p.stroke ? p.stroke.width / 2 : 0; return [pb.x - w, pb.y - w, pb.x + pb.w + w, pb.y + pb.h + w]; });
  const x0 = Math.min(...all.map((a) => a[0])), y0 = Math.min(...all.map((a) => a[1])), x1 = Math.max(...all.map((a) => a[2])), y1 = Math.max(...all.map((a) => a[3]));
  return { size: [Math.ceil(x1 - x0 + 2 * m), Math.ceil(y1 - y0 + 2 * m)], lineWidth, parts: xform(parts, place({ x: m - x0, y: m - y0 })) };
}

const AI_TAGS = ["artificial intelligence", "AI", "machine learning", "ML", "deep learning", "computational pathology", "digital pathology"];

export const icons = [
  {
    slug: "he-patch-tumour", name: "H&E patch — tumour (adenocarcinoma)", category: "methods",
    tags: ["H&E", "hematoxylin and eosin", "haematoxylin", "eosin", "patch", "tile", "image patch", "tumour", "tumor", "carcinoma", "adenocarcinoma", "colorectal cancer", "CRC", "TUM", "glands", "digital pathology", "computational pathology", "histopathology", "deep learning", "training data", "whole-slide image", "WSI"],
    scene: () => patchScene("tumour", 39),
  },
  {
    slug: "he-patch-stroma", name: "H&E patch — stroma (collagen and fibroblasts)", category: "methods",
    tags: ["H&E", "hematoxylin and eosin", "patch", "tile", "stroma", "STR", "fibrous stroma", "collagen", "fibroblast", "desmoplasia", "connective tissue", "digital pathology", "computational pathology", "histopathology", "deep learning", "training data"],
    scene: () => patchScene("stroma", 33),
  },
  {
    slug: "he-patch-lymphocytes", name: "H&E patch — lymphocytes (immune infiltrate)", category: "methods",
    tags: ["H&E", "hematoxylin and eosin", "patch", "tile", "lymphocytes", "LYM", "immune infiltrate", "TILs", "tumour-infiltrating lymphocytes", "lymphoid aggregate", "tertiary lymphoid structure", "TLS", "high endothelial venule", "digital pathology", "computational pathology", "histopathology", "deep learning", "training data"],
    scene: () => patchScene("lymph", 45),
  },
  {
    slug: "he-patch-grid", name: "H&E patch mosaic (tile dataset)", category: "methods",
    tags: ["H&E", "patches", "tiles", "mosaic", "tile dataset", "patch dataset", "training set", "NCT-CRC-HE", "tissue classes", "tumour", "stroma", "lymphocytes", "adipose", "mucus", "muscle", "normal mucosa", "debris", "necrosis", "digital pathology", "computational pathology", "deep learning", "self-supervised learning"],
    scene: () => patchGrid(),
  },
  {
    slug: "he-glass-slide", name: "H&E glass slide — stained tissue section under a coverslip, barcode label", category: "methods",
    tags: ["glass slide", "microscope slide", "histology slide", "H&E", "hematoxylin and eosin", "haematoxylin and eosin", "stained section", "tissue section", "FFPE", "formalin-fixed paraffin-embedded", "coverslip", "barcode", "label", "slide label", "pathology", "histopathology", "digital pathology", "whole-slide imaging", "WSI", "biopsy", "resection"],
    scene: () => fitted(heSlideParts(), { lineWidth: 1.3 }),
  },
  {
    slug: "whole-slide-image-scanner", name: "Whole-slide image scanner (digital pathology, brightfield)", category: "lab",
    tags: ["whole-slide scanner", "slide scanner", "WSI scanner", "whole-slide imaging", "WSI", "digital pathology", "scanner", "brightfield", "slide digitisation", "digitization", "high-throughput scanner", "slide rack", "Aperio", "GT 450", "Leica", "NanoZoomer", "Hamamatsu", "VENTANA DP 600", "Roche", "Philips IntelliSite", "Pannoramic", "3DHISTECH", "Grundium", "instrument", "computational pathology"],
    scene: () => fitted(scannerParts(), { lineWidth: 1.4 }),
  },
  {
    slug: "wsi-tiling-patches", name: "WSI tiling — tissue mask, patch grid and extracted patches", category: "methods",
    tags: ["whole-slide image", "WSI", "tiling", "tiles", "patches", "patch extraction", "patching", "tissue mask", "tissue segmentation", "Otsu", "grid", "224 px", "20x", "0.5 µm/px", "CLAM", "preprocessing", "H&E", "digital pathology", "computational pathology", "deep learning", "multiple-instance learning", "MIL"],
    scene: () => fitted(tilingParts(), { lineWidth: 1.3 }),
  },
  {
    slug: "attention-heatmap-wsi", name: "Attention heatmap over a whole-slide image", category: "methods",
    tags: ["attention heatmap", "heatmap", "attention map", "attention scores", "saliency", "interpretability", "explainability", "XAI", "whole-slide image", "WSI", "CLAM", "ABMIL", "TransMIL", "multiple-instance learning", "MIL", "tumour detection", "H&E", "digital pathology", "computational pathology", "colour bar"],
    scene: () => fitted(heatmapWsiParts(), { lineWidth: 1.3 }),
  },
  // ---------- models ----------
  {
    slug: "pathology-foundation-model", name: "Pathology foundation model — Vision Transformer encoder (self-supervised)", category: "computing",
    tags: [...AI_TAGS, "foundation model", "pathology foundation model", "Vision Transformer", "ViT", "ViT-L", "ViT-g", "encoder", "patch tokens", "CLS token", "class token", "positional embedding", "transformer blocks", "self-supervised learning", "SSL", "DINOv2", "iBOT", "masked image modelling", "pretraining", "UNI", "UNI2", "Virchow", "Virchow2", "CONCH", "Prov-GigaPath", "H-optimus", "Phikon", "embedding", "feature extractor"],
    scene: () => fitted(foundationParts(), { lineWidth: 1.3 }),
  },
  {
    slug: "dinov2-student-teacher", name: "DINOv2 self-distillation — student and teacher ViTs with EMA update (self-supervised pretraining)", category: "computing",
    tags: [...AI_TAGS, "DINOv2", "DINO", "iBOT", "self-distillation", "knowledge distillation", "student", "teacher", "student-teacher", "EMA", "exponential moving average", "momentum encoder", "self-supervised learning", "SSL", "pretraining", "multi-crop", "global crops", "local crops", "data augmentation", "masked image modelling", "MIM", "centering", "sharpening", "stop-gradient", "prototypes", "Vision Transformer", "ViT", "foundation model", "pathology foundation model", "UNI", "UNI2", "Virchow", "Virchow2", "Prov-GigaPath", "H-optimus", "Phikon-v2", "H&E"],
    scene: () => fitted(dinoParts(), { lineWidth: 1.3 }),
  },
  {
    slug: "transformer-block", name: "Transformer block — multi-head self-attention and MLP with residual connections", category: "computing",
    tags: [...AI_TAGS, "transformer", "transformer block", "encoder block", "self-attention", "multi-head attention", "MHA", "attention", "query", "key", "value", "QKV", "MLP", "feed-forward", "layer norm", "LayerNorm", "residual connection", "skip connection", "ViT", "LLM", "architecture"],
    scene: () => fitted(transformerBlockParts(), { lineWidth: 1.3 }),
  },
  {
    slug: "patch-embeddings-matrix", name: "Patch embeddings — H&E patches and their feature vectors", category: "charts",
    tags: [...AI_TAGS, "embeddings", "patch embeddings", "feature vectors", "features", "feature matrix", "representation", "latent space", "heat strip", "heatmap", "instance embeddings", "tile embeddings", "foundation model features", "H&E", "patches"],
    scene: () => fitted(embeddingsParts(), { lineWidth: 1.2 }),
  },
  {
    slug: "attention-mil-aggregation", name: "Attention-based multiple-instance learning (ABMIL) — bag of patches to slide prediction", category: "computing",
    tags: [...AI_TAGS, "multiple-instance learning", "MIL", "attention MIL", "ABMIL", "attention pooling", "gated attention", "CLAM", "TransMIL", "DSMIL", "aggregator", "bag", "instances", "weak supervision", "slide-level label", "slide embedding", "attention weights", "classifier", "prediction", "whole-slide image", "WSI"],
    scene: () => fitted(abmilParts(), { lineWidth: 1.2 }),
  },
  {
    slug: "neural-network", name: "Neural network (fully connected, multilayer perceptron)", category: "computing",
    tags: [...AI_TAGS, "neural network", "artificial neural network", "ANN", "multilayer perceptron", "MLP", "fully connected", "dense layers", "neurons", "nodes", "weights", "hidden layers", "input layer", "output layer", "deep neural network", "DNN"],
    scene: () => fitted(neuralNetParts(), { lineWidth: 1.3 }),
  },
  {
    slug: "convolutional-neural-network", name: "Convolutional neural network (CNN) — image to class", category: "computing",
    tags: [...AI_TAGS, "convolutional neural network", "CNN", "ConvNet", "convolution", "kernel", "filter", "receptive field", "feature maps", "pooling", "ResNet", "ResNet50", "EfficientNet", "fully connected", "classifier", "image classification", "H&E", "patch classification"],
    scene: () => fitted(cnnParts(), { lineWidth: 1.3 }),
  },
  {
    slug: "gpu-server", name: "GPU server — compute rack and GPU accelerator card", category: "computing",
    tags: ["GPU", "graphics processing unit", "accelerator", "server", "server rack", "compute node", "HPC", "high-performance computing", "cluster", "data centre", "datacenter", "cloud computing", "deep learning", "AI training", "inference", "CUDA", "NVIDIA", "A100", "H100", "H200", "B200", "L40S", "RTX", "workstation", "PCIe card", "computing"],
    scene: () => fitted(gpuServerParts(), { lineWidth: 1.3 }),
  },
  // ---------- evaluation charts ----------
  {
    slug: "training-loss-curve", name: "Training and validation loss curves (early stopping)", category: "charts",
    tags: [...AI_TAGS, "loss curve", "learning curve", "training loss", "validation loss", "epochs", "overfitting", "early stopping", "convergence", "model training", "cross-entropy", "line chart", "graph"],
    scene: () => fitted(lossCurveParts(), { lineWidth: 1.3 }),
  },
  {
    slug: "embedding-umap-tissue-types", name: "UMAP of patch embeddings coloured by tissue class", category: "charts",
    tags: [...AI_TAGS, "UMAP", "t-SNE", "embedding", "embedding space", "latent space", "patch embeddings", "feature space", "dimensionality reduction", "clusters", "tissue classes", "tissue types", "tumour", "stroma", "lymphocytes", "normal mucosa", "adipose", "muscle", "mucus", "debris", "NCT-CRC-HE-100K", "Kather", "foundation model features", "scatter plot"],
    scene: () => fitted(umapTissueParts(), { lineWidth: 1.2 }),
  },
  {
    slug: "confusion-matrix", name: "Confusion matrix (tissue-class classifier)", category: "charts",
    tags: [...AI_TAGS, "confusion matrix", "classification", "accuracy", "precision", "recall", "sensitivity", "specificity", "misclassification", "heatmap", "evaluation", "performance", "multiclass", "tissue classes", "matrix", "chart"],
    scene: () => fitted(confusionParts(), { lineWidth: 1.2 }),
  },
  {
    slug: "roc-curve", name: "ROC curve — two classifiers with AUC and chance line", category: "charts",
    tags: [...AI_TAGS, "ROC curve", "receiver operating characteristic", "AUC", "AUROC", "area under the curve", "sensitivity", "specificity", "true positive rate", "false positive rate", "TPR", "FPR", "operating point", "Youden", "classifier evaluation", "performance", "biomarker", "diagnostic accuracy", "chart", "graph"],
    scene: () => fitted(rocParts(), { lineWidth: 1.2 }),
  },
  // ---------- overview strips ----------
  {
    slug: "computational-pathology-pipeline", name: "Computational pathology pipeline — WSI to slide-level prediction and heatmap", category: "methods",
    tags: [...AI_TAGS, "pipeline", "workflow", "overview", "graphical abstract", "schematic", "whole-slide image", "WSI", "tiling", "patches", "tissue mask", "foundation model", "ViT", "encoder", "embeddings", "features", "multiple-instance learning", "MIL", "ABMIL", "CLAM", "attention pooling", "slide-level prediction", "weak supervision", "biomarker prediction", "attention heatmap", "H&E"],
    scene: () => pipelineScene(),
  },
  {
    slug: "model-training-loop", name: "Model training loop — forward pass, loss, backpropagation, weight update", category: "computing",
    tags: [...AI_TAGS, "training", "model training", "training loop", "supervised learning", "forward pass", "backpropagation", "backward pass", "gradient descent", "SGD", "Adam", "optimizer", "loss function", "cross-entropy", "gradients", "weights", "parameters", "labels", "ground truth", "epoch", "iteration", "workflow", "overview"],
    scene: () => fitted(trainingLoopParts(), { lineWidth: 1.3 }),
  },
];

