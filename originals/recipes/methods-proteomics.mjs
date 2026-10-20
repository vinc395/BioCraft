// Proteomics methods — spatial proteomics (PhenoCycler / CODEX, imaging mass cytometry, MIBI) and
// affinity proteomics (Olink PEA, SomaScan aptamers). Servier-like (soft) and NIH-like (line);
// light from the top left. Recurring things share colours (antibody chains, DNA barcodes,
// reporter dyes, marker pseudocolours, phenotypes) so single icons match the workflow strips.
import { blob, blobPts, circle, ellipse, rect, capsule, smoothClosed, smoothOpen, polygon, polyline, scatter, wavePts, rng, f } from "../lib/geom.mjs";
import { shade, tint, pathBox } from "../lib/style.mjs";
import { catmull, resample, arcLengths, roundPoly, clipConvex, inside, centroid, lineD, polyD, offsetClosed, signedArea } from "../lib/tissue.mjs";
import { unevenAngles, unevenSpacing, vary, clustered, fitInside } from "../lib/organic.mjs";
import { parseHex, toHex, toLch, fromLch } from "../../ui/js/color.js";

const DEG = Math.PI / 180;
const P = (x, y) => `${f(x)} ${f(y)}`;
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const add2 = (a, u, k = 1) => [a[0] + u[0] * k, a[1] + u[1] * k];

/* ---------------- palette ---------------- */

const COL = {
  ab: "#5b8bd9", abL: "#f0a35c", // antibody heavy / light chains (as the library IgG)
  barcode: "#45b7b0", // PhenoCycler antibody DNA barcode
  reporter: "#b9a6e6", // complementary reporter oligo
  dyeG: "#5cc85a", dyeY: "#f2b632", dyeM: "#c04fd0", // reporter dyes (3 channels per cycle)
  linker: "#a7b3c1", // conjugation linker (maleimide-PEG)
  polymer: "#8d9aab", chelator: "#7fcdbf", metal: "#a866c9", // MaxPar polymer, DOTA chelator, lanthanide
  protein: "#e9748a", protein2: "#f2b06b", protein3: "#8cc47a",
  pea1: "#45b7b0", pea2: "#f2c14e", peaNew: "#8e72c9", polymerase: "#7cc46a",
  apt: "#3f9fc9", mod: "#f2c14e", cy3: "#f07a3a", pcl: "#9a7bd0", biotin: "#5cb85c",
  strept: "#c9b8e6", bead: "#d3b88c", bead2: "#6e4a25", // catch-1 agarose, catch-2 magnetic beads
  plasma: "#f3d77a", plastic: "#e3edf4", plasticD: "#cadbe7",
  glass: "#dff0fb", slideEdge: "#a9c6dc", tissue: "#f2b9c8",
  laser: "#8b5cf6", plasmaTorch: "#c9a7f5", metalGrey: "#9aa8b7",
  arrow: "#c3d2e1", axis: "#6f7d8c",
  // pseudocolours of a multiplex immunofluorescence image (dark background)
  imgBg: "#161c27", dapi: "#4d7cf0",
};
/** Marker pseudocolours (mIF) and matching phenotype colours (maps). */
const TYPES = {
  liningFLS: { mk: "#e45ad2", ph: "#d987cf" }, // CD55 / PRG4 lining fibroblasts
  mac: { mk: "#ffd23f", ph: "#f2c14e" }, // CD68 macrophages
  B: { mk: "#ff5252", ph: "#e2606a" }, // CD20 B cells
  T: { mk: "#5ee05a", ph: "#6cbf68" }, // CD3 T cells
  endo: { mk: "#ff9c3c", ph: "#f0a050" }, // CD31 endothelium
  fib: { mk: "#3fd8e8", ph: "#45b7b0" }, // CD90 / PDPN sublining fibroblasts
  other: { mk: null, ph: "#c3ccd6" },
};
const HI = "#f7fafc", SHADOW = "#24303c";
/** The colour whose line-style flat() tint is `hex` — keeps dark image tiles near-black in line style too. */
const unflat = (hex) => { const [L, C, H] = toLch(parseHex(hex)); return toHex(fromLch(Math.max(0, (L - 0.18) / 0.82), C / 0.85, H)); };
/**
 * A part of a fluorescence / data image drawn identically in both styles: soft as given, line with the
 * fill pre-darkened so flat() restores it and no visible outline (images are not outlined objects).
 */
const imgPart = (p) => [{ ...p, line: false }, { ...p, soft: false, fill: unflat(p.fill), lineColor: p.lineColor ?? p.fill, lineWidth: p.lineWidth ?? 0.01 }];

/* ---------------- path helpers ---------------- */

function arc(cx, cy, rx, ry, a0, a1) {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90));
  const da = (a1 - a0) / n;
  let s = "";
  for (let i = 0; i < n; i++) {
    const t0 = (a0 + da * i) * DEG, t1 = (a0 + da * (i + 1)) * DEG;
    const k = (4 / 3) * Math.tan((t1 - t0) / 4);
    const p0 = [cx + rx * Math.cos(t0), cy + ry * Math.sin(t0)];
    const p1 = [cx + rx * Math.cos(t1), cy + ry * Math.sin(t1)];
    s += `C${P(p0[0] - k * rx * Math.sin(t0), p0[1] + k * ry * Math.cos(t0))} ${P(p1[0] + k * rx * Math.sin(t1), p1[1] - k * ry * Math.cos(t1))} ${P(p1[0], p1[1])}`;
  }
  return s;
}

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

const circPts = (cx, cy, r, n = 48, ry = r) => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * 2 * Math.PI) * r, cy + Math.sin((i / n) * 2 * Math.PI) * ry]);
const holeD = (pts) => polyD([...pts].reverse());
const ringD = (cx, cy, r0, r1, ry0 = r0, ry1 = r1) => polyD(circPts(cx, cy, r1, 64, ry1)) + holeD(circPts(cx, cy, r0, 64, ry0));

/** Local → world placement: scale s, rotation (degrees, clockwise on screen), optional mirror. */
function place({ x = 0, y = 0, s = 1, rot = 0, mirror = false } = {}) {
  const c = Math.cos(rot * DEG), sn = Math.sin(rot * DEG), m = mirror ? -1 : 1;
  return { P: ([px, py]) => [x + (m * px * c - py * sn) * s, y + (m * px * sn + py * c) * s], s, rot };
}
/** Map parts through placement t (geometry, stroke widths and line widths). */
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
/** Scale + move parts for strips (path data, stroke widths, outline widths). */
function placeParts(parts, { dx = 0, dy = 0, s = 1, lw = 1.67 } = {}) {
  const fn = ([x, y]) => [dx + x * s, dy + y * s];
  return parts.map((p) => {
    const q = { ...p };
    if (p.unite) q.unite = p.unite.map((d) => mapPath(d, fn));
    if (p.d) q.d = Array.isArray(p.d) ? p.d.map((d) => mapPath(d, fn)) : mapPath(p.d, fn);
    if (p.stroke) q.stroke = { ...p.stroke, width: p.stroke.width * s, ...(p.stroke.dash ? { dash: p.stroke.dash.map((v) => v * s) } : {}) };
    q.lineWidth = Math.max(0.55, (p.lineWidth ?? (p.shade === "small" || p.thin ? lw * 0.7 : lw)) * s);
    if (p.lineStrokeWidth) q.lineStrokeWidth = p.lineStrokeWidth * s;
    return q;
  });
}
/** Place parts built around their own origin at (x, y), scale s (outline widths kept constant). */
const put = (parts, x, y, s) => placeParts(parts, { dx: x, dy: y, s, lw: 1.67 / s });
function boundsOf(parts) {
  return pathBox(parts.flatMap((p) => p.unite || (Array.isArray(p.d) ? p.d : [p.d])).filter(Boolean));
}
/** Fit parts (built at any scale) centred into box [x0, y0, x1, y1]. */
function fit(parts, box, { maxS = Infinity, lw = 1.67 } = {}) {
  const b = boundsOf(parts);
  const s = Math.min((box[2] - box[0]) / b.w, (box[3] - box[1]) / b.h, maxS);
  return placeParts(parts, { dx: (box[0] + box[2]) / 2 - (b.x + b.w / 2) * s, dy: (box[1] + box[3]) / 2 - (b.y + b.h / 2) * s, s, lw: lw / s });
}

/** Points of a polyline between arc-length fractions a and b. */
function subLine(pts, a, b) {
  const s = arcLengths(pts), L = s[s.length - 1], A = a * L, B = b * L;
  const at = (v) => {
    let i = 1;
    while (i < s.length - 1 && s[i] < v) i++;
    const t = (v - s[i - 1]) / Math.max(1e-9, s[i] - s[i - 1]);
    return [lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)];
  };
  const out = [at(A)];
  for (let i = 0; i < pts.length; i++) if (s[i] > A + 0.3 && s[i] < B - 0.3) out.push(pts[i]);
  out.push(at(B));
  return out;
}
const spine = (pts, step = 1.5) => resample(catmull(pts, 12), step);
/** Offset a dense centreline sideways by k (positive = to the right of travel on screen). */
function offLine(c, k) {
  return c.map((p, i) => {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / l) * k, p[1] + (dx / l) * k];
  });
}

/** Closed outline of a band `w` wide along a dense centreline; cap0 / cap1 round the ends. */
const tubeD = (c, w, o = {}) => polyD(tubePts(c, w, o));
/**
 * A tube cut into overlapping round-capped pieces, as members of one `unite`. The merged outline is
 * the same, but soft style sizes the shadow rim by the pieces, so a long thin strand keeps its own
 * colour with a thin darker rim on the lower right instead of turning dark all over.
 */
function segTube(c, w, { cap0 = true, cap1 = true, piece = 12 } = {}) {
  const S = arcLengths(c), L = S.at(-1), n = Math.max(1, Math.round(L / piece));
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k / n - 0.4 / L), b = Math.min(1, (k + 1) / n + 0.4 / L);
    out.push(tubeD(subLine(c, a, b), w, { cap0: k > 0 || cap0, cap1: k < n - 1 || cap1 }));
  }
  return out;
}
/**
 * Soft-style shadow rim for a tube of width w along centreline c: a strip on the edge that faces the
 * lower right (light from the top left), thickest where the edge faces it squarely. Returned as path
 * data for a translucent dark overlay, so the strand itself stays one flat, recolourable colour.
 * `keep(p)` (optional) drops strip points where it is false (e.g. clipped at a protein's outline).
 */
function rimStrip(c, w, { t = 0.24 * w, map = null } = {}) {
  const out = [];
  for (const side of [1, -1]) {
    let run = [];
    const flush = () => {
      if (run.length > 2) {
        const pts = [...run.map((r) => r[0]), ...run.map((r) => r[1]).reverse()];
        out.push(polyD(map ? pts.map(map) : pts));
      }
      run = [];
    };
    for (let i = 0; i < c.length; i++) {
      const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      const n = [(-dy / l) * side, (dx / l) * side];
      const k = (n[0] + n[1]) * Math.SQRT1_2;
      if (k <= 0.05) { flush(); continue; }
      const th = t * Math.min(1, k * 1.25) ** 0.7;
      run.push([add2(c[i], n, w / 2), add2(c[i], n, w / 2 - th)]);
    }
    flush();
  }
  return out.join("");
}
function tubePts(c, w, { cap0 = false, cap1 = false, taper = 0 } = {}) {
  const n = c.length, L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const hw = (w / 2) * (1 - taper * (i / (n - 1)));
    L.push([c[i][0] - (dy / l) * hw, c[i][1] + (dx / l) * hw]);
    R.push([c[i][0] + (dy / l) * hw, c[i][1] - (dx / l) * hw]);
  }
  const pts = [...L];
  if (cap1) {
    const hw = (w / 2) * (1 - taper), p = c[n - 1], a0 = Math.atan2(L[n - 1][1] - p[1], L[n - 1][0] - p[0]);
    for (let k = 1; k < 8; k++) pts.push([p[0] + Math.cos(a0 - (Math.PI * k) / 8) * hw, p[1] + Math.sin(a0 - (Math.PI * k) / 8) * hw]);
  }
  pts.push(...R.reverse());
  if (cap0) {
    const hw = w / 2, p = c[0], a0 = Math.atan2(R[R.length - 1][1] - p[1], R[R.length - 1][0] - p[0]);
    for (let k = 1; k < 8; k++) pts.push([p[0] + Math.cos(a0 - (Math.PI * k) / 8) * hw, p[1] + Math.sin(a0 - (Math.PI * k) / 8) * hw]);
  }
  return pts;
}

/** Block arrow pointing right from x0 to x1 at height y. */
function arrowD(x0, x1, y, h = 12, head = 1.9) {
  const hh = (h * head) / 2, hl = Math.min((x1 - x0) * 0.55, h * 1.15);
  return roundPoly([[x0, y - h / 2], [x1 - hl, y - h / 2], [x1 - hl, y - hh], [x1, y], [x1 - hl, y + hh], [x1 - hl, y + h / 2], [x0, y + h / 2]], 1.6);
}
const arrowPart = (ds, fill = COL.arrow) => ({ d: [].concat(ds).join(""), fill, shade: "rim", gloss: false, highlight: false, thin: true });
/** A curved arrow along a dense centreline, ending in a head at the last point. */
function curvedArrowD(c, w = 5, head = 2.2) {
  const n = c.length, hl = w * 1.5;
  const s = arcLengths(c), L = s.at(-1);
  const body = subLine(c, 0, Math.max(0.05, 1 - hl / L));
  const e = body.at(-1), tip = c[n - 1];
  const ux = (tip[0] - e[0]) / (dist(tip, e) || 1), uy = (tip[1] - e[1]) / (dist(tip, e) || 1);
  const hw = (w * head) / 2;
  return [tubeD(body, w, { cap0: true }), polyD([[e[0] - uy * hw, e[1] + ux * hw], tip, [e[0] + uy * hw, e[1] - ux * hw]])];
}

/** Overlay highlight / shadow parts (soft style only). */
const glow = (d, opacity = 0.6, extra = {}) => ({ d, fill: HI, opacity, line: false, ...extra });
const dim = (d, opacity = 0.14, extra = {}) => ({ d, fill: SHADOW, opacity, line: false, ...extra });

/** Edge crescent for a flat rounded-rectangle face (light from the top left); flip = the lit edge. */
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
const faceShade = (x, y, w, h, r, fill, { bw = 3, hw = 2.4, dark = 0.1, light = 0.5 } = {}) => [
  { d: edgeBand(x, y, w, h, r, bw), fill: shade(fill, dark), line: false },
  glow(edgeBand(x, y, w, h, r, hw, { flip: true }), light),
];
/** A flat rounded panel with soft edge shading. */
const panel = (x, y, w, h, r, fill, o = {}) => [{ d: rect(x, y, w, h, r), fill, ...(o.part || {}) }, ...faceShade(x, y, w, h, r, fill, o)];

/** Light stripe on the lit side and a shadow stripe on the far side of tubes (soft only). */
function tubeStripes(cs, w, { caps = true, hi = 0.55, lo = 0.15 } = {}) {
  const off = (c, k) => c.map(([x, y]) => [x + k * w, y + k * w]);
  const o = { cap0: caps, cap1: caps };
  return [
    { unite: cs.map((c) => tubeD(off(c, 0.17), w * 0.4, o)), fill: SHADOW, opacity: lo, line: false },
    { unite: cs.map((c) => tubeD(off(c, -0.15), w * 0.24, o)), fill: HI, opacity: hi, line: false },
  ];
}

/* ---------------- DNA strands ---------------- */

/**
 * Base "teeth" along part of a dense centreline: short rounded sticks every `pitch`, on `side`
 * (+1 right of travel, −1 left), from the strand's middle out to `len` beyond it.
 */
function teeth(c, { from = 0, to = 1, pitch = 4.6, len = 5, w = 2.2, side = 1, skip = 0 } = {}) {
  const seg = subLine(c, from, to);
  const pts = resample(seg, pitch).slice(skip ? 1 : 0);
  const out = [];
  out.tips = [];
  for (let i = 0; i < pts.length; i++) {
    const a = seg[0], p = pts[i];
    const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
    let dx = q[0] - o[0], dy = q[1] - o[1];
    if (!dx && !dy) { dx = p[0] - a[0]; dy = p[1] - a[1]; }
    const l = Math.hypot(dx, dy) || 1, nx = (-dy / l) * side, ny = (dx / l) * side;
    out.push(capsule(p[0], p[1], p[0] + nx * len, p[1] + ny * len, w / 2));
    out.tips.push([p[0] + nx * len, p[1] + ny * len, nx, ny]);
  }
  return out;
}
/**
 * Soft-style shadow rim for strands: a translucent dark strip on the lower-right edge (rimStrip) over
 * a flat strand, so a long thin strand keeps its own colour at every size and in every icon.
 */
const strandRim = (cs, w, o = {}) => ({ d: [].concat(cs.length && Array.isArray(cs[0][0]) ? cs : [cs]).map((c) => rimStrip(c, w, o)).join(""), fill: SHADOW, opacity: 0.3, line: false });
/** A single DNA strand: backbone + teeth as one flat united part, plus its soft shadow rim. */
function strandPart(c, fill, { w = 4, cap0 = true, cap1 = true, teethOpts = null, extra = {} } = {}) {
  const sh = [tubeD(c, w, { cap0, cap1 })];
  for (const t of [].concat(teethOpts || [])) sh.push(...teeth(c, { w: w * 0.55, len: w * 1.25, ...t }));
  return [{ unite: sh, fill, thin: true, ...extra }, strandRim(c, w)];
}

