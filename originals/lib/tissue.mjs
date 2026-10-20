// Building blocks for histology-style tissue sections (Servier look): cell layers that follow a
// curved surface, fat honeycomb, vessels with blood cells, fibroblasts, collagen fibres and
// immune-cell infiltrates. Everything returns plain path data or point lists; many small
// shapes of one colour are joined into one compound path so they cost a single draw call.

import { f, rng, ellipse, circle, smoothClosed, smoothOpen } from "./geom.mjs";

/* ---------- curves ---------- */

/** Dense polyline through key points (Catmull–Rom). */
export function catmull(pts, per = 10, closed = false) {
  const n = pts.length, out = [];
  const P = closed ? [pts[n - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[n - 1]];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [P[i], P[i + 1], P[i + 2], P[i + 3]];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const c = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

/** Points every `step` along a polyline. */
export function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let seg = Math.hypot(bx - ax, by - ay);
    while (carry + seg >= step && seg > 0) {
      const t = (step - carry) / seg;
      ax += (bx - ax) * t;
      ay += (by - ay) * t;
      out.push([ax, ay]);
      seg = Math.hypot(bx - ax, by - ay);
      carry = 0;
    }
    carry += seg;
  }
  const last = pts[pts.length - 1], end = out[out.length - 1];
  if (Math.hypot(last[0] - end[0], last[1] - end[1]) > step * 0.35) out.push(last);
  return out;
}

/** Unit normals pointing to the left of the direction of travel (into tissue for a surface drawn left→right with tissue below). */
export function normals(pts) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  });
}

export function offsetPts(pts, d) {
  const ns = normals(pts);
  return pts.map((p, i) => [p[0] + ns[i][0] * d, p[1] + ns[i][1] * d]);
}

