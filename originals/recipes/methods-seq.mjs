// Sequencing methods — single-cell (droplet) workflow pieces, epigenomics assays, sequencing,
// typical plots and overview strips. Servier-like (soft) and NIH-like (line); light from the top left.
// Colours of recurring things are shared (gel bead, oligo segments, Tn5, nucleosomes…) so a
// workflow strip matches the single icons.
import { blob, blobPts, circle, ellipse, rect, capsule, smoothClosed, smoothOpen, polygon, polyline, rotate, scatter, rng, f } from "../lib/geom.mjs";
import { shade, tint, flat, pathBox } from "../lib/style.mjs";
import { catmull, resample, arcLengths, roundPoly, packIn, packWhere, inside, lineD, polyD, clipConvex, rectPoly } from "../lib/tissue.mjs";
import { unevenSpacing } from "../lib/organic.mjs";

const DEG = Math.PI / 180;
const P = (x, y) => `${f(x)} ${f(y)}`;
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* ---------------- palette ---------------- */

const COL = {
  // capture oligo segments (5' bead end → 3' end)
  r1: "#4f86d0", // Illumina (TruSeq) Read 1 handle
  bc: "#ef8f4a", // cell barcode
  umi: "#9a7bd0", // UMI
  polyT: "#f2c14e", // poly(dT)
  mrna: "#d9609a", polyA: "#74c267", cap5: "#b0444f",
  bead: "#b3c3ef", // hydrogel gel bead
  droplet: "#dff0fb", oil: "#fbeec4",
  cell: "#f5c6a5", cell2: "#a9d6ee", cell3: "#f4c3d1", cell4: "#cfe8a8",
  nuc: "#8a7fc6", nucleolus: "#5f4f9e",
  enzyme: "#c9a6e0", // reverse transcriptase & co. (lilac: no other molecule in the set uses it)
  bcChan: "#d6e1f8", sampleChan: "#fbe0e8", chipMat: "#c6d3df", // microfluidic channel liquids, chip material
  plastic: "#e3edf4", plasticD: "#cadbe7", frost: "#f4f6f8",
  holder: "#4d5866",
  sample: "#f2a9bd", oilWell: "#f5d27c", gem: "#eef1f6",
  arrow: "#c3d2e1",
  // chromatin (DNA violet so it never matches the blue antibody heavy chains)
  dna: "#8e72c9", histone: "#f4a7b9", tn5: "#7cc46a", ad1: "#e2566f", ad2: "#f2c14e",
  ab: "#5b8bd9", abL: "#f0a35c", pa: "#45b7b0", mnase: "#df5a4e", tf: "#f2c14e", mark: "#b8323f",
  magbead: "#a0703f", crosslink: "#3d4a5a", ca: "#7fd0e0", linker: "#b9a58e",
  // sequencing (P7 a darker amber, so it never matches the cell-barcode orange)
  glass: "#dff0fb", lane: "#9fc9ea", p5: "#45b7b0", p7: "#a87038", fwd: "#8e72c9", rev: "#e86a9a",
  baseA: "#3aa655", baseC: "#4f86d0", baseG: "#f0a050", baseT: "#d64f5c",
  axis: "#6f7d8c", insert: "#d9609a", r2: "#8fa0b0", i7: "#4f6478",
};
/** Categorical colours for clusters (pastel-saturated, distinct in hue). */
const CLU = ["#4e8fd6", "#f0a050", "#6cbf68", "#e2606a", "#9b7fd1", "#45b7b0", "#ec8fc0", "#d9b43a"];
const HI = "#f7fafc", SHADOW = "#24303c";

/* ---------------- path helpers ---------------- */

/** Elliptical arc from angle a0 to a1 (degrees, y down: 90 = bottom) as cubic segments (no leading M). */
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

/** Reverse a closed polygon-ish path made by polyD (for holes). */
const holeD = (pts) => polyD([...pts].reverse());
const circPts = (cx, cy, r, n = 48, ry = r) => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * 2 * Math.PI) * r, cy + Math.sin((i / n) * 2 * Math.PI) * ry]);
/** An annulus (ring) as one path: outer circle + reversed inner circle. */
const ringD = (cx, cy, r0, r1) => polyD(circPts(cx, cy, r1, 64)) + holeD(circPts(cx, cy, r0, 64));

/** Scale + move parts (path data, stroke widths, outline widths). */
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

/** Dense smooth centreline through key points, resampled every `step`. */
const spine = (pts, step = 1.5) => resample(catmull(pts, 12), step);

/**
 * Closed outline of a band `w` wide along a dense centreline (straight-segment polygon, so it is
 * robust for the boolean shading). cap0 / cap1: round the start / end.
 */
function tubeD(c, w, o = {}) {
  return polyD(tubePts(c, w, o));
}
/** The outline points of tubeD (for clipping). */
function tubePts(c, w, { cap0 = false, cap1 = false, taper = 0 } = {}) {
  const n = c.length, L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const hw = (w / 2) * (1 - taper * (i / (n - 1)));
    L.push([c[i][0] - (dy / l) * hw, c[i][1] + (dx / l) * hw]);
    R.push([c[i][0] + (dy / l) * hw, c[i][1] - (dx / l) * hw]);
  }
  const capPts = (p, from, to, hw) => {
    const out = [];
    const a0 = Math.atan2(from[1] - p[1], from[0] - p[0]);
    let a1 = Math.atan2(to[1] - p[1], to[0] - p[0]);
    // go the long way round through the tip side
    const tip = Math.atan2(c[n - 1][1] - c[n - 2][1], c[n - 1][0] - c[n - 2][0]);
    void tip;
    let da = a1 - a0;
    while (da <= 0) da += 2 * Math.PI;
    for (let k = 1; k < 8; k++) out.push([p[0] + Math.cos(a0 + (da * k) / 8) * hw, p[1] + Math.sin(a0 + (da * k) / 8) * hw]);
    return out;
  };
  const pts = [...L];
  if (cap1) {
    const hw = (w / 2) * (1 - taper);
    // from L[n-1] round the tip to R[n-1]: rotate the other way (counter-clockwise on screen)
    const p = c[n - 1], a0 = Math.atan2(L[n - 1][1] - p[1], L[n - 1][0] - p[0]);
    for (let k = 1; k < 8; k++) pts.push([p[0] + Math.cos(a0 - (Math.PI * k) / 8) * hw, p[1] + Math.sin(a0 - (Math.PI * k) / 8) * hw]);
  }
  pts.push(...R.reverse());
  if (cap0) {
    const hw = w / 2, p = c[0], a0 = Math.atan2(R[R.length - 1][1] - p[1], R[R.length - 1][0] - p[0]);
    for (let k = 1; k < 8; k++) pts.push([p[0] + Math.cos(a0 - (Math.PI * k) / 8) * hw, p[1] + Math.sin(a0 - (Math.PI * k) / 8) * hw]);
  }
  void capPts;
  return pts;
}

/**
 * A band along a dense centreline whose half-width swells from thin ends to `w`/2 in the middle
 * (a torn membrane edge, a fragment): round-ish tips, no blunt bar ends.
 */
function taperTubeD(c, w, { end = 0.25, min = 0.28 } = {}) {
  const n = c.length, s = arcLengths(c), L = s[n - 1], A = [], B = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const u = Math.min(s[i], L - s[i]) / (L * end);
    const hw = (w / 2) * Math.max(min, Math.min(1, Math.sin(Math.min(1, u) * Math.PI / 2)));
    A.push([c[i][0] - (dy / l) * hw, c[i][1] + (dx / l) * hw]);
    B.push([c[i][0] + (dy / l) * hw, c[i][1] - (dx / l) * hw]);
  }
  return polyD([...A, ...B.reverse()]);
}

/* ---------------- objects running off the frame ---------------- */

/** Rectangle as a clip polygon (counter-clockwise on screen, as clipConvex expects). */
const clipRect = (x, y, w, h) => rectPoly(x, y, w, h);
/** Clip closed point lists to a convex polygon; returns path data (empty pieces dropped). */
const clipD = (polys, clip) => polys.map((p) => clipConvex(p, clip)).filter((p) => p.length > 2).map(polyD).join("");

/**
 * Points of disc A (centre c, radius r) minus the same disc moved by v: the crescent the renderer
 * shades with, built here as a polygon so it can be clipped like the disc.
 */
function lunePts(cx, cy, r, vx, vy, n = 40) {
  const dl = Math.hypot(vx, vy), b = Math.acos(Math.min(1, dl / (2 * r))), fv = Math.atan2(vy, vx);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = fv + b + ((2 * Math.PI - 2 * b) * i) / n;
    out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  for (let i = 0; i <= n; i++) {
    const t = fv + Math.PI + b - (2 * b * i) / n;
    out.push([cx + vx + Math.cos(t) * r, cy + vy + Math.sin(t) * r]);
  }
  return out;
}

/**
 * A disc cut by a convex clip polygon (a droplet or bead running off the frame). The fill is flat
 * and clipped; the Servier shading (dark rim bottom right, light band and gloss top left) is drawn
 * as soft-only overlays clipped the same way, and the line style outlines only the curved edge — so
 * a cut edge never gets a rim or an outline.
 */
