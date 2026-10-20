// Brushes: patterns drawn along a smooth path that can be bent, extended and reshaped —
// lipid bilayers, DNA, RNA, epithelial cell layers, cytoskeletal filaments, collagen, blood
// vessels, myelinated axons, path arrows, freeform shapes, or any library icon repeated along
// the line (like BioRender's brushes). They are stored as "membrane" objects ({pts, closed,
// thickness, brush, palette…}) so older figures still open.
//
// Everything here is pure geometry → SVG markup; the same markup is drawn on the canvas and
// handed to the PNG/PDF exporters.

import { TRIM, head, headSize, headReach, dashArray } from "./heads.js";

const n = (v) => (Math.round(v * 100) / 100).toString();

/* ---------- colour helpers ---------- */

function rgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || "");
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
export const mix = (a, b, t) => {
  const A = rgb(a), B = rgb(b);
  return hex(A.map((v, i) => v + (B[i] - v) * t));
};
const lighten = (c, t) => mix(c, "#ffffff", t);
/** Darker and slightly richer, like the shading in Servier drawings. */
function shade(c, t) {
  const [r, g, b] = rgb(c);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx ? (mx - mn) / mx : 0;
  // push away from grey a little while darkening
  const k = 1 - t, boost = 1 + t * 0.35 * (1 - sat);
  const avg = (r + g + b) / 3;
  return hex([r, g, b].map((v) => (avg + (v - avg) * boost) * k));
}