/* ---------------- proteins ---------------- */

/** A globular protein: core ellipse + bump circles (geometry, so other parts can find its surface). */
function lumpyGeo(cx, cy, R, { n = 6, seed = 1, bump = 0.5, rot = 0, sx = 1, sy = 1 } = {}) {
  const r = rng(seed);
  const bumps = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + r() * 0.5) / n) * Math.PI * 2 + rot * DEG;
    const d = R * (0.42 + r() * 0.1), br = R * bump * (0.8 + r() * 0.4);
    bumps.push([cx + Math.cos(a) * d * sx, cy + Math.sin(a) * d * sy, br]);
  }
  return { c: [cx, cy], core: [R * 0.78 * sx, R * 0.78 * sy], bumps };
}
function lumpy(cx, cy, R, o = {}) {
  const g = lumpyGeo(cx, cy, R, o);
  return [ellipse(cx, cy, g.core[0], g.core[1]), ...g.bumps.map(([x, y, r]) => circle(x, y, r))];
}
const inLumpy = (g, [x, y]) => ((x - g.c[0]) / g.core[0]) ** 2 + ((y - g.c[1]) / g.core[1]) ** 2 <= 1 || g.bumps.some(([bx, by, br]) => Math.hypot(x - bx, y - by) <= br);
/** Distance from the protein's centre to its outline in direction a (degrees, screen). */
function rhoAt(g, a) {
  const u = [Math.cos(a * DEG), Math.sin(a * DEG)];
  let r = 0;
  while (r < 400 && inLumpy(g, add2(g.c, u, r + 0.2))) r += 0.2;
  return r + 0.1;
}
/** Point p pushed radially out onto the protein outline when it lies inside (clips shapes to the outside). */
const pushOut = (g, p) => {
  if (!inLumpy(g, p)) return p;
  const a = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) / DEG;
  return add2(g.c, [Math.cos(a * DEG), Math.sin(a * DEG)], rhoAt(g, a));
};
const proteinPart = (cx, cy, R, fill = COL.protein, seed = 4, o = {}) => ({ unite: lumpy(cx, cy, R, { seed, n: 6, ...o }), fill, shade: "organelle", glossSize: 0.07 });

/**
 * IgG antibody (same build as the library's antibody): hinge at the origin, Fc down, Fab arms up,
 * placed by t. Returns parts plus world positions of the Fab tips, the Fc end and the hinge sides.
 */
function antibody(t, { heavy = COL.ab, light = COL.abL, sh = "organelle" } = {}) {
  const r = 9, h = 6, o = r + 0.3, sn = Math.sin(38 * DEG), cs = Math.cos(38 * DEG);
  const H = [], Lc = [], hinge = [], tips = [], roots = [], vdom = [], caps = [];
  // every domain as a world capsule {a, b, r} too, so other parts can keep clear of the antibody
  const dom = (a, b) => (caps.push({ a: t.P(a), b: t.P(b), r: r * t.s }), capsule(...t.P(a), ...t.P(b), r * t.s));
  for (const k of [0, 1]) for (const side of [-1, 1]) {
    const cy = 26 + k * 32;
    H.push(dom([side * o, cy - h], [side * o, cy + h]));
  }
  for (const side of [-1, 1]) {
    const u = [side * sn, -cs], nin = [-side * cs, -sn], A0 = [side * 20.5, -3.5];
    const vd = [];
    for (const tt of [15, 47]) for (const [w, list] of [[o, H], [-o, Lc]]) {
      const c = add2(add2(A0, u, tt), nin, w);
      list.push(dom(add2(c, u, -h), add2(c, u, h)));
      // the variable domains (VH, VL) at the arm's end: world capsules, used to dock the arm on an antigen
      if (tt === 47) vd.push({ a: t.P(add2(c, u, -h)), b: t.P(add2(c, u, h)), r: r * t.s });
    }
    vdom.push(vd);
    hinge.push(capsule(...t.P([side * o, 10]), ...t.P(add2(add2(A0, nin, o), u, 4)), 2.6 * t.s));
    tips.push(t.P(add2(A0, u, 66)));
    roots.push(t.P(A0));
  }
  const g = sh === "organelle" ? { glossSize: 0.1 } : {};
  return {
    parts: [
      { d: hinge.join(""), fill: heavy, shade: "rim", gloss: false, highlight: false, thin: true },
      { d: H, fill: heavy, shade: sh, ...g },
      { d: Lc, fill: light, shade: sh, ...g },
    ],
    tips, roots, vdom, caps, fc: t.P([0, 76]), hingeL: t.P([-12, 7]), hingeR: t.P([12, 7]), t,
  };
}

/** Outline radius of protein g in direction a (degrees), from a 0.5° table (rhoAt is slow). */
function rhoFast(g, a) {
  if (!g.rt) {
    g.rt = new Float64Array(721);
    for (let i = 0; i <= 720; i++) g.rt[i] = rhoAt(g, i * 0.5);
  }
  const x = ((((a % 360) + 360) % 360) / 0.5), i = Math.min(719, Math.floor(x)), fr = x - i;
  return g.rt[i] * (1 - fr) + g.rt[i + 1] * fr;
}
/** Signed clearance of capsule {a, b, r} from protein g: negative = how deep it overlaps, positive = the gap. */
function capClear(g, { a, b, r }) {
  let best = Infinity;
  for (const e of [a, b]) for (let k = 0; k < 36; k++) {
    const q = [e[0] + Math.cos((k / 36) * 2 * Math.PI) * r, e[1] + Math.sin((k / 36) * 2 * Math.PI) * r];
    best = Math.min(best, dist(q, g.c) - rhoFast(g, Math.atan2(q[1] - g.c[1], q[0] - g.c[0]) / DEG));
  }
  return best;
}
/**
 * Dock Fab arm `arm` (0 left, 1 right) of an antibody (scale s, rotation near `rot`) onto protein g: the arm
 * axis is aimed at the protein's centre and the antibody slid along it until both variable domains (VH and
 * VL) overlap the protein outline by at least `depth`; the rotation is tuned within ±tune° so the two
 * domains sink in equally (binding as contact, not a near miss). Returns {t, clear: [VH, VL]}.
 */
function dockAb(g, { rot, s, arm, depth = 1.2, tune = 8, bias = 0.01 }) {
  let best = null;
  rhoFast(g, 0); // builds the radius table
  const rmax = Math.max(...g.rt);
  for (let dr = -tune; dr <= tune + 1e-9; dr += 0.5) {
    const ab0 = antibody(place({ s, rot: rot + dr }));
    const tip = ab0.tips[arm], root = ab0.roots[arm];
    const u = [(tip[0] - root[0]) / dist(tip, root), (tip[1] - root[1]) / dist(tip, root)];
    const at = (lam) => { const T = add2(g.c, u, -lam); return [T[0] - tip[0], T[1] - tip[1]]; };
    const clear = (lam) => { const o = at(lam); return ab0.vdom[arm].map((d) => capClear(g, { a: add2(d.a, o), b: add2(d.b, o), r: d.r })); };
    let lo = rmax * 0.4, hi = rmax * 3;
    for (let k = 0; k < 32; k++) {
      const m = (lo + hi) / 2;
      if (Math.max(...clear(m)) > -depth) hi = m; else lo = m;
    }
    const c = clear(lo), score = Math.abs(c[0] - c[1]) + Math.abs(dr) * bias;
    if (!best || score < best.score) best = { score, rot: rot + dr, o: at(lo), c };
  }
  return { t: place({ x: best.o[0], y: best.o[1], s, rot: best.rot }), clear: best.c };
}
/** Placement that puts Fab tip `arm` (0 left, 1 right) of an antibody at `tip`, rotated rot, scale s. */
function abAtTip(tip, rot, s, arm = 0) {
  const probe = antibody(place({ s, rot })).tips[arm];
  return place({ x: tip[0] - probe[0], y: tip[1] - probe[1], s, rot });
}

/* ---------------- PhenoCycler: barcoded antibody ---------------- */

/** IgG with a short single-stranded DNA barcode on a hinge cysteine (maleimide linker). Local, ~200 box. */
function barcodedAbParts() {
  const ab = antibody(place({ x: 84, y: 90, s: 0.98 }));
  const t = ab.t;
  const start = t.P([16, 12]);
  // barcode leaves a hinge cysteine between the right Fab arm and the Fc, then sweeps down to the right
  const c = spine([start, t.P([32, 22]), t.P([50, 30]), t.P([68, 44]), t.P([80, 62]), t.P([86, 80])], 1.2);
  const parts = [];
  const lk = spine([t.P([8, 9]), start], 0.8);
  parts.push({ d: tubeD(lk, 3.6, { cap0: true }), fill: COL.linker, shade: "rim", gloss: false, highlight: false, thin: true });
  parts.push(...strandPart(c, COL.barcode, { w: 5.4, cap0: false, teethOpts: { from: 0.1, to: 1, side: -1, pitch: 6.6, len: 6.2 } }));
  parts.push(...ab.parts);
  return parts;
}

/** A fluorophore: star + soft halo (soft style only). */
function dyeParts(cx, cy, r, fill, { halo = true, rot = -10 } = {}) {
  const out = [];
  if (halo) out.push({ d: circle(cx, cy, r * 1.9), fill, opacity: 0.28, line: false });
  out.push({ d: star(cx, cy, r, r * 0.5, 5, rot), fill, shade: "small", lineWidth: 0.8 });
  return out;
}

/** Base stations along centreline c between arc fractions a and b: points every `pitch` with the unit normal on `side` (−1 left of travel). */
function stations(c, a, b, pitch, side) {
  const L = arcLengths(c).at(-1), seg = subLine(c, a, b), pts = resample(seg, pitch);
  return pts.map((p, i) => {
    const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
    const dx = q[0] - o[0], dy = q[1] - o[1], l = Math.hypot(dx, dy) || 1;
    return { p, n: [(-dy / l) * side, (dx / l) * side], u: Math.min(b, a + (i * pitch) / L) };
  });
}

/**
 * PhenoCycler reporter hybridisation, 268 × 168. A cell surface in the tissue section (cytoplasm with
 * cortical actin under the lipid bilayer, on the glass slide) carries four DIFFERENT antigens — three
 * single-domain membrane proteins of different sizes and a two-domain receptor on a longer stalk —
 * each recognised by its own DNA-barcoded antibody (tilts, sizes and spacing vary as in a real section;
 * Fab domains docked onto the antigen). This cycle's three reporters (complementary oligos, one dye each)
 * are hybridised to their own barcodes, base for base at the barcode's stations; the fourth barcode
 * waits for a later cycle. Barcodes teal, reporters lilac throughout.
 */
function reporterHybParts() {
  const parts = [];
  const My = 118; // outer membrane surface
  const yo = My + 3, yi = My + 15.5, hr = 2.6, Ys = My + 31; // head-group rows of the two leaflets; slide top
  // tissue: cytoplasm under a lipid bilayer, on the glass slide
  parts.push({ d: rect(8, Ys, 252, 9, 3), fill: COL.glass, lineWidth: 1.1 }, ...faceShade(8, Ys, 252, 9, 3, COL.glass, { bw: 1.6, hw: 1.2, from: 4, light: 0.7 }));
  parts.push({ d: polyD([[8, My + 4], [260, My + 4], [260, Ys], [8, Ys]]), fill: "#f6d3dc", lineWidth: 1.1 });
  // cortical actin just under the inner leaflet: three long, gently wavy filaments, overlapping in places
  const act = [[11, 118, yi + 6.4, 0.3, 0.9], [92, 199, yi + 9.6, 2.1, 1.1], [160, 257, yi + 6.8, 4.0, 1.0]]
    .map(([x0, x1, y, ph, amp]) => tubeD(resample(catmull(wavePts(x0, y, x1, y, { amp, waves: (x1 - x0) / 31, phase: ph, n: 36 }), 4), 0.9), 1.6, { cap0: true, cap1: true }));
  parts.push({ d: act.join(""), fill: "#e7a6b8", thin: true, lineWidth: 0.6 });
  // lipid bilayer: two leaflets of head groups, their paired fatty-acid tails meeting in the core
  const heads = [], tails = [];
  for (let x = 10.5; x <= 258; x += 6) {
    const w = Math.sin(x * 0.05) * 0.8;
    heads.push(circle(x, yo + w, hr), circle(x, yi + w, hr));
    for (const dx of [-0.95, 0.95]) tails.push(capsule(x + dx, yo + w + hr - 0.4, x + dx * 1.15, yo + w + 5.7, 0.55), capsule(x + dx, yi + w - hr + 0.4, x + dx * 1.15, yi + w - 5.7, 0.55));
  }
  parts.push({ d: rect(8, yo, 252, yi - yo), fill: "#fbf1e2", thin: true });
  parts.push({ d: tails.join(""), fill: "#e9c88f", lineWidth: 0.35 });
  parts.push({ d: heads.join(""), fill: "#f0a35c", lineWidth: 0.55 });
  // four targets: x, colour, top-domain radius and seed, antibody tilt and scale, barcode bend (local x offsets)
  const T = [
    { x: 43, col: "#e9748a", R: 12, seed: 21, rot: 153, s: 0.41, bend: [2, -3, 3, -2], len: 108, dye: COL.dyeG },
    { x: 95, col: "#f2b06b", R: 10.5, seed: 34, rot: 171, s: 0.43, bend: [-3, 2, -4, 1], len: 102, dye: COL.dyeY },
    { x: 159, col: "#8cc47a", R: 10, seed: 52, rot: 158, s: 0.38, bend: [3, 4, -1, 3], len: 96, dye: COL.dyeM, two: true },
    { x: 205, col: "#9a7bd0", R: 13.5, seed: 47, rot: 178, s: 0.4, bend: [-2, -4, 2, -3], len: 105, dye: null },
  ];
  const antigens = [], abParts = [], bcs = [], reps = [];
  for (const a of T) {
    let top, sh;
    if (a.two) {
      // two-domain receptor: membrane-proximal domain on a long stalk, the distal domain above it
      const p = [a.x - 1, My - 11], q = [a.x + 2.5, My - 29];
      sh = [...lumpy(p[0], p[1], 8, { seed: a.seed + 5, n: 5, bump: 0.5 }), capsule(a.x - 1, My - 4, a.x - 1, yi, 3), capsule(p[0], p[1] - 5, q[0], q[1] + 5, 2.6)];
      top = { c: q, R: a.R };
    } else {
      top = { c: [a.x, My - a.R * 0.66 - 2], R: a.R };
      sh = [capsule(a.x, My - 2, a.x, yi, 3)];
    }
    const g = lumpyGeo(top.c[0], top.c[1], top.R, { seed: a.seed, n: 5, bump: 0.5 });
    antigens.push({ unite: [...lumpy(top.c[0], top.c[1], top.R, { seed: a.seed, n: 5, bump: 0.5 }), ...sh], fill: a.col, shade: "organelle", glossSize: 0.09 });
    const dk = dockAb(g, { rot: a.rot, s: a.s, arm: 1, depth: 1.0, tune: 6 });
    if (Math.max(...dk.clear) > -0.7) console.warn("  ! reporter hyb: Fab off its antigen", a.x, dk.clear);
    const ab = antibody(dk.t);
    abParts.push(ab);
    const t = ab.t, b = a.bend;
    const c = spine([t.P([13, 9]), t.P([26 + b[0], 26]), t.P([28 + b[1], 50]), t.P([26 + b[2], 76]), t.P([22 + b[3], a.len])], 1.1);
    const st = stations(c, 0.4, 0.98, 5.6, -1);
    bcs.push({ c, lk: spine([t.P([6, 7]), t.P([14.5, 9.5])], 0.6), st });
    if (a.dye) {
      // reporter: pairs with the outer part of the barcode (the stations past 50%), 8.4 to its left
      const pair = st.filter(({ u }) => u > 0.4);
      const top2 = subLine(c, 0.37, 1);
      const rc = offLine(top2, -8.4).reverse();
      reps.push({ c: rc, dye: a.dye, end: rc[0], st: pair });
    }
  }
  parts.push(...antigens);
  for (const ab of abParts) parts.push(...ab.parts);
  // dye halos go under the strands (the reporter keeps one colour all along); the stars go on top
  const dyes2 = reps.map((r) => dyeParts(r.end[0], r.end[1] - 3, 7.2, r.dye));
  for (const dp of dyes2) parts.push(dp[0]);
  parts.push({ d: bcs.map((b) => tubeD(b.lk, 3.2, { cap0: true, cap1: true })).join(""), fill: COL.linker, shade: "rim", gloss: false, highlight: false, thin: true });
  // paired bases: tips meet 0.6 apart halfway across the 8.4 offset (cap radius 1.2 → stick 2.7 + cap)
  const bw = 2.4, bl = (8.4 - 0.6) / 2 - bw / 2;
  parts.push({
    unite: bcs.flatMap((b) => [tubeD(b.c, 4.4, { cap0: true, cap1: true }), ...b.st.map(({ p, n }) => capsule(p[0], p[1], p[0] + n[0] * bl, p[1] + n[1] * bl, bw / 2))]),
    fill: COL.barcode, thin: true,
  }, strandRim(bcs.map((b) => b.c), 4.4));
  parts.push({
    unite: reps.flatMap((r) => [tubeD(r.c, 4.4, { cap0: true, cap1: true }), ...r.st.map(({ p, n }) => {
      const q = add2(p, n, 8.4);
      return capsule(q[0], q[1], q[0] - n[0] * bl, q[1] - n[1] * bl, bw / 2);
    })]),
    fill: COL.reporter, thin: true,
  }, strandRim(reps.map((r) => r.c), 4.4));
  for (const dp of dyes2) parts.push(dp[1]);
  return parts;
}