function clippedDisc(cx, cy, r, fill, clip, { rim = 0.034, hi = 0.05, dark = 0.1, hiOp = 0.5, gloss = true, lw = 1.67 } = {}) {
  const circ = circPts(cx, cy, r, 120);
  const body = clipConvex(circ, clip);
  if (body.length < 3) return [];
  const k = rim * 2 * r, h = hi * 2 * r;
  const parts = [
    { d: polyD(body), fill, lineColor: flat(fill) },
    { d: clipD([lunePts(cx, cy, r, -k, -k)], clip), fill: shade(fill, dark), line: false },
    glow(clipD([lunePts(cx, cy, r * 0.9, h, h)], clip), hiOp),
  ];
  if (gloss) {
    const g = [cx - r * 0.5, cy - r * 0.52];
    if (inside(clip, g)) parts.push(glow(ellipse(g[0], g[1], r * 0.1, r * 0.062, -50) + circle(g[0] + r * 0.17, g[1] - r * 0.08, r * 0.035), 0.75));
  }
  // the visible runs of the outline, for the line style (each run ends exactly on the clip edge)
  const ins = circ.map((p) => inside(clip, p));
  const start = ins.indexOf(false), m = circ.length;
  const edge = (a, b) => { // a inside, b outside: the crossing point
    let lo = 0, hi_ = 1;
    for (let it = 0; it < 24; it++) { const t = (lo + hi_) / 2; if (inside(clip, [lerp(a[0], b[0], t), lerp(a[1], b[1], t)])) lo = t; else hi_ = t; }
    return [lerp(a[0], b[0], lo), lerp(a[1], b[1], lo)];
  };
  const runs = [];
  if (start < 0) runs.push([...circ, circ[0]]);
  else {
    let cur = null;
    for (let j = 1; j <= m; j++) {
      const i = (start + j) % m, prev = (i - 1 + m) % m;
      if (ins[i]) { if (!cur) cur = [edge(circ[i], circ[prev])]; cur.push(circ[i]); }
      else if (cur) { cur.push(edge(circ[prev], circ[i])); runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
  }
  const arcs = runs.filter((r_) => r_.length > 1).map(polyline).join("");
  if (arcs) parts.push({ d: arcs, fill: "none", stroke: { color: fill, width: lw, cap: "butt" }, soft: false });
  return parts;
}

/** Block arrow pointing right from x0 to x1 at height y (Servier-like, rounded corners). */
function arrowD(x0, x1, y, h = 12, head = 1.9) {
  const hh = (h * head) / 2, hl = Math.min((x1 - x0) * 0.55, h * 1.15);
  return roundPoly([[x0, y - h / 2], [x1 - hl, y - h / 2], [x1 - hl, y - hh], [x1, y], [x1 - hl, y + hh], [x1 - hl, y + h / 2], [x0, y + h / 2]], 1.6);
}
const arrowPart = (ds) => ({ d: [].concat(ds).join(""), fill: COL.arrow, shade: "rim", gloss: false, highlight: false, thin: true });

/** Overlay highlight / shadow parts (soft style only). */
const glow = (d, opacity = 0.6, extra = {}) => ({ d, fill: HI, opacity, line: false, ...extra });
const dim = (d, opacity = 0.14, extra = {}) => ({ d, fill: SHADOW, opacity, line: false, ...extra });

/**
 * Edge shading for a flat rounded-rectangle face (x, y, w, h, corner r), light from the top left:
 * a crescent `bw` thick hugging the right and bottom edges — thickest round the bottom-right
 * corner, tapering to nothing well below the top-right corner and before the bottom-left one —
 * or, with flip, the matching crescent along the left and top edges. (The renderer's "rim" shade
 * offsets a whole copy of the shape, which on wide flat panels leaves a stepped top-right corner.)
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
/** Flat face + dark crescent (bottom right) + light crescent (top left), soft style only. */
const faceShade = (x, y, w, h, r, fill, { bw = 3, hw = 2.4, dark = 0.1, light = 0.5 } = {}) => [
  { d: edgeBand(x, y, w, h, r, bw), fill: shade(fill, dark), line: false },
  glow(edgeBand(x, y, w, h, r, hw, { flip: true }), light),
];

/* ---------------- tubes (body of revolution) ---------------- */

function lathe(cx, knots, { tension = 1, top = 0 } = {}) {
  const left = knots.map(([y, w]) => [cx - w, y]);
  const right = knots.filter(([, w]) => w > 0).map(([y, w]) => [cx + w, y]).reverse();
  const d = smoothOpen([...left, ...right], tension);
  if (!top) return d + "Z";
  return d + arc(cx, knots[0][0], knots[0][1], top, 0, -180) + "Z";
}
function widthAt(knots, y) {
  for (let i = 1; i < knots.length; i++) {
    const [y0, w0] = knots[i - 1], [y1, w1] = knots[i];
    if (y <= y1) return w0 + ((w1 - w0) * (y - y0)) / Math.max(1e-6, y1 - y0);
  }
  return knots[knots.length - 1][1];
}
function fillKnots(knots, level, wall, bottomWall = wall) {
  const yEnd = knots[knots.length - 1][0] - bottomWall;
  const out = [[level, widthAt(knots, level) - wall]];
  for (const [y, w] of knots) if (y > level + 0.5 && y < yEnd - 0.5) out.push([y, Math.max(0.8, w - wall)]);
  const tip = knots[knots.length - 1][1] === 0;
  out.push([yEnd, tip ? 0 : Math.max(1, widthAt(knots, yEnd) - wall)]);
  return out.filter(([, w], i, a) => w > 0 || i === a.length - 1);
}

/**
 * 1.5 mL microcentrifuge tube, closed, collar top at (cx, y0); s scales it. Returns
 * { parts (body + liquid, below anything drawn inside), top (marks, cap…), liquid: {knots, level} }.
 */
function microtube(cx, y0, { s = 1, cap = "#5b9fe0", liquid = COL.sample, level = 0.55 } = {}) {
  const k = (v) => v * s;
  const knots = [[y0 + k(4), k(24.5)], [y0 + k(22), k(24.2)], [y0 + k(44), k(23.6)], [y0 + k(56), k(20.5)], [y0 + k(120), k(6.4)], [y0 + k(129), k(2.8)], [y0 + k(133), 0]];
  const lv = y0 + k(44 + level * 60);
  const lk = fillKnots(knots, lv, k(2.6), k(3));
  const body = [
    { d: lathe(cx, knots), fill: COL.plastic, shade: "body", gloss: false },
    { d: lathe(cx, lk, { top: k(3) }), fill: liquid, shade: "body", gloss: false },
    glow(ellipse(cx, lv, widthAt(lk, lv), k(3)), 0.45),
  ];
  const top = [
    glow(tubeD(spine([[cx - k(19), y0 + k(10)], [cx - k(19), y0 + k(42)], [cx - k(12), y0 + k(82)], [cx - k(7), y0 + k(108)]], 1.5), k(4.2), { taper: 0.6 }), 0.7),
    { d: rect(cx - k(31), y0 - k(3), k(62), k(10), k(3.5)), fill: COL.plasticD, shade: "rim" },
    // hinge: a short flat strap bending from the lid's rim down to the collar (lid tab on the other side)
    { d: tubeD(spine([[cx - k(27), y0 - k(13)], [cx - k(32.5), y0 - k(10.5)], [cx - k(34), y0 - k(5)], [cx - k(31), y0 + k(1)]], 1), k(3.4), { cap0: true, cap1: true }), fill: shade(cap, 0.06), shade: "rim", gloss: false, highlight: false, thin: true },
    { unite: [rect(cx - k(29), y0 - k(28), k(58), k(26), k(7)), capsule(cx + k(26), y0 - k(21), cx + k(39), y0 - k(21), k(4.5))], fill: cap, shade: "body", glossAt: [0.22, 0.3], glossSize: 0.04 },
    glow(rect(cx - k(22), y0 - k(24), k(32), k(4), k(2)), 0.55),
  ];
  return { body, top, knots, lk, level: lv };
}

/* ---------------- cells and nuclei ---------------- */

/** A round cell (cytoplasm + nucleus) as two shape lists. */
function cellShapes(cx, cy, r, seed = 1, { nr = 0.5, off = [0.06, 0.08] } = {}) {
  return {
    body: blob(cx, cy, r, r * 0.95, { n: 8, wobble: 0.06, seed }),
    nuc: blob(cx + r * off[0], cy + r * off[1], r * nr, r * nr * 0.93, { n: 7, wobble: 0.07, seed: seed + 3 }),
  };
}

/** An isolated nucleus: envelope, nucleoplasm, nucleolus, chromatin specks. */
function nucleusParts(cx, cy, r, seed = 1, { fill = "#9b86cf" } = {}) {
  const pts = scatter(cx, cy, r * 0.56, r * 0.54, 7, { seed: seed + 4, minDist: r * 0.26, avoid: [[cx + r * 0.2, cy + r * 0.1, r * 0.35]] });
  // nuclear envelope (double membrane) as a darker band with pore gaps — what tells a nucleus from a cell
  const out = catmull(blobPts(cx, cy, r, r * 0.94, { n: 8, wobble: 0.05, seed }), 8, true);
  const inner = out.map(([x, y]) => [cx + (x - cx) * 0.86, cy + (y - cy) * 0.86]);
  const pores = Array.from({ length: 9 }, (_, i) => {
    const p = out[Math.round((i / 9) * out.length + 2) % out.length];
    return circle(cx + (p[0] - cx) * 0.93, cy + (p[1] - cy) * 0.93, r * 0.055);
  });
  return [
    { d: polyD(out), fill, shade: "organelle", glossAt: [0.3, 0.26] },
    { d: polyD(out) + holeD(inner), fill: shade(fill, 0.1), opacity: 0.9, thin: true, lineWidth: 0.7 },
    { d: pores.join(""), fill: tint(fill, 0.08), thin: true, lineWidth: 0.5 },
    { d: pts.map(([x, y]) => circle(x, y, r * 0.075)).join(""), fill: shade(fill, 0.14), opacity: 0.6, line: false },
    { d: blob(cx + r * 0.2, cy + r * 0.12, r * 0.26, r * 0.23, { n: 6, wobble: 0.08, seed: seed + 2 }), fill: COL.nucleolus, shade: "small" },
  ];
}

/* ---------------- capture oligos and gel beads ---------------- */

const SEGS = [["r1", 22], ["bc", 16], ["umi", 12], ["polyT", 30]];
const SEG_T = (() => {
  const tot = SEGS.reduce((a, [, n]) => a + n, 0);
  let acc = 0;
  return SEGS.map(([k, n]) => { const a = acc / tot; acc += n; return [k, a, acc / tot]; });
})();

/**
 * Oligo strands on a bead, in two depth layers: `back` strands leave the far side (their roots hidden
 * behind the bead), `front` strands leave the near face (their roots seen on the bead). Angular
 * spacing is uneven (CV ≈ 0.3), lengths vary ±25 % and bends are independent, so neighbours now and
 * then cross — a fuzzy coat, not a sun. Segment lengths are fractions of the *visible* strand, so the
 * blue Read 1 handle is never shorter than the orange barcode.
 * Returns { front: {r1:[d…], bc, umi, polyT}, back: {…} }.
 */
function beadOligos(cx, cy, R, { n = 70, len = 38, w = 3.9, seed = 3, back = 0.42 } = {}) {
  const rnd = rng(seed);
  const mk = () => ({ r1: [], bc: [], umi: [], polyT: [] });
  const out = { front: mk(), back: mk() };
  const a0 = rnd() * 360;
  for (const deg of unevenSpacing(n, 360, rnd, { cv: 0.3 })) {
    const isBack = rnd() < back;
    const a = (a0 + deg) * DEG, ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
    const L = len * (0.75 + rnd() * 0.5) * (isBack ? 0.9 : 1);
    // front roots sit at slightly different depths on the near face (no ring of equal roots)
    const r0 = R * (isBack ? 0.9 : 0.9 + rnd() * 0.07), tot = R - r0 + L;
    const bend = (rnd() - 0.5) * 0.3 * L;
    const key = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4, r = r0 + tot * t, lat = bend * t * t;
      key.push([cx + ux * r + vx * lat, cy + uy * r + vy * lat]);
    }
    const c = spine(key, 1.2);
    const hid = isBack ? (R - r0) / arcLengths(c).at(-1) : 0;
    const o = isBack ? out.back : out.front;
    for (const [k, t0, t1] of SEG_T) {
      o[k].push(tubeD(subLine(c, k === "r1" ? 0 : hid + (1 - hid) * t0, hid + (1 - hid) * t1), isBack ? w * 0.9 : w, { cap0: k === "r1" && !isBack, cap1: k === "polyT" }));
    }
  }
  return out;
}
const oligoParts = (o, { dark = 0 } = {}) => SEGS.map(([k]) => ({ d: o[k].join(""), fill: dark ? shade(COL[k], dark) : COL[k], shade: "rim", gloss: false, highlight: false, thin: true }));

/** A barcoded gel bead (hydrogel) with its coat of capture oligos. */
function gelBead(cx, cy, R, o = {}) {
  const ol = beadOligos(cx, cy, R, o);
  const parts = oligoParts(ol.back, { dark: 0.15 });
  parts.push({ d: circle(cx, cy, R), fill: COL.bead, shade: "body", glossAt: [0.28, 0.26] });
  // faint hydrogel mesh (soft only)
  const pts = scatter(cx + R * 0.08, cy + R * 0.1, R * 0.6, R * 0.58, 9, { seed: (o.seed || 3) + 7, minDist: R * 0.3 });
  parts.push({ d: pts.map(([x, y]) => circle(x, y, R * 0.05)).join(""), fill: shade(COL.bead, 0.1), opacity: 0.55, line: false });
  parts.push(...oligoParts(ol.front));
  return parts;
}

/**
 * A small gel bead for droplets and strips: bead + fringe of capture oligos, each strand split into
 * the same four segments as the barcoded-gel-bead icon (Read 1 → barcode → UMI → poly(dT), over the
 * visible length). With `clip` (a convex polygon) everything is cut to it — a bead running off the
 * frame. The returned array carries `.tips`: per strand { c (centreline), t0 (where it leaves the
 * bead), a (angle) } for hanging mRNAs on the poly(dT) ends.
 */
function miniBead(cx, cy, R, { seed = 5, n = 18, reach = [0.5, 0.14], w = null, clip = null, lw = 1.67 } = {}) {
  const rnd = rng(seed);
  const seg = { r1: [], bc: [], umi: [], polyT: [] }, tips = [];
  const sw = w ?? Math.max(1.2, R * 0.13);
  for (let i = 0; i < n; i++) {
    const a = ((i + (rnd() - 0.5) * 0.55) / n) * 2 * Math.PI;
    const r0 = R * 0.85, r1 = R * (1 + reach[0] + rnd() * reach[1]);
    const bend = (rnd() - 0.5) * R * 0.25;
    const mid = (r0 + r1) / 2;
    const c = spine([[cx + Math.cos(a) * r0, cy + Math.sin(a) * r0], [cx + Math.cos(a) * mid - Math.sin(a) * bend, cy + Math.sin(a) * mid + Math.cos(a) * bend], [cx + Math.cos(a) * r1, cy + Math.sin(a) * r1]], 0.6);
    const t0 = Math.min(0.5, (R - r0) / arcLengths(c).at(-1));
    for (const [k, a0, a1] of SEG_T) seg[k].push(tubePts(subLine(c, k === "r1" ? 0 : t0 + (1 - t0) * a0, t0 + (1 - t0) * a1), sw, { cap1: k === "polyT" }));
    tips.push({ c, t0, a: a / DEG });
  }
  const emit = (k) => (clip ? clipD(seg[k], clip) : seg[k].map(polyD).join(""));
  const parts = SEGS.map(([k]) => ({ d: emit(k), fill: COL[k], shade: "rim", gloss: false, highlight: false, thin: true })).filter((p) => p.d);
  if (clip) parts.push(...clippedDisc(cx, cy, R, COL.bead, clip, { lw, rim: 0.04, hi: 0.06, hiOp: 0.45 }));
  else parts.push({ d: circle(cx, cy, R), fill: COL.bead, shade: "organelle", glossAt: [0.28, 0.26] });
  parts.tips = tips;
  return parts;
}

/** Points spread over the free space of a disc (for reagents): `ok(p)` filters, minimum spacing `gap`. */
function freeSpots(cx, cy, r, count, ok, { seed = 1, gap = 16 } = {}) {
  const R = rng(seed), out = [];
  for (let t = 0; out.length < count && t < 4000; t++) {
    const a = R() * 2 * Math.PI, d = r * Math.sqrt(R());
    const p = [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
    if (ok(p) && out.every((q) => dist(p, q) >= gap)) out.push(p);
  }
  return out;
}

/**
 * A GEM in its emulsion. The oil is a flat field filling the frame; the neighbouring GEMs are the
 * same size as the central one (Chromium emulsions are monodisperse), hexagonally packed with thin
 * oil films between them and cut by the frame; two of them show part of their own gel bead. The
 * central droplet holds one gel bead (lower left, ~55 % of the droplet's diameter), one cell (upper
 * right, ~0.45 × the bead) and reverse transcriptase / reagent enzymes (lilac).
 */
function gemParts() {
  const W = 200, C = [100, 100], R = 70, Rn = 69, film = 7;
  const frame = clipRect(0, 0, W, W);
  const parts = [{ d: rect(0, 0, W, W), fill: COL.oil, lineColor: flat(COL.oil) }];
  const J = rng(31);
  const nb = [17, 77, 137, 197, 257, 317].map((a) => {
    const aa = (a + (J() - 0.5) * 5) * DEG, dd = R + Rn + film + (J() - 0.5) * 2;
    return [C[0] + Math.cos(aa) * dd, C[1] + Math.sin(aa) * dd];
  });
  for (const [x, y] of nb) parts.push(...clippedDisc(x, y, Rn, COL.droplet, frame, { rim: 0.03, hi: 0.045 }));
  // partial gel beads in the two corner GEMs (lower left, upper right)
  parts.push(...miniBead(nb[2][0] + 8, nb[2][1] - 6, 38, { seed: 41, n: 30, w: 4.2, reach: [0.34, 0.08], clip: frame }));
  parts.push(...miniBead(nb[5][0] - 4, nb[5][1] + 9, 38, { seed: 43, n: 30, w: 4.2, reach: [0.34, 0.08], clip: frame }));
  // the central GEM
  parts.push({ d: circle(C[0], C[1], R), fill: COL.droplet, shade: "body", glossAt: [0.22, 0.2] });
  const B = [C[0] - 6.5, C[1] + 6.5], BR = 38;
  parts.push(...miniBead(B[0], B[1], BR, { seed: 5, n: 30, w: 4.2, reach: [0.36, 0.1] }));
  const cc = [C[0] + 35.5, C[1] - 35.5], cr = 17;
  const c = cellShapes(cc[0], cc[1], cr, 12, { nr: 0.46 });
  parts.push({ d: c.body, fill: COL.cell, shade: "organelle", glossAt: [0.3, 0.26] });
  parts.push({ d: c.nuc, fill: COL.nuc, shade: "small" });
  const ez = freeSpots(C[0], C[1], R - 8, 6, (p) => dist(p, C) < R - 8.5 && dist(p, B) > BR * 1.46 + 7 && dist(p, cc) > cr + 9, { seed: 7, gap: 20 });
  parts.push({ unite: ez.flatMap(([x, y], i) => lumpy(x, y, 6, { n: 6, seed: 3 + i, rot: i * 47 })), fill: COL.enzyme, shade: "small" });
  return parts;
}

/* ---------------- transforms ---------------- */

/** Local → world placement: scale s, rotation (degrees, clockwise on screen). */
function place({ x = 0, y = 0, s = 1, rot = 0 } = {}) {
  const c = Math.cos(rot * DEG), sn = Math.sin(rot * DEG);
  return { P: ([px, py]) => [x + (px * c - py * sn) * s, y + (px * sn + py * c) * s], s, rot };
}
/** Map parts built in local coordinates through placement t (geometry and stroke widths only). */
function xform(parts, t) {
  return parts.map((p) => {
    const q = { ...p };
    if (p.unite) q.unite = p.unite.map((d) => mapPath(d, t.P));
    if (p.d) q.d = Array.isArray(p.d) ? p.d.map((d) => mapPath(d, t.P)) : mapPath(p.d, t.P);
    if (p.stroke) q.stroke = { ...p.stroke, width: p.stroke.width * t.s };
    if (p.lineStrokeWidth) q.lineStrokeWidth = p.lineStrokeWidth * t.s;
    return q;
  });
}
const add2 = (a, u, k) => [a[0] + u[0] * k, a[1] + u[1] * k];

/* ---------------- tubes with soft-only shading stripes ---------------- */

/** Light stripe on the lit side and a shadow stripe on the far side of tubes (soft style only). */
function tubeStripes(cs, w, { caps = true, hi = 0.55, lo = 0.15 } = {}) {
  const off = (c, k) => c.map(([x, y]) => [x + k * w, y + k * w]);
  const o = { cap0: caps, cap1: caps };
  return [
    { unite: cs.map((c) => tubeD(off(c, 0.17), w * 0.4, o)), fill: SHADOW, opacity: lo, line: false },
    { unite: cs.map((c) => tubeD(off(c, -0.15), w * 0.24, o)), fill: HI, opacity: hi, line: false },
  ];
}

/* ---------------- proteins ---------------- */

/** A lumpy globular protein (unite these). */
function lumpy(cx, cy, R, { n = 6, seed = 1, bump = 0.5, rot = 0, sx = 1, sy = 1 } = {}) {
  const r = rng(seed);
  const out = [ellipse(cx, cy, R * 0.78 * sx, R * 0.78 * sy)];
  for (let i = 0; i < n; i++) {
    const a = ((i + r() * 0.5) / n) * Math.PI * 2 + rot * DEG;
    const d = R * (0.42 + r() * 0.1), br = R * bump * (0.8 + r() * 0.4);
    out.push(circle(cx + Math.cos(a) * d * sx, cy + Math.sin(a) * d * sy, br));
  }
  return out;
}

/**
 * IgG antibody (same build as the library's antibody): hinge at the origin, Fc down, Fab arms up,
 * placed by t. Returns parts plus the world positions of both Fab tips and the Fc end.
 */
function antibody(t, { heavy = COL.ab, light = COL.abL, sh = "organelle" } = {}) {
  const r = 9, h = 6, o = r + 0.3, sn = Math.sin(38 * DEG), cs = Math.cos(38 * DEG);
  const H = [], Lc = [], hinge = [], tips = [];
  const dom = (a, b) => capsule(...t.P(a), ...t.P(b), r * t.s);
  for (const k of [0, 1]) for (const side of [-1, 1]) {
    const cy = 26 + k * 32;
    H.push(dom([side * o, cy - h], [side * o, cy + h]));
  }
  for (const side of [-1, 1]) {
    const u = [side * sn, -cs], nin = [-side * cs, -sn], A0 = [side * 20.5, -3.5];
    for (const tt of [15, 47]) for (const [w, list] of [[o, H], [-o, Lc]]) {
      const c = add2(add2(A0, u, tt), nin, w);
      list.push(dom(add2(c, u, -h), add2(c, u, h)));
    }
    hinge.push(capsule(...t.P([side * o, 10]), ...t.P(add2(add2(A0, nin, o), u, 4)), 2.6 * t.s));
    tips.push(t.P(add2(A0, u, 66)));
  }
  const g = sh === "organelle" ? { glossSize: 0.1 } : {};
  return {
    parts: [
      { d: hinge.join(""), fill: heavy, shade: "rim", gloss: false, highlight: false, thin: true },
      { d: H, fill: heavy, shade: sh, ...g },
      { d: Lc, fill: light, shade: sh, ...g },
    ],
    tips, fc: t.P([0, 76]),
  };
}
/** Placement that puts Fab tip `arm` (0 left, 1 right) of an antibody at `tip`, rotated rot, scale s. */
function abAtTip(tip, rot, s, arm = 0) {
  const probe = antibody(place({ s, rot })).tips[arm];
  return place({ x: tip[0] - probe[0], y: tip[1] - probe[1], s, rot });
}

/** Tn5 transposome (homodimer) loaded with two adapters (red and yellow), local size ~52 × 60. */
function tn5Local({ seed = 1, adapters = true } = {}) {
  const parts = [];
  if (adapters) {
    for (const [side, col] of [[-1, COL.ad1], [1, COL.ad2]]) {
      const c = spine([[side * 9, -2], [side * 13, -14], [side * 15, -25], [side * 21, -35]], 1);
      parts.push({ d: tubeD(c, 5.6, { cap1: true }), fill: col, shade: "rim", gloss: false, highlight: false, thin: true });
    }
  }
  parts.push({ d: [blob(-10, 0, 13.5, 12, { n: 7, wobble: 0.1, seed }), blob(10.5, 0.8, 13.5, 12, { n: 7, wobble: 0.1, seed: seed + 5 })], fill: COL.tn5, shade: "organelle", glossSize: 0.07 });
  return parts;
}

/* ---------------- chromatin ---------------- */

/** DNA wrapped 1.5 turns round a histone core (side view, axis vertical): in at the left, out at the right. */
function nucHelix(cx, cy, { R = 15, ry = 14, w = 7, p = 10, e = 9, rot = 0, ph0 = 0.3, ph1 = 2.7 } = {}) {
  // seen from slightly above: each turn is an ellipse (front half low, back half high and hidden).
  // Phase in units of π: 0 = left silhouette, 0–1 front, 1–2 back, 2–3 front again. The DNA comes in
  // on the front (ph0, heading right) and leaves on the front (ph1, heading right), so linkers join
  // the wrap almost straight. Returns the points and the indices where the back half starts / ends.
  const Rw = R + w * 0.3, pts = [], step = 1 / 48;
  const at = (k) => rotate([cx - Rw * Math.cos(k * Math.PI), cy - 2.5 + 0.75 * p - (p * k) / 2 + e * Math.sin(k * Math.PI)], cx, cy, rot);
  const ks = [];
  for (let k = ph0; k < ph1 - 1e-6; k += step) ks.push(k);
  ks.push(ph1);
  for (const k of [1, 2]) if (!ks.some((v) => Math.abs(v - k) < 1e-6)) ks.push(k);
  ks.sort((a, b) => a - b);
  for (const k of ks) pts.push(at(k));
  return { pts, a: ks.findIndex((v) => Math.abs(v - 1) < 1e-6), b: ks.findIndex((v) => Math.abs(v - 2) < 1e-6), core: ellipse(cx, cy, R, ry, rot) };
}

/**
 * A chromatin fibre. items (in order): [x, y] linker points, {x, y, …nucHelix options, tail?: {a, len}}
 * nucleosomes, and "cut" (DNA ends here — a Tn5/MNase cut — and a new piece starts).
 * Returns parts: DNA behind, histone tails, cores, DNA wrapped in front, tail marks.
 */
function chromatin(items, { w = 7, R = 15, ry = 14, p = 10, e = 7.5, dna = COL.dna, histone = COL.histone, capEnds = true, stripes = true, lead = 4.5 } = {}) {
  // The DNA is one continuous centreline per run (between cuts). Everything in front of the histone
  // cores — linkers and the front half of each wrap — is one layer; only the back half of each wrap
  // (behind the core) is drawn underneath. Linkers leave / enter a wrap along its tangent (a knot
  // `lead` units out), so there are no kinks or notches where they join.
  const front = [], back = [], cores = [], tails = [], marks = [], markPts = [];
  const unit = (a, b) => { const l = dist(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  let piece = null, knots = [], last = null, startCap = capEnds;
  const linker = (to) => {
    const K = [];
    if (last) K.push(last.pt, add2(last.pt, last.t, lead));
    K.push(...knots);
    if (to) K.push(add2(to.pt, to.t, -lead), to.pt);
    knots = [];
    return K.length >= 2 ? resample(catmull(K, 12), 1.4) : [];
  };
  const append = (pts) => {
    if (!pts.length) return;
    if (!piece) { piece = [...pts]; return; }
    piece.push(...(dist(piece[piece.length - 1], pts[0]) < 0.6 ? pts.slice(1) : pts));
  };
  const close = (cap1) => {
    if (piece && piece.length >= 2) front.push({ c: piece, cap0: startCap, cap1 });
    piece = null;
  };
  for (const it of items) {
    if (Array.isArray(it)) { knots.push(it); continue; }
    if (it === "cut") { append(linker(null)); close(true); startCap = true; last = null; continue; }
    const o = { R, ry, w, p, e, ...it };
    const hx = nucHelix(it.x, it.y, o), P_ = hx.pts;
    const n = P_.length - 1, a = hx.a, b = hx.b;
    if (last || knots.length) append(linker({ pt: P_[0], t: unit(P_[0], P_[1]) }));
    append(P_.slice(0, a + 1));
    close(true);
    startCap = true;
    back.push(P_.slice(a - 1, b + 2));
    append(P_.slice(b));
    cores.push(hx.core);
    if (it.tail) {
      const { a: ang, len = 20 } = it.tail, ux = Math.cos(ang * DEG), uy = Math.sin(ang * DEG);
      const s0 = [it.x + ux * o.R * 0.6, it.y + uy * o.ry * 0.6];
      const k = [s0, add2(add2(s0, [ux, uy], len * 0.4), [-uy, ux], 3), add2(add2(s0, [ux, uy], len * 0.75), [uy, -ux], 2.5), add2(s0, [ux, uy], len)];
      tails.push(smoothOpen(k));
      marks.push(circle(...k[3], 4.2)); markPts.push(k[3]);
    }
    last = { pt: P_[n], t: unit(P_[n - 1], P_[n]) };
  }
  append(linker(null));
  close(capEnds);
  const parts = [];
  if (back.length) {
    parts.push({ unite: back.map((c) => tubeD(c, w, { cap0: true, cap1: true })), fill: dna, thin: true });
    if (stripes) parts.push(...tubeStripes(back, w, { caps: false }));
  }
  if (tails.length) parts.push({ d: tails.join(""), fill: "none", stroke: { color: shade(histone, 0.12), width: 3.2, cap: "round" } });
  if (cores.length) parts.push({ d: cores, fill: histone, shade: "organelle", glossSize: 0.05, glossAt: [0.3, 0.2] });
  if (front.length) {
    parts.push({ unite: front.map((f) => tubeD(f.c, w, { cap0: !!f.cap0, cap1: !!f.cap1 })), fill: dna, thin: true });
    if (stripes) parts.push(...tubeStripes(front.map((f) => f.c), w, { caps: false }));
  }
  if (marks.length) parts.push({ d: marks, fill: COL.mark, shade: "small" });
  parts.marks = markPts;
  return parts;
}

/**
 * Formaldehyde crosslinks: a short dark two-bar "staple" bridging each protein–DNA contact.
 * pts: [x, y, angle°] (the direction the staple spans, default 90 = vertical).
 */
const crosslinks = (pts, len = 5) => ({
  unite: pts.flatMap(([x, y, a = 90]) => {
    const u = [Math.cos(a * DEG), Math.sin(a * DEG)], v = [-u[1], u[0]];
    return [-1, 1].map((s) => {
      const c = add2([x, y], v, s * 1.15);
      return capsule(...add2(c, u, -len / 2 + 0.5), ...add2(c, u, len / 2 - 0.5), 0.5);
    });
  }),
  fill: COL.crosslink, thin: true, lineWidth: 0.5,
});

/* ---------------- epigenomics scenes ---------------- */

const N = (x, y, o = {}) => ({ x, y, ...o });


/**
 * Tn5 insertion sites. The DNA is cut at x — a small visible gap under the centre of the dimer —
 * and each new end carries an adapter strand rising out of the cut (red = Read 1 / Tn5ME-A side
 * on the left end, yellow = Read 2 / Tn5ME-B side on the right end), held by the bound dimer.
 */
const CUT_G = 10; // the gap between the two round DNA ends (≥ 8 after the line style's outlines)
/** DNA knots either side of a cut at x (DNA width w, round ends): `"cut"` goes between them. */
const cutAt = (x, y, g = CUT_G, w = 7) => [[x - g / 2 - w / 2, y], "cut", [x + g / 2 + w / 2, y]];
function adapterEnds(sites, { g = CUT_G, w = 4.6, rise = 1, dnaW = 7 } = {}) {
  // every insertion leaves red on the left end and yellow on the right end, so the fragment between
  // two insertions reads yellow … red (one A and one B adapter: the ones that amplify).
  const red = [], yel = [];
  for (const [x, y] of sites) {
    for (const [side, list] of [[-1, red], [1, yel]]) {
      // each adapter rises from the outer half of its DNA end cap and leans away from the cut, so the
      // gap stays open and the Tn5 dimer shows between the two adapters
      const x0 = x + side * (g / 2 + dnaW / 2 + 1);
      const k = [[0, -1], [2.2, -6.5], [5.6, -11.5], [10, -15.5]].map(([u, v]) => [x0 + side * u * rise, y + v * rise]);
      list.push(tubeD(spine(k, 0.8), w, { cap0: true, cap1: true }));
    }
  }
  return [
    { d: red.join(""), fill: COL.ad1, shade: "rim", gloss: false, highlight: false, thin: true },
    { d: yel.join(""), fill: COL.ad2, shade: "rim", gloss: false, highlight: false, thin: true },
  ];
}

/** Tn5 dimer that has just inserted, sitting on the cut (drawn behind the DNA so the DNA runs through its base). */
const tn5Bound = (x, y, seed, s = 0.8) => xform(tn5Local({ seed, adapters: false }), place({ x, y: y - 6, s }));

/**
 * ATAC-seq: closed chromatin (a compact zig-zag of nucleosomes, protected), an open nucleosome-free
 * stretch where Tn5 has inserted its adapters, a loaded Tn5 arriving, and spaced nucleosomes.
 */
function atacParts() {
  const Y = 132, s1 = 150, s2 = 206;
  // closed chromatin: a compact, folded fibre — a second tier of nucleosomes behind the first, its
  // DNA disappearing behind the front cores — packed shoulder to shoulder (no room for Tn5)
  const parts = chromatin([[22, Y - 5], [16, Y - 16], N(40, Y - 27, { rot: 5 }), N(74, Y - 28, { p: -10, rot: -4 }), [95, Y - 25.5], [100.5, Y - 20], [100.5, Y - 12.5], [97, Y - 6]]);
  parts.push(...tn5Bound(s1, Y, 2), ...tn5Bound(s2, Y, 6));
  parts.push(...chromatin([
    [5, Y + 13], N(22, Y, { rot: -4 }), N(56, Y - 1, { p: -10, rot: 3 }), N(90, Y, { rot: -3 }),
    [116, Y - 4], ...cutAt(s1, Y),
    [168, Y - 1], [178, Y - 1], ...cutAt(s2, Y),
    [226, Y + 4], N(252, Y), [272, Y - 6], [286, Y - 6],
  ]));
  parts.push(...adapterEnds([[s1, Y], [s2, Y]]));
  parts.push(...xform(tn5Local({ seed: 9 }), place({ x: 178, y: 72, s: 0.86 })));
  return parts;
}

/**
 * Placement of an antibody whose Fab tip `arm` sits at `tip` and whose Fc end lands at `fc`
 * (scale and rotation solved from the two points).
 */
function abBetween(tip, fc, arm = 0) {
  const probe = antibody(place({ s: 1 }));
  const lt = probe.tips[arm], lf = probe.fc;
  const la = Math.atan2(lf[1] - lt[1], lf[0] - lt[0]), ll = dist(lt, lf);
  const wa = Math.atan2(fc[1] - tip[1], fc[0] - tip[0]), wl = dist(tip, fc);
  return abAtTip(tip, (wa - la) / DEG, wl / ll, arm);
}

/** pA(G) domain of a fusion protein. */
const paLump = (x, y, seed = 4, r = 9.5) => ({ unite: lumpy(x, y, r, { seed }), fill: COL.pa, shade: "organelle", glossSize: 0.08 });

/**
 * CUT&Tag: an antibody bound to a histone-tail mark on one nucleosome, pA-Tn5 held on its Fc, and
 * the tethered Tn5 that has just tagmented the neighbouring linker DNA (adapters on the new ends).
 */
function cutTagParts() {
  const Y = 132, cut = 160;
  // pA sits right on the left Tn5 monomer (one fusion protein): a short linker, buried at both ends
  // in the two domains, drawn behind everything
  const pa = [150, 104.5];
  const parts = [{ d: smoothOpen([[pa[0] + 0.5, pa[1] + 6.5], [pa[0] + 1.3, pa[1] + 10.5], [pa[0] + 1.6, pa[1] + 14.5]]), fill: "none", stroke: { color: COL.linker, width: 2.6, cap: "round" } }];
  parts.push(...tn5Bound(cut, Y, 3));
  const ch = chromatin([
    [9, Y + 5], N(30, Y), [52, Y - 4], [62, Y + 1], N(92, Y, { p: -10, tail: { a: -100, len: 20 } }),
    [118, Y + 5], [134, Y + 1], ...cutAt(cut, Y),
    [184, Y + 1], [198, Y + 5], N(222, Y), [242, Y - 4], [249, Y],
  ]);
  parts.push(...ch);
  const mark = ch.marks[0];
  // the antibody's Fc points down-right into the pA domain
  const fc = [pa[0] - 4.4, pa[1] - 2.4];
  const ab = antibody(abBetween([mark[0] - 1, mark[1] - 3.5], fc, 0));
  parts.push(...adapterEnds([[cut, Y]]));
  parts.push(...ab.parts);
  parts.push(paLump(pa[0], pa[1]));
  return parts;
}

/**
 * CUT&RUN: an antibody bound to a chromatin-bound protein (e.g. a transcription factor), pA-MNase
 * held on its Fc; Ca2+-activated MNase has cut the linker DNA on both sides of the bound protein.
 */
function cutRunParts() {
  const Y = 132;
  // MNase has cut the linker DNA on both sides of the bound protein: the released fragment lifts away
  // pA-MNase sits on the left cut it has just made: MNase touches both new DNA ends, pA right above
  // it on a short linker, the antibody's Fc buried in pA
  const mn = [65, Y - 14], pa = [63, Y - 38.5];
  const parts = [{ d: smoothOpen([[pa[0] + 0.4, pa[1] + 6.5], [pa[0] + 1.1, pa[1] + 10.5], [pa[0] + 1.6, pa[1] + 14.5]]), fill: "none", stroke: { color: COL.linker, width: 2.6, cap: "round" } }];
  parts.push(...chromatin([
    [9, Y + 5], N(30, Y), [50, Y - 3], [56.5, Y], "cut",
    [74, Y - 6], [92, Y - 5], [110, Y - 4.5], [128, Y - 4.5], [146, Y - 6], "cut",
    [163, Y - 1], [178, Y - 4], [194, Y - 6], N(218, Y, { p: -10 }), [238, Y + 6.5], [247, Y + 5],
  ]));
  const tf = [128, Y - 18];
  parts.push({ unite: lumpy(tf[0], tf[1], 13, { seed: 7, n: 6 }), fill: COL.tf, shade: "organelle", glossSize: 0.07 });
  const fc = [pa[0] + 4.9, pa[1] - 1];
  const ab = antibody(abBetween([tf[0] - 6, tf[1] - 7], fc, 1));
  parts.push(...ab.parts);
  parts.push(paLump(pa[0], pa[1], 5));
  parts.push({ unite: lumpy(mn[0], mn[1], 10.5, { seed: 11 }), fill: COL.mnase, shade: "organelle", glossSize: 0.08 });
  parts.push({ d: [circle(mn[0] - 19, mn[1] - 5, 3), circle(mn[0] + 17, mn[1] - 13, 2.8), circle(mn[0] - 14, mn[1] - 21, 2.6)], fill: COL.ca, shade: "small" });
  return parts;
}

/** ChIP: crosslinked chromatin fragment, target protein, antibody, protein A/G on a magnetic bead. */
function chipParts({ short = false } = {}) {
  const parts = [];
  // A magnetic bead (1–3 µm) is a huge surface next to an IgG (~15 nm): in the icon it is large and
  // runs off the bottom of the frame (local y 206); in the strip's mini version it is whole.
  const bc = short ? [104, 168] : [104, 182], br = short ? 36 : 51;
  const frame = clipRect(-20, -20, 240, 226);
  if (short) parts.push({ d: circle(bc[0], bc[1], br), fill: COL.magbead, shade: "body", glossAt: [0.28, 0.25] });
  else parts.push(...clippedDisc(bc[0], bc[1], br, COL.magbead, frame, { rim: 0.03, hi: 0.04, hiOp: 0.28 }));
  // protein A/G coupled to the bead surface: small lumpy globules half sunk into it, unevenly spaced
  // and mostly on the upper side; the topmost (larger) one holds the antibody's Fc
  const R = rng(17);
  const span = short ? [158, 382] : [168, 372];
  const angs = unevenSpacing(11, span[1] - span[0], R, { cv: 0.35 }).map((a) => span[0] + a).filter((a) => Math.abs(((a - 270 + 540) % 360) - 180) > 13);
  const glob = angs.map((a, i) => {
    const r = 3.6 + R() * 1.4, d = br - 1;
    return lumpy(bc[0] + Math.cos(a * DEG) * d, bc[1] + Math.sin(a * DEG) * d, r, { n: 5, seed: 30 + i, rot: R() * 360 });
  });
  parts.push({ unite: glob.flat(), fill: COL.pa, shade: "small" });
  const top = [bc[0], bc[1] - br - 1.5];
  const ab = antibody(place({ x: 104, y: top[1] - 41, s: 0.49 }));
  parts.push(...ab.parts);
  parts.push({ unite: lumpy(top[0], top[1], 6.8, { n: 6, seed: 4 }), fill: COL.pa, shade: "organelle", glossSize: 0.08 });
  const tfY = top[1] - 41 - 37;
  parts.push({ unite: lumpy(72, tfY, 13, { seed: 7, n: 6 }), fill: COL.tf, shade: "organelle", glossSize: 0.07 });
  // the strip's mini version keeps just the TF-bound piece so the bead and antibody stay large
  const dy = tfY - 54;
  parts.push(...chromatin((short ? [[34, 40], [72, 37.5], [112, 39]] : [[12, 40], [60, 37], [100, 38], N(146, 34, { rot: -5 }), [188, 30]]).map((k) => (Array.isArray(k) ? [k[0], k[1] + dy] : { ...k, y: k.y + dy }))));
  parts.push(crosslinks([[64, 41.6 + dy], [79.5, 41.4 + dy]]));
  return parts;
}

/* ---------------- lab objects ---------------- */

/**
 * Droplet-microfluidics chip in its holder (Chromium-style, unbranded), seen from the front and
 * above: 8 lanes × (recovery/GEM well, sample + RT mix, gel beads, partitioning oil) and channels.
 */
function chromiumChipParts() {
  const parts = [];
  const sy = 0.6, x0 = 24, y0 = 30, cw = 172, cd = 150;
  // holder: side (darker, offset down) then top face
  parts.push({ d: rect(12, 31.6, 196, 106.8, 8), fill: "#7d8a98" });
  parts.push({ d: rect(12, 21.6, 196, 106.8, 8), fill: "#b9c5d1" }, ...faceShade(12, 21.6, 196, 106.8, 8, "#b9c5d1", { bw: 3.2, light: 0.6 }));
  // chip slab
  parts.push({ d: rect(x0, y0 + 6, cw, cd * sy, 5), fill: "#3f4955" });
  parts.push({ d: rect(x0, y0, cw, cd * sy, 5), fill: "#56616f" }, ...faceShade(x0, y0, cw, cd * sy, 5, "#56616f", { bw: 2.6, hw: 2, dark: 0.07, light: 0.22 }));
  // rows far → near, as on the real chip: GEM recovery wells (top), partitioning oil (row 3),
  // gel beads (row 2), sample + RT master mix (row 1, nearest the user, largest wells)
  const rows = [ // v (depth), rx, liquid colour
    { v: 17, rx: 7.2, col: COL.gem },
    { v: 52, rx: 6.6, col: COL.oilWell },
    { v: 88, rx: 6.4, col: COL.bead },
    { v: 122, rx: 7.6, col: COL.sample },
  ];
  const ys = rows.map((r) => y0 + r.v * sy);
  const lanes = Array.from({ length: 8 }, (_, i) => x0 + 10.75 + i * 21.5);
  // (the microchannels run inside the chip; the icon shows them in a magnifier — chromiumChipIcon)
  const rim = [], hole = [], liq = rows.map(() => []);
  rows.forEach((r, k) => {
    for (const x of lanes) {
      const ry = r.rx * sy;
      rim.push(ellipse(x, ys[k], r.rx + 2, ry + 1.4));
      hole.push(ellipse(x, ys[k], r.rx, ry));
      liq[k].push(ellipse(x, ys[k] + ry * 0.28, r.rx * 0.8, ry * 0.66));
    }
  });
  parts.push({ d: rim.join(""), fill: "#8794a3", shade: "small", thin: true });
  parts.push({ d: hole.join(""), fill: "#2b333d", thin: true });
  rows.forEach((r, k) => parts.push({ d: liq[k].join(""), fill: r.col, shade: "small", thin: true }));
  // label tab on the near edge (clear of the sample wells)
  parts.push({ d: rect(x0 + 60, y0 + cd * sy - 5.6, 52, 4.5, 2.2), fill: "#7d8a98", thin: true });
  return parts;
}

/**
 * The chip in its holder (left, 64 %) and a magnifier (right) on one lane's droplet junction: the
 * gel-bead and cell channels merging, the oil cross, GEMs leaving towards the recovery well.
 */
function chromiumChipIcon() {
  const s = 0.64, dx = 6 - 12 * s, dy = 54 - 80 * s;
  const parts = placeParts(chromiumChipParts(), { dx, dy, s, lw: 2 });
  const W = ([x, y]) => [dx + x * s, dy + y * s];
  // the spot on the last lane, between the oil well and the recovery well
  const q0 = W([185.25 - 8, 30 + 34.5 * 0.6 - 6.5]), q1 = W([185.25 + 8, 30 + 34.5 * 0.6 + 6.5]);
  const L = [186, 54], lr = 40;
  const tang = (deg) => [L[0] + Math.cos(deg * DEG) * (lr + 4), L[1] + Math.sin(deg * DEG) * (lr + 4)];
  parts.push({ d: polyline([[q1[0], q0[1]], tang(203)]) + polyline([[q1[0], q1[1]], tang(157)]), fill: "none", stroke: { color: "#8fa0b0", width: 1.2 }, lineStrokeWidth: 1 });
  parts.push({ d: rect(q0[0], q0[1], q1[0] - q0[0], q1[1] - q0[1], 1.2), fill: "none", stroke: { color: "#eef3f8", width: 1.3 }, lineColor: "#eef3f8", lineStrokeWidth: 1.1 });
  // lens: chip material, then the channels (local window centred on the junction)
  parts.push({ d: circle(L[0], L[1], lr), fill: COL.chipMat, lineWidth: 1.2 });
  const c0 = [63, 46], sj = 0.9;
  const clip = circPts(c0[0], c0[1], (lr + 1.5) / sj, 72);
  parts.push(...placeParts(junctionParts(clip), { dx: L[0] - c0[0] * sj, dy: L[1] - c0[1] * sj, s: sj, lw: 1.6 }));
  // the lens rim: flat, with a soft-only shadow along its outer lower right
  parts.push({ d: ringD(L[0], L[1], lr - 0.5, lr + 4.5), fill: "#c9d3dd", lineWidth: 1.2 });
  parts.push(dim(polyD(lunePts(L[0], L[1], lr + 4.5, -1.6, -1.6, 48)), 0.16));
  return parts;
}

/** Patterned flow cell on its carrier with 4 lanes, and a magnified view of the nanowell array (2-colour SBS). */
function flowCellParts() {
  const parts = [];
  parts.push({ d: rect(12, 24, 196, 70, 9), fill: "#8996a4" });
  parts.push({ d: rect(12, 16, 196, 70, 9), fill: "#c9d3dd" }, ...faceShade(12, 16, 196, 70, 9, "#c9d3dd", { bw: 3, light: 0.6 }));
  // the glass sits in a recess of the carrier: shadow along its top-left edge, light along the bottom right
  parts.push({ d: rect(24, 24, 172, 54, 4), fill: COL.glass });
  parts.push({ d: edgeBand(24, 24, 172, 54, 4, 2.6, { flip: true }), fill: shade(COL.glass, 0.12), line: false });
  const ly = [33.5, 45.5, 57.5, 69.5];
  parts.push({ d: ly.map((y) => capsule(42, y, 178, y, 4.3)).join(""), fill: COL.lane, shade: "small", gloss: false });
  parts.push({ d: ly.flatMap((y) => [circle(33, y, 2.8), circle(187, y, 2.8)]).join(""), fill: "#7f9db4", thin: true });
  parts.push(glow(polyD([[60, 24], [76, 24], [52, 78], [36, 78]]), 0.45), glow(polyD([[82, 24], [88, 24], [64, 78], [58, 78]]), 0.35));
  // magnifier
  const L = [128, 138], lr = 41;
  const sq = [124, 51.5, 12, 12];
  const tang = (deg) => [L[0] + Math.cos(deg * DEG) * (lr + 4), L[1] + Math.sin(deg * DEG) * (lr + 4)];
  parts.push({ d: polyline([[sq[0], sq[1] + sq[3]], tang(196)]) + polyline([[sq[0] + sq[2], sq[1] + sq[3]], tang(-16)]), fill: "none", stroke: { color: "#8fa0b0", width: 1.2 } });
  parts.push({ d: rect(...sq, 1.5), fill: "none", stroke: { color: "#4f6478", width: 1.4 } });
  parts.push({ d: circle(L[0], L[1], lr), fill: "#27384c" });
  const R = rng(11), groups = { g: [], r: [], y: [], o: [] };
  const sp = 10.2;
  // a full hexagonal lattice: the wells at the edge run under the lens rim, which cuts them cleanly
  for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {
    const x = L[0] + (i + (Math.abs(j) % 2) * 0.5) * sp, y = L[1] + j * sp * 0.866;
    if (Math.hypot(x - L[0], y - L[1]) > lr + 1) continue;
    const v = R();
    groups[v < 0.3 ? "g" : v < 0.55 ? "r" : v < 0.75 ? "y" : "o"].push(circle(x, y, 3.6));
  }
  const spot = { g: "#62d36e", r: "#f0605a", y: "#f5d24a", o: "#46596f" };
  for (const k of ["o", "g", "r", "y"]) parts.push({ d: groups[k].join(""), fill: spot[k], shade: k === "o" ? undefined : "small", lineWidth: 0.6 });
  parts.push({ d: ringD(L[0], L[1], lr - 0.5, lr + 5), fill: "#c9d3dd", shade: "small" });
  return parts;
}

/** Bridge amplification on the flow-cell surface: template, single- and double-stranded bridges, then a clonal cluster. */
function bridgeParts() {
  const parts = [];
  const Y = 96, W3 = 3.3;
  parts.push({ d: rect(8, Y + 5, 244, 15, 4), fill: "#a9c6dc" });
  parts.push({ d: rect(8, Y, 244, 15, 4), fill: COL.glass }, ...faceShade(8, Y, 244, 15, 4, COL.glass, { bw: 2.2, hw: 1.6, from: 6, light: 0.8 }));
  const R = rng(4);
  // colour groups: teal = P5 (surface oligo, and the P5' end of forward strands), orange = P7 (and P7')
  const grp = { p5: [], p7: [], fwd: [], rev: [] };
  /**
   * One strand along dense centreline c (surface end first): its foot is the surface oligo it grew
   * from (forward strands from P7, reverse from P5), its free 3' end carries the complement of the
   * other oligo (forward → P5', reverse → P7'), which is what hybridises to the lawn to form a bridge.
   */
  const strand = (c, kind, { foot = 6, tip = 6.5, cap = true } = {}) => {
    const L = arcLengths(c).at(-1), a = foot / L, b = 1 - tip / L;
    const [fc, tc] = kind === "fwd" ? ["p7", "p5"] : ["p5", "p7"];
    grp[fc].push(tubeD(subLine(c, 0, a), W3));
    grp[kind].push(tubeD(subLine(c, a, b), W3));
    grp[tc].push(tubeD(subLine(c, b, 1), W3, { cap1: cap }));
  };
  /** Drop the end of a centreline that comes closer than `clear` to the surface (a free 3' end). */
  const lift = (c, clear = 4.2) => {
    let n = c.length;
    while (n > 2 && c[n - 1][1] > Y - clear) n--;
    return c.slice(0, n);
  };
  // the foot (the surface oligo the strand grew from) always stands upright
  const standing = (x, h, { lean = 0, wig = 0.8, ph = 0 } = {}) =>
    spine([[x, Y + 0.5], [x, Y - 6], [x + Math.sin(ph) * wig + lean * 0.15, Y - h * 0.33], [x - Math.sin(ph + 1) * wig + lean * 0.5, Y - h * 0.66], [x + lean, Y - h]], 1.1);
  const arch = (x0, x1, top) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, u = 1 - t;
      pts.push([u * u * u * x0 + 3 * u * u * t * x0 + 3 * u * t * t * x1 + t * t * t * x1, u * u * u * (Y + 0.5) + 3 * u * u * t * top + 3 * u * t * t * top + t * t * t * (Y + 0.5)]);
    }
    return resample(pts, 1.1);
  };
  /** The same arch offset inwards by k (a parallel strand), running from right foot to left. */
  const inner = (c, k) => {
    const out = c.map((p, i) => {
      const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)], l = dist(a, b) || 1;
      return [p[0] - ((b[1] - a[1]) / l) * k, p[1] + ((b[0] - a[0]) / l) * k];
    }).filter((p) => p[1] <= Y + 0.5);
    return out.reverse();
  };
  // 1 template strand (grown from a P7 oligo) leaning towards a P5 oligo
  strand(standing(22, 52, { lean: 7, ph: 1 }), "fwd");
  // 2 single-stranded bridge: its P5' end hybridised to a surface P5 oligo
  strand(arch(42, 68, Y - 70), "fwd", { cap: false });
  // 3 double-stranded bridge after extension: the forward strand is anchored only at its left foot
  // (its P5' end is paired with the extended P5 oligo, free above the surface); the new reverse
  // strand is that extended oligo, anchored only at the right, its P7' end free above the left foot
  const ds = arch(86, 124, Y - 82);
  strand(lift(ds), "fwd");
  strand(lift(inner(ds, W3 + 1.3)), "rev");
  // 4 clonal cluster after many cycles: forward and reverse copies standing in a dome
  // 4 clonal cluster after many cycles: forward and reverse copies at uneven spacing, each leaning a
  // little (6–10°) with a gentle curve, a couple still bridged (arches) under the dome
  const cx = 194, half = 50, feet = [22, 42, 68, 86, 90.6, 119.4, 124];
  strand(arch(cx - 33, cx - 21, Y - 30), "fwd", { cap: false });
  strand(arch(cx + 14, cx + 27, Y - 34), "rev", { cap: false });
  const xs = unevenSpacing(15, 2 * half - 4, R, { cv: 0.3 }).map((v) => cx - half + 2 + v);
  xs.forEach((x, k) => {
    const t = (x - cx) / half, h = 26 + 50 * Math.sqrt(Math.max(0, 1 - t * t)) * (0.86 + R() * 0.2);
    // the copies fan out from the cluster's middle (a few lean against the trend and cross a neighbour)
    const fan = Math.abs(t) < 0.15 ? (R() < 0.5 ? -1 : 1) : Math.sign(t), lean = (R() < 0.82 ? fan : -fan) * h * Math.tan((6 + R() * 4) * DEG);
    strand(standing(x, h, { wig: 0.9, ph: x * 0.09, lean }), R() < 0.5 ? "rev" : "fwd");
    feet.push(x);
  });
  // lawn of surface oligos (P5 / P7) between the strands: uneven spacing, lengths 6–8
  const lawn = { p5: [], p7: [] };
  for (let x = 12; x < 249; x += 5.4 * (0.65 + R() * 0.7)) {
    if (feet.some((u) => Math.abs(u - x) < 4.2) || (x > cx - half && x < cx + half)) continue;
    lawn[R() < 0.5 ? "p5" : "p7"].push(tubeD(spine([[x, Y + 0.5], [x + (R() - 0.5) * 1.2, Y - 6 - R() * 2]], 1), 2.4, { cap1: true }));
  }
  // flat: the renderer's rim offset scales with the strand length, which on long thin strands leaves
  // light gaps along them
  const ribbon_ = (key, ds2) => ({ unite: ds2, fill: COL[key], thin: true });
  parts.push(ribbon_("p5", [...lawn.p5, ...grp.p5]), ribbon_("p7", [...lawn.p7, ...grp.p7]), ribbon_("fwd", grp.fwd), ribbon_("rev", grp.rev));
  return parts;
}

