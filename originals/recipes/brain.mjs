// Brain: cerebral cortex in health and Alzheimer's disease (AD) and the key AD lesions.
//   brain-cortex-healthy / brain-cortex-alzheimers — matched grey-matter sections under the pia
//   amyloid-beta-plaque, neuron-neurofibrillary-tangle, reactive-astrocyte, microglia-activated,
//   tau-tangle-fibrils — the lesions and cells on their own
//   brain-coronal-healthy / brain-coronal-alzheimers — matched gross coronal slices
//
// Cells with thin processes (neurons, astrocytes, microglia) are drawn as one united silhouette
// over a darker shadow copy whose offset follows the local process thickness (as cells.mjs does):
// the renderer's crescents scale with the bounding box and would swamp thin processes.
import { blobPts, circle, ellipse, capsule, smoothClosed, smoothOpen, ribbon, rotate, rng, f } from "../lib/geom.mjs";
import { shade, tint, flat, outline, pathBox } from "../lib/style.mjs";
import { lineD, polyD, catmull, resample, normals, inside } from "../lib/tissue.mjs";
import { C, Layers, sw } from "../lib/histo.mjs";
import { unevenSpacing, unevenAngles, assertInside } from "../lib/organic.mjs";

/** Line-style fields for a filled part that should have no visible outline (diffuse things). */
const noLine = (fill) => ({ lineColor: flat(fill), lineWidth: 0.05 });

/* ===================== geometry helpers (after cells.mjs) ===================== */

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const rad = (d) => (d * Math.PI) / 180;
const pol = (x, y, r, deg) => [x + Math.cos(rad(deg)) * r, y + Math.sin(rad(deg)) * r];

function crPoint(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const q = (j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
  return [q(0), q(1)];
}

/** Evenly spaced points (≈ step apart) along a smooth open curve through pts. */
function along(pts, step = 2) {
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

/** Point, unit direction and angle (deg) at fraction t (by arc length) of a smooth curve through pts. */
function at(pts, t) {
  const c = along(pts, 0.8);
  const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + dist(c[i], c[i - 1]));
  const Lx = cum[cum.length - 1] * t;
  let i = cum.findIndex((v) => v >= Lx);
  if (i <= 0) i = 1;
  const a = c[i - 1], b = c[i], l = dist(a, b) || 1;
  return { p: b, dir: [(b[0] - a[0]) / l, (b[1] - a[1]) / l], ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
}

/**
 * Outline around centreline `pts` with half-width w(t); `shift(hw)` moves samples diagonally (shadow
 * copy); `round` closes the far end with a blunt semicircular tip instead of a point.
 */
function tubePts(pts, w, { step = 2, shift = null, round = false } = {}) {
  const c = along(pts, step);
  const n = c.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(c[i], c[i - 1]));
  const total = cum[n - 1] || 1;
  const hw = (i) => (typeof w === "function" ? w(cum[i] / total) : w);
  const s = (i) => (shift ? shift(hw(i)) : 0);
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    left.push([c[i][0] - (dy / l) * hw(i) + s(i), c[i][1] + (dx / l) * hw(i) + s(i)]);
    right.push([c[i][0] + (dy / l) * hw(i) + s(i), c[i][1] - (dx / l) * hw(i) + s(i)]);
  }
  const u = (a, b) => { const l = dist(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const ue = u(c[n - 2], c[n - 1]), us = u(c[1], c[0]);
  const base = [c[0][0] + us[0] * hw(0) * 0.9 + s(0), c[0][1] + us[1] * hw(0) * 0.9 + s(0)];
  if (round) {
    // blunt tip: a semicircle from the left edge round the end to the right edge
    const e = c[n - 1], h = hw(n - 1), lv = [-ue[1], ue[0]], cap = [];
    for (let k = 1; k < 6; k++) {
      const ph = (k * Math.PI) / 6;
      cap.push([e[0] + h * (Math.cos(ph) * lv[0] + Math.sin(ph) * ue[0]) + s(n - 1), e[1] + h * (Math.cos(ph) * lv[1] + Math.sin(ph) * ue[1]) + s(n - 1)]);
    }
    return [...left, ...cap, ...right.reverse(), base];
  }
  const tip = [c[n - 1][0] + ue[0] * hw(n - 1) * 0.9 + s(n - 1), c[n - 1][1] + ue[1] * hw(n - 1) * 0.9 + s(n - 1)];
  return [...left, tip, ...right.reverse(), base];
}

const taper = (base, tip, p = 1.5) => (t) => tip + (base - tip) * Math.pow(1 - t, p);

/* soft-style pieces: shape `d` and its shadow copy `sd` (offset grows with local thickness) */
let SH = { max: 0.9, k: 0.42, body: 1 };
const shadowShift = () => (hw) => Math.min(SH.max, SH.k * hw);

function piece(pts, w, o = {}) {
  return { pts, d: smoothClosed(tubePts(pts, w, o)), sd: smoothClosed(tubePts(pts, w, { ...o, shift: shadowShift() })) };
}
/** A tapered process from (x0,y0) heading ang°, len long, bending `bend`° along the way. */
function proc(x0, y0, ang, len, { bend = 0, base = 1.4, tip = 0.4, p = 1.5, seg = 4, wave = 0, seed = 1, wf = null, round = false } = {}) {
  let pts;
  for (let k = 0; k < 10; k++) {
    pts = [[x0, y0]];
    const R = rng(seed);
    let a = rad(ang), x = x0, y = y0;
    const da = rad(bend) / seg;
    for (let i = 0; i < seg; i++) {
      x += Math.cos(a) * (len / seg);
      y += Math.sin(a) * (len / seg);
      pts.push([x, y]);
      a += da + (wave ? rad((R() - 0.5) * wave) : 0);
    }
    // in a tissue section, processes stop short of the edge of the section and of the vessels
    const ok = ([px, py]) => (!FRAME || (px > FRAME[0] && py > FRAME[1] && px < FRAME[2] && py < FRAME[3])) &&
      !AVOID.some(([ax, ay, ar]) => Math.hypot(px - ax, py - ay) < ar);
    if (pts.slice(1).every(ok)) break;
    len *= 0.82;
  }
  return piece(pts, wf || taper(base, tip, p), { round });
}
/** Signed difference a − b of two angles in degrees, in (−180, 180]. */
const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
/** Inner limits [x0, y0, x1, y1] for processes in the current tissue section (null for single cells). */
let FRAME = null;
/** The house style being drawn ("soft" | "line"); a few thin parts are drawn differently in each. */
let STYLE = "soft";
/** Circles [x, y, r] (vessels) that processes in the current section must stop short of. */
let AVOID = [];
/** Circles [x, y, r] round other cells' somata, which axons stop short of. */
let SOMAS = [];
/** A closed shape piece from outline points. */
function shapePiece(pts, tension = 1, sh = SH.body) {
  return { d: smoothClosed(pts, tension), sd: smoothClosed(pts.map(([x, y]) => [x + sh, y + sh]), tension) };
}
const blobPiece = (cx, cy, rx, ry, o = {}, sh = SH.body) => shapePiece(blobPts(cx, cy, rx, ry, o), o.tension ?? 1, sh);

/** Point at parameter angle th (deg) on ellipse e = {cx, cy, rx, ry, rot}, pushed `off` outward along its normal. */
function ellipseAt(e, th, off = 0) {
  const t = rad(th), ex = Math.cos(t) * e.rx, ey = Math.sin(t) * e.ry;
  let nx = Math.cos(t) / e.rx, ny = Math.sin(t) / e.ry;
  const nl = Math.hypot(nx, ny);
  return rotate([e.cx + ex + (nx / nl) * off, e.cy + ey + (ny / nl) * off], e.cx, e.cy, e.rot || 0);
}
/** A band `width` wide whose centre runs `off` outside ellipse e, from parameter angle a0 to a1 (deg). */
function ellipseBand(e, a0, a1, off, width, taper = 0.75) {
  const pts = [];
  const n = Math.max(8, Math.round(Math.abs(a1 - a0) / 6));
  for (let i = 0; i <= n; i++) pts.push(ellipseAt(e, a0 + ((a1 - a0) * i) / n, off));
  return ribbon(pts, width, { taper });
}

/** Outline of a band along a smooth curve through pts with half-width w(t), cut square at both ends. */
function flatTube(pts, w, step = 1.5) {
  const c = along(pts, step), n = c.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(c[i], c[i - 1]));
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, hw = w(cum[i] / cum[n - 1]);
    left.push([c[i][0] - (dy / l) * hw, c[i][1] + (dx / l) * hw]);
    right.push([c[i][0] + (dy / l) * hw, c[i][1] - (dx / l) * hw]);
  }
  return smoothOpen(left) + "L" + smoothOpen(right.reverse()).slice(1) + "Z";
}