/** Deterministic pseudo-random numbers in [0,1) for organic jitter that doesn't flicker. */
function rand(seed, i) {
  let x = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/* ---------- catalogue ---------- */

// [key, label, default colour]
export const BRUSHES = {
  bilayer: { name: "Lipid bilayer", T: 16, min: 6, max: 60 },
  dna: {
    name: "DNA double helix", T: 22, min: 8, max: 90, spacing: true,
    palette: [["s1", "Strand 1", "#2f6db5"], ["s2", "Strand 2", "#e0634f"], ["a", "A", "#f2b83d"], ["t", "T", "#7cc36e"], ["g", "G", "#5aa6e0"], ["c", "C", "#b07cd1"]],
  },
  rna: {
    name: "RNA / mRNA strand", T: 14, min: 6, max: 60, spacing: true,
    palette: [["s1", "Backbone", "#d9534f"], ["a", "A", "#f2b83d"], ["u", "U", "#7cc36e"], ["g", "G", "#5aa6e0"], ["c", "C", "#b07cd1"]],
  },
  cuboidal: {
    name: "Epithelium — cuboidal cells", T: 34, min: 10, max: 140, spacing: true, cells: true,
    palette: [["cell", "Cytoplasm", "#f7cfc0"], ["edge", "Cell edge", "#de8f7c"], ["nuc", "Nucleus", "#8f62b0"], ["bm", "Basement membrane", "#c6658a"]],
  },
  columnar: {
    name: "Epithelium — columnar cells", T: 60, min: 16, max: 220, spacing: true, cells: true,
    palette: [["cell", "Cytoplasm", "#f6d3c5"], ["edge", "Cell edge", "#dc8d7a"], ["nuc", "Nucleus", "#8f62b0"], ["bm", "Basement membrane", "#c6658a"]],
  },
  squamous: {
    name: "Squamous / endothelial cells", T: 10, min: 4, max: 60, spacing: true, cells: true,
    palette: [["cell", "Cytoplasm", "#f4c3c0"], ["edge", "Cell edge", "#d8857f"], ["nuc", "Nucleus", "#8f62b0"], ["bm", "Basement membrane", "#c6658a"]],
  },
  actin: {
    name: "Actin filament", T: 12, min: 4, max: 60, spacing: true,
    palette: [["m1", "Strand 1", "#f0a33c"], ["m2", "Strand 2", "#e27d3a"]],
  },
  microtubule: {
    name: "Microtubule", T: 24, min: 8, max: 90, spacing: true,
    palette: [["a", "α-tubulin", "#9fd3ef"], ["b", "β-tubulin", "#3d8ccf"]],
  },
  collagen: {
    name: "Collagen fibre", T: 16, min: 5, max: 80, spacing: true,
    palette: [["f", "Fibril", "#f1c48f"], ["d", "Banding & edge", "#b9783f"]],
  },
  vessel: {
    name: "Blood vessel", T: 40, min: 10, max: 220, spacing: true,
    palette: [["wall", "Wall", "#ec8f93"], ["edge", "Outer edge", "#b8434f"], ["lumen", "Lumen", "#fbe5de"], ["rbc", "Red blood cells", "#d9343c"]],
  },
  axon: {
    name: "Myelinated axon", T: 18, min: 6, max: 100, spacing: true,
    palette: [["myelin", "Myelin", "#e3ecf8"], ["sheath", "Myelin edge", "#8aa3c9"], ["axon", "Axon", "#f3c56c"]],
  },
  // drawn things rather than patterns: a smooth arrow along the path, a closed freeform blob
  arrow: { name: "Path arrow", T: 2.5, min: 0.5, max: 24, line: true, palette: [["line", "Colour", "#2b3440"]] },
  freeform: { name: "Freeform shape", T: 1.5, min: 0, max: 20, shape: true },
  icon: { name: "Repeat an icon", T: 40, min: 6, max: 300, spacing: true },
};

/** Ready-made arrangements of path arrows, placed by dragging a box (or clicking). */
export const BRUSH_PRESETS = {
  circular: { name: "Circular arrow", kind: "arrow" },
  plasmid: { name: "Plasmid / gene map", kind: "arrow" },
};

export const brushKind = (o) => (BRUSHES[o.brush] ? o.brush : "bilayer");

export function palette(o) {
  const def = BRUSHES[brushKind(o)].palette || [];
  const p = {};
  for (const [k, , c] of def) p[k] = o.palette?.[k] || c;
  return p;
}

/** How far the drawing reaches from the path (for bounding boxes and hit areas). */
export function brushPad(o) {
  const T = o.thickness ?? BRUSHES[brushKind(o)].T;
  const k = brushKind(o);
  if (BRUSHES[k].cells) return T * (k === "squamous" ? 1.9 : 1.25) + 2;
  if (k === "icon") return T * (0.75 + 0.6 * (o.jitter || 0)) + 2;
  if (k === "rna") return T * 0.9 + 2;
  if (k === "arrow" && !o.closed) {
    const s = headSize(T, o.headScale);
    return Math.max(T / 2, headReach(o.startHead, s), headReach(o.endHead, s)) + 2;
  }
  return T / 2 + 2;
}

/**
 * Evenly spaced points along an elliptical arc from a0 to a1 degrees (clockwise on the page),
 * about every `step` degrees (20° keeps the smooth curve through them within 1% of the circle).
 */
export function arcPts(cx, cy, rx, ry, a0, a1, step = 20) {
  const k = Math.max(2, Math.ceil(Math.abs(a1 - a0) / step));
  const out = [];
  for (let i = 0; i <= k; i++) {
    const a = ((a0 + ((a1 - a0) * i) / k) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/* ---------- path geometry ---------- */

/** Smooth curve through points (Catmull–Rom), sampled densely as a polyline. */
export function smoothPolyline(pts, closed, steps = 12) {
  if (pts.length < 2) return pts.slice();
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [P[i], P[i + 1], P[i + 2], P[i + 3]];
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(closed ? out[0] : pts[pts.length - 1]);
  return out;
}

/** A polyline parametrised by arc length. */
export class Track {
  constructor(poly, closed) {
    this.p = poly;
    this.closed = closed;
    this.cum = [0];
    for (let i = 1; i < poly.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
    this.len = this.cum[this.cum.length - 1] || 0;
  }
  pos(s) {
    const P = this.p, C = this.cum, L = this.len;
    if (P.length < 2 || !L) return P[0] ? [P[0][0], P[0][1]] : [0, 0];
    s = this.closed ? ((s % L) + L) % L : Math.max(0, Math.min(L, s));
    let lo = 0, hi = C.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (C[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = C[lo + 1] - C[lo];
    const t = seg > 1e-9 ? (s - C[lo]) / seg : 0;
    return [P[lo][0] + (P[lo + 1][0] - P[lo][0]) * t, P[lo][1] + (P[lo + 1][1] - P[lo][1]) * t];
  }
  /** [x, y, tx, ty]: position and unit tangent (central difference, so offsets bend smoothly). */
  at(s) {
    const h = Math.min(1.5, this.len / 200 || 0.5);
    const a = this.pos(this.closed ? s - h : Math.max(0, s - h)), b = this.pos(this.closed ? s + h : Math.min(this.len, s + h));
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const [x, y] = this.pos(s);
    return [x, y, dx / l, dy / l];
  }
  /** Point offset `d` along the normal (−ty, tx) at arc length s. */
  off(s, d) {
    const [x, y, tx, ty] = this.at(s);
    return [x - ty * d, y + tx * d];
  }
}

/** A freeform shape is always a closed loop. */
const isClosed = (o) => !!o.closed || o.brush === "freeform";

export function brushTrack(o, steps = 12) {
  const closed = isClosed(o);
  return new Track(smoothPolyline(o.pts, closed, steps), closed);
}

const P = (p) => `${n(p[0])} ${n(p[1])}`;
const line = (pts) => (pts.length ? "M" + pts.map(P).join("L") : "");

/** The part of a track between arc lengths s0 and s1, as a polyline. */
function subPath(tr, s0, s1) {
  const out = [tr.pos(s0)];
  for (let i = 1; i < tr.p.length - 1; i++) if (tr.cum[i] > s0 && tr.cum[i] < s1) out.push(tr.p[i]);
  out.push(tr.pos(s1));
  return out;
}

/** A line offset `d` from the track between s0 and s1. */
function offPath(tr, s0, s1, d, step) {
  const out = [];
  for (let s = s0; s < s1; s += step) out.push(tr.off(s, d));
  out.push(tr.off(s1, d));
  return out;
}

const strokePath = (d, color, w, extra = "") => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(w)}"${extra}/>`;

/** The centre line, used for the hit area and the editing guide. */
export function brushSpine(o) {
  const tr = brushTrack(o);
  const k = brushKind(o);
  const T = o.thickness ?? BRUSHES[k].T;
  const off = BRUSHES[k].cells ? (o.side === 1 ? 1 : -1) * T * 0.5 : 0;
  if (!off) return line(tr.p) + (tr.closed ? "Z" : "");
  const pts = [];
  const step = Math.max(2, tr.len / 400);
  for (let s = 0; s <= tr.len + 1e-6; s += step) pts.push(tr.off(s, off));
  return line(pts) + (tr.closed ? "Z" : "");
}

/* ---------- markup ---------- */

/** Markup for a brush object (coordinates as stored in o.pts). `icon` = {inner, vb} for icon brushes. */
export function brushMarkup(o, hit, icon = null) {
  const k = brushKind(o);
  const T = o.thickness ?? BRUSHES[k].T;
  let out = "";
  if (o.pts.length >= 2) {
    const tr = brushTrack(o);
    if (o.closed && o.fill && o.fill !== "none" && k !== "freeform") out += `<path d="${line(tr.p)}Z" fill="${o.fill}" stroke="none"/>`;
    if (tr.len > 0.5) {
      switch (k) {
        case "arrow": out += arrowMarkup(o, tr, T); break;
        case "freeform": out += freeformMarkup(o, tr, T); break;
        case "vessel": out += vesselMarkup(o, tr, T); break;
        case "axon": out += axonMarkup(o, tr, T); break;
        case "dna": out += dnaMarkup(o, tr, T); break;
        case "rna": out += rnaMarkup(o, tr, T); break;
        case "cuboidal":
        case "columnar":
        case "squamous": out += cellsMarkup(o, tr, T, k); break;
        case "actin": out += actinMarkup(o, tr, T); break;
        case "microtubule": out += microtubuleMarkup(o, tr, T); break;
        case "collagen": out += collagenMarkup(o, tr, T); break;
        case "icon": out += icon ? iconRepeatMarkup(o, tr, T, icon) : `<path d="${line(tr.p)}" fill="none" stroke="#c0392b" stroke-width="2" stroke-dasharray="4 3"/>`; break;
        default: out += bilayerMarkup(o, T);
      }
    }
  }
  if (hit) out += `<path class="hit" d="${brushSpine(o)}" fill="none" stroke="transparent" stroke-width="${n(Math.max(T, 8) + 6)}"/>`;
  return out;
}

/* lipid bilayer: two leaflets of round heads with paired tails */

function resampleEvery(poly, step) {
  const out = [];
  let carry = 0;
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1], [bx, by] = poly[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (!len) continue;
    const tx = (bx - ax) / len, ty = (by - ay) / len;
    let d = carry ? step - carry : 0;
    while (d <= len) {
      out.push([ax + tx * d, ay + ty * d, tx, ty]);
      d += step;
    }
    carry = len - (d - step);
  }
  return out;
}

function bilayerMarkup(o, T) {
  const r = o.headR ?? T * 0.17;
  const headC = o.headColor || "#f0a35c", tailC = o.tailColor || "#e9c88f";
  const poly = smoothPolyline(o.pts, o.closed);
  const samples = resampleEvery(poly, r * 2.15);
  let heads = "", tails = "";
  const off = T / 2 - r;
  for (const [x, y, tx, ty] of samples) {
    const nx = -ty, ny = tx;
    for (const side of [1, -1]) {
      const hx = x + nx * off * side, hy = y + ny * off * side;
      heads += `M${n(hx - r)} ${n(hy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;
      // two fatty-acid tails per lipid, pointing to the bilayer middle
      const inner = side * Math.max(0.6, T * 0.04);
      for (const s of [-0.38, 0.38]) {
        const ax = hx + tx * r * s - nx * r * 0.8 * side, ay = hy + ty * r * s - ny * r * 0.8 * side;
        tails += `M${n(ax)} ${n(ay)}L${n(x + nx * inner + tx * r * s)} ${n(y + ny * inner + ty * r * s)}`;
      }
    }
  }
  let out = `<path d="${tails}" fill="none" stroke="${tailC}" stroke-width="${n(Math.max(0.4, r * 0.32))}" stroke-linecap="round"/>`;
  out += `<path d="${heads}" fill="${headC}"${o.headStroke ? ` stroke="${o.headStroke}" stroke-width="${n(r * 0.18)}"` : ""}/>`;
  // a soft highlight on each head, as in the shaded library art
  if (T >= 10 && o.gloss !== false) {
    let hl = "";
    const hr = r * 0.38;
    for (const [x, y, tx, ty] of samples) {
      const nx = -ty, ny = tx;
      for (const side of [1, -1]) {
        const hx = x + nx * off * side - r * 0.3, hy = y + ny * off * side - r * 0.32;
        hl += `M${n(hx - hr)} ${n(hy)}a${n(hr)} ${n(hr)} 0 1 0 ${n(2 * hr)} 0a${n(hr)} ${n(hr)} 0 1 0 ${n(-2 * hr)} 0`;
      }
    }
    out += `<path d="${hl}" fill="${lighten(headC, 0.55)}" opacity="0.55"/>`;
  }
  return out;
}

/* DNA: two backbones with major/minor grooves and coloured base pairs */

function dnaMarkup(o, tr, T) {
  const pal = palette(o);
  const L = tr.len;
  const r = (T / 2) * 0.84, wb = T * 0.17, wr = T * 0.1;
  let pitch = T * 1.7 * (o.spacing || 1);
  if (o.closed) pitch = L / Math.max(1, Math.round(L / pitch));
  const dphi = Math.PI * 0.78; // B-DNA: the second backbone trails → major and minor grooves
  const ds = Math.max(0.6, pitch / 30);
  const runs = (phase) => {
    const out = { front: [], back: [] };
    let cur = null;
    for (let s = 0; s <= L + ds * 0.5; s += ds) {
      const ss = Math.min(s, L);
      const th = (2 * Math.PI * ss) / pitch + phase;
      const p = tr.off(ss, r * Math.sin(th));
      const front = Math.cos(th) >= 0;
      if (!cur || cur.front !== front) {
        const prev = cur ? cur.pts[cur.pts.length - 1] : null;
        if (cur) cur.pts.push(p);
        cur = { front, pts: prev ? [prev, p] : [p] };
        (front ? out.front : out.back).push(cur);
      } else cur.pts.push(p);
    }
    return out;
  };
  const a = runs(0), b = runs(dphi);
  const path = (rs) => rs.map((r) => line(r.pts)).join("");
  const ribbon = (rs, c, back) => {
    if (!rs.length) return "";
    const col = back ? shade(c, 0.32) : c;
    let s = `<path d="${path(rs)}" fill="none" stroke="${col}" stroke-width="${n(wb)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (!back && T >= 9) s += `<path d="${path(rs)}" fill="none" stroke="${lighten(c, 0.5)}" stroke-width="${n(wb * 0.3)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>`;
    return s;
  };
  // base pairs, ~10 per turn
  const PAIRS = [["a", "t"], ["t", "a"], ["g", "c"], ["c", "g"]];
  const step = pitch / 10;
  const byColour = {};
  const add = (c, d) => (byColour[c] = (byColour[c] || "") + d);
  const seed = o.seed || 7;
  for (let k = 0, s = step / 2; s < L; k++, s += step) {
    const th = (2 * Math.PI * s) / pitch;
    const p1 = tr.off(s, r * Math.sin(th)), p2 = tr.off(s, r * Math.sin(th + dphi));
    if (Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) < wb * 0.7) continue;
    const m = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    const [x, y] = PAIRS[Math.floor(rand(seed, k) * 4)];
    add(pal[x], `M${P(p1)}L${P(m)}`);
    add(pal[y], `M${P(m)}L${P(p2)}`);
  }
  let rungs = "";
  for (const [c, d] of Object.entries(byColour)) rungs += `<path d="${d}" fill="none" stroke="${c}" stroke-width="${n(wr)}" stroke-linecap="round"/>`;
  return ribbon(a.back, pal.s1, true) + ribbon(b.back, pal.s2, true) + rungs + ribbon(a.front, pal.s1, false) + ribbon(b.front, pal.s2, false);
}

/* RNA: one wavy backbone with bases on one side */

function rnaMarkup(o, tr, T) {
  const pal = palette(o);
  const L = tr.len, side = o.side === 1 ? 1 : -1;
  const wb = T * 0.2, amp = T * 0.07, per = T * 2.8;
  const wave = (s) => amp * Math.sin((2 * Math.PI * s) / per);
  const pts = [];
  const ds = Math.max(0.6, T / 10);
  for (let s = 0; s <= L + ds * 0.5; s += ds) pts.push(tr.off(Math.min(s, L), wave(Math.min(s, L))));
  const step = T * 0.46 * (o.spacing || 1);
  const by = {};
  const seed = o.seed || 11;
  const KEYS = ["a", "u", "g", "c"];
  for (let k = 0, s = step / 2; s < L; k++, s += step) {
    const w = wave(s);
    const c = pal[KEYS[Math.floor(rand(seed, k) * 4)]];
    by[c] = (by[c] || "") + `M${P(tr.off(s, w + side * wb * 0.2))}L${P(tr.off(s, w + side * T * 0.68))}`;
  }
  let out = "";
  for (const [c, d] of Object.entries(by)) {
    out += `<path d="${d}" fill="none" stroke="${shade(c, 0.25)}" stroke-width="${n(T * 0.24)}" stroke-linecap="round"/>`;
    out += `<path d="${d}" fill="none" stroke="${c}" stroke-width="${n(T * 0.16)}" stroke-linecap="round"/>`;
  }
  out += `<path d="${line(pts)}" fill="none" stroke="${shade(pal.s1, 0.2)}" stroke-width="${n(wb * 1.2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  out += `<path d="${line(pts)}" fill="none" stroke="${pal.s1}" stroke-width="${n(wb * 0.85)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  out += `<path d="${line(pts)}" fill="none" stroke="${lighten(pal.s1, 0.5)}" stroke-width="${n(wb * 0.28)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>`;
  return out;
}

/* Epithelial cells: a row of cells standing on a basement membrane */

/** Cut `r0` off the start and `r1` off the end of a polyline. */
function trim(pts, r0, r1) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  if (r0 + r1 >= L) {
    const t = r0 / (r0 + r1 || 1) * L;
    const p = pointAt(pts, cum, t);
    return [p, p];
  }
  const out = [pointAt(pts, cum, r0)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > r0 && cum[i] < L - r1) out.push(pts[i]);
  out.push(pointAt(pts, cum, L - r1));
  return out;
}
function pointAt(pts, cum, s) {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1, t = Math.max(0, Math.min(1, (s - cum[i - 1]) / seg));
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
}

/** A cell outline between arc lengths s0..s1 and heights h0..top(s) with rounded corners. */
function cellPath(tr, side, h0, top, rBase, rTop, s0, s1) {
  const K = Math.max(3, Math.ceil((s1 - s0) / 2.5));
  const bottom = [], upper = [];
  for (let k = 0; k <= K; k++) {
    const s = s0 + ((s1 - s0) * k) / K;
    bottom.push(tr.off(s, side * h0));
    upper.push(tr.off(s, side * top(s)));
  }
  upper.reverse();
  const right = [bottom[K], upper[0]], left = [upper[K], bottom[0]];
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const rb = Math.min(rBase, len(...right) * 0.45, len(...left) * 0.45), rt = Math.min(rTop, len(...right) * 0.45, len(...left) * 0.45);
  const B = trim(bottom, rb, rb), R = trim(right, rb, rt), U = trim(upper, rt, rt), Lf = trim(left, rt, rb);
  return `M${P(B[0])}L${B.slice(1).map(P).join("L")}Q${P(bottom[K])} ${P(R[0])}L${P(R[1])}Q${P(upper[0])} ${P(U[0])}L${U.slice(1).map(P).join("L")}Q${P(upper[K])} ${P(Lf[0])}L${P(Lf[1])}Q${P(bottom[0])} ${P(B[0])}Z`;
}

function ellipseAt(tr, s, h, rx, ry, side) {
  const [x, y, tx, ty] = tr.at(s);
  const cx = x - ty * h * side, cy = y + tx * h * side;
  const a = (Math.atan2(ty, tx) * 180) / Math.PI;
  return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" transform="rotate(${n(a)} ${n(cx)} ${n(cy)})"`;
}

function cellsMarkup(o, tr, T, kind) {
  const pal = palette(o);
  const side = o.side === 1 ? 1 : -1;
  const L = tr.len, seed = o.seed || 3;
  const want = { cuboidal: 1.0, columnar: 0.4, squamous: 3.6 }[kind] * T * (o.spacing || 1);
  const N = Math.max(1, Math.round(L / want));
  const W = L / N;
  const gap = Math.min(W * 0.05, T * 0.06, 1.4);
  const sw = Math.max(0.5, Math.min(W, T) * 0.035);
  const outer = mix(pal.cell, pal.edge, 0.4);
  let bodies = "", inners = "", gloss = "", nuclei = "", apical = "";
  const apicalKind = o.apical || "none";
  for (let i = 0; i < N; i++) {
    const s0 = i * W + gap / 2, s1 = (i + 1) * W - gap / 2, sm = (s0 + s1) / 2, w = s1 - s0;
    const j = (rand(seed, i) - 0.5) * 2; // −1..1
    let top, rTop, rBase, nh, nrx, nry, nc;
    if (kind === "squamous") {
      // flat cell with the nucleus bulging into the lumen
      const bw = w * 0.24, bh = T * 0.85;
      const bc = sm + j * w * 0.12;
      top = (s) => T + bh * Math.sqrt(Math.max(0, 1 - ((s - bc) / bw) ** 2)) ** 1.2;
      rTop = Math.min(T * 0.45, w * 0.1);
      rBase = Math.min(T * 0.2, w * 0.05);
      nh = T * 0.55 + bh * 0.42;
      nrx = bw * 0.82;
      nry = (T + bh) * 0.36;
      nc = bc;
    } else {
      const ht = T * (1 + (kind === "columnar" ? 0.05 : 0.035) * j);
      top = () => ht;
      rTop = Math.min(w * (kind === "columnar" ? 0.3 : 0.3), ht * 0.3);
      rBase = Math.min(w * 0.12, ht * 0.08);
      nh = kind === "columnar" ? ht * (0.34 + 0.04 * j) : ht * 0.5;
      nrx = kind === "columnar" ? w * 0.3 : w * 0.27;
      nry = kind === "columnar" ? ht * 0.16 : ht * 0.24;
      nc = sm + j * w * 0.05;
    }
    bodies += cellPath(tr, side, gap * 0.4, top, rBase, rTop, s0, s1);
    // a lighter cushion inside the darker rim, the way the shaded library cells are drawn
    const ins = Math.min(w, T) * 0.11;
    if (w > ins * 3) {
      const tIn = (s) => Math.max(gap * 0.4 + ins * 2, top(s) - ins);
      inners += cellPath(tr, side, gap * 0.4 + ins, tIn, Math.max(0, rBase - ins * 0.5), Math.max(0, rTop - ins * 0.6), s0 + ins, s1 - ins);
      if (kind !== "squamous" && T > 14) gloss += ellipseAt(tr, s0 + w * 0.3, top(s0 + w * 0.3) * 0.84, w * 0.13, Math.min(T * 0.06, w * 0.08), side) + `/>`;
    }
    // nucleus with a darker rim, a highlight and a nucleolus
    const hs = side;
    nuclei += ellipseAt(tr, nc, nh, nrx, nry, hs) + ` fill="${pal.nuc}" stroke="${shade(pal.nuc, 0.3)}" stroke-width="${n(sw * 0.9)}"/>`;
    if (Math.min(nrx, nry) > 2.5) {
      nuclei += ellipseAt(tr, nc - nrx * 0.22, nh + nry * 0.28, nrx * 0.48, nry * 0.42, hs) + ` fill="${lighten(pal.nuc, 0.38)}" opacity="0.6"/>`;
      const nr = Math.min(nrx, nry) * 0.22;
      nuclei += ellipseAt(tr, nc + nrx * 0.25, nh - nry * 0.12, nr, nr, hs) + ` fill="${shade(pal.nuc, 0.35)}"/>`;
    }
    // apical specialisations
    if (apicalKind !== "none" && kind !== "squamous") {
      const r0 = rTop * (apicalKind === "microvilli" ? 0.45 : 0.8);
      if (apicalKind === "microvilli") {
        const sp = Math.max(1.2, Math.min(w * 0.09, T * 0.03));
        for (let s = s0 + r0; s <= s1 - r0; s += sp) {
          const h = top(s);
          apical += `M${P(tr.off(s, side * (h - sw)))}L${P(tr.off(s, side * (h + T * 0.09)))}`;
        }
      } else if (apicalKind === "cilia") {
        const sp = Math.max(2, T * 0.06);
        let q = 0;
        for (let s = s0 + r0; s <= s1 - r0; s += sp, q++) {
          const h = top(s), len = T * (0.3 + 0.04 * Math.sin(q * 1.7 + i));
          const [, , tx, ty] = tr.at(s);
          const a = tr.off(s, side * (h - sw)), b = tr.off(s, side * (h + len));
          const bend = len * 0.28;
          const c = [(a[0] + b[0]) / 2 + tx * bend, (a[1] + b[1]) / 2 + ty * bend];
          const e = [b[0] + tx * bend * 0.9, b[1] + ty * bend * 0.9];
          apical += `M${P(a)}Q${P(c)} ${P(e)}`;
        }
      }
    }
  }
  let out = "";
  if (o.basement !== false) {
    const bm = [];
    const step = Math.max(1.5, L / 600);
    const bw = Math.max(0.9, T * (kind === "squamous" ? 0.12 : 0.05));
    for (let s = 0; s <= L + 1e-6; s += step) bm.push(tr.off(Math.min(s, L), -side * bw * 0.45));
    out += `<path d="${line(bm)}${o.closed ? "Z" : ""}" fill="none" stroke="${pal.bm}" stroke-width="${n(bw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (apical) {
    const aw = apicalKind === "cilia" ? Math.max(0.35, T * 0.016) : Math.max(0.5, T * 0.022);
    out += `<path d="${apical}" fill="none" stroke="${shade(pal.edge, 0.12)}" stroke-width="${n(aw)}" stroke-linecap="round"/>`;
  }
  out += `<path d="${bodies}" fill="${outer}" stroke="${pal.edge}" stroke-width="${n(sw)}" stroke-linejoin="round"/>`;
  if (inners) out += `<path d="${inners}" fill="${pal.cell}"/>`;
  if (gloss) out += `<g fill="${lighten(pal.cell, 0.6)}" opacity="0.6">${gloss}</g>`;
  return out + nuclei;
}

/* Actin: two twisted strands of globular monomers */

function actinMarkup(o, tr, T) {
  const pal = palette(o);
  const L = tr.len;
  const rb = T * 0.27;
  const d = rb * 1.75 * (o.spacing || 1);
  let half = d * 6.5;
  if (o.closed) half = L / Math.max(1, Math.round(L / half));
  const beads = [];
  for (let k = 0, s = rb; s <= L - rb * 0.5 || (o.closed && s < L); k++, s += d / 2) {
    const strand = k % 2 ? 1 : -1;
    const ph = (Math.PI * s) / half;
    const lat = strand * T * 0.21 * Math.cos(ph);
    const z = strand * Math.sin(ph);
    const [x, y] = tr.off(s, lat);
    beads.push({ x, y, z, c: strand > 0 ? pal.m1 : pal.m2 });
  }
  beads.sort((a, b) => a.z - b.z);
  const sw = rb * 0.12;
  let out = "";
  for (const b of beads) {
    const c = b.z < 0 ? shade(b.c, 0.18) : b.c;
    out += `<circle cx="${n(b.x)}" cy="${n(b.y)}" r="${n(rb)}" fill="${c}" stroke="${shade(b.c, 0.38)}" stroke-width="${n(sw)}"/>`;
    if (rb > 2.2) out += `<circle cx="${n(b.x - rb * 0.3)}" cy="${n(b.y - rb * 0.32)}" r="${n(rb * 0.34)}" fill="${lighten(b.c, 0.55)}" opacity="${b.z < 0 ? 0.35 : 0.7}"/>`;
  }
  return out;
}

/* Microtubule: a hollow tube of α/β-tubulin protofilaments */

function microtubuleMarkup(o, tr, T) {
  const pal = palette(o);
  const L = tr.len;
  const a = T * 0.2 * (o.spacing || 1); // one tubulin subunit along the tube
  const rows = [-0.375, -0.125, 0.125, 0.375];
  // the far wall, seen through the gaps
  const edge = [];
  const step = Math.max(1.5, L / 500);
  for (let s = 0; s <= L + 1e-6; s += step) edge.push(tr.pos(Math.min(s, L)));
  let out = `<path d="${line(edge)}${o.closed ? "Z" : ""}" fill="none" stroke="${shade(pal.b, 0.45)}" stroke-width="${n(T * 0.92)}" stroke-linecap="butt" stroke-linejoin="round"/>`;
  const by = { a: [], b: [] };
  rows.forEach((f, j) => {
    const persp = Math.sqrt(1 - (2 * f) ** 2 * 0.75);
    const ry = T * 0.122 * persp, rx = a * 0.47;
    const stagger = (j * a * 0.46) % (2 * a);
    for (let k = 0, s = stagger + a / 2; s < L - a * 0.3; k++, s += a) {
      by[k % 2 ? "b" : "a"].push(ellipseAt(tr, s, f * T, rx, ry, 1));
    }
  });
  for (const key of ["a", "b"]) {
    const c = pal[key];
    out += `<g fill="${c}" stroke="${shade(c, 0.32)}" stroke-width="${n(Math.max(0.3, T * 0.018))}">${by[key].map((e) => e + "/>").join("")}</g>`;
  }
  // a soft sheen along the top of the tube
  const hl = [];
  for (let s = 0; s <= L + 1e-6; s += step) hl.push(tr.off(Math.min(s, L), -T * 0.3));
  out += `<path d="${line(hl)}" fill="none" stroke="#ffffff" stroke-width="${n(T * 0.08)}" stroke-linecap="round" opacity="0.35"/>`;
  return out;
}

/* Collagen: a bundle of crimped, banded fibrils */

function collagenMarkup(o, tr, T) {
  const pal = palette(o);
  const L = tr.len;
  const per = T * 2.6, amp = T * 0.05;
  const offs = [-0.31, 0, 0.31];
  const wf = T * 0.34;
  const step = Math.max(0.8, T / 10);
  let out = "";
  offs.forEach((f, i) => {
    const pts = [];
    const crimp = (s) => f * T + amp * Math.sin((2 * Math.PI * s) / per + i * 1.9);
    for (let s = 0; s <= L + step * 0.5; s += step) pts.push(tr.off(Math.min(s, L), crimp(Math.min(s, L))));
    const d = line(pts);
    out += `<path d="${d}" fill="none" stroke="${pal.d}" stroke-width="${n(wf)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    out += `<path d="${d}" fill="none" stroke="${pal.f}" stroke-width="${n(wf * 0.78)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    // D-period banding
    const D = T * 0.42 * (o.spacing || 1);
    let bands = "";
    for (let s = D / 2 + i * D * 0.33; s < L - D * 0.3; s += D) {
      const c = crimp(s);
      bands += `M${P(tr.off(s, c - wf * 0.36))}L${P(tr.off(s, c + wf * 0.36))}`;
    }
    out += `<path d="${bands}" fill="none" stroke="${pal.d}" stroke-width="${n(Math.max(0.4, D * 0.2))}" opacity="0.75"/>`;
    const hl = pts.map(([x, y], k) => {
      const s = Math.min(k * step, L);
      return tr.off(s, crimp(s) - wf * 0.18);
    });
    out += `<path d="${line(hl)}" fill="none" stroke="${lighten(pal.f, 0.6)}" stroke-width="${n(wf * 0.18)}" stroke-linecap="round" opacity="0.7"/>`;
  });
  return out;
}

/* Path arrow: a smooth line with the same heads as straight arrows */

function arrowMarkup(o, tr, T) {
  const color = palette(o).line, L = tr.len;
  const s = headSize(T, o.headScale);
  const sh = tr.closed ? "none" : o.startHead || "none", eh = tr.closed ? "none" : o.endHead || "none";
  const tS = Math.min(s * (TRIM[sh] ?? 0), L * 0.45), tE = Math.min(s * (TRIM[eh] ?? 0), L * 0.45);
  // a head points along the chord under it, so it sits straight on a bend
  const dir = (a, b) => {
    const p = tr.pos(a), q = tr.pos(b), l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  };
  const d = tr.closed ? line(tr.p) + "Z" : line(subPath(tr, tS, L - tE));
  let out = strokePath(d, color, T, ` stroke-linecap="${o.dash ? "butt" : "round"}" stroke-linejoin="round"${o.dash ? ` stroke-dasharray="${dashArray(o.dash, T)}"` : ""}`);
  if (eh !== "none") out += head(eh, tr.pos(L), dir(Math.max(0, L - s * 0.8), L), s, color, T);
  if (sh !== "none") out += head(sh, tr.pos(0), dir(Math.min(L, s * 0.8), 0), s, color, T);
  return out;
}

/* Freeform shape: a closed smooth blob through the points */

function freeformMarkup(o, tr, T) {
  const fill = o.fill && o.fill !== "none" ? o.fill : "none";
  const fo = Math.max(0, Math.min(1, o.fillOpacity ?? 1));
  const line_ = o.stroke && o.stroke !== "none" && T > 0 ? o.stroke : null;
  let a = `fill="${fill}"${fill !== "none" && fo < 1 ? ` fill-opacity="${n(fo)}"` : ""}`;
  a += line_ ? ` stroke="${line_}" stroke-width="${n(T)}" stroke-linejoin="round"${o.dash ? ` stroke-dasharray="${dashArray(o.dash, T)}"` : ""}` : ` stroke="none"`;
  return `<path d="${line(tr.p)}Z" ${a}/>`;
}

/* Blood vessel: a tube with a muscular wall, a pale lumen and red blood cells flowing along it */

function vesselMarkup(o, tr, T) {
  const pal = palette(o), L = tr.len, seed = o.seed || 9;
  const d = line(tr.p) + (tr.closed ? "Z" : "");
  const e = Math.max(0.6, T * 0.04), lw = T * 0.6; // outer edge, lumen width
  const lin = ` stroke-linejoin="round"`;
  const tan = (s) => {
    const [, , tx, ty] = tr.at(s);
    return (Math.atan2(ty, tx) * 180) / Math.PI;
  };
  const ell = (s, rx, ry, extra) => {
    const [x, y] = tr.pos(s);
    return `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" transform="rotate(${n(tan(s))} ${n(x)} ${n(y)})" ${extra}/>`;
  };
  const capRx = T * 0.15;
  let out = "";
  // the far end shows the rounded outside of the tube
  if (!tr.closed) out += ell(L, capRx, T / 2, `fill="${pal.wall}" stroke="${pal.edge}" stroke-width="${n(e)}"`);
  out += strokePath(d, pal.edge, T, lin) + strokePath(d, pal.wall, T - 2 * e, lin);
  // circular smooth muscle: fine bands across the wall on both sides
  const band = Math.max(1.6, T * 0.16);
  let ring = "";
  for (let s = band / 2; s < L; s += band) {
    for (const side of [1, -1]) ring += `M${P(tr.off(s, side * (lw / 2 + T * 0.05)))}L${P(tr.off(s, side * (T / 2 - e * 1.6)))}`;
  }
  out += strokePath(ring, shade(pal.wall, 0.16), Math.max(0.3, T * 0.018), ` stroke-linecap="round" opacity="0.55"`);
  // endothelial lining, then the lumen
  out += strokePath(d, mix(pal.wall, pal.edge, 0.35), lw + Math.max(0.8, T * 0.05), lin);
  out += strokePath(d, pal.lumen, lw, lin);
  // a soft sheen along the upper wall
  out += strokePath(line(offPath(tr, 0, L, -T * 0.36, Math.max(1.5, L / 300))), lighten(pal.wall, 0.55), T * 0.05, ` stroke-linecap="round" opacity="0.6"`);
  // red blood cells: biconcave discs, some face-on, some tilted, drifting with the flow
  const r = T * 0.14;
  const step = T * 0.62 * (o.spacing || 1);
  let rbc = "";
  for (let k = 0, s = (tr.closed ? 0 : r * 1.4) + step * rand(seed, 999) * 0.5; s < L - (tr.closed ? 0 : r * 1.4); k++, s += step * (0.75 + 0.5 * rand(seed, k * 5))) {
    const lat = (rand(seed, k * 5 + 1) - 0.5) * 2 * (lw / 2 - r * 1.1);
    const [x, y] = tr.off(s, lat);
    const face = rand(seed, k * 5 + 2) < 0.55;
    const rx = r, ry = face ? r * 0.92 : r * (0.38 + 0.2 * rand(seed, k * 5 + 3));
    const a = tan(s) + (rand(seed, k * 5 + 4) - 0.5) * 50;
    const g = `transform="translate(${n(x)} ${n(y)}) rotate(${n(a)})"`;
    rbc += `<g ${g}><ellipse rx="${n(rx)}" ry="${n(ry)}" fill="${pal.rbc}" stroke="${shade(pal.rbc, 0.3)}" stroke-width="${n(r * 0.1)}"/>`;
    rbc += face
      ? `<ellipse rx="${n(rx * 0.48)}" ry="${n(ry * 0.48)}" fill="${shade(pal.rbc, 0.16)}"/><ellipse cx="${n(-rx * 0.32)}" cy="${n(-ry * 0.5)}" rx="${n(rx * 0.32)}" ry="${n(ry * 0.16)}" fill="${lighten(pal.rbc, 0.5)}" opacity="0.7"/>`
      : `<path d="M${n(-rx * 0.55)} 0L${n(rx * 0.55)} 0" stroke="${shade(pal.rbc, 0.2)}" stroke-width="${n(ry * 0.45)}" stroke-linecap="round"/>`;
    rbc += `</g>`;
  }
  out += rbc;
  // the near end: the cut face of the wall around a dark lumen
  if (!tr.closed) {
    out += ell(0, capRx, T / 2, `fill="${pal.wall}" stroke="${pal.edge}" stroke-width="${n(e)}"`);
    out += ell(0, capRx * 0.62, lw / 2, `fill="${shade(pal.rbc, 0.45)}" stroke="${mix(pal.wall, pal.edge, 0.35)}" stroke-width="${n(Math.max(0.4, T * 0.025))}"`);
  }
  return out;
}

/* Myelinated axon: an axon wrapped in myelin segments, bare at the nodes of Ranvier */

function axonMarkup(o, tr, T) {
  const pal = palette(o), L = tr.len;
  const d = line(tr.p) + (tr.closed ? "Z" : "");
  const aw = T * 0.36, e = Math.max(0.5, T * 0.05);
  let out = strokePath(d, shade(pal.axon, 0.3), aw + 2 * e, ` stroke-linecap="round" stroke-linejoin="round"`);
  out += strokePath(d, pal.axon, aw, ` stroke-linecap="round" stroke-linejoin="round"`);
  out += strokePath(line(offPath(tr, 0, L, -aw * 0.18, Math.max(1.5, L / 300))), lighten(pal.axon, 0.5), aw * 0.22, ` stroke-linecap="round" opacity="0.7"`);
  // internodes of equal length between short nodes; an open axon is bare at both ends
  const node = Math.max(1.5, T * 0.32);
  const want = T * 3.4 * (o.spacing || 1);
  const N = Math.max(1, Math.round((L - node) / (want + node)));
  const seg = tr.closed ? L / N - node : (L - node * (N + 1)) / N;
  if (seg <= 0.5) return out;
  let body = "", edge = "", lam = "", gloss = "";
  for (let i = 0; i < N; i++) {
    const s0 = (tr.closed ? node / 2 : node) + i * (seg + node), s1 = s0 + seg;
    // a capsule: a round-capped stroke whose caps end exactly at the segment ends
    const c0 = s0 + Math.min(T / 2, seg / 2), c1 = s1 - Math.min(T / 2, seg / 2);
    const sub = line(subPath(tr, c0, Math.max(c0 + 0.01, c1)));
    edge += sub;
    body += sub;
    if (c1 - c0 > T * 0.3) {
      const st = Math.max(1.2, (c1 - c0) / 60);
      for (const f of [-0.24, 0.24]) lam += line(offPath(tr, c0, c1, f * T, st));
      gloss += line(offPath(tr, c0 + T * 0.1, c1 - T * 0.1, -T * 0.3, st));
    }
  }
  const cap = ` stroke-linecap="round" stroke-linejoin="round"`;
  out += strokePath(edge, pal.sheath, T, cap) + strokePath(body, pal.myelin, T - 2 * e, cap);
  if (lam) out += strokePath(lam, mix(pal.myelin, pal.sheath, 0.4), Math.max(0.3, T * 0.025), ` stroke-linecap="round" opacity="0.8"`);
  if (gloss) out += strokePath(gloss, "#ffffff", T * 0.09, ` stroke-linecap="round" opacity="0.6"`);
  return out;
}

/* Any library icon, repeated along the path */

function iconRepeatMarkup(o, tr, T, icon) {
  const [vx, vy, vw, vh] = icon.vb;
  const sc = T / (vh || 1);
  const w = vw * sc;
  let step = (w + T * 0.12) * (o.spacing || 1);
  const L = tr.len;
  let count = o.closed ? Math.max(1, Math.round(L / step)) : Math.max(1, Math.floor((L + step * 0.25) / step));
  if (o.closed) step = L / count;
  const start = o.closed ? 0 : Math.max(0, (L - step * (count - 1)) / 2);
  const id = `${icon.prefix}tile`;
  const jit = o.jitter || 0, seed = o.seed || 5;
  const follow = o.follow !== false;
  const side = o.side === 1 ? 1 : -1;
  let uses = "";
  for (let k = 0; k < count; k++) {
    const s = start + k * step;
    const [x, y, tx, ty] = tr.at(s);
    const lat = jit ? (rand(seed, k * 3) - 0.5) * T * 0.6 * jit : 0;
    const px = x - ty * lat, py = y + tx * lat;
    let ang = follow ? (Math.atan2(ty, tx) * 180) / Math.PI + (side > 0 ? 180 : 0) : 0;
    if (jit) ang += (rand(seed, k * 3 + 1) - 0.5) * 50 * jit;
    const s2 = sc * (jit ? 1 + (rand(seed, k * 3 + 2) - 0.5) * 0.3 * jit : 1);
    uses += `<use xlink:href="#${id}" transform="translate(${n(px)} ${n(py)}) rotate(${n(ang)}) scale(${n(s2)})"/>`;
  }
  return `<defs><g id="${id}" transform="translate(${n(-vx - vw / 2)} ${n(-vy - vh / 2)})">${icon.inner}</g></defs>${uses}`;
}