/** A small reporter glyph: short oligo with its dye at one end, centred at (x, y), angle deg. */
function reporterGlyph(x, y, deg, dye, { len = 15, opacity } = {}) {
  const u = [Math.cos(deg * DEG), Math.sin(deg * DEG)];
  const a = add2([x, y], u, -len / 2), b = add2([x, y], u, len / 2);
  const c = spine([a, b], 0.8);
  const op = opacity != null ? { opacity } : {};
  const dp = dyeParts(b[0] + u[0] * 3, b[1] + u[1] * 3, 5.4, dye, { halo: opacity == null }).map((p) => ({ ...p, ...op }));
  // halo under the strand, star on top
  return [
    ...dp.slice(0, -1),
    { unite: [tubeD(c, 3.6, { cap0: true, cap1: true }), ...teeth(c, { pitch: 4.4, len: 3.2, w: 2, from: 0.12, to: 0.9, side: 1 })], fill: COL.reporter, thin: true, ...op },
    { ...strandRim(c, 3.6), ...(opacity != null ? { opacity: 0.3 * opacity } : {}) },
    dp.at(-1),
  ];
}

/**
 * One cycle's image of the SAME field (PhenoCycler re-images DAPI every cycle for registration): the cell
 * layout `cells` ({p, r, nuc}) is shared by all tiles; only which cells are positive, and for which of the
 * cycle's three markers, changes (~35% positive, different cells each cycle). Dark field kept near-black
 * in line style too (imgPart).
 */
function cycleTile(x, y, s, cells, cycle, { dyes = [COL.dyeG, COL.dyeY, COL.dyeM], frame = "#5d6b7c" } = {}) {
  const R = rng(101 + cycle * 17);
  const parts = [...imgPart({ d: rect(x, y, s, s, 3), fill: COL.imgBg, stroke: { color: frame, width: 1.1 }, lineColor: frame, lineWidth: 1 })];
  const ring = dyes.map(() => []), fill = dyes.map(() => []), nuc = [];
  for (const c of cells) {
    const [px, py] = [x + c.p[0] * s, y + c.p[1] * s], rr = c.r * s;
    if (R() < 0.36) {
      const k = Math.floor(R() * dyes.length);
      ring[k].push(ringD(px, py, rr * 0.76, rr));
      fill[k].push(circle(px, py, rr));
    }
    const n = c.nuc; // built at the tile's own scale (path data is rounded to 0.01)
    nuc.push(ellipse(x + n.cx * s, y + n.cy * s, n.rx * s, n.ry * s, n.rot));
  }
  dyes.forEach((c, k) => fill[k].length && parts.push(...imgPart({ d: fill[k].join(""), fill: c, opacity: 0.3 })));
  parts.push(...imgPart({ d: nuc.join(""), fill: COL.dapi, opacity: 0.95 }));
  dyes.forEach((c, k) => ring[k].length && parts.push(...imgPart({ d: ring[k].join(""), fill: c })));
  return parts;
}
/** The field imaged in every cycle: cells in unit coordinates (seeded, a loose cluster and sparser edges). */
function cycleField(n = 22) {
  const R = rng(37);
  const pts = clustered(R, { x: 0.09, y: 0.09, w: 0.82, h: 0.82 }, n, { clusters: 3, spread: 0.34, minDist: 0.158 });
  return pts.map(([px, py]) => {
    const r = vary(R, 0.07, 0.16);
    return { p: [px, py], r, nuc: { cx: px + (R() - 0.5) * r * 0.3, cy: py + (R() - 0.5) * r * 0.3, rx: r * 0.52, ry: r * 0.43, rot: R() * 180 } };
  });
}

/**
 * Objective lens seen from the side, front lens centred at f, axis u (unit vector toward the specimen):
 * a barrel (34 × 16) with three knurl rings at the back, a coloured magnification ring near the front,
 * then a stepped, narrower nose (10 wide) ending in the front lens.
 */
function objectiveParts(f, u, k = 1) {
  const v = [-u[1], u[0]];
  const Q = (a, b) => add2(add2(f, u, a * k), v, b * k);
  const quad = (a0, a1, h0, h1 = h0, r = 1.6) => roundPoly([Q(a0, -h0), Q(a1, -h1), Q(a1, h1), Q(a0, h0)], r * k);
  return [
    { d: quad(-46, -13.5, 8, 8, 2.6), fill: "#94a3b4", shade: "organelle", gloss: false },
    { d: [-43, -40, -37].map((a) => polyline([Q(a, -7.1), Q(a, 7.1)])).join(""), fill: "none", stroke: { color: "#6c7a8b", width: 0.9 * k, cap: "round" }, lineStrokeWidth: 0.8 * k },
    { d: quad(-19, -15, 8.3, 8.3, 0.8), fill: "#e2b23a", thin: true },
    { d: quad(-14, -7, 6.2, 6.2, 1.4), fill: "#7d8b9b", shade: "rim", gloss: false, highlight: false, thin: true },
    { d: quad(-7.5, 0, 4.7, 3.5, 1.3), fill: "#5f6f82", shade: "rim", gloss: false, highlight: false, thin: true },
    { d: ellipse(...Q(-0.4, 0), 1.1 * k, 2.6 * k, Math.atan2(u[1], u[0]) / DEG), fill: "#d9ecf8", thin: true },
  ];
}

/** PhenoCycler cycling: add reporters → image → strip, round the stained section; one image per cycle. */
function cyclesParts() {
  const parts = [];
  const C = [98, 88], Rr = 62;
  const P2 = (deg, r = Rr) => [C[0] + Math.cos(deg * DEG) * r, C[1] + Math.sin(deg * DEG) * r];
  // three arrows round the ring (clockwise), leaving room for the three steps
  const arcs = [[-58, 0], [60, 112], [178, 232]].map(([a0, a1]) => {
    const pts = [];
    for (let a = a0; a <= a1 + 0.01; a += 3) pts.push(P2(a));
    return curvedArrowD(spine(pts, 1), 6.4, 2.2);
  });
  parts.push(arrowPart(arcs.flat()));
  // the stained tissue section on its slide (stays on the stage for all cycles): a thin, flat section
  parts.push(...panel(C[0] - 31, C[1] - 15, 62, 30, 4, COL.glass, { bw: 1.8, hw: 1.4, light: 0.7 }));
  const tis = [C[0] + 1, C[1] + 0.5];
  parts.push({ d: blob(tis[0], tis[1], 22, 10.5, { n: 9, wobble: 0.12, seed: 4 }), fill: COL.tissue, stroke: { color: shade(COL.tissue, 0.1), width: 1 }, lineWidth: 1 });
  // top: this cycle's three reporters are added (one dye each), falling toward the section
  {
    const top = P2(-90);
    [[-21, 3, 72, COL.dyeG], [0, -2, 90, COL.dyeY], [21, 4, 107, COL.dyeM]].forEach(([dx, dy, a, dye]) => parts.push(...reporterGlyph(top[0] + dx, top[1] + dy - 2, a, dye, { len: 19 })));
  }
  // lower right: imaging — the objective aimed at the section; its light converges to a spot on the tissue
  {
    const a = 34, u = [-Math.cos(a * DEG), -Math.sin(a * DEG)];
    const f = add2(P2(a, Rr - 2), u, 14); // front lens
    const spot = add2(tis, [2, 1]), D = dist(f, spot);
    const ax = [(spot[0] - f[0]) / D, (spot[1] - f[1]) / D], vx = [-ax[1], ax[0]];
    const cone = polyD([add2(f, vx, -6), add2(f, vx, 6), add2(spot, vx, 1.5), add2(spot, vx, -1.5)]);
    parts.push({ d: cone, fill: "#bfe6ff", opacity: 0.55, line: false });
    parts.push({ d: cone, fill: "#cfe8f8", opacity: 0.6, soft: false, lineColor: "#cfe8f8", lineWidth: 0.01 });
    parts.push({ d: cone, fill: "none", stroke: { color: "#7fa7c4", width: 0.6, dash: [2, 1.6], cap: "butt" }, soft: false, lineColor: "#7fa7c4", lineStrokeWidth: 0.6 });
    parts.push({ d: ellipse(spot[0], spot[1], 2.6, 1.8), fill: "#eef8ff", opacity: 0.9, line: false });
    parts.push(...objectiveParts(f, ax));
  }
  // lower left: stripping — a drop of stripping buffer; the released reporters drift away (faded)
  {
    const b = P2(150, Rr + 3);
    parts.push({ d: smoothClosed([[b[0] + 2, b[1] - 17], [b[0] + 9, b[1] - 1], [b[0] + 6, b[1] + 7.5], [b[0] - 3, b[1] + 9], [b[0] - 8.5, b[1] + 1]], 0.9), fill: "#bfe0f5", shade: "small", glossAt: [0.34, 0.52] });
    parts.push(...reporterGlyph(b[0] - 18, b[1] - 14, -152, COL.dyeG, { opacity: 0.55, len: 18 }));
    parts.push(...reporterGlyph(b[0] - 15, b[1] + 18, 158, COL.dyeM, { opacity: 0.55, len: 18 }));
    parts.push(arrowPart(curvedArrowD(spine([[b[0] - 11, b[1] + 1.5], [b[0] - 26, b[1] + 3]], 0.6), 3.8, 2.2), "#a8bccf"));
  }
  // image stack: one image per cycle (three markers each), the same field every time, newest in front
  parts.push(arrowPart(arrowD(172, 188, C[1] - 4, 7, 2)));
  const cells = cycleField();
  for (let k = 0; k < 4; k++) parts.push(...cycleTile(220 - k * 9, 22 + k * 9, 70, cells, k));
  return parts;
}

/* ---------------- imaging mass cytometry: metal-tagged antibody ---------------- */

/** Distance from point p to segment ab. */
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
  const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - dx * k, p[1] - a[1] - dy * k);
}
/**
 * IgG with two MaxPar-type polymers, each maleimide-coupled to a hinge cysteine and carrying pendant DOTA
 * chelators that each hold one lanthanide ion. The two polymers differ, as real conjugates do: a longer
 * one (8 chelators) loops out to the lower left, a shorter one (6) runs down the right and curls under the
 * Fc. Chelators sit at uneven intervals (CV ~0.3), mostly alternating sides with the odd same-side pair,
 * radii ±10%; a pendant that would touch the antibody, the other polymer or another chelator flips side
 * or is dropped. Backbone + stubs are one flat shape (a polymer is a thin chain: no sphere shading) with a
 * translucent shadow strip along its lower-right edge in soft style, like the DNA strands in this file.
 */
function metalAbParts({ s = 1.04, x = 103.5, y = 75.8 } = {}) {
  const ab = antibody(place({ x, y, s }));
  const t = ab.t;
  const R = rng(23);
  const w = 3.2 * s;
  const polys = [
    { key: [[-12, 8], [-25, 13], [-37, 27], [-45, 47], [-47, 68], [-52, 86], [-64, 97], [-76, 99]], n: 8, sides: "oioo ioio" },
    { key: [[12, 8], [24, 14], [33, 30], [36, 50], [33, 70], [24, 85], [11, 92]], n: 6, sides: "ioiooi" },
  ].map((pl) => ({ ...pl, c: spine(pl.key.map(t.P), 1) }));
  const back = [], stubs = [], chel = [], ions = [], placed = [];
  const mid = t.P([0, 40]); // a point on the antibody's axis: "outer" pendants point away from it
  for (const pl of polys) {
    const c = pl.c, S = arcLengths(c), L = S.at(-1);
    back.push(...segTube(c, w, { piece: 10 }));
    const sides = pl.sides.replace(/ /g, "");
    const us = unevenSpacing(pl.n, L, R, { cv: 0.3, start: 0.13 * L, end: 1.02 * L });
    us.forEach((u, i) => {
      const at = S.findIndex((v) => v >= u), k = at < 0 ? c.length - 2 : Math.min(c.length - 2, at);
      const p = c[k], q = c[k + 1], o = c[Math.max(0, k - 1)];
      const dx = q[0] - o[0], dy = q[1] - o[1], l = Math.hypot(dx, dy) || 1;
      const nrm = [-dy / l, dx / l];
      const r = vary(R, 5.4 * s, 0.1), len = vary(R, 8.6 * s, 0.08);
      const cand = [1, -1].map((sd) => add2(p, nrm, sd * len));
      const outer = dist(cand[0], mid) > dist(cand[1], mid) ? 0 : 1;
      const want = sides[i] === "o" ? outer : 1 - outer;
      // a chelator must clear the antibody's domains, the chelators already placed and both backbones
      const ok = (e) => ab.caps.every((q) => segDist(e, q.a, q.b) > q.r + r + 1.6) && placed.every(([q2, rq]) => dist(e, q2) > r + rq + 1.4) &&
        polys.every((pl2) => pl2.c.every((p2) => dist(p2, e) > r + w / 2 + 1.2));
      const e = [cand[want], cand[1 - want]].find(ok);
      if (!e) return;
      placed.push([e, r]);
      stubs.push(capsule(...p, ...e, 1.15 * s));
      chel.push(circle(e[0], e[1], r));
      ions.push(circle(e[0] - 0.35 * s, e[1] - 0.35 * s, r * 0.6));
    });
  }
  if (placed.length < 12) console.warn("  ! metal-tagged antibody: only", placed.length, "chelators placed");
  return [
    { unite: [...back, ...stubs], fill: COL.polymer, thin: true },
    strandRim(polys.map((pl) => pl.c), w),
    ...ab.parts,
    { d: chel.join(""), fill: COL.chelator, shade: "small", thin: true },
    { d: ions.join(""), fill: COL.metal, shade: "small", thin: true },
  ];
}

/* ---------------- Olink proximity extension assay ---------------- */

/** DNA drawn in the PEA scene and the amplicons (scene units): strand width, centreline gap of a duplex, base width and pitch. */
const DNA = { ws: 7, gap: 17, tw: 3.8, pitch: 7.6 };
/** A base at (x, y) pointing down (dy 1) or up (−1); paired bases' tips meet 0.8 apart on the duplex midline. */
const baseD = (x, y, dy) => capsule(x, y, x, y + dy * ((DNA.gap - 0.8) / 2 - DNA.tw / 2), DNA.tw / 2);
/** Dense straight centreline from (x0, y) to (x1, y). */
const run = (x0, x1, y) => resample([[x0, y], [x1, y]], 1.1);
/** One flat strand (backbone + its bases as one shape) and its soft shadow rim. */
const strand = (c, fill, bases, { cap0 = true, cap1 = true } = {}) => [
  { unite: [tubeD(c, DNA.ws, { cap0, cap1 }), ...bases], fill, thin: true, lineWidth: 1.15 },
  strandRim(c, DNA.ws),
];

/**
 * One PEA step, scene units (~150 × 150). The target protein sits at the top; two antibodies each bind
 * their own epitope with one Fab arm — docked so that both variable domains (VH, VL) rest on the protein's
 * surface. Both lean in toward the protein (free arm up, Fc splayed down and out), which keeps the pair
 * compact so the DNA below can be the main subject. Each antibody's oligo starts inside its inner CH3
 * domain (where it is conjugated, so the Fc covers its 5' end), drops and turns inward: the left oligo
 * (teal) runs right along the upper level, the right oligo (yellow) runs left along the lower level. The
 * DNA spans the width under the pair: the 3' ends pair over nOv bases, and the yellow continues as a
 * template (nTpl bases) to the right antibody — the extension runs toward the template's 5' end, which is
 * why the right Fc sits beyond the template, with no hairpin. Every base on both strands sits at one shared
 * list of x stations; paired tips meet 0.8 apart on the duplex midline.
 * stage 1: hybridised; the template's bases still unpaired (a comb). stage 2: DNA polymerase sits on the
 * primer–template junction and has extended the teal 3' end along the template by nExt bases (new strand
 * violet, base for base on the template's bases); the template's last bases enter the enzyme unpaired.
 * Paint order: strands, polymerase, antibodies (covering the oligos' 5' ends), protein (over the Fab tips).
 */