/** Generic benchtop / production sequencer (unbranded): box in 3/4 view, touchscreen, status light, cartridge door, vents. */
function sequencerParts() {
  const parts = [];
  const a = [26, 66], b = [142, 66], c = [142, 174], d = [26, 174], D = [42, -28];
  const t = (p) => add2(p, D, 1);
  // body: side face (shadow side), top face (lit), front face
  parts.push({ d: roundPoly([a, t(a), t(b), t(c), c, d], 2.5), fill: "#c3cfdb" });
  parts.push({ d: roundPoly([a, t(a), t(b), b], 2.5), fill: "#f1f4f7" });
  parts.push({ d: roundPoly([a, b, c, d], 2.5), fill: "#dfe7ef" }, ...faceShade(26, 66, 116, 108, 2.5, "#dfe7ef", { bw: 3.2, light: 0.7 }));
  // side vents
  parts.push({ d: [0, 1, 2, 3].map((i) => polyline([[152, 122 + i * 8], [174, 108 + i * 8]])).join(""), fill: "none", stroke: { color: "#9fb0c0", width: 2.2, cap: "round" } });
  // flow-cell / reagent bay lid on top
  parts.push({ d: polyD([[70, 56], [118, 56], [134, 45.5], [86, 45.5]]), fill: "#d5dee7", thin: true });
  // status light bar along the whole top edge of the front
  parts.push({ d: capsule(33, 72, 135, 72, 2.2), fill: "#59c3e6", shade: "small", gloss: false });
  // large touchscreen, upper right: a dark run view with per-cycle base-call bars in the four base colours
  parts.push({ d: rect(80, 79, 56, 39, 3.5), fill: "#55626f", shade: "small" });
  parts.push({ d: rect(83.5, 82.5, 49, 32, 2), fill: "#2f3b4a" });
  const bars = [[0.55, "A"], [0.8, "C"], [0.7, "T"], [0.92, "G"], [0.62, "C"], [0.85, "A"], [0.74, "G"], [0.9, "T"]];
  const BC = { A: COL.baseA, C: COL.baseC, G: COL.baseG, T: COL.baseT };
  for (const b of "ACGT") parts.push({ d: bars.map(([h, k], i) => (k === b ? rect(87 + i * 5.6, 111 - h * 19, 3.8, h * 19, 1) : "")).join(""), fill: BC[b], thin: true, lineWidth: 0.5 });
  parts.push({ d: rect(87, 86.5, 42, 2.4, 1.2), fill: "#a9b8c8", thin: true, lineWidth: 0.5 });
  parts.push({ d: circle(37.5, 84, 3.2), fill: "#8fa0b0", shade: "small", thin: true });
  // door with the flow-cell / reagent-cartridge slot: a glass flow cell with its lanes sitting in the slot
  parts.push({ d: rect(32, 123, 104, 45, 4), fill: "#6f7f92" }, ...faceShade(32, 123, 104, 45, 4, "#6f7f92", { bw: 2.6, hw: 2, dark: 0.08, light: 0.3 }));
  parts.push({ d: rect(42, 129.5, 84, 25, 3), fill: "#4b5867", thin: true });
  parts.push({ d: rect(47, 133, 74, 18, 2.5), fill: COL.glass, shade: "small", thin: true });
  parts.push({ d: [137.5, 142, 146.5].map((y) => capsule(55, y, 113, y, 1.6)).join(""), fill: COL.lane, thin: true, lineWidth: 0.5 });
  parts.push({ d: capsule(68, 161, 100, 161, 2), fill: "#c9d4df", shade: "small", gloss: false, thin: true });
  return parts;
}

