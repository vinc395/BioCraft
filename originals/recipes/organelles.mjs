// Organelles, microbes and viruses — Servier-like: pastel fills, light from the top left.
import { blob, blobPts, circle, ellipse, rect, capsule, ribbon, smoothClosed, smoothOpen, scatter, wavePts, polygon, polyline, rotate, rng, f } from "../lib/geom.mjs";
import { shade, tint } from "../lib/style.mjs";
import { kit } from "./cells.mjs";
import { insideShape, edgeDistance } from "../lib/organic.mjs";

const shiftPath = (d, dx, dy) => kit.movePath(d, dx, dy);

const TAU = Math.PI * 2, DEG = Math.PI / 180;

/* ---------- palette (shared so the cell cutaway matches the single organelles) ---------- */
const C = {
  nucEnv: "#dcc0ea", nucPlasm: "#9d7cc8", nucleolus: "#65479a",
  mitoOut: "#f7bea6", mitoIn: "#ec8b7f",
  rer: "#e3809a", ribo: "#5b3f86", ser: "#eba3b9",
  golgi: "#7fb3de", golgiVes: "#a8cdeb",
};

/* ---------- private geometry helpers ---------- */
const lerp = (a, b, t) => a + (b - a) * t;
const pol = (cx, cy, rx, a, ry = rx) => [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];

/** Local points (centred on 0,0) → rotated by `rot`°, scaled, moved to (cx, cy). */
const place = (pts, cx, cy, rot = 0, s = 1) => {
  const c = Math.cos(rot * DEG), sn = Math.sin(rot * DEG);
  return pts.map(([x, y]) => [cx + (x * c - y * sn) * s, cy + (x * sn + y * c) * s]);
};

/** Dense points on a Catmull–Rom curve through `ctrl` (same curve as geom's smoothOpen/smoothClosed). */
function splinePts(ctrl, per = 10, closed = false) {
  const n = ctrl.length, out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = closed ? ctrl[(i - 1 + n) % n] : ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i % n], p2 = ctrl[(i + 1) % n];
    const p3 = closed ? ctrl[(i + 2) % n] : ctrl[Math.min(n - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let k = 0; k < per; k++) {
      const t = k / per, u = 1 - t;
      const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      out.push([b0 * p1[0] + b1 * c1[0] + b2 * c2[0] + b3 * p2[0], b0 * p1[1] + b1 * c1[1] + b2 * c2[1] + b3 * p2[1]]);
    }
  }
  if (!closed) out.push(ctrl[n - 1]);
  return out;
}

/** Even arc-length resampling of a polyline (closed: wraps around). */
function resample(pts, step, closed = false) {
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const [ax, ay] = src[i - 1], [bx, by] = src[i];
    const seg = Math.hypot(bx - ax, by - ay);
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      d += step;
    }
    carry = seg - (d - step);
  }
  if (closed && out.length > 1 && Math.hypot(out[out.length - 1][0] - out[0][0], out[out.length - 1][1] - out[0][1]) < step * 0.5) out.pop();
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

const area = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

/** Points just outside a closed outline every `step` px, pushed out by `off` (ribosomes on ER, beads on membranes). */
function alongOutline(pts, step, off, closed = true) {
  const r = resample(pts, step, closed);
  const sgn = area(pts) > 0 ? 1 : -1;
  return r.map((p, i) => {
    const a = r[(i - 1 + r.length) % r.length], b = r[(i + 1) % r.length];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [p[0] + (sgn * ty / l) * off, p[1] - (sgn * tx / l) * off];
  });
}

/** Closed outline of a band of width w (number or fn(t)) along an open centre line, with round caps. */
function bandPts(line, w, capN = 9) {
  const n = line.length, L = [], Rr = [], N = [], U = [];
  const wid = typeof w === "function" ? w : () => w;
  for (let i = 0; i < n; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const h = wid(n > 1 ? i / (n - 1) : 0) / 2;
    N.push([dy / l, -dx / l]); U.push([dx / l, dy / l]);
    L.push([line[i][0] + (dy / l) * h, line[i][1] - (dx / l) * h]);
    Rr.push([line[i][0] - (dy / l) * h, line[i][1] + (dx / l) * h]);
  }
  const cap = (P, nrm, u, h, back) => {
    const out = [];
    for (let k = 1; k < capN; k++) {
      const ph = (k / capN) * Math.PI, s = back ? -1 : 1;
      out.push([P[0] + h * (Math.cos(ph) * nrm[0] * s + Math.sin(ph) * u[0] * s), P[1] + h * (Math.cos(ph) * nrm[1] * s + Math.sin(ph) * u[1] * s)]);
    }
    return out;
  };
  const he = wid(1) / 2, hs = wid(0) / 2;
  return [...L, ...cap(line[n - 1], N[n - 1], U[n - 1], he, false), ...Rr.reverse(), ...cap(line[0], N[0], U[0], hs, true)];
}

