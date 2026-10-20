// Helpers against the two defects reviewers find most often in recipe art:
//   1. containment — nuclei, tangles, gloss, bands spilling outside the shape that should hold them,
//      or shapes poking out of the frame because only their centre was checked;
//   2. mechanical repetition — evenly spaced clones, perfect rings and chains, cog-wheel outlines.
// See .claude/skills/biocraft-illustration/SKILL.md. Everything is deterministic (pass rng(seed)).

/* ---------- path geometry ---------- */

/**
 * Flatten absolute path data (M L H V C Q Z, the commands geom.mjs / tissue.mjs write) into one
 * polygon per subpath. Curves are sampled `per` times.
 */
export function flatten(d, per = 10) {
  const polys = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0;
  const toks = String(d).match(/[MLHVCQZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
  let cmd = "M";
  for (let i = 0; i < toks.length; ) {
    if (/[a-z]/i.test(toks[i])) {
      cmd = toks[i++];
      if (/[a-z]/.test(cmd)) throw new Error(`flatten(): relative command "${cmd}" — use absolute path data`);
      if (cmd === "Z") {
        if (cur) cur.closed = true;
        x = sx;
        y = sy;
        continue;
      }
    }
    const take = (k) => toks.slice(i, (i += k)).map(Number);
    if (cmd === "M") {
      [x, y] = take(2);
      sx = x;
      sy = y;
      cur = [[x, y]];
      polys.push(cur);
      cmd = "L"; // further pairs are implicit lineto
    } else if (cmd === "L") {
      [x, y] = take(2);
      cur.push([x, y]);
    } else if (cmd === "H") {
      [x] = take(1);
      cur.push([x, y]);
    } else if (cmd === "V") {
      [y] = take(1);
      cur.push([x, y]);
    } else if (cmd === "C") {
      const [a, b, c, e, fx, fy] = take(6);
      for (let k = 1; k <= per; k++) {
        const t = k / per, u = 1 - t;
        cur.push([u * u * u * x + 3 * u * u * t * a + 3 * u * t * t * c + t * t * t * fx, u * u * u * y + 3 * u * u * t * b + 3 * u * t * t * e + t * t * t * fy]);
      }
      [x, y] = [fx, fy];
    } else if (cmd === "Q") {
      const [a, b, fx, fy] = take(4);
      for (let k = 1; k <= per; k++) {
        const t = k / per, u = 1 - t;
        cur.push([u * u * x + 2 * u * t * a + t * t * fx, u * u * y + 2 * u * t * b + t * t * fy]);
      }
      [x, y] = [fx, fy];
    } else i++;
  }
  return polys.filter((p) => p.length > 1);
}

/** Even-odd point-in-shape test over all subpaths (holes count as outside). */
export function insideShape(polys, [px, py]) {
  let c = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** Distance from a point to the nearest edge of any subpath. */
export function edgeDistance(polys, [px, py]) {
  let best = Infinity;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      best = Math.min(best, Math.hypot(px - ax - dx * t, py - ay - dy * t));
    }
  }
  return best;
}

/**
 * Does `inner` (path data or point list) lie inside `outer` with at least `margin` clearance?
 * → {ok, outside: points that break the rule, worst: deepest violation in units}
 */
export function checkInside(inner, outer, margin = 0) {
  const ip = typeof inner === "string" ? flatten(inner).flat() : inner;
  const op = typeof outer === "string" ? flatten(outer) : [outer];
  const outside = [];
  let worst = 0;
  for (const p of ip) {
    const inShape = insideShape(op, p);
    const d = edgeDistance(op, p);
    const v = inShape ? margin - d : margin + d;
    if (v > 1e-6) {
      outside.push(p);
      worst = Math.max(worst, v);
    }
  }
  return { ok: !outside.length, outside, worst };
}

/** checkInside that warns on the console (use while developing a recipe; the build output shows it). */
export function assertInside(label, inner, outer, margin = 0) {
  const r = checkInside(inner, outer, margin);
  if (!r.ok) console.warn(`  ! containment: ${label} — ${r.outside.length} point(s) outside, worst ${r.worst.toFixed(2)} units`);
  return r.ok;
}

/** Is the whole shape (not just its centre) inside the art box [x, y, w, h] with `margin`? */
export function inFrame(shape, [x, y, w, h], margin = 4) {
  const pts = typeof shape === "string" ? flatten(shape).flat() : shape;
  return pts.every(([px, py]) => px >= x + margin && px <= x + w - margin && py >= y + margin && py <= y + h - margin);
}

const centroidOf = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);