/** Sequencing reads aligned to a reference: coverage track, stacked reads (strand-coloured) with a heterozygous SNV, reference bases. */
function readsParts() {
  const parts = [];
  const R = rng(7), X0 = 14, X1 = 246, bw = 5.8, nb = 40;
  const seq = Array.from({ length: nb }, () => "ACGT"[Math.floor(R() * 4)]);
  // reads: each row filled left to right (a real pile-up), a few gaps so coverage varies
  const reads = [];
  for (let r = 0; r < 8; r++) {
    let x = X0 - R() * 40;
    while (x < X1 - 12) {
      const len = 42 + R() * 30, x0 = Math.max(X0, x), x1 = Math.min(X1, x + len);
      if (x1 - x0 > 16 && R() > 0.12 + r * 0.03) reads.push({ x0, x1, r, fwd: R() < 0.5 });
      x += len + 4 + R() * 12;
    }
  }
  const yOf = (r) => 56 + r * 10.8, h = 7.6;
  // the variant sits where coverage is deepest
  const covers = (q, bx) => q.x0 < bx - 1 && q.x1 > bx + bw + 1;
  let snp = 8;
  for (let b = 8; b < nb - 8; b++) if (reads.filter((q) => covers(q, X0 + b * bw)).length > reads.filter((q) => covers(q, X0 + snp * bw)).length) snp = b;
  seq[snp] = "G";
  const snpX = X0 + snp * bw;
  // coverage
  const cov = [];
  for (let x = X0; x <= X1; x += 2) cov.push([x, 47 - reads.filter((q) => q.x0 <= x && q.x1 >= x).length * 3.6]);
  parts.push({ d: polyD([[X0, 47], ...cov, [X1, 47]]), fill: "#b4c2d2", thin: true });
  parts.push({ d: polyline([[X0, 50.5], [X1, 50.5]]), fill: "none", stroke: { color: "#c9d3dd", width: 1.2 } });
  // reads point in their strand's direction (no tip where the window clips them)
  const shape = (q) => {
    const y = yOf(q.r), tip = 4;
    if (q.fwd) {
      const end = q.x1 >= X1 - 0.1 ? [[q.x1, y], [q.x1, y + h]] : [[q.x1 - tip, y], [q.x1, y + h / 2], [q.x1 - tip, y + h]];
      return roundPoly([[q.x0, y], ...end, [q.x0, y + h]], 1.4);
    }
    const start = q.x0 <= X0 + 0.1 ? [[q.x0, y + h], [q.x0, y]] : [[q.x0 + tip, y + h], [q.x0, y + h / 2], [q.x0 + tip, y]];
    return roundPoly([...start, [q.x1, y], [q.x1, y + h]], 1.4);
  };
  parts.push({ d: reads.filter((q) => q.fwd).map(shape).join(""), fill: "#f0a9a9", thin: true });
  parts.push({ d: reads.filter((q) => !q.fwd).map(shape).join(""), fill: "#a9c3ec", thin: true });
  // mismatches: the SNV (alt A) in about half the reads, plus two sequencing errors
  const mm = { A: [], C: [], G: [], T: [] };
  let nAlt = 0, nCov = 0;
  reads.forEach((q) => {
    if (!covers(q, snpX)) return;
    if (nCov++ % 2 === 0) { mm.A.push(rect(snpX, yOf(q.r), bw, h)); nAlt++; }
  });
  // the coverage bar at the variant shows the allele split (alt below, ref above)
  const cb = (n) => 47 - n * 3.6;
  mm.A.push(rect(snpX, cb(nAlt), bw, 47 - cb(nAlt)));
  mm.G.push(rect(snpX, cb(nCov), bw, cb(nAlt) - cb(nCov)));
  for (const [qi, b] of [[3, 7], [11, 30]]) {
    const q = reads[qi], x = X0 + b * bw;
    // an error base that contrasts with the read colour (green/blue on red reads, orange/red on blue)
    const alt = q && (q.fwd ? (seq[b] === "C" ? "A" : "C") : (seq[b] === "G" ? "T" : "G"));
    if (q && q.x0 < x - 2 && q.x1 > x + bw + 2) mm[alt].push(rect(x, yOf(q.r), bw, h));
  }
  // reference
  const ref = { A: [], C: [], G: [], T: [] };
  seq.forEach((b, i) => ref[b].push(rect(X0 + i * bw, 150, bw, 11)));
  const BC = { A: COL.baseA, C: COL.baseC, G: COL.baseG, T: COL.baseT };
  for (const b of "ACGT") {
    const ds = [...ref[b], ...mm[b]];
    if (ds.length) parts.push({ d: ds.join(""), fill: BC[b], thin: true });
  }
  return parts;
}