const PEA = { s: 0.46, tilt: 18, pr: 22, drop: 28, nOv: 4, nTpl: 7, nExt: 4, polR: 16 };
function peaGeo(o = PEA) {
  const g = lumpyGeo(0, 0, o.pr, { seed: 6, n: 6 });
  const dk = { s: o.s, tune: o.tune ?? 6, bias: o.bias ?? 0.12 };
  const dL = dockAb(g, { ...dk, rot: o.tilt, arm: 1 }), dR = dockAb(g, { ...dk, rot: -o.tilt, arm: 0 });
  if (Math.max(...dL.clear, ...dR.clear) > -0.9) console.warn("  ! PEA: a Fab domain does not reach the protein", dL.clear, dR.clear);
  return { L: antibody(dL.t), R: antibody(dR.t), clear: [dL.clear, dR.clear] };
}
function peaScene(stage = 2, o = PEA) {
  const { gap, pitch } = DNA;
  const { L, R } = peaGeo(o);
  const Lf = L.fc, Rf = R.fc;
  const Yt = Math.max(Lf[1], Rf[1]) + o.drop, Yb = Yt + gap;
  // one shared list of base stations: the overlap (both strands), then the template (yellow; violet in stage 2)
  const xt0 = Lf[0] + 13; // where the teal has finished turning
  const span = (o.nOv + o.nTpl) * pitch, room = Rf[0] - 13 - xt0;
  if (span > room + 1) console.warn("  ! PEA: the template does not fit between the antibodies", span, room);
  const y3 = xt0 - 1; // the yellow's 3' end, just inside the teal's turn (spare room → clearance before the yellow's turn)
  const xs = Array.from({ length: o.nOv + o.nTpl }, (_, k) => y3 + pitch * (k + 0.5));
  const x3 = y3 + o.nOv * pitch, xe = x3 + o.nExt * pitch; // teal 3' end, extension front
  const xyr = y3 + span + 1; // where the yellow starts turning up to its antibody
  // the teal leaves the Fc heading down and a little out, then rounds into the upper level in one arc
  const lt = L.t.P([5.5, 79]);
  const cL = [...spine([L.t.P([6, 60]), lt, [lerp(lt[0], Lf[0], 0.5) - 0.6, lerp(lt[1], Yt, 0.55)], [Lf[0] + 2.6, Yt - 3.2], [Lf[0] + 8, Yt - 0.35], [xt0 + 1, Yt]], 1.1), ...run(xt0 + 2, x3, Yt).slice(1)];
  const cR = [...spine([R.t.P([-6, 60]), R.t.P([-5.5, 79]), [Rf[0] + 1.5, Yb - 13], [Rf[0] - 4, Yb - 2.2], [xyr, Yb]], 1.1), ...run(xyr - 1, y3, Yb).slice(1)];
  const parts = [];
  parts.push(...strand(cL, COL.pea1, xs.slice(0, o.nOv).map((x) => baseD(x, Yt, 1))));
  parts.push(...strand(cR, COL.pea2, xs.map((x) => baseD(x, Yb, -1))));
  if (stage === 2) {
    parts.push(...strand(run(x3, xe, Yt), COL.peaNew, xs.slice(o.nOv, o.nOv + o.nExt).map((x) => baseD(x, Yt, 1)), { cap0: false }));
    parts.push({ unite: lumpy(xe + o.polR * 0.42, (Yt + Yb) / 2, o.polR, { seed: 3, n: 6, bump: 0.5 }), fill: COL.polymerase, shade: "organelle", glossSize: 0.07 });
  }
  parts.push(...L.parts, ...R.parts);
  parts.push({ unite: lumpy(0, 0, o.pr, { seed: 6, n: 6 }), fill: COL.protein, shade: "organelle", glossSize: 0.07 });
  return parts;
}

/**
 * PCR amplicons in the PEA scene's units: the extended oligo (teal 5' part → violet copy) paired with its
 * complement (yellow). Both strands carry bases at the same x (every pitch), so all pairs are in register;
 * the teal → violet change falls between two bases.
 */
function ampliconParts({ n = 4, nb = 9, split = 4 } = {}) {
  const { ws, gap, pitch } = DNA;
  const top1 = [], top2 = [], bot = [], rims = [];
  const Lx = nb * pitch;
  // copies of one product, loosely stacked: uneven sideways offsets and spacing
  const offs = [0, 10.5, 2.5, 13], steps = [0, 33.5, 64, 98];
  for (let i = 0; i < n; i++) {
    const x0 = offs[i % 4], y = steps[i] ?? i * (gap + ws + 14);
    const xs = Array.from({ length: nb }, (_, k) => x0 + pitch / 2 + pitch * k), xm = x0 + split * pitch;
    top1.push(tubeD(run(x0, xm, y), ws, { cap0: true }), ...xs.slice(0, split).map((x) => baseD(x, y, 1)));
    top2.push(tubeD(run(xm, x0 + Lx, y), ws, { cap1: true }), ...xs.slice(split).map((x) => baseD(x, y, 1)));
    bot.push(tubeD(run(x0, x0 + Lx, y + gap), ws, { cap0: true, cap1: true }), ...xs.map((x) => baseD(x, y + gap, -1)));
    rims.push(run(x0, x0 + Lx, y), run(x0, x0 + Lx, y + gap));
  }
  const st = { thin: true, lineWidth: 1.15 };
  return [{ unite: bot, fill: COL.pea2, ...st }, { unite: top1, fill: COL.pea1, ...st }, { unite: top2, fill: COL.peaNew, ...st }, strandRim(rims, ws)];
}

/* ---------------- SomaScan: SOMAmer reagent ---------------- */

/** A biotin (small pentagon) centred at (x, y), radius r. */
const biotinD = (x, y, r, rot = 0) => roundPoly([0, 1, 2, 3, 4].map((i) => {
  const a = (rot - 90 + i * 72 + (i % 2 ? 6 : -4)) * DEG, rr = r * (i % 2 ? 0.92 : 1);
  return [x + Math.cos(a) * rr, y + Math.sin(a) * rr];
}), r * 0.24);

/**
 * A SOMAmer reagent (slow off-rate modified aptamer) folded onto its target protein, local: the 5' end
 * of the stem at the origin, the stem pointing up (−y), the protein above. Like the solved SOMAmer–protein
 * structures (PDGF-BB, IL-6) it is a compact, irregular fold on ONE face of the protein, not a ring:
 * a short 5-bp stem opens into two unequal lobes. Lobe 1 swings out to the left and tucks behind the
 * protein's rim (that stretch is drawn before the protein, which hides it) and the strand re-emerges at
 * the lower rim; lobe 2 crosses in front of the protein's lower face and returns to the stem. Modified
 * bases (benzyl-/naphthyl-dU, yellow knobs) sit on short stalks that press onto the protein surface.
 * 5' tags below the stem: Cy3, photocleavable linker, biotin (outermost).
 * w: strand width (other strand details scale with it); pr: protein size; ptags: angles (deg, local) of
 * NHS-biotin tags on the protein. Returns grouped parts and anchor points.
 */
function somaFold({ pr = 50, seed = 11, protein = COL.protein, w = 5.4, tags = true, cy3 = true, ptags = [], body = false } = {}) {
  const q = w / 5.4;
  const xs = 5.6 * q, bp = 6.2 * q, stemL = 5 * bp;
  const lo = { seed, n: 7, bump: 0.46 };
  const g0 = lumpyGeo(0, 0, pr, lo);
  const rho = (a) => rhoAt(g0, a);
  const C = [0, -stemL - 24 * q - rho(90)];
  const g = lumpyGeo(C[0], C[1], pr, lo);
  const dirA = (a) => [Math.cos(a * DEG), Math.sin(a * DEG)];
  const Pp = (a, off) => add2(C, dirA(a), rho(a) + off * q);
  const offOf = (p) => { const a = Math.atan2(p[1] - C[1], p[0] - C[0]) / DEG; return dist(p, C) - rho(a); };
  const hid = Pp(128, -18);
  const ctrl = [
    [-xs, 0], [-xs, -stemL * 0.5], [-xs, -stemL],
    Pp(113, 13), Pp(129, 10), Pp(145, 8.5), Pp(158, 3), // lobe 1 hugs the rim out to the left
    Pp(163, -8), Pp(150, -18), hid, Pp(106, -12), // tucked behind the protein's rim (hidden)
    Pp(97, 1.5), Pp(91, 8.5), // re-emerges at the lower rim
    Pp(80, 10), Pp(68, 9.5), Pp(57, 10.5), // lobe 2 along the lower-right rim…
    Pp(50, 17), Pp(57, 22.5), Pp(70, 22.5), Pp(82, 19.5), // …and back round to the stem
    [xs, -stemL], [xs, -stemL * 0.5], [xs, -3 * q],
  ];
  const c = spine(ctrl, 1.1 * q);
  const near = (p) => c.reduce((bi, q2, i) => (dist(q2, p) < dist(c[bi], p) ? i : bi), 0);
  // the hidden run: the inside stretch round `hid`, bounded by the last outside control points either side
  const ins = c.map((p) => inLumpy(g, p));
  const ih = near(hid), lo1 = near(ctrl[6]), hi1 = near(ctrl[12]);
  let iIn = ih, iOut = ih;
  while (iIn > lo1 && ins[iIn - 1]) iIn--;
  while (iOut < hi1 && ins[iOut + 1]) iOut++;
  const e = Math.round(3 / 1.1), cut = Math.round(9 / 1.1);
  // behind: from just outside the entry to just outside the exit
  const back = c.slice(Math.max(0, iIn - e - 2), iOut + e + 3);
  // in front: up to the rim and on from it; the pieces that meet the rim are clipped to the outline
  const f1 = c.slice(0, iIn - cut + 1), f1e = c.slice(iIn - cut, iIn + e + 1);
  const f2s = c.slice(iOut - e, iOut + cut + 1), f2 = c.slice(iOut + cut);
  const clip = (pts) => polyD(pts.map((p) => pushOut(g, p)));
  const pc = { piece: 7 * q };
  const front = [...segTube(f1, w, pc), clip(tubePts(f1e, w)), clip(tubePts(f2s, w)), ...segTube(f2, w, pc)];
  // stem base pairs: a stick from each strand to the midline
  for (let k = 0; k < 5; k++) {
    const y = -bp * (k + 0.55);
    front.push(capsule(-xs, y, -0.6 * q, y, 1.35 * q), capsule(0.6 * q, y, xs, y, 1.35 * q));
  }
  // loop bases (pointing at the protein) and modified bases on stalks reaching its surface
  const S = arcLengths(c);
  const visible = (i) => i < iIn - 3 || i > iOut + 3;
  const mods = [];
  let last = -99, nb = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i];
    if (p[1] > -stemL - 2 * q || !visible(i)) continue;
    if (S[i] - last < 6.6 * q) continue;
    const t = c[Math.min(c.length - 1, i + 1)], o = c[Math.max(0, i - 1)];
    const tn = [(t[0] - o[0]) / (dist(t, o) || 1), (t[1] - o[1]) / (dist(t, o) || 1)];
    const u = [(C[0] - p[0]) / dist(C, p), (C[1] - p[1]) / dist(C, p)];
    if (Math.abs(tn[0] * u[0] + tn[1] * u[1]) > 0.55) continue;
    const off = offOf(p);
    if (off > -1.5 * q && off < w * 0.75) continue; // right on the rim: no room
    last = S[i];
    nb++;
    const rk = 3.3 * q;
    if (off > w * 0.5 + rk && off < 16 * q && nb % 2 === 0 && mods.length < 6) {
      // modified base: its knob overlaps the protein surface by ~1 unit
      const a = Math.atan2(p[1] - C[1], p[0] - C[0]) / DEG;
      const kc = add2(C, dirA(a), rho(a) + rk - 1.2 * q);
      front.push(capsule(...p, ...kc, 1.3 * q));
      mods.push(circle(kc[0], kc[1], rk));
    } else front.push(capsule(...p, ...add2(p, u, 4.6 * q), 1.3 * q));
  }
  // the strand is flat; its shadow rim is a translucent overlay (soft style), the same at every size
  const st = { fill: COL.apt, thin: true };
  const rimP = (d) => ({ d, fill: SHADOW, opacity: 0.3, line: false });
  const po = (p) => pushOut(g, p);
  const tg = ptags.map((a) => {
    const r = 0.95 * w, p = add2(C, dirA(a), rho(a) + 0.12 * w); // overlaps the protein by ~0.8 w
    return { a, d: biotinD(p[0], p[1], r, a + 90), tip: add2(C, dirA(a), rho(a) + 0.12 * w + r) };
  });
  const out = {
    back: { unite: segTube(back, w, pc), ...st },
    backRim: rimP(rimStrip(back, w)),
    frontRim: rimP(rimStrip(f1, w) + rimStrip(f1e, w, { map: po }) + rimStrip(f2s, w, { map: po }) + rimStrip(f2, w)),
    protein: { unite: lumpy(C[0], C[1], pr, lo), fill: protein, ...(body ? { shade: "body", glossAt: [0.3, 0.22], glossSize: 0.045 } : { shade: "organelle", glossSize: 0.07 }) },
    ptags: tg.length ? { d: tg.map((t) => t.d).join(""), fill: COL.biotin, shade: "small", thin: true } : null,
    front: { unite: front, ...st },
    knobs: { d: mods.join(""), fill: COL.mod, shade: "small", thin: true },
    tags: [],
    biotinAt: [-xs, 29 * q],
    tagTip: (a) => tg.find((t) => t.a === a).tip,
    C, pr,
  };
  if (tags) {
    // 5' end: Cy3 fluorophore, photocleavable linker, biotin (outermost)
    out.tags.push({ d: tubeD(spine([[-xs, 9 * q], [-xs, 24 * q]], 0.8), 3.6 * q), fill: COL.pcl, shade: "rim", gloss: false, highlight: false, thin: true });
    out.tags.push({ d: biotinD(-xs, 29 * q, 6 * q, 20), fill: COL.biotin, shade: "small", thin: true });
  }
  if (cy3) out.tags.push({ d: star(-xs, 6.5 * q, 8.4 * q, 4.2 * q, 5, -10), fill: COL.cy3, shade: "small", thin: true });
  return out;
}
/** The fold's parts in paint order: hidden stretch, protein, (tags on the protein), front strand, knobs, 5' tags. */
const foldParts = (F, { protein = true } = {}) => [F.back, F.backRim, ...(protein ? [F.protein] : []), ...(F.ptags ? [F.ptags] : []), F.front, F.frontRim, F.knobs, ...F.tags];
/** The single SOMAmer icon: the fold turned so the stem runs up-left from the protein (5' tags at the top left). */
function somamerIconParts() {
  const F = somaFold({ pr: 50, seed: 11 });
  return fit(xform(foldParts(F), place({ rot: 135 })), [10, 10, 190, 190]);
}

/** A star (fluorophore), n points. */
function star(cx, cy, R, r, n = 5, rot = 0) {
  const pts = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = (rot - 90 + (i * 180) / n) * DEG, rr = i % 2 ? r : R;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return roundPoly(pts, R * 0.12);
}

/* ---------------- a segmented tissue field (shared by the image, phenotype and neighbourhood maps) ---------------- */

/** Keep the part of convex polygon `poly` where (p − m)·u ≤ 0. */
function clipHalf(poly, m, u) {
  const out = [];
  const side = (p) => (p[0] - m[0]) * u[0] + (p[1] - m[1]) * u[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp <= 0) !== (sq <= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}
/** Corner-cutting smoothing of a closed polygon. */
function chaikin(pts, it = 2) {
  let p = pts;
  for (let k = 0; k < it; k++) {
    const o = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = o;
  }
  return p;
}
const ellPoly = (cx, cy, rx, ry, rot = 0, n = 14) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * 2 * Math.PI, x = Math.cos(a) * rx, y = Math.sin(a) * ry, r = rot * DEG;
  return [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)];
});
const polyArea = (p) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;

/** Distance from c to polygon `poly` along the ray at angle deg (the polygon must be star-shaped about c). */
function rayHit(poly, c, deg) {
  const d = [Math.cos(deg * DEG), Math.sin(deg * DEG)];
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const e = [b[0] - a[0], b[1] - a[1]], den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-9) continue;
    const w = [a[0] - c[0], a[1] - c[1]];
    const t = (w[0] * e[1] - w[1] * e[0]) / den, s = (w[0] * d[1] - w[1] * d[0]) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best;
}
/** Cut off every corner of convex polygon `poly` sharper than minDeg (a glyph-like spike reads as a mark, not a cell). */
function blunt(poly, minDeg = 70) {
  let p = poly;
  for (let it = 0; it < 12; it++) {
    let worst = -1, wa = 180;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i - 1 + p.length) % p.length], v = p[i], b = p[(i + 1) % p.length];
      const u = [a[0] - v[0], a[1] - v[1]], w = [b[0] - v[0], b[1] - v[1]];
      const ang = Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1]) / ((Math.hypot(...u) * Math.hypot(...w)) || 1)))) / DEG;
      if (ang < wa) { wa = ang; worst = i; }
    }
    if (wa >= minDeg || worst < 0) break;
    const a = p[(worst - 1 + p.length) % p.length], v = p[worst], b = p[(worst + 1) % p.length];
    const k = 0.34 * Math.min(dist(a, v), dist(b, v));
    const ua = [(a[0] - v[0]) / dist(a, v), (a[1] - v[1]) / dist(a, v)], ub = [(b[0] - v[0]) / dist(b, v), (b[1] - v[1]) / dist(b, v)];
    p = [...p.slice(0, worst), add2(v, ua, k), add2(v, ub, k), ...p.slice(worst + 1)];
  }
  return p;
}

/**
 * A 180 × 180 field of inflamed tissue (synovium-like): a lining layer under the joint space at the top,
 * a lymphoid aggregate (a compact core of touching B cells, T cells round it), two vessels and stroma with
 * fibroblasts and macrophages. Stromal cells are a gapped Voronoi tessellation limited to a per-type
 * ellipse — round where there is room, polygonal where crowded, like expanded nuclei in real segmentations;
 * no cell keeps a corner sharper than 70°, and edge cells with < 35% of their area in the tile are dropped.
 * Vessels: irregular lumens (aspect ~1.3, the two differ), each lined by a few (4 / 3) flat endothelial
 * cells — crescents of unequal length with hairline gaps, one flattened nucleus each at an uneven place.
 * Lymphocyte nuclei fill ~80% of the cell. Also: Gabriel-graph neighbours and cellular-neighbourhood labels.
 */
