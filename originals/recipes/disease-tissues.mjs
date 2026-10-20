// More organ tissues in healthy and disease states (Servier-style histology): renal cortex round a
// glomerulus (healthy vs crescentic glomerulonephritis) and the bronchial wall (healthy vs asthma).
// Pairs share their framing.
//
// KIDNEY (280 × 250). Plan, bottom → top: interstitium → peritubular capillaries → tubules (basement
// membrane, one ring of epithelium with basal nuclei, lumen; proximal with brush border, distal paler)
// → (GN) fibrosis and infiltrate → Bowman's capsule (parietal cells) → arterioles → crescent → tuft.
//   Tubules are a ray-cast partition of the cortex (densely packed profiles of uneven shape, thin
//   interstitium, capillaries at the junctions). Vascular pole upper left: afferent arteriole (thick
//   media, renin granules) from the left edge and efferent arteriole leaving through the top, both
//   passing through the capsule into the tuft hilum; the macula densa (crowded nuclei) of a distal
//   tubule sits between them. GN: crescent, hypercellular tuft with neutrophils, injured tubules,
//   RBC and protein casts, periglomerular and interstitial fibrosis and inflammation.
// BRONCHUS (320 × 240): pseudostratified ciliated epithelium with goblet and basal cells, basement
//   membrane, lamina propria, smooth muscle in bundles, submucosal glands, cartilage plate. Asthma:
//   folded mucosa, goblet hyperplasia, thick BM, hypertrophied muscle, eosinophils and mast cells, and a
//   laminated mucus plug resting on the cilia with eosinophils and Creola bodies.
import { circle, ellipse, capsule, blob, blobPts, ribbon, rng, smoothClosed, smoothOpen, armsPts } from "../lib/geom.mjs";
import { shade } from "../lib/style.mjs";
import { catmull, resample, normals, offsetClosed, area, arcLengths, cellBand, roundPoly, spindle, fibre, rbc, packIn, packWhere, inside, polyD, lineD, lobes } from "../lib/tissue.mjs";
import { checkInside, fitInside, edgeDistance, unevenSpacing, clustered, vary } from "../lib/organic.mjs";
import { C, Layers, sw, defineLayers, vessel, capillaryAlong, lymphocyte, plasmaCell, macrophage, neutrophil, mastCell } from "../lib/histo.mjs";

/** Define a subset of the standard histology layers (vessels, immune cells…) at this point in the stack. */
function std(L, keys) {
  const t = new Layers();
  defineLayers(t, C.matrix);
  for (const k of keys) {
    const { ds, ...st } = t.map.get(k);
    L.def(k, st);
  }
}
const BLOOD = ["wall", "lumen", "rbc", "endo"];
const IMMUNE = ["tcell", "tnuc", "bcell", "bnuc", "plasma", "plasmaNuc", "mac", "macNuc", "neut", "neutNuc"];

/**
 * Clip a scene to its axis-aligned frame by clamping every coordinate into [x0, x1] × [y0, y1]: the parts of a
 * shape beyond the frame collapse onto the frame edge (a straight cut), so nothing pokes out of the art box.
 */
function clampD(d, [x0, y0, x1, y1]) {
  let cmd = "M", idx = 0;
  return d.replace(/([MLHVCQZ])|(-?\d*\.?\d+(?:e-?\d+)?)/gi, (tok, c, num) => {
    if (c) {
      cmd = c.toUpperCase();
      idx = 0;
      return c;
    }
    const isX = cmd === "H" ? true : cmd === "V" ? false : idx % 2 === 0;
    idx++;
    const v = isX ? Math.min(x1, Math.max(x0, Number(num))) : Math.min(y1, Math.max(y0, Number(num)));
    return (Math.round(v * 100) / 100).toString();
  });
}
function clampScene(scene, box) {
  scene.parts = scene.parts.map((p) => ({
    ...p,
    ...(p.d ? { d: Array.isArray(p.d) ? p.d.map((x) => clampD(x, box)) : clampD(p.d, box) } : {}),
    ...(p.unite ? { unite: p.unite.map((x) => clampD(x, box)) } : {}),
  }));
  return scene;
}

/** Points round an oval (dir −1 runs the other way so cellBand grows cells inward). */
function ovalPts(cx, cy, rx, ry, { rot = 0, n = 90, dir = 1, wobble = 0, seed = 1 } = {}) {
  const R = rng(seed);
  const waves = [R() * 6, R() * 6, R() * 6];
  const r0 = (rot * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => {
    const a = (dir * i * Math.PI * 2) / n;
    const k = 1 + wobble * (Math.sin(a * 2 + waves[0]) * 0.5 + Math.sin(a * 3 + waves[1]) * 0.35 + Math.sin(a * 5 + waves[2]) * 0.15);
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    return [cx + x * Math.cos(r0) - y * Math.sin(r0), cy + x * Math.sin(r0) + y * Math.cos(r0)];
  });
}
const ring = (pts) => lineD([...pts, pts[0]]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
};

/* ===================== kidney: renal cortex around a glomerulus ===================== */

/**
 * Cells by ray casting from each site (a Voronoi partition, mildly weighted so walls curve a little),
 * stopped by obstacle discs [x, y, r] and the frame. Returns per-site polygons and, per boundary point,
 * the neighbour that bounds it (-1 frame, -2 obstacle).
 */
function rayCells(sites, w, [bx, by, bw, bh], obstacles = [], nRays = 96) {
  const cells = [], owners = [];
  sites.forEach((s, i) => {
    const poly = [], own = [];
    for (let k = 0; k < nRays; k++) {
      const a = (k / nRays) * Math.PI * 2, u = [Math.cos(a), Math.sin(a)];
      let best = Infinity, who = -1;
      if (Math.abs(u[0]) > 1e-9) best = Math.min(best, (u[0] > 0 ? bx + bw - s[0] : s[0] - bx) / Math.abs(u[0]));
      if (Math.abs(u[1]) > 1e-9) best = Math.min(best, (u[1] > 0 ? by + bh - s[1] : s[1] - by) / Math.abs(u[1]));
      for (let j = 0; j < sites.length; j++) {
        if (j === i) continue;
        const dx = s[0] - sites[j][0], dy = s[1] - sites[j][1], c = dx * dx + dy * dy;
        if (c > 140 * 140) continue;
        const b = u[0] * dx + u[1] * dy, kk = (w[j] * w[j]) / (w[i] * w[i]);
        let r = Infinity;
        if (Math.abs(kk - 1) < 1e-6) {
          if (b < 0) r = -c / (2 * b);
        } else {
          const disc = b * b + (kk - 1) * c;
          if (disc >= 0) for (const v of [(b + Math.sqrt(disc)) / (kk - 1), (b - Math.sqrt(disc)) / (kk - 1)]) if (v > 1e-6 && v < r) r = v;
        }
        if (r < best) {
          best = r;
          who = j;
        }
      }
      for (const [ox, oy, orr] of obstacles) {
        const qx = ox - s[0], qy = oy - s[1], bb = u[0] * qx + u[1] * qy, cc = qx * qx + qy * qy - orr * orr, disc = bb * bb - cc;
        if (disc < 0) continue;
        const r = bb - Math.sqrt(disc);
        if (r > 0 && r < best) {
          best = r;
          who = -2;
        }
      }
      poly.push([s[0] + u[0] * best, s[1] + u[1] * best]);
      own.push(who);
    }
    cells.push(poly);
    owners.push(own);
  });
  return { cells, owners };
}
/** Polygon moved inward by d, corners rounded by repeated neighbour averaging; null if it vanishes. */
function insetCell(poly, d, passes = 8) {
  let p = offsetClosed(poly, -d);
  for (let pass = 0; pass < passes; pass++) p = p.map((q, i) => {
    const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
    return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
  });
  return p.length > 5 && area(p) > 40 ? p : null;
}
const meanPt = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);

/**
 * A cortical tubule profile from its outline (any shape): basement membrane, one ring of epithelial cells
 * with basal nuclei, the lumen. Proximal: tall pink cells, brush border, small irregular lumen. Distal:
 * paler, lower cells, open lumen. `macula`: the arc of the distal tubule facing the vascular pole becomes a
 * plaque of narrow, crowded cells with tall nuclei. `cast`: "rbc" | "protein"; `injured`: flattened, dilated.
 */