/** Smooth closed path through a dense outline (resampled every `step` px). */
const smoothPath = (pts, step = 4) => smoothClosed(resample(pts, step, true));
/** The same outline reversed — a hole when appended to an enclosing path. */
const holePath = (pts, step = 4) => smoothClosed(resample(pts, step, true).reverse());
const ellPts = (cx, cy, rx, ry = rx, n = 64, rot = 0) => place(Array.from({ length: n }, (_, i) => pol(0, 0, rx, (i / n) * TAU, ry)), cx, cy, rot);
/** Ring (annulus) between two ellipses. */
const ring = (cx, cy, rx, ry, w) => ellipse(cx, cy, rx, ry) + holePath(ellPts(cx, cy, rx - w, ry - w, 72), 3);
const dots = (pts, r) => pts.map(([x, y]) => circle(x, y, r));

/** Annular sector with round ends, angles in degrees (nuclear envelope pieces, double membranes). */
function arcBandPts(cx, cy, rx, ry, w, a0, a1) {
  const n = Math.max(6, Math.round(Math.abs(a1 - a0) / 3));
  const mid = [];
  for (let i = 0; i <= n; i++) mid.push(pol(cx, cy, rx - w / 2, (a0 + ((a1 - a0) * i) / n) * DEG, ry - w / 2));
  return bandPts(mid, w);
}

/* ---------- organelle builders ---------- */

/**
 * Mitochondrion: outer membrane (super-ellipse) + inner membrane folded into cristae (one meander shape).
 * Returns {outer, inner} path data.
 */
function mitoPaths({ cx, cy, L, H, rot = 0, folds = 6, seed = 1, bend = 0, gap = 0.085, cwk = 0.085, depth = [0.56, 0.74] }) {
  const a = L / 2, b = H / 2, n = 2.5;
  const m = Math.max(2.5, H * gap), A = a - m, B = b - m;
  const cw = Math.max(2.4, H * cwk);
  const R = rng(seed);
  const bendY = (x) => bend * b * (x / a) ** 2;
  const sup = (t, ax, by) => {
    const c = Math.cos(t), s = Math.sin(t);
    const x = ax * Math.sign(c) * Math.abs(c) ** (2 / n);
    return [x, by * Math.sign(s) * Math.abs(s) ** (2 / n) + bendY(x)];
  };
  const half = (x) => B * Math.pow(Math.max(0, 1 - Math.abs(x / A) ** n), 1 / n);
  const outer = [];
  for (let i = 0; i < 120; i++) outer.push(sup((i / 120) * TAU, a, b));

  const cr = [];
  for (let k = 0; k < folds; k++) {
    const xc = lerp(-A * 0.72, A * 0.72, folds > 1 ? k / (folds - 1) : 0.5) + (R() - 0.5) * cw * 0.6;
    cr.push({ xc, top: k % 2 === 0, depth: lerp(depth[0], depth[1], R()) * 2 * B, lean: (R() - 0.5) * cw * 1.4 });
  }
  const tops = cr.filter((c) => c.top).sort((p, q) => p.xc - q.xc);
  const bots = cr.filter((c) => !c.top).sort((p, q) => q.xc - p.xc);
  const pts = [];
  const N = 400;
  let skip = null;
  for (let i = 0; i <= N; i++) {
    const t = Math.PI + (i / N) * TAU;
    const [x, y] = sup(t, A, B);
    const onTop = Math.sin(t) < 1e-9; // t = π (the start, x = −A) counts as top, so no bottom crista is spliced in first
    if (skip) {
      if ((skip.top && onTop && x < skip.x) || (!skip.top && !onTop && x > skip.x)) continue;
      skip = null;
    }
    if (onTop && tops.length && x >= tops[0].xc - cw / 2) {
      const c = tops.shift(), xl = c.xc - cw / 2, xr = c.xc + cw / 2;
      const yl = -half(xl) + bendY(xl), yr = -half(xr) + bendY(xr), yt = (yl + yr) / 2 + c.depth;
      for (let k = 0; k <= 6; k++) pts.push([lerp(xl, xl + c.lean, k / 6), lerp(yl, yt, k / 6)]);
      for (let k = 1; k < 8; k++) pts.push(pol(c.xc + c.lean, yt, cw / 2, Math.PI - (k / 8) * Math.PI));
      for (let k = 0; k <= 6; k++) pts.push([lerp(xr + c.lean, xr, k / 6), lerp(yt, yr, k / 6)]);
      skip = { top: true, x: xr };
      continue;
    }
    if (!onTop && bots.length && x <= bots[0].xc + cw / 2) {
      const c = bots.shift(), xl = c.xc - cw / 2, xr = c.xc + cw / 2;
      const yl = half(xl) + bendY(xl), yr = half(xr) + bendY(xr), yt = (yl + yr) / 2 - c.depth;
      for (let k = 0; k <= 6; k++) pts.push([lerp(xr, xr + c.lean, k / 6), lerp(yr, yt, k / 6)]);
      for (let k = 1; k < 8; k++) pts.push(pol(c.xc + c.lean, yt, cw / 2, -(k / 8) * Math.PI));
      for (let k = 0; k <= 6; k++) pts.push([lerp(xl + c.lean, xl, k / 6), lerp(yt, yl, k / 6)]);
      skip = { top: false, x: xl };
      continue;
    }
    pts.push([x, y]);
  }
  return { outer: smoothClosed(place(outer, cx, cy, rot)), inner: polygon(place(pts, cx, cy, rot)) };
}