/* ---------------- cell preparation ---------------- */

/** Microtube with dissociated cells floating in the liquid. */
function cellTube(cx, y0, s, { seed = 4, n = 14 } = {}) {
  const tube = microtube(cx, y0, { s, liquid: "#f7d9e2", level: 0.3 });
  const R = rng(seed + 1);
  const pts = packWhere({ x: cx - 26 * s, y: tube.level + 4 * s, w: 52 * s, h: 125 * s }, n, 8.3 * s, ([x, y]) => Math.abs(x - cx) < widthAt(tube.lk, y) - 4 * s && y < y0 + 122 * s, { seed });
  const cells = { d: pts.map(([x, y]) => circle(x, y, (2.9 + R() * 0.6) * s)).join(""), fill: COL.cell, shade: "small", thin: true };
  return { tube, parts: [...tube.body, cells, ...tube.top] };
}

/** Tube of dissociated cells with a magnified view of single cells in suspension. */
function suspensionParts() {
  const parts = [];
  parts.push(...cellTube(56, 50, 0.9).parts);
  // magnifier
  const L = [144, 116], lr = 46;
  const spot = [58, 132];
  const tang = (deg) => [L[0] + Math.cos(deg * DEG) * (lr + 3), L[1] + Math.sin(deg * DEG) * (lr + 3)];
  parts.push({ d: polyline([[spot[0] + 3, spot[1] - 8], tang(-128)]) + polyline([[spot[0] + 4, spot[1] + 8], tang(146)]), fill: "none", stroke: { color: "#9fb0c0", width: 1.3 } });
  parts.push({ d: circle(spot[0], spot[1], 9), fill: "none", stroke: { color: "#7f93a8", width: 1.4 } });
  parts.push({ d: circle(L[0], L[1], lr), fill: "#fbeff3" });
  const kinds = [COL.cell, COL.cell2, COL.cell3, COL.cell4];
  const cells = [[124, 92, 13], [163, 89, 12], [138, 124, 14], [174, 128, 11.5], [117, 141, 10.5], [155, 154, 11]];
  const bodies = kinds.map(() => []), nucs = [];
  cells.forEach(([x, y, r], i) => {
    const c = cellShapes(x, y, r, 30 + i * 3);
    bodies[i % 4].push(c.body);
    nucs.push(c.nuc);
  });
  kinds.forEach((k, i) => parts.push({ d: bodies[i], fill: k, shade: "organelle", glossSize: 0.06 }));
  parts.push({ d: nucs, fill: COL.nuc, shade: "small" });
  parts.push({ d: ringD(L[0], L[1], lr - 0.5, lr + 4.5), fill: "#c9d3dd", shade: "small" });
  return parts;
}