function tubuleFrom(L, outline, { kind = "pct", seed = 1, cast = null, injured = false, macula = null }) {
  const R = rng(seed);
  let ring = resample([...outline, outline[0]], 1.2);
  ring.pop();
  // orientation: the band of cells must grow inward (majority vote of the normals against the centre)
  const ns0 = normals(ring), c0 = meanPt(ring);
  if (ring.reduce((v, p, i) => v + Math.sign((c0[0] - p[0]) * ns0[i][0] + (c0[1] - p[1]) * ns0[i][1]), 0) < 0) ring = ring.slice().reverse();
  // epithelial height from the true half-width (distance from the centre to the outline), so long oblique
  // profiles keep a lumen
  const inr = edgeDistance([ring], c0);
  if (inr < 8 || !inside(ring, c0)) return false;
  const th = Math.min(inr * (kind === "pct" ? 0.64 : 0.42), kind === "pct" ? 11 : 7.5) * (injured ? 0.5 : 1);
  let lumenPts = offsetClosed(ring, -th).map((p, i, arr) => {
    if (kind !== "pct" || injured) return p;
    const c = meanPt(arr), k = 1 - 0.1 * (0.5 + 0.5 * Math.sin(i * 0.9 + seed));
    return [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
  });
  // a thin profile (cut at the frame or obliquely) can turn its offset lumen inside out: then leave it out
  if (!checkInside(lumenPts, ring, 1).ok) lumenPts = fitInside(lumenPts, ring, 1.2, 0.5);
  if (!lumenPts || area(lumenPts) < 14) return false;
  L.add("tbm", polyD(offsetClosed(ring, 1.1)));
  const cells = cellBand([...ring, ring[0]], { rows: 1, thickness: th, cellLen: kind === "pct" ? 8.6 : 6.4, jitter: 0.2, seed, nucleus: 0.3 });
  for (const c of cells) {
    const n = c.poly.length / 2, base = meanPt(c.poly.slice(0, n)), apex = meanPt(c.poly.slice(n));
    const md = macula && Math.hypot(base[0] - macula[0], base[1] - macula[1]) < macula[2];
    L.add(kind === "pct" ? (injured ? "pctInj" : "pct") : "dct", roundPoly(c.poly, 0.9));
    if (R() < (kind === "pct" ? 0.7 : 0.9) || md) {
      const t = md ? 0.55 : injured ? 0.45 : 0.3;
      const np = [base[0] + (apex[0] - base[0]) * t, base[1] + (apex[1] - base[1]) * t];
      const ang = (Math.atan2(apex[1] - base[1], apex[0] - base[0]) * 180) / Math.PI;
      // macula densa: two crowded, tall nuclei per cell slot (narrow cells packed into a plaque)
      for (const lat of md ? [-1.5, 1.5] : [0]) {
        const q = [np[0] - Math.sin((ang * Math.PI) / 180) * lat, np[1] + Math.cos((ang * Math.PI) / 180) * lat];
        let nuc = blobPts(q[0], q[1], md ? 2.5 : injured ? 1.2 : 2, md ? 1.05 : kind === "pct" ? 2.3 : 2, { n: 7, wobble: 0.06, seed: seed + c.i, rot: ang });
        nuc = fitInside(nuc, c.poly, 0.3) ?? nuc;
        L.add("kNuc", smoothClosed(nuc));
      }
    }
  }
  // macula densa: extra narrow crowded cells over the plaque (drawn as more nuclei, tightly spaced)
  const lumenD = smoothClosed(lumenPts.filter((_, i) => i % 2 === 0), 0.8);
  if (kind === "pct" && !injured) L.add("brush", lumenD);
  L.add(cast === "protein" ? "castP" : "tLumen", lumenD);
  if (cast === "rbc") {
    const lc = meanPt(lumenPts), lr = Math.sqrt(area(lumenPts) / Math.PI);
    L.add("castR", smoothClosed(lumenPts.filter((_, i) => i % 3 === 0).map(([x, y]) => [lc[0] + (x - lc[0]) * 0.86, lc[1] + (y - lc[1]) * 0.86]), 0.8));
    for (const p of packIn(lc[0], lc[1], lr * 0.55, lr * 0.55, 7, 3.4, { seed })) L.add("rbc", rbc(p[0], p[1], 2, R() * 180));
  }
}

/** Push the points of a closed outline out of a disc (a capillary taking room in the interstitium), then soften. */
function dentOut(poly, c, r) {
  let p = poly.map(([x, y]) => {
    const dx = x - c[0], dy = y - c[1], d = Math.hypot(dx, dy) || 1e-6;
    return d >= r ? [x, y] : [c[0] + (dx / d) * r, c[1] + (dy / d) * r];
  });
  for (let pass = 0; pass < 2; pass++) p = p.map((q, i) => {
    const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
    return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
  });
  return p;
}
/** Peritubular capillary cut across: thin wall, an oval lumen with one red cell and one flat endothelial nucleus. */
function ptc(L, [x, y], rx, ry, rot, R) {
  const rr = (rot * Math.PI) / 180, P = (lx, ly) => [x + lx * Math.cos(rr) - ly * Math.sin(rr), y + lx * Math.sin(rr) + ly * Math.cos(rr)];
  L.add("wall", ellipse(x, y, rx, ry, rot));
  const lx = rx - 0.8, ly = ry - 0.8;
  L.add("lumen", ellipse(x, y, lx, ly, rot));
  const a = R() * Math.PI * 2;
  L.add("endo", ellipse(...P(Math.cos(a) * (lx - 0.5), Math.sin(a) * (ly - 0.5)), Math.min(1.9, lx * 0.65), 0.5, (a * 180) / Math.PI + rot + 90));
  const rb = Math.min(lx, ly) * 0.7;
  L.add("rbc", rbc(...P(-Math.cos(a) * 0.35, -Math.sin(a) * 0.35), rb, R() * 180));
}
/**
 * A vessel cut lengthwise along `path` (outer end first), with outer and lumen widths that vary with arc length.
 * The outer end is cut obliquely, as where a vessel leaves the plane of section: one wall starts `slant` units
 * later than the other and the lumen tapers shut.
 */
function vesselBand(path, wOut, wIn, slant = 6) {
  const pts = resample(path, 1);
  const s = arcLengths(pts), ns = normals(pts);
  const edge = (k, w, from) => pts.map((p, i) => (s[i] >= from ? [p[0] + (ns[i][0] * k * w(s[i])) / 2, p[1] + (ns[i][1] * k * w(s[i])) / 2] : null)).filter(Boolean);
  const wall = [...edge(1, wOut, 0), ...edge(-1, wOut, slant).reverse()];
  const s0 = slant * 0.7, wl = (x) => wIn(x) * Math.sqrt(Math.max(0, Math.min(1, (x - s0) / 9)));
  const lumen = [...edge(1, wl, s0), ...edge(-1, wl, s0).reverse()];
  return { wall, lumen, pts, s, ns, total: s[s.length - 1] };
}

function kidney(gn, seed = 61) {
  const R = rng(seed), L = new Layers();
  const W = 280, H = 250, cx = 140, cy = 130, capR = 63;
  const pal = {
    inter: gn ? "#f9dedd" : "#fbe9e7", pct: "#f1a6b4", pctInj: "#f6c6cf", dct: "#f7cdd4", kNuc: "#7d4f9f",
    tbm: "#f3b6c0", brush: "#f9dbe1", tLumen: "#fff6f5", castP: "#f2b8c6", castR: "#f7d3d3",
    parietal: "#f2b4c0", bow: "#fff3f2", mes: gn ? "#f0a9bb" : "#f3bccb", loop: gn ? "#e57c90" : "#ec97a5", loopLumen: "#fde8ea",
    podo: "#7d55a6", mesNuc: "#8b5ba9", crescent: "#eba5b6", cresNuc: "#7a4f9d", art: "#e98b97", artNuc: "#82559f", jg: "#c46a9a",
    lacis: "#f7dce6", lacisNuc: "#8d66ad",
  };
  L.def("inter", { fill: pal.inter, lineWidth: 0.5 })
    .def("collagen", { fill: "none", stroke: { color: gn ? "#e9aeb4" : "#f1c5c8", width: gn ? 1.5 : 1.1, cap: "round" }, lineColor: "#d99ea5", lineStrokeWidth: 0.7 });
  std(L, BLOOD);
  L.def("tbm", { fill: pal.tbm, lineWidth: 0.6 })
    .def("pct", { fill: pal.pct, stroke: sw(shade(pal.pct, 0.14), 0.55), lineWidth: 0.6 })
    .def("pctInj", { fill: pal.pctInj, stroke: sw(shade(pal.pctInj, 0.14), 0.55), lineWidth: 0.6 })
    .def("dct", { fill: pal.dct, stroke: sw(shade(pal.dct, 0.14), 0.55), lineWidth: 0.6 })
    .def("kNuc", { fill: pal.kNuc, shade: "small", lineWidth: 0.35 })
    .def("brush", { fill: "none", stroke: { color: pal.brush, width: 3, cap: "round" }, lineColor: "#e7a9b6", lineStrokeWidth: 0.6 })
    .def("tLumen", { fill: pal.tLumen, lineWidth: 0.4 })
    .def("castP", { fill: pal.castP, stroke: sw(shade(pal.castP, 0.12), 0.5), lineWidth: 0.5 })
    .def("castR", { fill: pal.castR, lineWidth: 0.4 });
  std(L, ["rbc", ...IMMUNE, "fibro", "fibroNuc"]);
  // Bowman's space under the parietal layer, so the parietal lips at the hilum stay visible
  L.def("bow", { fill: pal.bow, lineWidth: 0.5 })
    .def("parietal", { fill: pal.parietal, stroke: sw(shade(pal.parietal, 0.14), 0.8), lineWidth: 1 })
    .def("parNuc", { fill: pal.kNuc, lineWidth: 0.3 })
    .def("crescent", { fill: pal.crescent, stroke: sw(shade(pal.crescent, 0.14), 0.7), lineWidth: 0.9 })
    .def("cresNuc", { fill: pal.cresNuc, lineWidth: 0.35 })
    .def("fibrin", { fill: C.fibrin, stroke: sw(shade(C.fibrin, 0.16), 0.5), lineWidth: 0.6 })
    .def("mes", { fill: pal.mes, stroke: sw(shade(pal.mes, 0.12), 0.6), lineWidth: 0.8, unite: [] })
    // arterioles over the hilar mesangium, under the capillary loops they open into
    .def("art", { fill: pal.art, stroke: sw(shade(pal.art, 0.16), 0.7), shade: "rim", lineWidth: 0.9 })
    .def("artLumen", { fill: "#fdeceb", lineWidth: 0.4 })
    .def("artRbc", { fill: C.rbc, shade: "small", lineWidth: 0.4 })
    .def("artNuc", { fill: pal.artNuc, lineWidth: 0.3 })
    .def("jg", { fill: pal.jg, lineWidth: 0.2 })
    .def("lacis", { fill: pal.lacis, stroke: sw(shade(pal.lacis, 0.14), 0.4), shade: "small", lineWidth: 0.45 })
    .def("lacisNuc", { fill: pal.lacisNuc, lineWidth: 0.25 })
    .def("loop", { fill: pal.loop, lineWidth: gn ? 1 : 0.7 })
    .def("loopLumen", { fill: pal.loopLumen, lineWidth: 0.3 })
    .def("artJoin", { fill: pal.loopLumen, lineWidth: 0 })
    .def("gRbc", { fill: C.rbc, shade: "small", lineWidth: 0.4 })
    .def("endoNucG", { fill: "#9a6bb4", lineWidth: 0.25 })
    .def("mesNuc", { fill: pal.mesNuc, shade: "small", lineWidth: 0.35 })
    .def("podo", { fill: pal.podo, lineWidth: 0.35 })
    .def("gNeutNuc", { fill: C.neutNuc, lineWidth: 0.3 });

  // a straight-cut block of cortex
  L.add("inter", polyD([[6, 6], [W - 6, 6], [W - 6, H - 6], [6, H - 6]]));

  /* --- vascular pole (upper left). The afferent (thick media, renin granules) and efferent (thin wall)
     arterioles cross Bowman's capsule side by side through a hilum gap, diverging outward in a V; each lumen
     opens into a hilar capillary loop. The lacis (extraglomerular mesangium) fills the V next to the hilum and
     the macula densa of the distal tubule closes it, touching the afferent wall. Both arterioles leave the
     plane of section obliquely about 45–50 units out. --- */
  const thP = (-135 * Math.PI) / 180;
  const u = [Math.cos(thP), Math.sin(thP)], v = [-Math.sin(thP), Math.cos(thP)];
  const P = [cx + u[0] * capR, cy + u[1] * capR];
  const at = (o, a, b = 0) => [o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b];
  const dirU = (deg) => [Math.cos(thP + (deg * Math.PI) / 180), Math.sin(thP + (deg * Math.PI) / 180)];
  const mv = (p, d, k) => [p[0] + d[0] * k, p[1] + d[1] * k];
  const arts = [
    { aff: true, b: -9, dir: dirU(-44), len: 50, bow: 3, wPole: 13, wOut: 16.5, lPole: 5.6, lOut: 6.8 },
    { aff: false, b: 7.8, dir: dirU(38), len: 45, bow: -2.5, wPole: 9.6, wOut: 11, lPole: 4.6, lOut: 5.2 },
  ];
  for (const A of arts) {
    const C0 = at(P, 0, A.b), nrm = [-A.dir[1], A.dir[0]];
    A.C0 = C0;
    A.In = at(P, -13.5, A.b * 0.78);
    A.path = catmull([mv(mv(C0, A.dir, A.len), nrm, A.bow * 0.4), mv(mv(C0, A.dir, A.len * 0.62), nrm, A.bow), mv(mv(C0, A.dir, A.len * 0.28), nrm, A.bow * 0.5), at(C0, 3), C0, at(C0, -6.5, -A.b * 0.1), A.In], 6);
    const rp = resample(A.path, 1), sl = arcLengths(rp);
    A.sPole = sl[rp.reduce((b, p, i) => (dist(p, C0) < dist(rp[b], C0) ? i : b), 0)];
    const lerp = (a, b, s) => a + (b - a) * Math.min(1, s / A.sPole);
    A.wO = (s) => (s <= A.sPole ? lerp(A.wOut, A.wPole, s) : A.wPole - 0.8);
    A.wI = (s) => (s <= A.sPole ? lerp(A.lOut, A.lPole, s) : A.lPole);
    A.band = vesselBand(A.path, A.wO, A.wI, A.aff ? 6 : 5);
    A.wallPoly = A.band.wall;
  }
  const [aff, eff] = arts;
  // which side of an arteriole's axis a point lies on (+1 / −1)
  const sideOf = (A, q) => {
    const { pts, ns } = A.band;
    const k = pts.reduce((b, p, i) => (dist(p, q) < dist(pts[b], q) ? i : b), 0);
    return Math.sign((q[0] - pts[k][0]) * ns[k][0] + (q[1] - pts[k][1]) * ns[k][1]);
  };
  const mid = at(P, 4, (aff.b + eff.b) / 2);
  const innerSide = arts.map((A) => sideOf(A, mid));
  // macula densa tubule: an oval in the V, its plaque facing the hilum and touching the afferent wall
  const mdR = [12.5, 11];
  const mdOut = (M) => Array.from({ length: 48 }, (_, k) => {
    const a = (k / 48) * Math.PI * 2;
    return [M[0] + v[0] * Math.cos(a) * mdR[0] + u[0] * Math.sin(a) * mdR[1], M[1] + v[1] * Math.cos(a) * mdR[0] + u[1] * Math.sin(a) * mdR[1]];
  });
  let best = null;
  for (let dM = 18; dM <= 34; dM += 0.5) {
    for (let bM = -8; bM <= 10; bM += 0.5) {
      const M = at(P, dM, bM), o = mdOut(M), oT = offsetClosed(o, 1.1);
      if (oT.some((q) => inside(aff.wallPoly, q) || inside(eff.wallPoly, q))) continue;
      const gA = Math.min(...oT.map((q) => edgeDistance([aff.wallPoly], q)));
      const gE = Math.min(...oT.map((q) => edgeDistance([eff.wallPoly], q)));
      const aNear = Math.min(...o.map((q) => (q[0] - P[0]) * u[0] + (q[1] - P[1]) * u[1]));
      const score = Math.abs(gA - 0.5) + 2 * Math.max(0, 0.3 - gE) + 0.25 * Math.abs(aNear - 15);
      if (!best || score < best.score) best = { score, M, o, aNear };
    }
  }
  const mdC = best.M, mdOutline = best.o;
  const plaque = mdOutline.reduce((b, q) => (dist(q, P) < dist(b, P) ? q : b), mdOutline[0]);
  // lacis cells: in the V between the arterioles, from the hilum out to the macula densa
  const inV = (q, m) => {
    const a = (q[0] - P[0]) * u[0] + (q[1] - P[1]) * u[1];
    return a > 1 + m && a < best.aNear - 0.5 && arts.every((A, i) => sideOf(A, q) === innerSide[i] && !inside(A.wallPoly, q) && edgeDistance([A.wallPoly], q) > m) &&
      !inside(mdOutline, q) && edgeDistance([mdOutline], q) > m + 1.1;
  };

  // GN: a widened, eccentric periglomerular zone (broadest lower right) for fibrosis and the infiltrate
  const obstacles = [gn ? [cx + 9, cy + 8, capR + 15] : [cx, cy, capR + 4], [mdC[0], mdC[1], mdR[0] + 3.5], [...at(P, 7, (aff.b + eff.b) / 2), 9]];
  for (const A of arts) for (const p of resample(A.path, 4)) obstacles.push([p[0], p[1], A.wOut / 2 + 3]);

  /* --- tubules: a packed partition of the cortex round the glomerulus (little interstitium) --- */
  const G = rng(seed + 50);
  const sites = [], wts = [];
  for (let t = 0; t < 5000 && sites.length < 40; t++) {
    const r = 15 + G() * 8, p = [6 + G() * (W - 12), 6 + G() * (H - 12)];
    if (obstacles.some(([ox, oy, orr]) => Math.hypot(p[0] - ox, p[1] - oy) < orr + r * 0.55)) continue;
    if (sites.some((q, i) => dist(q, p) < (r + wts[i]) * 0.86)) continue;
    sites.push(p);
    wts.push(r);
  }
  const { cells, owners } = rayCells(sites, wts.map((v) => 0.85 + v / 100), [8, 8, W - 16, H - 16], obstacles);
  const gap = gn ? 3.2 : 2.1;
  const tubes = [];
  cells.forEach((poly, i) => {
    const out = insetCell(poly, gap);
    if (!out || area(out) < 260) return;
    tubes.push({ i, out, c: sites[i] });
  });

  // peritubular capillaries where tubules meet: the tubule outlines give way a little round each one. The
  // healthy cortex is rich in them; in GN they are fewer and squeezed flat by fibrosis (rarefaction).
  const GP = rng(seed + 70);
  const cand = [];
  owners.forEach((own, i) => own.forEach((o, k) => {
    const prev = own[(k - 1 + own.length) % own.length];
    if (o !== prev && o >= 0 && prev >= 0) cand.push(cells[i][k]);
  }));
  for (let k = cand.length - 1; k > 0; k--) {
    const j = Math.floor(GP() * (k + 1));
    [cand[k], cand[j]] = [cand[j], cand[k]];
  }
  const ptcs = [];
  for (const p of cand) {
    if (ptcs.length >= (gn ? 5 : 13)) break;
    if (p[0] < 14 || p[0] > W - 14 || p[1] < 14 || p[1] > H - 14) continue;
    if (ptcs.some((q) => dist(q, p) < 24) || obstacles.some(([ox, oy, orr]) => Math.hypot(p[0] - ox, p[1] - oy) < orr + 2)) continue;
    if (tubes.some((t) => checkInside([p], t.out, 0).ok && edgeDistance([t.out], p) > 1.5)) continue;
    ptcs.push(p);
  }
  for (const p of ptcs) {
    const rc = gn ? vary(GP, 2.9, 0.1) : vary(GP, 3.1, 0.12), ry = rc * (gn ? 0.6 : vary(GP, 0.82, 0.1));
    for (const t of tubes) t.out = dentOut(t.out, p, rc + 1.9);
    ptc(L, p, rc, ry, GP() * 180, GP);
  }
  const inTube = (p, m = 0) => tubes.some((t) => checkInside([p], t.out, -m).ok);

  // the macula densa tubule (distal) at the vascular pole; the rest proximal (~2/3) or distal
  tubuleFrom(L, mdOutline, { kind: "dct", seed: seed + 5, macula: [plaque[0], plaque[1], 13] });
  const order = tubes.slice().sort((a, b) => dist(a.c, [cx, cy]) - dist(b.c, [cx, cy]));
  order.forEach((t, k) => {
    const distal = G() < 0.3;
    const cast = gn && k === 2 ? "rbc" : gn && k === 6 ? "protein" : null;
    const injured = gn && (G() < 0.3 || cast === "protein");
    tubuleFrom(L, t.out, { kind: distal && !cast ? "dct" : "pct", seed: seed + 10 + t.i, cast, injured });
  });

  if (gn) {
    // periglomerular fibrosis and inflammation in the widened interstitium round Bowman's capsule
    for (let k = 0; k < 16; k++) {
      const a0 = R() * 360, r = capR + 4 + R() * 7, a1 = a0 + 30 + R() * 40;
      const pts = [];
      for (let i = 0; i <= 10; i++) {
        const a = ((a0 + ((a1 - a0) * i) / 10) * Math.PI) / 180;
        pts.push([cx + Math.cos(a) * (r + Math.sin(i) * 0.8), cy + Math.sin(a) * (r + Math.sin(i) * 0.8)]);
      }
      if (!pts.some((q) => inTube(q, 1) || obstacles.slice(1).some(([ox, oy, orr]) => Math.hypot(q[0] - ox, q[1] - oy) < orr - 2) || ptcs.some((c) => dist(c, q) < 5))) L.add("collagen", lineD(pts));
    }
    // interstitial fibrosis: short collagen bundles and fibroblasts where tubules have dropped out
    for (const q of packWhere({ x: 12, y: 12, w: W - 24, h: H - 24 }, 26, 9, (p) => !inTube(p, 4) && dist(p, [cx, cy]) > capR + 6 && !obstacles.slice(1).some(([ox, oy, orr]) => Math.hypot(p[0] - ox, p[1] - oy) < orr + 2) && !ptcs.some((c) => dist(c, p) < 8), { seed: seed + 4 })) {
      const a = R() * Math.PI;
      const pts = [[q[0] - Math.cos(a) * 7, q[1] - Math.sin(a) * 7], [q[0] + Math.cos(a) * 7, q[1] + Math.sin(a) * 7]];
      if (!pts.some((p) => inTube(p, 1.5))) L.add("collagen", fibre(pts[0][0], pts[0][1], pts[1][0], pts[1][1], { amp: 1, waves: 1.5, phase: R() * 6 }));
      else if (R() < 0.5) {
        L.add("fibro", spindle(q[0], q[1], 13, 3.4, (a * 180) / Math.PI));
        L.add("fibroNuc", ellipse(q[0], q[1], 3, 1.1, (a * 180) / Math.PI));
      }
    }
    const R2 = rng(seed + 5);
    const spots = clustered(R2, { x: 16, y: 16, w: W - 32, h: H - 32 }, 30, { clusters: 4, spread: 0.12, minDist: 8.2, test: (q) => !inTube(q, 4.4) && dist(q, [cx, cy]) > capR + 4.5 && !obstacles.slice(1).some(([ox, oy, orr]) => Math.hypot(q[0] - ox, q[1] - oy) < orr + 1) && !ptcs.some((c) => dist(c, q) < 9) });
    spots.forEach((p, k) => {
      if (k % 5 === 0) macrophage(L, p, seed + k, 0.7);
      else if (k % 7 === 1) plasmaCell(L, p, R2);
      else if (k % 6 === 2) neutrophil(L, p, R2);
      else lymphocyte(L, p, 3.9, "T", R2);
    });
  }

  // Bowman's capsule: flat parietal epithelium, interrupted at the hilum where its two lips turn inward along
  // the arterioles onto the tuft
  const tc = gn ? [cx - 7, cy - 5] : [cx + 1, cy + 1], tuftR = gn ? 44 : 53;
  L.add("bow", circle(cx, cy, capR - 1));
  {
    const aLo = thP + (aff.b - aff.wPole / 2 + 0.3) / capR, aHi = thP + (eff.b + eff.wPole / 2 - 0.3) / capR;
    const rIn = capR - 3.6, rLip = capR - 9.5, dLip = 3.4;
    const P2 = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    const poly = [];
    const a0 = aHi, a1 = aLo + Math.PI * 2;
    for (let k = 0; k <= 150; k++) poly.push(P2(a0 + ((a1 - a0) * k) / 150, capR));
    // afferent-side lip (end of the arc): down the gap edge, across, back up inside the ring
    for (let r = capR - 1.5; r >= rLip; r -= 1.5) poly.push(P2(a1, r));
    poly.push(P2(a1 - dLip / rLip, rLip));
    for (let r = rLip + 1.5; r <= rIn; r += 1.5) poly.push(P2(a1 - dLip / r, r));
    for (let k = 150; k >= 0; k--) {
      const a = a0 + dLip / rIn + ((a1 - dLip / rIn - (a0 + dLip / rIn)) * k) / 150;
      poly.push(P2(a, rIn));
    }
    // efferent-side lip (start of the arc)
    for (let r = rIn - 1.5; r >= rLip; r -= 1.5) poly.push(P2(a0 + dLip / r, r));
    poly.push(P2(a0, rLip));
    for (let r = rLip + 1.5; r < capR - 1; r += 1.5) poly.push(P2(a0, r));
    L.add("parietal", roundPoly(poly, 1.1));
    for (const a of unevenSpacing(22, 360, R, { cv: 0.3 })) {
      const ar = (a * Math.PI) / 180;
      let rel = ar - a0;
      while (rel < 0) rel += Math.PI * 2;
      if (rel < 0.12 || rel > a1 - a0 - 0.12) continue; // no parietal nuclei in the hilum gap
      L.add("parNuc", ellipse(cx + Math.cos(ar) * (capR - 1.8), cy + Math.sin(ar) * (capR - 1.8), 3, 1, a + 90));
    }
  }

  // crescent: proliferating parietal cells, macrophages and fibrin filling Bowman's space
  let cresPoly = null;
  if (gn) {
    const a0 = -30, a1 = 150, pts = [], inner = [];
    for (let i = 0; i <= 30; i++) {
      const t = i / 30, a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
      const depth = 15 * Math.pow(Math.sin(Math.PI * t), 0.6);
      pts.push([cx + Math.cos(a) * (capR - 3.4), cy + Math.sin(a) * (capR - 3.4)]);
      inner.push([cx + Math.cos(a) * (capR - 3.4 - depth), cy + Math.sin(a) * (capR - 3.4 - depth)]);
    }
    cresPoly = [...pts, ...inner.reverse()];
    L.add("crescent", smoothClosed(cresPoly, 0.6));
    for (const p of packWhere({ x: cx - capR, y: cy - capR, w: capR * 2, h: capR * 2 }, 26, 4.2, (q) => inside(cresPoly, q) && dist(q, [cx, cy]) < capR - 6, { seed: seed + 7 })) {
      const a = Math.atan2(p[1] - cy, p[0] - cx);
      L.add("cresNuc", ellipse(p[0], p[1], 2.4, 1.5, (a * 180) / Math.PI + 90 + (R() - 0.5) * 50));
    }
    for (let k = 0; k < 5; k++) {
      const a = ((-10 + k * 34 + R() * 10) * Math.PI) / 180, r = capR - 12 - R() * 5;
      L.add("fibrin", blob(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 4 + R() * 2, 1.6 + R(), { n: 7, wobble: 0.35, seed: seed + 20 + k, rot: (a * 180) / Math.PI + 90 }));
    }
  }

  // glomerular tuft: lobules of capillary loops on a mesangial stalk that runs out to the hilum; the two hilar
  // loops are where the arterioles open into the tuft
  const loopR = gn ? 6 : 6.6;
  const inner = arts.flatMap((A) => resample([A.C0, A.In], 2).map((p) => [p[0], p[1], A.wPole / 2 + loopR * 0.9]));
  const loops = [...arts.map((A) => A.In), ...packIn(tc[0], tc[1], tuftR - loopR - 1, tuftR - loopR - 1, gn ? 33 : 35, loopR * 1.72, { seed: seed + 8, tries: 2000, avoid: [...arts.map((A) => [A.In[0], A.In[1], loopR * 1.72]), ...inner] })];
  const mes = L.map.get("mes").unite;
  for (const p of loops) mes.push(circle(p[0], p[1], loopR + 2.1));
  mes.push(blob(tc[0] - 4, tc[1] - 4, tuftR * 0.45, tuftR * 0.4, { n: 8, wobble: 0.2, seed: seed + 9 }));
  mes.push(capsule(...at(P, -24, (aff.b + eff.b) / 2), ...at(P, 1.5, (aff.b + eff.b) / 2), 3)); // hilar stalk
  // arterioles: afferent (thick media, juxtaglomerular granular cells by the pole), efferent (thin wall)
  for (const A of arts) {
    const { band } = A;
    L.add("art", polyD(band.wall));
    L.add("artLumen", polyD(band.lumen));
    const { pts, s, ns, total } = band;
    const atS = (x) => {
      let i = 0;
      while (i < s.length - 2 && s[i + 1] < x) i++;
      return i;
    };
    // circumferential smooth-muscle nuclei in the media, uneven; granular (renin) cells replace them by the pole
    const jg0 = A.sPole - 15;
    for (const x of unevenSpacing(Math.floor(A.sPole / (A.aff ? 5.2 : 7)), A.sPole - 8, R, { cv: 0.35, start: 7 })) {
      if (A.aff && x > jg0) continue;
      const i = atS(x), ang = Math.atan2(ns[i][1], ns[i][0]);
      for (const k of [-1, 1]) {
        const off = (A.wI(x) / 2 + (A.wO(x) - A.wI(x)) / 4) * k + (R() - 0.5) * 0.8;
        L.add("artNuc", ellipse(pts[i][0] + ns[i][0] * off, pts[i][1] + ns[i][1] * off, Math.min(2.2, (A.wO(x) - A.wI(x)) / 4.6), 0.9, (ang * 180) / Math.PI));
      }
    }
    if (A.aff) {
      for (const x of [jg0 + 2, jg0 + 7, jg0 + 12]) {
        const i = atS(x);
        for (const k of [-1, 1]) {
          const off = (A.wI(x) / 2 + (A.wO(x) - A.wI(x)) / 4) * k;
          for (const [gx, gy] of packIn(pts[i][0] + ns[i][0] * off, pts[i][1] + ns[i][1] * off, 1.6, 1.6, 3, 1.1, { seed: Math.round(x * 3 + k) })) L.add("jg", circle(gx, gy, 0.5));
        }
      }
    }
    for (const x of unevenSpacing(A.aff ? 3 : 2, A.sPole - 12, R, { cv: 0.4, start: 12 })) {
      const i = atS(x);
      L.add("artRbc", rbc(pts[i][0], pts[i][1], A.wI(x) * 0.4, (Math.atan2(ns[i][1], ns[i][0]) * 180) / Math.PI));
    }
    // the lumen opens into its hilar loop (cut through the loop wall)
    const d = [A.C0[0] - A.In[0], A.C0[1] - A.In[1]], dl = Math.hypot(...d);
    L.add("artJoin", capsule(A.In[0], A.In[1], A.In[0] + (d[0] / dl) * (loopR + 1.2), A.In[1] + (d[1] / dl) * (loopR + 1.2), A.lPole / 2 - 0.2));
  }
  // lacis: a small cluster of pale extraglomerular mesangial cells
  {
    const lc = packWhere({ x: P[0] - 22, y: P[1] - 22, w: 44, h: 44 }, 7, 4.3, (q) => inV(q, 1.7), { seed: seed + 31 });
    for (const q of lc) {
      const a = Math.atan2(u[1], u[0]) * (180 / Math.PI) + 90 + (R() - 0.5) * 40;
      let cell = blobPts(q[0], q[1], vary(R, 2.5, 0.1), vary(R, 1.95, 0.1), { n: 8, wobble: 0.1, seed: Math.round(q[0] * 9 + q[1]), rot: a });
      L.add("lacis", smoothClosed(cell));
      L.add("lacisNuc", ellipse(q[0] + (R() - 0.5) * 0.5, q[1] + (R() - 0.5) * 0.5, 1.3, 0.8, a));
    }
  }
  const nearArt = (q, m) => arts.some((A) => segDist(q, A.C0, A.In) < A.wPole / 2 + m);
  for (const p of loops) {
    L.add("loop", circle(p[0], p[1], loopR));
    const lr = gn ? loopR - 2.7 : loopR - 1.5;
    L.add("loopLumen", circle(p[0], p[1], lr));
    const r0 = R();
    if (gn && r0 < 0.22) L.add("gNeutNuc", lobes(p[0], p[1], 2.6, 3, R() * 360));
    else if (r0 < (gn ? 0.4 : 0.62)) L.add("gRbc", rbc(p[0] + (R() - 0.5), p[1] + (R() - 0.5), Math.min(3.3, lr * 0.8), R() * 180));
    const ea = R() * Math.PI * 2;
    L.add("endoNucG", ellipse(p[0] + Math.cos(ea) * (lr - 0.6), p[1] + Math.sin(ea) * (lr - 0.6), 2, 0.8, (ea * 180) / Math.PI + 90));
    // podocytes sit on the outside of peripheral loops, facing Bowman's space
    const uu = [p[0] - tc[0], p[1] - tc[1]], ul = Math.hypot(...uu) || 1;
    if (ul > tuftR - loopR * 3.2) {
      const q = [p[0] + (uu[0] / ul) * (loopR + 1.9), p[1] + (uu[1] / ul) * (loopR + 1.9)];
      if ((!cresPoly || !inside(cresPoly, q)) && dist(q, P) > 17 && !nearArt(q, 3)) L.add("podo", ellipse(q[0], q[1], 2.7, 1.8, (Math.atan2(uu[1], uu[0]) * 180) / Math.PI + 90));
    }
  }
  // mesangial cells between the loops (many more in proliferative glomerulonephritis)
  let nm = 0;
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      const d = dist(loops[i], loops[j]);
      if (d > loopR * 2.9) continue;
      const m = [(loops[i][0] + loops[j][0]) / 2, (loops[i][1] + loops[j][1]) / 2];
      if (dist(m, tc) > tuftR * 0.85 || nearArt(m, 2.5) || nm > (gn ? 46 : 16) || R() < (gn ? 0.1 : 0.6)) continue;
      L.add("mesNuc", ellipse(m[0], m[1], 2.1, 1.7, R() * 180));
      nm++;
    }
  }
  return clampScene({ size: [W, H], lineWidth: 1.2, parts: L.parts() }, [6, 6, W - 6, H - 6]);
}