let FIELD = null;
function field() {
  if (FIELD) return FIELD;
  const X0 = 10, Y0 = 10, W = 180, H = 180, R = rng(21);
  const surf = (x) => Y0 + 19 + 4 * Math.sin(x * 0.045 + 0.4) + 2.2 * Math.sin(x * 0.12 + 1);
  const WALL = 4.4; // endothelial cell thickness (segmentation mask)
  const vessels = [
    { c: [146, 133], rx: 16.5, ry: 12.4, rot: 28, seed: 5, nE: 4 },
    { c: [160, 60], rx: 9.6, ry: 7.3, rot: -52, seed: 12, nE: 3 },
  ].map((v) => {
    const lumen = catmull(blobPts(v.c[0], v.c[1], v.rx, v.ry, { n: 9, wobble: 0.1, seed: v.seed, rot: v.rot }), 8, true);
    const rt = Array.from({ length: 361 }, (_, i) => rayHit(lumen, v.c, i));
    const rV = (a) => { const x = ((a % 360) + 360) % 360, i = Math.floor(x); return rt[i] + (rt[i + 1] - rt[i]) * (x - i); };
    return { ...v, lumen, rV };
  });
  const wallGap = (p) => Math.min(...vessels.map((v) => dist(p, v.c) - v.rV(Math.atan2(p[1] - v.c[1], p[0] - v.c[0]) / DEG) - WALL));
  const agg = { c: [60, 134], r: 48 };
  const spacing = (p) => {
    if (p[1] < surf(p[0]) + 19) return 12.4;
    if (dist(p, agg.c) < agg.r) return 12;
    if (wallGap(p) < 13) return 12.4;
    return 17.5;
  };
  const seeds = [];
  // endothelium first: 3–4 flat cells per vessel, crescents of unequal length round the lumen
  for (const v of vessels) {
    const ang = unevenAngles(v.nE, R, { cv: 0.35 }).sort((a, b) => a - b);
    v.junctions = ang;
    const ga = (0.32 / ((v.rx + v.ry) / 2)) / DEG; // half a hairline gap, in degrees
    for (let k = 0; k < v.nE; k++) {
      const a0 = ang[k] + ga, a1 = (k + 1 < v.nE ? ang[k + 1] : ang[0] + 360) - ga;
      const n = Math.max(8, Math.ceil((a1 - a0) / 3));
      const outer = [], inner = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n, r = v.rV(a);
        outer.push(add2(v.c, dirOf(a), r + WALL));
        inner.push(add2(v.c, dirOf(a), r + 0.1));
      }
      const am = (a0 + a1) / 2, an = a0 + (a1 - a0) * (0.28 + R() * 0.44);
      seeds.push({
        p: add2(v.c, dirOf(am), v.rV(am) + WALL / 2), type: "endo", vessel: v,
        sector: chaikin([...outer, ...inner.reverse()], 1),
        nucPts: ellPoly(...add2(v.c, dirOf(an), v.rV(an) + 2.2), 3.5, 1.2, an + 90, 16),
      });
    }
  }
  for (let t = 0; t < 9000 && seeds.length < 400; t++) {
    const p = [X0 - 4 + R() * (W + 8), Y0 - 4 + R() * (H + 8)];
    if (p[1] < surf(p[0]) + 6) continue;
    if (wallGap(p) < 6.5) continue;
    const sp = spacing(p);
    if (seeds.some((q) => dist(p, q.p) < Math.min(sp, spacing(q.p)) * 0.98)) continue;
    seeds.push({ p });
  }
  // cell types by region: lining (FLS, macrophages), aggregate (B core, T rim), sublining stroma
  for (const s of seeds) {
    if (s.type) continue;
    const [x, y] = s.p, u = R(), da = dist(s.p, agg.c);
    if (y < surf(x) + 19) s.type = u < 0.62 ? "liningFLS" : "mac";
    else if (da < agg.r * 0.5) s.type = "B";
    else if (da < agg.r) s.type = u < 0.82 ? "T" : u < 0.87 ? "B" : u < 0.95 ? "mac" : "other";
    else s.type = u < 0.46 ? "fib" : u < 0.68 ? "mac" : u < 0.82 ? "T" : "other";
  }
  // shapes: gapped Voronoi ∩ per-type ellipse, kept 1 unit off the vessel walls; fibroblasts follow a gentle flow
  const box = tileClip(0.2), big = [[-20, -20], [220, -20], [220, 220], [-20, 220]];
  const flowAng = (p) => -18 + 14 * Math.sin(p[1] * 0.03 + p[0] * 0.01);
  for (const s of seeds) {
    let vor = big, cell = box, full = big;
    for (const q of seeds) {
      if (q === s || dist(q.p, s.p) > 58) continue;
      const u = [q.p[0] - s.p[0], q.p[1] - s.p[1]], l = Math.hypot(...u);
      const m = [(s.p[0] + q.p[0]) / 2, (s.p[1] + q.p[1]) / 2];
      vor = clipHalf(vor, m, u);
      if (s.sector || q.sector) continue; // the endothelium is bounded by the wall below, not by bisectors
      cell = clipHalf(cell, add2(m, u, -1 / l), u);
      full = clipHalf(full, add2(m, u, -1 / l), u);
    }
    s.vor = vor;
    if (s.sector) { s.cell = s.sector; s.nuc = { pts: s.nucPts }; continue; }
    const t = s.type;
    const [rx, ry, ang] = t === "fib" ? [15.5, 6, flowAng(s.p)] : t === "liningFLS" ? [10, 7.4, 8] : t === "mac" ? [11, 9.6, R() * 180] : t === "B" || t === "T" ? [7.3, 7, 0] : [8.3, 7.3, R() * 180];
    for (const [a, b] of ellPoly(s.p[0], s.p[1], rx, ry, ang).map((p, i, A) => [p, A[(i + 1) % A.length]])) {
      const e = [b[0] - a[0], b[1] - a[1]];
      cell = clipHalf(cell, a, [e[1], -e[0]]);
      full = clipHalf(full, a, [e[1], -e[0]]);
    }
    for (const v of vessels) {
      if (dist(s.p, v.c) > Math.max(v.rx, v.ry) + WALL + 26) continue;
      const a0 = Math.atan2(s.p[1] - v.c[1], s.p[0] - v.c[0]) / DEG;
      const W1 = (a) => add2(v.c, dirOf(a), v.rV(a) + WALL + 1);
      for (let da = -80; da <= 80; da += 4) {
        const m = W1(a0 + da), tg = [W1(a0 + da + 1)[0] - W1(a0 + da - 1)[0], W1(a0 + da + 1)[1] - W1(a0 + da - 1)[1]];
        let nIn = [tg[1], -tg[0]];
        if ((v.c[0] - m[0]) * nIn[0] + (v.c[1] - m[1]) * nIn[1] < 0) nIn = [-nIn[0], -nIn[1]];
        if ((s.p[0] - m[0]) * nIn[0] + (s.p[1] - m[1]) * nIn[1] >= 0) continue; // this stretch of wall faces away from the cell
        cell = clipHalf(cell, m, nIn);
        full = clipHalf(full, m, nIn);
      }
    }
    if (cell.length > 2 && polyArea(cell) < 0.35 * polyArea(full)) cell = [];
    if (cell.length > 2) cell = blunt(cell, 70);
    s.cell = cell.length > 2 ? chaikin(cell, 2) : null;
    if (s.cell) {
      const c = centroid(cell), A = polyArea(cell);
      const lym = t === "B" || t === "T";
      const req = Math.sqrt(A / Math.PI);
      const nuc = lym ? ellPoly(c[0] + (R() - 0.5) * 0.8, c[1] + (R() - 0.5) * 0.8, 0.8 * req, 0.74 * req, R() * 180, 16)
        : t === "fib" ? ellPoly(c[0], c[1], Math.sqrt(A) * 0.42, Math.sqrt(A) * 0.2, ang, 16)
        : ellPoly(c[0], c[1], Math.sqrt(A) * 0.33, Math.sqrt(A) * 0.27, R() * 180, 16);
      s.nuc = { pts: fitInside(nuc, s.cell, lym ? 1.1 : 1.4) ?? nuc };
    }
  }
  const cells = seeds.filter((s) => s.cell && s.p[0] > X0 - 2 && s.p[0] < X0 + W + 2 && s.p[1] > Y0 - 2 && s.p[1] < Y0 + H + 2);
  // Gabriel graph: i–j are neighbours if no other cell lies in the circle on their segment
  const edges = [];
  cells.forEach((a, i) => {
    a.nb = [];
    cells.forEach((b, j) => {
      if (j <= i) return;
      const d = dist(a.p, b.p);
      if (d > 34) return;
      const m = [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2];
      if (cells.some((c, k) => k !== i && k !== j && dist(c.p, m) < d / 2 - 0.01)) return;
      edges.push([i, j]);
    });
  });
  for (const [i, j] of edges) { cells[i].nb.push(j); cells[j].nb.push(i); }
  // cellular neighbourhoods: composition of each cell's 8 nearest cells (plus vessel proximity), then one smoothing vote
  cells.forEach((a) => {
    const w = [...cells].sort((p, q) => dist(p.p, a.p) - dist(q.p, a.p)).slice(0, 8);
    const n = (t) => w.filter((c) => c.type === t).length;
    a.cn = n("liningFLS") + n("mac") >= 4 && a.p[1] < surf(a.p[0]) + 34 ? 0 : n("B") + n("T") >= 4 ? 1 : n("endo") >= 1 && wallGap(a.p) < 22 ? 2 : 3;
  });
  const cn2 = cells.map((a) => {
    const votes = [0, 0, 0, 0];
    votes[a.cn] += 1.5;
    for (const j of a.nb) votes[cells[j].cn]++;
    return votes.indexOf(Math.max(...votes));
  });
  cells.forEach((a, i) => (a.cn = cn2[i]));
  // seeds whose cells are not drawn (outside the tile) take the neighbourhood of the nearest drawn cell
  for (const s of seeds) if (s.cn == null) s.cn = cells.reduce((b, c) => (dist(c.p, s.p) < dist(b.p, s.p) ? c : b)).cn;
  FIELD = { cells, seeds, edges, vessels, surf, X0, Y0, W, H, WALL };
  return FIELD;
}

/** A ring (membrane) inside the outline: outline + reversed inner offset. */
const ringPts = (pts, w) => polyD(pts) + holeD(offsetClosed(pts, -w));
/** CD31 on a vessel: one continuous, irregular ring on the luminal side, a little thicker at the cell junctions. */
function cd31Ring(v) {
  const outer = [], inner = [];
  for (let a = 0; a < 360; a += 2) {
    const j = Math.max(...v.junctions.map((q) => Math.exp(-(((((a - q) % 360) + 540) % 360 - 180) ** 2) / 50)));
    const r = v.rV(a);
    inner.push(add2(v.c, dirOf(a), r));
    outer.push(add2(v.c, dirOf(a), r + 2.0 + 0.9 * j));
  }
  return polyD(outer) + holeD(inner);
}

/** The tile as a convex octagon (corners chamfered inside the rounded frame), inset by m. */
const tileClip = (m = 0, c = 3.4) => [[10 + m + c, 10 + m], [190 - m - c, 10 + m], [190 - m, 10 + m + c], [190 - m, 190 - m - c], [190 - m - c, 190 - m], [10 + m + c, 190 - m], [10 + m, 190 - m - c], [10 + m, 10 + m + c]];
/** The field's frame: a rounded tile. */
const tileD = () => rect(10, 10, 180, 180, 5);

/** Pseudocoloured multiplex immunofluorescence image of the field: DAPI nuclei + 6 markers (identical in both styles). */
function mifParts() {
  const F = field();
  const parts = [...imgPart({ d: tileD(), fill: COL.imgBg, lineColor: "#3b4454", lineWidth: 1.2 })];
  const by = {};
  for (const c of F.cells) (by[c.type] = by[c.type] || []).push(c);
  const order = ["fib", "liningFLS", "mac", "T", "B"];
  // cytoplasmic / membrane signal: a faint fill, a soft inner glow, then (after the nuclei) the crisp membrane
  for (const t of order) {
    const cs = by[t] || [], mk = TYPES[t].mk;
    if (cs.length) parts.push(...imgPart({ d: cs.map((c) => polyD(c.cell)).join(""), fill: mk, opacity: 0.28 }));
  }
  for (const t of order) {
    const cs = by[t] || [], mk = TYPES[t].mk, lym = t === "B" || t === "T";
    if (cs.length) parts.push(...imgPart({ d: cs.map((c) => ringPts(c.cell, lym ? 2.2 : 3.6)).join(""), fill: mk, opacity: 0.3 }));
  }
  // red-cell autofluorescence in the larger lumen
  const v0 = F.vessels[0];
  parts.push(...imgPart({ d: [[-5, -2.4, 2.4], [3.4, 2.6, 2.2], [6.2, -4.2, 2]].map(([dx, dy, r]) => ellipse(v0.c[0] + dx, v0.c[1] + dy, r, r * 0.8, 20)).join(""), fill: "#c7604f", opacity: 0.6 }));
  parts.push(...imgPart({ d: F.cells.map((c) => smoothClosed(c.nuc.pts)).join(""), fill: COL.dapi, opacity: 0.92 }));
  for (const t of order) {
    const cs = by[t] || [], mk = TYPES[t].mk, lym = t === "B" || t === "T";
    if (cs.length) parts.push(...imgPart({ d: cs.map((c) => ringPts(c.cell, lym ? 1.2 : 1.7)).join(""), fill: mk }));
  }
  parts.push(...imgPart({ d: F.vessels.map(cd31Ring).join(""), fill: TYPES.endo.mk }));
  return parts;
}

/** Segmentation mask coloured by phenotype (cell-type map): flat data marks, a fine darker edge per cell. */
function phenoParts({ bg = "#f3f5f8" } = {}) {
  const F = field();
  const parts = [{ d: tileD(), fill: bg, stroke: { color: shade(bg, 0.12), width: 1 }, lineWidth: 1.4 }];
  const by = {};
  for (const c of F.cells) (by[c.type] = by[c.type] || []).push(c);
  for (const t of ["other", "fib", "endo", "liningFLS", "mac", "T", "B"]) {
    const cs = by[t] || [], col = TYPES[t].ph, edge = shade(col, 0.15);
    if (cs.length) parts.push({ d: cs.map((c) => polyD(c.cell)).join(""), fill: col, stroke: { color: edge, width: 0.5 }, lineColor: edge, lineWidth: 0.5 });
  }
  return parts;
}

const CN_COL = ["#f6cce6", "#d3eabd", "#fbdcb4", "#cfe0f4"];
/** Cellular neighbourhoods: CN regions (merged Voronoi cells), the spatial graph and typed nodes (flat data marks). */
function neighbourhoodParts({ bg = "#f7f9fb" } = {}) {
  const F = field();
  const frame = shade(bg, 0.14);
  const parts = [{ d: tileD(), fill: bg, lineColor: bg, lineWidth: 0.01 }];
  const inTile = (c) => c.p[0] > 14 && c.p[0] < 186 && c.p[1] > 14 && c.p[1] < 186;
  // neighbourhood regions: the Voronoi cell of every seed, clipped to the rounded tile itself, so they
  // tile the field edge to edge; no outlines of their own (line style draws only the borders between them)
  const clip = rrPts(10, 10, 180, 180, 5, 8);
  const vs = F.seeds.map((s) => ({ s, poly: clipConvex(s.vor, clip) })).filter((v) => v.poly.length > 2);
  for (let k = 0; k < 4; k++) {
    const ks = vs.filter((v) => v.s.cn === k);
    if (ks.length) parts.push({ unite: ks.map((v) => polyD(v.poly)), fill: CN_COL[k], lineColor: CN_COL[k], lineWidth: 0.01 });
  }
  const borders = [];
  for (const { s, poly } of vs) poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const o = F.seeds.reduce((best, q) => (q !== s && dist(q.p, m) < dist(best.p, m) ? q : best), F.seeds[F.seeds[0] === s ? 1 : 0]);
    if (o.cn !== s.cn && s.cn < o.cn && Math.abs(dist(o.p, m) - dist(s.p, m)) < 0.3) borders.push(polyline([a, b]));
  });
  parts.push({ d: borders.join(""), fill: "none", stroke: { color: "#9aa8b6", width: 0.8, cap: "round" }, soft: false, lineColor: "#8d9aa8", lineStrokeWidth: 0.8 });
  // joint space (above the lining, inside the rounded frame) and vessel lumens are not tissue
  const top = [];
  for (let x = 10; x <= 190.01; x += 3) top.push([x, F.surf(x) - 1]);
  const corner = (cx, cy, a0, a1) => Array.from({ length: 7 }, (_, j) => { const a = (a0 + ((a1 - a0) * j) / 6) * DEG; return [cx + Math.cos(a) * 5, cy + Math.sin(a) * 5]; });
  parts.push({ d: polyD([...top, ...corner(185, 15, 0, -90), ...corner(15, 15, -90, -180)]), fill: bg, lineColor: bg, lineWidth: 0.01 });
  parts.push({ d: smoothOpen(top), fill: "none", stroke: { color: "#9aa8b6", width: 0.8, cap: "round" }, soft: false, lineColor: "#8d9aa8", lineStrokeWidth: 0.8 });
  parts.push({ d: F.vessels.map((v) => polyD(v.lumen)).join(""), fill: bg, lineWidth: 0.8, thin: true });
  parts.push({ d: tileD(), fill: "none", stroke: { color: frame, width: 1 }, lineStrokeWidth: 1.4 });
  parts.push({ d: F.edges.filter(([i, j]) => inTile(F.cells[i]) && inTile(F.cells[j])).map(([i, j]) => polyline([F.cells[i].p, F.cells[j].p])).join(""), fill: "none", stroke: { color: "#8d9aa8", width: 1.1, cap: "round" }, lineColor: "#8d9aa8", lineStrokeWidth: 0.9 });
  const by = {};
  for (const c of F.cells.filter(inTile)) (by[c.type] = by[c.type] || []).push(c);
  // nodes: flat discs in the phenotype colours; endothelial nodes are rounded squares (a shape cue, not only hue)
  for (const t of ["other", "fib", "endo", "liningFLS", "mac", "T", "B"]) {
    const cs = by[t] || [], col = TYPES[t].ph;
    const mark = t === "endo" ? (c) => rect(c.p[0] - 3.6, c.p[1] - 3.6, 7.2, 7.2, 1.8) : (c) => circle(c.p[0], c.p[1], 3.6);
    if (cs.length) parts.push({ d: cs.map(mark).join(""), fill: col, lineColor: shade(col, 0.3), lineWidth: 0.6 });
  }
  // one index cell with its neighbourhood window
  const idx = F.cells.reduce((b, c) => (dist(c.p, [104, 96]) < dist(b.p, [104, 96]) ? c : b));
  parts.push({ d: circle(idx.p[0], idx.p[1], 25), fill: "none", stroke: { color: "#3d4a5a", width: 1.5, dash: [4, 3], cap: "round" } });
  parts.push({ d: circle(idx.p[0], idx.p[1], 4.6), fill: "#3d4a5a", lineWidth: 0.6 });
  return parts;
}