/** Translate absolute path data (M L H V C Q Z). */
function movePath(d, dx, dy) {
  const toks = d.match(/[MLHVCQZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
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

/* ===================== palette ===================== */

const P = {
  csf: "#e8f3f8", arach: "#f0c3c3", pia: "#e497a3", neuropil: "#f7e4e1", fibre: "#ecc6c3",
  neuron: "#f5cf7f", inter: "#f4b98a", nNuc: "#9a6fb8", nucleolus: "#5d3f85",
  astro: "#b5d99a", astroNuc: "#7d78bd", oliHalo: "#eef5fb", oliNuc: "#5a55a3",
  micro: "#a3cdec", microNuc: "#4f63ad",
  amyloid: "#e08d48", core: "#c2622d", halo: "#f6d6a2", diffuse: "#f4c787", amyFib: "#e7a560", dystro: "#e9bd63",
  tangle: "#433774", ghost: "#8d84b4", phago: "#d9823f",
  artWall: "#e88690", artLumen: "#fdeceb", smc: "#9b5ea8",
};

/** A cell type drawn as one united silhouette over a shadow copy. */
function cellLayers(L, key, fill, lineWidth = 0.55) {
  L.def(key + "Sh", { fill: shade(fill, 0.13), unite: [], line: false })
    .def(key, { fill, unite: [], lineWidth });
}
function addCell(L, key, pieces) {
  for (const p of pieces) {
    L.map.get(key + "Sh").unite.push(p.sd);
    L.map.get(key).unite.push(p.d);
  }
}
const parts = (L) => L.parts().filter((p) => !p.unite || p.unite.length);
/** Add to a layer, merging into one shape when the layer unites its paths. */
function addTo(L, key, d) {
  const l = L.map.get(key);
  if (l.unite) l.unite.push(...[].concat(d));
  else L.add(key, d);
}

/* ===================== cells for the tissue sections ===================== */

/**
 * Pyramidal neuron: triangular soma (apex to the pia), apical dendrite up to `top` with a tuft
 * and obliques, basal dendrites from the base corners, thin axon down. Returns nucleus info.
 */
function pyramidal(L, { x, y, s = 1, tilt = 0, top = 44, seed = 1, ad = false, tangle = false, ts = 1, bl = 1, axLean = 0 }) {
  const R = rng(seed);
  const k = s * 1.12 * (ad ? 0.86 : 1);
  const wk = ad ? 0.8 : 1;
  const T = (px, py) => rotate([x + px * k, y + py * k], x, y, tilt);
  const somaPts = [[0, -12], [-3.4, -4.6], [-7.4, 4.4], [-3.8, 7.3], [3.8, 7.3], [7.4, 4.4], [3.4, -4.6]].map(([a, b]) => T(a, b));
  const pieces = [shapePiece(somaPts, 0.85)];
  // apical dendrite, gently wandering straight up to layer I; the trunk starts well inside the
  // soma, so it flares smoothly out of the apex (no shoulders at the join)
  const apex = T(0, -10.5);
  const len = apex[1] - top;
  const n = Math.max(2, Math.round(len / 22));
  const ap = [T(0, -5.8), apex];
  for (let i = 1; i <= n; i++) ap.push([apex[0] + Math.sin(i * 1.7 + seed) * 1.6 * ts * (i / n), apex[1] - (len * i) / n]);
  const wAp = taper(2.05 * wk * k, 0.6 * wk * ts, 1.7);
  pieces.push(piece(ap, wAp));
  // tuft
  const tip = ap[ap.length - 1];
  const tuft = ad ? [-120, -62] : [-132, -98, -58];
  tuft.forEach((a, i) => pieces.push(proc(tip[0], tip[1] + 1, a + (R() - 0.5) * 14, ((ad ? 9 : 12) + R() * 6) * ts, { bend: (i % 2 ? 22 : -22), base: 0.85 * wk * ts, tip: 0.35 * ts, seed: seed + i })));
  // obliques
  const obl = ad ? [0.4] : [0.3, 0.55, 0.78];
  obl.forEach((t, i) => {
    if (len * t < 14 * ts) return;
    const q = at(ap, t);
    const side = (i + seed) % 2 ? -1 : 1;
    pieces.push(proc(q.p[0], q.p[1], -90 + side * (58 + R() * 18), (9 + R() * 5) * ts, { bend: side * 16, base: 0.95 * wk * ts, tip: 0.35 * ts, seed: seed + 10 + i }));
  });
  // basal dendrites
  const basal = [[-6.2, 4.4, 168], [-6, 5.4, 128], [-1.8, 7.2, 102], [6, 5.4, 56], [6.2, 4.4, 14]];
  basal.forEach(([bx, by, a], i) => {
    if (ad && i === 2) return;
    const o = T(bx, by);
    const L0 = (13 + R() * 7) * k * bl * (ad ? 0.8 : 1);
    const pr = proc(o[0], o[1], a + tilt + (R() - 0.5) * 16, L0, { bend: (R() - 0.5) * 40, base: 1.6 * wk * k, tip: 0.38 * ts, seed: seed + 20 + i });
    pieces.push(pr);
    if (!ad && i !== 2) {
      const b = pr.pts[2];
      pieces.push(proc(b[0], b[1], a + tilt + (i < 2 ? 34 : -34), (6 + R() * 3) * ts, { base: 0.75 * ts, tip: 0.3 * ts, seed: seed + 30 + i }));
    }
  });
  // axon: in a section, long, thin and of even calibre with oblique collaterals (unlike the
  // tapering dendrites) — in line style a single thin stroke after the hillock; in the single-cell
  // icon, a short stub with a hillock
  if (FRAME) {
    const ax = axonPieces(...T(0.3, 6.4), k, { lean: tilt + axLean, side: seed % 2 ? 1 : -1, seed });
    if (STYLE === "line") {
      pieces.push(ax.hillock);
      L.add("axonLine", ax.lines.map((l) => smoothOpen(l)));
    } else pieces.push(...ax.pieces);
  } else {
    const ax0 = T(0.6, 7);
    const axEnd = ax0[1] + 18 * k;
    pieces.push(piece([ax0, [ax0[0] + 0.6, (ax0[1] * 2 + axEnd) / 3], [ax0[0] - 0.4, axEnd]], (t) => (0.5 + 1.1 * Math.max(0, 1 - t * 3)) * ts));
  }
  addCell(L, "neuron", pieces);
  // nucleus + nucleolus (a tangle pushes the nucleus aside)
  const nc = tangle ? T(2.6, 2.8) : T(0, 1.4);
  const nr = (tangle ? 3.5 : 4.3) * k;
  L.add("nNuc", circle(nc[0], nc[1], nr));
  L.add("nucleolus", circle(nc[0] + 0.7 * k, nc[1] - 0.5 * k, 1.25 * k));
  if (tangle) addTangle(L, T, k, ap, wAp);
  return { x, y, k, somaPts, nc, nr };
}

/**
 * Axon of a neuron in a section: a small conical hillock, then a thin process of uniform calibre
 * running straight down past the basal dendrites (stopping short of other cells, vessels and the
 * edge of the section), with one or two collaterals leaving obliquely downward (35–55°) and curving
 * gently, on either side. Returns the silhouette pieces (soft), the hillock alone and the centrelines
 * beyond it (line style, where the axon is a single thin stroke).
 */
function axonPieces(x0, y0, k, { lean = 0, side = 1, want = 46, seed = 1 } = {}) {
  const R = rng(seed + 400);
  const d = [-Math.sin(rad(lean)), Math.cos(rad(lean))];
  const dA = 90 + lean;
  const blocked = ([px, py]) => (FRAME && (py > FRAME[3] + 1.5 || px < FRAME[0] || px > FRAME[2])) ||
    [...AVOID, ...SOMAS].some(([ax, ay, ar]) => Math.hypot(px - ax, py - ay) < ar);
  const run = (o, u, max) => {
    let l = 0;
    while (l < max && !blocked([o[0] + u[0] * (l + 1), o[1] + u[1] * (l + 1)])) l++;
    return l;
  };
  const len = run([x0, y0 + 2], d, want * k) + 2;
  const end = [x0 + d[0] * len, y0 + d[1] * len];
  const hw = 0.27;
  const P = (s) => [x0 + d[0] * s, y0 + d[1] * s];
  const out = [piece([[x0, y0], P(len / 2), end], (t) => hw + 0.95 * Math.pow(Math.max(0, 1 - (t * len) / 3.6), 1.4), { step: 1 })];
  const hillock = piece([[x0, y0], P(2), P(4.2)], (t) => 0.3 + 0.95 * Math.pow(Math.max(0, 1 - (t * 4.2) / 3.6), 1.4), { step: 0.6 });
  const lines = [[P(3.4), P((3.4 + len) / 2), end]];
  if (len > 18) {
    // the first collateral on `side`, a second on the other side when the axon is long enough
    const plan = [[0.4 + R() * 0.14, side], ...(len > 30 ? [[0.66 + R() * 0.12, -side]] : [])];
    for (const [fr, sg] of plan) {
      const q = P(len * fr);
      const a = dA + sg * (35 + R() * 20);
      const cl = run(q, [Math.cos(rad(a)), Math.sin(rad(a))], (6 + R() * 8) * k);
      if (cl < 5) continue;
      // curving gently back toward the axon's own course
      const m = pol(q[0], q[1], cl * 0.5, a);
      const e = pol(m[0], m[1], cl * 0.5, a - sg * (10 + R() * 10));
      const pts = [q, pol(q[0], q[1], cl * 0.25, a), m, e];
      out.push(piece(pts, hw, { step: 1 }));
      lines.push(pts);
    }
  }
  return { pieces: out, hillock, lines };
}

/**
 * Flame-shaped neurofibrillary tangle: fills the soma beside the nucleus and runs up the apical
 * dendrite as a tongue built from the dendrite's own centreline and width, inset on both sides so a
 * rim of cytoplasm stays visible along its whole length.
 */
function addTangle(L, T, k, ap, wAp) {
  const c = along(ap, 0.45 * k);
  const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + dist(c[i], c[i - 1]));
  const total = cum[cum.length - 1];
  const inset = 0.42 * k, s0 = 1.7 * k, sTop = 12.6 * k;
  const tongue = [];
  for (let i = 0; i < c.length; i++) {
    const s = cum[i];
    if (s < s0 || s > sTop) continue;
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const u = (s - s0) / (sTop - s0);
    const g = u < 0.3 ? 1 : 1 - 0.86 * Math.pow((u - 0.3) / 0.7, 0.9);
    const hw = Math.max(0.12 * k, (wAp(s / total) - inset) * g);
    tongue.push({ p: c[i], n: [dy / l, -dx / l], hw, u });
  }
  const side = (sg, f = 1) => tongue.map(({ p, n, hw }) => [p[0] + n[0] * hw * sg * f, p[1] + n[1] * hw * sg * f]);
  const last = tongue[tongue.length - 1];
  const tip = [last.p[0] - last.n[1] * 0.5 * k, last.p[1] + last.n[0] * 0.5 * k];
  const lower = [[1.4, -5.2], [-0.1, -2.2], [-0.9, 1.8], [-1.9, 5.3], [-5.2, 4.4], [-4.7, 0.4], [-2.9, -4.1]].map(([a, b]) => T(a, b));
  L.add("tangle", smoothClosed([...side(1), tip, ...side(-1).reverse(), ...lower], 0.9));
  // paired helical filament bundles running up the flame
  const at = (u, f) => {
    const q = tongue[Math.min(tongue.length - 1, Math.round(u * (tongue.length - 1)))];
    return [q.p[0] + q.n[0] * q.hw * f, q.p[1] + q.n[1] * q.hw * f];
  };
  const fib = [];
  for (const [f, top, lo] of [[0.5, 0.42, -4.2], [0.1, 0.78, -3.2], [-0.35, 0.6, -2.2]]) {
    fib.push(smoothOpen([T(lo, 3.6), T(lo * 0.62 - 0.4, -0.6), at(0, f), at(top * 0.5, f * 0.9), at(top, f * 0.6)]));
  }
  L.add("tangleFib", fib);
}

/** Interneuron: small round multipolar soma with smooth (aspiny) dendrites. */
function interneuron(L, { x, y, s = 1, seed = 1, rot = 0, ad = false }) {
  const R = rng(seed);
  const pieces = [blobPiece(x, y, 5.3 * s, 4.8 * s, { n: 8, wobble: 0.07, seed, rot })];
  const nd = 5;
  const angs = unevenAngles(nd, R, { cv: 0.3, start: rot });
  for (let i = 0; i < nd; i++) {
    const a = angs[i];
    const o = pol(x, y, 4.2 * s, a);
    const pr = proc(o[0], o[1], a, (11 + R() * 7) * s * (ad ? 0.85 : 1), { bend: (R() - 0.5) * 50, base: 1.25 * s, tip: 0.35, seed: seed + i, wave: 20 });
    pieces.push(pr);
    if (i % 2 === 0) pieces.push(proc(...pr.pts[2], a + (R() > 0.5 ? 38 : -38), 6 * s, { base: 0.6, tip: 0.28, seed: seed + 9 + i }));
  }
  addCell(L, "inter", pieces);
  L.add("nNuc", circle(x + 0.3, y + 0.3, 3.2 * s));
  L.add("nucleolus", circle(x + 0.8, y - 0.2, 1 * s));
}

/**
 * Protoplasmic astrocyte: small soma, bushy processes; `feet`: end-feet on vessels ({cx,cy,r})
 * or on the pia ({pia: y}). `reactive`: hypertrophic soma and thick processes.
 */
function astrocyte(L, { x, y, seed = 1, feet = [], reactive = false, toward = null }) {
  const R = rng(seed);
  const g = reactive ? 1.45 : 1;
  const pieces = [blobPiece(x, y, 4.4 * g, 3.9 * g, { n: 7, wobble: 0.12, seed })];
  if (!reactive) {
    // protoplasmic: many fine, bushy processes at uneven angles, each forking twice
    const np = 8 + (seed % 2);
    unevenAngles(np, R, { cv: 0.32 }).forEach((a, i) => {
      const o = pol(x, y, 3, a);
      const pr = proc(o[0], o[1], a, 9 + R() * 6, { bend: (R() - 0.5) * 40, base: 1.25, tip: 0.35, seed: seed + i, wave: 24 });
      pieces.push(pr);
      for (let b = 0; b < 2; b++) {
        const q = pr.pts[2 + b];
        pieces.push(proc(q[0], q[1], a + (b % 2 ? 38 : -38) + (R() - 0.5) * 20, 4.5 + R() * 3, { base: 0.6, tip: 0.28, seed: seed + 20 + i * 2 + b }));
      }
    });
  } else {
    // hypertrophic: 5–6 thick primary processes at clustered angles — the two thickest close together
    // towards `toward` (a plaque or a vessel), the others shorter and unevenly spread — each gently
    // tortuous with 1–2 varicosities, 1–3 secondary branches at different distances and blunt ends
    const np = seed % 3 === 0 ? 5 : 6;
    const t0 = toward ? toward.ang : R() * 360, pair = 18 + R() * 14;
    const angs = [t0 - pair / 2, t0 + pair / 2, ...unevenSpacing(np - 2, 360 - pair, R, { cv: 0.45 }).map((s) => t0 + pair / 2 + s)];
    angs.forEach((a, i) => {
      const thick = i < 2;
      const len = thick ? 13 + R() * 5 + (toward ? toward.extra : 0) : 8 + R() * 5;
      const base = thick ? 2.4 + R() * 0.25 : 1.65 + R() * 0.35, tip = thick ? 0.8 : 0.72;
      const vs = [0.32 + R() * 0.2, ...(R() < 0.6 ? [0.66 + R() * 0.16] : [])];
      const wf = (t) => tip + (base - tip) * Math.pow(1 - t, 1.15) + vs.reduce((s, v) => s + 0.42 * Math.exp(-Math.pow((t - v) / 0.07, 2)), 0);
      const o = pol(x, y, 3.2 * g, a);
      const pr = proc(o[0], o[1], a, len, { bend: (R() - 0.5) * 40, wave: 26, seg: 6, wf, round: true, seed: seed + i });
      pieces.push(pr);
      const nb = thick ? 2 + (R() < 0.5 ? 1 : 0) : 1 + (R() < 0.45 ? 1 : 0);
      const frs = unevenSpacing(nb, 0.55, R, { cv: 0.4 }).map((s) => 0.26 + s);
      let sg = R() < 0.5 ? 1 : -1;
      for (const fr of frs) {
        const q = at(pr.pts, fr);
        const bl = (thick ? 5.5 : 4.5) + R() * 4;
        pieces.push(proc(q.p[0], q.p[1], q.ang + sg * (32 + R() * 22), bl, { bend: sg * (R() * 30), base: 0.82, tip: 0.5, p: 1, wave: 20, round: true, seed: seed + 30 + i * 4 + Math.round(fr * 10) }));
        if (R() < 0.75) sg = -sg;
      }
    });
  }
  for (const ft of feet) {
    if (ft.pia != null) {
      // subpial end-foot: process up to the pia, flattened along it (glia limitans)
      const fx = ft.x;
      pieces.push(piece([[x, y - 2], [(x + fx) / 2, (y + ft.pia) / 2], [fx, ft.pia + 1.8]], taper(1.3 * g, 0.9, 1)));
      pieces.push(piece([[fx - 6, ft.pia + 1.4], [fx, ft.pia + 1.2], [fx + 6, ft.pia + 1.4]], (t) => 1.1 * (1 - Math.abs(t - 0.5) * 0.9)));
      continue;
    }
    if (ft.pad) {
      // end-foot lining the outer border of a perivascular space (vessel cut lengthwise)
      const m = ft.pad[1];
      pieces.push(piece([[x, y], [(x + m[0]) / 2, (y + m[1]) / 2 + 2], m], taper(1.4 * g, 1, 1)));
      pieces.push(piece(ft.pad, (t) => 1.2 * (1 - Math.abs(t - 0.5) * 0.9)));
      continue;
    }
    // perivascular end-foot: one process runs to the capillary and spreads into a continuous sleeve
    // round 285–330° of its outer wall, leaving one small gap away from the stalk (the sleeve tucks
    // under the vessel wall, which is laid over it; it swells over a pericyte)
    const a = (Math.atan2(y - ft.cy, x - ft.cx) * 180) / Math.PI;
    const th = polarToParam(ft, a);
    const e = ellipseAt(ft, th, 0.9);
    const m = pol((x + e[0]) / 2, (y + e[1]) / 2, 1.2, a + 90);
    pieces.push(piece([pol(x, y, 2, a + 180), m, e], (t) => 1.15 * g - 0.3 * t + 0.9 * Math.pow(t, 7)));
    const gapC = th + 180 + (R() - 0.5) * 140, gapW = 30 + R() * 45;
    const bulge = ft.peri != null ? { th: ft.peri, amt: 0.75 } : null;
    const sl = (dx) => sleeveD({ ...ft, cx: ft.cx + dx, cy: ft.cy + dx }, gapC + gapW / 2, gapC + 360 - gapW / 2, -0.5, reactive ? 1.55 : 1.3, bulge);
    pieces.push({ d: sl(0), sd: sl(0.4) });
  }
  addCell(L, "astro", pieces);
  if (reactive) {
    // eccentric nucleus, ~0.42 of the soma width (soma ≈ 2.4× the nucleus)
    const nc = pol(x, y, 1.5, (toward ? toward.ang + 180 : R() * 360) + (R() - 0.5) * 50);
    L.add("astroNuc", ellipse(nc[0], nc[1], 2.7, 2.1, R() * 180));
  } else L.add("astroNuc", ellipse(x + 0.2, y + 0.2, 2.8, 2.3, R() * 180));
}

/** Parametric angle (deg) of the point of ellipse e that lies in polar direction `a` (deg) from its centre. */
function polarToParam(e, a) {
  const al = rad(a - (e.rot || 0));
  return (Math.atan2(e.rx * Math.sin(al), e.ry * Math.cos(al)) * 180) / Math.PI;
}

/**
 * A band round ellipse e between offsets offIn and offOut (outward +) from parameter angle a0 to a1
 * (deg), with rounded ends; `bulge` {th, amt} thickens it outward round parameter angle th.
 */
function sleeveD(e, a0, a1, offIn, offOut, bulge = null) {
  const n = Math.max(16, Math.round(Math.abs(a1 - a0) / 5));
  const A = [], B = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, a = a0 + (a1 - a0) * s;
    const endF = Math.min(1, (Math.min(s, 1 - s) * n) / 2.2);
    const rnd = 0.3 + 0.7 * Math.sqrt(Math.max(0, 1 - Math.pow(1 - endF, 2)));
    let out = offOut;
    if (bulge) out += bulge.amt * Math.exp(-Math.pow(angDiff(a, bulge.th) / 24, 2));
    const mid = (offIn + out) / 2, hw = ((out - offIn) / 2) * rnd;
    A.push(ellipseAt(e, a, mid + hw));
    B.push(ellipseAt(e, a, mid - hw));
  }
  return smoothClosed([...A, ...B.reverse()]);
}

/** A lens-shaped band along ellipse e centred on parameter angle th (±span°), between offsets offA(u) and offB(u), u = 1 mid, 0 at the tips. */
function lensOnEllipse(e, th, span, offA, offB, n = 14) {
  const A = [], B = [];
  for (let i = 0; i <= n; i++) {
    const s = -1 + (2 * i) / n, u = Math.cos((s * Math.PI) / 2);
    A.push(ellipseAt(e, th + s * span, offA(u)));
    if (i > 0 && i < n) B.push(ellipseAt(e, th + s * span, offB(u)));
  }
  return smoothClosed([...A, ...B.reverse()]);
}

/**
 * Brain capillary cut across (~7 × 6 units against 20–25 µm neuronal somata: a ~5 µm lumen): a thin
 * wall whose single endothelial cell bulges into the lumen round its flattened, crescent-shaped
 * nucleus (at parameter angle c.th), one red cell filling most of the lumen, and optionally a
 * pericyte nucleus on the outer wall at c.peri.
 */
function capillary(L, c) {
  const wall = 1.2;
  L.add("wall", ellipse(c.cx, c.cy, c.rx, c.ry, c.rot));
  const lum = [];
  for (let a = 0; a < 360; a += 10) lum.push(ellipseAt(c, a, -(wall + 0.75 * Math.exp(-Math.pow(angDiff(a, c.th) / 34, 2)))));
  L.add("lumen", smoothClosed(lum));
  const far = ellipseAt(c, c.th + 180, 0), dl = dist(far, [c.cx, c.cy]) || 1;
  const rc = [c.cx + ((far[0] - c.cx) / dl) * 0.4, c.cy + ((far[1] - c.cy) / dl) * 0.4];
  const rbcD = ellipse(rc[0], rc[1], (c.rx - wall) * 0.76, (c.ry - wall) * 0.68, c.rot);
  assertInside("capillary red cell", rbcD, smoothClosed(lum), 0.1);
  L.add("rbc", rbcD);
  L.add("endo", lensOnEllipse(c, c.th, 46, () => -0.3, (u) => -(0.3 + 1.25 * u)));
  if (c.peri != null) L.add("smc", lensOnEllipse(c, c.peri, 30, () => 0.05, (u) => 0.05 + 1.0 * u));
}

/** Oligodendrocyte: small round dark nucleus in a clear perinuclear halo ("fried egg"). */
function oligo(L, [x, y], r = 1) {
  L.add("oliHalo", circle(x, y, 4.6 * r));
  L.add("oliNuc", circle(x + 0.3, y + 0.3, 2.6 * r));
}

/** Ramified (surveillant) microglia: rod-shaped nucleus, long thin branched processes. */
function microglia(L, { x, y, seed = 1, rot = 0 }) {
  const R = rng(seed);
  const pieces = [blobPiece(x, y, 4.6, 2.9, { n: 8, wobble: 0.1, seed, rot })];
  const angs = [rot, rot + 180, rot + 70 + R() * 30, rot - 80 - R() * 30, rot + 130];
  angs.forEach((a, i) => {
    const o = pol(x, y, i < 2 ? 3.6 : 2.2, a);
    const pr = proc(o[0], o[1], a, 12 + R() * 7, { bend: (R() - 0.5) * 50, base: 0.95, tip: 0.28, seed: seed + i, wave: 30, seg: 5 });
    pieces.push(pr);
    for (const b of [2, 4]) pieces.push(proc(...pr.pts[b], a + (b === 2 ? 40 : -40) + (R() - 0.5) * 20, 4 + R() * 3, { base: 0.45, tip: 0.22, seed: seed + 10 + i * 3 + b }));
  });
  addCell(L, "micro", pieces);
  L.add("microNuc", ellipse(x, y, 3.3, 1.65, rot));
}

/** Kidney-shaped outline: an ellipse whose +y side (before rotation) is pushed in by `dent` (0..1). */
function bean(cx, cy, rx, ry, rot, dent) {
  const pts = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2, sn = Math.sin(a), cs = Math.cos(a);
    const y = sn > 0 ? ry * sn - 2 * dent * ry * Math.pow(sn, 3) * (1 - cs * cs) : ry * sn;
    pts.push(rotate([cx + rx * cs, cy + y], cx, cy, rot));
  }
  return smoothClosed(pts);
}

/**
 * Activated (amoeboid) microglia on a plaque at (px,py,pr): a plump body lying on the plaque edge
 * (`off` × s outside it: small = partly over the halo), processes hugging the plaque surface (the
 * microglial barrier), `nOut` short processes outward, nucleus `nuc` ("oval" | "bean" | "dent") in
 * the outer half and `nPh` phagolysosomes with ingested Aβ in the half facing the plaque.
 */
function microgliaOnPlaque(L, { px, py, pr, ang, seed = 1, span = 34, spans = null, s = 1, off = 2, nOut = 2, nuc = "oval", nPh = 2, key = "micro", nucKey = "microNuc", phKey = "phago" }) {
  const R = rng(seed);
  const pieces = [];
  const rr = pr + off * s;
  const c = pol(px, py, rr, ang);
  pieces.push(blobPiece(c[0], c[1], 6.8 * s, 4.5 * s, { n: 10, wobble: 0.08, seed, rot: ang + 90 }));
  const rh = pr + 0.3 * s;
  const a0 = ((5 * s) / rr) * 57.3;
  [-1, 1].forEach((sg, k) => {
    const sp = spans ? spans[k] : span * (k ? 1.15 : 0.85);
    const pts = [pol(px, py, rr - 0.6 * s, ang + sg * a0 * 0.45)];
    for (let i = 1; i <= 5; i++) pts.push(pol(px, py, rh - i * 0.22 * s, ang + sg * (a0 + (sp / 2) * (i / 5) * 1.3)));
    pieces.push(piece(pts, taper(1.7 * s, 0.4 * s, 1)));
  });
  for (let j = 0; j < nOut; j++) {
    const aa = ang + (nOut === 1 ? (R() - 0.5) * 40 : -46 + (92 * j) / (nOut - 1) + (R() - 0.5) * 16);
    const o = pol(c[0], c[1], 3.2 * s, aa);
    pieces.push(proc(o[0], o[1], aa, (5.5 + R() * 3) * s, { bend: (R() - 0.5) * 50, base: 0.95 * s, tip: 0.3 * s, seed: seed + 7 + j }));
  }
  addCell(L, key, pieces);
  const nc = pol(px, py, rr + 1.5 * s, ang - 4 + (R() - 0.5) * 10);
  if (nuc === "bean") L.add(nucKey, bean(nc[0], nc[1], 3.7 * s, 1.55 * s, ang + 90, 0.45));
  else if (nuc === "dent") L.add(nucKey, bean(nc[0], nc[1], 3 * s, 2 * s, ang + 90, 0.22));
  else L.add(nucKey, ellipse(nc[0], nc[1], 3 * s, 1.85 * s, ang + 90));
  // phagocytosed amyloid in phagolysosomes, well inside the cell, on the side facing the plaque
  const tg = [Math.cos(rad(ang + 90)), Math.sin(rad(ang + 90))];
  for (let j = 0; j < nPh; j++) {
    const t = nPh === 1 ? 2.2 * s : -3 * s + (6 * s * j) / (nPh - 1);
    const b = pol(px, py, rr - 1.6 * s, ang);
    L.add(phKey, circle(b[0] + tg[0] * t, b[1] + tg[1] * t, (j % 2 ? 0.8 : 1.05) * s));
  }
}

/** Free activated microglia (amoeboid, retracted thick processes). */
function microgliaAmoeboid(L, { x, y, seed = 1, rot = 0 }) {
  const R = rng(seed);
  const pieces = [blobPiece(x, y, 5.8, 4.6, { n: 8, wobble: 0.16, seed, rot })];
  for (let i = 0; i < 4; i++) {
    const a = rot + i * 90 + (R() - 0.5) * 40;
    const o = pol(x, y, 4, a);
    pieces.push(proc(o[0], o[1], a, 5 + R() * 4, { bend: (R() - 0.5) * 40, base: 1.7, tip: 0.6, seed: seed + i }));
  }
  addCell(L, "micro", pieces);
  L.add("microNuc", ellipse(x - 0.4, y + 0.3, 3.3, 2.1, rot + 20));
  L.add("phago", circle(x + 2.6, y - 1.6, 1));
}

/**
 * Amyloid-β plaque: halo of fibrillar amyloid with radiating fibrils; `cored` adds a compact core
 * and dystrophic neurites (swollen, tau-laden neurite bulbs) in the corona. Diffuse plaques are
 * fluffy, ill-defined and lack a core and neurites.
 */