/* ===================== bronchus: airway wall ===================== */

const offsetLine = (pts, d) =>
  pts.map((p, i) => {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / l) * d, p[1] + (dx / l) * d];
  });
/** A band between two offsets of a line. */
const band = (pts, d0, d1) => [...offsetLine(pts, d0), ...offsetLine(pts, d1).reverse()];
const f2 = (v) => (Math.round(v * 100) / 100).toString();

function eosinophil(L, [x, y], R, s = 1) {
  L.add("eos", circle(x, y, 6.2 * s));
  L.add("eosNuc", lobes(x, y, 4 * s, 2, R() * 180));
  for (const g of packIn(x, y, 4.8 * s, 4.8 * s, 9, 1.9 * s, { seed: Math.round(x * 13 + y) })) L.add("eosGran", circle(g[0], g[1], 0.85 * s));
}

function bronchus(asthma, seed = 81) {
  const R = rng(seed), L = new Layers();
  const W = 320, H = 240, X0 = 6, X1 = W - 6, Y1 = H - 6;
  const pal = {
    lumen: "#fbf4f6", mucus: "#cdd6ef", matrix: asthma ? "#f8d8dc" : "#fbe5e4", epi: "#f6cdd3", basal: "#f0bcc5", goblet: "#e3e5f6",
    gobNuc: "#5f4c93", nuc: "#7c4fa0", cilia: "#c48da3", bm: asthma ? "#f0b9cc" : "#e9a3b4", muscle: "#ee9aa4", musNuc: "#8a4f97",
    cart: "#d6d2ee", cartEdge: "#bdb6e0", chondro: "#f6f2fb", chNuc: "#7e66b3", gland: "#e6ecf8", glandNuc: "#6a5aa4", serous: "#e8b6cf",
    serousNuc: "#7a4f9c", duct: "#efc3d2",
  };
  L.def("lumenBg", { fill: pal.lumen, lineWidth: 0.5 })
    .def("matrix", { fill: pal.matrix, lineWidth: 0.6 })
    .def("collagen", { fill: "none", stroke: { color: asthma ? "#eab0b9" : "#f1c6c8", width: 1.2, cap: "round" }, lineColor: "#d99ea5", lineStrokeWidth: 0.6 })
    .def("peri", { fill: "#ecd2df", lineWidth: 0.6 })
    .def("cart", { fill: pal.cart, stroke: sw(pal.cartEdge, 1.2), lineWidth: 1.1 })
    .def("lacuna", { fill: pal.chondro, lineWidth: 0.4 })
    .def("chNuc", { fill: pal.chNuc, lineWidth: 0.3 })
    .def("muscle", { fill: pal.muscle, stroke: sw(shade(pal.muscle, 0.14), 0.7), shade: "rim", lineWidth: 0.9 })
    .def("smc", { fill: "none", stroke: { color: shade(pal.muscle, 0.1), width: 0.6 }, lineColor: "#c86f7c", lineStrokeWidth: 0.4 })
    .def("musNuc", { fill: pal.musNuc, lineWidth: 0.3 });
  std(L, [...BLOOD, "fibro", "fibroNuc", ...IMMUNE]);
  L.def("mast", { fill: C.mast, shade: "small", lineWidth: 0.7 }).def("mastGran", { fill: C.mastGran, lineWidth: 0.3 })
    .def("eos", { fill: "#fbd9dd", shade: "small", lineWidth: 0.6 })
    .def("eosGran", { fill: "#ec6a4c", lineWidth: 0.2 })
    .def("eosNuc", { fill: "#6e4b9e", lineWidth: 0.3 })
    .def("bm", { fill: pal.bm, stroke: sw(shade(pal.bm, 0.12), 0.5), lineWidth: 0.6 })
    // the gland duct crosses the basement membrane to open on the surface; acini cover its deep end
    .def("duct", { fill: pal.duct, stroke: sw(shade(pal.duct, 0.14), 0.5), lineWidth: 0.6 })
    .def("ductSep", { fill: "none", stroke: { color: shade(pal.duct, 0.12), width: 0.4, cap: "round" }, lineColor: shade(pal.duct, 0.4), lineStrokeWidth: 0.3 })
    .def("ductNuc", { fill: pal.serousNuc, lineWidth: 0.25 })
    .def("ductLumen", { fill: "#fdfcff", lineWidth: 0.3 })
    .def("gland", { fill: pal.gland, stroke: sw(shade(pal.gland, 0.18), 0.5), lineWidth: 0.55 })
    .def("serous", { fill: pal.serous, stroke: sw(shade(pal.serous, 0.16), 0.5), lineWidth: 0.55 })
    .def("glandSep", { fill: "none", stroke: { color: shade(pal.gland, 0.16), width: 0.4, cap: "round" }, lineColor: shade(pal.gland, 0.42), lineStrokeWidth: 0.3 })
    .def("serousSep", { fill: "none", stroke: { color: shade(pal.serous, 0.12), width: 0.4, cap: "round" }, lineColor: shade(pal.serous, 0.4), lineStrokeWidth: 0.3 })
    .def("glandNuc", { fill: pal.glandNuc, lineWidth: 0.25 })
    .def("serousNuc", { fill: pal.serousNuc, lineWidth: 0.25 })
    .def("glandLumen", { fill: "#fdfcff", lineWidth: 0.3 })
    .def("basal", { fill: pal.basal, stroke: sw(shade(pal.basal, 0.16), 0.5), lineWidth: 0.5 })
    .def("epi", { fill: pal.epi, stroke: sw(shade(pal.epi, 0.16), 0.55), lineWidth: 0.6 })
    .def("goblet", { fill: pal.goblet, stroke: sw(shade(pal.goblet, 0.2), 0.6), lineWidth: 0.6 })
    .def("mucin", { fill: "#f7f8fd", opacity: 0.9, lineWidth: 0.3 })
    .def("epiNuc", { fill: pal.nuc, shade: "small", lineWidth: 0.3 })
    .def("gobNuc", { fill: pal.gobNuc, lineWidth: 0.3 })
    .def("cilia", { fill: "none", stroke: { color: pal.cilia, width: 0.6, cap: "round" }, lineColor: "#a66a83", lineStrokeWidth: 0.4 })
    .def("mucus", { fill: pal.mucus, stroke: sw(shade(pal.mucus, 0.16), 0.8), opacity: 0.92, lineWidth: 0.8 })
    .def("mucusStrand", { fill: "none", stroke: { color: "#b7c2e6", width: 1, cap: "round" }, lineColor: "#8d99c9", lineStrokeWidth: 0.5 })
    .def("shed", { fill: pal.epi, stroke: sw(shade(pal.epi, 0.16), 0.5), lineWidth: 0.5 });

  // the mucosa: folded by the contracted muscle in asthma
  const amp = asthma ? 13 : 5, waves = asthma ? 3.5 : 1.5, top = asthma ? 62 : 48;
  const surface = catmull(Array.from({ length: 15 }, (_, i) => {
    const x = X0 - 4 + ((X1 - X0 + 8) * i) / 14;
    return [x, top + amp * Math.sin((i / 14) * waves * Math.PI * 2 + 0.6) + (R() - 0.5) * 2];
  }), 6);
  const ET = asthma ? 30 : 25; // epithelium height
  // a straight-cut block of airway wall
  L.add("lumenBg", polyD([[X0, 6], [X1, 6], [X1, Y1], [X0, Y1]]));
  const tissue = [...surface, [X1 + 4, Y1], [X0 - 4, Y1]];
  L.add("matrix", polyD(tissue.map(([x, y]) => [Math.max(X0, Math.min(X1, x)), Math.min(Y1, y)])));

  // deep layers follow a smoothed copy of the surface
  const smooth = catmull(Array.from({ length: 9 }, (_, i) => [X0 - 4 + ((X1 - X0 + 8) * i) / 8, top + 6 + 2.5 * Math.sin(i * 0.9)]), 10);
  const mTop = ET + (asthma ? 30 : 34), mTh = asthma ? 24 : 11;
  const idx = (x, arr) => Math.max(0, Math.min(arr.length - 1, Math.round(((x - (X0 - 4)) / (X1 - X0 + 8)) * (arr.length - 1))));
  const surfY = (x) => surface[idx(x, surface)][1];
  const muscleTopY = (x) => smooth[idx(x, smooth)][1] + mTop, muscleBotY = (x) => muscleTopY(x) + mTh;
  // cartilage plate along the bottom
  const cy0 = H - 52;
  // (a plate: smooth upper surface, cut square at the frame; no spline overshoot past the frame)
  // the plate runs on beyond the section: cut straight at the frame (no rounded tile corners), with a fibrous
  // perichondrium over its upper surface
  const cartTop = catmull([[X0 - 6, cy0 + 9], [70, cy0 + 2], [160, cy0], [250, cy0 + 3], [X1 + 6, cy0 + 11]], 6);
  const cartPts = [...cartTop, [X1 + 6, Y1 + 6], [X0 - 6, Y1 + 6]];
  L.add("peri", polyD([...cartTop.map(([x, y]) => [x, y - 3.4]), ...cartTop.slice().reverse().map(([x, y]) => [x, y + 1])]));
  L.add("cart", polyD(cartPts));
  for (const q of packWhere({ x: X0 + 8, y: cy0 + 6, w: X1 - X0 - 16, h: Y1 - cy0 - 12 }, 20, 13, (pt) => inside(cartPts, pt) && pt[1] > cy0 + 8 && pt[1] < Y1 - 9, { seed: seed + 3 })) {
    L.add("lacuna", ellipse(q[0], q[1], 5.2, 4, R() * 40 - 20));
    L.add("chNuc", ellipse(q[0] + 0.6, q[1] + 0.4, 2.5, 2, R() * 180));
  }

  // smooth muscle in bundles of uneven length and girth with gaps between them (asthma: hypertrophied,
  // nearly continuous); bundles that reach the frame are cut there, the others end in rounded spindle tips.
  // The gland duct passes through the gap at u ≈ 0.62–0.66.
  const segs = asthma ? [[-0.05, 0.59], [0.69, 1.05]] : [[-0.05, 0.26], [0.34, 0.6], [0.7, 1.05]];
  const centre = offsetLine(smooth, mTop + mTh / 2), nC = centre.length;
  const bundles = [];
  for (const [u0, u1] of segs) {
    const i0 = Math.max(0, Math.round(u0 * (nC - 1))), i1 = Math.min(nC - 1, Math.round(u1 * (nC - 1)));
    const pts = centre.slice(i0, i1 + 1).filter(([x]) => x >= X0 - 2 && x <= X1 + 2);
    const nrm = normals(pts), m = pts.length - 1;
    const wf = (k) => {
      const e0 = u0 < 0 ? 1 : Math.min(1, k / 9), e1 = u1 > 1 ? 1 : Math.min(1, (m - k) / 9), e = Math.min(e0, e1);
      return mTh * (0.86 + 0.14 * Math.sin((k / m) * 8 + u0 * 10)) * Math.sqrt(Math.max(0, 1 - (1 - e) ** 2));
    };
    const left = pts.map((p, k) => [p[0] + (nrm[k][0] * wf(k)) / 2, p[1] + (nrm[k][1] * wf(k)) / 2]);
    const right = pts.map((p, k) => [p[0] - (nrm[k][0] * wf(k)) / 2, p[1] - (nrm[k][1] * wf(k)) / 2]);
    const poly = [...left, ...right.slice().reverse()];
    bundles.push(poly);
    L.add("muscle", smoothClosed(poly.filter((_, k) => k % 2 === 0 || k === left.length - 1), 0.9));
  }
  const rows = asthma ? 4 : 2;
  for (let r = 0; r < rows; r++) {
    const line = offsetLine(smooth, mTop + ((r + 0.5) * mTh) / rows);
    for (let i = 2 + (r % 2) * 3; i < line.length - 4; i += 7) {
      const [x, y] = line[i], [x2, y2] = line[i + 3];
      if (Math.min(x, x2) < X0 + 12 || Math.max(x, x2) > X1 - 12) continue;
      const ang = (Math.atan2(y2 - y, x2 - x) * 180) / Math.PI;
      const d = spindle((x + x2) / 2, (y + y2) / 2, 22, (mTh / rows) * 0.95, ang);
      if (!bundles.some((b) => checkInside(d, b, 0.5).ok)) continue;
      L.add("smc", d);
      L.add("musNuc", ellipse((x + x2) / 2 + (R() - 0.5) * 3, (y + y2) / 2, 4.2, 0.9, ang));
    }
  }

  /* --- submucosal gland: a lobule of touching acini, mucous (pale, flat basal nuclei) and serous (pink, round
     basal nuclei), each a closed ring of wedge cells round a small lumen; larger and more numerous in asthma.
     One excretory duct, lined by cuboidal cells, runs up through the gap between muscle bundles and the
     lamina propria to open on the surface between two epithelial cells. --- */
  const GA = rng(seed + 40);
  const acini = [];
  const nAc = asthma ? 14 : 9, rMean = asthma ? 9 : 8.2;
  const okAc = (c, r) => Array.from({ length: 12 }, (_, k) => {
    const a = (k / 12) * Math.PI * 2;
    return [c[0] + Math.cos(a) * (r + 1.4), c[1] + Math.sin(a) * (r + 1.4)];
  }).every((q) => !inside(cartPts, q) && q[1] > muscleBotY(q[0]) + 1.2 && q[0] > X0 + 3 && q[0] < X1 - 3);
  const gStart = asthma ? [252, 170] : [258, 156];
  acini.push({ c: gStart, r: rMean });
  for (let t = 0; t < 6000 && acini.length < nAc; t++) {
    const base = acini[Math.floor(GA() * acini.length)], r = vary(GA, rMean, 0.15), a = GA() * Math.PI * 2;
    const d = base.r + r - 0.2 + GA() * 0.7;
    const c = [base.c[0] + Math.cos(a) * d, base.c[1] + Math.sin(a) * d];
    if (dist(c, gStart) > (asthma ? 62 : 40) || !okAc(c, r) || acini.some((o) => dist(o.c, c) < o.r + r - 0.3)) continue;
    acini.push({ c, r });
  }
  // the duct leaves the acinus nearest the muscle gap
  const uGap = asthma ? 0.64 : 0.65, gx = centre[Math.round(uGap * (nC - 1))][0];
  const first = acini.reduce((b, a) => (dist(a.c, [gx, muscleBotY(gx)]) < dist(b.c, [gx, muscleBotY(gx)]) ? a : b), acini[0]);
  acini.forEach((a, k) => (a.serous = a === first ? false : GA() < 0.42 || k % 5 === 3));
  const xo = gx - 7; // opening on the surface
  const ductPath = resample(catmull([
    first.c, [first.c[0] + (gx - first.c[0]) * 0.55, muscleBotY(gx) + 3], [gx, (muscleTopY(gx) + muscleBotY(gx)) / 2], [gx - 3, muscleTopY(gx) - 8],
    [xo + 1, surfY(xo) + ET + 8], [xo, surfY(xo) + ET * 0.5], [xo, surfY(xo) - 0.5],
  ], 8), 1);
  const dW = 10, dL = 3.6;
  L.add("duct", ribbon(ductPath, dW));
  L.add("ductLumen", ribbon(ductPath.slice(0, -1).concat([[xo, surfY(xo) - 2]]), dL));
  {
    // cuboidal lining: round nuclei at uneven spacing on both sides of the lumen
    const ns = normals(ductPath), nD = ductPath.length;
    for (const k of [-1, 1]) {
      for (const t of unevenSpacing(Math.floor(nD / 4.6), nD - 6, GA, { cv: 0.3, start: 3 })) {
        const i = Math.round(t), q = ductPath[i], n = ns[i], o = k * (dL / 2 + (dW - dL) / 4 + (GA() - 0.5) * 0.4);
        if (q[1] < surfY(q[0]) + 4) continue;
        L.add("ductNuc", ellipse(q[0] + n[0] * o, q[1] + n[1] * o, vary(GA, 1.2, 0.12), vary(GA, 1.0, 0.1), GA() * 180));
      }
    }
  }
  const nearDuct = (p, m) => {
    for (let i = 1; i < ductPath.length; i += 2) if (segDist(p, ductPath[i - 1], ductPath[i]) < dW / 2 + m) return true;
    return false;
  };
  for (const a of acini) {
    const { c, r, serous } = a;
    const rL = serous ? vary(GA, 1.3, 0.15) : vary(GA, 2.2, 0.12);
    const outline = blobPts(c[0], c[1], r, r * vary(GA, 0.95, 0.04), { n: 12, wobble: 0.04, seed: Math.round(c[0] * 7 + c[1]), rot: GA() * 180 });
    L.add(serous ? "serous" : "gland", smoothClosed(outline));
    const rEdge = (ang) => {
      // distance from the centre to the outline along ang (outline is star-shaped about c)
      let best = r;
      for (let k = 0; k < outline.length; k++) {
        const p = outline[k], q = outline[(k + 1) % outline.length];
        const a0 = Math.atan2(p[1] - c[1], p[0] - c[0]), a1 = Math.atan2(q[1] - c[1], q[0] - c[0]);
        let da = a1 - a0;
        if (da < -Math.PI) da += Math.PI * 2;
        if (da > Math.PI) da -= Math.PI * 2;
        let t = ang - a0;
        while (t < -Math.PI) t += Math.PI * 2;
        while (t > Math.PI) t -= Math.PI * 2;
        if (da !== 0 && t / da >= 0 && t / da <= 1) best = dist(p, c) + (dist(q, c) - dist(p, c)) * (t / da);
      }
      return best;
    };
    const n = serous ? 6 + Math.floor(GA() * 2) : 7 + Math.floor(GA() * 3);
    const off = GA() * 360, angs = unevenSpacing(n, 360, GA, { cv: 0.22 }).map((d) => d + off).map((d) => (d * Math.PI) / 180).sort((x, y) => x - y);
    for (let k = 0; k < n; k++) {
      const a = angs[k], re = rEdge(a) * 0.98;
      L.add(serous ? "serousSep" : "glandSep", lineD([[c[0] + Math.cos(a) * (rL + 0.2), c[1] + Math.sin(a) * (rL + 0.2)], [c[0] + Math.cos(a) * re, c[1] + Math.sin(a) * re]]));
      const am = (a + (k + 1 < n ? angs[k + 1] : angs[0] + Math.PI * 2)) / 2, rem = rEdge(am);
      if (serous) {
        // round nucleus in the basal half of the cell
        const rr = rL + (rem - rL) * 0.66;
        L.add("serousNuc", circle(c[0] + Math.cos(am) * rr, c[1] + Math.sin(am) * rr, Math.min(1.2, (rem - rL) * 0.2)));
      } else {
        // mucous cell: nucleus flattened against the base by the mucin
        const rr = rem - 1.75;
        L.add("glandNuc", ellipse(c[0] + Math.cos(am) * rr, c[1] + Math.sin(am) * rr, 1.6, 0.62, (am * 180) / Math.PI + 90));
      }
    }
    L.add("glandLumen", circle(c[0], c[1], rL));
  }
  const inGland = (p, m) => acini.some((a) => dist(a.c, p) < a.r + m) || nearDuct(p, m);

  // lamina propria and submucosa: collagen, capillaries, fibroblasts and immune cells
  const inLP = (pt, pad = 0) => pt[1] > surfY(pt[0]) + ET + (asthma ? 7 : 3) + pad && pt[1] < muscleTopY(pt[0]) - pad && pt[0] > X0 + pad && pt[0] < X1 - pad && !inGland(pt, 2 + pad);
  const inSub = (pt, pad = 0) => pt[1] > muscleBotY(pt[0]) + pad && pt[1] < cy0 - pad && pt[0] > X0 + pad && pt[0] < X1 - pad && !inGland(pt, 3 + pad);
  const box = { x: X0, y: 20, w: X1 - X0, h: H - 40 };
  // collagen: a few long bundles of 2–3 gently wavy strands running with the wall (lamina propria and
  // submucosa), interrupted where a gland or the duct crosses — not scattered squiggles
  const GB = rng(seed + 55);
  const bundleRun = (yOf, x0, x1, strands, ok) => {
    for (let k = 0; k < strands; k++) {
      const ph = GB() * 6, pts = [];
      for (let x = x0; x <= x1; x += 2) pts.push([x, yOf(x) + (k - (strands - 1) / 2) * 2.4 + 1.1 * Math.sin(x / 9 + ph + k * 0.7)]);
      let run = [];
      const flush = () => {
        if (run.length > 6) L.add("collagen", smoothOpen(run.filter((_, i) => i % 2 === 0 || i === run.length - 1)));
        run = [];
      };
      for (const p of pts) (ok(p) ? run.push(p) : flush());
      flush();
    }
  };
  const lpY = (t) => (x) => surfY(x) + ET + (asthma ? 7 : 3) + (muscleTopY(x) - surfY(x) - ET - (asthma ? 7 : 3)) * t;
  const subY = (t) => (x) => muscleBotY(x) + (cy0 - muscleBotY(x)) * t;
  for (const [yOf, strands] of [[lpY(0.4), 2], [lpY(0.75), 3], [subY(0.3), 3], [subY(0.7), 2]]) {
    const x0 = X0 - 10 + GB() * 70, x1 = x0 + 150 + GB() * 130;
    bundleRun(yOf, x0, x1, strands, (p) => inLP(p, 1.5) || inSub(p, 1.5));
  }
  for (const q of packWhere(box, asthma ? 7 : 5, 22, (pt) => inLP(pt, 5) || inSub(pt, 6), { seed: seed + 6 })) {
    vessel(L, { cx: q[0], cy: q[1], rx: 5 + R() * 2, ry: 4 + R() * 1.5, rot: R() * 180, kind: "cap", seed: Math.round(q[0] + q[1]) });
  }
  for (const q of packWhere(box, 5, 14, (pt) => inLP(pt, 3) || inSub(pt, 3), { seed: seed + 7 })) {
    const a = R() * 40 - 20;
    L.add("fibro", spindle(q[0], q[1], 16, 3.6, a));
    L.add("fibroNuc", ellipse(q[0], q[1], 3.4, 1.2, a));
  }
  const imm = packWhere(box, asthma ? 30 : 6, 9, (pt) => inLP(pt, 3) || (asthma && inSub(pt, 3)), { seed: seed + 8 });
  imm.forEach((q, k) => {
    if (asthma && k % 2 === 0) eosinophil(L, q, R, 0.9);
    else if (asthma && k % 5 === 1) mastCell(L, q, seed + k);
    else if (k % 4 === 3) plasmaCell(L, q, R);
    else lymphocyte(L, q, 4.2, "T", R);
  });

  // basement membrane (thickened by subepithelial fibrosis in asthma)
  L.add("bm", polyD(band(surface, ET - 0.4, ET + (asthma ? 5 : 1.6)).map(([x, y]) => [Math.max(X0, Math.min(X1, x)), y])));
  // pseudostratified epithelium: basal cells, then tall ciliated and goblet cells (none where the duct opens)
  const baseLine = offsetLine(surface, ET * 0.78);
  const inX = (c) => c.poly.every(([x]) => x >= X0 + 0.5 && x <= X1 - 0.5) && !c.poly.some((p) => nearDuct(p, 0.3));
  for (const c of cellBand(baseLine, { rows: 1, thickness: ET * 0.22, cellLen: 7, jitter: 0.2, seed: seed + 9, nucleus: 0.34 }).filter(inX)) {
    L.add("basal", roundPoly(c.poly, 0.8));
    L.add("epiNuc", ellipse(c.nucleus.cx, c.nucleus.cy, 2.1, 1.4, c.nucleus.rot));
  }
  const cells = cellBand(surface, { rows: 1, thickness: ET * 0.8, cellLen: asthma ? 7.5 : 7, jitter: 0.18, seed: seed + 10, nucleus: 0.3 });
  cells.forEach((c, i) => {
    if (!inX(c)) return;
    const goblet = asthma ? i % 2 === 0 || i % 7 === 3 : i % 5 === 2;
    const n = c.poly.length / 2;
    const topEdge = c.poly.slice(0, n), botEdge = c.poly.slice(n).reverse();
    const at = (t, k) => [topEdge[k][0] + (botEdge[k][0] - topEdge[k][0]) * t, topEdge[k][1] + (botEdge[k][1] - topEdge[k][1]) * t];
    const mid = Math.floor(n / 2);
    if (goblet) {
      L.add("goblet", roundPoly(c.poly, 1.4));
      // mucin cup in the upper part, nucleus squeezed to the base
      const cup = [...topEdge.map((_, k) => at(0.08, k)), ...topEdge.map((_, k) => at(0.62, k)).reverse()];
      L.add("mucin", smoothClosed(cup.length > 6 ? cup.filter((_, k) => k % 2 === 0) : cup, 0.8));
      const b = at(0.8, mid);
      L.add("gobNuc", ellipse(b[0], b[1], 2.2, 1.1, c.nucleus.rot));
    } else {
      L.add("epi", roundPoly(c.poly, 0.9));
      const b = at(0.62 + (R() - 0.5) * 0.12, mid);
      L.add("epiNuc", ellipse(b[0], b[1], 1.6, 2.6, c.nucleus.rot));
      for (let k = 0; k < n; k++) {
        const p0 = topEdge[k], a = topEdge[Math.max(0, k - 1)], b2 = topEdge[Math.min(n - 1, k + 1)];
        const dx = b2[0] - a[0], dy = b2[1] - a[1], l = Math.hypot(dx, dy) || 1;
        const len = 6 + R() * 1.5, bend = 1.4;
        L.add("cilia", "M" + f2(p0[0]) + " " + f2(p0[1]) + "Q" + f2(p0[0] + (dy / l) * len * 0.5 + (dx / l) * bend) + " " + f2(p0[1] - (dx / l) * len * 0.5 + (dy / l) * bend) + " " + f2(p0[0] + (dy / l) * len) + " " + f2(p0[1] - (dx / l) * len));
      }
    }
  });
  if (asthma) {
    // mucus plug in the lumen, with trapped eosinophils and shed epithelium
    // the plug fills the lumen and rests on the cilia, dipping into the folds of the mucosa
    const xs0 = 44, xs1 = 266, topY = (x) => 11 + 2.5 * Math.sin(x / 19 + 1), botY = (x) => surfY(x) - 8.5;
    const bot = [], topE = [];
    for (let x = xs1; x >= xs0; x -= 4) bot.push([x, botY(x)]);
    for (let x = xs0; x <= xs1; x += 6) topE.push([x, topY(x)]);
    const plug = [...bot, [xs0 - 9, (botY(xs0) + topY(xs0)) / 2], ...topE, [xs1 + 9, (botY(xs1) + topY(xs1)) / 2]];
    L.add("mucus", smoothClosed(plug, 0.8));
    // laminated strands running along the plug
    for (const t of [0.22, 0.42, 0.62, 0.8]) {
      const pts = [];
      for (let x = xs0 + 12 + t * 10; x <= xs1 - 12 - t * 8; x += 8) pts.push([x, topY(x) + (botY(x) - topY(x)) * t + (R() - 0.5) * 2.5]);
      L.add("mucusStrand", smoothOpen(pts));
    }
    const midY = (x, t = 0.5) => topY(x) + (botY(x) - topY(x)) * t;
    for (const [x, t] of [[106, 0.5], [176, 0.36], [232, 0.55], [150, 0.68]]) eosinophil(L, [x, midY(x, t)], R, 0.75);
    // Creola bodies: compact clusters of shed ciliated epithelial cells
    for (const [x, t, a0] of [[78, 0.45, 20], [204, 0.6, -15]]) {
      const c = [x, midY(x, t)];
      for (const k of [0, 1, 2, 3]) {
        const a = ((a0 + k * 42 - 63) * Math.PI) / 180;
        const p = [c[0] + Math.cos(a) * 4.2, c[1] + Math.sin(a) * 4.2];
        L.add("shed", capsule(c[0] + Math.cos(a) * 0.5, c[1] + Math.sin(a) * 0.5, p[0] + Math.cos(a) * 2.2, p[1] + Math.sin(a) * 2.2, 2.3));
        L.add("epiNuc", ellipse(c[0] + Math.cos(a) * 2.6, c[1] + Math.sin(a) * 2.6, 1.6, 1.1, (a * 180) / Math.PI));
      }
    }
  }
  return clampScene({ size: [W, H], lineWidth: 1.2, parts: L.parts() }, [X0, 6, X1, Y1]);
}