/* ---------------- small shared helpers ---------------- */

/** Convex hull (monotone chain). */
function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** Points round a rounded rectangle. */
function rrPts(x, y, w, h, r, n = 6) {
  const out = [];
  for (const [cx, cy, a0] of [[x + w - r, y + r, -90], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90], [x + r, y + r, 180]])
    for (let k = 0; k <= n; k++) { const a = (a0 + (90 * k) / n) * DEG; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return out;
}
const dropY = (pts, k) => pts.map(([x, y]) => [x, y + k]);
/** A gaussian peak standing on baseline y0. */
function peakD(x0, y0, hgt, sd) {
  const pts = [];
  for (let k = -3.2; k <= 3.2001; k += 0.4) pts.push([x0 + k * sd, y0 - hgt * Math.exp(-(k * k) / 2)]);
  return polyD([[x0 - 3.2 * sd, y0], ...pts, [x0 + 3.2 * sd, y0]]);
}
/** UV light flash (lightning bolt) centred at (x, y). */
function boltD(x, y, s = 1) {
  return roundPoly([[2, -11], [7, -11], [3, -2], [8, -2], [-4, 12], [-1, 2], [-6, 2]].map(([px, py]) => [x + px * s, y + py * s]), 0.8 * s);
}
const METALS = [TYPES.liningFLS.ph, TYPES.mac.ph, TYPES.T.ph, TYPES.fib.ph, TYPES.endo.ph]; // metal channels (as the phenotypes)
// per-assay colours for the readouts: chart colours that no DNA strand (teal, yellow, violet) or the polymerase (green) uses
const ASSAY = ["#4e8fd6", "#e2606a", "#ec8fc0", "#d9b43a"];

/* ---------------- 96-well plate ---------------- */

/**
 * SBS 96-well plate (127.8 × 85.5 mm, 9 mm pitch, 14.4 mm tall; row A at the back, A1 back left) in an
 * orthographic 3/4 view: turned ~15° so the right end is nearer, seen from ~30° above. Visible faces:
 * the flat top, the front long wall and the right short wall, with the foot skirt stepping out at the
 * bottom. (x, y) is the front-left top corner; ~1.3 px per mm, ~195 × 96 px overall.
 */
/** rrPts with the corner at (x, y + h) cut off at 45° (ch long on each side) instead of rounded. */
function rrPtsCut(x, y, w, h, r, ch, n = 6) {
  const pts = rrPts(x, y, w, h, r, n);
  return [...pts.slice(0, 2 * (n + 1)), [x + ch, y + h], [x, y + h - ch], ...pts.slice(3 * (n + 1))];
}
function plateParts({ liquid = "#f2d27a", x = 4, y = 58 } = {}) {
  const U = [1.26, 0.17], V = [0.34, -0.63], H = 18, Lx = 127.8, Ly = 85.5, rc = 4;
  const M = ([a, b]) => [x + U[0] * a + V[0] * b, y + U[1] * a + V[1] * b];
  const Md = (d, dy = 0) => mapPath(d, (p) => { const q = M(p); return [q[0], q[1] + dy]; });
  // the A1 corner (back left) is chamfered, as on the ANSI/SLAS footprint drawing
  const ch = 6;
  const topMm = rrPtsCut(0, 0, Lx, Ly, rc, ch);
  const top = topMm.map(M);
  const foot = rrPtsCut(-1.6, -1.6, Lx + 3.2, Ly + 3.2, rc + 1.6, ch + 1.33).map(M);
  const parts = [];
  // foot skirt, then the walls (straight down)
  parts.push({ d: polyD(hull([...dropY(foot, H - 4.2), ...dropY(foot, H)])), fill: "#afc2d2", shade: "rim", gloss: false, highlight: false, thin: true });
  parts.push({ d: polyD(hull([...top, ...dropY(top, H - 3.6)])), fill: "#c4d5e2", shade: "rim", gloss: false, highlight: false });
  // the right short wall faces away from the light: a soft shadow on it (soft) / an edge line (line)
  const right = topMm.filter(([a]) => a >= Lx - 1.3).map(M);
  parts.push(dim(polyD(hull([...right, ...dropY(right, H - 3.6)])), 0.1));
  const corner = M([Lx - rc + rc * Math.cos(-45 * DEG), rc + rc * Math.sin(-45 * DEG)]);
  parts.push({ d: polyline([corner, [corner[0], corner[1] + H - 3.6]]), fill: "none", stroke: { color: shade(COL.plasticD, 0.4), width: 1 }, lineStrokeWidth: 0.9, soft: false });
  // flat top face, a thin light strip along its back and left edges
  parts.push({ d: polyD(top), fill: COL.plastic });
  const strip = (w) => [[Lx - rc - 6, Ly - w], [ch + w * 0.414, Ly - w], [w, Ly - ch - w * 0.414], [w, rc + 6]];
  const outer = strip(0.15), inner = strip(2.2);
  parts.push(glow(polyD([...outer, ...inner.reverse()].map(M)), 0.75));
  // deep wells: through each opening we see the shaded back wall (upper ~40%) above the sample's
  // surface (the lower part) — the opening outline shifted down, clipped to the opening
  const wells = [], liq = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 12; c++) {
    const a = 14.38 + 9 * c, b = Ly - 11.24 - 9 * r;
    const op = circPts(a, b, 3.4, 24).map(M);
    if (signedArea(op) < 0) op.reverse();
    const ys = op.map((p) => p[1]), hgt = Math.max(...ys) - Math.min(...ys);
    wells.push(polyD(op));
    liq.push(polyD(clipConvex(op.map(([px, py]) => [px, py + 0.42 * hgt]), op)));
  }
  parts.push({ d: wells.join(""), fill: "#9fb0c0", lineWidth: 0.6 });
  parts.push({ d: liq.join(""), fill: liquid, shade: "rim", gloss: false, highlight: false, lineWidth: 0.45 });
  return parts;
}

/* ---------------- imaging mass cytometry: laser ablation ---------------- */

/**
 * A stained section on a slide (oblique view); a UV laser focused through an objective ablates it
 * pixel by pixel along raster rows; each shot's plume is swept by the helium stream into the
 * transfer line that leads to the ICP-TOF mass cytometer. 280 × 170.
 */
function imcAblationParts() {
  const parts = [];
  const S = ([a, b]) => [16 + a + 0.5 * b, 150 - 0.42 * b];
  const SL = (d) => mapPath(d, S);
  // glass slide and the tissue section on it
  const top = [[0, 0], [204, 0], [204, 84], [0, 84]].map(S);
  // a thin glass slide: pale edge, flat top with a light strip along its back and left edges
  parts.push({ d: polyD(hull([...top, ...dropY(top, 3.6)])), fill: COL.slideEdge });
  parts.push({ d: polyD(top), fill: COL.glass });
  parts.push(glow(polyD([[1.2, 83], [199, 83], [196.5, 80.2], [3.6, 80.2], [3.6, 6], [1.2, 3.5]].map(S)), 0.8));
  parts.push({ d: SL(smoothClosed(blobPts(90, 42, 76, 34, { n: 11, wobble: 0.07, seed: 8 }))), fill: COL.tissue, stroke: { color: shade(COL.tissue, 0.1), width: 1 } });
  // cells in the section (nuclei), not in the ablated area
  const roi = [[84, 26], [126, 26], [126, 32], [138, 32], [138, 56], [84, 56]];
  const nuc = scatter(90, 42, 66, 28, 70, { seed: 5, minDist: 9.5 })
    .filter(([a, b]) => !(a > 79 && a < 143 && b > 21 && b < 61) && ((a - 90) / 70) ** 2 + ((b - 42) / 30) ** 2 < 0.92)
    .map(([a, b], i) => SL(ellipse(a, b, 3.4, 2.6, (i * 47) % 180)));
  parts.push({ d: nuc.join(""), fill: "#c98fb4", shade: "small", lineWidth: 0.55 });
  // ablated raster: rows done at the back, the current row half done (exposed glass)
  parts.push({ d: SL(polyD(roi)), fill: COL.glass, lineWidth: 0.9 });
  const grid = [];
  for (let a = 90; a < 138; a += 6) grid.push(polyline([S([a, a < 126 ? 26 : 32]), S([a, 56])]));
  for (let b = 32; b < 56; b += 6) grid.push(polyline([S([84, b]), S([138, b])]));
  parts.push({ d: grid.join(""), fill: "none", stroke: { color: "#a9c6dc", width: 0.7, cap: "butt" }, lineStrokeWidth: 0.55 });
  // cut faces of the section (its thickness) on the pit's back and left walls, the walls we look onto
  {
    const t = 1.5, dn = (p) => [p[0], p[1] + t];
    const bl = S([84, 56]), br = S([138, 56]), fl = S([84, 26]);
    parts.push({ d: polyD([bl, br, dn(br), dn(bl)]) + polyD([fl, bl, dn(bl), dn(fl)]), fill: "#d98ea4", lineWidth: 0.4 });
  }
  const spot = S([123, 29]);
  // helium stream flowing just above the section (not painted on it), past the spot, into the funnel
  parts.push({ ...arrowPart([
    ...curvedArrowD(spine([[98, 125], [120, 123], [141, 119.5]], 0.8), 2.2, 2.4),
    ...curvedArrowD(spine([[106, 116.5], [126, 114.5], [144, 111]], 0.8), 2.2, 2.4),
  ], "#a9d3ef"), opacity: 0.7 });
  // transfer line: a funnel above the spot, then the tube off to the mass cytometer
  const mouth = [178, 114];
  const tube = spine([[185, 104], [194, 94], [210, 87], [234, 84], [252, 84]], 1);
  parts.push({ unite: [polyD(hull([[mouth[0] - 13, mouth[1] - 3.6], [mouth[0] + 7, mouth[1] + 10], [190.5, 106.5], [181, 99]])), tubeD(tube, 12, { cap1: true })], fill: "#d3e2ee", shade: "organelle", gloss: false, opacity: 0.92 });
  parts.push(...tubeStripes([subLine(tube, 0.06, 0.98)], 12, { hi: 0.5, lo: 0.1 }));
  // the plume: an aerosol cloud of overlapping translucent puffs, small at the spot and widening as the
  // helium carries it up into the funnel, with the metal-carrying particles inside it
  const plume = spine([[spot[0], spot[1] - 2.5], [158.5, 129], [168, 121], [mouth[0] + 1, mouth[1] + 2]], 1);
  const R = rng(14);
  const puffs = [[0.06, 3.2], [0.27, 4.9], [0.48, 6.4], [0.7, 7.8], [0.92, 9]].map(([u, r], i) => {
    const p = subLine(plume, 0, u).at(-1);
    return { c: [p[0] + (i % 2 ? 0.8 : -0.6), p[1] + (i % 2 ? -0.7 : 0.5)], r };
  });
  const puffD = puffs.map((q, i) => blob(q.c[0], q.c[1], q.r, q.r * 0.9, { n: 7, wobble: 0.08, seed: 40 + i }));
  for (const d of puffD) parts.push({ d, fill: "#ddd0f6", opacity: 0.62, line: false });
  // line style: the cloud as one flat translucent shape with a faint dashed edge (a diffuse aerosol, not an object)
  parts.push({ unite: puffD, fill: "#ece4fa", opacity: 0.75, soft: false, lineColor: "#ece4fa", lineWidth: 0.01 });
  parts.push({ unite: puffD, fill: "none", stroke: { color: "#a891d6", width: 0.5, dash: [1.6, 1.4], cap: "butt" }, soft: false, lineColor: "#a891d6", lineStrokeWidth: 0.5 });
  const dots = METALS.map(() => []);
  let di = 0;
  for (const q of puffs) {
    const n = Math.round(q.r / 2.1);
    for (const [px, py] of scatter(q.c[0], q.c[1], q.r * 0.62, q.r * 0.55, n, { seed: 60 + di, minDist: 3 })) dots[di++ % 5].push(circle(px, py, 1.3 + R() * 0.6));
  }
  const tl = resample(subLine(tube, 0.12, 0.93), 6.5);
  tl.forEach((p, i) => dots[(i + 2) % 5].push(circle(p[0] + (R() - 0.5) * 2, p[1] + (R() - 0.5) * 4.5, 1.6 + R() * 0.5)));
  dots.forEach((ds, k) => parts.push({ d: ds.join(""), fill: METALS[k], shade: "small", lineWidth: 0.5 }));
  parts.push(arrowPart(arrowD(256, 276, 84, 7, 2)));
  // UV laser through the objective onto the spot
  const ox = spot[0];
  parts.push({ d: polyD([[ox - 4, 58], [ox + 4, 58], [ox + 1.3, spot[1]], [ox - 1.3, spot[1]]]), fill: COL.laser, opacity: 0.32, lineColor: COL.laser, lineWidth: 0.01 });
  parts.push({ d: polyD([[ox - 1.6, 58], [ox + 1.6, 58], [ox + 0.5, spot[1]], [ox - 0.5, spot[1]]]), fill: "#a98af7", opacity: 0.9, lineColor: "#7a55e0", lineWidth: 0.5 });
  parts.push({ d: ellipse(spot[0], spot[1], 7, 3.6), fill: "#c9b2ff", opacity: 0.55, line: false });
  parts.push({ d: ellipse(spot[0], spot[1], 3, 1.5), fill: "#f1e9ff", line: false });
  parts.push(...objectiveParts([ox, 58], [0, 1], 1.05));
  return parts;
}

/* ---------------- mass cytometer: ICP ionisation and time-of-flight ---------------- */

/**
 * Schematic CyTOF / Helios: sample (cells or ablation plumes) into the argon ICP torch where it is
 * atomised and ionised; sampler and skimmer cones; an RF quadrupole that throws out light ions;
 * the time-of-flight chamber (pusher → packets separated by mass → detector); the mass spectrum
 * with one peak per metal channel. 300 × 160.
 */