function mitochondrionParts(o, colors = {}) {
  const p = mitoPaths(o);
  return [
    { d: p.outer, fill: colors.out || C.mitoOut, shade: "body", glossAt: o.glossAt },
    { d: p.inner, fill: colors.in || C.mitoIn, shade: "rim", gloss: false, thin: o.thin },
  ];
}

/** Nucleus: nucleoplasm, chromatin, nucleolus and an envelope broken by pores. */
function nucleusParts({ cx, cy, rx, ry, w, pores = 12, seed = 1, nucleolus = [0.12, 0.1, 0.3], poreGap = 7, chromatin = true }) {
  const R = rng(seed);
  const parts = [];
  parts.push({ d: ellipse(cx, cy, rx - w + 1.5, ry - w + 1.5), fill: C.nucPlasm, shade: "organelle", glossAt: [0.28, 0.24] });
  if (chromatin) {
    const pts = scatter(cx, cy, (rx - w) * 0.72, (ry - w) * 0.72, 14, { seed: seed + 3, minDist: rx * 0.17 });
    parts.push({ unite: pts.map(([x, y], i) => blob(x, y, 3 + R() * 3.5, 2.6 + R() * 3, { n: 6, wobble: 0.25, seed: seed + i })), fill: shade(C.nucPlasm, 0.1), opacity: 0.55, line: false });
  }
  const [nx, ny, nr] = nucleolus;
  parts.push({ d: blob(cx + rx * nx, cy + ry * ny, rx * nr, ry * nr * 0.92, { n: 8, wobble: 0.09, seed: seed + 7 }), fill: C.nucleolus, shade: "organelle" });
  // envelope pieces between pores
  const segs = [];
  const span = 360 / pores, gapDeg = (poreGap / ((rx + ry) / 2)) / DEG;
  const off = R() * span;
  for (let i = 0; i < pores; i++) {
    const a0 = off + i * span + gapDeg / 2 + (R() - 0.5) * span * 0.2;
    const a1 = off + (i + 1) * span - gapDeg / 2 + (R() - 0.5) * span * 0.2;
    segs.push(polygon(arcBandPts(cx, cy, rx, ry, w, a0, a1)));
  }
  parts.push({ d: segs, fill: C.nucEnv, shade: "rim", gloss: false });
  return parts;
}

/** A flattened ER sac (cisterna) along a centre line: bulbous ends, thickness w. */
function sacPts(ctrl, w, { bulb = 0.35, per = 12 } = {}) {
  const line = resample(splinePts(ctrl, per), 2.5);
  return bandPts(line, (t) => w * (1 + bulb * Math.max(0, 1 - Math.min(t, 1 - t) * 6.5) ** 2));
}

/* ---------- icons ---------- */