function plaque(L, { x, y, r, seed = 1, cored = true, neurites = 7, s = 1, avoid = [] }) {
  const R = rng(seed);
  if (!cored) {
    // diffuse plaque: an ill-defined, translucent cloud of non-fibrillar Aβ (a fainter outer zone,
    // 11 small lobes with a ragged edge and a few wisps), no core, no neurites
    L.add("diffOuter", smoothClosed(blobPts(x, y, r * 1.12, r * 1.04, { n: 14, wobble: 0.12, seed: seed + 50 })));
    const lobes = [smoothClosed(blobPts(x, y, r * 0.55, r * 0.5, { n: 9, wobble: 0.15, seed }))];
    for (let i = 0; i < 11; i++) {
      const c = pol(x, y, r * (0.5 + R() * 0.22), i * 32.7 + R() * 16);
      lobes.push(smoothClosed(blobPts(c[0], c[1], r * (0.24 + R() * 0.1), r * (0.21 + R() * 0.08), { n: 7, wobble: 0.25, seed: seed + i, rot: R() * 180 })));
    }
    addTo(L, "diffuse", lobes);
    for (let i = 0; i < 14; i++) {
      const c = pol(x, y, r * (0.25 + Math.sqrt(R()) * 0.75), R() * 360), a = R() * 360, l = 2 + R() * 3;
      L.add("amyFib", smoothOpen([pol(c[0], c[1], -l, a), pol(c[0], c[1], 0.7, a + 40), pol(c[0], c[1], l, a)]));
    }
    return;
  }
  // sizes below are given for a plaque of radius 52 and scaled by k
  const k = Math.max(r / 52, 0.4);
  // corona: no outline of its own — three lobed zones of fibrillar Aβ, densest round the core and
  // fading outward, with radiating fibrils whose tips make the ragged outer edge
  // zones with lumpy, uneven edges (the outer one most irregular)
  for (const [key, fr, amp, sd] of [["haloOut", 1.0, 1.9, 11], ["halo", 0.8, 1.3, 23], ["haloIn", 0.56, 0.9, 37]]) {
    if (L.map.has(key)) addTo(L, key, smoothClosed(lobedPts(x, y, r * fr, seed + sd, amp, 8)));
  }
  const rc = r * 0.28;
  const edge = lobedFn(seed + 11, 0.11 * 1.9);
  const inHalo = (p, m = 0.93) => dist(p, [x, y]) < r * m * edge((Math.atan2(p[1] - y, p[0] - x) * 180) / Math.PI);
  const fib = [];
  // radial fibrils from the core, most of them short, so the density falls off outward
  for (let i = 0, nf = Math.round(32 * Math.min(1, 0.5 + k)); i < nf; i++) {
    const a = R() * 360;
    const rs = rc * (0.85 + R() * 0.25);
    const re = rs + (r * 0.92 * edge(a) - rs) * (0.22 + 0.78 * Math.pow(R(), 1.5));
    const dev = (R() - 0.5) * 50;
    const p0 = pol(x, y, rs, a), p2 = pol(p0[0], p0[1], re - rs, a + dev);
    const p1 = pol((p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2, (R() - 0.5) * 2.4 * k, a + dev + 90);
    const w0 = (0.32 + R() * 0.38) * k * 1.6;
    fib.push(smoothClosed(tubePts([p0, p1, p2], (t) => w0 * (1 - 0.8 * t), { step: Math.max(0.8, 1.6 * k) })));
  }
  // curved bundles of 2–3 strands running obliquely or round the plaque, one strand crossing the others
  for (let i = 0, nb = Math.round(15 * Math.min(1, 0.5 + k)); i < nb; i++) {
    const a = R() * 360, rho = r * (0.42 + R() * 0.32);
    const head = a + (R() < 0.55 ? 90 * (R() < 0.5 ? 1 : -1) + (R() - 0.5) * 50 : (R() - 0.5) * 100);
    const L0 = (10 + R() * 12) * k, bend = (R() - 0.5) * 60;
    const c0 = pol(x, y, rho, a);
    const cl = [c0];
    for (let j = 1; j <= 4; j++) cl.push(pol(cl[j - 1][0], cl[j - 1][1], L0 / 4, head + (bend * j) / 4));
    if (!cl.every((p) => inHalo(p) && dist(p, [x, y]) > rc * 1.2)) continue;
    const ns = R() < 0.5 ? 2 : 3, cross = Math.floor(R() * ns);
    for (let s2 = 0; s2 < ns; s2++) {
      const off0 = (s2 - (ns - 1) / 2) * 1.05 * k;
      const pts = cl.map((p, j) => {
        const q = cl[Math.min(4, j + 1)], o = cl[Math.max(0, j - 1)], l = dist(o, q) || 1;
        const nrm = [-(q[1] - o[1]) / l, (q[0] - o[0]) / l];
        const off = s2 === cross ? off0 * (1 - (2 * j) / 4) : off0; // this one swaps sides
        return [p[0] + nrm[0] * off, p[1] + nrm[1] * off];
      }).slice(0, ns === 3 && s2 === 2 ? 4 : 5);
      const w0 = (0.3 + R() * 0.2) * k * 1.6;
      fib.push(smoothClosed(tubePts(pts, (t) => w0 * (1 - 0.55 * Math.abs(t - 0.45) * 2), { step: Math.max(0.8, 1.4 * k) })));
    }
  }
  L.add("fibril", fib);
  // compact core: lobulated and irregular, with 6–9 fibrillar spikes of uneven length and width
  // (some blunt) and one smooth stretch without spikes; darker at its centre
  const nSp = 6 + Math.floor(R() * 4), smooth0 = R() * 360, smoothLen = 70 + R() * 35;
  const spikes = unevenSpacing(nSp, 360 - smoothLen - 16, R, { cv: 0.45 }).map((s) => ({
    a: smooth0 + smoothLen + 8 + s, w: 6 + R() * 12, h: (1 + R() * 3) * Math.max(k, 0.55), blunt: R() < 0.35,
  }));
  const lump = lobedFn(seed + 3, 0.17);
  const core = [];
  for (let a = 0; a < 360; a += 3) {
    let rr = rc * lump(a);
    for (const sp of spikes) {
      const d = Math.abs(angDiff(a, sp.a));
      if (d < sp.w) rr += sp.h * (sp.blunt ? Math.pow(1 - Math.pow(d / sp.w, 2), 0.7) : Math.pow(1 - d / sp.w, 1.7));
    }
    core.push(pol(x, y, rr, a));
  }
  L.add("amyloid", smoothClosed(core, 0.8));
  L.add("coreIn", smoothClosed(lobedPts(x + 0.04 * rc, y + 0.04 * rc, rc * 0.62, seed + 5, 1.4)));
  if (L.map.has("coreDark")) L.add("coreDark", smoothClosed(lobedPts(x + 0.08 * rc, y + 0.06 * rc, rc * 0.3, seed + 6, 1.6)));
  // dystrophic neurites: the swollen ends and segments of neurites that run into the corona from the
  // surrounding neuropil, each of a different size — club-shaped bulbs on a tapering neck, beaded
  // strings and irregular fusiform swellings — packed with small tau granules. Each neurite is ONE
  // united silhouette with its parent process, which runs out past the edge of the plaque.
  const kinds = ["club", "bead", "seg", "club", "bead", "club", "seg", "club"];
  const sizes = [7.2, 4.4, 5.6, 3.4, 6.2, 5, 4.2, 6.6];
  const nw = 0.72 * k; // half-width of a parent neurite
  const usedA = [];
  const nAng = unevenAngles(neurites, R, { cv: 0.4 });
  for (let i = 0; i < neurites; i++) {
    const kind = kinds[i % kinds.length], b = sizes[i % sizes.length] * k;
    let a = nAng[i];
    for (let t = 0; t < 12 && (avoid.some((av) => Math.abs(((a - av + 540) % 360) - 180) < 26) || usedA.some((u) => Math.abs(((a - u + 540) % 360) - 180) < 300 / neurites / 1.4)); t++) a += 9;
    usedA.push(a);
    const rr = Math.max(rc + 6.5 * k + b, r * (0.5 + R() * 0.16));
    const c = pol(x, y, rr, a);
    // the parent neurite: from the swelling out past the plaque edge, wandering a little
    let ta = a + (R() - 0.5) * 60;
    for (const av of avoid) {
      const d = ((ta - av + 540) % 360) - 180;
      if (Math.abs(d) < 30) ta = av + (d < 0 ? -30 : 30);
    }
    const path = [c];
    let p = c, h = ta;
    const reach = r + (4 + R() * 5) * k * 1.3;
    for (let q = 0; q < 80 && dist(p, [x, y]) < reach; q++) {
      const radial = (Math.atan2(p[1] - y, p[0] - x) * 180) / Math.PI;
      h += (R() - 0.5) * 26 + (((radial - h + 540) % 360) - 180) * 0.12;
      p = pol(p[0], p[1], 2.4 * k, h);
      path.push(p);
    }
    const shapes = [], gran = [];
    const granules = (cx, cy, rx, ry, rot, n, sd) => {
      const R2 = rng(sd);
      const pts = [];
      for (let t = 0; pts.length < n && t < 300; t++) {
        const g = rotate([cx + (R2() - 0.5) * 2 * rx * 0.6, cy + (R2() - 0.5) * 2 * ry * 0.52], cx, cy, rot);
        if (pts.some((q) => dist(q, g) < 1.1 * k * 1.6)) continue;
        pts.push(g);
      }
      for (const g of pts) gran.push(smoothClosed(blobPts(g[0], g[1], (0.5 + R2() * 0.35) * k * 1.6, (0.4 + R2() * 0.3) * k * 1.6, { n: 6, wobble: 0.3, seed: sd + g[0] | 0, rot: R2() * 180 })));
    };
    if (kind === "club") {
      // bulbous end on a neck that tapers into the parent neurite
      shapes.push(smoothClosed(blobPts(c[0], c[1], b, b * 0.78, { n: 9, wobble: 0.1, seed: seed + 60 + i, rot: ta })));
      shapes.push(smoothClosed(tubePts(path, (t) => nw + (b * 0.6 - nw) * Math.exp(-Math.pow((t * dist(path[0], path[path.length - 1])) / (b * 1.5), 2)), { step: Math.max(0.6, k) })));
      granules(c[0], c[1], b, b * 0.78, ta, 4 + (i % 3), seed + 70 + i);
    } else if (kind === "bead") {
      // a string of 3 (or 4) swellings of falling size along the neurite
      shapes.push(smoothClosed(tubePts(path, nw, { step: Math.max(0.6, k) })));
      const nb = i % 2 ? 4 : 3;
      let s0 = 0;
      const cum = [0];
      for (let q = 1; q < path.length; q++) cum.push(cum[q - 1] + dist(path[q], path[q - 1]));
      const atS = (sv) => { const q = cum.findIndex((v) => v >= sv); return path[q < 0 ? path.length - 1 : q]; };
      for (let j = 0; j < nb; j++) {
        const bj = b * (1 - 0.2 * j) * (0.9 + R() * 0.2);
        const q = atS(s0);
        if (dist(q, [x, y]) > r * 0.98) break;
        shapes.push(smoothClosed(blobPts(q[0], q[1], bj * 0.95, bj * 0.78, { n: 8, wobble: 0.12, seed: seed + 80 + i * 5 + j, rot: ta })));
        granules(q[0], q[1], bj * 0.95, bj * 0.78, ta, j < 2 ? 2 : 1, seed + 90 + i * 5 + j);
        s0 += bj + b * (1 - 0.2 * (j + 1)) + 1.6 * k;
      }
    } else {
      // an irregular, lumpy fusiform swelling along a neurite that runs on a little beyond it
      const back = pol(c[0], c[1], -b * 1.9, ta);
      const segPath = [back, ...path];
      const tot = segPath.reduce((s, q, j) => s + (j ? dist(q, segPath[j - 1]) : 0), 0);
      const u0 = (b * 1.9) / tot, sp = (b * 1.3) / tot;
      shapes.push(smoothClosed(tubePts(segPath, (t) => nw * (t < 0.04 ? 0.6 : 1) + b * 0.62 * Math.exp(-Math.pow((t - u0 + sp * 0.35) / sp, 2)) + b * 0.42 * Math.exp(-Math.pow((t - u0 - sp * 0.55) / (sp * 0.6), 2)), { step: Math.max(0.5, k * 0.8) })));
      granules(c[0], c[1], b * 1.2, b * 0.55, ta, 4 + (i % 2), seed + 99 + i);
    }
    addTo(L, "dystro", shapes);
    L.add("tauDot", gran);
  }
}

/** Polar outline with a few soft lobes (plaque zones, cores): radius R × (1 ± amp·0.08). */
function lobedFn(seed, amp = 0.08) {
  const R = rng(seed);
  const h = [[2, R() * 6.28, 0.35], [3, R() * 6.28, 0.45], [5, R() * 6.28, 0.3], [8, R() * 6.28, 0.18]];
  return (a) => 1 + amp * h.reduce((s, [n, ph, w]) => s + w * Math.sin(rad(a) * n + ph), 0);
}
function lobedPts(x, y, Rr, seed, amp = 1, step = 10) {
  const fn = lobedFn(seed, 0.11 * amp);
  const out = [];
  for (let a = 0; a < 360; a += step) out.push(pol(x, y, Rr * fn(a), a));
  return out;
}

/* ===================== cortex section (healthy / AD) ===================== */

/**
 * A neuropil thread: a short tau-filled dendritic fragment (4–8 long, ~1 thick) shaped as a C, a gentle
 * S or a kinked stick, with 0–2 fusiform varicosities.
 */
function threadD(x, y, len, ang, kind, nVar, R) {
  const n = 6, B = 40 + R() * 35, sg = R() < 0.5 ? 1 : -1;
  const head = (j) => {
    const u = j / (n - 1);
    if (kind === "C") return ang + sg * B * (u - 0.5);
    if (kind === "S") return ang + sg * B * 0.6 * Math.sin(2 * Math.PI * u);
    return ang + (j >= 3 ? sg * (34 + R() * 12) : 0); // kinked
  };
  let p = pol(x, y, -len / 2, ang);
  const pts = [p];
  for (let j = 0; j < n; j++) {
    p = pol(p[0], p[1], len / n, head(j));
    pts.push(p);
  }
  const hw = 0.42 + R() * 0.12;
  const vs = nVar ? (nVar > 1 ? [0.3, 0.68] : [0.38 + R() * 0.25]) : [];
  return smoothClosed(tubePts(pts, (t) => hw * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.02))) + vs.reduce((s, v) => s + 0.48 * Math.exp(-Math.pow((t - v) / 0.08, 2)), 0), { step: 0.6 }));
}

