// Geometry helpers for icon recipes. Everything returns SVG path data ("d") or point lists.
// Coordinates are in a 200 × 200 design space unless a recipe says otherwise.

export const f = (v) => {
  const s = (Math.round(v * 100) / 100).toString();
  return s === "-0" ? "0" : s;
};

/** Deterministic random numbers (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const K = 0.5522847498;

export function ellipse(cx, cy, rx, ry = rx, rot = 0) {
  if (!rot) {
    return `M${f(cx + rx)} ${f(cy)}C${f(cx + rx)} ${f(cy + ry * K)} ${f(cx + rx * K)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}` +
      `C${f(cx - rx * K)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * K)} ${f(cx - rx)} ${f(cy)}` +
      `C${f(cx - rx)} ${f(cy - ry * K)} ${f(cx - rx * K)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}` +
      `C${f(cx + rx * K)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * K)} ${f(cx + rx)} ${f(cy)}Z`;
  }
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push(rotate([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry], cx, cy, rot));
  }
  return smoothClosed(pts);
}
export const circle = (cx, cy, r) => ellipse(cx, cy, r, r);

export function rect(x, y, w, h, r = 0) {
  r = Math.min(r, w / 2, h / 2);
  if (!r) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  const k = r * (1 - K);
  return `M${f(x + r)} ${f(y)}H${f(x + w - r)}C${f(x + w - k)} ${f(y)} ${f(x + w)} ${f(y + k)} ${f(x + w)} ${f(y + r)}` +
    `V${f(y + h - r)}C${f(x + w)} ${f(y + h - k)} ${f(x + w - k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}` +
    `H${f(x + r)}C${f(x + k)} ${f(y + h)} ${f(x)} ${f(y + h - k)} ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}C${f(x)} ${f(y + k)} ${f(x + k)} ${f(y)} ${f(x + r)} ${f(y)}Z`;
}

export function polygon(pts) {
  return "M" + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L") + "Z";
}
export function polyline(pts) {
  return "M" + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L");
}

export function rotate([x, y], cx, cy, deg) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
}
export const rotatePts = (pts, cx, cy, deg) => pts.map((p) => rotate(p, cx, cy, deg));
export const movePts = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);
export const scalePts = (pts, sx, sy, cx = 0, cy = 0) => pts.map(([x, y]) => [cx + (x - cx) * sx, cy + (y - cy) * (sy ?? sx)]);

/** Closed smooth curve through points (Catmull–Rom → cubic Bézier). tension 0..1 (1 = round). */
export function smoothClosed(pts, tension = 1) {
  const n = pts.length;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const t = tension / 6;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

/** Open smooth curve through points. */
export function smoothOpen(pts, tension = 1) {
  const n = pts.length;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    const t = tension / 6;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/** Points around an ellipse with radial jitter — the outline of a cell, nucleus or blob. */
export function blobPts(cx, cy, rx, ry, { n = 9, wobble = 0.07, seed = 1, rot = 0, phase = 0 } = {}) {
  const r = rng(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + phase) / n) * Math.PI * 2;
    const k = 1 + (r() * 2 - 1) * wobble;
    pts.push(rotate([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k], cx, cy, rot));
  }
  return pts;
}
export const blob = (cx, cy, rx, ry, o = {}) => smoothClosed(blobPts(cx, cy, rx, ry, o), o.tension ?? 1);

/**
 * Outline with protrusions (pseudopods, dendrites, ruffles): `arms` bumps of relative length
 * `reach`, each `width` (fraction of the gap between arms) wide.
 */