/** Offset a closed outline by d (positive = outward), whatever its winding. */
export function offsetClosed(pts, d) {
  const n = pts.length;
  const sgn = signedArea(pts) > 0 ? 1 : -1;
  return pts.map((p, i) => {
    const a = pts[(i - 2 + n) % n], b = pts[(i + 2) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    // for positive (clockwise on screen) winding the right-hand normal points outward
    return [p[0] + (dy / l) * d * sgn, p[1] - (dx / l) * d * sgn];
  });
}
export const signedArea = (poly) => poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

/** A strip `t(u)` thick laid along a polyline on its left (u = 0..1 along the line). */
export function strip(line, t) {
  const ns = normals(line);
  const n = line.length;
  const far = line.map((p, i) => {
    const th = typeof t === "function" ? t(i / (n - 1)) : t;
    return [p[0] + ns[i][0] * th, p[1] + ns[i][1] * th];
  });
  return [...line, ...far.reverse()];
}

/** Shrink a polygon toward its centroid (pores of spongy bone, cell interiors). */
export const shrink = (poly, k) => {
  const [cx, cy] = centroid(poly);
  return poly.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
};

export function arcLengths(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return s;
}

/* ---------- polygons ---------- */

/** Polygon → path with softly rounded corners (r = corner cut length). */
export function roundPoly(pts, r = 2) {
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1, lb = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    const ra = Math.min(r, la / 2), rb = Math.min(r, lb / 2);
    const p1 = [p[0] + ((a[0] - p[0]) / la) * ra, p[1] + ((a[1] - p[1]) / la) * ra];
    const p2 = [p[0] + ((b[0] - p[0]) / lb) * rb, p[1] + ((b[1] - p[1]) / lb) * rb];
    d += `${i ? "L" : "M"}${f(p1[0])} ${f(p1[1])}Q${f(p[0])} ${f(p[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

/** Clip a polygon to a convex polygon (Sutherland–Hodgman). */
export function clipConvex(poly, clip) {
  let out = poly;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const cross = (p, q) => {
      const x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1], x3 = p[0], y3 = p[1], x4 = q[0], y4 = q[1];
      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4) || 1e-9;
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(cross(p, q));
    }
  }
  return out;
}
export const rectPoly = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
export const area = (poly) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
export const centroid = (poly) => poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);

/* ---------- layers of cells ---------- */

/**
 * Cells packed in `rows` along a surface polyline (lining, epithelium), brick-staggered,
 * extending `thickness` into the tissue. Returns [{poly, row, nucleus:{cx,cy,rx,ry,rot}, i}].
 */
export function cellBand(surface, { rows = 2, thickness = 20, cellLen = 16, jitter = 0.3, seed = 1, nucleus = 0.32 } = {}) {
  const R = rng(seed);
  const s = arcLengths(surface);
  // thickness may vary along the surface (u = 0..1): rete ridges, crypt bases, hyperplasia
  const T = typeof thickness === "function" ? s.map((v) => thickness(v / s[s.length - 1])) : s.map(() => thickness);
  const ns = normals(surface);
  const curves = [];
  for (let r = 0; r <= rows; r++) curves.push(surface.map((p, i) => [p[0] + ns[i][0] * ((T[i] * r) / rows), p[1] + ns[i][1] * ((T[i] * r) / rows)]));
  thickness = T.reduce((a, b) => a + b, 0) / T.length;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const top = curves[r], bot = curves[r + 1];
    // space cells by this row's own length, so deep rows get fewer cells where the surface
    // curves around a villus tip (and more in the valleys) instead of piling up
    const mid = top.map((p, i) => [(p[0] + bot[i][0]) / 2, (p[1] + bot[i][1]) / 2]);
    const sr = arcLengths(mid), total = sr[sr.length - 1];
    const idxAt = (len) => {
      let i = 0;
      while (i < sr.length - 1 && sr[i + 1] <= len) i++;
      return i;
    };
    const bounds = [0];
    let pos = cellLen * ((r % 2 ? 0.5 : 0.9) + R() * 0.3);
    while (pos < total - cellLen * 0.45) {
      const i = idxAt(pos);
      if (i > bounds[bounds.length - 1]) bounds.push(i);
      pos += cellLen * (1 + (R() - 0.5) * 2 * jitter);
    }
    if (bounds[bounds.length - 1] !== surface.length - 1) bounds.push(surface.length - 1);
    for (let k = 0; k < bounds.length - 1; k++) {
      const i0 = bounds[k], i1 = bounds[k + 1];
      const poly = [...top.slice(i0, i1 + 1), ...bot.slice(i0, i1 + 1).reverse()];
      const im = Math.round((i0 + i1) / 2);
      const th = thickness / rows, len = sr[i1] - sr[i0];
      const ang = (Math.atan2(surface[i1][1] - surface[i0][1], surface[i1][0] - surface[i0][0]) * 180) / Math.PI;
      const cx = (top[im][0] + bot[im][0]) / 2, cy = (top[im][1] + bot[im][1]) / 2;
      cells.push({
        poly, row: r, i: cells.length,
        nucleus: { cx: cx + (R() - 0.5) * 1.5, cy: cy + (R() - 0.5) * 1.5, rx: Math.max(1.6, Math.min(len * nucleus, th * 0.42)), ry: Math.max(1.4, th * 0.3), rot: ang },
      });
    }
  }
  return cells;
}

/** Jittered hexagonal tiling over a rectangle (fat cells, packed polygonal cells). */
export function honeycomb(x0, y0, w, h, size, { jitter = 0.28, seed = 3 } = {}) {
  const R = rng(seed);
  const dx = size * Math.sqrt(3), dy = size * 1.5;
  const jit = new Map();
  const J = (x, y) => {
    const k = `${Math.round(x * 10)},${Math.round(y * 10)}`;
    if (!jit.has(k)) jit.set(k, [x + (R() - 0.5) * size * jitter * 2, y + (R() - 0.5) * size * jitter * 2]);
    return jit.get(k);
  };
  const cells = [];
  for (let row = -1; row * dy < h + size * 2; row++) {
    for (let col = -1; col * dx < w + size * 2; col++) {
      const cx = x0 + col * dx + (Math.abs(row) % 2 ? dx / 2 : 0), cy = y0 + row * dy;
      const poly = [];
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (60 * k - 30);
        poly.push(J(cx + size * Math.cos(a), cy + size * Math.sin(a)));
      }
      cells.push({ cx, cy, poly });
    }
  }
  return cells;
}

/* ---------- small structures ---------- */

/** A spindle-shaped cell (fibroblast/smooth muscle) centred at (cx,cy), long axis at `deg`. */
export function spindle(cx, cy, len, wid, deg = 0, { bend = 0, tail = 0.2 } = {}) {
  const pts = [];
  const n = 9;
  const half = (t) => Math.pow(Math.sin(Math.PI * t), 0.75) * (wid / 2) * (1 - tail * Math.abs(t - 0.5) * 2);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([(t - 0.5) * len, -half(t) + bend * Math.sin(Math.PI * t) * wid]);
  }
  for (let i = n - 1; i >= 1; i--) {
    const t = i / n;
    pts.push([(t - 0.5) * len, half(t) + bend * Math.sin(Math.PI * t) * wid]);
  }
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return smoothClosed(pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]), 0.8);
}

/** Gently wavy fibre between two points. */
export function fibre(x0, y0, x1, y1, { amp = 2.5, waves = 2, phase = 0 } = {}) {
  const pts = [];
  const n = 10, dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n, w = Math.sin(t * waves * Math.PI * 2 + phase) * amp;
    pts.push([x0 + dx * t - (dy / l) * w, y0 + dy * t + (dx / l) * w]);
  }
  return smoothOpen(pts);
}

/** Red blood cell seen edge-on or face-on (small ellipse). */
export const rbc = (cx, cy, r, rot = 0) => ellipse(cx, cy, r, r * 0.78, rot);

/** Kidney/lobed nucleus for small immune cells. */
export function lobes(cx, cy, r, n = 3, rot = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ((rot + (i - (n - 1) / 2) * 70) * Math.PI) / 180;
    out.push(circle(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, r * 0.42));
  }
  return out;
}

/** Points with a minimum spacing inside an ellipse, avoiding discs [[x,y,r]…]. */
export function packIn(cx, cy, rx, ry, count, minDist, { seed = 5, avoid = [], tries = 400 } = {}) {
  const R = rng(seed);
  const out = [];
  let t = 0;
  while (out.length < count && t++ < count * tries) {
    const a = R() * Math.PI * 2, d = Math.sqrt(R());
    const p = [cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d];
    if (out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < minDist)) continue;
    if (avoid.some(([x, y, r]) => Math.hypot(x - p[0], y - p[1]) < r)) continue;
    out.push(p);
  }
  return out;
}

/** Points inside an arbitrary test region. */
export function packWhere(box, count, minDist, test, { seed = 5, tries = 600 } = {}) {
  const R = rng(seed);
  const out = [];
  let t = 0;
  while (out.length < count && t++ < count * tries) {
    const p = [box.x + R() * box.w, box.y + R() * box.h];
    if (!test(p)) continue;
    if (out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < minDist)) continue;
    out.push(p);
  }
  return out;
}

/** Point-in-polygon. */
export function inside(poly, [x, y]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export const join = (ds) => ds.filter(Boolean).join("");
export const polyD = (pts) => "M" + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L") + "Z";
export const lineD = (pts) => "M" + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L");