/** Nuclei released from lysed cells: a cell with a torn membrane losing its nucleus, and free isolated nuclei. */
function nucleiParts() {
  const parts = [];
  const C = [72, 76], r = 50;
  const outline = catmull(blobPts(C[0], C[1], r, r * 0.92, { n: 9, wobble: 0.08, seed: 12 }), 10, true);
  const sL = arcLengths(outline), tot = sL[sL.length - 1];
  const seg = (a, b) => outline.filter((_, i) => sL[i] >= a * tot && sL[i] <= b * tot);
  parts.push({ d: polyD(outline), fill: tint(COL.cell, 0.03), opacity: 0.85, lineColor: flat(tint(COL.cell, 0.03)) });
  // what is left of the plasma membrane: torn pieces that taper to their torn ends
  const keep = [[0.0, 0.07], [0.62, 0.78], [0.83, 0.97], [0.36, 0.5]];
  const mem = shade(COL.cell, 0.12);
  parts.push({ d: keep.map(([a, b]) => taperTubeD(spine(seg(a, b), 1.2), 3.8, { end: 0.3 })).join(""), fill: mem, shade: "rim", gloss: false, highlight: false, thin: true });
  // membrane fragments drifting away: smooth arcs with the cell's own curvature (r ≈ 50), tapering,
  // and a few small membrane vesicles
  const arcPiece = ([mx, my], ang, len, bendSide = 1, r = 50) => {
    const u = [Math.cos(ang * DEG), Math.sin(ang * DEG)], v = [-u[1] * bendSide, u[0] * bendSide], pts = [];
    for (let i = 0; i <= 16; i++) {
      const sl = -len / 2 + (len * i) / 16, th = sl / r;
      pts.push(add2(add2([mx, my], u, r * Math.sin(th)), v, r * (1 - Math.cos(th))));
    }
    return taperTubeD(resample(pts, 1), 2.6, { end: 0.35, min: 0.3 });
  };
  parts.push({ d: [arcPiece([138, 30], -8, 26, 1), arcPiece([36, 158], 30, 22, 1), arcPiece([126, 187], 4, 16, -1), arcPiece([184, 112], 80, 28, -1)].join(""), fill: mem, shade: "rim", gloss: false, highlight: false, thin: true });
  parts.push({ d: [ringD(186, 72, 3.5, 5.2), ringD(34, 128, 2.9, 4.4), ringD(96, 183, 3.2, 4.8)].join(""), fill: mem, shade: "rim", gloss: false, highlight: false, thin: true });
  parts.push({ d: [circle(110, 40, 2.6), circle(160, 186, 2.2)].join(""), fill: COL.cell, shade: "small", thin: true });
  // cytoplasmic remnants (mitochondria) left in the ghost and drifting out
  // (Servier-style: orange outer membrane, lighter matrix, cristae folding in from alternate sides)
  const mitos = [[38, 62, 54, 54, 5], [44, 96, 60, 102, 4.6], [12, 100, 20, 112, 4]];
  parts.push({ d: mitos.map((m) => capsule(...m)).join(""), fill: "#ef9a78", shade: "small", thin: true });
  parts.push({ d: mitos.map(([x1, y1, x2, y2, r]) => capsule(x1, y1, x2, y2, r * 0.66)).join(""), fill: "#f9c6a6", thin: true, lineWidth: 0.5 });
  const cristae = mitos.flatMap(([x1, y1, x2, y2, r]) => {
    const l = Math.hypot(x2 - x1, y2 - y1), u = [(x2 - x1) / l, (y2 - y1) / l], v = [-u[1], u[0]];
    return [-0.75, -0.25, 0.25, 0.75].map((t, i) => {
      const side = i % 2 ? 1 : -1, c = [(x1 + x2) / 2 + (u[0] * t * (l + r)) / 2, (y1 + y2) / 2 + (u[1] * t * (l + r)) / 2];
      return polyline([add2(c, v, side * r * 0.95), add2(c, v, side * r * 0.12)]);
    });
  });
  parts.push({ d: cristae.join(""), fill: "none", stroke: { color: "#e07f5c", width: 1.15, cap: "round" }, lineStrokeWidth: 0.8 });
  // the escaping nucleus (lower right of the torn cell) and free nuclei
  parts.push(...nucleusParts(104, 104, 24, 5));
  parts.push(...nucleusParts(156, 58, 22, 9));
  parts.push(...nucleusParts(150, 148, 24, 13));
  parts.push(...nucleusParts(66, 152, 20, 17));
  return parts;
}

/* ---------------- charts ---------------- */

/** L-shaped axes with ticks (no labels). */
function axes(x0, y0, x1, y1, { xt = [], yt = [], color = COL.axis, w = 1.6 } = {}) {
  let d = polyline([[x0, y1], [x0, y0], [x1, y0]]);
  for (const x of xt) d += polyline([[x, y0], [x, y0 + 4.5]]);
  for (const y of yt) d += polyline([[x0, y], [x0 - 4.5, y]]);
  return { d, fill: "none", stroke: { color, width: w, cap: "round" }, lineStrokeWidth: w };
}

/** UMAP-style embedding: clusters of cells (dots), one colour per cluster. */
function umapParts({ x0 = 22, y0 = 180, s = 1, dotR = 2.15, minD = 1.2, axesOn = true, density = 1.2 } = {}) {
  const parts = [];
  if (axesOn) parts.push(axes(x0, y0, x0 + 166, y0 - 166, { xt: [x0 + 50, x0 + 100, x0 + 150], yt: [y0 - 50, y0 - 100, y0 - 150] }));
  // Each cluster is a 2-D Gaussian cloud along a centreline (a point for round clusters, a bent arc
  // for continua): dense core, sparse edge, dots allowed to overlap a little. In the 200 × 200 frame.
  const cl = [ // centreline, spread across (sd), spread along (for round ones), dots, rotation
    { c: [[66, 56]], sd: [10.5, 6.8], rot: 25, n: 125 },
    { c: [[140, 46]], sd: [9.5, 5.6], rot: -28, n: 90 },
    { c: [[158, 104]], sd: [6.6, 10], rot: 8, n: 92 },
    { c: [[30, 94], [36, 113], [52, 127], [78, 133]], sd: [4], n: 92 }, // curved continuum
    { c: [[92, 166], [106, 152], [126, 147], [148, 156]], sd: [3.6], n: 70 }, // bent arc
    { c: [[104, 94]], sd: [4.4, 3.8], n: 34 },
    { c: [[170, 158]], sd: [4.4, 3.5], rot: 20, n: 32 },
    { c: [[44, 160]], sd: [2.9, 2.6], n: 16 },
  ];
  const R = rng(61);
  const gauss = () => { const u = Math.max(1e-6, R()), v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const inFrame = ([x, y]) => x > 30 && x < 192 && y > 16 && y < 172;
  const placed = [];
  const fits = (p) => inFrame(p) && placed.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) >= minD);
  const sample = (k, count) => {
    const { c, sd, rot = 0 } = cl[k], out = [];
    const line = c.length > 1 ? resample(catmull(c, 12), 1) : null;
    for (let t = 0; out.length < count && t < count * 60; t++) {
      let p;
      if (line) {
        // along the arc denser in the middle, thinning to the ends; across it Gaussian
        const u = (R() + R() + R()) / 3, i = Math.min(line.length - 2, Math.floor(u * (line.length - 1)));
        const a = line[i], b = line[i + 1], l = dist(a, b) || 1, g = gauss() * sd[0] * (1 - 0.5 * Math.abs(u - 0.5));
        p = [a[0] - ((b[1] - a[1]) / l) * g, a[1] + ((b[0] - a[0]) / l) * g];
      } else {
        p = rotate([c[0][0] + gauss() * sd[0], c[0][1] + gauss() * sd[1]], c[0][0], c[0][1], rot);
      }
      if (fits(p)) { out.push(p); placed.push(p); }
    }
    return out;
  };
  const groups = cl.map((_, k) => sample(k, Math.round(cl[k].n * density)));
  // a thin trajectory of cells bridging two related clusters (green → pink), and a few stray cells
  const bridge = [[160, 124], [162, 130], [163.5, 136], [165, 141], [166.5, 146], [168, 150.5]];
  for (const p of bridge) if (fits(p)) { groups[2].push(p); placed.push(p); }
  const strays = [[0, [100, 72]], [1, [176, 72]], [3, [86, 104]], [2, [128, 122]], [4, [70, 150]]];
  for (const [k, p] of strays) if (fits(p)) { groups[k].push(p); placed.push(p); }
  const map = ([x, y]) => [x0 + (x - 22) * s, y0 + (y - 180) * s];
  // chart marks are flat (as in the dot plot): fill + a fine outline one step darker
  groups.forEach((pts, i) => parts.push({ d: pts.map((p) => circle(...map(p), dotR)).join(""), fill: CLU[i], stroke: { color: shade(CLU[i], 0.15), width: 0.4 * s * (dotR / 2.15) }, lineColor: shade(CLU[i], 0.2), lineWidth: 0.45 }));
  return parts;
}

/** Dot plot of marker genes: columns genes, rows clusters; dot size = % expressing, colour = mean expression. */
function dotPlotParts() {
  const parts = [];
  const nG = 8, nC = 6, gx = (j) => 40 + j * 20, cy = (i) => 24 + i * 24;
  parts.push(axes(24, 160, 196, 10, { xt: Array.from({ length: nG }, (_, j) => gx(j)), yt: Array.from({ length: nC }, (_, i) => cy(i)) }));
  const levels = ["#e4e6ef", "#c3c3e6", "#9c92d6", "#7462c2", "#4b3a9e"];
  const R = rng(21), home = [0, 0, 1, 2, 3, 3, 4, 5];
  const byLevel = levels.map(() => []);
  for (let i = 0; i < nC; i++) for (let j = 0; j < nG; j++) {
    const own = home[j] === i, near = Math.abs(home[j] - i) === 1 && R() < 0.35;
    const frac = own ? 0.7 + R() * 0.3 : near ? 0.3 + R() * 0.25 : 0.04 + R() * 0.2;
    const expr = own ? 0.75 + R() * 0.25 : near ? 0.35 + R() * 0.2 : R() * 0.25;
    const rr = 8.6 * Math.sqrt(frac);
    if (rr < 1.6) continue;
    byLevel[Math.min(4, Math.floor(expr * 5))].push(circle(gx(j), cy(i), rr));
  }
  // chart marks stay flat (no 3-D shading, which would distort the encoded size and colour):
  // a flat fill with a fine outline one step darker, in both styles
  const mark = (d, fill) => ({ d, fill, stroke: { color: shade(fill, 0.12), width: 0.6 }, lineColor: shade(fill, 0.2), lineWidth: 0.6 });
  byLevel.forEach((ds, k) => ds.length && parts.push(mark(ds.join(""), levels[k])));
  // legend: stepped colour bar and size key
  levels.forEach((c, k) => parts.push({ d: rect(206, 92 - k * 13, 10, 13), fill: c, thin: true, lineWidth: 0.6 }));
  parts.push(mark([circle(211, 116, 2.2), circle(211, 129, 4), circle(211, 146, 6.2)].join(""), "#b9bfcc"));
  return parts;
}

/** Violin plots (one per group) with box (IQR) and median. */
function violinParts() {
  const parts = [];
  const yTop = 18, yBot = 152;
  parts.push(axes(22, 160, 194, 10, { yt: [40, 80, 120] }));
  const groups = [
    { x: 56, col: "#6ea8e0", mix: [[118, 14, 1], [80, 10, 0.35]] },
    { x: 96, col: "#f2a65a", mix: [[70, 18, 1], [122, 9, 0.3]] },
    { x: 136, col: "#79c27a", mix: [[104, 22, 1]] },
    { x: 174, col: "#a98bd8", mix: [[52, 12, 0.9], [96, 16, 0.6], [136, 8, 0.25]] },
  ];
  const boxes = [], lines = [];
  for (const g of groups) {
    const dens = (y) => g.mix.reduce((a, [m, sd, w]) => a + w * Math.exp(-0.5 * ((y - m) / sd) ** 2), 0);
    const ys = [];
    for (let y = yTop; y <= yBot; y += 2) ys.push(y);
    const mx = Math.max(...ys.map(dens));
    // trimmed at the data range; the thin tails keep a half-width of 1.6 and end in a round tip
    const pts = ys.map((y) => [y, (15.5 * dens(y)) / mx]).filter(([, w]) => w > 0.25).map(([y, w]) => [y, Math.max(1.6, w)]);
    const y0 = pts[0][0], y1 = pts[pts.length - 1][0];
    const tipB = Array.from({ length: 7 }, (_, i) => { const a = (i / 6) * Math.PI; return [g.x + Math.cos(a) * 1.6, y1 + Math.sin(a) * 1.6]; });
    const tipT = Array.from({ length: 7 }, (_, i) => { const a = Math.PI + (i / 6) * Math.PI; return [g.x + Math.cos(a) * 1.6, y0 + Math.sin(a) * 1.6]; });
    const right = pts.map(([y, w]) => [g.x + w, y]), left = pts.map(([y, w]) => [g.x - w, y]).reverse();
    // chart marks are flat: fill + a fine outline in the same hue (the line style outlines it too)
    parts.push({ d: polyD(catmull([...right.slice(0, -1), ...tipB, ...left.slice(1, -1), ...tipT.slice(0, -1)], 3, true)), fill: g.col, stroke: { color: shade(g.col, 0.15), width: 0.6 } });
    // quartiles from the density
    const cdf = [];
    let acc = 0;
    for (const y of ys) { acc += dens(y); cdf.push([y, acc]); }
    const q = (p) => cdf.find(([, v]) => v >= p * acc)[0];
    const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
    boxes.push(rect(g.x - 3.2, q1, 6.4, q3 - q1, 1.6));
    lines.push(polyline([[g.x, q(0.05)], [g.x, q1]]) + polyline([[g.x, q3], [g.x, q(0.95)]]));
    lines.push(polyline([[g.x - 3.2, q2], [g.x + 3.2, q2]]));
  }
  parts.push({ d: lines.join(""), fill: "none", stroke: { color: "#3d4a5a", width: 1.4, cap: "butt" } });
  parts.push({ d: boxes.join(""), fill: "#f4f6f8", thin: true, lineWidth: 0.9 });
  parts.push({ d: lines.filter((_, i) => i % 2 === 1).join(""), fill: "none", stroke: { color: "#3d4a5a", width: 1.6, cap: "butt" } });
  return parts;
}

/* ---------------- workflow strips ---------------- */

function boundsOf(parts) {
  return pathBox(parts.flatMap((p) => p.unite || (Array.isArray(p.d) ? p.d : [p.d])).filter(Boolean));
}

/** A piece of tissue (biopsy / synovium chunk) as a small block: top face with nuclei and a vessel, cut side. */
function tissueMini() {
  const top = blobPts(50, 30, 44, 19, { n: 10, wobble: 0.08, seed: 3 });
  const xs = top.map((p) => p[0]), x0 = Math.min(...xs), x1 = Math.max(...xs);
  const topD = smoothClosed(top), sideD = smoothClosed(top.map(([x, y]) => [x, y + 15]));
  const nucs = scatter(50, 30, 34, 12, 11, { seed: 5, minDist: 8, avoid: [[66, 26, 9]] });
  return [
    { unite: [topD, sideD, rect(x0 + 1.5, 26, x1 - x0 - 3, 19)], fill: "#e7a0b5", shade: "body", gloss: false },
    { d: [ellipse(30, 47, 2.4, 1.6), ellipse(52, 51, 2.4, 1.6), ellipse(74, 47, 2.4, 1.6), ellipse(41, 52, 2, 1.4), ellipse(63, 51.5, 2, 1.4)].join(""), fill: COL.nucleolus, opacity: 0.7, thin: true },
    { d: topD, fill: "#f6cfd8", shade: "organelle", gloss: false },
    { d: nucs.map(([x, y], i) => ellipse(x, y, 3.2, 2.2, i * 40)).join(""), fill: "#8b63b3", shade: "small", thin: true },
    { d: ellipse(66, 26, 6.4, 4.4), fill: "#e3828b", shade: "small", thin: true },
    { d: ellipse(66, 26, 3.8, 2.4), fill: "#fdebe9", thin: true },
  ];
}