function massCytometerParts() {
  const parts = [];
  const cy = 60;
  const R = rng(9);
  // RF load coil: three helical turns round the torch's end. Each turn is a narrow ellipse (the coil seen
  // slightly from the side) advancing one pitch along the axis: its back half runs behind the torch (drawn
  // first, so only the bits beyond the tube show), its front half crosses over the tube and the plasma.
  const coilHalf = (x0, front) => {
    const pts = [];
    for (let k = 0; k <= 24; k++) {
      const t = front ? -90 + (180 * k) / 24 : 90 + (180 * k) / 24;
      pts.push([x0 + (front ? 0 : 3.3) + (3.3 * k) / 24 + 3.4 * Math.cos(t * DEG), cy + 21.5 * Math.sin(t * DEG)]);
    }
    return pts;
  };
  const turns = [55.5, 62.1, 68.7];
  const coilBack = turns.map((x) => coilHalf(x, false)), coilFront = turns.map((x) => coilHalf(x, true));
  const backD = coilBack.map((c) => tubeD(c, 3, { cap0: true, cap1: true })).join("");
  parts.push({ d: backD, fill: "#d98c4f", thin: true }, dim(backD, 0.22));
  // torch: outer quartz tube, injector, argon plasma
  parts.push({ d: rect(14, cy - 17, 64, 34, 7), fill: COL.glass, shade: "organelle", gloss: false });
  parts.push({ d: capsule(7, cy, 62, cy, 4.4), fill: "#bcd7ea", shade: "rim", gloss: false, highlight: false, thin: true });
  parts.push({ d: smoothClosed([[60, cy], [64, cy - 12], [80, cy - 15.5], [97, cy - 12], [110, cy - 5.5], [116, cy], [110, cy + 5.5], [97, cy + 12], [80, cy + 15.5], [64, cy + 12]]), fill: "#cbb4f2", shade: "organelle", glossAt: [0.3, 0.3] });
  parts.push({ d: ellipse(84, cy, 15, 6.6), fill: "#f5efff", opacity: 0.8, line: false });
  parts.push({ unite: coilFront.map((c) => tubeD(c, 3.2, { cap0: true, cap1: true })), fill: "#d98c4f", thin: true }, strandRim(coilFront, 3.2));
  // sample entering (cells / plumes), atomised and ionised in the plasma
  const dots = METALS.map(() => []), light = [];
  for (let i = 0; i < 6; i++) dots[i % 5].push(circle(12 + i * 7.6, cy + (R() - 0.5) * 3, 1.5));
  // interface cones (sampler, skimmer)
  const cone = (tx, x1, hh, th) => {
    const up = roundPoly([[tx, cy - 2.1], [x1, cy - hh], [x1 + th, cy - hh], [x1 + th, cy - hh + th * 1.4], [tx + th, cy - 2.1]], 0.9);
    return up + mapPath(up, ([px, py]) => [px, 2 * cy - py]);
  };
  parts.push({ d: cone(115, 126, 25, 5) + cone(131, 140, 17, 4), fill: "#a5b1be", shade: "rim", gloss: false, highlight: false });
  // RF quadrupole: low-mass ions are thrown out, heavy (metal) ions pass
  for (let i = 0; i < 7; i++) light.push(circle(152 + i * 4.4, cy - 3 - i * i * 0.9, 1.3));
  for (let i = 0; i < 6; i++) light.push(circle(154 + i * 4.4, cy + 3 + i * i * 0.95, 1.3));
  parts.push({ d: light.join(""), fill: "#b8c3cf", opacity: 0.85, shade: "small", lineWidth: 0.45 });
  parts.push({ d: [capsule(152, cy - 13, 194, cy - 13, 4.8), capsule(152, cy + 13, 194, cy + 13, 4.8)].join(""), fill: "#b7c2ce", shade: "organelle", gloss: false });
  for (let i = 0; i < 18; i++) {
    const x = 120 + i * 7.6, yy = cy + (R() - 0.5) * 2.4;
    if (x < 199 || x > 211) dots[i % 5].push(circle(x, yy, 1.7)); // none inside the chamber wall
  }
  // orthogonal-acceleration TOF: a metal vacuum chamber. The beam enters through a slit in its left
  // wall just above the pusher plate, which pushes ion packets upward; they separate by mass on the
  // way to the detector (a microchannel plate) at the top.
  const cX = 204, cY = 4, Wc = 88, Hc = 70, rc = 8, t = 3, s0 = cy - 3.6, s1 = cy + 3.6;
  const wallC = "#b7c3cf";
  parts.push({ d: rect(cX + t, cY + t, Wc - 2 * t, Hc - 2 * t, rc - t), fill: "#eef2f6", lineColor: "#eef2f6", lineWidth: 0.01 });
  const O = rrPts(cX, cY, Wc, Hc, rc, 6), I = rrPts(cX + t, cY + t, Wc - 2 * t, Hc - 2 * t, rc - t, 6);
  const corner = (A, k) => A.slice(k * 7, k * 7 + 7);
  const wall = [[cX, s0], ...corner(O, 3), ...corner(O, 0), ...corner(O, 1), ...corner(O, 2), [cX, s1],
    [cX + t, s1], ...corner(I, 2).reverse(), ...corner(I, 1).reverse(), ...corner(I, 0).reverse(), ...corner(I, 3).reverse(), [cX + t, s0]];
  parts.push({ d: polyD(wall), fill: wallC, lineWidth: 1.1 });
  // metal shading (soft): a darker rim on the outer bottom/right, a light edge on the outer top/left (not across the slit)
  parts.push({ d: edgeBand(cX, cY, Wc, Hc, rc, 1.3), fill: shade(wallC, 0.14), line: false });
  parts.push(glow(edgeBand(cX, cY, Wc, Hc, rc, 1.1, { flip: true, from: 24 }), 0.8));
  // pusher plate, with an arrow for the push
  parts.push({ d: rect(214, cy + 5, 70, 3.4, 1.5), fill: "#7d8b9b", shade: "small", thin: true });
  parts.push(arrowPart(curvedArrowD(spine([[278, 62.5], [278, 47]], 0.6), 2.8, 2.3), "#9fb2c6"));
  // detector: microchannel plate (dark) with its channels
  parts.push({ d: rect(214, 9.4, 68, 6.2, 1.6), fill: "#56657a", shade: "small", thin: true });
  parts.push({ d: [222, 235, 248, 261, 274].map((x) => rect(x - 0.7, 10.6, 1.4, 3.8, 0.6)).join(""), fill: "#aebdcc", lineWidth: 0.4 });
  // packets as rows: light ions fly fastest (nearest the detector), heavy ones lag (nearest the pusher)
  const packs = [[cy - 12, 0, 3.2, 4], [cy - 25, 1, 2.8, 4.5], [cy - 38, 2, 2.4, 5]]; // y, colour, ion radius, streak length
  const pk = [TYPES.liningFLS.ph, TYPES.mac.ph, TYPES.T.ph];
  const speed = [];
  const pd = pk.map(() => []);
  packs.forEach(([y, k, r, L], row) => {
    // rows staggered by half a spacing so they read as separate packets, not as columns; two faint
    // speed lines trail each packet (the push arrow already gives the direction)
    for (let j = 0; j < 5; j++) {
      const x = 223 + (row % 2) * 4.5 + j * 9, yy = y + (j % 2 ? 0.8 : -0.8);
      pd[k].push(circle(x, yy, r));
      if (j === 1 + (row % 2) || j === 3 + (row % 2)) speed.push(capsule(x, yy + r + 1.6, x, yy + r + 1.6 + L, 0.3));
    }
  });
  parts.push({ d: speed.join(""), fill: "#b3bfcc", opacity: 0.85, lineColor: "#b3bfcc", lineWidth: 0.01 });
  dots.forEach((ds, k) => parts.push({ d: ds.join(""), fill: METALS[k], shade: "small", lineWidth: 0.5 }));
  pd.forEach((ds, k) => parts.push({ d: ds.join(""), fill: pk[k], shade: "small", lineWidth: 0.6 }));
  // mass spectrum: one peak per metal channel (m/z 139–176), three matching the packets
  const X = (m) => 34 + (m - 139) * 6.2, y0 = 150;
  const grey = [[142, 18], [143, 10], [145, 26], [147, 14], [148, 22], [150, 12], [152, 30], [154, 8], [155, 20], [158, 16], [162, 24], [164, 10], [166, 18], [168, 12], [170, 26], [172, 9], [174, 14]];
  parts.push({ d: grey.map(([m, h]) => peakD(X(m), y0, h, 1.25)).join(""), fill: "#b9c3ce", lineWidth: 0.5 });
  [[141, 34, 2], [159, 28, 1], [175, 42, 0]].forEach(([m, h, k]) => parts.push({ d: peakD(X(m), y0, h, 1.35), fill: pk[k], lineWidth: 0.6 }));
  parts.push({ d: polyline([[24, 100], [24, y0], [276, y0]]), fill: "none", stroke: { color: COL.axis, width: 1.6, cap: "round" }, lineStrokeWidth: 1.4 });
  parts.push(arrowPart(curvedArrowD(spine([[285, 80], [285, 100]], 0.6), 4.6, 2.2)));
  return parts;
}

/* ---------------- Olink readouts ---------------- */

/** qPCR amplification plot (Olink Target / Flex on Biomark-type qPCR) in a panel. */
function qpcrParts(x, y, w, h, { frame = true } = {}) {
  const parts = frame ? panel(x, y, w, h, 7, "#f2f5f9", { bw: 2.4, hw: 2, light: 0.7 }) : [];
  const x0 = x + 15, y0 = y + h - 15, x1 = x + w - 10, y1 = y + 13;
  const yt = y0 - (y0 - y1) * 0.3;
  parts.push({ d: polyline([[x0 + 3, yt], [x1, yt]]), fill: "none", stroke: { color: "#8d9aa8", width: 1.3, dash: [4, 3], cap: "butt" }, lineStrokeWidth: 1.1 });
  ASSAY.forEach((col, i) => {
    const c = x0 + (x1 - x0) * (0.3 + i * 0.105), A = (y0 - y1) * (0.86 - (i % 3) * 0.09), k = (x1 - x0) * 0.05;
    const pts = [];
    for (let t = x0 + 3; t <= x1 + 0.01; t += 2) pts.push([t, y0 - 3 - A / (1 + Math.exp(-(t - c) / k))]);
    parts.push({ d: smoothOpen(pts), fill: "none", stroke: { color: col, width: 2.6, cap: "round" }, lineColor: shade(col, 0.12), lineStrokeWidth: 2.2 });
  });
  parts.push({ d: polyline([[x0, y1], [x0, y0], [x1, y0]]), fill: "none", stroke: { color: COL.axis, width: 1.6, cap: "round" }, lineStrokeWidth: 1.4 });
  return parts;
}

/** NGS readout (Olink Explore / Reveal): reads = sample index + assay barcode, counted per assay. */
function ngsParts(x, y, w, h, { frame = true } = {}) {
  const parts = frame ? panel(x, y, w, h, 7, "#f2f5f9", { bw: 2.4, hw: 2, light: 0.7 }) : [];
  const order = [0, 1, 0, 2, 1, 0];
  const rx0 = x + 11, rw = w * 0.38, rh = 8, gap = (h - 26 - rh) / 5;
  const idx = [], per = [[], [], []];
  order.forEach((k, i) => {
    const yy = y + 13 + i * gap;
    per[k].push(rect(rx0 + rw * 0.27, yy, rw * 0.73, rh, rh / 2));
    idx.push(rect(rx0, yy, rw * 0.33, rh, rh / 2));
  });
  const ax = rx0 + rw + 5;
  parts.push(arrowPart(arrowD(ax, ax + 13, y + h / 2, 5.5, 2)));
  const bx0 = ax + 20, bx1 = x + w - 9, by0 = y + h - 13, by1 = y + 13;
  const bw = (bx1 - bx0 - 6) / 3 - 3;
  [3, 2, 1].forEach((n, k) => {
    const bh = ((by0 - by1 - 2) * n) / 3;
    per[k].push(rect(bx0 + 5 + k * (bw + 3), by0 - bh, bw, bh + 0.8, 1.4));
  });
  // flat chart marks (a shaded rim would swallow the narrow count bars): one part per assay = its reads + its bar
  per.forEach((ds, k) => parts.push({ d: ds.join(""), fill: ASSAY[k], thin: true }));
  parts.push({ d: idx.join(""), fill: "#b9c3ce", thin: true });
  parts.push({ d: polyline([[bx0, by1], [bx0, by0], [bx1, by0]]), fill: "none", stroke: { color: COL.axis, width: 1.6, cap: "round" }, lineStrokeWidth: 1.4 });
  return parts;
}

/* ---------------- SomaScan workflow ---------------- */

/** The SOMAmer reagent on the beads: the same fold as the single somamer-aptamer icon, a little smaller protein and bolder strands. */
const GLYPH = { pr: 46, w: 6.2, body: false };
const GSC = 0.28; // glyph scale on the beads (fold units → bead units)
const PTAGS = [-90, -160, -18]; // NHS-biotin tags on each protein: −90 (far from the SOMAmer) bridges to catch 2
/** An eluted (unfolded) SOMAmer: single strand with bases, modified bases and its 5' Cy3, local from (0,0). */
function somaFree(pts, { cy3 = true, side = 1 } = {}) {
  const c = spine(pts, 0.9);
  const tt = teeth(c, { from: 0.06, to: 0.97, side, pitch: 5.2, len: 3.4, w: 2 });
  const out = [{ unite: [tubeD(c, 3.4, { cap0: true, cap1: true }), ...tt], fill: COL.apt, thin: true }, { d: rimStrip(c, 3.4), fill: SHADOW, opacity: 0.3, line: false }];
  out.push({ d: tt.tips.filter((_, i) => i % 3 === 1).map(([x, y, nx, ny]) => circle(x + nx, y + ny, 2.4)).join(""), fill: COL.mod, shade: "small", thin: true });
  if (cy3) {
    const a = c[0], b = c[4];
    const u = [(a[0] - b[0]) / (dist(a, b) || 1), (a[1] - b[1]) / (dist(a, b) || 1)];
    out.push({ d: star(a[0] + u[0] * 5.6, a[1] + u[1] * 5.6, 5, 2.5, 5, -10), fill: COL.cy3, shade: "small", thin: true });
  }
  return out;
}
/** Streptavidin bead (local centre 0,0, radius R) with streptavidin at the given angles. */
function beadParts(R, angles, fill = COL.bead) {
  return [
    { d: circle(0, 0, R), fill, shade: "body", glossAt: [0.3, 0.26] },
    { d: angles.map((a) => circle(Math.cos(a * DEG) * (R - 0.5), Math.sin(a * DEG) * (R - 0.5), 4.6)).join(""), fill: COL.strept, shade: "small", thin: true },
  ];
}
/** Placement putting local point `at` of a glyph onto world point q, with local up turned to direction dir (unit). */
function glyphAt(q, dir, s, at = [0, 0]) {
  const rot = Math.atan2(dir[0], -dir[1]) / DEG;
  const t0 = place({ s, rot });
  const p = t0.P(at);
  return place({ x: q[0] - p[0], y: q[1] - p[1], s, rot });
}
const ANG = [-126, -90, -54], ANG2 = [-140, -90, -40];
const SOMA_PROT = [COL.protein, COL.protein2, COL.protein3];
/** Thin outlines (line style) for the strand-sized parts of the small bead glyphs, so the strands keep their colour. */
const FINE = [COL.apt, COL.mod, COL.cy3, COL.pcl, COL.biotin];
const fineLines = (parts, lw = 0.72) => parts.map((p) => (FINE.includes(p.fill) ? { ...p, lineWidth: lw } : p));
/**
 * Merge glyphs built alike (same part list) into one part per kind, so a step has one strand part,
 * one Cy3 part…; parts at indices in `keep` (the differently coloured proteins) stay separate.
 */
function mergeGlyphs(gl, keep = []) {
  const out = [];
  const n = Math.max(...gl.map((g) => g.length));
  for (let k = 0; k < n; k++) {
    const ps = gl.map((g) => g[k]).filter(Boolean);
    if (!ps.length) continue;
    if (keep.includes(k)) { out.push(...ps); continue; }
    const q = { ...ps[0] };
    if (ps[0].unite) q.unite = ps.flatMap((p) => p.unite);
    else q.d = ps.map((p) => [].concat(p.d).join("")).join("");
    out.push(q);
  }
  return out;
}
const R1 = 26, R2 = 22; // catch-1 (streptavidin agarose) and catch-2 (streptavidin magnetic) beads
const dirOf = (a) => [Math.cos(a * DEG), Math.sin(a * DEG)];
/** Step 1 — bind: SOMAmers on a streptavidin bead (catch 1) bind their proteins. */
function somaBindParts() {
  const gl = ANG.map((a, i) => {
    const d = dirOf(a), F = somaFold({ ...GLYPH, protein: SOMA_PROT[i], seed: 11 + i });
    return xform(foldParts(F), glyphAt([d[0] * (R1 + 2.6), d[1] * (R1 + 2.6)], d, GSC, F.biotinAt));
  });
  return [...beadParts(R1, ANG), ...fineLines(mergeGlyphs(gl, [2]))];
}
/** Step 2 placement: the complex after photocleavage (Cy3 kept, PC linker and 5' biotin gone), recaptured by the protein's biotin. */
function captured(i) {
  const a = ANG2[i], d = dirOf(a);
  const F = somaFold({ ...GLYPH, protein: SOMA_PROT[i], seed: 11 + i, tags: false, ptags: PTAGS });
  return { F, t: glyphAt([d[0] * (R2 + 2.4), d[1] * (R2 + 2.4)], [-d[0], -d[1]], GSC, F.tagTip(-90)) };
}
/** Step 2 — capture: proteins biotinylated, complexes photocleaved off and re-captured on a catch-2 bead by the protein's biotin. */
function somaCaptureParts() {
  const gl = ANG2.map((_, i) => { const { F, t } = captured(i); return xform(foldParts(F), t); });
  return [...beadParts(R2, ANG2, COL.bead2), ...fineLines(mergeGlyphs(gl, [2]))];
}
/**
 * A released SOMAmer's random coil (local, starting at the 5' end at the origin): a seeded walk of
 * `n` uneven steps whose heading wanders ±35° about `rot` (degrees from straight up); `curl` ends it in
 * a small residual hairpin turn.
 */