function cortex(ad, style = "soft") {
  SH = { max: 0.9, k: 0.42, body: 1 };
  STYLE = style;
  FRAME = [8.5, 34, 311.5, 231.5];
  const W = 320, H = 240, x0 = 6, y0 = 6, x1 = W - 6, y1 = H - 6;
  const L = new Layers();
  const piaY = (x) => 31 + Math.sin(x / 37 + 0.6) * 1.4 + Math.sin(x / 13) * 0.4;
  const pia = [];
  for (let x = x0; x <= x1 + 0.01; x += 4) pia.push([x, piaY(x)]);

  // vessels: pial artery and its penetrating arteriole, which runs down through the whole field and
  // leaves the section at the bottom edge, giving off two branches that narrow towards capillary size
  // and are cut obliquely; capillaries cut across. Processes are kept clear of all of them.
  // AD: amyloid (CAA) replaces the outer media, so the walls of the pial artery and of the upper
  // arteriole are thicker (the lumen is unchanged) and the perivascular space is enlarged.
  const pa = ad ? { cx: 262, cy: 21.5, rx: 11, ry: 9 } : { cx: 262, cy: 21.5, rx: 10, ry: 8 };
  const pen = [[262, 26], [263.5, 80], [266, 140], [267.2, 196], [267.4, y1]];
  const wallH = (t) => 4.8 - 1.3 * t;
  const caaW = (t) => (ad ? 0.95 * (1 - clamp((t - 0.58) / 0.16)) : 0);
  const wallW = (t) => wallH(t) + caaW(t);
  const lumW = (t) => wallH(t) - 2.3 + 0.55 * t;
  const branches = [{ t: 0.36, ang: 33, len: 20, bend: 10 }, { t: 0.72, ang: 143, len: 19, bend: -10 }].map((b) => {
    const q = at(pen, b.t).p;
    const e = pol(q[0], q[1], b.len, b.ang);
    const m = pol((q[0] + e[0]) / 2, (q[1] + e[1]) / 2, b.bend * 0.12, b.ang + 90);
    return { ...b, pts: [q, m, e], end: e, face: (Math.atan2(e[1] - m[1], e[0] - m[0]) * 180) / Math.PI };
  });
  // capillaries: ~7 × 6 units, each with one endothelial nucleus at a seeded angle; two with a pericyte
  const caps = [
    { cx: 46, cy: 112, rx: 3.6, ry: 3.0, rot: 20, seed: 30 },
    { cx: 195, cy: 106, rx: 3.4, ry: 3.0, rot: -30, seed: 31, peri: true },
    { cx: 100, cy: 176, rx: 3.7, ry: 3.1, rot: 10, seed: 32 },
    { cx: 246, cy: 214, rx: 3.5, ry: 2.9, rot: 60, seed: 33, peri: true },
    { cx: 288, cy: 99, rx: 3.4, ry: 3.0, rot: 0, seed: 34 },
    { cx: 101, cy: 67, rx: 3.3, ry: 2.9, rot: -15, seed: 35 },
  ].map((c) => {
    const R = rng(c.seed * 7);
    const th = R() * 360;
    return { ...c, th, peri: c.peri ? th + 180 + (R() - 0.5) * 50 : null };
  });
  AVOID = caps.map((c) => [c.cx, c.cy, Math.max(c.rx, c.ry) + 3]);
  for (let t = 0; t <= 1.001; t += 0.04) AVOID.push([...at(pen, Math.min(t, 1)).p, t < 0.64 ? (ad ? 9 : 7.6) : 6]);
  for (const b of branches) for (let t = 0.3; t <= 1.001; t += 0.14) AVOID.push([...at(b.pts, Math.min(t, 1)).p, 4.8]);

  L.def("csf", { fill: P.csf, stroke: sw(shade(P.csf, 0.12), 0.9), lineWidth: 1 })
    .def("arach", { fill: P.arach, stroke: sw(shade(P.arach, 0.12), 0.6), lineWidth: 0.8 })
    .def("trab", { fill: "none", stroke: { color: shade(P.arach, 0.04), width: 0.9, cap: "round" }, lineColor: "#d7a3a6", lineStrokeWidth: 0.6 })
    .def("neuropil", { fill: P.neuropil, lineWidth: 0.9 })
    .def("fibre", { fill: "none", stroke: { color: P.fibre, width: 0.7, cap: "round" }, line: false, opacity: 0.9 })
    // diffuse plaques and plaque coronas are ill-defined: no outlines in line style
    .def("diffOuter", { fill: tint(P.diffuse, 0.03), opacity: 0.42, ...noLine(tint(P.diffuse, 0.03)) })
    .def("diffuse", { fill: P.diffuse, opacity: 0.66, unite: [], ...noLine(P.diffuse) })
    .def("haloOut", { fill: P.halo, opacity: 0.4, ...noLine(P.halo) })
    .def("halo", { fill: P.halo, opacity: 0.6, ...noLine(P.halo) })
    .def("haloIn", { fill: P.halo, opacity: 0.6, line: false })
    .def("amyFib", { fill: "none", stroke: { color: P.amyFib, width: 0.75, cap: "round" }, lineStrokeWidth: 0.4 })
    .def("fibril", { fill: P.amyFib, opacity: 0.95, lineWidth: 0.15, thin: true });
  // astrocytes lie beneath the vessels, so their end-feet tuck under the vessel walls
  cellLayers(L, "astro", P.astro);
  L.def("astroNuc", { fill: P.astroNuc, shade: "small", lineWidth: 0.4 })
    .def("pvs", { fill: P.csf, lineWidth: 0.4 })
    .def("pia", { fill: "none", stroke: { color: P.pia, width: 1.7, cap: "round" }, lineStrokeWidth: 1 })
    .def("piaNuc", { fill: shade(P.pia, 0.18), lineWidth: 0.3 })
    .def("artWall", { fill: P.artWall, unite: [], lineWidth: 0.7 })
    .def("artLumen", { fill: P.artLumen, unite: [], lineWidth: 0.4 })
    .def("smc", { fill: P.smc, lineWidth: 0.3 })
    .def("cutWall", { fill: shade(P.artWall, 0.05), lineWidth: 0.45 })
    .def("cutLumen", { fill: P.artLumen, lineWidth: 0.3 });
  // capillary profiles (thin wall, no heavy outline), red cells and endothelial nuclei
  L.def("wall", { fill: C.wall, shade: "rim", lineWidth: 0.4 })
    .def("lumen", { fill: C.lumen, lineWidth: 0.25 })
    .def("rbc", { fill: C.rbc, shade: "small", lineWidth: 0.35 })
    .def("endo", { fill: C.endo, lineWidth: 0.3 });
  L.def("caa", { fill: P.amyloid, shade: "rim", lineWidth: 0.4 })
    .def("oliHalo", { fill: P.oliHalo, stroke: sw(shade(P.oliHalo, 0.08), 0.5), lineWidth: 0.4 })
    .def("oliNuc", { fill: P.oliNuc, shade: "small", lineWidth: 0.4 });
  cellLayers(L, "neuron", P.neuron);
  // line style: axons beyond the hillock are single thin strokes in the neuron's own hue
  L.def("axonLine", { fill: "none", stroke: { color: P.neuron, width: 0.6, cap: "round" }, lineColor: shade(P.neuron, 0.3), lineStrokeWidth: 0.6, soft: false });
  cellLayers(L, "inter", P.inter);
  L.def("tangle", { fill: P.tangle, lineWidth: 0.4 })
    .def("tangleFib", { fill: "none", stroke: { color: tint(P.tangle, 0.16), width: 0.45, cap: "round" }, line: false })
    .def("nNuc", { fill: P.nNuc, shade: "small", lineWidth: 0.45 })
    .def("nucleolus", { fill: P.nucleolus, lineWidth: 0.3 })
    // ghost tangle: a faint flame-shaped envelope (dashed outline in line style only) round pale, loose fibrils
    .def("ghostEnv", { fill: tint(P.tangle, 0.62), opacity: 0.32, ...noLine(tint(P.tangle, 0.62)) })
    .def("ghostLine", { fill: "none", stroke: { color: tint(P.tangle, 0.3), width: 0.4, dash: [1.2, 1.1] }, lineColor: tint(P.tangle, 0.3), lineStrokeWidth: 0.4, soft: false })
    .def("ghost", { fill: "none", stroke: { color: tint(P.tangle, 0.45), width: 0.6, cap: "round" }, lineColor: tint(P.tangle, 0.25), lineStrokeWidth: 0.5 })
    .def("thread", { fill: P.tangle, lineWidth: 0.2, unite: [] })
    .def("amyloid", { fill: P.amyloid, shade: "small", lineWidth: 0.45 })
    .def("coreIn", { fill: P.core, lineWidth: 0.3, thin: true })
    .def("dystro", { fill: P.dystro, shade: "small", lineWidth: 0.4, unite: [] })
    .def("tauDot", { fill: P.tangle, lineWidth: 0.2 });
  cellLayers(L, "micro", P.micro);
  L.def("microNuc", { fill: P.microNuc, shade: "small", lineWidth: 0.4 })
    .def("phago", { fill: P.phago, lineWidth: 0.25 });

  // frame: subarachnoid space (CSF), arachnoid along the top, cortex below the pia
  L.add("csf", `M${x0} ${y0 + 9}Q${x0} ${y0} ${x0 + 9} ${y0}H${x1 - 9}Q${x1} ${y0} ${x1} ${y0 + 9}V${y1 - 9}Q${x1} ${y1} ${x1 - 9} ${y1}H${x0 + 9}Q${x0} ${y1} ${x0} ${y1 - 9}Z`);
  L.add("arach", `M${x0} ${y0 + 9}Q${x0} ${y0} ${x0 + 9} ${y0}H${x1 - 9}Q${x1} ${y0} ${x1} ${y0 + 9}V12.6` + lineD([...Array(40)].map((_, i) => [x1 - (i * (x1 - x0)) / 39, 12.2 + Math.sin(i * 0.9) * 0.5])).replace("M", "L") + "Z");
  for (const tx of [26, 74, 118, 168, 214, 296]) L.add("trab", smoothOpen([[tx, 13], [tx + 2.5, 20], [tx - 1, piaY(tx - 1) - 1]]));
  L.add("neuropil", lineD(pia) + `L${x1} ${y1 - 9}Q${x1} ${y1} ${x1 - 9} ${y1}H${x0 + 9}Q${x0} ${y1} ${x0} ${y1 - 9}Z`);
  // tangential fibres of layer I and a few fibres deeper in the neuropil
  const RF = rng(7);
  for (let i = 0; i < 6; i++) {
    const yy = 38 + i * 4.6, xa = 10 + RF() * 60, xb = xa + 90 + RF() * 150;
    L.add("fibre", smoothOpen([[xa, yy], [(xa * 2 + xb) / 3, yy + (RF() - 0.5) * 4], [(xa + xb * 2) / 3, yy + (RF() - 0.5) * 4], [Math.min(xb, x1 - 4), yy + (RF() - 0.5) * 3]]));
  }
  for (let i = 0; i < 16; i++) {
    const p = [14 + RF() * (W - 28), 70 + RF() * (H - 84)], a = RF() * Math.PI;
    L.add("fibre", smoothOpen([[p[0] - Math.cos(a) * 12, p[1] - Math.sin(a) * 12], [p[0] + 2, p[1] - 1.5], [p[0] + Math.cos(a) * 12, p[1] + Math.sin(a) * 12]]));
  }

  // pial artery and penetrating arteriole in its perivascular (Virchow–Robin) space
  // (the perivascular space narrows and closes about two thirds of the way down)
  const pvsEnd = 0.64, wEnd = wallW(pvsEnd) + 0.05, pv0 = ad ? 7.4 : 6;
  L.add("pvs", piece([[262, 30], [263.5, 80], [266, 140], at(pen, pvsEnd).p], (t) => pv0 - (pv0 - wEnd) * Math.pow(t, 1.4)).d);
  const aw = L.map.get("artWall").unite, al = L.map.get("artLumen").unite;
  aw.push(ellipse(pa.cx, pa.cy, pa.rx, pa.ry), flatTube(pen, wallW));
  al.push(ellipse(pa.cx, pa.cy, 7.2, 5.4), flatTube([[262, 22], ...pen.slice(1)], lumW));
  // branches: narrowing over ~20 units and cut obliquely (an elliptical face showing the lumen and a red cell)
  for (const b of branches) {
    const w0 = wallH(b.t) * 0.85, l0 = lumW(b.t) * 0.85;
    aw.push(flatTube(b.pts, (t) => w0 - (w0 - 2.8) * t));
    al.push(flatTube(b.pts, (t) => l0 - (l0 - 1.45) * t));
    L.add("cutWall", ellipse(b.end[0], b.end[1], 2.3, 3, b.face));
    L.add("cutLumen", ellipse(b.end[0] + 0.1, b.end[1] + 0.1, 1.3, 1.85, b.face));
    L.add("rbc", ellipse(b.end[0] + 0.15, b.end[1] + 0.15, 0.85, 1.25, b.face + 20));
  }
  L.add("rbc", ellipse(pa.cx - 1, pa.cy + 0.5, 3, 2.3, 30));
  for (const t of [0.1, 0.27, 0.45, 0.6, 0.79, 0.95]) {
    const q = at(pen, t);
    L.add("rbc", ellipse(q.p[0], q.p[1], Math.min(1.4, lumW(t) - 0.35), 2.1, q.ang + 90));
  }
  // cerebral amyloid angiopathy (AD): Aβ replacing the outer media in long, patchy segments on both
  // walls of the upper arteriole and round ~270° of the pial artery
  const caaPial = [[-206, -42], [-28, 66]];
  const caaPen = [[0.02, 0.21, 1], [0.27, 0.5, 1], [0.06, 0.31, -1], [0.37, 0.59, -1]];
  const inCAA = (t, side) => ad && caaPen.some(([a, b, sd]) => sd === side && t > a - 0.01 && t < b + 0.01);
  // smooth-muscle nuclei, thinning out as the arteriole narrows
  [0.04, 0.1, 0.17, 0.25, 0.34, 0.44, 0.56, 0.7, 0.87].forEach((t, i) => {
    const q = at(pen, t), side = i % 2 ? 1 : -1;
    if (inCAA(t, side)) return;
    const off = (wallH(t) + lumW(t)) / 2 + caaW(t) * 0.5;
    L.add("smc", ellipse(q.p[0] - q.dir[1] * side * off, q.p[1] + q.dir[0] * side * off, 1.6 - 0.35 * t, 0.75, q.ang));
  });
  for (let i = 0; i < 9; i++) {
    const a = i * 40 + 10, aa = ((a + 180) % 360) - 180;
    if (ad && caaPial.some(([p, q]) => (aa > p - 4 && aa < q + 4) || (aa - 360 > p - 4 && aa - 360 < q + 4))) continue;
    const q = [pa.cx + Math.cos(rad(a)) * (pa.rx - 1.4), pa.cy + Math.sin(rad(a)) * (pa.ry - 1.3)];
    L.add("smc", ellipse(q[0], q[1], 1.5, 0.7, a + 90));
  }
  if (ad) {
    for (const [a0, a1] of caaPial) L.add("caa", ellipseBand(pa, a0, a1, -1.75, 2.5, 0.35));
    for (const [t0, t1, side] of caaPen) {
      const pts = [];
      for (let t = t0; t <= t1 + 0.001; t += 0.015) {
        const q = at(pen, t), off = wallW(t) - 1.45;
        pts.push([q.p[0] - q.dir[1] * side * off, q.p[1] + q.dir[0] * side * off]);
      }
      L.add("caa", ribbon(pts, 2.4, { taper: 0.35 }));
    }
  }
  // pia with flattened meningothelial nuclei
  L.add("pia", smoothOpen(pia));
  for (const px of [20, 58, 104, 150, 196, 236, 300]) L.add("piaNuc", ellipse(px, piaY(px) - 0.2, 2.6, 0.9, (Math.atan2(piaY(px + 1) - piaY(px - 1), 2) * 180) / Math.PI));

  // capillaries
  caps.forEach((c) => capillary(L, c));
  const cap = (i) => ({ ...caps[i] });

  // plaques (AD): plaque-associated microglia sit at uneven angles — two close together, one apart
  const P1 = { x: 152, y: 150, r: 26 }, P2 = { x: 204, y: 196, r: 17 }, P3 = { x: 34, y: 160, r: 11 };
  const mgA = [-46, 4, 168];
  if (ad) {
    plaque(L, { ...P1, seed: 5, cored: true, neurites: 8, avoid: mgA });
    plaque(L, { ...P2, seed: 9, cored: false });
    plaque(L, { ...P3, seed: 13, cored: true, neurites: 4, avoid: [10] });
  }

  // oligodendrocytes (satellites beside neuronal somata and free in the neuropil)
  const olis = ad
    ? [[88, 154], [20, 122], [276, 88], [292, 226], [120, 226], [168, 214], [222, 178], [60, 66]]
    : [[88, 154], [164, 144], [140, 216], [20, 122], [276, 88], [222, 178], [292, 226], [60, 66], [104, 226]];
  for (const p of olis) oligo(L, p);
  // dendrites and glial processes pass beside the oligodendrocytes, not over them
  for (const [ox, oy] of olis) AVOID.push([ox, oy, 5.4]);

  // astrocytes: end-feet on every capillary, on the penetrating arteriole and on the pia; each soma
  // sits between the apical dendrites, never on one
  const astros = [
    { x: 92, y: 48, seed: 3, feet: [{ pia: piaY(81), x: 81 }, { pia: piaY(104), x: 104 }, cap(5)] },
    { x: 66, y: 120, seed: 5, feet: [cap(0)] },
    { x: 206, y: 122, seed: 7, feet: [cap(1)] },
    { x: 116, y: 162, seed: 11, feet: [cap(2)] },
    { x: 247, y: 100, seed: 13, feet: [{ pad: [[257.3, 88.5], [257.7, 96], [258.1, 103.5]] }] },
    { x: 236, y: 203, seed: 17, feet: [cap(3)] },
    { x: 283, y: 76, seed: 29, feet: [cap(4)] },
  ];
  if (ad) {
    // the arteriole's AD wall is thicker: its end-foot pad sits a little further out
    astros[4].feet = [{ pad: [[256.6, 88.5], [257, 96], [257.4, 103.5]] }];
  }
  for (const a of astros) {
    if (ad && a.seed === 11) continue;
    astrocyte(L, { ...a, reactive: ad });
  }
  const extra = ad ? [
    // gliosis: extra hypertrophic astrocytes reaching towards the dense-cored plaque
    { x: 110, y: 126, seed: 19, toward: { ang: 32, extra: 5 }, feet: [] },
    { x: 190, y: 181, seed: 23, toward: { ang: 220, extra: 5 }, feet: [] },
    { x: 108, y: 188, seed: 11, feet: [cap(2)] },
  ] : [];
  for (const a of extra) astrocyte(L, { ...a, reactive: true });

  const mgFree = ad ? [[139, 51], [286, 140]] : [[139, 51], [22, 150], [166, 180], [286, 140]];
  SOMAS = [...[...astros, ...extra].map((a) => [a.x, a.y, ad ? 9 : 8]), ...mgFree.map(([x, y]) => [x, y, 7]),
    [100, 116, 7], [284, 164, 7], [22, 178, 7], [172, 70, 7], ...(ad ? [[P1.x, P1.y, P1.r * 0.45]] : [])];
  // pyramidal neurons (rows in layers II–III, apical dendrites to layer I)
  const pyr = [
    { x: 34, y: 86, s: 0.82, seed: 101 },
    { x: 112, y: 84, s: 0.86, seed: 103 },
    { x: 208, y: 80, s: 0.82, seed: 107 },
    { x: 76, y: 144, s: 1, seed: 109 },
    { x: 150, y: 136, s: 1.05, seed: 113 },
    { x: 226, y: 146, s: 1, seed: 127 },
    { x: 54, y: 206, s: 1.08, seed: 131 },
    { x: 128, y: 208, s: 1.1, seed: 137 },
    { x: 186, y: 206, s: 1.05, seed: 139 },
    { x: 299, y: 196, s: 0.95, seed: 149 },
  ];
  // AD: neuron loss (1, 4, 7, 8 gone), the survivors shrunken; tangles in three
  const keep = ad ? [0, 2, 3, 5, 6, 9] : pyr.map((_, i) => i);
  const tangles = new Set([0, 3, 6]);
  for (const i of keep) pyramidal(L, { ...pyr[i], top: 46 + (i % 3) * 3, ad, tangle: ad && tangles.has(i) });

  // interneurons
  const ints = [
    { x: 100, y: 116, s: 0.95, seed: 201, rot: 10 },
    { x: 284, y: 164, s: 0.95, seed: 203, rot: 40 },
    { x: 22, y: 178, s: 0.85, seed: 207, rot: 0 },
    { x: 172, y: 70, s: 0.85, seed: 211, rot: 20 },
  ];
  ints.forEach((p, i) => {
    if (ad && i === 3) return;
    interneuron(L, { ...p, ad });
  });

  if (ad) {
    // ghost tangle: the extracellular remains of a tangle whose neuron (no. 1) has died — pale, loose
    // fibrils in a faint flame-shaped envelope the size of a shrunken soma
    const gx = 111, gy = 88;
    const env = [[0, -8], [2.2, -4.5], [4.6, 0], [5, 3.5], [3, 6], [0, 6.6], [-3.2, 5.8], [-5, 3], [-4.2, -0.5], [-1.8, -4.8]].map(([a, b]) => [gx + a, gy + b]);
    L.add("ghostEnv", smoothClosed(env));
    L.add("ghostLine", smoothClosed(env));
    const RG = rng(41);
    for (const [ox, top] of [[-3, -1.2], [-1.6, -4.6], [0.1, -6.4], [1.6, -3.8], [3, -0.6]]) {
      const pts = [];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        pts.push([gx + ox * (1 - t * 0.6) + Math.sin(t * 7 + ox * 2) * 0.45 * (0.5 + RG()), gy + 4.6 + (top - 4.6) * t]);
      }
      L.add("ghost", smoothOpen(pts));
    }
    // neuropil threads (tau-filled dendritic fragments): clustered round the dense-cored plaque and the
    // tangle-bearing neurons, some lying along a dendrite's course
    const RT = rng(77);
    for (const [tx, ty, len, a, kind, nv] of [
      [184, 126, 7, 62, "C", 1], [124, 178, 6, 18, "S", 0], [160, 184, 5.5, 104, "K", 0], [188, 151, 4.5, 140, "C", 0],
      [91, 132, 7, 78, "S", 1], [63, 163, 5, 112, "C", 0], [46, 70, 6.5, 96, "K", 1], [21, 101, 4.5, 70, "C", 0],
      [69, 192, 7.5, 84, "S", 0], [40, 223, 5, 18, "C", 2], [212, 58, 6, 90, "S", 0], [231, 104, 5, 94, "C", 1], [24, 141, 4.5, 150, "K", 0],
    ]) addTo(L, "thread", threadD(tx, ty, len, a, kind, nv, RT));
  }

  // microglia
  if (!ad) {
    microglia(L, { x: 139, y: 51, seed: 301, rot: 10 });
    microglia(L, { x: 22, y: 150, seed: 303, rot: 70 });
    microglia(L, { x: 166, y: 180, seed: 307, rot: -20 });
    microglia(L, { x: 286, y: 140, seed: 311, rot: 100 });
  } else {
    // plaque-associated microglia, each different; the close pair keep short processes on their
    // facing sides so the two cells stay apart
    microgliaOnPlaque(L, { px: P1.x, py: P1.y, pr: P1.r, ang: mgA[0], seed: 321, s: 1.15, off: 0.9, spans: [30, 12], nOut: 2, nuc: "bean", nPh: 2 });
    microgliaOnPlaque(L, { px: P1.x, py: P1.y, pr: P1.r, ang: mgA[1], seed: 323, s: 1.05, off: 3.2, spans: [12, 40], nOut: 2, nuc: "oval", nPh: 1 });
    microgliaOnPlaque(L, { px: P1.x, py: P1.y, pr: P1.r, ang: mgA[2], seed: 327, s: 1.25, off: 1.8, spans: [30, 42], nOut: 1, nuc: "dent", nPh: 3 });
    microgliaOnPlaque(L, { px: P3.x, py: P3.y, pr: P3.r, ang: 10, seed: 329, s: 0.95, off: 1.6, span: 40, nOut: 2, nuc: "oval", nPh: 2 });
    microgliaAmoeboid(L, { x: 139, y: 51, seed: 331, rot: 10 });
    microgliaAmoeboid(L, { x: 286, y: 140, seed: 333, rot: 60 });
  }

  FRAME = null;
  AVOID = [];
  SOMAS = [];
  STYLE = "soft";
  return { size: [W, H], lineWidth: 0.7, parts: parts(L) };
}

/* ===================== soft-style extras for single cells (after cells.mjs) ===================== */