export function armsPts(cx, cy, r, { arms = 6, reach = 0.5, width = 0.45, seed = 3, jitter = 0.25, n = 6, rot = 0 } = {}) {
  const R = rng(seed);
  const pts = [];
  for (let i = 0; i < arms; i++) {
    const a0 = (i / arms) * Math.PI * 2 + (rot * Math.PI) / 180 + (R() - 0.5) * jitter;
    const len = r * (1 + reach * (0.6 + R() * 0.8));
    const span = ((Math.PI * 2) / arms) * width * (0.7 + R() * 0.6);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      // gap between arms → base of the arm → tip → base
      const a = a0 + (t - 0.5) * ((Math.PI * 2) / arms);
      const inArm = Math.abs(a - a0) < span / 2;
      const rad = inArm ? r + (len - r) * Math.cos(((a - a0) / span) * Math.PI) : r * (0.94 + R() * 0.08);
      pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
  }
  return pts;
}

/** Evenly spaced points inside an ellipse (for granules, vesicles, dots). */
export function scatter(cx, cy, rx, ry, count, { seed = 7, minDist = 0, avoid = [] } = {}) {
  const r = rng(seed);
  const out = [];
  let tries = 0;
  while (out.length < count && tries++ < count * 200) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r());
    const p = [cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d];
    if (out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < minDist)) continue;
    if (avoid.some(([ax, ay, ar]) => Math.hypot(ax - p[0], ay - p[1]) < ar)) continue;
    out.push(p);
  }
  return out;
}

/** A capsule (rounded rod) from (x1,y1) to (x2,y2) with radius r — bacilli, tubes, chromatids. */
export function capsule(x1, y1, x2, y2, r) {
  const a = Math.atan2(y2 - y1, x2 - x1), nx = -Math.sin(a) * r, ny = Math.cos(a) * r;
  const tx = Math.cos(a) * r * K, ty = Math.sin(a) * r * K;
  const ex = Math.cos(a) * r, ey = Math.sin(a) * r;
  return `M${f(x1 + nx)} ${f(y1 + ny)}L${f(x2 + nx)} ${f(y2 + ny)}` +
    `C${f(x2 + nx + tx)} ${f(y2 + ny + ty)} ${f(x2 + ex + nx * K)} ${f(y2 + ey + ny * K)} ${f(x2 + ex)} ${f(y2 + ey)}` +
    `C${f(x2 + ex - nx * K)} ${f(y2 + ey - ny * K)} ${f(x2 - nx + tx)} ${f(y2 - ny + ty)} ${f(x2 - nx)} ${f(y2 - ny)}` +
    `L${f(x1 - nx)} ${f(y1 - ny)}` +
    `C${f(x1 - nx - tx)} ${f(y1 - ny - ty)} ${f(x1 - ex - nx * K)} ${f(y1 - ey - ny * K)} ${f(x1 - ex)} ${f(y1 - ey)}` +
    `C${f(x1 - ex + nx * K)} ${f(y1 - ey + ny * K)} ${f(x1 + nx - tx)} ${f(y1 + ny - ty)} ${f(x1 + nx)} ${f(y1 + ny)}Z`;
}

/** A thick band along a smooth open curve (ribbons, ER sheets, tails), closed as an outline. */
export function ribbon(pts, width, { taper = 0 } = {}) {
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const t = pts.length > 1 ? i / (pts.length - 1) : 0;
    const w = (width / 2) * (1 - taper * Math.abs(t - 0.5) * 2);
    left.push([p[0] - (dy / l) * w, p[1] + (dx / l) * w]);
    right.push([p[0] + (dy / l) * w, p[1] - (dx / l) * w]);
  }
  return smoothOpen(left) + "L" + smoothOpen(right.reverse()).slice(1) + "Z";
}

/** Points along a sine wave (DNA strands, membranes, filaments). */
export function wavePts(x1, y1, x2, y2, { amp = 10, waves = 2, phase = 0, n = 40 } = {}) {
  const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy), nx = -dy / l, ny = dx / l;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, s = Math.sin(t * waves * Math.PI * 2 + phase) * amp;
    out.push([x1 + dx * t + nx * s, y1 + dy * t + ny * s]);
  }
  return out;
}