/**
 * Droplet generator (a cross junction) in local coordinates, cut to the convex polygon `clip`:
 * gel beads arrive as a close-packed, touching train in their own aqueous channel (blue); cells arrive
 * sparsely in a separate channel (pink) that merges with it just before the cross; partitioning oil
 * (yellow) from both sides pinches off droplets (GEMs) that leave on the right — each with one bead
 * (lower left, ~60 % of the droplet) and at most one cell (upper right, about half the bead).
 */
function junctionParts(clip) {
  const y = 44, J = 62, rb = 5.6, rc = 2.9, rd = 9.5;
  const box = (x0, y0, x1, y1) => rectPoly(x0, y0, x1 - x0, y1 - y0);
  const cut = (polys) => polys.map((p) => clipConvex(p, clip)).filter((p) => p.length > 2).map(polyD);
  const disc = (x, yy, r) => circPts(x, yy, r, 36);
  const parts = [];
  // oil: the two side channels crossing the aqueous stream, and the outlet carrying the droplets
  parts.push({ unite: cut([box(J - 7, -60, J + 7, 150), box(J - 1, y - 10, 260, y + 10)]), fill: COL.oilWell, thin: true });
  // cell channel, coming in from the lower left (drawn first: it flows into the bead channel)
  const A = [10, y + 56], Bm = [J - 18, y + 1], l = dist(A, Bm), u = [(Bm[0] - A[0]) / l, (Bm[1] - A[1]) / l], v = [-u[1], u[0]];
  const band = [add2(A, v, 5), add2(Bm, v, 5), add2(Bm, v, -5), add2(A, v, -5)];
  parts.push({ unite: cut([band]), fill: COL.sampleChan, thin: true });
  // bead channel ending in the aqueous finger that the oil pinches off
  const bez = (p0, p1, p2, p3) => Array.from({ length: 11 }, (_, i) => {
    const t = i / 10, s = 1 - t;
    return [0, 1].map((k) => s * s * s * p0[k] + 3 * s * s * t * p1[k] + 3 * s * t * t * p2[k] + t * t * t * p3[k]);
  });
  const finger = [[-60, y - 6.5], ...bez([J - 9, y - 6.5], [J - 2, y - 6.5], [J + 3, y - 3.6], [J + 4, y]), ...bez([J + 4, y], [J + 3, y + 3.6], [J - 2, y + 6.5], [J - 9, y + 6.5]).slice(1), [-60, y + 6.5]];
  parts.push({ unite: cut([finger]), fill: COL.bcChan, thin: true });
  // droplets in the outlet: each its own shape, so each gets its own rim
  const drops = [[J + 19.5, true], [J + 40, false], [J + 60.5, true]];
  const dd = cut(drops.map(([x]) => disc(x, y, rd)));
  if (dd.length) parts.push({ d: dd, fill: COL.droplet, shade: "small" });
  // beads: the touching train (one already in the finger), and one per droplet
  const beads = [[J - 1.5, y + 0.4]];
  for (let k = 1; k < 9; k++) beads.push([J - 1.5 - k * 2 * rb, y + (k % 2 ? -0.3 : 0.3)]);
  for (const [x] of drops) beads.push([x - 2.4, y + 2.3]);
  const bd = cut(beads.map(([x, yy]) => disc(x, yy, rb)));
  if (bd.length) parts.push({ d: bd.join(""), fill: COL.bead, shade: "small", thin: true });
  // cells: sparse in their channel, and one in two of the three droplets
  const cells = [add2(A, u, 30), add2(add2(A, u, 49), v, 1.2)];
  for (const [x, has] of drops) if (has) cells.push([x + 4.3, y - 4.2]);
  const cd = cut(cells.map(([x, yy]) => disc(x, yy, rc)));
  if (cd.length) parts.push({ d: cd.join(""), fill: COL.cell, shade: "small", thin: true });
  return parts;
}

/** Droplet generation at a microfluidic cross junction, as a chip piece for the workflow strip. */
function junctionMini() {
  const parts = [{ d: rect(2, 4, 132, 80, 8), fill: COL.chipMat }, ...faceShade(2, 4, 132, 80, 8, COL.chipMat, { bw: 3.4, hw: 2.6, light: 0.6 })];
  parts.push(...junctionParts(rectPoly(2, 4, 132, 80)));
  return parts;
}

/** Inside the droplet: the cell is lysed, poly(A) mRNAs hybridise to the bead's barcoded oligos, RT makes cDNA. */
function rtMini() {
  const D = [50, 50], DR = 44;
  const parts = [{ d: circle(D[0], D[1], DR), fill: COL.droplet, shade: "body", glossAt: [0.22, 0.2] }];
  const bc = [45, 55], br = 19;
  const mb = miniBead(bc[0], bc[1], br, { seed: 8, n: 17, reach: [0.55, 0.14], w: 2.5 });
  parts.push(...mb);
  // mRNAs from the lysed cell, captured: each poly(A) 3' end (green) pairs alongside a poly(dT) tip,
  // the body runs on past the oligo's end and curls away, 5' cap on two of them
  const R = rng(19);
  const keep = (p) => { const d = dist(p, D), m = DR - 3.5; return d <= m ? p : [D[0] + ((p[0] - D[0]) * m) / d, D[1] + ((p[1] - D[1]) * m) / d]; };
  const sa = (t) => ((t.a + 540) % 360) - 180; // −180…180, 0 = right, −90 = up
  const pick = [...mb.tips].filter((t) => sa(t) > -150 && sa(t) < 20).sort((a, b) => sa(a) - sa(b));
  const chosen = [pick[0], pick[Math.round(pick.length * 0.36)], pick[Math.round(pick.length * 0.66)], pick[pick.length - 1]];
  const polyA = [], body = [], caps = [], mpts = [];
  chosen.forEach((t, i) => {
    const c = t.c, n = c.length, ts = t.t0 + (1 - t.t0) * 0.66;
    const tip = c[n - 1], uu = [(tip[0] - c[n - 3][0]) / dist(tip, c[n - 3]), (tip[1] - c[n - 3][1]) / dist(tip, c[n - 3])];
    const side = i % 2 ? 1 : -1, vv = [-uu[1] * side, uu[0] * side], off = 2.4;
    const pa = subLine(c, ts, 1).map((p) => add2(p, vv, off));
    const e = add2(tip, vv, off);
    polyA.push(tubeD(pa, 2.3, { cap0: true }));
    const len = 14 + R() * 10, curl = (R() < 0.5 ? 1 : -1) * (0.9 + R() * 0.6), sb = i === 1;
    const k = [add2(e, uu, -0.6), add2(e, uu, 3)];
    let dir = Math.atan2(uu[1], uu[0]), p = k[1];
    for (let j = 0; j < 4; j++) { dir += curl * 0.36 * (sb && j > 1 ? -1.3 : 1); p = add2(p, [Math.cos(dir), Math.sin(dir)], len / 4); k.push(keep(p)); }
    const cl = spine(k, 0.8);
    body.push(tubeD(cl, 2.5, { cap1: true }));
    mpts.push(...cl, ...pa);
    if (i % 2 === 0) caps.push(circle(...cl[cl.length - 1], 2.1));
  });
  parts.push({ d: body.join(""), fill: COL.mrna, shade: "rim", gloss: false, highlight: false, thin: true });
  parts.push({ d: polyA.join(""), fill: COL.polyA, shade: "rim", gloss: false, highlight: false, thin: true });
  parts.push({ d: caps.join(""), fill: COL.cap5, shade: "small", thin: true });
  // reverse transcriptase (lilac, as in the GEM icon) in the free space
  const ez = freeSpots(D[0], D[1], DR - 7, 3, (p) => dist(p, bc) > br * 1.75 + 5 && dist(p, D) < DR - 7 && mpts.every((q) => dist(p, q) > 7.5), { seed: 5, gap: 18 });
  parts.push({ unite: ez.flatMap(([x, y], i) => lumpy(x, y, 5, { n: 6, seed: 9 + i, rot: i * 61 })), fill: COL.enzyme, shade: "small", thin: true });
  return parts;
}

/** Final 3' library molecules: P5 — Read 1 — cell barcode — UMI — poly(dT) — cDNA insert — Read 2 — i7 — P7. */
function libraryMini({ segs = null, inserts = [36, 22, 46, 28] } = {}) {
  const S = segs || [["p5", 6], ["r1", 14], ["bc", 9], ["umi", 7], ["polyT", 8], ["insert", 0], ["r2", 10], ["i7", 7], ["p7", 6]];
  const by = {};
  inserts.forEach((L, k) => {
    let x = 4 + (k % 2) * 3;
    for (const [key, w0] of S) {
      const w = key === "insert" ? L : w0;
      (by[key] = by[key] || []).push(rect(x, 6 + k * 15, w, 8.5, 1.2));
      x += w;
    }
  });
  return Object.entries(by).map(([k, ds]) => ({ d: ds.join(""), fill: COL[k], shade: "small", thin: true }));
}

/** Tagmented ATAC fragments: DNA with a red adapter on one end and a yellow one on the other. */
function atacFragmentsMini() {
  return libraryMini({ segs: [["ad1", 12], ["insert", 0], ["ad2", 12]], inserts: [44, 30, 54, 36] }).map((p) => (p.fill === COL.insert ? { ...p, fill: COL.dna } : p));
}

/** Genome track: coverage peaks over a gene model. */
function peaksMini({ peaks = [[22, 4, 0.55], [52, 3.2, 1], [80, 4, 0.4], [104, 3, 0.75]], color = COL.dna, amp = 40 } = {}) {
  const base = 10 + amp, pts = [], g = base + 14;
  for (let x = 4; x <= 116; x += 1.5) {
    const v = peaks.reduce((a, [m, sd, h]) => a + h * Math.exp(-0.5 * ((x - m) / sd) ** 2), 0);
    pts.push([x, base - 2 - Math.min(1.05, v) * amp]);
  }
  return [
    { d: polyD([[4, base], ...pts, [116, base]]), fill: color, thin: true },
    { d: polyline([[4, base + 0.8], [116, base + 0.8]]), fill: "none", stroke: { color: COL.axis, width: 1.4 } },
    { d: polyline([[14, g], [108, g]]), fill: "none", stroke: { color: "#4f6478", width: 1.6 } },
    { d: [rect(16, g - 5, 10, 10, 1), rect(40, g - 5, 7, 10, 1), rect(58, g - 5, 12, 10, 1), rect(84, g - 5, 6, 10, 1), rect(98, g - 5, 10, 10, 1)].join(""), fill: "#4f6478", thin: true },
  ];
}

/** Open chromatin being tagmented (compact version of the ATAC icon). */
function tagmentMini() {
  const Y = 86;
  // the spent dimer sits on the cut it made, holding the two new adapter-tagged ends
  const parts = [...tn5Bound(72.5, Y, 2, 0.84)];
  // a wide cut (16 units) so it still reads as a gap after the strip scales this step down
  parts.push(...chromatin([[4, Y + 6], N(26, Y), [44, Y - 3], [52, Y], ...cutAt(72.5, Y, 16), [95, Y + 2], N(122, Y, { p: -10 }), [146, Y + 6]]));
  parts.push(...adapterEnds([[72.5, Y]], { g: 16 }));
  parts.push(...xform(tn5Local({ seed: 9 }), place({ x: 112, y: 36, s: 0.86, rot: 8 })));
  return parts;
}

/** Chromatin with a bound transcription factor, crosslinked (formaldehyde). */
function crosslinkMini() {
  // a looped stretch of chromatin (arched, so the step is as tall as its neighbours): nucleosomes
  // on both legs, the transcription factor bound on the top linker, × = formaldehyde crosslinks
  const T = 30;
  const parts = [{ unite: lumpy(62, T - 13, 12, { seed: 7, n: 6 }), fill: COL.tf, shade: "organelle", glossSize: 0.07 }];
  parts.push(...chromatin([[2, 86], N(20, 64, { rot: -35 }), [38, 42], [50, T + 2], [62, T], [74, T + 2], [88, 40], N(104, 62, { rot: 35, p: -10 }), [122, 86]]));
  parts.push(crosslinks([[55, T - 0.5], [69, T - 0.5], [11.5, 57.5, 218], [112.5, 56.5, -38]]));
  return parts;
}

/** Sheared chromatin fragments (sonication). */
function shearedMini() {
  const parts = [{ unite: lumpy(78, 54, 11, { seed: 7, n: 6 }), fill: COL.tf, shade: "organelle", glossSize: 0.07 }];
  const frags = [
    [[4, 22], N(30, 18), [54, 22]],
    [[52, 70], [70, 66], [86, 66], [104, 70]],
    [[18, 104], N(44, 100, { p: -10 }), [70, 106]],
  ];
  for (const f of frags) parts.push(...chromatin(f));
  parts.push(crosslinks([[71, 66.5], [85, 66.5], [30, 4.5], [44, 86.5]]));
  return parts;
}

/** Purified DNA fragments (crosslinks reversed, proteins digested). */
function dnaFragmentsMini() {
  // lengths 20–45, different bends and tilts, two with an S-bend
  const cs = [
    [[8, 14], [18, 9], [30, 9]],
    [[44, 30], [56, 22], [70, 26], [84, 20]],
    [[4, 52], [16, 44], [32, 42], [46, 48]],
    [[62, 52], [70, 58], [82, 60]],
    [[14, 84], [26, 76], [38, 82], [50, 76], [60, 78]],
  ].map((k) => spine(k, 1.2));
  return [{ d: cs.map((c) => tubeD(c, 7, { cap0: true, cap1: true })).join(""), fill: COL.dna, thin: true }, ...tubeStripes(cs, 7)];
}

/**
 * Lay out workflow steps left → right, each scaled to fit a cell (and `maxS`), with block arrows between.
 * steps: [{ parts, scale? (relative weight of the cell, default 1), maxS? }]
 */
function strip(steps, { W = 520, H = 150, aw = 16, pad = 6, ch = 118, vpad = 9, fitH = true } = {}) {
  const gap = 5, n = steps.length;
  const wsum = steps.reduce((a, st) => a + (st.w || 1), 0);
  const unit = (W - 2 * pad - (n - 1) * (aw + 2 * gap)) / wsum;
  const parts = [];
  let x = pad;
  const arrows = [];
  steps.forEach((st, i) => {
    const cw = unit * (st.w || 1), b = boundsOf(st.parts);
    const s = Math.min(cw / b.w, ch / b.h, st.maxS ?? Infinity);    const dx = x + cw / 2 - (b.x + b.w / 2) * s, dy = H / 2 - (b.y + b.h / 2) * s + (st.dy || 0);
    parts.push(...placeParts(st.parts, { dx, dy, s, lw: 1.15 / s }));
    x += cw;
    if (i < n - 1) { arrows.push(arrowD(x + gap, x + gap + aw, H / 2, 7.5, 2)); x += aw + 2 * gap; }
  });
  parts.push(arrowPart(arrows));
  if (!fitH) return { size: [W, H], lineWidth: 1.6, parts };
  // trim the empty bands above and below: the strip is as tall as its tallest step plus a margin
  const b = boundsOf(parts), H2 = Math.ceil(Math.min(H, b.h + 2 * vpad));
  const moved = placeParts(parts, { dy: (H2 - b.h) / 2 - b.y, s: 1 }).map((q, i) => ({ ...q, lineWidth: parts[i].lineWidth }));
  return { size: [W, H2], lineWidth: 1.6, parts: moved };
}