/** Dense points along the closed smooth curve through pts (as smoothClosed draws it). */
function loop(pts, per = 10) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let k = 0; k < per; k++) out.push(crPoint(p0, p1, p2, p3, k / per));
  }
  return out;
}
/** Light band just inside the lit (top-left) edge of a closed outline given as dense points. */
function litBand(outline, { inset = 2.5, width = 8, min = 0.15, pow = 0.85 } = {}) {
  const n = outline.length;
  let ar = 0;
  for (let i = 0; i < n; i++) { const a = outline[i], b = outline[(i + 1) % n]; ar += a[0] * b[1] - b[0] * a[1]; }
  const sg = ar > 0 ? 1 : -1;
  const g = [], N = [];
  for (let i = 0; i < n; i++) {
    const a = outline[(i - 1 + n) % n], b = outline[(i + 1) % n];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    const nx = (sg * ty) / l, ny = (-sg * tx) / l;
    N.push([nx, ny]);
    const lit = -(nx + ny) * Math.SQRT1_2;
    g.push(lit > min ? Math.pow((lit - min) / (1 - min), pow) : 0);
  }
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
const glossDots = (cx, cy, r) => [ellipse(cx, cy, r, r * 0.62, -38), circle(cx + r * 2, cy - r * 0.9, r * 0.38)];
/** Soft-only highlight parts for a cell: a light band inside the lit edge and specular dots. */
function softExtras(fill, band, gloss) {
  const out = [];
  if (band) out.push({ d: band, fill: tint(fill, 0.12), opacity: 0.85, line: false });
  if (gloss) out.push({ unite: glossDots(...gloss), fill: "#ffffff", opacity: 0.8, line: false });
  return out;
}

/* ===================== AD components ===================== */

function plaqueIcon() {
  SH = { max: 2, k: 0.4, body: 2.2 };
  const L = new Layers();
  // the corona is ill-defined: no outline in line style (only the compact core is crisp)
  L.def("haloOut", { fill: P.halo, opacity: 0.4, ...noLine(P.halo) })
    .def("halo", { fill: P.halo, opacity: 0.62, ...noLine(P.halo) })
    .def("haloIn", { fill: P.halo, opacity: 0.62, line: false })
    .def("fibril", { fill: P.amyFib, opacity: 0.95, lineWidth: 0.35, thin: true })
    .def("amyloid", { fill: P.amyloid, shade: "rim", lineWidth: 1.1 })
    .def("coreIn", { fill: P.core, opacity: 0.8, lineWidth: 0.5, thin: true })
    .def("coreDark", { fill: shade(P.core, 0.1), opacity: 0.7, lineWidth: 0.4, thin: true })
    .def("dystro", { fill: P.dystro, shade: "small", lineWidth: 0.9, unite: [] })
    .def("tauDot", { fill: P.tangle, lineWidth: 0.5 });
  cellLayers(L, "micro", P.micro, 1.2);
  L.def("microNuc", { fill: P.microNuc, shade: "small", lineWidth: 0.9 })
    .def("phago", { fill: P.phago, shade: "small", lineWidth: 0.6 });
  // a second microglial cell, drawn over the first where the two overlap
  cellLayers(L, "micro2", P.micro, 1.2);
  L.def("micro2Nuc", { fill: P.microNuc, shade: "small", lineWidth: 0.9 })
    .def("phago2", { fill: P.phago, shade: "small", lineWidth: 0.6 });
  const mgA = [-70, -33, 150];
  plaque(L, { x: 100, y: 101, r: 52, seed: 3, cored: true, neurites: 7, s: 2.3, avoid: mgA });
  // three different plaque-associated microglia: a cluster of two on one side (the second partly
  // overlapping the first) and one apart; one lies partly over the halo, one sits mostly outside it
  const mg = { px: 100, py: 101, pr: 52 };
  microgliaOnPlaque(L, { ...mg, ang: mgA[0], seed: 41, s: 2.0, off: 0.9, spans: [30, 22], nOut: 1, nuc: "bean", nPh: 1 });
  microgliaOnPlaque(L, { ...mg, ang: mgA[1], seed: 43, s: 2.3, off: 3.4, spans: [24, 46], nOut: 2, nuc: "oval", nPh: 2, key: "micro2", nucKey: "micro2Nuc", phKey: "phago2" });
  microgliaOnPlaque(L, { ...mg, ang: mgA[2], seed: 47, s: 2.65, off: 1.8, span: 56, nOut: 2, nuc: "dent", nPh: 3 });
  return fitBox(parts(L));
}

function nftNeuronIcon() {
  SH = { max: 2.2, k: 0.4, body: 2.4 };
  const L = new Layers();
  cellLayers(L, "neuron", P.neuron, 1.3);
  L.def("tangle", { fill: P.tangle, shade: "small", lineWidth: 1 })
    .def("tangleFib", { fill: "none", stroke: { color: tint(P.tangle, 0.18), width: 1.1, cap: "round" }, lineColor: tint(P.tangle, 0.3), lineStrokeWidth: 0.8 })
    .def("nNuc", { fill: P.nNuc, shade: "organelle", lineWidth: 1.1 })
    .def("nucleolus", { fill: P.nucleolus, shade: "small", lineWidth: 0.7 });
  const n = pyramidal(L, { x: 110, y: 148, s: 3.1, top: 50, seed: 5, tangle: true, ts: 2.3, bl: 0.78 });
  const band = litBand(loop(n.somaPts, 12), { inset: 2.4, width: 7 });
  const ps = parts(L);
  // light band and gloss go right after the cell body (under the nucleus and tangle)
  const i = ps.findIndex((p) => p.fill === P.neuron && p.unite);
  ps.splice(i + 1, 0, ...softExtras(P.neuron, band, [96, 128, 3.2]));
  return fitBox(ps);
}

/**
 * Reactive (hypertrophic) astrocyte on a capillary. Plan (200 × 200 working box, cropped to the art):
 *   paint order: capillary wall → its lumen faces, red cells, endothelial nuclei → end-foot shadow →
 *   astrocyte shadow + united silhouette (processes, vascular stem, lamella, soma) → soma shading →
 *   GFAP bundles → nucleus.
 *   Six primary processes at clustered angles (gaps 26–97°): the vascular stem and a thick process
 *   reach down toward the vessel, a close pair points up, the others are shorter; each is gently
 *   tortuous with 1–2 varicosities, carries 2–4 blunt secondary branches at different distances and
 *   ends in a rounded tip. Soma 58 × 48 with an eccentric nucleus 22 × 16 (≈0.4 of its width).
 *   GFAP bundles sweep round the nucleus and stream out along the processes.
 *   The capillary is cut open at both ends (lumen and a red cell on each face); the end-foot lamella
 *   covers its near face and wraps under its lower edge over the middle 60% of its length.
 */
function reactiveAstrocyteIcon() {
  SH = { max: 2.4, k: 0.42, body: 2.6 };
  const L = new Layers();
  const R = rng(61);
  const cx = 100, cy = 86;
  L.def("capWall", { fill: C.wall, shade: "body", lineWidth: 1.1, unite: [], glossAt: [0.12, 0.42], glossSize: 0.02 })
    .def("capFace", { fill: shade(C.wall, 0.06), shade: "small", lineWidth: 0.9 })
    .def("capLumen", { fill: C.lumen, shade: "dip", lineWidth: 0.8 })
    .def("rbc", { fill: C.rbc, shade: "small", lineWidth: 0.7 })
    .def("endo", { fill: C.endo, shade: "small", lineWidth: 0.6 })
    .def("footSh", { fill: shade(C.wall, 0.13), opacity: 0.9, line: false });
  cellLayers(L, "astro", P.astro, 1.3);
  L.def("soma", { fill: P.astro, shade: "body", line: false })
    .def("gfap", { fill: shade(P.astro, 0.2), lineWidth: 0.25, thin: true, opacity: 0.8 })
    .def("astroNuc", { fill: P.astroNuc, shade: "organelle", lineWidth: 1.1 });

  // the capillary: a slightly curved tube cut open at both ends
  const tube = [[36, 171.5], [100, 168.4], [166, 162]];
  const capR = 6.2;
  const ax = along(tube, 0.5);
  const axisAt = (x) => {
    let i = ax.findIndex((p) => p[0] >= x);
    if (i <= 0) i = 1;
    const a = ax[i - 1], b = ax[i], t = (x - a[0]) / (b[0] - a[0] || 1), l = dist(a, b) || 1;
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], n: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l], ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
  };
  const V = (x, n) => { const q = axisAt(x); return [q.p[0] + q.n[0] * n, q.p[1] + q.n[1] * n]; };
  L.map.get("capWall").unite.push(ribbon(tube, capR * 2));
  for (const x of [tube[0][0], tube[2][0]]) {
    const q = axisAt(x);
    // the cut face: the wall ring, the lumen and a red cell inside it
    L.add("capFace", ellipse(q.p[0], q.p[1], 3.1, capR, q.ang));
    L.add("capLumen", ellipse(q.p[0] + 0.2, q.p[1] + 0.1, 1.9, 3.9, q.ang));
    L.add("rbc", ellipse(q.p[0] + 0.35, q.p[1] + 0.5, 1.1, 2.3, q.ang + 4));
  }
  // endothelial nuclei: flat, along the axis, on the wall clear of the end-foot
  for (const [x, n] of [[60, 2.4], [146, -2.2]]) L.add("endo", ellipse(...V(x, n), 5, 1.25, axisAt(x).ang));

  const pieces = [], fil = [];
  const nuc = [cx - 9, cy - 4], nRx = 11, nRy = 8, nRot = 18;
  /** Distance from the nucleus centre to its outline in direction a (deg). */
  const nucR = (a) => {
    const t = rad(a - nRot);
    return 1 / Math.sqrt(Math.pow(Math.cos(t) / nRx, 2) + Math.pow(Math.sin(t) / nRy, 2));
  };
  // GFAP bundles for one process: start beside the nucleus, sweep round it and stream out along the
  // process (never into the nucleus)
  const bundles = (pr, w, nF, side) => {
    const root = at(pr.pts, 0.04).p;
    const th = (Math.atan2(root[1] - nuc[1], root[0] - nuc[0]) * 180) / Math.PI;
    for (let j = 0; j < nF; j++) {
      const f = nF > 1 ? -0.5 + j / (nF - 1) : 0;
      const a0 = th + side * (68 + 14 * j), a1 = th + side * (30 + 8 * j);
      const pts = [pol(nuc[0], nuc[1], nucR(a0) + 1.8 + 0.9 * j, a0), pol(nuc[0], nuc[1], nucR(a1) + 3.2 + 1.1 * j, a1)];
      for (const t of [0.06, 0.18, 0.31, 0.44]) {
        const q = at(pr.pts, t), off = w(t) * 0.5 * f;
        pts.push([q.p[0] - q.dir[1] * off, q.p[1] + q.dir[0] * off]);
      }
      fil.push(smoothClosed(tubePts(pts, (t) => 0.42 - 0.32 * t, { step: 1.1 })));
    }
  };
  // [angle, length, half-width at the root, bend, number of side branches, side of the first branch]
  const MAIN = [
    { a: 36, len: 52, base: 8, bend: 16, nb: 3, sg: 1 },
    { a: -16, len: 42, base: 6.2, bend: -12, nb: 2, sg: -1 },
    { a: -64, len: 52, base: 7.6, bend: 20, nb: 3, sg: 1 },
    { a: -96, len: 38, base: 5.8, bend: -22, nb: 2, sg: -1 },
    { a: 166, len: 50, base: 7.2, bend: -16, nb: 3, sg: -1 },
  ];
  MAIN.forEach((m, i) => {
    const a = m.a + (R() - 0.5) * 6;
    const o = pol(cx, cy, 16, a);
    const tip = 2.1, vs = [0.3 + R() * 0.15, ...(i % 2 ? [] : [0.62 + R() * 0.12])];
    const wf = (t) => tip + (m.base - tip) * Math.pow(1 - t, 1.1) + vs.reduce((s, v) => s + 1.3 * Math.exp(-Math.pow((t - v) / 0.06, 2)), 0);
    const pr = proc(o[0], o[1], a, m.len + 12, { bend: m.bend, seg: 7, wave: 16, wf, round: true, seed: 70 + i });
    pieces.push(pr);
    // 2–4 secondary branches at different distances, mostly alternating sides, with blunt ends
    const frs = unevenSpacing(m.nb, 0.6, R, { cv: 0.45 }).map((s) => 0.2 + s);
    let sg = m.sg;
    for (const fr of frs) {
      const q = at(pr.pts, fr);
      const bl = 18 + R() * 12 * (1 - fr * 0.4);
      const br = proc(q.p[0], q.p[1], q.ang + sg * (40 + R() * 24), bl, { bend: sg * (8 + R() * 24), base: 2.5 * (1 - fr * 0.3), tip: 1.15, p: 0.55, seg: 5, wave: 22, round: true, seed: 90 + i * 5 + Math.round(fr * 10) });
      pieces.push(br);
      // a small knob at the blunt end
      const e = br.pts[br.pts.length - 1];
      pieces.push(blobPiece(e[0], e[1], 1.75, 1.55, { n: 7, wobble: 0.1, seed: 300 + i * 7 + Math.round(fr * 10), rot: R() * 180 }, 0.9));
      if (R() < 0.75) sg = -sg;
    }
    bundles(pr, wf, m.base > 7 ? 4 : 3, i % 2 ? 1 : -1);
  });

  // the vascular process: down to the capillary, flaring smoothly into the end-foot lamella
  const footX = 106, x0 = 84, x1 = 128, top = -(capR + 1);
  const stemEnd = V(footX, top + 1.8);
  const stem = piece([pol(cx, cy, 15, 82), [cx + 6, cy + 30], [cx + 5, cy + 52], stemEnd], (t) => 4.4 - 1.5 * t + 8.5 * Math.pow(t, 9));
  pieces.push(stem);
  // the lamella: its upper edge just above the vessel's top surface; it covers the vessel's near face
  // and wraps round under its lower edge over the middle 60% of its length, with a scalloped free edge
  const upper = [], lower = [];
  for (let i = 0; i <= 64; i++) {
    const u = i / 64, x = x0 + (x1 - x0) * u;
    const e = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(2 * u - 1), 6)));
    const wrap = clamp((0.5 - Math.abs(u - 0.5)) / 0.2) ** 1.4; // 0 at the ends, 1 over the middle 60%
    const sc = 1.0 * Math.abs(Math.sin(Math.PI * u * 6)) * (0.7 + 0.3 * Math.sin(u * 13));
    upper.push(V(x, top + (1 - e) * 4 + 0.15 * Math.sin(u * 17)));
    lower.push(V(x, top + (1 - e) * 4 + e * (2.6 + wrap * (2 * capR + 0.6) + sc)));
  }
  const lamPts = [...upper, ...lower.slice(1, -1).reverse()];
  const lamPiece = shapePiece(lamPts, 0.9, 0.9);
  pieces.push(lamPiece);
  L.add("footSh", movePath(lamPiece.d, 0.6, 1.6));
  bundles(stem, (t) => 4.4 - 1.5 * t, 3, 1);
  // hypertrophic soma over the roots of the processes
  const somaPts = blobPts(cx, cy, 29, 24, { n: 10, wobble: 0.12, seed: 62, rot: 12 });
  pieces.push(shapePiece(somaPts, 1, 1.5));
  addCell(L, "astro", pieces);
  L.add("soma", smoothClosed(somaPts));
  L.add("gfap", fil);
  const nucD = ellipse(nuc[0], nuc[1], nRx, nRy, nRot);
  assertInside("reactive astrocyte nucleus", nucD, smoothClosed(somaPts), 3);
  L.add("astroNuc", nucD);
  return fitBox(parts(L));
}