export const icons = [
  {
    slug: "kidney-glomerulus-healthy",
    name: "Kidney cortex — healthy glomerulus",
    category: "tissues",
    tags: ["kidney", "renal", "glomerulus", "nephron", "Bowman's capsule", "podocyte", "mesangial cell", "proximal tubule", "distal tubule", "renal cortex", "afferent arteriole", "efferent arteriole", "vascular pole", "macula densa", "juxtaglomerular apparatus", "peritubular capillaries", "brush border", "H&E", "histology", "healthy", "tissue section"],
    scene: () => kidney(false),
  },
  {
    slug: "kidney-glomerulonephritis",
    name: "Kidney cortex — crescentic glomerulonephritis",
    category: "tissues",
    tags: ["kidney", "renal", "glomerulonephritis", "crescent", "lupus nephritis", "ANCA vasculitis", "IgA nephropathy", "nephritis", "proteinuria", "haematuria", "red cell cast", "cellular crescent", "RPGN", "rapidly progressive glomerulonephritis", "anti-GBM", "interstitial fibrosis", "tubular injury", "acute kidney injury", "CKD", "inflammation", "histology", "disease", "tissue section"],
    scene: () => kidney(true),
  },
  {
    slug: "bronchus-healthy",
    name: "Bronchus wall — healthy",
    category: "tissues",
    tags: ["bronchus", "airway", "lung", "respiratory epithelium", "pseudostratified", "ciliated", "goblet cell", "basement membrane", "airway smooth muscle", "submucosal gland", "cartilage", "histology", "healthy", "tissue section"],
    scene: () => bronchus(false),
  },
  {
    slug: "bronchus-asthma",
    name: "Bronchus wall — asthma (airway remodelling)",
    category: "tissues",
    tags: ["bronchus", "airway", "asthma", "airway remodelling", "mucus plug", "goblet cell hyperplasia", "eosinophil", "eosinophilic inflammation", "type 2 inflammation", "Th2", "mast cell", "subepithelial fibrosis", "thickened basement membrane", "airway smooth muscle hypertrophy", "bronchoconstriction", "histology", "disease", "tissue section"],
    scene: () => bronchus(true),
  },
];