export const icons = [
  {
    slug: "nucleus", name: "Nucleus", category: "organelles",
    tags: ["nucleus", "cell nucleus", "nuclear envelope", "nuclear membrane", "nuclear pore", "nuclear pore complex", "NPC", "nucleolus", "chromatin", "heterochromatin", "euchromatin", "nucleoplasm", "double membrane", "organelle", "DNA", "genome", "eukaryotic cell"],
    scene: () => ({ size: [200, 200], parts: nucleusParts({ cx: 100, cy: 100, rx: 84, ry: 80, w: 10, pores: 12, seed: 4 }) }),
  },
  {
    slug: "mitochondrion", name: "Mitochondrion", category: "organelles",
    tags: ["mitochondria", "mitochondrion", "cristae", "inner membrane", "outer membrane", "mitochondrial matrix", "intermembrane space", "ATP", "ATP synthase", "OXPHOS", "oxidative phosphorylation", "electron transport chain", "respiration", "TCA cycle", "Krebs cycle", "mtDNA", "metabolism", "powerhouse", "organelle"],
    scene: () => ({ size: [200, 200], parts: mitochondrionParts({ cx: 100, cy: 100, L: 182, H: 104, rot: -12, folds: 7, seed: 5, bend: 0.06 }) }),
  },
  {
    slug: "rough-endoplasmic-reticulum", name: "Rough endoplasmic reticulum (RER)", category: "organelles",
    tags: ["RER", "rough ER", "rough endoplasmic reticulum", "ER", "endoplasmic reticulum", "ribosomes", "polysomes", "cisternae", "protein synthesis", "translation", "protein folding", "ER stress", "UPR", "unfolded protein response", "secretory pathway", "organelle"],
    scene: () => {
      // 200 × 200. Paint order: cisternae (each its own shaded shape) → ribosomes.
      // A stack of flattened cisternae of uneven length, staggered left/right (not centred rows), slightly
      // wavy, with bulbous ends; ribosomes stud the cytosolic face at uneven spacing with polysome-like runs
      // and bare gaps, and vary a little in size.
      const R = rng(21);
      const sacs = [];
      const rows = [
        { y: 33, x0: 28, x1: 130, w: 11.5 },
        { y: 67, x0: 64, x1: 184, w: 12.5 },
        { y: 100, x0: 16, x1: 150, w: 13 },
        { y: 134, x0: 50, x1: 186, w: 12 },
        { y: 167, x0: 22, x1: 114, w: 12.5 },
        { y: 170, x0: 140, x1: 182, w: 11 },
      ];
      for (const [j, r] of rows.entries()) {
        const ctrl = [];
        const k1 = r.x1 - r.x0 > 80 ? 4 : 2;
        for (let k = 0; k <= k1; k++) {
          const x = lerp(r.x0, r.x1, k / k1);
          ctrl.push([x, r.y + Math.sin(k * 1.3 + j * 1.7) * 3.2 + (k === 0 || k === k1 ? 2.4 : 0) * (j % 2 ? -1 : 1) + (R() - 0.5) * 2.4]);
        }
        sacs.push(sacPts(ctrl, r.w, { bulb: 0.3 + R() * 0.25 }));
      }
      const ribos = [];
      for (const s of sacs) {
        const ring = alongOutline(s, 1, 3.7);
        let i = Math.floor(R() * 5);
        while (i < ring.length) {
          ribos.push(circle(...ring[i], 2.2 + R() * 0.6));
          i += Math.round(R() < 0.1 ? 15 + R() * 8 : 5.4 + R() * 3.4); // mostly 5–9 apart, now and then a bare stretch
        }
      }
      return {
        size: [200, 200],
        parts: [
          { d: sacs.map((s) => polygon(s)), fill: C.rer, shade: "organelle", highlight: false, gloss: false },
          { unite: ribos, fill: C.ribo, thin: true },
        ],
      };
    },
  },
  {
    slug: "smooth-endoplasmic-reticulum", name: "Smooth endoplasmic reticulum (SER)", category: "organelles",
    tags: ["SER", "smooth ER", "smooth endoplasmic reticulum", "ER", "endoplasmic reticulum", "tubules", "tubular network", "ER network", "lipid synthesis", "steroid synthesis", "detoxification", "calcium store", "sarcoplasmic reticulum", "organelle"],
    scene: () => {
      // 200 × 200. One united shape: an anastomosing network of tubules with mostly three-way junctions, meshes of
      // uneven size, tubules of uneven calibre (6.5–12) that bow slightly, and a few blind-ended tubules at the periphery.
      // Every tubule has the same width (W0) where it meets a junction, so the round ends meet without lumps. Small
      // concave fillets (radius 3.4, less than the half-width) web each junction corner on its inner bisector.
      const nodes = [[44, 76], [86, 46], [140, 44], [172, 86], [66, 112], [110, 90], [146, 124], [38, 150], [92, 148], [124, 176], [170, 164]];
      const edges = [[0, 1], [1, 2], [2, 3], [3, 6], [6, 5], [5, 1], [0, 4], [4, 5], [4, 8], [8, 6], [6, 10], [10, 9], [9, 8], [7, 8]];
      const ends = [[0, [16, 62]], [2, [158, 18]], [3, [186, 64]], [7, [20, 176]], [9, [108, 190]], [10, [184, 186]]];
      const R = rng(31);
      const W0 = 8.4;
      const shapes = [], lights = [], inc = nodes.map(() => []);
      const dirOf = (p, q) => { const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
      // soft look made by hand (the renderer's rim would scale with the whole network, not with one tubule):
      // a shadow copy offset to the bottom right, and a thin light streak along the top-left side of each tubule
      const tubule = (i, j, a, b, wMid, wEnd, bowK) => {
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        const bow = (R() - 0.5) * bowK * l;
        const line = resample(splinePts([a, [mx - (dy / l) * bow, my + (dx / l) * bow], b], 10), 2.5);
        const n = line.length;
        const w = (t) => (1 - t) * W0 + t * wEnd + (wMid - (W0 + wEnd) / 2) * Math.sin(Math.PI * t);
        inc[i].push(dirOf(line[0], line[2]));
        if (j != null) inc[j].push(dirOf(line[n - 1], line[n - 3]));
        const mid = line.slice(Math.round(n * 0.16), Math.round(n * 0.84)).map(([x, y]) => [x - wMid * 0.17, y - wMid * 0.17]);
        if (mid.length > 2) lights.push(polygon(bandPts(mid, wMid * 0.24)));
        const bp = bandPts(line, w);
        tubePolys.push(bp);
        shapes.push(polygon(bp));
      };
      const tubePolys = [];
      // a point counts as "on the network" when it lies inside, or within `tol` of, some tubule
      const onNet = (p, tol) => tubePolys.some((q) => insideShape([q], p) || edgeDistance([q], p) < tol);
      for (const [i, j] of edges) tubule(i, j, nodes[i], nodes[j], 6.5 + R() * 5.5, W0, 0.32);
      for (const [i, tip] of ends) tubule(i, null, nodes[i], tip, 6 + R() * 2.5, 5.5 + R() * 1.5, 0.25);
      // junction fillets between angularly neighbouring tubules (radius below the tubule half-width)
      const hw = W0 / 2, rf = 3.4;
      for (const [k, P] of nodes.entries()) {
        const ds = inc[k].map((d) => ({ d, a: Math.atan2(d[1], d[0]) })).sort((p, q) => p.a - q.a);
        for (let m = 0; m < ds.length; m++) {
          const A = ds[m], B = ds[(m + 1) % ds.length];
          let gap = B.a - A.a;
          if (gap <= 0) gap += 2 * Math.PI;
          // acute corners (< 50°) would put the corner point far out along bowed tubules, where a fillet pokes out
          if (ds.length < 2 || gap < 0.87 || gap > 2.9) continue;
          const ni = [-A.d[1], A.d[0]], nj = [B.d[1], -B.d[0]];
          const Cn = kit.meet([P[0] + ni[0] * hw, P[1] + ni[1] * hw], A.d, [P[0] + nj[0] * hw, P[1] + nj[1] * hw], B.d);
          // the corner and both tangent points must sit on the tubule edges, or the fillet would show as a lump
          const t = rf / Math.tan(gap / 2);
          const T1 = [Cn[0] + A.d[0] * t, Cn[1] + A.d[1] * t], T2 = [Cn[0] + B.d[0] * t, Cn[1] + B.d[1] * t];
          if (![Cn, T1, T2].every((p) => onNet(p, 0.5))) continue;
          shapes.push(kit.filletPoly(Cn, A.d, B.d, rf));
        }
      }
      return {
        size: [200, 200],
        parts: [
          { unite: shapes.map((d) => shiftPath(d, 1.9, 1.9)), fill: shade(C.ser, 0.13), line: false },
          { unite: shapes, fill: C.ser },
          { unite: lights, fill: tint(C.ser, 0.12), opacity: 0.8, line: false },
        ],
      };
    },
  },
  {
    slug: "golgi-apparatus", name: "Golgi apparatus", category: "organelles",
    tags: ["Golgi", "Golgi apparatus", "Golgi complex", "Golgi body", "Golgi stack", "dictyosome", "cisternae", "cis-Golgi", "trans-Golgi network", "TGN", "secretory pathway", "protein trafficking", "glycosylation", "vesicles", "COPI", "COPII", "secretion", "organelle"],
    scene: () => golgiScene({ cx: 100, cy: 182, seed: 41 }),
  },
];

/**
 * Golgi stack in section, after Servier golgi-2d-1: five curved cisternae from the cis face (convex, top) to the trans
 * face (concave, bottom). 200 × 200. Paint order: cisternae (each shaded on its own) → vesicles (budding + free).
 * The cisternae differ in arc length (±25 %), thickness and lateral offset, and have dilated, bulbous rims. The cis-most
 * and trans-most cisternae are fenestrated (broken in two). Vesicles bud from the rims and from the concave face on the
 * trans side; a few small transport vesicles arrive at the cis face, and larger secretory vesicles leave below the
 * trans face.
 */
function golgiScene({ cx, cy, seed }) {
  const R = rng(seed);
  const sacs = [], buds = [], ves = [];
  const spec = [ // cis → trans: radius, arc length, thickness, lateral offset, bulb, fenestra (deg from the apex)
    { r: 160, L: 122, w: 9.5, dx: -5, bulb: 0.75, gap: [-9, -2] },
    { r: 138, L: 140, w: 11.5, dx: 4, bulb: 0.55 },
    { r: 116, L: 132, w: 12.5, dx: -2, bulb: 0.6 },
    { r: 94, L: 106, w: 11, dx: 6, bulb: 0.7 },
    { r: 72, L: 124, w: 13, dx: -3, bulb: 0.8, gap: [3, 21] },
  ];
  const ends = [];
  spec.forEach((s, k) => {
    const c = [cx + s.dx, cy + k * 2];
    const half = (s.L / (2 * s.r * 0.88)) * (180 / Math.PI);
    // a fenestra leaves the cut ends only slightly dilated; the outer rims keep their full bulb
    const pieces = s.gap ? [[-half, s.gap[0], s.bulb, 0.15], [s.gap[1], half, 0.15, s.bulb]] : [[-half, half, s.bulb, s.bulb]];
    for (const [d0, d1, b0, b1] of pieces) {
      const n = Math.max(3, Math.round((d1 - d0) / 8));
      const ctrl = [];
      for (let i = 0; i <= n; i++) ctrl.push(pol(c[0], c[1], s.r, (-90 + d0 + ((d1 - d0) * i) / n) * DEG, s.r * 0.78));
      const line = resample(splinePts(ctrl, 12), 2.5), w = s.w * (0.92 + R() * 0.16);
      sacs.push(bandPts(line, (t) => w * (1 + b0 * Math.max(0, 1 - t * 6.5) ** 2 + b1 * Math.max(0, 1 - (1 - t) * 6.5) ** 2)));
    }
    ends.push({ k, c, s, half });
  });
  const out = (e, deg) => pol(e.c[0], e.c[1], e.s.r, (-90 + deg) * DEG, e.s.r * 0.78);
  // budding vesicles: at the rims of the three trans-most cisternae (slightly below, on the concave side) and two
  // on the concave face of the trans-most one
  for (const e of ends.slice(2)) {
    const beyond = ((e.s.w / 2) * (1 + e.s.bulb) + 3.5) / (e.s.r * 0.88) / DEG; // just past the dilated rim
    for (const side of e.k % 2 ? [1] : [-1, 1]) {
      const p = out(e, side * (e.half + beyond));
      buds.push(circle(p[0], p[1] + 4, 5 + R() * 1.2));
    }
  }
  const t = ends[4];
  for (const deg of [-24, 22]) {
    const p = pol(t.c[0], t.c[1], t.s.r - t.s.w * 0.5 - 4.6, (-90 + deg) * DEG, (t.s.r - t.s.w * 0.5 - 4.6) * 0.78);
    buds.push(circle(p[0], p[1], 5.2));
  }
  // free vesicles: small ones at the cis face, larger secretory ones below the trans face
  ves.push(circle(56, 38, 5), circle(92, 26, 4.2), circle(141, 30, 5.6), circle(170, 52, 4));
  ves.push(circle(84, 160, 8.5), circle(118, 166, 6.8), circle(62, 176, 5.6));
  return {
    size: [200, 200],
    parts: [
      { d: sacs.map((s) => polygon(s)), fill: C.golgi, shade: "organelle", highlight: false, gloss: false },
      { d: [...buds, ...ves], fill: C.golgiVes, shade: "small", gloss: false },
    ],
  };
}