function activatedMicrogliaIcon() {
  SH = { max: 2.4, k: 0.42, body: 2.6 };
  const L = new Layers();
  const R = rng(81);
  const bx = 92, by = 112;
  const dense = loop(blobPts(bx, by, 46, 39, { n: 11, wobble: 0.08, seed: 84, rot: -22 }), 10);
  // phagocytic cup at the upper right: the inner membrane follows a fibrillar Aβ clump at a gap of
  // ~2 units, and two thick pseudopods wrap round the clump until their tips nearly meet
  const cA = -40, u = [Math.cos(rad(cA)), Math.sin(rad(cA))];
  let edge = [bx, by];
  for (let r = 0; r < 90; r += 0.25) {
    const q = [bx + u[0] * r, by + u[1] * r];
    if (!inside(dense, q)) { edge = q; break; }
  }
  const aD = 9.5, aT = 11.5, gap = 1.8; // clump half-depth (along u) and half-width
  const cc = [edge[0] + u[0] * 7, edge[1] + u[1] * 7];
  const E = { cx: cc[0], cy: cc[1], rx: aD + gap, ry: aT + gap, rot: cA }; // inner membrane of the cup
  const local = (p) => {
    const dx = p[0] - cc[0], dy = p[1] - cc[1], t = rad(cA);
    return [dx * Math.cos(t) + dy * Math.sin(t), -dx * Math.sin(t) + dy * Math.cos(t)];
  };
  const inE = (p) => { const [lx, ly] = local(p); return (lx / E.rx) ** 2 + (ly / E.ry) ** 2 < 1; };
  const thOf = (p) => { const [lx, ly] = local(p); return (Math.atan2(ly / E.ry, lx / E.rx) * 180) / Math.PI; };
  // replace the stretch of outline inside the cup by the cup floor (round the back of the clump)
  const fl = dense.map(inE);
  const k0 = dense.reduce((b, q, j) => (dist(q, cc) > dist(dense[b], cc) ? j : b), 0);
  const seq = [...dense.slice(k0), ...dense.slice(0, k0)], fs = [...fl.slice(k0), ...fl.slice(0, k0)];
  const i0 = fs.indexOf(true), i1 = fs.lastIndexOf(true);
  const tA = thOf(seq[i0 - 1]), tB = thOf(seq[i1 + 1]);
  // sweep from tA to tB the way that passes the back (θ = 180)
  const pos = ((tB - tA) % 360 + 360) % 360;
  const viaBack = ((180 - tA) % 360 + 360) % 360 < pos;
  const sweep = viaBack ? pos : pos - 360;
  const floor = [];
  for (let i = 1, n = Math.ceil(Math.abs(sweep) / 5); i < n; i++) floor.push(ellipseAt(E, tA + (sweep * i) / n));
  const bodyPts = [...seq.slice(0, i0), ...floor, ...seq.slice(i1 + 1)];
  const pieces = [shapePiece(bodyPts, 1, 2.6)];
  // the two pseudopods: thick at the base (≈13 units), tapering to rounded tips at the front
  for (const sg of [1, -1]) {
    const hw = (t) => 6.6 - 3.9 * Math.pow(t, 0.9);
    const pts = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18;
      pts.push(ellipseAt(E, sg * (142 - 127 * t), hw(t)));
    }
    pieces.push(piece(pts, hw));
    const tip = pts[pts.length - 1];
    pieces.push(shapePiece(blobPts(tip[0], tip[1], hw(1), hw(1), { n: 10, wobble: 0 }), 1, 1.4));
  }
  // short, thick, blunt (retracted) processes of different lengths with rounded ends
  const rimAt = (a) => {
    let best = bodyPts[0], bd = 1e9;
    for (const p of bodyPts) {
      const d = Math.abs(((Math.atan2(p[1] - by, p[0] - bx) * 180) / Math.PI - a + 540) % 360 - 180);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const STUBS = [[180, 13, 5.2], [224, 7, 4.6], [134, 12, 5], [32, 8, 4.4], [268, 10, 4.8], [92, 5, 4.4]];
  for (const [a0, len, w] of STUBS) {
    const a = a0 + (R() - 0.5) * 8;
    const e = rimAt(a), d = [Math.cos(rad(a)), Math.sin(rad(a))];
    const o = [e[0] - d[0] * 7, e[1] - d[1] * 7];
    const end = [e[0] + d[0] * len, e[1] + d[1] * len];
    const bend = (R() - 0.5) * 0.5 * len;
    const mid = [(o[0] + end[0]) / 2 - d[1] * bend, (o[1] + end[1]) / 2 + d[0] * bend];
    const tipW = w * 0.55;
    pieces.push(piece([o, mid, end], (t) => tipW + (w - tipW) * Math.pow(1 - t, 0.8)));
    pieces.push(shapePiece(blobPts(end[0], end[1], tipW, tipW, { n: 10, wobble: 0 }), 1, 1.2));
  }
  cellLayers(L, "micro", P.micro, 1.3);
  L.def("phagosome", { fill: "#e9f3fb", shade: "small", lineWidth: 0.9 })
    .def("phago", { fill: P.phago, shade: "small", lineWidth: 0.8 })
    .def("lipid", { fill: "#f7e3a1", shade: "small", lineWidth: 0.8 })
    .def("microNuc", { fill: P.microNuc, shade: "organelle", lineWidth: 1.1 })
    .def("haze", { fill: P.halo, opacity: 0.85, lineWidth: 0.5, thin: true })
    .def("abeta", { fill: P.amyloid, shade: "small", lineWidth: 0.8 })
    .def("trem2", { fill: "#d8649e", lineWidth: 0.6 });
  addCell(L, "micro", pieces);
  // TREM2: lining the whole inner membrane of the cup (stalk in the membrane, head touching the Aβ)
  // and scattered over the rest of the cell surface (between the processes)
  const trem = [];
  const receptor = (p, dir, sc = 1) => {
    const d = [Math.cos(rad(dir)), Math.sin(rad(dir))];
    const p0 = [p[0] - d[0] * 0.5, p[1] - d[1] * 0.5], p1 = [p[0] + d[0] * 1.5 * sc, p[1] + d[1] * 1.5 * sc];
    trem.push(capsule(p0[0], p0[1], p1[0], p1[1], 0.5) + ellipse(p[0] + d[0] * 2.5 * sc, p[1] + d[1] * 2.5 * sc, 1.15, 1.5, dir));
  };
  for (let th = -150; th <= 150.1; th += 23) {
    const p = ellipseAt(E, th), q = ellipseAt(E, th, -1);
    receptor(p, (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI);
  }
  for (const a of [157, 201, 244, 112, 60]) {
    const p = rimAt(a);
    const q = rimAt(a + 3), q2 = rimAt(a - 3);
    // outward normal of the outline at p
    const tx = q[0] - q2[0], ty = q[1] - q2[1];
    let nA = (Math.atan2(-tx, ty) * 180) / Math.PI;
    if (Math.cos(rad(nA - a)) < 0) nA += 180;
    receptor(p, nA, 1.4);
  }
  // nucleus: kidney-shaped and eccentric, its hilum facing the cell centre
  const nc = [bx - 17, by + 9];
  const toC = (Math.atan2(by - nc[1], bx - nc[0]) * 180) / Math.PI;
  L.add("microNuc", bean(nc[0], nc[1], 13, 10.5, toC - 90, 0.38));
  // phagolysosomes with ingested Aβ, lipid droplets (LDAM)
  for (const [x, y, r] of [[106, 104, 7], [114, 129, 6.5], [93, 142, 5.5]]) {
    L.add("phagosome", circle(x, y, r));
    L.add("phago", smoothClosed(blobPts(x + 0.5, y + 0.5, r * 0.55, r * 0.5, { n: 7, wobble: 0.22, seed: x })));
  }
  for (const [x, y, r] of [[84, 92, 4], [118, 140, 3.6], [70, 135, 3.6], [130, 116, 3.2]]) L.add("lipid", circle(x, y, r));
  // the Aβ clump: a pale haze of aggregated Aβ with short fibrils crossing at random angles
  L.add("haze", smoothClosed(blobPts(cc[0], cc[1], aD, aT, { n: 12, wobble: 0.06, seed: 87, rot: cA })));
  const RR = rng(85), rods = [];
  const inAgg = (q) => { const [lx, ly] = local(q); return (lx / (aD - 1.05)) ** 2 + (ly / (aT - 1.05)) ** 2 <= 1; };
  for (let tries = 0; rods.length < 15 && tries < 4000; tries++) {
    const ang = rods.length < 10 ? cA + 90 + 12 + (RR() - 0.5) * 70 : RR() * 180;
    const len = 5.5 + RR() * 4;
    const c = [cc[0] + (RR() - 0.5) * 2 * aT, cc[1] + (RR() - 0.5) * 2 * aT];
    const e1 = pol(c[0], c[1], len / 2, ang), e2 = pol(c[0], c[1], -len / 2, ang);
    if (!inAgg(e1) || !inAgg(e2)) continue;
    if (rods.some((r) => dist(r.c, c) < 2.5)) continue;
    rods.push({ c, d: capsule(e1[0], e1[1], e2[0], e2[1], 1.05) });
  }
  L.add("abeta", rods.map((r) => r.d));
  L.add("trem2", trem);
  const band = litBand(bodyPts, { inset: 2.6, width: 8 });
  const ps = parts(L);
  const i = ps.findIndex((p) => p.fill === P.micro && p.unite);
  ps.splice(i + 1, 0, ...softExtras(P.micro, band, [66, 92, 4]));
  return fitBox(ps);
}

/** Crop the canvas to the drawing plus a margin m on every side, the drawing centred. */
function fitBox(ps, m = 9) {
  const all = ps.flatMap((p) => (p.unite ? p.unite : [].concat(p.d)));
  const b = pathBox(all);
  const w = Math.ceil(b.w + 2 * m), h = Math.ceil(b.h + 2 * m);
  return { size: [w, h], parts: recentre(ps, w, h) };
}

/** Move all parts so that the drawing's bounding box is centred in a w × h box. */
function recentre(ps, w, h) {
  const all = ps.flatMap((p) => (p.unite ? p.unite : [].concat(p.d)));
  const b = pathBox(all);
  const dx = w / 2 - (b.x + b.w / 2), dy = h / 2 - (b.y + b.h / 2);
  const mv = (d) => movePath(d, dx, dy);
  return ps.map((p) => (p.unite ? { ...p, unite: p.unite.map(mv) } : { ...p, d: Array.isArray(p.d) ? p.d.map(mv) : mv(p.d) }));
}

/**
 * Paired helical filament (PHF) of tau. Plan (cropped to the art, ≈300 × 100):
 *   paint order: fuzzy coat + phospho-sites → back runs of both protofilaments (shadow, fill, β-rungs,
 *   edges) → front runs (the same) → inset (disc, link, pale fold bands, β-strand arrows, turns, tails).
 *   The filament is a flat band of two protofilaments twisting about its axis: each protofilament's
 *   projected outline is y ± h(x) with h smooth, so the edges are tangent-continuous; edge-on the band
 *   narrows to 35% of its face-on width, and crossovers come every 64 units (3.5× the 18-unit width,
 *   as a real PHF crosses over every ~80 nm at 8–20 nm). Runs are split where the band is face-on
 *   (the two protofilaments side by side), so no cut ever lies on top of the other strand.
 *   Inset: the core cross-section — two identical Alzheimer folds (C-shaped, with a flattened, kinked
 *   back and an inward hook at the C-terminal end) of β-strand arrows of different lengths, packed back
 *   to back (C2 symmetry), with short fuzzy-coat stubs at both termini.
 */
function tauFibrils() {
  const L = new Layers();
  const R = rng(91);
  const cA = "#7a72c8", cB = "#a59de0", coat = "#c3bfe6";
  const cy = 60, xa = 106, half = 64, xb = xa + 3 * half, hwB = 9, tk = 0.35 * hwB;
  const th = (x) => (Math.PI * (x - xa)) / half;
  const strand = (j, x) => {
    const t = th(x), sg = j ? -1 : 1;
    return { y: cy + sg * (hwB / 2) * Math.cos(t), h: Math.hypot((hwB / 2) * Math.cos(t), tk * Math.sin(t)), z: sg * Math.sin(t) };
  };
  const outer = (x, up) => Math.max(...[0, 1].map((j) => { const s = strand(j, x); return up ? cy - (s.y - s.h) : s.y + s.h - cy; }));

  L.def("coat", { fill: "none", stroke: { color: coat, width: 1.6, cap: "round" }, lineColor: "#a9a3d8", lineStrokeWidth: 1 })
    .def("phos", { fill: "#f2a23c", shade: "small", lineWidth: 0.7 });
  for (const d of ["back", "front"]) {
    for (const [k, c] of [["A", cA], ["B", cB]]) {
      L.def(d + k + "Sh", { fill: shade(c, 0.16), line: false })
        .def(d + k, { fill: c, ...noLine(c) })
        .def("rung" + d + k, { fill: "none", stroke: { color: tint(c, 0.12), width: 0.8, cap: "butt" }, lineColor: shade(c, 0.02), lineStrokeWidth: 0.5, opacity: 0.9 })
        .def("edge" + d + k, { fill: "none", stroke: { color: shade(c, 0.3), width: 1 }, lineColor: outline(c), lineStrokeWidth: 1, soft: false });
    }
  }

  // fuzzy coat: disordered tails leaving both edges, hyperphosphorylated mostly along their length
  for (let x = xa + 7; x < xb - 6; x += 7 + R() * 2.5) {
    for (const up of [1, -1]) {
      if (R() < 0.25) continue;
      const y0 = cy - up * (outer(x, up > 0) - 1.6);
      const pts = [[x, y0]];
      let a = -90 * up + (R() - 0.5) * 50, px = x, py = y0;
      const nseg = 3 + Math.floor(R() * 3);
      for (let k = 0; k < nseg; k++) {
        a += (R() - 0.5) * 70;
        a = Math.max(-90 * up - 65, Math.min(-90 * up + 65, a));
        px = Math.max(xa + 2, Math.min(px + Math.cos(rad(a)) * 4.1, xb - 2));
        py += Math.sin(rad(a)) * 4.1;
        pts.push([px, py]);
      }
      L.add("coat", smoothOpen(pts));
      const rp = R();
      if (rp < 0.5) L.add("phos", circle(...pts[Math.floor(pts.length / 2)], 1.5));
      else if (rp < 0.62) L.add("phos", circle(...pts[1], 1.5));
      else if (rp < 0.76) L.add("phos", circle(px, py, 1.5));
      if (rp < 0.2) L.add("phos", circle(...pts[pts.length - 2], 1.5));
    }
  }

  // the two protofilaments, in runs between face-on points (θ = kπ)
  for (let r = 0; r < 3; r++) {
    const x0 = xa + r * half, x1 = x0 + half;
    for (const j of [0, 1]) {
      const k = j ? "B" : "A";
      const front = strand(j, (x0 + x1) / 2).z > 0;
      const d = front ? "front" : "back";
      const e0 = r === 0 ? 0 : 0.5, e1 = r === 2 ? 0 : 0.5; // overlap neighbouring runs a little
      const xs = [];
      for (let x = x0 - e0; x <= x1 + e1 + 0.001; x += 1.5) xs.push(Math.min(x, x1 + e1));
      // the shadow copy drops furthest where the strands cross (a cast shadow on the strand behind)
      // and not at all where they lie side by side, so it never steps at a run boundary
      const drop = (x) => 1.3 * Math.sin(th(x)) ** 2;
      const top = (sh = 0) => xs.map((x) => { const s = strand(j, x); return [x, s.y - s.h + sh * drop(x)]; });
      const bot = (sh = 0) => xs.map((x) => { const s = strand(j, x); return [x, s.y + s.h + sh * drop(x)]; });
      // the filament's own ends are rounded (each strand closes in a semicircle); the cut ends of a
      // run are straight, so the smoothing cannot overshoot there
      const shape = (sh) => {
        const T = top(sh), B = bot(sh).reverse();
        const seq = [...(r === 0 ? capPts(strand(j, x0), x0, -1, 0) : []), ...T];
        if (r === 2) return smoothOpen([...seq, ...capPts(strand(j, x1), x1, 1, 0), ...B]) + "Z";
        return smoothOpen(seq) + "L" + smoothOpen(B).slice(1) + "Z";
      };
      L.add(d + k + "Sh", shape(1));
      L.add(d + k, shape(0));
      // the edges, as strokes (line style), stopping where the run is cut
      const T0 = top(0), B0 = bot(0);
      const edges = [smoothOpen(T0), smoothOpen(B0)];
      if (r === 0) edges.push(smoothOpen([B0[0], ...capPts(strand(j, x0), x0, -1, 0), T0[0]]));
      if (r === 2) edges.push(smoothOpen([T0[T0.length - 1], ...capPts(strand(j, x1), x1, 1, 0), B0[B0.length - 1]]));
      L.add("edge" + d + k, edges);
      // stacked β-strands (cross-β rungs) across the face, perpendicular to the filament axis
      for (let x = x0 + 2.2; x < x1 - 1.2; x += 3.2) {
        const s = strand(j, x), l = s.h - 1.3;
        if (l > 0.8) L.add("rung" + d + k, `M${f(x)} ${f(s.y - l)}L${f(x)} ${f(s.y + l)}`);
      }
    }
  }

  // inset: cross-section of the filament core
  const ix = 46, iy = cy;
  L.def("inset", { fill: "#f1f0f9", stroke: sw("#d6d3ec", 1), lineWidth: 1 })
    .def("link", { fill: "none", stroke: { color: "#c9c5e6", width: 1.2, cap: "round", dash: [3, 3] }, lineStrokeWidth: 1 })
    // a faint backing band along each chain (soft only), so the fold still reads when small
    .def("bandA", { fill: tint(cA, 0.22), opacity: 0.55, line: false })
    .def("bandB", { fill: tint(cB, 0.18), opacity: 0.55, line: false })
    .def("tails", { fill: "none", stroke: { color: coat, width: 1.4, cap: "round" }, lineColor: "#a9a3d8", lineStrokeWidth: 0.9 })
    .def("turns", { fill: "none", stroke: { color: "#9790d6", width: 1.3, cap: "round" }, lineStrokeWidth: 0.9 });
  for (const [k, c] of [["A", cA], ["B", cB]]) L.def("arrowSh" + k, { fill: shade(c, 0.16), line: false }).def("arrow" + k, { fill: c, lineWidth: 0.7 });
  L.add("inset", circle(ix, iy, 40));
  L.add("link", `M${ix + 41} ${iy}L${xa - 7} ${cy}`);
  // one fold (back on the −x side, opening to +x), N → C: β-strands of different lengths; a kink in
  // the flattened back; the C-terminal end hooks inward
  // (β1–β2 the upper arm, β3/β4 the kinked back, β5 the lower arm, β6–β8 a small triangular β-helix
  // whose last strand turns back into the C: the hook)
  const STR = [[[10, -9.5], [2, -12.8]], [[-1.5, -13.2], [-9.5, -10]], [[-11.4, -7.5], [-12, -1]], [[-11, 1.5], [-12.2, 7.5]],
    [[-10, 10.5], [-3, 13.4]], [[0, 13.6], [6.5, 12.6]], [[8.6, 11], [9.6, 5.2]], [[7.8, 3.6], [3.4, 7.4]]];
  const nTail = [[10, -9.5], [12.5, -8], [15, -9.6], [17, -8]], cTail = [[3.4, 7.4], [2.6, 4.2], [5.8, 0.8], [9.6, 0.2], [12.6, -1.8]];
  const arrow = (p, q, w = 3.5, hw = 5.6, hl = 2.6) => {
    const l = dist(p, q), u = [(q[0] - p[0]) / l, (q[1] - p[1]) / l], n = [-u[1], u[0]];
    const b = [q[0] - u[0] * hl, q[1] - u[1] * hl];
    const o = (c, k) => [c[0] + n[0] * k, c[1] + n[1] * k];
    return polyD([o(p, w / 2), o(b, w / 2), o(b, hw / 2), q, o(b, -hw / 2), o(b, -w / 2), o(p, -w / 2)]);
  };
  const SC = 1.12, ROT = -28;
  const place = (p, flip) => {
    const lx = (flip ? -p[0] - 16 : p[0] + 16) * SC, ly = (flip ? -p[1] - 1.6 : p[1] + 1.6) * SC;
    return rotate([ix + lx, iy + ly], ix, iy, ROT);
  };
  for (const [K, flip] of [["A", true], ["B", false]]) {
    const P0 = (p) => place(p, flip);
    // the backbone through all strands and turns, as a pale band under the arrows
    const bb = [];
    STR.forEach(([p, q], i) => {
      bb.push(p, q);
      if (i < STR.length - 1) {
        const n = STR[i + 1][0], m = [(q[0] + n[0]) / 2, (q[1] + n[1]) / 2];
        const out = Math.hypot(m[0], m[1]) || 1;
        const mm = [m[0] + (m[0] / out) * 1.3, m[1] + (m[1] / out) * 1.3];
        L.add("turns", smoothOpen([q, mm, n].map(P0)));
        bb.push(mm);
      }
    });
    L.add("band" + K, ribbon(catmull(bb.map(P0), 6), 7, { taper: 0.25 }));
    for (const [p, q] of STR) {
      const d = arrow(P0(p), P0(q), 3.5 * SC * 0.86, 5.6 * SC * 0.86, 2.6 * SC * 0.9);
      L.add("arrowSh" + K, movePath(d, 0.8, 1));
      L.add("arrow" + K, d);
    }
    L.add("tails", [smoothOpen(nTail.map(P0)), smoothOpen(cTail.map(P0))]);
  }
  // paint order: the inset (disc, link, bands, tails, turns, arrows) goes over the coat and filament
  const ps = parts(L);
  return fitBox(ps);
}

/** A strand's rounded end at x: a semicircle of points beyond x in direction dir (±1), top to bottom. */
function capPts(s, x, dir, sh = 0) {
  const out = [];
  for (let q = 1; q < 8; q++) {
    const ph = (q * Math.PI) / 8;
    out.push([x + dir * Math.sin(ph) * s.h * 0.9, s.y + sh - Math.cos(ph) * s.h]);
  }
  return dir > 0 ? out : out.reverse();
}

/* ===================== coronal slices (gross anatomy) ===================== */

/**
 * Cut slits (sulci/fissures) into a closed outline: splice several slits into one outline at once. Each slit replaces the run of outline points
 * within rc of its mouth m — found on the ORIGINAL outline, so neighbouring slits can never eat
 * into each other's walls (as happens when they are carved one after another).
 */
function spliceIn(poly, slits, label = "") {
  const N = poly.length;
  const cover = Array.from({ length: N }, () => []);
  const rs = slits.map(({ seq, m, rc }, ri) => {
    let i0 = 0;
    for (let i = 1; i < N; i++) if (dist(poly[i], m) < dist(poly[i0], m)) i0 = i;
    let s = i0, t = i0;
    while (dist(poly[(s - 1 + N) % N], m) < rc) s = (s - 1 + N) % N;
    while (dist(poly[(t + 1) % N], m) < rc) t = (t + 1) % N;
    // enter by the wall that lies on the side we come from (along the outline's direction of travel)
    const before = poly[(s - 1 + N) % N], after = poly[(t + 1) % N];
    const v = [after[0] - before[0], after[1] - before[1]];
    const ab = [seq[0][0] - seq[seq.length - 1][0], seq[0][1] - seq[seq.length - 1][1]];
    const ins = ab[0] * v[0] + ab[1] * v[1] <= 0 ? seq : seq.slice().reverse();
    for (let k = s; ; k = (k + 1) % N) {
      cover[k].push(ri);
      if (k === t) break;
    }
    return { ins, done: false };
  });
  if (label && cover.some((c) => c.length > 1)) console.warn(`brain.mjs: overlapping slits in ${label}`);
  const z = Math.max(0, cover.findIndex((c) => !c.length));
  const out = [];
  for (let j = 0; j < N; j++) {
    const k = (z + j) % N;
    if (!cover[k].length) { out.push(poly[k]); continue; }
    for (const ri of cover[k]) if (!rs[ri].done) { out.push(...rs[ri].ins); rs[ri].done = true; }
  }
  return out;
}

/* raster helpers: signed distance fields of outlines and the contours of a field */

/** A grid (cell size res) covering poly with a margin. */
function gridFor(poly, res = 0.25, pad = 6) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  return { x0, y0, res, W: Math.ceil((Math.max(...xs) + pad - x0) / res), H: Math.ceil((Math.max(...ys) + pad - y0) / res) };
}
/** 1 for grid cells whose centre lies inside the closed outline poly (even-odd scanlines). */
function rasterIn(poly, G) {
  const { x0, y0, res, W, H } = G, m = new Uint8Array(W * H), n = poly.length;
  for (let j = 0; j < H; j++) {
    const y = y0 + (j + 0.5) * res, cr = [];
    for (let k = 0; k < n; k++) {
      const a = poly[k], b = poly[(k + 1) % n];
      if (a[1] > y !== b[1] > y) cr.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    cr.sort((p, q) => p - q);
    for (let k = 0; k + 1 < cr.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((cr[k] - x0) / res - 0.5)), i1 = Math.min(W - 1, Math.floor((cr[k + 1] - x0) / res - 0.5));
      for (let i = i0; i <= i1; i++) m[j * W + i] = 1;
    }
  }
  return m;
}
/** Exact Euclidean distance (units) from every cell to the nearest cell where src is set (Felzenszwalb & Huttenlocher). */
function edt(src, G) {
  const { W, H, res } = G, INF = 1e12, g = new Float64Array(W * H);
  for (let k = 0; k < W * H; k++) g[k] = src[k] ? 0 : INF;
  const M = Math.max(W, H), f = new Float64Array(M), out = new Float64Array(M), v = new Int32Array(M), z = new Float64Array(M + 1);
  const pass = (len) => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < H; j++) f[j] = g[j * W + i];
    pass(H);
    for (let j = 0; j < H; j++) g[j * W + i] = out[j];
  }
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) f[i] = g[j * W + i];
    pass(W);
    for (let i = 0; i < W; i++) g[j * W + i] = Math.sqrt(out[i]) * res;
  }
  return g;
}
/** Signed distance to the outline of a raster mask: + inside, − outside. */
function sdf(mask, G) {
  const n = mask.length, inv = new Uint8Array(n);
  for (let k = 0; k < n; k++) inv[k] = mask[k] ? 0 : 1;
  const dIn = edt(inv, G), dOut = edt(mask, G), out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = mask[k] ? dIn[k] - G.res / 2 : -(dOut[k] - G.res / 2);
  return out;
}
/** Closed loops (≈ step apart) where field F crosses 0, by marching squares; small slivers are dropped. */
function contours(F, G, { step = 1.3, minArea = 14 } = {}) {
  const { x0, y0, res, W, H } = G;
  const val = (i, j) => F[j * W + i];
  const pts = new Map(), adj = new Map();
  const ptOn = (id) => {
    if (pts.has(id)) return;
    const c = id >> 1, i = c % W, j = (c - i) / W;
    const [v1, v2, di, dj] = id & 1 ? [val(i, j), val(i, j + 1), 0, 1] : [val(i, j), val(i + 1, j), 1, 0];
    const t = -v1 / (v2 - v1);
    pts.set(id, [x0 + (i + 0.5 + di * t) * res, y0 + (j + 0.5 + dj * t) * res]);
  };
  const link = (a, b) => {
    ptOn(a); ptOn(b);
    for (const [p, q] of [[a, b], [b, a]]) (adj.get(p) || adj.set(p, []).get(p)).push(q);
  };
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = val(i, j) >= 0, b = val(i + 1, j) >= 0, c = val(i + 1, j + 1) >= 0, e = val(i, j + 1) >= 0;
      if (a === b && b === c && c === e) continue;
      const cell = j * W + i;
      const Tn = 2 * cell, Bn = 2 * (cell + W), Ln = 2 * cell + 1, Rn = 2 * (cell + 1) + 1;
      const xe = [];
      if (a !== b) xe.push(Tn);
      if (b !== c) xe.push(Rn);
      if (c !== e) xe.push(Bn);
      if (e !== a) xe.push(Ln);
      if (xe.length === 2) link(xe[0], xe[1]);
      else {
        const mid = (val(i, j) + val(i + 1, j) + val(i + 1, j + 1) + val(i, j + 1)) / 4 >= 0;
        if (mid === a) { link(Tn, Rn); link(Bn, Ln); } else { link(Tn, Ln); link(Rn, Bn); }
      }
    }
  }
  const seen = new Set(), loops = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const lp = [];
    let prev = -1, cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      lp.push(pts.get(cur));
      const nb = adj.get(cur);
      const nx = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      cur = nx;
    }
    const ar = Math.abs(lp.reduce((s, p, k) => { const q = lp[(k + 1) % lp.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    if (ar < minArea) continue;
    const r = resample([...lp, lp[0]], step);
    if (dist(r[0], r[r.length - 1]) < step * 0.5) r.pop();
    loops.push(r);
  }
  return loops;
}
/** Number of pairs of non-adjacent edges of a closed outline that cross (0 for a clean outline). */
function crossings(poly) {
  const n = poly.length;
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  let c = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const p = poly[j], q = poly[(j + 1) % n];
      if (Math.max(a[0], b[0]) < Math.min(p[0], q[0]) || Math.max(p[0], q[0]) < Math.min(a[0], b[0])) continue;
      if (Math.max(a[1], b[1]) < Math.min(p[1], q[1]) || Math.max(p[1], q[1]) < Math.min(a[1], b[1])) continue;
      if (cross(a, b, p) * cross(a, b, q) < 0 && cross(p, q, a) * cross(p, q, b) < 0) { c++; crossings.at = a; }
    }
  }
  return c;
}