/**
 * Shrink a point list (e.g. a nucleus outline) toward its own centroid — and pull the centroid toward the
 * container's — until it fits inside `outerPoly` with `margin`. Returns the fitted points (or null if it
 * cannot fit above `minScale`).
 */
export function fitInside(pts, outerPoly, margin = 1, minScale = 0.3) {
  const c = centroidOf(pts), oc = centroidOf(outerPoly);
  for (let s = 1; s >= minScale; s -= 0.04) {
    for (const pull of [0, 0.25, 0.5]) {
      const cx = c[0] + (oc[0] - c[0]) * pull, cy = c[1] + (oc[1] - c[1]) * pull;
      const cand = pts.map(([x, y]) => [cx + (x - c[0]) * s, cy + (y - c[1]) * s]);
      if (checkInside(cand, outerPoly, margin).ok) return cand;
    }
  }
  return null;
}

/* ---------- organic variation ---------- */

/** v varied by ±frac (uniform), e.g. vary(R, 12, 0.25) → 9..15. */
export const vary = (R, v, frac) => v * (1 + (R() * 2 - 1) * frac);

/** Pick from an array. */
export const pick = (R, arr) => arr[Math.floor(R() * arr.length)];

/**
 * n positions along [0, total] with uneven gaps (coefficient of variation ≈ cv) — for cells along a
 * membrane, receptors on a surface, sulci along a cortex, bases along a strand that should not tick
 * like a ruler.
 */
export function unevenSpacing(n, total, R, { cv = 0.35, start = 0, end = total } = {}) {
  const gaps = Array.from({ length: n + 1 }, () => Math.max(0.15, 1 + (R() * 2 - 1) * cv * 1.7));
  const sum = gaps.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += gaps[i];
    out.push(start + ((end - start) * acc) / sum);
  }
  return out;
}

/** n angles (degrees) round a circle with uneven gaps — never "exactly 120° apart". */
export function unevenAngles(n, R, { cv = 0.35, start = R() * 360 } = {}) {
  return unevenSpacing(n, 360, R, { cv }).map((a) => (start + a) % 360);
}

/**
 * Points in clusters (immune infiltrates, granules, plaques): `clusters` seeds placed by `test`, members
 * scattered round each with a density that falls off from the cluster core. `test(p)` must accept a point.
 */
export function clustered(R, box, count, { clusters = 3, spread = 0.15, minDist = 0, test = () => true, tries = 4000 } = {}) {
  const seeds = [];
  for (let t = 0; seeds.length < clusters && t < tries; t++) {
    const p = [box.x + R() * box.w, box.y + R() * box.h];
    if (test(p)) seeds.push({ p, w: 0.5 + R() });
  }
  if (!seeds.length) return [];
  const total = seeds.reduce((a, s) => a + s.w, 0);
  const out = [];
  const rad = Math.min(box.w, box.h) * spread;
  for (let t = 0; out.length < count && t < tries * 4; t++) {
    let r = R() * total, s = seeds[0];
    for (const c of seeds) if ((r -= c.w) <= 0) { s = c; break; }
    // gaussian-ish radius: dense core, sparse edge
    const a = R() * Math.PI * 2, d = rad * Math.sqrt(-2 * Math.log(Math.max(1e-6, R()))) * 0.6;
    const p = [s.p[0] + Math.cos(a) * d, s.p[1] + Math.sin(a) * d];
    if (p[0] < box.x || p[1] < box.y || p[0] > box.x + box.w || p[1] > box.y + box.h || !test(p)) continue;
    if (minDist && out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < minDist)) continue;
    out.push(p);
  }
  return out;
}

/**
 * Per-instance variation for repeated objects (cells in a field, microglia round a plaque): returns
 * `n` parameter sets {scale, rot, seed, variant} that are never clones of each other.
 */
export function instances(R, n, { scale = 0.18, rotJitter = 40, variants = 3 } = {}) {
  const used = new Set();
  return Array.from({ length: n }, (_, i) => {
    let variant = Math.floor(R() * variants);
    if (used.size < variants) while (used.has(variant)) variant = (variant + 1) % variants;
    used.add(variant);
    return { scale: vary(R, 1, scale), rot: (R() * 2 - 1) * rotJitter, seed: 1000 + Math.floor(R() * 1e6) + i, variant };
  });
}