/* ---------------- icon scenes ---------------- */


/* ---------------- icons ---------------- */

const SEQ_TAGS = ["sequencing", "next-generation sequencing", "NGS", "high-throughput sequencing", "DNA sequencing", "short-read sequencing", "genomics"];
const EPI_TAGS = ["epigenomics", "epigenetics", "chromatin", "nucleosome", "histone", "DNA", "sequencing", "NGS", "genomics"];
const SC_TAGS = ["single-cell RNA-seq", "scRNA-seq", "single cell", "droplet", "10x Genomics", "Chromium", "GEM-X", "Next GEM", "microfluidics"];

export const icons = [
  {
    slug: "barcoded-gel-bead", name: "Barcoded gel bead (hydrogel bead with capture oligos)", category: "methods",
    tags: [...SC_TAGS, "gel bead", "barcoded bead", "hydrogel bead", "GEM bead", "capture oligo", "oligo-dT", "poly(dT)", "cell barcode", "UMI", "Drop-seq bead", "inDrops bead", "bead"],
    scene: () => ({ size: [200, 200], parts: gelBead(100, 100, 47, { n: 62, len: 34, w: 3.4, seed: 4, back: 0.45 }) }),
  },
  {
    slug: "capture-oligo-structure", name: "Capture oligo — Read 1, barcode, UMI, poly(dT) capturing mRNA", category: "nucleic-acids",
    tags: [...SC_TAGS, "capture oligo", "oligonucleotide", "primer", "Read 1", "TruSeq Read 1", "R1", "cell barcode", "10x barcode", "UMI", "unique molecular identifier", "poly(dT)", "oligo-dT", "poly(A) tail", "mRNA capture", "gel bead primer", "3' capture"],
    scene: () => {
      const parts = [];
      const y = 36, h = 9, tooth = 8, pitch = 7;
      const xs = [52, 118, 166, 202, 292];
      const comb = (x0, x1, yb, dir, len, w = 3.2) => {
        const out = [];
        for (let x = x0 + pitch / 2; x < x1 - 1; x += pitch) out.push(rect(x - w / 2, dir > 0 ? yb - 0.6 : yb - len, w, len + 0.6, 0.8));
        return out;
      };
      // captured mRNA (behind): 3' poly(A) tail under the poly(dT) — its flat 3' end in register with
      // the start of the poly(dT), one A under every T — then the body curling back to a 5' cap
      const my = y + h + tooth * 2 + 3.5;
      const mc = spine([[202, my], [250, my], [288, my], [302, my + 10], [298, my + 30], [270, my + 40], [230, my + 42], [196, my + 38], [168, my + 42]], 1.5);
      parts.push({ unite: [tubeD(mc, 7), ...comb(202, 292, my - 3.5, -1, tooth, 3)], fill: COL.mrna });
      // tube shading as soft-only stripes, so the light stays on the upper-left side all the way round the curl
      parts.push(...tubeStripes([mc], 7, { caps: false, hi: 0.5, lo: 0.18 }));
      parts.push({ d: comb(202, 292, my - 3.5, -1, tooth, 3).join(""), fill: COL.polyA, thin: true });
      parts.push({ d: circle(162, my + 43, 6.5), fill: COL.cap5, shade: "small" });
      // the oligo, 5' end on the bead: the four segments are flat (bar + its teeth, so no seams or
      // stepped notches), shaded once as one bar by soft-only overlays: a dark band along the
      // bottom edge and round the 3' cap, a light band along the top
      SEGS.forEach(([k], i) => {
        const x0 = xs[i], x1 = xs[i + 1];
        const sh = [rect(x0 - (i ? 0 : 6), y, x1 - x0 + (i ? 0 : 6), h, 0), ...comb(x0, x1, y + h, 1, tooth)];
        if (k === "polyT") sh.push(circle(x1, y + h / 2, h / 2));
        parts.push({ unite: sh, fill: COL[k] });
      });
      const xe = xs[xs.length - 1], kb = 1.9;
      parts.push({ fill: SHADOW, opacity: 0.2, line: false, unite: [rect(xs[0] - 6, y + h - kb, xe - xs[0] + 6, kb), polyD(lunePts(xe, y + h / 2, h / 2, -kb, -kb, 16))] });
      parts.push(glow(rect(xs[0] - 4, y + 1.3, xe - xs[0] + 2, 1.7, 0.85), 0.5));
      parts.push({ d: circle(30, 48, 25), fill: COL.bead, shade: "body", glossAt: [0.28, 0.26] });
      return { size: [320, 116], parts: xform(parts, place({ x: 4, y: -10.5 })) };
    },
  },
  {
    slug: "gel-bead-in-emulsion", name: "GEM — droplet with one cell and one barcoded gel bead", category: "methods",
    tags: [...SC_TAGS, "GEM", "gel bead-in-emulsion", "droplet", "emulsion", "partition", "water-in-oil droplet", "encapsulation", "Drop-seq", "inDrops", "reverse transcription", "barcoding"],
    scene: () => ({ size: [200, 200], parts: gemParts() }),
  },
  {
    slug: "chromium-chip", name: "Droplet microfluidic chip (Chromium-style) — sample, gel bead and oil wells", category: "lab",
    tags: [...SC_TAGS, "chip", "microfluidic chip", "Chip G", "Chip K", "GEM-X chip", "Next GEM chip", "chip holder", "gel bead well", "sample well", "partitioning oil", "recovery well", "8 channels", "Chromium Controller", "Chromium X", "Chromium iX", "partitioning"],
    scene: () => ({ size: [236, 108], lineWidth: 1.5, parts: chromiumChipIcon() }),
  },
  {
    slug: "single-cell-suspension", name: "Single-cell suspension (tube of dissociated cells, magnified)", category: "lab",
    tags: [...SC_TAGS, "single-cell suspension", "cell suspension", "dissociated cells", "tissue dissociation", "enzymatic digestion", "collagenase", "dispase", "cells in tube", "microcentrifuge tube", "Eppendorf tube", "cell counting", "viability"],
    scene: () => ({ size: [200, 200], parts: xform(suspensionParts(), place({ x: -9, y: 2.75 })) }),
  },
  {
    slug: "single-nucleus-isolation", name: "Single-nucleus isolation — nuclei released from lysed cells", category: "methods",
    tags: ["single-nucleus RNA-seq", "snRNA-seq", "snATAC-seq", "Multiome", "nuclei isolation", "nuclei extraction", "nuclear isolation", "cell lysis", "lysis buffer", "detergent", "NP-40", "Dounce homogenizer", "frozen tissue", "nucleus", "nuclei", "torn membrane"],
    scene: () => ({ size: [200, 200], parts: xform(nucleiParts(), place({ x: 2, y: -8 })) }),
  },
  // ---------- epigenomics ----------
  {
    slug: "atac-seq-tn5", name: "ATAC-seq — Tn5 tagmenting open chromatin between nucleosomes", category: "nucleic-acids",
    tags: [...EPI_TAGS, "ATAC-seq", "scATAC-seq", "single-cell ATAC", "Multiome", "Tn5", "Tn5 transposase", "transposome", "tagmentation", "Nextera adapters", "open chromatin", "accessible chromatin", "nucleosome-free region", "NFR", "closed chromatin", "heterochromatin", "chromatin accessibility"],
    scene: () => ({ size: [301, 131], lineWidth: 1.7, parts: xform(atacParts(), place({ x: 5, y: -28.7 })) }),
  },
  {
    slug: "chip-seq-pulldown", name: "ChIP — crosslinked chromatin captured by antibody on a magnetic bead", category: "methods",
    tags: [...EPI_TAGS, "ChIP", "ChIP-seq", "chromatin immunoprecipitation", "immunoprecipitation", "IP", "pulldown", "crosslinking", "formaldehyde", "transcription factor", "protein A", "protein G", "protein A/G", "magnetic bead", "Dynabeads", "antibody"],
    scene: () => ({ size: [200, 200], parts: xform(chipParts(), place({ y: -6 })) }),
  },
  {
    slug: "cut-and-tag", name: "CUT&Tag — pA-Tn5 tethered by an antibody to a histone mark", category: "methods",
    tags: [...EPI_TAGS, "CUT&Tag", "CUT and Tag", "cleavage under targets and tagmentation", "pA-Tn5", "pAG-Tn5", "protein A-Tn5", "Tn5", "tagmentation", "histone mark", "histone modification", "H3K27me3", "H3K4me3", "methylation", "antibody", "scCUT&Tag"],
    scene: () => ({ size: [258, 112], parts: xform(cutTagParts(), place({ y: -44.5 })) }),
  },
  {
    slug: "cut-and-run", name: "CUT&RUN — pA-MNase cutting DNA around a bound protein", category: "methods",
    tags: [...EPI_TAGS, "CUT&RUN", "CUT and RUN", "cleavage under targets and release using nuclease", "pA-MNase", "pAG-MNase", "MNase", "micrococcal nuclease", "calcium", "Ca2+", "transcription factor", "antibody", "protein-DNA interaction"],
    scene: () => ({ size: [256, 108], parts: xform(cutRunParts(), place({ y: -48 })) }),
  },
  // ---------- sequencing ----------
  {
    slug: "illumina-flow-cell", name: "Patterned flow cell — lanes and nanowell clusters (magnified)", category: "lab",
    tags: [...SEQ_TAGS, "flow cell", "patterned flow cell", "Illumina", "NovaSeq", "NovaSeq X", "NextSeq", "nanowells", "clusters", "lanes", "SBS", "sequencing by synthesis", "two-colour chemistry", "XLEAP-SBS", "fluorescence imaging"],
    scene: () => ({ size: [220, 192], parts: xform(flowCellParts(), place({ y: -4 })) }),
  },
  {
    slug: "bridge-amplification-cluster", name: "Bridge amplification — clonal cluster on the flow cell", category: "methods",
    tags: [...SEQ_TAGS, "bridge amplification", "bridge PCR", "cluster generation", "clonal cluster", "ExAmp", "exclusion amplification", "P5", "P7", "surface oligos", "lawn", "flow cell surface", "Illumina", "template strand"],
    scene: () => ({ size: [260, 120], lineWidth: 1.5, parts: xform(bridgeParts(), place({ y: -7 })) }),
  },
  {
    slug: "dna-sequencer", name: "DNA sequencer (benchtop / production NGS instrument)", category: "lab",
    tags: [...SEQ_TAGS, "sequencer", "DNA sequencer", "NGS instrument", "sequencing machine", "Illumina", "NovaSeq", "NovaSeq X", "NextSeq", "MiSeq", "Element AVITI", "Ultima", "MGI DNBSEQ", "instrument", "machine"],
    scene: () => ({ size: [200, 200], parts: xform(sequencerParts(), place({ x: -5, y: -6 })) }),
  },
  {
    slug: "sequencing-reads-alignment", name: "Sequencing reads aligned to a reference (pile-up with SNV)", category: "charts",
    tags: [...SEQ_TAGS, "reads", "alignment", "read alignment", "mapping", "pile-up", "pileup", "coverage", "reference genome", "genome browser", "IGV", "BAM", "SNV", "SNP", "variant", "mismatch", "STAR", "BWA", "bowtie2"],
    scene: () => ({ size: [260, 170], lineWidth: 1.6, parts: xform(readsParts(), place({ y: -6 })) }),
  },
  // ---------- overview strips ----------
  {
    slug: "scrna-seq-workflow", name: "scRNA-seq workflow — tissue to UMAP (droplet-based)", category: "methods",
    tags: [...SC_TAGS, "workflow", "overview", "pipeline", "schematic", "tissue dissociation", "single-cell suspension", "encapsulation", "barcoding", "reverse transcription", "cDNA", "library preparation", "sequencing", "UMAP", "clustering", "graphical abstract"],
    scene: () => strip([
      { parts: tissueMini() },
      { parts: cellTube(50, 30, 1).parts, w: 0.7, maxS: 0.46 },
      { parts: junctionMini(), w: 1.2 },
      { parts: rtMini() },
      { parts: libraryMini() },
      { parts: sequencerParts() },
      { parts: umapParts({ dotR: 3.6, minD: 3.4, density: 0.36 }) },
    ], { W: 600, H: 150 }),
  },
  {
    slug: "atac-seq-workflow", name: "ATAC-seq workflow — nuclei, Tn5 tagmentation, library, sequencing, peaks", category: "methods",
    tags: [...EPI_TAGS, "ATAC-seq", "scATAC-seq", "workflow", "overview", "pipeline", "schematic", "nuclei isolation", "Tn5", "tagmentation", "open chromatin", "chromatin accessibility", "library", "PCR", "peaks", "peak calling", "MACS2", "genome track", "graphical abstract"],
    scene: () => strip([
      { parts: [...nucleusParts(30, 34, 22, 5), ...nucleusParts(74, 46, 20, 9), ...nucleusParts(40, 78, 21, 13)] },
      { parts: tagmentMini(), w: 1.3 },
      { parts: atacFragmentsMini() },
      { parts: sequencerParts() },
      { parts: peaksMini() },
    ], { W: 540, H: 150 }),
  },
  {
    slug: "chip-seq-workflow", name: "ChIP-seq workflow — crosslink, shear, immunoprecipitate, purify, sequence, peaks", category: "methods",
    tags: [...EPI_TAGS, "ChIP-seq", "ChIP", "chromatin immunoprecipitation", "workflow", "overview", "pipeline", "schematic", "crosslinking", "formaldehyde", "sonication", "chromatin shearing", "immunoprecipitation", "magnetic beads", "reverse crosslinking", "DNA purification", "sequencing", "peaks", "peak calling", "graphical abstract"],
    scene: () => strip([
      { parts: crosslinkMini(), w: 1.2 },
      { parts: shearedMini(), w: 0.95 },
      { parts: chipParts({ short: true }), w: 0.8, maxS: 0.5 },
      { parts: dnaFragmentsMini(), w: 0.9 },
      { parts: sequencerParts() },
      { parts: peaksMini({ peaks: [[30, 2.6, 0.3], [62, 2.4, 1], [96, 2.6, 0.5]], color: "#f0a050", amp: 62 }), w: 1.05 },
    ], { W: 580, H: 150 }),
  },
  // ---------- charts ----------
  {
    slug: "umap-single-cell-clusters", name: "UMAP of single cells — coloured clusters", category: "charts",
    tags: [...SC_TAGS, "UMAP", "t-SNE", "tSNE", "embedding", "dimensionality reduction", "clusters", "clustering", "Leiden", "Louvain", "cell types", "scatter plot", "Seurat", "Scanpy", "single-cell atlas"],
    scene: () => ({ size: [200, 200], parts: umapParts() }),
  },
  {
    slug: "dot-plot-marker-genes", name: "Dot plot of marker genes by cluster", category: "charts",
    tags: ["dot plot", "DotPlot", "marker genes", "gene expression", "percent expressing", "average expression", "clusters", "cell types", "scRNA-seq", "single-cell", "Seurat", "Scanpy", "bubble plot", "heatmap"],
    scene: () => ({ size: [230, 172], parts: dotPlotParts() }),
  },
  {
    slug: "violin-plot", name: "Violin plot with box and median", category: "charts",
    tags: ["violin plot", "VlnPlot", "distribution", "box plot", "median", "IQR", "gene expression", "scRNA-seq", "single-cell", "Seurat", "Scanpy", "ggplot2", "density", "statistics"],
    scene: () => ({ size: [200, 172], parts: violinParts() }),
  },
];