/** The walls and rounded fundus of a slit along centreline cl (half-width hw(i)), from cl[from] inward. */
function slitSeq(cl, hw, from = 0) {
  const n = cl.length;
  const perp = (i) => {
    const a = cl[Math.max(0, i - 1)], b = cl[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const A = [], B = [];
  for (let i = from; i < n; i++) {
    const p = perp(i), w = hw(i);
    A.push([cl[i][0] + p[0] * w, cl[i][1] + p[1] * w]);
    B.push([cl[i][0] - p[0] * w, cl[i][1] - p[1] * w]);
  }
  const e = cl[n - 1], pe = perp(n - 1), we = hw(n - 1);
  const a0 = Math.atan2(pe[1], pe[0]);
  const fwd = [cl[n - 1][0] - cl[n - 2][0], cl[n - 1][1] - cl[n - 2][1]];
  const sg = Math.cos(a0 + Math.PI / 2) * fwd[0] + Math.sin(a0 + Math.PI / 2) * fwd[1] > 0 ? 1 : -1;
  const fund = [];
  for (let k = 1; k < 8; k++) {
    const a = a0 + (sg * Math.PI * k) / 8;
    fund.push([e[0] + Math.cos(a) * we, e[1] + Math.sin(a) * we]);
  }
  return [...A, ...fund, ...B.reverse()];
}

/** Centreline of a callosal sulcus: out from the midline over the callosum, hooking down at its lateral end. */
const callosalLine = (floor, hc, { Lcc, hook }, sgn) => (t) => [150 + sgn * Lcc * t, floor - hc + hook * Math.pow(t, 2.4)];

/**
 * The longitudinal fissure as one slit: down the midline from the mouth at yTop to the corpus
 * callosum at `floor`, where a callosal sulcus (half-width hc) runs out to each side over the
 * callosum and hooks down round the cingulate gyrus — `sides` [right, left] {Lcc, hook} differ, so
 * the two are not mirror images. Returns the outline from the left mouth wall round to the right one.
 */
function fissureSeq(yTop, floor, h, hc, sides) {
  const xm = 150;
  const halfOf = (sd, sgn) => {
    const ccl = callosalLine(floor, hc, sd, sgn);
    const n = Math.max(8, Math.round(sd.Lcc * 1.5));
    const P = [], N = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = ccl(Math.max(0, t - 0.01)), b = ccl(Math.min(1, t + 0.01)), l = dist(a, b);
      P.push(ccl(t));
      N.push([(-(b[1] - a[1]) / l) * sgn, ((b[0] - a[0]) / l) * sgn]); // points down, into the callosum
    }
    const half = P.map((p, i) => [p[0] + N[i][0] * hc, p[1] + N[i][1] * hc]);
    // rounded fundus at the hooked end, from the lower wall round to the upper one
    const e = P[n], tl = dist(P[n], P[n - 1]), T = [(P[n][0] - P[n - 1][0]) / tl, (P[n][1] - P[n - 1][1]) / tl];
    for (let k = 1; k < 8; k++) {
      const ph = (k * Math.PI) / 8;
      half.push([e[0] + hc * (Math.cos(ph) * N[n][0] + Math.sin(ph) * T[0]), e[1] + hc * (Math.cos(ph) * N[n][1] + Math.sin(ph) * T[1])]);
    }
    for (let i = n; i >= 0; i--) {
      const p = [P[i][0] - N[i][0] * hc, P[i][1] - N[i][1] * hc];
      if (sgn * (p[0] - xm) < h + 0.8) break;
      half.push(p);
    }
    for (let y = floor - 2 * hc - 0.8; y > yTop; y -= 1) half.push([xm + sgn * h, y]);
    half.push([xm + sgn * h, yTop]);
    return half;
  };
  const right = halfOf(sides[0], 1), left = halfOf(sides[1], -1);
  return [...left.reverse(), ...right.slice(1)];
}

/**
 * The insula and the Sylvian cleft round it, in the right hemisphere's own coordinates: base(t) is
 * the laterally convex insular surface without its short gyri (t 0 → 1 from its top to its bottom;
 * the circular sulcus continues a little beyond both ends), off(t, d) a point d out from it (lateral
 * +), and seq(stem, h, flare) the outline of the whole cleft (stem, cistern, both limbs of the
 * circular sulcus, the insular surface with its 2 oblique sulci) for spliceIn.
 */
function sylvianGeometry(ad) {
  const insX = 241, y0 = 103.5, H = 28.5, bulge = ad ? 5.4 : 6.2, crown = 0.8;
  const notches = [{ t: 0.3, d: ad ? 3.4 : 4, tilt: 40 }, { t: 0.69, d: ad ? 2.2 : 2.4, tilt: -46 }];
  const hn = ad ? 0.95 : 0.7;
  const base = (t) => [insX + bulge * Math.sin(Math.PI * t), y0 + H * t];
  const tan = (t) => { const a = base(t - 0.005), b = base(t + 0.005), l = dist(a, b); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const nrm = (t) => { const T = tan(t); return [T[1], -T[0]]; };
  const off = (t, d) => { const p = base(t), n = nrm(t); return [p[0] + n[0] * d, p[1] + n[1] * d]; };
  // the short gyri: rounded crowns between the notches
  const bump = (t) => crown * (1 - Math.max(...notches.map((q) => Math.exp(-Math.pow((t - q.t) / 0.07, 2)))));
  const surf = (t) => off(t, bump(t));
  const ta = -0.12, tb = 1.12, tU = 0.36, tL = 0.66;
  const notchSeq = (q) => {
    const M = surf(q.t), N = nrm(q.t), T = tan(q.t);
    const dir = rotate([-N[0], -N[1]], 0, 0, q.tilt);
    let pu = [dir[1], -dir[0]];
    if (pu[0] * -T[0] + pu[1] * -T[1] < 0) pu = [-pu[0], -pu[1]];
    const w = (s) => hn * (1 - 0.25 * Math.pow(s / q.d, 2));
    const A = [], B = [];
    for (let s = 0; s <= q.d + 1e-9; s += 0.5) {
      A.push([M[0] + dir[0] * s + pu[0] * w(s), M[1] + dir[1] * s + pu[1] * w(s)]);
      B.push([M[0] + dir[0] * s - pu[0] * w(s), M[1] + dir[1] * s - pu[1] * w(s)]);
    }
    const E = [M[0] + dir[0] * q.d, M[1] + dir[1] * q.d], we = w(q.d), fund = [];
    for (let k = 1; k < 8; k++) {
      const ph = (k * Math.PI) / 8;
      fund.push([E[0] + we * (Math.cos(ph) * pu[0] + Math.sin(ph) * dir[0]), E[1] + we * (Math.cos(ph) * pu[1] + Math.sin(ph) * dir[1])]);
    }
    return [...A, ...fund, ...B.reverse()];
  };
  const seq = (cl, h, flare) => {
    const n = cl.length, cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(cl[i], cl[i - 1]));
    const Lt = cum[n - 1];
    const hw = (i) => h + flare * Math.pow(clamp((cum[i] - (Lt - 9)) / 9), 1.6);
    const up = [], dn = [];
    for (let i = 0; i < n; i++) {
      const a = cl[Math.max(0, i - 1)], b = cl[Math.min(n - 1, i + 1)], l = dist(a, b) || 1;
      let nv = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
      if (nv[1] < 0) nv = [-nv[0], -nv[1]];
      up.push([cl[i][0] - nv[0] * hw(i), cl[i][1] - nv[1] * hw(i)]);
      dn.push([cl[i][0] + nv[0] * hw(i), cl[i][1] + nv[1] * hw(i)]);
    }
    const W = crown + 2 * h;
    const opU = [], opL = [], ins = [];
    for (let t = tU; t >= ta - 1e-9; t -= 0.02) opU.push(off(t, W));
    for (let t = tb; t >= tL - 1e-9; t -= 0.02) opL.push(off(t, W));
    // rounded fundus of a limb: s = −1 at the top end, +1 at the bottom end
    const fund = (t, s) => {
      const c = off(t, crown + h), N = nrm(t), T = tan(t), out = [];
      for (let k = 1; k < 8; k++) {
        const ph = (k * Math.PI) / 8, cn = s < 0 ? Math.cos(ph) : -Math.cos(ph), st = s * Math.sin(ph);
        out.push([c[0] + h * (cn * N[0] + st * T[0]), c[1] + h * (cn * N[1] + st * T[1])]);
      }
      return out;
    };
    const done = new Set();
    for (let t = ta; t <= tb + 1e-9; t += 0.008) {
      const q = notches.find((z) => Math.abs(t - z.t) < (hn + 0.25) / H);
      if (q) { if (!done.has(q)) { ins.push(...notchSeq(q)); done.add(q); } continue; }
      ins.push(surf(t));
    }
    return [...up, ...opU, ...fund(ta, -1), ...ins, ...fund(tb, 1), ...opL, ...dn.reverse()];
  };
  return { base, off, seq };
}

/**
 * Coronal slice at the level of the thalamus and the body of the hippocampus. The pial outline
 * (with every sulcus, the Sylvian fissure and insula, the longitudinal fissure ending on the corpus
 * callosum, and the clefts beside the diencephalon cut in) is grey matter; the white matter is
 * everything deeper than the local cortical thickness (thicker on gyral crowns than in sulcal fundi),
 * plus the corpus callosum and the base of the diencephalon, which have no cortex on them. The
 * hippocampus bulges into the temporal horn, with Ammon's horn and the dentate gyrus as two
 * interlocking Cs and the subiculum continuous with the parahippocampal cortex. AD: thinner cortex,
 * open sulci, widened Sylvian fissure, thin callosum, enlarged ventricles and temporal horns,
 * dilated choroidal fissures, shrunken hippocampi.
 */
function coronal(ad) {
  const L = new Layers();
  const W = 300, H = 236;
  const sc = ad ? 0.965 : 1;
  const S = ([x, y]) => [150 + (x - 150) * sc, 118 + (y - 118) * sc];
  const mir = (pts) => pts.map(([x, y]) => [300 - x, y]);
  const tfm = (m) => (p) => S(m ? [300 - p[0], p[1]] : p);
  /** Inverse of tfm(m): slice coordinates back to the right hemisphere's own. */
  const invT = (m) => ([x, y]) => {
    const q = [150 + (x - 150) / sc, 118 + (y - 118) / sc];
    return m ? [300 - q[0], q[1]] : q;
  };
  const Tc = ad ? 3.85 : 5.5, Tf = ad ? 2.45 : 3.5; // cortical thickness on crowns and in fundi
  const hS = ad ? 2.1 : 0.75; // half-width of an ordinary sulcus
  const G = {
    gm: "#e4b8ad", wm: "#f8efe7", vent: "#c3def0", stri: "#f1ba8c", gp: "#f7d8b5", thal: "#ebb3a4", hypo: "#f4d4ca",
    hippo: "#b2d48c", tract: "#fffbf6",
  };
  // right half of the slice from the top of the longitudinal fissure round to the midline at the
  // base of the diencephalon (hypothalamus), mirrored
  const right = [[150, 24], [158, 14.5], [172, 9], [190, 7], [210, 8.5], [230, 14.5], [248, 25.5], [263, 40.5], [275, 59.5], [282, 82],
    [285.5, 105], [285.5, 126], [283, 146], [278, 166], [270, 185], [258, 202], [243, 215], [227, 222], [212, 221], [200, 214.5],
    [192, 204], [188, 195.5], [183.5, 191], [176, 190.5], [169, 188.5], [163, 185.5], [157, 184], [150, 184.5]];
  const key = [...right, ...mir(right.slice(1, -1)).reverse()].map(S);
  const hull = resample([...catmull(key, 12, true), key[0]], 1.1);
  if (dist(hull[0], hull[hull.length - 1]) < 0.6) hull.pop();
  const nrm = normals(hull);
  const nearest = (poly, q) => poly.reduce((b, p, i) => (dist(p, q) < dist(poly[b], q) ? i : b), 0);
  const angOf = (v) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  const cumS = [0];
  for (let i = 1; i < hull.length; i++) cumS.push(cumS[i - 1] + dist(hull[i], hull[i - 1]));
  const perim = cumS[cumS.length - 1] + dist(hull[0], hull[hull.length - 1]);
  const atS = (s) => {
    s = ((s % perim) + perim) % perim;
    let i = cumS.findIndex((v) => v >= s);
    return i < 0 ? hull.length - 1 : i;
  };

  const R = rng(17);
  const cuts = [];
  // a sulcal centreline: in along `ang`, swinging ±B° about it in a gentle S (the bend changes sign)
  const centreline = (p0, ang, depth, B, phase = 0) => {
    const pts = [p0];
    let [x, y] = p0;
    for (let t = 1; t <= depth; t++) {
      const a = ang + B * Math.sin(1.9 * Math.PI * (t / depth) + phase);
      x += Math.cos(rad(a));
      y += Math.sin(rad(a));
      pts.push([x, y]);
    }
    return pts;
  };
  const addSulcus = (q, ang, depth, B, h, br) => {
    const cl = centreline(q, ang, depth, B);
    cuts.push({ cl, h });
    if (br) {
      // a side branch leaving one wall part of the way down
      const [fr, side, lf] = br;
      const i = Math.max(3, Math.round(cl.length * fr)), a = cl[i - 1], b = cl[i + 1];
      const l = dist(a, b), u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], nv = [-u[1] * side, u[0] * side];
      const start = [cl[i][0] + nv[0] * h, cl[i][1] + nv[1] * h];
      cuts.push({ cl: centreline(start, angOf(u) + side * 48, Math.max(4, Math.round(depth * lf)) + (ad ? 1 : 0), -side * 16), h: h * 0.9, branch: true });
    }
  };
  // sulci of the right hemisphere, by position along the outline from the top of the longitudinal
  // fissure: [s, depth, S-bend°, lean°, side branch [fraction down, side, relative length]]. The named
  // sulci are the deep ones; the left hemisphere mirrors them with small differences.
  const SUL = [
    [19, 29, 24, 6, null], // superior frontal
    [35, 9, -20, -4, null],
    [62, 14, 26, 8, [0.5, 1, 0.45]],
    [92, 30, -28, -6, [0.58, -1, 0.35]], // central
    [108, 10, 22, 4, null],
    [134, 21, 30, -8, [0.42, 1, 0.4]], // postcentral
    [166, 12, -24, 6, null],
    [194, 15, 26, -4, [0.5, 1, 0.45]],
    [245, 28, -30, 6, [0.66, 1, 0.32]], // superior temporal
    [273, 23, 26, -6, null], // inferior temporal
    [297, 9, -22, 0, null],
    [319, 19, -24, 8, null], // occipitotemporal
    [352, 24, 28, -4, [0.45, 1, 0.35]], // collateral
  ];
  for (const [s0, depth, B, lean, br] of SUL) {
    for (const m of [false, true]) {
      const s = (m ? perim - s0 * sc - (R() - 0.5) * 6 : s0 * sc);
      const i = atS(s);
      const ang = angOf(nrm[i]) + (m ? -lean : lean) + (R() - 0.5) * 6;
      const dep = depth + (ad ? 2 : 0) + (R() - 0.5) * 4;
      const bb = (m ? -B : B) * (0.8 + R() * 0.4);
      addSulcus(hull[i], ang, Math.round(dep), bb, hS, br ? [br[0] + (R() - 0.5) * 0.1, m ? -br[1] : br[1], br[2]] : null);
    }
  }
  // lateral (Sylvian) fissure: a stem rising gently medially in a slight S between the opercula, opening
  // into a small triangular cistern against the insula; from there the cleft follows the laterally
  // convex insula up and down (superior and inferior limbs of the circular sulcus, angled
  // superomedially and inferomedially). The insula carries 3 short gyri between 2 oblique insular
  // sulci of different depths. Widened (and the insula thinner) in AD. All in the right hemisphere's
  // own coordinates, then mirrored and scaled.
  const hSy = ad ? 2.1 : 0.8, flare = ad ? 3.4 : 2.3;
  const SY = sylvianGeometry(ad);
  for (const m of [false, true]) {
    const tf = tfm(m);
    const ml = invT(m)(hull[nearest(hull, tf([285.5, 128.5]))]);
    const E = SY.off(0.5, 0.8 + 2 * hSy + 2.6);
    const clL = resample(catmull([ml, [273, ml[1] - 1.6], [262.5, E[1] + 3.2], E], 10), 1);
    cuts.push({ cl: clL.map(tf), h: hSy, named: "sylvian", seqFn: (clG) => SY.seq(clG.map(invT(m)), hSy, flare).map(tf) });
  }
  // the clefts between each medial temporal lobe and the diencephalon (transverse fissure / ambient
  // cistern), rising from the base to the medial edge of the hippocampus (choroidal fissure)
  const hip = ad ? { c: [204.5, 169.5], s: 0.68 } : { c: [206, 167], s: 1.12 };
  const hipLocal = [[-13, 2.5], [-10, -3.8], [-3, -8], [5, -8.2], [11.5, -4.6], [13.6, 2], [10.2, 7.6], [2, 9], [-6, 8.8], [-11.2, 6.2]];
  const H2 = (pts) => pts.map(([x, y]) => [hip.c[0] + x * hip.s, hip.c[1] + y * hip.s]);
  const tip = H2([[-13, 2.5]])[0];
  const clefts = [];
  for (const m of [false, true]) {
    const tf = tfm(m);
    const q = hull[nearest(hull, tf([187, 193.5]))];
    const top = tf([tip[0] - 1, tip[1] + 0.6]);
    const mid = [(q[0] + top[0]) / 2 + (m ? 0.8 : -0.8), (q[1] + top[1]) / 2];
    const c = { cl: resample(catmull([q, mid, top], 8), 1), h: ad ? 1.6 : 1.15, hwf: ad ? (t) => 1.6 + 1.5 * t * t : null, m };
    c.full = c.cl.slice();
    cuts.push(c);
    clefts.push(c);
  }
  // rounded gyral shoulders: the surface dips a little at each sulcal mouth
  const dip = ad ? 3 : 2.2;
  const mouths = [...cuts.filter((c) => !c.branch).map((c) => c.cl[0]), hull[0]];
  const surf = hull.map((p, i) => {
    let d = 0;
    for (const mo of mouths) d = Math.max(d, Math.exp(-Math.pow(dist(p, mo) / 4.2, 2)));
    return [p[0] + nrm[i][0] * dip * d, p[1] + nrm[i][1] * dip * d];
  });
  for (const c of cuts) if (!c.branch) c.cl = c.cl.slice(Math.ceil(dip));
  const slits = (c) => {
    if (c.seqFn) return { seq: c.seqFn(c.cl), m: c.cl[0], rc: c.h + 1 };
    const n = c.cl.length;
    const hw = c.hwf ? (i) => c.hwf(i / n) : (i) => c.h * (1 - 0.25 * Math.pow(i / n, 2));
    return { seq: slitSeq(c.cl, hw, 0), m: c.cl[0], rc: hw(0) + 1 };
  };
  // longitudinal fissure down to the corpus callosum, with the callosal sulci
  const floorY = S([150, ad ? 85 : 86])[1];
  const hF = ad ? 2.2 : 0.9, hc = ad ? 1.3 : 0.75;
  // callosal sulci [right, left]: different lengths and hooks, so the midline is not a symmetric "⊥"
  const ccSides = [{ Lcc: 12.5 * sc, hook: 4.2 }, { Lcc: 10.4 * sc, hook: 2.9 }];
  const yTop = surf[0][1] + 1.2;
  const fis = { seq: fissureSeq(yTop, floorY, hF, hc, ccSides), m: [150, yTop], rc: hF + 1.6 };
  let brain = spliceIn(surf, [...cuts.filter((c) => !c.branch).map(slits), fis], ad ? "AD slice" : "slice");
  for (const c of cuts.filter((c) => c.branch)) brain = spliceIn(brain, [slits(c)]);
  // the cingulate sulcus, branching off the wall of the longitudinal fissure on the medial surface
  const late = [];
  const wallBranch = (probe, ang, len, h, bend = 0) => ({ cl: centreline(brain[nearest(brain, probe)], ang, len, bend), h, branch: true });
  for (const m of [false, true]) {
    const sg = m ? -1 : 1, mA = (a) => (m ? 180 - a : a);
    late.push(wallBranch(S([150 + sg * hF, m ? 60 : 64.5]), mA(m ? -22 : -12), m ? 15 : 13, hS, m ? 14 : -10));
  }
  for (const c of late) brain = spliceIn(brain, [slits(c)]);
  const nx = crossings(brain);
  if (nx) console.warn(`brain.mjs: ${ad ? "AD " : ""}coronal outline crosses itself ${nx}× (near ${crossings.at.map((v) => v.toFixed(0))})`);

  // white matter = deeper than the local cortical thickness below the pial surface, or in the
  // corpus callosum (below the callosal sulci), the base of the diencephalon (medial to the clefts)
  // or the fimbria at the top of each cleft, which have no cortex on them — except along the
  // subiculum, where the cortex of the parahippocampal gyrus runs on into Ammon's horn
  const ccHalf = (sd, sgn) => {
    const fn = callosalLine(floorY, hc, sd, sgn), pts = [];
    for (let i = 0; i <= 14; i++) pts.push(fn(i / 14));
    const e = pts[pts.length - 1];
    return [...pts, [e[0] + sgn * (Tc + 1.5), e[1]], [e[0] + sgn * (Tc + 1.5), floorY + 40]];
  };
  const ccPoly = [...ccHalf(ccSides[0], 1), ...ccHalf(ccSides[1], -1).reverse()];
  const [cR, cL] = clefts;
  const dien = [S([150, 150]), S([166, 151]), S([182, 157.5]), ...cR.full.slice().reverse(), [cR.full[0][0], 262], [cL.full[0][0], 262], ...cL.full, S([118, 157.5]), S([134, 151])];
  const caStart = [-10.7, 5.6];
  const subs = [], fimb = [];
  for (const c of clefts) {
    const f0 = c.full[c.full.length - 1], f1 = c.full[Math.max(0, c.full.length - 8)];
    const dn = [(f1[0] - f0[0]) / dist(f0, f1), (f1[1] - f0[1]) / dist(f0, f1)];
    const lat = c.m ? [dn[1], -dn[0]].map((v) => -v) : [dn[1], -dn[0]];
    const hwTop = c.hwf ? c.hwf(1) : c.h;
    // the subiculum: from the middle of the cortex on the lateral wall of the cleft into the CA band
    const a = [f0[0] + dn[0] * 7 * hip.s + lat[0] * (hwTop + Tc / 2), f0[1] + dn[1] * 7 * hip.s + lat[1] * (hwTop + Tc / 2)];
    const b = tfm(c.m)(H2([[caStart[0] + 1.2, caStart[1] + 0.2]])[0]);
    subs.push(polyPts(tubePts([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.6], b], Tc * 0.5 * (ad ? 1.15 : 1), { step: 0.8 })));
    // the fimbria / alveus round the top of the cleft: white matter, not cortex
    fimb.push(polyPts(blobPts(f0[0] - dn[0] * 2 * hip.s + lat[0] * 0.5, f0[1] - dn[1] * 2 * hip.s + lat[1] * 0.5, 5.4 * hip.s + 1 + hwTop, 5.4 * hip.s + 1 + hwTop, { n: 12, wobble: 0 })));
  }
  const Gd = gridFor(brain);
  const Ds = sdf(rasterIn(brain, Gd), Gd), Sc = sdf(rasterIn(ccPoly, Gd), Gd), Sd = sdf(rasterIn(dien, Gd), Gd);
  // depth below the outer surface (with the fissures but without the sulci): crowns ≈ 0
  const outer = spliceIn(surf, [...clefts.map(slits), fis]);
  const Dh = sdf(rasterIn(outer, Gd), Gd);
  const Sb = fimb.map((p) => sdf(rasterIn(p, Gd), Gd)), Ss = subs.map((p) => sdf(rasterIn(p, Gd), Gd));
  const F = new Float64Array(Ds.length);
  for (let k = 0; k < F.length; k++) {
    const Tk = Tc - (Tc - Tf) * clamp((Dh[k] - Tc) / 12);
    let v = Math.max(Ds[k] - Tk, Math.min(Ds[k] + 0.35, Math.max(Sc[k], Sd[k], Sb[0][k], Sb[1][k])));
    v = Math.min(v, -Ss[0][k], -Ss[1][k]);
    F[k] = v;
  }
  const wm = contours(F, Gd);

  // sulci and fissures are CSF-filled clefts (the ventricles' colour), with a thin shade cast by
  // their upper-left wall; a darker rim along the slice's shadow side
  L.def("gmRim", { fill: shade(G.gm, 0.25), line: false })
    .def("csfS", { fill: G.vent, ...noLine(G.vent) })
    .def("gmSh", { fill: shade(G.gm, 0.25), line: false })
    .def("gm", { fill: G.gm, lineWidth: 1.2 })
    .def("wm", { fill: G.wm, stroke: sw(shade(G.wm, 0.05), 0.6), lineWidth: 0.8 })
    .def("hypo", { fill: G.hypo, shade: "rim", lineWidth: 0.8, unite: [] })
    .def("stri", { fill: G.stri, shade: "rim", lineWidth: 0.9 })
    .def("gp", { fill: G.gp, shade: "rim", lineWidth: 0.8 })
    .def("claus", { fill: G.gm, lineWidth: 0.6 })
    .def("vent", { fill: G.vent, stroke: sw(shade(G.vent, 0.16), 0.9), lineWidth: 1 })
    .def("thal", { fill: G.thal, shade: "rim", lineWidth: 0.9 })
    .def("caud", { fill: G.stri, shade: "rim", lineWidth: 0.9 })
    .def("tract", { fill: G.tract, stroke: sw(shade(G.wm, 0.14), 0.45), lineWidth: 0.7 })
    .def("hippo", { fill: G.hippo, shade: "rim", lineWidth: 0.9 })
    .def("ca", { fill: shade(G.hippo, 0.13), lineWidth: ad ? 0.3 : 0.4, thin: true })
    .def("dg", { fill: shade(G.hippo, 0.22), lineWidth: ad ? 0.28 : 0.35, thin: true })
    .def("fimbria", { fill: G.tract, stroke: sw(shade(G.wm, 0.12), 0.4), lineWidth: 0.6 });
  // rim, CSF in the clefts, the shade cast into them, grey matter, white matter
  L.add("gmRim", movePath(polyD(surf), 1.6, 1.8));
  L.add("csfS", polyD(surf));
  L.add("gmSh", movePath(polyD(brain), 0.7, 0.8));
  L.add("gm", polyD(brain));
  L.add("wm", wm.map((lp) => smoothClosed(lp)));

  const both = (k, d) => { L.add(k, d(false)); L.add(k, d(true)); };
  const tf = (pts, m) => pts.map(tfm(m));
  // hypothalamus: the pale base of the diencephalon round the floor of the third ventricle (no cortex),
  // tapering from the width of the thalami to the base, with the mammillary bodies on its ventral face
  const iR = nearest(surf, S([157, 184.5])), iL = nearest(surf, S([143, 184.5]));
  const base = surf.slice(iR, iL + 1).map((p, k) => [p[0] - nrm[iR + k][0] * 0.35, p[1] - nrm[iR + k][1] * 0.35]);
  const hy = (x, y) => S([x, y]);
  L.map.get("hypo").unite.push(smoothClosed([hy(137, 146), hy(150, 147.6), hy(163, 146), hy(160.6, 156), hy(158.2, 166), hy(157.3, 176), ...base, hy(142.7, 176), hy(141.8, 166), hy(139.4, 156)], 0.8));
  const midBase = surf[nearest(surf, S([150, 186]))];
  for (const sg of [-1, 1]) L.map.get("hypo").unite.push(circle(midBase[0] + sg * 3.3 * sc, midBase[1] - 0.4, 3 * sc));
  // lentiform nucleus (putamen + globus pallidus) and claustrum, beside the insula
  both("stri", (m) => smoothClosed(tf([[218, 103.5], [227, 109.5], [231.4, 121], [231, 135], [226, 147.5], [217, 150.5], [212.5, 139], [213, 119]], m)));
  both("gp", (m) => smoothClosed(tf([[211.5, 118], [212.5, 131], [210.5, 144], [204.5, 137.5], [203, 126]], m)));
  // the claustrum: a thin curved sheet parallel to the insula, beyond its cortex and the extreme capsule
  const clausPts = [];
  for (let t = -0.06; t <= 1.13; t += 0.07) clausPts.push(SY.off(t, -(ad ? 8 : 9.2)));
  both("claus", (m) => ribbon(tf(clausPts, m), 1.6, { taper: 0.7 }));
  // lateral ventricles under the corpus callosum (septum pellucidum between them), third ventricle;
  // AD: about twice the healthy height, ballooned at the superolateral angle, the caudate still in
  // the inferolateral wall
  const lv = ad
    ? [[151.4, 89.4], [160, 88.6], [170, 89.4], [179, 91.6], [186.5, 94.8], [191.5, 99.4], [192.6, 104.6], [190, 108.8], [181, 111], [169, 111.2], [158, 111], [151.4, 110.6], [151.4, 104], [151.4, 96]]
    : [[150.75, 98.2], [158, 97.6], [167, 98.3], [176, 100.1], [182.5, 102.4], [186, 105.3], [184, 108.6], [176, 108.8], [167, 108.9], [159, 108.6], [150.75, 108], [150.75, 104.5], [150.75, 101]];
  both("vent", (m) => smoothClosed(tf(lv, m), 0.75));
  // third ventricle: a slit down the midline (6–7 units wide in AD), ending ~3 units above the base
  const v3w = ad ? 3.3 : 0.85, v3top = ad ? 108 : 106.5, v3bot = 118 + (midBase[1] - 3 - 118) / sc;
  L.add("vent", smoothClosed([S([150 - v3w, v3top]), S([150 + v3w, v3top]), S([150 + v3w, v3bot - 9]), S([150 + v3w * 0.55, v3bot - 3.5]), S([150, v3bot]), S([150 - v3w * 0.55, v3bot - 3.5]), S([150 - v3w, v3bot - 9])], 0.5));
  // temporal horns capping the hippocampi (dilated in AD)
  const hornW = ad ? 6.4 : 2.5;
  const horn = loop(H2(hipLocal), 8)
    .map((p) => ({ p, a: (Math.atan2(p[1] - hip.c[1], p[0] - hip.c[0]) * 180) / Math.PI }))
    .filter(({ a }) => (ad ? a > -160 && a < 46 : a > -146 && a < 18))
    .map(({ p, a }) => [p[0] + Math.cos(rad(a)) * (hornW / 2 - 0.7), p[1] + Math.sin(rad(a)) * (hornW / 2 - 0.7)]);
  both("vent", (m) => ribbon(tf(horn, m), hornW, { taper: 0.55 }));
  // thalami beside the third ventricle, forming the floor of the lateral ventricles medially
  const thal = [[151, 109.5], [159, 107], [169, 107.6], [178.5, 112], [183.5, 121], [182.5, 132.5], [176, 141.5], [165, 146], [156, 145.5], [151, 139]];
  both("thal", (m) => smoothClosed(tf(ad ? thal.map(([x, y]) => [170 + (x - 170) * 0.94 + 1.5, 128 + (y - 128) * 0.94 + 1.5]) : thal, m)));
  // caudate body in the inferolateral angle of the lateral ventricle (as in health, slightly smaller in AD)
  both("caud", (m) => ellipse(...tfm(m)(ad ? [187.2, 110.6] : [178.5, 109.2]), ad ? 7.1 : 7.4, ad ? 4.4 : 4.6, m ? -(ad ? 33 : 28) : ad ? 33 : 28));
  // white tracts: fornix bodies under the septum; optic tracts resting on the ventral surface
  // lateral to the hypothalamus, against the cerebral peduncles
  for (const sg of [-1, 1]) L.add("tract", ellipse(...S([150 + sg * 2.3, ad ? 108.8 : 106]), 2.1, 1.5));
  for (const m of [false, true]) {
    const i = nearest(surf, tfm(m)([169, 189]));
    const p = surf[i], n = nrm[i];
    L.add("tract", ellipse(p[0] + n[0] * 1.7, p[1] + n[1] * 1.7, 3 * sc, 1.25 * sc, angOf([-n[1], n[0]])));
  }
  // hippocampus bulging into the floor of the temporal horn; inside, Ammon's horn (CA1 from the
  // subiculum along the floor, CA2–3 up the lateral side and back along the top, CA3–4 curling down
  // into the hilus) and the dentate gyrus, a C opening laterally round the end of CA4
  both("hippo", (m) => smoothClosed(tf(H2(hipLocal), m)));
  const caPts = [caStart, [-6.5, 7.2], [-0.5, 7.4], [5, 6.6], [9.4, 3.8], [10.9, -0.4], [9.1, -4.4], [4.2, -6.1], [-0.6, -5.9], [-2.4, -4.4], [-3.0, -2.1], [-4.4, 0.2]];
  // the pyramidal layer tapers: thin at the subiculum/CA1, widest at CA3, thinning again into the hilus
  const caW = (t) => hip.s * sc * (0.6 + 0.55 * clamp((t - 0.12) / 0.5) - 0.25 * clamp((t - 0.86) / 0.14));
  both("ca", (m) => smoothClosed(tubePts(tf(H2(caPts), m), caW, { step: 0.5 })));
  // the dentate gyrus: a thinner V/C cupping the end of CA3/CA4 and opening laterally, tapering to
  // fine ends (no blunt caps)
  const dgPts = [];
  for (let a = 32; a <= 242.1; a += 15) dgPts.push([-5 + 3.5 * Math.cos(rad(a)) * (a > 90 && a < 200 ? 0.92 : 1), 0.4 + 3.5 * Math.sin(rad(a))]);
  both("dg", (m) => smoothClosed(tubePts(tf(H2(dgPts), m), (t) => hip.s * sc * (0.12 + 0.42 * Math.pow(Math.sin(Math.PI * t), 0.7)), { step: 0.4 })));
  // fimbria: a small white-matter tab on the upper-medial edge, at the top of the cleft
  both("fimbria", (m) => ellipse(...tf(H2([[-12.1, -1.6]]), m)[0], 3.4 * hip.s * sc, 1.7 * hip.s * sc, m ? 180 + 64 : -64));
  return { size: [W, H], lineWidth: 1, parts: parts(L) };
}