function coilPts(seed, { n = 5, step = 11, rot = 0, curl = 0 } = {}) {
  const R = rng(seed);
  const base = -90 + rot;
  let a = base + (R() - 0.5) * 40, p = [0, 0];
  const pts = [p];
  for (let i = 0; i < n; i++) {
    a = base + Math.max(-35, Math.min(35, a - base + (R() - 0.5) * 75));
    p = add2(p, dirOf(a), step * (0.8 + R() * 0.4));
    pts.push(p);
  }
  for (let k = 0; k < curl; k++) {
    a += 62 * Math.sign(curl || 1);
    p = add2(p, dirOf(a), 5.2);
    pts.push(p);
  }
  return pts;
}
/** Step 3 — wash and release: SOMAmers eluted from their proteins (which stay on the catch-2 bead). */
function somaReleaseParts() {
  const gl = ANG2.map((_, i) => { const { F, t } = captured(i); return xform([F.protein, F.ptags], t); });
  // the three eluted SOMAmers float off above the bead, unfolded — each its own random coil (lengths
  // ±20%, tilts −20…+35°, one keeping a small hairpin); Cy3 at the 5' end
  const free = [
    { at: [-34, -82], seed: 5, n: 4, rot: -20 },
    { at: [-2, -110], seed: 12, n: 5, rot: 28, curl: 3 },
    { at: [30, -84], seed: 21, n: 5, rot: 35 },
  ].map((o) => xform(somaFree(coilPts(o.seed, o)), place({ x: o.at[0], y: o.at[1], s: 0.62 })));
  return [...beadParts(R2, ANG2, COL.bead2), ...fineLines(mergeGlyphs(gl, [0])), ...fineLines(mergeGlyphs(free))];
}
/**
 * Step 4 — hybridise: eluted SOMAmers pair with complementary capture probes on the array — three
 * duplexes (bases of probe and SOMAmer meeting halfway) and one empty probe whose protein was absent.
 */
function somaHybParts() {
  const parts = [...panel(0, 92, 100, 11, 3, COL.glass, { bw: 1.6, hw: 1.2, light: 0.7 })];
  const xs = [8, 32, 56, 80], gap = 7.8, probe = [], apt = [], aptRim = [], mods = [], cy = [];
  const ys = [];
  for (let y = 88; y > 36.5; y -= 5.2) ys.push(y); // base-pair rows
  xs.forEach((x, i) => {
    probe.push(...segTube(spine([[x, 92], [x, 32]], 1), 3.4, { cap0: false, piece: 9 }));
    for (const y of ys) probe.push(capsule(x, y, x + 3.2, y, 1)); // probe bases point right, to its SOMAmer
    if (i === 2) return; // empty probe
    const ax = x + gap;
    const ac = spine([[ax, 34], [ax, 90]], 1);
    apt.push(tubeD(ac, 3.4, { cap0: true, cap1: true }));
    aptRim.push(rimStrip(ac, 3.4));
    ys.forEach((y, j) => {
      apt.push(capsule(ax, y, ax - 3.2, y, 1)); // SOMAmer bases point left: the tips meet halfway
      if (j % 3 === 1) mods.push(circle(ax + 3.3, y, 2.2)); // modified-base side chains, outer side
    });
    cy.push(star(ax, 28.4, 5.2, 2.6, 5, -10));
  });
  parts.push({ unite: probe, fill: "#b7c3cf", shade: "rim", gloss: false, highlight: false, thin: true });
  parts.push({ unite: apt, fill: COL.apt, thin: true }, { d: aptRim.join(""), fill: SHADOW, opacity: 0.3, line: false });
  parts.push({ d: mods.join(""), fill: COL.mod, shade: "small", thin: true });
  parts.push({ d: cy.join(""), fill: COL.cy3, shade: "small", thin: true });
  return parts;
}
/** Step 5 — readout: the scanned array, Cy3 intensity per probe spot ∝ protein amount (RFU). */
function arrayImageParts() {
  const parts = [{ d: rect(0, 0, 60, 60, 4), fill: COL.imgBg, lineWidth: 1.2 }];
  const R = rng(31), lv = [[], [], [], []];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    const v = R();
    lv[v < 0.25 ? 0 : v < 0.5 ? 1 : v < 0.8 ? 2 : 3].push(circle(8 + c * 11, 8 + r * 11, 3.9));
  }
  [[0.16, "#6b7686"], [0.4, COL.cy3], [0.7, COL.cy3], [1, "#ffb35c"]].forEach(([op, col], k) => {
    if (lv[k].length) parts.push({ d: lv[k].join(""), fill: col, opacity: op, lineColor: col, lineWidth: 0.01 });
  });
  return parts;
}

/* ---------------- icons ---------------- */

const SPATIAL_TAGS = ["spatial proteomics", "multiplex imaging", "highly multiplexed imaging", "tissue imaging", "single-cell spatial", "spatial biology", "proteomics"];
const PC_TAGS = [...SPATIAL_TAGS, "PhenoCycler", "PhenoCycler-Fusion", "CODEX", "co-detection by indexing", "Akoya Biosciences", "Quanterix", "DNA-barcoded antibody", "oligo-conjugated antibody", "cyclic immunofluorescence", "multiplex immunofluorescence", "mIF"];
const IMC_TAGS = [...SPATIAL_TAGS, "imaging mass cytometry", "IMC", "Hyperion", "Hyperion XTi", "Standard BioTools", "Fluidigm", "mass cytometry", "CyTOF", "metal-tagged antibody", "lanthanide"];
// MIBI shares the metal-tagged antibodies and the image analysis, but uses an ion beam (no laser, no ICP torch)
const MIBI_TAGS = ["MIBI", "MIBI-TOF", "multiplexed ion beam imaging", "Ionpath"];
const OLINK_TAGS = ["Olink", "PEA", "proximity extension assay", "affinity proteomics", "plasma proteomics", "proteomics", "Olink Explore", "Explore HT", "Olink Reveal", "Olink Target 96", "Olink Flex", "Thermo Fisher", "biomarker", "NPX"];
const SOMA_TAGS = ["SomaScan", "SomaLogic", "SOMAmer", "aptamer", "slow off-rate modified aptamer", "affinity proteomics", "plasma proteomics", "proteomics", "Standard BioTools", "Illumina Protein Prep", "biomarker", "RFU"];

export const icons = [
  {
    slug: "dna-barcoded-antibody", name: "DNA-barcoded antibody (PhenoCycler / CODEX)", category: "proteins",
    tags: [...PC_TAGS, "antibody", "IgG", "barcode", "oligonucleotide", "oligo", "DNA tag", "conjugation", "maleimide", "antibody-oligo conjugate", "CITE-seq", "AbSeq"],
    scene: () => ({ size: [200, 200], parts: barcodedAbParts() }),
  },
  {
    slug: "phenocycler-reporter-hybridisation", name: "PhenoCycler reporters hybridised to barcoded antibodies in tissue", category: "methods",
    tags: [...PC_TAGS, "reporter", "fluorescent reporter", "reporter oligo", "complementary oligonucleotide", "hybridisation", "hybridization", "barcode", "fluorophore", "Atto 550", "Alexa Fluor 647", "Alexa Fluor 750", "antigen", "cell membrane", "tissue section", "staining"],
    scene: () => ({ size: [268, 168], parts: reporterHybParts() }),
  },
  {
    slug: "phenocycler-cycles", name: "PhenoCycler cycles — add reporters, image, strip; one image per cycle", category: "methods",
    tags: [...PC_TAGS, "cycle", "cyclic imaging", "iterative imaging", "reporter", "imaging", "stripping", "fluidics", "image stack", "three markers per cycle", "DAPI", "registration", "stitching", "CyCIF", "COMET"],
    scene: () => ({ size: [300, 170], parts: cyclesParts() }),
  },
  {
    slug: "metal-tagged-antibody", name: "Metal-tagged antibody (lanthanide polymer, IMC / CyTOF)", category: "proteins",
    tags: [...IMC_TAGS, ...MIBI_TAGS, "antibody", "IgG", "MaxPar", "Maxpar X8", "polymer", "DOTA", "chelator", "metal isotope", "heavy metal", "conjugation"],
    scene: () => ({ size: [200, 200], parts: metalAbParts() }),
  },
  {
    slug: "olink-pea", name: "Olink PEA — antibody pair, oligo hybridisation, extension, amplicon", category: "methods",
    tags: [...OLINK_TAGS, "antibody pair", "matched antibodies", "DNA oligo", "hybridisation", "hybridization", "DNA polymerase", "extension", "amplicon", "PCR", "DNA barcode", "proximity ligation", "PLA"],
    scene: () => {
      // the PEA scene fills the height; the amplicons share its scale (same strand width and base pitch)
      const pea = peaScene(2), amp = ampliconParts();
      const bp = boundsOf(pea), ba = boundsOf(amp), k = 146 / bp.h;
      const parts = placeParts(pea, { dx: 8 - bp.x * k, dy: 7 - bp.y * k, s: k, lw: 1.67 / k });
      const x1 = 8 + bp.w * k, xA = x1 + 30;
      parts.push(...placeParts(amp, { dx: xA - ba.x * k, dy: 80 - (ba.y + ba.h / 2) * k, s: k, lw: 1.67 / k }));
      parts.push(arrowPart(arrowD(x1 + 5, xA - 6, 80, 7, 2)));
      return { size: [Math.round(xA + ba.w * k + 8), 160], lineWidth: 1.6, parts };
    },
  },
  {
    slug: "multiplex-if-image", name: "Multiplex immunofluorescence image — DAPI and six markers (pseudocolour)", category: "charts",
    tags: [...PC_TAGS, ...MIBI_TAGS, "multiplex IF", "mIF", "multiplexed immunofluorescence", "immunofluorescence", "IF", "pseudocolour", "false colour", "composite image", "DAPI", "nuclei", "CD3", "CD20", "CD68", "CD31", "CD90", "PDPN", "CD55", "synovium", "tissue section", "microscopy", "COMET", "Lunaphore", "CyCIF", "MACSima", "Orion", "IMC image"],
    scene: () => ({ size: [200, 200], parts: mifParts() }),
  },
  {
    slug: "cell-phenotype-map", name: "Cell phenotype map — segmented cells coloured by cell type", category: "charts",
    tags: [...SPATIAL_TAGS, ...MIBI_TAGS, "phenotype map", "cell-type map", "cell segmentation", "segmentation mask", "Mesmer", "Cellpose", "StarDist", "DeepCell", "QuPath", "cell phenotyping", "clustering", "cell types", "spatial map", "PhenoCycler", "IMC", "Xenium", "CosMx"],
    scene: () => ({ size: [200, 200], parts: phenoParts() }),
  },
  {
    slug: "neighbourhood-analysis", name: "Cellular neighbourhood analysis — spatial graph and neighbourhoods", category: "charts",
    tags: [...SPATIAL_TAGS, ...MIBI_TAGS, "cellular neighbourhoods", "cellular neighborhoods", "CN", "neighbourhood analysis", "neighborhood analysis", "spatial interaction", "cell-cell interaction", "spatial graph", "Delaunay", "Gabriel graph", "k-nearest neighbours", "kNN", "window", "niche", "spatial niche", "tissue niche", "squidpy", "CytoMAP", "histoCAT", "imcRtools", "co-localisation"],
    scene: () => ({ size: [200, 200], parts: neighbourhoodParts() }),
  },
  {
    slug: "somamer-aptamer", name: "SOMAmer reagent — modified aptamer bound to its protein", category: "proteins",
    tags: [...SOMA_TAGS, "modified nucleotides", "benzyl-dU", "naphthyl-dU", "single-stranded DNA", "ssDNA", "Cy3", "photocleavable linker", "biotin", "protein binding"],
    scene: () => ({ size: [200, 200], parts: somamerIconParts() }),
  },
  {
    slug: "imc-laser-ablation", name: "Imaging mass cytometry — UV laser ablation of a stained section, plume to the mass cytometer", category: "methods",
    tags: [...IMC_TAGS, "laser ablation", "LA-ICP-MS", "UV laser", "213 nm", "ablation plume", "aerosol", "helium", "carrier gas", "transfer line", "raster", "pixel", "1 µm", "region of interest", "ROI", "tissue section", "slide", "objective", "ablation cell"],
    scene: () => ({ size: [280, 170], lineWidth: 1.5, parts: fit(imcAblationParts(), [10, 10, 270, 160], { lw: 1.5 }) }),
  },
  {
    slug: "mass-cytometer-tof", name: "Mass cytometer — ICP ionisation, ion filter, time-of-flight separation, mass spectrum", category: "methods",
    tags: [...IMC_TAGS, "Helios", "CyTOF XT", "time-of-flight", "TOF", "mass spectrometry", "ICP-MS", "ICP-TOF-MS", "inductively coupled plasma", "argon plasma", "torch", "sampler cone", "skimmer cone", "quadrupole", "ion optics", "pusher", "detector", "mass spectrum", "m/z", "isotope", "metal channel", "readout"],
    scene: () => ({ size: [300, 160], lineWidth: 1.5, parts: fit(massCytometerParts(), [8, 8, 292, 152], { lw: 1.5 }) }),
  },
  {
    slug: "plasma-sample-96-well-plate", name: "96-well plate with plasma samples", category: "lab",
    tags: ["96-well plate", "microplate", "microtiter plate", "microtitre plate", "multiwell plate", "SBS plate", "ANSI/SLAS", "plasma", "serum", "blood plasma", "EDTA plasma", "samples", "sample plate", "biobank", "cohort", "Olink", "SomaScan", "affinity proteomics", "plasma proteomics", "ELISA", "plate", "well"],
    scene: () => ({ size: [240, 128], lineWidth: 1.4, parts: fit(plateParts(), [14, 16, 226, 112]) }),
  },
  {
    slug: "olink-readout", name: "Olink readout — qPCR amplification curves or NGS barcode counts", category: "methods",
    tags: [...OLINK_TAGS, "readout", "qPCR", "real-time PCR", "amplification curve", "amplification plot", "Ct", "Cq", "threshold", "Biomark HD", "Signature Q100", "Olink Target 48", "NGS", "next-generation sequencing", "Illumina", "NovaSeq", "NextSeq", "sequencing reads", "read counts", "barcode counting", "sample index", "quantification"],
    scene: () => ({ size: [300, 140], lineWidth: 1.5, parts: [...qpcrParts(8, 8, 138, 124), ...ngsParts(154, 8, 138, 124)] }),
  },
  {
    slug: "olink-pea-workflow", name: "Olink PEA workflow — sample, antibody-pair binding, extension, amplification, readout", category: "methods",
    tags: [...OLINK_TAGS, "workflow", "overview", "pipeline", "96-well plate", "plasma", "incubation", "antibody pair", "hybridisation", "hybridization", "DNA polymerase", "extension", "PCR", "pre-amplification", "amplicon", "NGS", "sequencing", "read counts", "readout"],
    scene: () => {
      // panels 2 (pair bound, 3' ends hybridised) and 3 (polymerase extension) are the component icon's scene
      // at one scale and position, so only the new strand and the polymerase change between them; the
      // amplicons share that scale. The DNA is drawn bold enough to read at thumbnail size.
      const p1 = peaScene(1), p2 = peaScene(2), amp = ampliconParts({ nb: 7, split: 3 });
      const b1 = boundsOf(p1), b2 = boundsOf(p2), ba = boundsOf(amp);
      const bx = Math.min(b1.x, b2.x), by = Math.min(b1.y, b2.y);
      const bw = Math.max(b1.x + b1.w, b2.x + b2.w) - bx, bh = Math.max(b1.y + b1.h, b2.y + b2.h) - by;
      // widths: margins 6, plate 52, four arrows 15, NGS at least 58; the PEA panels and amplicons share scale k
      const plateW = 52, arW = 15, ngsW = 58, cy = 75;
      const k = Math.min((520 - 12 - plateW - 4 * arW - ngsW) / (2 * bw + ba.w), 134 / bh);
      const parts = [], arrows = [];
      let x = 6;
      const gapA = () => { arrows.push(arrowD(x + 2, x + arW - 2, cy, 6.5, 2)); x += arW; };
      const at = (P, b) => placeParts(P, { dx: x - b.x * k, dy: cy - (b.y + b.h / 2) * k, s: k, lw: 1.67 / k });
      parts.push(...fit(plateParts(), [x, cy - 22, x + plateW, cy + 22])); x += plateW; gapA();
      parts.push(...at(p1, { x: bx, y: by, w: bw, h: bh })); x += bw * k; gapA();
      parts.push(...at(p2, { x: bx, y: by, w: bw, h: bh })); x += bw * k; gapA();
      parts.push(...at(amp, ba)); x += ba.w * k; gapA();
      parts.push(...fit(ngsParts(0, 0, 120, 110, { frame: false }), [x, cy - 40, 514, cy + 40]));
      parts.push(arrowPart(arrows));
      return { size: [520, 150], lineWidth: 1.5, parts };
    },
  },
  {
    slug: "somascan-workflow", name: "SomaScan workflow — bind, capture, release, hybridise to array, read out", category: "methods",
    tags: [...SOMA_TAGS, "workflow", "overview", "pipeline", "streptavidin bead", "catch-1", "catch-2", "NHS-biotin", "biotinylation", "photocleavage", "UV", "kinetic challenge", "dextran sulfate", "elution", "hybridisation", "hybridization", "DNA microarray", "Agilent", "Cy3", "fluorescence", "RFU", "SomaScan 11K", "readout"],
    scene: () => {
      // steps 1–3 share one scale (beads centred at y 104) so the beads and glyphs match
      const s = 0.82, by = 104;
      const parts = [
        ...put(somaBindParts(), 52, by, s),
        ...put(somaCaptureParts(), 172, by, s),
        ...put(somaReleaseParts(), 280, by, s),
        ...fit(somaHybParts(), [368, 30, 448, 132]),
        ...fit(arrayImageParts(), [466, 56, 514, 104]),
      ];
      parts.push(arrowPart([[97, 112], [224, 239], [352, 366], [450, 464]].map(([a, b]) => arrowD(a, b, 92, 6.5, 2))));
      parts.push({ d: boltD(106, 72, 0.9), fill: COL.laser, shade: "small", thin: true });
      return { size: [520, 150], lineWidth: 1.5, parts };
    },
  },
];