/** Points of a closed outline drawn by smoothClosed (for rasterising). */
function polyPts(pts) {
  return loop(pts, 4);
}

/* ===================== icons ===================== */

export const icons = [
  {
    slug: "brain-cortex-healthy",
    name: "Cerebral cortex — healthy grey matter (section)",
    category: "tissues",
    tags: ["cerebral cortex", "grey matter", "gray matter", "neocortex", "brain", "CNS", "histology", "tissue section", "healthy", "control",
      "pyramidal neuron", "interneuron", "astrocyte", "oligodendrocyte", "microglia", "neuropil", "pia mater", "meninges", "subarachnoid space",
      "capillary", "blood-brain barrier", "BBB", "end-feet", "glia limitans", "penetrating arteriole", "layer I", "layer II/III", "NeuN", "GFAP", "Iba1", "Olig2",
      "neurovascular unit", "pericyte", "endothelial cell", "AQP4", "perivascular space", "Virchow-Robin space"],
    description: "Grey matter under the pia: a pial artery and its penetrating arteriole in a perivascular space, pyramidal neurons with apical dendrites to layer I and thin axons with oblique collaterals, interneurons, protoplasmic astrocytes whose end-feet sheathe every capillary (one flattened endothelial nucleus, a red cell, pericytes on two), satellite oligodendrocytes and ramified microglia. Pairs with brain-cortex-alzheimers.",
    scene: (style) => cortex(false, style),
  },
  {
    slug: "brain-cortex-alzheimers",
    name: "Cerebral cortex — Alzheimer's disease (plaques and tangles)",
    category: "tissues",
    tags: ["Alzheimer's disease", "AD", "dementia", "neurodegeneration", "cerebral cortex", "grey matter", "brain", "histology", "tissue section", "pathology",
      "amyloid plaque", "amyloid-beta", "Aβ", "senile plaque", "neuritic plaque", "dense-core plaque", "diffuse plaque", "dystrophic neurites",
      "neurofibrillary tangle", "NFT", "tau", "p-tau", "ghost tangle", "neuropil threads", "neuron loss", "reactive astrocytes", "astrogliosis",
      "activated microglia", "plaque-associated microglia", "DAM", "cerebral amyloid angiopathy", "CAA", "Thioflavin S", "AT8", "6E10", "GFAP", "Iba1"],
    description: "Same field as brain-cortex-healthy in Alzheimer's disease: dense-cored and diffuse amyloid-β plaques with dystrophic neurites, flame-shaped neurofibrillary tangles, a ghost tangle, neuropil threads, neuron loss and shrinkage, hypertrophic reactive astrocytes reaching towards the plaque, amoeboid microglia clustered on plaques and cerebral amyloid angiopathy thickening the walls of the pial artery and penetrating arteriole (with an enlarged perivascular space).",
    scene: (style) => cortex(true, style),
  },
  {
    slug: "amyloid-beta-plaque",
    name: "Amyloid-β plaque — dense-cored (neuritic) with microglia",
    category: "tissues",
    tags: ["amyloid plaque", "amyloid-beta", "amyloid beta", "Aβ", "Abeta", "Aβ42", "senile plaque", "neuritic plaque", "dense-core plaque", "cored plaque",
      "Alzheimer's disease", "AD", "dystrophic neurites", "plaque-associated microglia", "microglial barrier", "DAM", "TREM2", "amyloid fibrils",
      "Thioflavin S", "Congo red", "6E10", "4G8", "methoxy-X04", "amyloid PET", "lecanemab", "donanemab", "neurodegeneration"],
    description: "A dense-cored amyloid-β plaque: a compact, lobulated core with a few fibrillar spikes, a fading corona of radiating and crossing fibril bundles, club-shaped and beaded tau-laden dystrophic neurites entering from the surrounding neuropil, and three different activated microglia wrapping the plaque (two clustered on one side; phagocytosed Aβ inside).",
    scene: () => plaqueIcon(),
  },
  {
    slug: "neuron-neurofibrillary-tangle",
    name: "Pyramidal neuron with neurofibrillary tangle (NFT)",
    category: "cells",
    tags: ["neurofibrillary tangle", "NFT", "tau", "tauopathy", "hyperphosphorylated tau", "p-tau", "paired helical filaments", "PHF", "flame-shaped tangle",
      "pyramidal neuron", "neuron", "Alzheimer's disease", "AD", "Braak stage", "AT8", "PHF-1", "Gallyas", "Bielschowsky", "tau PET", "neurodegeneration"],
    description: "Cortical pyramidal neuron whose soma and proximal apical dendrite are filled by a flame-shaped neurofibrillary tangle that pushes the nucleus aside.",
    scene: () => nftNeuronIcon(),
  },
  {
    slug: "reactive-astrocyte",
    name: "Reactive astrocyte (hypertrophic, GFAP-high)",
    category: "cells",
    tags: ["reactive astrocyte", "astrocyte", "astrogliosis", "gliosis", "hypertrophic astrocyte", "GFAP", "vimentin", "glial fibrillary acidic protein",
      "A1 astrocyte", "disease-associated astrocyte", "DAA", "neuroinflammation", "Alzheimer's disease", "AD", "glia", "CNS", "plasma GFAP", "S100B",
      "end-foot", "perivascular end-foot", "capillary", "blood-brain barrier", "BBB", "AQP4"],
    description: "Reactive astrocyte: enlarged soma with an eccentric nucleus, thick, irregular, branched processes with blunt ends and GFAP intermediate-filament bundles sweeping round the nucleus into them, and a vascular end-foot that spreads into a lamella wrapping a capillary segment.",
    scene: () => reactiveAstrocyteIcon(),
  },
  {
    slug: "microglia-activated",
    name: "Activated microglia — amoeboid, engulfing amyloid-β (DAM)",
    category: "cells",
    tags: ["microglia", "activated microglia", "amoeboid microglia", "disease-associated microglia", "DAM", "MGnD", "phagocytosis", "phagocytic cup",
      "amyloid-beta", "Aβ", "TREM2", "APOE", "lipid droplets", "LDAM", "phagolysosome", "Iba1", "CD68", "TMEM119", "P2RY12", "neuroinflammation",
      "Alzheimer's disease", "AD", "brain macrophage", "CNS", "fibrillar amyloid", "pseudopod"],
    description: "Activated (amoeboid) microglia with short retracted processes; two pseudopods form a phagocytic cup, lined with TREM2, round a fibrillar amyloid-β aggregate; TREM2 also on the cell surface, phagolysosomes with ingested Aβ and lipid droplets inside.",
    scene: () => activatedMicrogliaIcon(),
  },
  {
    slug: "tau-tangle-fibrils",
    name: "Tau paired helical filament (PHF) — molecular structure",
    category: "proteins",
    tags: ["tau", "MAPT", "paired helical filament", "PHF", "tau filament", "tau fibril", "amyloid fibril", "cross-beta", "β-sheet", "protofilament",
      "C-shaped fold", "Alzheimer fold", "fuzzy coat", "hyperphosphorylation", "phospho-tau", "p-tau217", "p-tau181", "cryo-EM", "neurofibrillary tangle",
      "NFT", "tauopathy", "Alzheimer's disease", "AD", "seeding", "aggregation"],
    description: "Two protofilaments of stacked β-strands twist round each other to form a paired helical filament (crossover every ~80 nm); disordered tails, hyperphosphorylated along their length, form the fuzzy coat. Inset: cross-section of the filament core, two identical C-shaped Alzheimer folds (kinked back, β-helix and inward hook) packed back to back (C2 symmetry).",
    scene: () => tauFibrils(),
  },
  {
    slug: "brain-coronal-healthy",
    name: "Brain coronal slice — healthy",
    category: "anatomy",
    tags: ["brain", "coronal section", "coronal slice", "cerebrum", "cerebral hemispheres", "cortex", "grey matter", "white matter", "corpus callosum",
      "lateral ventricle", "third ventricle", "temporal horn", "hippocampus", "thalamus", "basal ganglia", "caudate", "putamen", "globus pallidus",
      "claustrum", "insula", "Sylvian fissure", "sulci", "gyri", "neuroanatomy", "MRI", "healthy", "control", "cingulate gyrus",
      "septum pellucidum", "fornix", "internal capsule", "hypothalamus", "optic tract", "subiculum", "dentate gyrus", "cornu ammonis", "choroidal fissure"],
    description: "Coronal slice through both hemispheres at the level of the thalamus and hippocampal body: gyri with white-matter cores, corpus callosum under the cingulate gyri, septum pellucidum and fornix, lateral and third ventricles, caudate, putamen, globus pallidus, claustrum and insula, thalamus, hypothalamus with mammillary bodies and optic tracts, and the hippocampus in the floor of the temporal horn (Ammon's horn and dentate gyrus interlocking, subiculum continuous with the parahippocampal cortex, fimbria). Pairs with brain-coronal-alzheimers.",
    scene: () => coronal(false),
  },
  {
    slug: "brain-coronal-alzheimers",
    name: "Brain coronal slice — Alzheimer's disease (atrophy)",
    category: "anatomy",
    tags: ["Alzheimer's disease", "AD", "dementia", "brain atrophy", "cortical atrophy", "hippocampal atrophy", "ventriculomegaly",
      "enlarged ventricles", "hydrocephalus ex vacuo", "widened sulci", "temporal horn", "medial temporal lobe atrophy", "MTA score", "neurodegeneration",
      "brain", "coronal section", "coronal slice", "MRI", "volumetry", "callosal atrophy", "choroidal fissure", "Sylvian fissure widening"],
    description: "Same coronal slice as brain-coronal-healthy in Alzheimer's disease: thinner cortex with widened, CSF-filled sulci and Sylvian fissure, thinned corpus callosum, lateral ventricles about twice the healthy height and a wider third ventricle, dilated temporal horns and choroidal fissures, shrunken hippocampi (medial temporal lobe atrophy).",
    scene: () => coronal(true),
  },
];
