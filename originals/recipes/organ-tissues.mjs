// Organ tissues in healthy and disease states (Servier-style histology): artery, skin, lung,
// colon, liver, trabecular bone. Each pair shares its framing so the two sit side by side.
import { circle, ellipse, capsule, blob, blobPts, ribbon, rng, f, smoothClosed, smoothOpen, armsPts } from "../lib/geom.mjs";
import { shade, tint } from "../lib/style.mjs";
import {
  catmull, resample, arcLengths, cellBand, honeycomb, clipConvex, rectPoly, roundPoly, spindle, fibre, rbc,
  packIn, packWhere, inside, polyD, lineD, centroid, area, strip, shrink, lobes, normals, offsetClosed, signedArea,
} from "../lib/tissue.mjs";
import { C, Layers, sw, defineLayers, vessel, capillaryAlong, lymphocyte, plasmaCell, macrophage, neutrophil } from "../lib/histo.mjs";
import { fitInside, checkInside, flatten, edgeDistance, unevenSpacing, unevenAngles, clustered, vary } from "../lib/organic.mjs";

const R2D = 180 / Math.PI;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mean = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);

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

/** Occupancy grid (1-unit cells): mark polygons, then ask whether a disc is free. */
class Grid {
  constructor(w, h) {
    this.w = Math.ceil(w);
    this.h = Math.ceil(h);
    this.a = new Uint8Array(this.w * this.h);
  }
  mark(poly, grow = 0) {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - grow)), x1 = Math.min(this.w - 1, Math.ceil(Math.max(...xs) + grow));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - grow)), y1 = Math.min(this.h - 1, Math.ceil(Math.max(...ys) + grow));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (inside(poly, [x + 0.5, y + 0.5]) || (grow && poly.some((p) => Math.abs(p[0] - x - 0.5) + Math.abs(p[1] - y - 0.5) < grow))) this.a[y * this.w + x] = 1;
    }
  }
  disc(cx, cy, r) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x >= 0 && y >= 0 && x < this.w && y < this.h && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) this.a[y * this.w + x] = 1;
    }
  }
  free([cx, cy], r) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r && this.a[y * this.w + x]) return false;
    }
    return true;
  }
}

/** Drop inverted, collapsed or duplicated cells (where a lining band turns a tight corner). */
function cleanCells(cells) {
  const areas = cells.map((c) => signedArea(c.poly));
  const sgn = Math.sign(areas.reduce((a, b) => a + Math.sign(b), 0)) || 1;
  const med = areas.map(Math.abs).sort((a, b) => a - b)[Math.floor(areas.length / 2)];
  const kept = [];
  cells.forEach((c, i) => {
    if (Math.sign(areas[i]) !== sgn || Math.abs(areas[i]) < med * 0.35) return;
    const ctr = centroid(c.poly);
    if (kept.some((k) => dist(k.ctr, ctr) < 3)) return;
    kept.push({ ...c, ctr });
  });
  return kept;
}

/** Eosinophil: bilobed nucleus and orange granules (colours as in the library). */
function eosinophil(L, [x, y], R, s = 1) {
  L.add("eos", circle(x, y, 4.6 * s));
  L.add("eosGran", packIn(x, y, 3.4 * s, 3.4 * s, 8, 1.5 * s, { seed: Math.round(x * 13 + y) }).map(([gx, gy]) => circle(gx, gy, 0.7 * s)).join(""));
  L.add("eosNuc", lobes(x, y, 3 * s, 2, R() * 180));
}
/** Small lymphocyte and plasma cell at mucosal scale. */
function lymphS(L, [x, y], kind, R, r = 2.9) {
  r = vary(R, r, 0.1);
  L.add(kind === "B" ? "bcell" : "tcell", circle(x, y, r));
  L.add(kind === "B" ? "bnuc" : "tnuc", circle(x + (R() - 0.5) * r * 0.25, y + (R() - 0.5) * r * 0.25, r * 0.68));
}
function plasmaS(L, [x, y], R, s = 1) {
  const a = R() * 180, ar = a / R2D, rx = vary(R, 4.6, 0.1) * s, ry = rx * 0.7;
  L.add("plasma", ellipse(x, y, rx, ry, a));
  L.add("plasmaNuc", circle(x + Math.cos(ar) * (rx - 2.9 * s), y + Math.sin(ar) * (rx - 2.9 * s), 1.9 * s));
}
function neutS(L, [x, y], R, s = 1) {
  L.add("neut", circle(x, y, 4 * s));
  L.add("neutNuc", lobes(x, y, 2.9 * s, R() < 0.5 ? 3 : 4, R() * 360));
}
function macroS(L, [x, y], R, s = 1) {
  const r = vary(R, 5.6, 0.15) * s, seed = Math.floor(R() * 1e6);
  const pts = armsPts(x, y, r, { arms: 4 + Math.floor(R() * 3), reach: 0.18 + R() * 0.16, width: 0.55, seed, n: 5, rot: R() * 360 });
  L.add("mac", smoothClosed(pts, 0.9));
  let nuc = blobPts(x + (R() - 0.5) * r * 0.3, y + (R() - 0.5) * r * 0.3, r * 0.42, r * 0.3, { n: 8, wobble: 0.12, seed: seed + 1, rot: R() * 180 });
  nuc = fitInside(nuc, pts, 0.8) ?? nuc;
  L.add("macNuc", smoothClosed(nuc));
}

/** Define a subset of the standard histology layers (vessels, immune cells…) at this point in the stack. */
function std(L, keys) {
  const t = new Layers();
  defineLayers(t, C.matrix);
  for (const k of keys) {
    const { ds, ...st } = t.map.get(k);
    L.def(k, st);
  }
}
// artWall before lumen: the arteriole lumen must paint over its wall (definition order = paint order)
const BLOOD = ["artWall", "wall", "lumen", "rbc", "endo", "lymphWall", "lymphLumen"];
const IMMUNE = ["tcell", "tnuc", "bcell", "bnuc", "plasma", "plasmaNuc", "mac", "macNuc", "neut", "neutNuc"];

/** Wavy arc around (cx,cy) at radius r from a0 to a1 degrees. */
function arcFibre(cx, cy, r, a0, a1, amp = 1.2, waves = 3, phase = 0) {
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, a = ((a0 + (a1 - a0) * t) * Math.PI) / 180, rr = r + Math.sin(t * waves * Math.PI * 2 + phase) * amp;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return lineD(catmull(pts, 3));
}
const circlePts = (cx, cy, r, n = 120, dir = 1, wave = 0, waves = 0) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (dir * i * Math.PI * 2) / n, rr = r + (wave ? Math.sin(i * ((waves * Math.PI * 2) / n)) * wave : 0);
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  });

/* ===================== artery ===================== */

function artery(diseased, seed = 41) {
  const R = rng(seed), L = new Layers(), cx = 120, cy = 120;
  const col = { adv: "#f6dccb", media: "#ee9ca5", intima: "#f8d0d3", plaque: "#f4cfcb", core: "#f8dc8e", foam: "#f7c788", calc: "#ebe7dd" };
  L.def("advent", { fill: col.adv, stroke: sw(shade(col.adv, 0.14), 1), lineWidth: 1.2 })
    .def("adventFib", { fill: "none", stroke: { color: "#ebc1ad", width: 1.3, cap: "round" }, lineColor: "#d8a68e", lineStrokeWidth: 0.8 })
    .def("adventNuc", { fill: "#9b74b4", lineWidth: 0.4 });
  std(L, BLOOD);
  L.def("eel", { fill: "none", stroke: { color: "#f1dc95", width: 2.2 }, lineColor: "#cbb15b", lineStrokeWidth: 1 })
    .def("media", { fill: col.media, stroke: sw(shade(col.media, 0.14), 0.9), shade: "rim", lineWidth: 1.1 })
    .def("lamellae", { fill: "none", stroke: { color: "#f7c8cc", width: 1.1 }, lineColor: "#e3a0a8", lineStrokeWidth: 0.6 })
    .def("smcNuc", { fill: "#86589f", lineWidth: 0.4 })
    .def("iel", { fill: "none", stroke: { color: "#f6e7a6", width: 2.4 }, lineColor: "#d4bc60", lineStrokeWidth: 1 })
    .def("intima", { fill: diseased ? col.plaque : col.intima, stroke: sw(shade(col.intima, 0.14), 0.8), lineWidth: 0.9 })
    .def("core", { fill: col.core, stroke: sw(shade(col.core, 0.16), 0.9), shade: "small", lineWidth: 1 })
    .def("crystal", { fill: "#fffaf0", lineWidth: 0.45 })
    .def("capBand", { fill: "#e9a3ad", lineWidth: 0.6 })
    .def("capNuc", { fill: "#86589f", lineWidth: 0.3 })
    .def("foam", { fill: col.foam, stroke: sw(shade(col.foam, 0.16), 0.6), shade: "small", lineWidth: 0.7 })
    .def("foamVac", { fill: "#fff6df", lineWidth: 0.3 })
    .def("foamNuc", { fill: "#8b5aa0", lineWidth: 0.3 })
    .def("calc", { fill: col.calc, stroke: sw("#c9c3b3", 0.7), shade: "small", lineWidth: 0.8 })
    .def("blood", { fill: "#fbe1df", lineWidth: 0.7 })
    .def("endoCell", { fill: "#f5b8bf", stroke: sw(shade("#f5b8bf", 0.16), 0.6), lineWidth: 0.6 })
    .def("endoNuc", { fill: "#86589f", lineWidth: 0.3 })
    .def("plt", { fill: "#d9b3e6", lineWidth: 0.3 })
    .def("rbc2", { fill: C.rbc, shade: "small", lineWidth: 0.5 });
  std(L, ["neut", "neutNuc"]);

  L.add("advent", blob(cx, cy, 110, 106, { n: 16, wobble: 0.03, seed }));
  for (let k = 0; k < 20; k++) {
    const a0 = R() * 360, r = 90 + R() * 15;
    L.add("adventFib", arcFibre(cx, cy, r, a0, a0 + 24 + R() * 30, 1.4, 2, R() * 6));
  }
  for (let k = 0; k < 16; k++) {
    const a = R() * Math.PI * 2, r = 89 + R() * 16;
    L.add("adventNuc", ellipse(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3.2, 1.2, (a * 180) / Math.PI + 90));
  }
  vessel(L, { cx: cx - 72, cy: cy + 68, rx: 5, kind: "cap", seed: seed + 1 });
  vessel(L, { cx: cx + 84, cy: cy - 56, rx: 4.5, kind: "cap", seed: seed + 2 });
  L.add("eel", lineD(circlePts(cx, cy, 85, 140, 1, 0.8, 30)));
  L.add("media", circle(cx, cy, 84));
  // atherosclerosis: the plaque (upper left) pushes the internal elastic lamina outward, thinning the media under
  // it by about a third; elsewhere the wall is normal
  const plaqueDir = (225 * Math.PI) / 180;
  const bump = (a) => {
    const d = Math.abs((((a - plaqueDir) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    return d < 1.5 ? Math.cos(((d / 1.5) * Math.PI) / 2) ** 2 : 0;
  };
  const rInt = (a) => 51 + (diseased ? 9.5 * bump(a) : 0);
  const ringAt = (rOf, n = 160, wave = 0, waves = 0) => Array.from({ length: n + 1 }, (_, i) => {
    const a = (i * Math.PI * 2) / n, r = rOf(a) + (wave ? Math.sin(i * ((waves * Math.PI * 2) / n)) * wave : 0);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  for (const r of [60, 68, 76]) {
    // medial elastic lamellae, broken off where the plaque has thinned the media
    const pts = ringAt(() => r, 140, 0.7, 26);
    let run = [];
    const flush = () => {
      if (run.length > 4) L.add("lamellae", lineD(run));
      run = [];
    };
    pts.forEach((p) => (Math.hypot(p[0] - cx, p[1] - cy) > rInt(Math.atan2(p[1] - cy, p[0] - cx)) + 4 ? run.push(p) : flush()));
    flush();
  }
  for (const r of [56, 64, 72, 80]) {
    const n = Math.round(r / 3.4);
    for (let i = 0; i < n; i++) {
      // circumferential smooth-muscle nuclei: staggered, uneven in spacing, depth and length
      if (R() < 0.12) continue;
      const a = ((i + (r % 8 ? 0.5 : 0) + (R() - 0.5) * 0.75) / n) * Math.PI * 2, rr = r + (R() - 0.5) * 4.4;
      if (rr < rInt(a) + 3.5) continue;
      L.add("smcNuc", ellipse(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, vary(R, 4, 0.22), vary(R, 1.15, 0.15), (a * 180) / Math.PI + 90 + (R() - 0.5) * 14));
    }
  }
  L.add("iel", lineD(ringAt((a) => rInt(a) + 1, 160, 1.4, 40)));
  L.add("intima", polyD(ringAt(rInt, 160).slice(0, -1)));

  // lumen: concentric when healthy; in atherosclerosis an eccentric D, its round side against the thin plaque-free
  // wall, its flat side the fibrous cap of the plaque bulging into it
  const d45 = [Math.SQRT1_2, Math.SQRT1_2];
  let lumen;
  if (!diseased) lumen = circlePts(cx, cy, 47, 160, -1).slice(0, -1);
  else {
    const a0 = (-40 * Math.PI) / 180, a1 = (130 * Math.PI) / 180, arc = [];
    for (let k = 0; k <= 60; k++) { const a = a0 + ((a1 - a0) * k) / 60; arc.push([cx + Math.cos(a) * 46, cy + Math.sin(a) * 46]); }
    const E1 = arc[arc.length - 1], E0 = arc[0], cap = [];
    for (let k = 1; k < 40; k++) { const t = k / 40, b = 7.5 * Math.sin(Math.PI * t); cap.push([E1[0] + (E0[0] - E1[0]) * t + d45[0] * b, E1[1] + (E0[1] - E1[1]) * t + d45[1] * b]); }
    lumen = [...arc, ...cap];
    for (let pass = 0; pass < 4; pass++) lumen = lumen.map((q, i) => { const a = lumen[(i - 1 + lumen.length) % lumen.length], b = lumen[(i + 1) % lumen.length]; return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4]; });
    lumen = lumen.slice().reverse();
    // the plaque: a necrotic lipid core (yellow) right under the fibrous cap, cholesterol clefts in it, foam cells at
    // its shoulders, calcification at its base, a neovessel
    const corePoly = catmull([[86, 104], [100, 87], [122, 81], [142, 88], [151, 106], [133, 113], [113, 121], [97, 125]], 6, true);
    L.add("core", polyD(corePoly));
    const GK = rng(seed + 77);
    let made = 0;
    for (let t = 0; t < 200 && made < 6; t++) {
      const p = [96 + GK() * 48, 89 + GK() * 28], a = (-25 + GK() * 50 + (GK() < 0.3 ? 60 : 0)) * (Math.PI / 180), l = vary(GK, 5.5, 0.25), w = vary(GK, 0.75, 0.15);
      const pts = [];
      for (let k = 0; k <= 10; k++) pts.push([(k / 5 - 1) * l, -w * Math.pow(Math.sin((Math.PI * k) / 10), 0.6)]);
      for (let k = 9; k >= 1; k--) pts.push([(k / 5 - 1) * l, w * Math.pow(Math.sin((Math.PI * k) / 10), 0.6)]);
      const poly = pts.map(([x, y]) => [p[0] + x * Math.cos(a) - y * Math.sin(a), p[1] + x * Math.sin(a) + y * Math.cos(a)]);
      if (!checkInside(poly, corePoly, 1.4).ok) continue;
      if (L.map.get("crystal").ds.some((d) => flatten(d)[0].some((q) => poly.some((r) => dist(q, r) < 2.2)))) continue;
      L.add("crystal", polyD(poly));
      made++;
    }
    for (const [x, y] of [[76, 114], [88, 130], [142, 76], [150, 90], [70, 98]]) {
      L.add("foam", circle(x, y, 6.2));
      for (const [vx, vy] of packIn(x, y, 3.8, 3.8, 5, 2.2, { seed: Math.round(x * y) })) L.add("foamVac", circle(vx, vy, 1.1));
      L.add("foamNuc", ellipse(x + 2.6, y + 2.6, 1.8, 1.2, 45));
    }
    L.add("calc", blob(100, 76, 7, 3.6, { n: 8, wobble: 0.3, seed: seed + 5, rot: -30 }) + blob(126, 72, 5, 3, { n: 7, wobble: 0.3, seed: seed + 6, rot: 10 }));
    vessel(L, { cx: 98, cy: 134, rx: 3.6, kind: "cap", seed: seed + 7 });
    // fibrous cap: a dense collagenous band (5–7 thick) between the core and the lumen, with flat smooth-muscle
    // nuclei parallel to the lumen
    const capIn = [], capOut = [];
    for (let k = 0; k <= 30; k++) {
      const t = 0.06 + (0.88 * k) / 30, b = 7.5 * Math.sin(Math.PI * t), th = 9.6 * Math.pow(Math.sin(Math.PI * (k / 30)), 0.45);
      const p = [E1[0] + (E0[0] - E1[0]) * t + d45[0] * b, E1[1] + (E0[1] - E1[1]) * t + d45[1] * b];
      capIn.push([p[0] + d45[0] * 0.3, p[1] + d45[1] * 0.3]);
      capOut.push([p[0] - d45[0] * th, p[1] - d45[1] * th]);
    }
    L.add("capBand", smoothClosed([...capIn, ...capOut.reverse()].filter((_, k) => k % 2 === 0), 0.8));
    const ang = (Math.atan2(E0[1] - E1[1], E0[0] - E1[0]) * 180) / Math.PI;
    for (const t of unevenSpacing(5, 1, R, { cv: 0.3, start: 0.2, end: 0.8 })) {
      const b = 7.5 * Math.sin(Math.PI * t), o = 6.4 + (R() - 0.5) * 1.4;
      const p = [E1[0] + (E0[0] - E1[0]) * t + d45[0] * (b - o), E1[1] + (E0[1] - E1[1]) * t + d45[1] * (b - o)];
      L.add("capNuc", ellipse(p[0], p[1], vary(R, 3.4, 0.15), 0.85, ang + (R() - 0.5) * 10));
    }
  }
  L.add("blood", polyD(lumen));
  // endothelium lining the lumen (a ring of flat cells)
  let endo = cellBand([...lumen, lumen[0]], { rows: 1, thickness: 3.4, cellLen: 9, jitter: 0.2, seed });
  if (endo.length && inside(lumen, centroid(endo[0].poly))) endo = cellBand([...lumen, lumen[0]].reverse(), { rows: 1, thickness: 3.4, cellLen: 9, jitter: 0.2, seed });
  for (const c of endo) {
    L.add("endoCell", roundPoly(c.poly, 0.8));
    L.add("endoNuc", ellipse(c.nucleus.cx, c.nucleus.cy, 2.6, 0.9, c.nucleus.rot));
  }
  const [lx, ly, lr] = diseased ? [138, 138, 20] : [cx, cy, 47];
  for (const p of packIn(lx, ly, lr * 0.62, lr * 0.62, diseased ? 5 : 11, 9, { seed: seed + 9 })) L.add("rbc2", rbc(p[0], p[1], 3.6, R() * 180));
  for (const p of packIn(lx, ly, lr * 0.7, lr * 0.7, diseased ? 2 : 4, 7, { seed: seed + 10, avoid: [] })) L.add("plt", ellipse(p[0], p[1], 1.6, 1.1, R() * 180));
  if (!diseased) neutrophil(L, [cx + 20, cy - 18], R);
  return { size: [240, 240], lineWidth: 1.3, parts: L.parts() };
}

/* ===================== skin ===================== */

// Skin (320 × 240), one framing for both states. Plan, bottom → top: dermis → reticular dermis (a diffuse
// zone, no outline) → collagen bundles (fine and loose in the papillary dermis, long coarse wavy bundles of
// 2–3 strands in the reticular dermis) → fat → vessels (deep plexus, an undulating subpapillary plexus that
// leaves the frame, capillary loops of uneven height in the dermal papillae) → adnexa (an obliquely cut hair
// follicle with its sebaceous gland on the left, an eccrine sweat coil by the fat on the right; same x
// positions in both states, at the same relative depth) → fibroblasts, immune cells → epidermis (basal,
// spinous, granular cells) → stratum corneum (parakeratotic scale with Munro microabscesses in psoriasis).
// Psoriasis: acanthosis with long regular rete ridges, thin suprapapillary plates, no granular layer,
// parakeratosis, Munro microabscesses (6–10 neutrophils), dilated tortuous papillary capillaries, T cells and
// dendritic cells round the vessels.
function skin(psoriasis, seed = 51) {
  const R = rng(seed), L = new Layers();
  const W = 320, X0 = 8, X1 = 312, YB = 232;
  const pal = {
    corneum: "#f6ccbb", granular: "#f9e4d6", spinous: "#f6d6c8", basal: "#efbfb3", melano: "#c99b7a", derm: "#fbe2df", reticular: "#f7d6d3", nuc: "#7a52a2",
    ors: "#f3d6cc", irs: "#e9a2a6", hair: "#9a7452", ctSheath: "#f2c8c6", seb: "#f0dfc4", sebCell: "#fcf6ea", sebNuc: "#8f6aa8",
    eccrine: "#f3dbe5", eccDuct: "#e7b0c4", eccNuc: "#7d55a6",
  };
  L.def("dermis", { fill: pal.derm, stroke: sw(shade(pal.derm, 0.1), 1), lineWidth: 1.2 })
    .def("reticular", { fill: pal.reticular, lineWidth: 0.6, line: false })
    .def("bundle", { fill: "none", stroke: { color: "#ecb6b6", width: 2.1, cap: "round" }, lineColor: "#d9a0a3", lineStrokeWidth: 0.9 })
    .def("collagen", { fill: "none", stroke: { color: "#efc3c2", width: 0.95, cap: "round" }, lineColor: "#dca5a8", lineStrokeWidth: 0.6 })
    .def("fat", { fill: C.fat, stroke: sw(C.fatBorder, 1.2), lineWidth: 1 });
  std(L, [...BLOOD, "fibro", "fibroNuc", ...IMMUNE]);
  L.def("capWall", { fill: C.wall, stroke: sw(shade(C.wall, 0.16), 0.7), lineWidth: 0.8, unite: [] })
    .def("capLumen", { fill: C.lumen, lineWidth: 0.4, unite: [] })
    .def("capRbc", { fill: C.rbc, shade: "small", lineWidth: 0.4 })
    // adnexa
    .def("ctSheath", { fill: pal.ctSheath, lineWidth: 0.6 })
    .def("ors", { fill: pal.ors, stroke: sw(shade(pal.ors, 0.14), 0.6), shade: "rim", lineWidth: 0.7 })
    .def("orsNuc", { fill: pal.nuc, lineWidth: 0.25 })
    .def("irs", { fill: pal.irs, lineWidth: 0.4 })
    .def("hair", { fill: pal.hair, shade: "small", lineWidth: 0.5 })
    .def("seb", { fill: pal.seb, stroke: sw(shade(pal.seb, 0.14), 0.6), shade: "rim", lineWidth: 0.7, unite: [] })
    .def("sebCell", { fill: pal.sebCell, lineWidth: 0.3 })
    .def("sebNuc", { fill: pal.sebNuc, lineWidth: 0.2 })
    .def("eccrine", { fill: pal.eccrine, stroke: sw(shade(pal.eccrine, 0.14), 0.5), shade: "small", lineWidth: 0.55 })
    .def("eccDuct", { fill: pal.eccDuct, stroke: sw(shade(pal.eccDuct, 0.14), 0.5), shade: "small", lineWidth: 0.55 })
    .def("eccNuc", { fill: pal.eccNuc, lineWidth: 0.22 })
    .def("eccLumen", { fill: "#fffafb", lineWidth: 0.3 });
  L.def("dc", { fill: "#aee0d6", stroke: sw(shade("#aee0d6", 0.18), 0.6), shade: "small", lineWidth: 0.6 })
    .def("dcNuc", { fill: "#5f7fb8", lineWidth: 0.3 })
    .def("epidermis", { fill: pal.spinous, stroke: sw(shade(pal.spinous, 0.16), 0.8), lineWidth: 1 })
    .def("spinous", { fill: pal.spinous, stroke: sw(shade(pal.spinous, 0.15), 0.7), lineWidth: 0.6 })
    .def("granular", { fill: pal.granular, stroke: sw(shade(pal.granular, 0.15), 0.7), lineWidth: 0.6 })
    .def("kgran", { fill: "#6d4f8f", lineWidth: 0.2 })
    .def("basal", { fill: pal.basal, stroke: sw(shade(pal.basal, 0.15), 0.7), lineWidth: 0.6 })
    .def("melano", { fill: pal.melano, stroke: sw(shade(pal.melano, 0.15), 0.7), lineWidth: 0.6 })
    .def("epiNuc", { fill: pal.nuc, shade: "small", lineWidth: 0.35 })
    .def("corneum", { fill: pal.corneum, stroke: sw(shade(pal.corneum, 0.14), 0.8), lineWidth: 0.9 })
    .def("flakes", { fill: "none", stroke: { color: shade(pal.corneum, 0.1), width: 0.9 }, lineColor: shade(pal.corneum, 0.35), lineStrokeWidth: 0.5 })
    .def("paraNuc", { fill: "#7d5a92", lineWidth: 0.2 })
    .def("munro", { fill: C.neut, shade: "small", lineWidth: 0.45 })
    .def("munroNuc", { fill: C.neutNuc, lineWidth: 0.25 });

  // skin surface and the dermo-epidermal junction (rete ridges dip down, dermal papillae rise)
  const sy = (x) => (psoriasis ? 34 : 40) + 3 * Math.sin(x / 31);
  const surface = resample(catmull([X0, 60, 104, 152, 200, 248, X1].map((x) => [x, sy(x)]), 14), 1.4);
  const ridges = psoriasis ? 7 : 9;
  const uu = (x) => (x - X0) / (X1 - X0);
  // rete ridges of uneven width and depth (psoriasis: regular elongation, only slightly varied)
  const wave = (x) => 0.5 + 0.5 * Math.cos(uu(x) * Math.PI * ridges * 2 + 0.6 + (psoriasis ? 0.25 : 0.7) * Math.sin(uu(x) * 7.3 + 1.1)); // 1 = ridge, 0 = papilla
  const amp = (x) => 1 + (psoriasis ? 0.08 : 0.22) * Math.sin(uu(x) * 11.7 + 2.3);
  const jy = psoriasis
    ? (x) => sy(x) + 22 + 92 * amp(x) * Math.pow(wave(x), 0.45) // long, club-shaped ridges; thin suprapapillary plates
    : (x) => sy(x) + 34 + 18 * amp(x) * Math.pow(wave(x), 0.85);
  // subpapillary plexus: a vessel running in the plane of the section beneath the rete ridges, undulating
  const plexY = (x) => (psoriasis ? 168 : 107) + 3.6 * Math.sin(x / 41 + 0.8) + 1.8 * Math.sin(x / 15 + 2.1);
  const junction = [];
  for (let x = X0; x <= X1 + 0.01; x += 1.2) junction.push([x, jy(x)]);
  const epiPoly = [...surface, ...junction.slice().reverse()];
  const distJ = (p) => Math.min(...junction.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
  const below = (p, m = 4) => p[1] > jy(p[0]) + m && p[0] > X0 + m && p[0] < X1 - m && p[1] < YB - m;

  // adnexa: same x positions in both states, at the same relative depth in the dermis
  const fol = { c: [54, psoriasis ? 189 : 150], rx: 15, ry: 9.5, rot: -26 };
  const sebC = [fol.c[0] + 27, fol.c[1] - 1];
  const coilC = [262, psoriasis ? 194 : 184];
  const adnexa = [[fol.c[0], fol.c[1], 18], [sebC[0], sebC[1], 13], [coilC[0], coilC[1], 20]];
  const nearAdnexa = (p, m = 0) => adnexa.some(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) < r + m);

  L.add("dermis", polyD([...surface, [X1, YB], [X0, YB]]));
  const retY = psoriasis ? 176 : 117;
  L.add("reticular", polyD([...catmull([[X0, retY], [80, retY - 4], [160, retY + 3], [240, retY - 3], [X1, retY + 2]], 10), [X1, YB], [X0, YB]]));
  const fatTop = (x) => (psoriasis ? 212 : 202) + 6 * Math.sin(x / 29);
  for (const c of honeycomb(X0, 186, W, 60, 10.5, { seed: seed + 3 })) {
    if (c.poly.some(([x, y]) => y < fatTop(x))) continue;
    const poly = clipConvex(c.poly, rectPoly(X0, 0, X1 - X0, YB));
    if (poly.length > 2 && area(poly) > 25 && !poly.some((p) => nearAdnexa(p, 1))) L.add("fat", roundPoly(poly, 3));
  }
  // deep plexus vessels (cut across), clear of the adnexa
  const plexus = psoriasis ? [[118, 190, 7.5], [184, 186, 7], [222, 200, 6]] : [[112, 160, 8], [182, 152, 7], [222, 170, 6]];
  const freeDeep = (p, m) => !nearAdnexa(p, m) && !plexus.some(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) < r * 1.3 + m) && Math.abs(p[1] - plexY(p[0])) > 5 + m;
  // collagen: long coarse wavy bundles of 2–3 strands in the reticular dermis …
  const GB = rng(seed + 21);
  for (const y0 of unevenSpacing(psoriasis ? 4 : 6, (psoriasis ? 206 : 197) - (retY + 6), GB, { cv: 0.3 }).map((v) => v + retY + 6)) {
    const x0 = X0 - 20 + GB() * 90, len = 130 + GB() * 140, tilt = (GB() - 0.5) * 0.12, ph = GB() * 6, strands = GB() < 0.5 ? 2 : 3;
    for (let k = 0; k < strands; k++) {
      const pts = [];
      for (let x = x0; x <= Math.min(X1 + 10, x0 + len); x += 2) pts.push([x, y0 + (x - x0) * tilt + 3.2 * Math.sin(x / 23 + ph) + (k - (strands - 1) / 2) * 2.6 + 0.6 * Math.sin(x / 7 + k)]);
      let run = [];
      const flush = () => {
        if (run.length > 6) L.add("bundle", smoothOpen(run.filter((_, i) => i % 2 === 0 || i === run.length - 1)));
        run = [];
      };
      for (const p of pts) (below(p, 6) && p[1] < fatTop(p[0]) - 3 && freeDeep(p, 2.5) ? run.push(p) : flush());
      flush();
    }
  }
  // … and a few fine, loose fibres in the papillary dermis, following the junction
  for (const [off, ph] of [[7, 0.3], [12, 2.2], [17, 4.1]]) {
    const pts = junction.filter((_, i) => i % 3 === 0).map(([x, y]) => [x, Math.min(y + off, plexY(x) - 5) + 1.2 * Math.sin(x / 9 + ph)]);
    let run = [];
    const flush = () => {
      if (run.length > 5) L.add("collagen", smoothOpen(run));
      run = [];
    };
    for (const p of pts) (below(p, 4) && p[1] < plexY(p[0]) - 4 && !nearAdnexa(p, 2) ? run.push(p) : flush());
    flush();
  }

  // capillary loops: hairpins rising from the subpapillary plexus into most dermal papillae, their tips at uneven
  // heights under the epidermis (dilated, tortuous and in every papilla in psoriasis); one united network
  const capW = L.map.get("capWall").unite, capL = L.map.get("capLumen").unite;
  const plex = [];
  for (let x = X0 - 6; x <= X1 + 6.01; x += 3) plex.push([x, plexY(x)]);
  const rwP = psoriasis ? 3.3 : 2.6;
  capW.push(ribbon(plex, rwP * 2));
  capL.push(ribbon(plex, (rwP - 1) * 2));
  for (let k = 3; k < plex.length - 3; k += 6 + Math.floor(R() * 5)) L.add("capRbc", ellipse(plex[k][0], plex[k][1], 1.6, rwP - 1.2, Math.atan2(plex[k + 1][1] - plex[k - 1][1], plex[k + 1][0] - plex[k - 1][0]) * R2D));
  const tips = junction.filter((p, i) => i > 3 && i < junction.length - 4 && [-3, -2, -1, 1, 2, 3].every((d) => junction[i + d][1] > p[1]));
  for (const [tx, ty] of tips) {
    if (tx < X0 + 9 || tx > X1 - 9 || (!psoriasis && R() < 0.25) || nearAdnexa([tx, plexY(tx)], 3)) continue;
    const half = psoriasis ? vary(R, 3.6, 0.12) : vary(R, 2.1, 0.2), rw = psoriasis ? 2.6 : 1.7;
    const top = ty + (psoriasis ? 5.5 + R() * 6 : 4.8 + R() * 9), bot = plexY(tx), lean = (R() - 0.5) * 3, ph = R() * 6;
    // psoriasis: tortuous limbs (several bends along the loop); healthy: nearly straight
    const wig = psoriasis ? 1.9 : 0.4, nW = psoriasis ? 4.5 : 1.2;
    const path = [];
    const limb = (side, t) => [tx + side * half + lean * t + Math.sin(t * nW * Math.PI * 2 + ph + side * 0.7) * wig, bot + (top + half - bot) * t];
    for (let k = 0; k <= 16; k++) path.push(limb(-1, k / 16));
    for (let k = 1; k < 8; k++) {
      const a = Math.PI + (k / 8) * Math.PI;
      path.push([tx + lean + Math.sin(nW * Math.PI * 2 + ph) * wig * 0 + Math.cos(a) * half, top + half + Math.sin(a) * half]);
    }
    for (let k = 16; k >= 0; k--) path.push(limb(1, k / 16));
    capW.push(ribbon(path, rw * 2));
    capL.push(ribbon(path, (rw - 0.9) * 2));
    for (let k = 4; k < path.length - 3; k += psoriasis ? 5 : 10) L.add("capRbc", ellipse(path[k][0], path[k][1], 1.2, rw - 1, 0));
  }
  for (const [x, y, r] of plexus) vessel(L, { cx: x, cy: y, rx: r * 1.3, ry: r, kind: "ven", rbcs: 2, seed: seed + x });

  /* --- adnexa --- */
  {
    // hair follicle cut obliquely: connective-tissue sheath, outer root sheath (pale keratinocytes), inner root
    // sheath (eosinophilic), pigmented hair shaft
    const { c, rx, ry, rot } = fol;
    L.add("ctSheath", ellipse(c[0], c[1], rx + 1.6, ry + 1.6, rot));
    L.add("ors", ellipse(c[0], c[1], rx, ry, rot));
    for (const a of unevenSpacing(16, 360, R, { cv: 0.25 })) {
      const ar = (a * Math.PI) / 180, rr = (rot * Math.PI) / 180, k = 0.72 + R() * 0.12;
      const lx = Math.cos(ar) * rx * k, ly = Math.sin(ar) * ry * k;
      L.add("orsNuc", ellipse(c[0] + lx * Math.cos(rr) - ly * Math.sin(rr), c[1] + lx * Math.sin(rr) + ly * Math.cos(rr), 1.5, 1.05, a + rot));
    }
    L.add("irs", ellipse(c[0] + 0.6, c[1] - 0.3, rx * 0.47, ry * 0.5, rot));
    L.add("hair", ellipse(c[0] + 0.6, c[1] - 0.3, rx * 0.32, ry * 0.34, rot));
    // sebaceous gland: lobules of pale foamy sebocytes with small central nuclei, its short duct opening into the follicle
    const seb = L.map.get("seb").unite;
    const lobes = [[sebC[0] - 2, sebC[1] - 3, 7.5, 6], [sebC[0] + 6, sebC[1] + 2, 6.5, 5.5], [sebC[0] - 3, sebC[1] + 5, 6, 4.8]];
    for (const [x, y, a, b] of lobes) seb.push(blob(x, y, a, b, { n: 8, wobble: 0.08, seed: Math.round(x * 3 + y) }));
    seb.push(capsule(sebC[0] - 6, sebC[1] + 1, fol.c[0] + rx * 0.72, fol.c[1] - 2.5, 2.6)); // duct to the follicle
    for (const [x, y, a, b] of lobes) {
      for (const q of packIn(x, y, a - 2.2, b - 2.2, 7, 3.5, { seed: Math.round(x * 7 + y) })) {
        L.add("sebCell", blob(q[0], q[1], 1.75, 1.55, { n: 6, wobble: 0.1, seed: Math.round(q[0] * 11 + q[1]) }));
        L.add("sebNuc", circle(q[0], q[1], 0.55));
      }
    }
    // eccrine sweat coil: a cluster of tubule profiles, pale secretory coil and darker two-layered duct
    const GE = rng(seed + 61), profs = [{ c: coilC, r: 6.2 }];
    for (let t = 0; t < 800 && profs.length < 7; t++) {
      const b = profs[Math.floor(GE() * profs.length)], r = vary(GE, 5.8, 0.15), a = GE() * Math.PI * 2, d = b.r + r + 0.4 + GE() * 0.8;
      const p = [b.c[0] + Math.cos(a) * d, b.c[1] + Math.sin(a) * d];
      if (dist(p, coilC) > 15 || profs.some((o) => dist(o.c, p) < o.r + r + 0.3)) continue;
      profs.push({ c: p, r });
    }
    profs.forEach((pf, k) => {
      const duct = k === 1 || k === 4, rot2 = GE() * 180, ry2 = pf.r * vary(GE, 0.8, 0.1);
      L.add(duct ? "eccDuct" : "eccrine", ellipse(pf.c[0], pf.c[1], pf.r, ry2, rot2));
      const lr = duct ? 1.3 : 1.9;
      const n = duct ? 9 : 7;
      for (const a of unevenSpacing(n, 360, GE, { cv: 0.2 })) {
        const ar = (a * Math.PI) / 180, rr = (rot2 * Math.PI) / 180;
        for (const kk of duct ? [0.5, 0.8] : [0.68]) {
          if (duct && kk === 0.8 && GE() < 0.4) continue;
          const lx = Math.cos(ar) * pf.r * kk, ly = Math.sin(ar) * ry2 * kk;
          L.add("eccNuc", circle(pf.c[0] + lx * Math.cos(rr) - ly * Math.sin(rr), pf.c[1] + lx * Math.sin(rr) + ly * Math.cos(rr), duct ? 0.8 : 0.95));
        }
      }
      L.add("eccLumen", ellipse(pf.c[0], pf.c[1], lr, lr * 0.85, rot2));
    });
  }

  for (const p of packWhere({ x: X0, y: 90, w: W, h: 110 }, 7, 36, (q) => below(q, 8) && q[1] < fatTop(q[0]) - 8 && freeDeep(q, 12), { seed: seed + 6 })) {
    const a = -20 + R() * 40;
    L.add("fibro", spindle(p[0], p[1], 28, 5.5, a));
    L.add("fibroNuc", ellipse(p[0], p[1], 3.8, 1.7, a));
  }
  if (psoriasis) {
    for (const [vx, vy] of plexus) for (const p of packIn(vx, vy, 30, 16, 12, 8.4, { seed: seed + vx, avoid: [[vx, vy, 14]] })) if (below(p, 6) && !nearAdnexa(p, 5) && Math.abs(p[1] - plexY(p[0])) > 7) lymphocyte(L, p, 3.9, "T", R);
    for (const p of packWhere({ x: X0, y: 80, w: W, h: 100 }, 6, 30, (q) => below(q, 8) && distJ(q) > 10 && q[1] < fatTop(q[0]) - 8 && freeDeep(q, 8), { seed: seed + 8 })) {
      L.add("dc", blob(p[0], p[1], 8, 6, { n: 10, wobble: 0.45, seed: Math.round(p[0]) }));
      L.add("dcNuc", ellipse(p[0], p[1], 2.6, 2, 0));
    }
  }

  // epidermis: polygonal keratinocytes over the region, flattening towards the surface
  L.add("epidermis", polyD(epiPoly));
  const cs = psoriasis ? 6.4 : 6.8;
  for (const c of honeycomb(X0 - 6, 20, W + 12, psoriasis ? 160 : 70, cs, { seed: seed + 11, jitter: 0.3 })) {
    const ctr = centroid(c.poly);
    if (!inside(epiPoly, ctr) || !c.poly.every((p) => inside(epiPoly, p)) || distJ(ctr) < 9.5) continue;
    const depth = ctr[1] - sy(ctr[0]);
    const granular = !psoriasis && depth < 11;
    // upper cells are flattened parallel to the surface
    const flat = Math.max(0.55, Math.min(1, depth / 26));
    const poly = c.poly.map(([x, y]) => [x, ctr[1] + (y - ctr[1]) * flat]);
    L.add(granular ? "granular" : "spinous", roundPoly(poly, 1.6));
    L.add("epiNuc", ellipse(ctr[0], ctr[1], granular ? 2.2 : 2.4, (granular ? 1.1 : 2) * Math.max(0.7, flat), 0));
    if (granular) for (const [gx, gy] of packIn(ctr[0], ctr[1], 4, 2, 3, 1.8, { seed: Math.round(ctr[0] * 3) })) L.add("kgran", circle(gx, gy, 0.55));
  }
  // basal layer: one row of columnar cells standing on the junction
  for (const c of cellBand(junction.slice().reverse(), { rows: 1, thickness: 9, cellLen: 6.2, jitter: 0.2, seed: seed + 12, nucleus: 0.42 }).filter((c) => c.poly.every(([x]) => x >= X0 + 0.3 && x <= X1 - 0.3))) {
    L.add(R() < 0.07 ? "melano" : "basal", roundPoly(c.poly, 1.2));
    const n = c.nucleus;
    L.add("epiNuc", ellipse(n.cx, n.cy, n.ry * 0.9, n.rx * 0.9, n.rot));
  }

  // stratum corneum: thin basket-weave keratin; thick parakeratotic scale in psoriasis
  const above = surface.slice().reverse();
  const ct = psoriasis ? 17 : 5.5;
  const ctAt = (u) => ct * (psoriasis ? 0.85 + 0.3 * Math.sin(u * 17) : 1);
  L.add("corneum", polyD(strip(above, ctAt)));
  for (let k = 1; k < (psoriasis ? 5 : 3); k++) L.add("flakes", lineD(strip(above, (ct * k) / (psoriasis ? 5 : 3)).slice(above.length)));
  if (psoriasis) {
    // Munro microabscesses: clusters of 6–10 neutrophils inside the parakeratotic scale
    const munro = [[88, 8, 13.5, 3.6], [218, 8, 14.5, 3.6]];
    const inMunro = (q) => munro.some(([x, d, a, b]) => ((q[0] - x) / (a + 3)) ** 2 + ((q[1] - (sy(x) - d)) / (b + 3)) ** 2 < 1);
    for (const p of packWhere({ x: X0 + 3, y: 10, w: X1 - X0 - 6, h: 30 }, 30, 9, (q) => q[1] < sy(q[0]) - 2 && q[1] > sy(q[0]) - ct + 3 && !inMunro(q), { seed: seed + 9 })) L.add("paraNuc", ellipse(p[0], p[1], 2.4, 0.8, 0));
    for (const [x, d, a, b] of munro) {
      for (const p of packIn(x, sy(x) - d, a, b, 9, 4.9, { seed: seed + x })) {
        L.add("munro", circle(p[0], p[1], vary(R, 2.6, 0.08)));
        L.add("munroNuc", lobes(p[0], p[1], 1.95, R() < 0.5 ? 3 : 4, R() * 360));
      }
    }
  }
  return clampScene({ size: [320, 240], lineWidth: 1.3, parts: L.parts() }, [X0, 0, X1, YB]);
}


/* ===================== lung ===================== */

// Lung parenchyma (300 × 240), one geometry for all three states. Plan, bottom → top:
//   septal tissue (base) → dense scar (fibrosis) → septal collagen → bronchovascular bundle
//   (bronchiole: muscle, epithelium, lumen; pulmonary artery branch) → fibroblasts → airspaces
//   (one united part: alveoli of uneven size + an alveolar duct whose septa end in knobs) →
//   septal capillary RBCs → type I nuclei → type II pneumocytes at septal junctions → alveolar
//   macrophages → exudate (neutrophils, fibrin, RBCs) / honeycomb cysts and a fibroblastic focus.
// Alveoli come from a multiplicatively weighted (Apollonius) partition of sites of very different size,
// so the thin septa are curved arcs, big alveoli bulge into small ones, and openings with knobbed free
// septal tips (alveolar ducts and sacs) turn the foam into lace.
// Pneumonia: congested septa; alveoli flooded with proteinaceous exudate, neutrophils, fibrin strands,
// a few RBCs and macrophages; pus in the bronchiole (bronchopneumonia). Architecture preserved.
// Fibrosis (UIP/IPF pattern): patchy — dense subpleural-like scar with honeycomb cysts (bronchiolar
// lining, mucus) round the bundle, a fibroblastic focus at the leading edge, thickened septa with
// collagen and fibroblasts in between, near-normal alveoli in the far corner.

function clipHalf(poly, m, n) {
  const out = [];
  const val = (p) => (p[0] - m[0]) * n[0] + (p[1] - m[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], vp = val(p), vq = val(q);
    if (vp <= 0) out.push(p);
    if ((vp <= 0) !== (vq <= 0)) {
      const t = vp / (vp - vq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}
/** Convex polygon moved in by d on every side (null if it vanishes). */
function insetConvex(poly, d) {
  const sgn = signedArea(poly) > 0 ? 1 : -1;
  let out = poly;
  for (let i = 0; i < poly.length && out.length > 2; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
    const nx = (sgn * -ey) / l, ny = (sgn * ex) / l;
    out = clipHalf(out, [a[0] + nx * d, a[1] + ny * d], [-nx, -ny]);
  }
  return out.length > 2 && area(out) > 20 ? out : null;
}
/**
 * Multiplicatively weighted Voronoi (Apollonius) cells by ray casting from each site: the wall between
 * sites i and j is where d(p, si)/wi = d(p, sj)/wj, a circular arc. Returns per-site boundary polygons
 * (nRays points) and, for each boundary point, the neighbour that bounds it (-1 = frame).
 */
function apollonius(sites, w, [bx, by, bw, bh], nRays = 120) {
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
        if (c > 160 * 160) continue;
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
      poly.push([s[0] + u[0] * best, s[1] + u[1] * best]);
      own.push(who);
    }
    cells.push(poly);
    owners.push(own);
  });
  return { cells, owners };
}
/** A cell polygon moved inward by d (thicker at the junctions), corners rounded by smoothing; null if it vanishes. */
function insetCell(poly, d) {
  let p = offsetClosed(poly, -d);
  for (let pass = 0; pass < 9; pass++) p = p.map((q, i) => {
    const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
    return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
  });
  p = p.filter((_, i) => i % 2 === 0);
  return p.length > 5 && area(p) > 30 ? p : null;
}
/** Chaikin corner cutting (closed polygon). */
const chaikin = (p) => p.flatMap((a, i) => {
  const b = p[(i + 1) % p.length];
  return [[a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]];
});
/**
 * An alveolar airspace from its (inset, convex) Voronoi cell: corners rounded by corner cutting, walls bowed
 * and beaded by a low-frequency inward-only wobble (so a wall can thicken but never break through).
 */
function softAir(poly, R, wob = 0.08) {
  // fillet each corner (quadratic arc, cut length ~ a fifth of the shorter edge, at most 4.5 units)
  const p = poly.length > 24 ? poly.slice() : [];
  for (let i = 0; i < (poly.length > 24 ? 0 : poly.length); i++) {
    const a = poly[(i - 1 + poly.length) % poly.length], v = poly[i], b = poly[(i + 1) % poly.length];
    const la = dist(a, v), lb = dist(v, b), r = Math.min(4.5, 0.24 * Math.min(la, lb));
    const p1 = [v[0] + ((a[0] - v[0]) / la) * r, v[1] + ((a[1] - v[1]) / la) * r], p2 = [v[0] + ((b[0] - v[0]) / lb) * r, v[1] + ((b[1] - v[1]) / lb) * r];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3, u = 1 - t;
      p.push([u * u * p1[0] + 2 * u * t * v[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * v[1] + t * t * p2[1]]);
    }
  }
  const c = centroid(p), ph = [R() * 6, R() * 6], f2 = 2 + Math.floor(R() * 2);
  return p.map(([x, y]) => {
    const a = Math.atan2(y - c[1], x - c[0]);
    const k = 1 - wob * (0.5 + 0.3 * Math.sin(f2 * a + ph[0]) + 0.2 * Math.sin((f2 + 2) * a + ph[1]));
    return [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k];
  });
}
function voronoi(sites, [bx, by, bw, bh]) {
  return sites.map((s, i) => {
    let poly = rectPoly(bx, by, bw, bh);
    for (let j = 0; j < sites.length && poly.length > 2; j++) {
      if (j === i || dist(s, sites[j]) > 150) continue;
      const t = sites[j];
      poly = clipHalf(poly, [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2], [t[0] - s[0], t[1] - s[1]]);
    }
    return poly;
  });
}
const hull = (pts) => {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) {
    while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
};

/** Closed polygon resampled every `step` along its perimeter. */
const resampleClosed = (poly, step) => {
  const r = resample([...poly, poly[0]], step);
  if (r.length > 2 && dist(r[0], r[r.length - 1]) < step * 0.5) r.pop();
  return r;
};
/**
 * The inset of a star-shaped cell (seen from its site s) at distance d from its boundary, found along each ray
 * by bisection on the true distance to the boundary: exact, with sharp corners and no offset loops.
 */
function insetByDistance(cell, s, d) {
  const polys = [cell];
  if (edgeDistance(polys, s) <= d + 0.5) return null;
  return cell.map((p) => {
    const R0 = dist(p, s), u = [(p[0] - s[0]) / R0, (p[1] - s[1]) / R0];
    let lo = 0, hi = R0;
    for (let it = 0; it < 15; it++) {
      const mid = (lo + hi) / 2;
      if (edgeDistance(polys, [s[0] + u[0] * mid, s[1] + u[1] * mid]) > d) lo = mid;
      else hi = mid;
    }
    return [s[0] + u[0] * lo, s[1] + u[1] * lo];
  });
}
/** Fillet the corners of a closed polygon (radius ≈ rc along each edge); returns the points and the corner mid-points. */
function roundCorners(poly, rc) {
  const P = resampleClosed(poly, 1), n = P.length;
  const turn = P.map((p, i) => {
    const a = P[(i - 2 + n) % n], b = P[(i + 2) % n];
    const v1 = [p[0] - a[0], p[1] - a[1]], v2 = [b[0] - p[0], b[1] - p[1]];
    return Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]));
  });
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] > 0.3 && turn[i] >= turn[(i - 1 + n) % n] && turn[i] > turn[(i + 1) % n] && !corners.some((c) => Math.min(Math.abs(c - i), n - Math.abs(c - i)) < 3)) corners.push(i);
  }
  corners.sort((a, b) => a - b);
  const out = P.slice(), mids = [];
  corners.forEach((c, j) => {
    const prev = corners[(j - 1 + corners.length) % corners.length], next = corners[(j + 1) % corners.length];
    const dPrev = corners.length > 1 ? (c - prev + n) % n : n, dNext = corners.length > 1 ? (next - c + n) % n : n;
    const k = Math.max(1, Math.min(Math.round(rc), Math.floor(dPrev * 0.45), Math.floor(dNext * 0.45)));
    const A = P[(c - k + n) % n], B = P[(c + k) % n], V = P[c];
    for (let t = -k + 1; t <= k - 1; t++) {
      const u = (t + k) / (2 * k);
      out[(c + t + n) % n] = [(1 - u) * (1 - u) * A[0] + 2 * (1 - u) * u * V[0] + u * u * B[0], (1 - u) * (1 - u) * A[1] + 2 * (1 - u) * u * V[1] + u * u * B[1]];
    }
    mids.push(out[c]);
  });
  return { pts: out, corners: mids };
}
/** Push the points of a polygon out of an ellipse (centre c, semi-axes a, b, rotated ang°), then soften. */
function dentEllipse(poly, c, a, b, ang) {
  const ca = Math.cos((ang * Math.PI) / 180), sa = Math.sin((ang * Math.PI) / 180);
  let hit = false;
  let p = poly.map(([x, y]) => {
    const dx = x - c[0], dy = y - c[1], lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca, v = (lx / a) ** 2 + (ly / b) ** 2;
    if (v >= 1) return [x, y];
    hit = true;
    const k = 1 / Math.sqrt(Math.max(v, 1e-6)), nx = lx * k, ny = ly * k;
    return [c[0] + nx * ca - ny * sa, c[1] + nx * sa + ny * ca];
  });
  if (!hit) return poly;
  for (let pass = 0; pass < 2; pass++) p = p.map((q, i) => {
    const A = p[(i - 1 + p.length) % p.length], B = p[(i + 1) % p.length];
    return [(A[0] + 2 * q[0] + B[0]) / 4, (A[1] + 2 * q[1] + B[1]) / 4];
  });
  return p;
}

function lung(state, seed = 61) {
  const pneu = state === "pneumonia", fib = state === "fibrosis";
  const R = rng(seed), L = new Layers();
  const X0 = 8, Y0 = 8, W = 284, H = 224;
  const pal = {
    sept: pneu ? "#f0b1ba" : fib ? "#f1bcc2" : "#f5c8cd", scar: "#e8a3ad", air: pneu ? "#f9dfe4" : "#f8fbfd",
    t2: "#dcb6e6", t2Nuc: "#7a52a2", t1Nuc: "#86589f", epi: "#f6cdd3", muscle: "#ee9aa4", mucus: "#dfe6f6", focus: "#ece4f2", capLumen: "#fbe5e8",
  };
  L.def("sept", { fill: pal.sept, lineWidth: 0.5 })
    .def("scar", { fill: pal.scar, lineWidth: 0, ...(fib ? { unite: [] } : {}) })
    .def("collagen", { fill: "none", stroke: { color: "#d68794", width: 1.2, cap: "round" }, lineColor: "#c07784", lineStrokeWidth: 0.7 })
    .def("bMuscle", { fill: pal.muscle, stroke: sw(shade(pal.muscle, 0.14), 0.7), shade: "rim", lineWidth: 0.9 })
    .def("bEpi", { fill: pal.epi, stroke: sw(shade(pal.epi, 0.16), 0.5), lineWidth: 0.55 })
    .def("bLumen", { fill: pneu ? "#f6e1e6" : "#fbf6f8", lineWidth: 0.5 })
    .def("cilia", { fill: "none", stroke: { color: "#c48da3", width: 0.5, cap: "round" }, lineColor: "#a66a83", lineStrokeWidth: 0.35 })
    .def("bNuc", { fill: "#7c4fa0", lineWidth: 0.3 });
  std(L, ["artWall", "wall", "lumen", "rbc", "endo", "fibro", "fibroNuc"]);
  // airspaces: one united shape, no outline in soft; a thin mauve outline in line style
  L.def("air", { fill: pal.air, lineColor: "#c27f8c", lineWidth: 0.75, unite: [] })
    .def("tip", { fill: shade(pal.sept, 0.04), line: false })
    .def("capLumen", { fill: pal.capLumen, lineWidth: 0.3 })
    .def("capRbc", { fill: C.rbc, shade: "small", lineWidth: 0.4 })
    .def("t1Nuc", { fill: pal.t1Nuc, lineWidth: 0.3 })
    .def("focus", { fill: pal.focus, stroke: sw(shade(pal.focus, 0.1), 0.5), lineWidth: 0.6 })
    .def("focusFb", { fill: C.fibro, lineWidth: 0.4 })
    .def("focusNuc", { fill: C.nucleus, lineWidth: 0.3 })
    .def("t2", { fill: pal.t2, stroke: sw(shade(pal.t2, 0.16), 0.5), shade: "small", lineWidth: 0.55 })
    .def("t2Nuc", { fill: pal.t2Nuc, lineWidth: 0.3 })
    .def("t2Vac", { fill: "#f4e8f8", lineWidth: 0.2 })
    .def("fibrinS", { fill: "none", stroke: { color: "#f0dc8c", width: 1.3, cap: "round" }, lineColor: "#c4ab4f", lineStrokeWidth: 0.6 })
    .def("mucus", { fill: pal.mucus, stroke: sw(shade(pal.mucus, 0.16), 0.6), lineWidth: 0.6 })
    .def("cystEpi", { fill: pal.epi, stroke: sw(shade(pal.epi, 0.16), 0.5), lineWidth: 0.5 })
    .def("cystNuc", { fill: "#7c4fa0", lineWidth: 0.3 })
    .def("cystCilia", { fill: "none", stroke: { color: "#c48da3", width: 0.5, cap: "round" }, lineColor: "#a66a83", lineStrokeWidth: 0.35 });
  std(L, [...IMMUNE]);
  L.def("airRbc", { fill: C.rbc, shade: "small", lineWidth: 0.4 });

  // a straight-cut block of parenchyma
  L.add("sept", polyD(rectPoly(X0, Y0, W, H)));

  /* --- geometry (shared by the three states) --- */
  const G = rng(seed + 100); // geometry stream, independent of state
  const bron = [62, 182, 24], art = [100, 205, 12];
  const inZone = (p, m = 0) => dist(p, bron) < bron[2] + 5 + m || dist(p, art) < art[2] + 4 + m;
  // alveoli of very different size: some large (duct-like) spaces, many medium, a share of small ones
  const sites = [], radii = [];
  // (sites run past the frame, so the frame cuts through alveoli instead of leaving a septal border)
  for (let t = 0; t < 9000 && sites.length < 98; t++) {
    const p = [X0 - 10 + G() * (W + 20), Y0 - 10 + G() * (H + 20)], u = G();
    const r = u < 0.16 ? 23 + G() * 8 : u < 0.4 ? 10 + G() * 3 : 13.5 + G() * 8;
    if (inZone(p, 10)) continue;
    if (sites.some((q, i) => dist(q, p) < (r + radii[i]) * 0.9)) continue;
    sites.push(p);
    radii.push(r);
  }
  const nAlv = sites.length;
  // guard sites hug the bundle so the alveoli around it end at a band of adventitia
  for (const [cx, cy, r] of [bron, art]) {
    const n = Math.round((2 * Math.PI * (r + 9)) / 13);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + G() * 0.2, p = [cx + Math.cos(a) * (r + 8.5), cy + Math.sin(a) * (r + 8.5)];
      if (!inZone(p, -1) && p[0] > X0 && p[0] < X0 + W && p[1] > Y0 && p[1] < Y0 + H) {
        sites.push(p);
        radii.push(8);
      }
    }
  }
  // weighted (Apollonius) partition: walls are circular arcs, bigger alveoli bulge into smaller ones
  const { cells, owners } = apollonius(sites, radii, [X0 - 14, Y0 - 14, W + 28, H + 28]);
  // no alveolus reaches into the bronchovascular bundle: cut each ray at the bundle's adventitia
  for (let i = 0; i < nAlv; i++) {
    const s = sites[i];
    cells[i] = cells[i].map((p) => {
      const R0 = dist(p, s), u = [(p[0] - s[0]) / R0, (p[1] - s[1]) / R0];
      let best = R0;
      for (const [cx, cy, r] of [[bron[0], bron[1], bron[2] + 6], [art[0], art[1], art[2] + 5]]) {
        const qx = cx - s[0], qy = cy - s[1], b = u[0] * qx + u[1] * qy, disc = b * b - (qx * qx + qy * qy - r * r);
        if (disc < 0) continue;
        const t = b - Math.sqrt(disc);
        if (t > 0 && t < best) best = t;
      }
      return [s[0] + u[0] * best, s[1] + u[1] * best];
    });
  }
  // shared walls between neighbouring alveoli (each once), as curved point runs
  const edges = [];
  for (let i = 0; i < nAlv; i++) {
    const poly = cells[i], own = owners[i], n = poly.length;
    let k0 = 0;
    while (k0 < n && own[k0] === own[(k0 - 1 + n) % n]) k0++;
    if (k0 === n) continue;
    for (let k = 0; k < n; ) {
      const j = own[(k0 + k) % n], pts = [];
      while (k < n && own[(k0 + k) % n] === j) pts.push(poly[(k0 + k++) % n]);
      if (pts.length < 3 || !(j > i || (j >= nAlv && j !== -1))) continue;
      const len = arcLengths(pts).pop();
      edges.push({ i, j, a: pts[0], b: pts[pts.length - 1], len, pts });
    }
  }
  const along = (e, t) => {
    const sL = e.sL || (e.sL = arcLengths(e.pts)), want = t * sL[sL.length - 1];
    let k = 0;
    while (k < sL.length - 2 && sL[k + 1] < want) k++;
    const u = (want - sL[k]) / (sL[k + 1] - sL[k] || 1);
    return [e.pts[k][0] + (e.pts[k + 1][0] - e.pts[k][0]) * u, e.pts[k][1] + (e.pts[k + 1][1] - e.pts[k][1]) * u];
  };
  // a few incomplete walls (sac openings), the same in every state
  const openings = edges.filter((e) => e.j >= 0 && e.j < nAlv && e.len > 13 && G() < 0.13);
  // fibrosis map: severe round the bundle (lower left), sparing the upper right
  const hash = (p) => {
    const v = Math.sin(p[0] * 12.9898 + p[1] * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const fmap = (p) => Math.max(0, Math.min(1, 1.3 - (p[0] - X0) / 240 - (Y0 + H - p[1]) / 330 + (hash(p) - 0.5) * 0.12));
  const fv = sites.map((s) => (fib ? fmap(s) : 0));
  // alveolar ducts: chains of alveoli opening into each other through the middle of their walls
  const ductEdges = [];
  for (const [target, n, dir] of [[[170, 70], 4, [1, -0.4]], [[236, 178], 3, [-0.5, -1]]]) {
    const start = sites.slice(0, nAlv).reduce((best, s, i) => (dist(s, target) < dist(sites[best], target) ? i : best), 0);
    const duct = [start];
    while (duct.length < n) {
      const cur = duct[duct.length - 1];
      const nb = edges.filter((e) => (e.i === cur || e.j === cur) && e.j >= 0 && e.j < nAlv).map((e) => (e.i === cur ? e.j : e.i)).filter((k) => !duct.includes(k));
      if (!nb.length) break;
      const score = (k) => (sites[k][0] - sites[cur][0]) * dir[0] + (sites[k][1] - sites[cur][1]) * dir[1];
      duct.push(nb.sort((a, b) => score(b) - score(a))[0]);
    }
    ductEdges.push(...edges.filter((e) => duct.includes(e.i) && duct.includes(e.j)));
  }

  /* --- airspaces: each alveolus inset from its cell at half the septal thickness, corners filleted (r ≈ 4.5) so
     septal junctions become small concave triangles, walls gently bowed --- */
  const airPolys = new Map(), airCorners = new Map();
  const dense = new Set(), cysts = [];
  if (fib) {
    for (let i = 0; i < nAlv; i++) if (fv[i] > 0.72) dense.add(i);
    for (let i = nAlv; i < sites.length; i++) if (fmap(sites[i]) > 0.72) dense.add(i);
    // honeycomb cysts: irregular airspaces larger than alveoli, packed in the scar with thick walls
    const inDense = (p) => [...dense].some((i) => inside(cells[i], p));
    const GC = rng(seed + 7);
    for (let t = 0; t < 3000 && cysts.length < 7; t++) {
      const p = [X0 + GC() * W, Y0 + GC() * H], r = 9 + GC() * 11;
      if (!inDense(p) || dist(p, bron) < bron[2] + r + 9 || dist(p, art) < art[2] + r + 8) continue;
      if (p[0] - r < X0 + 7 || p[1] + r > Y0 + H - 7 || p[1] - r < Y0 + 7) continue;
      if (cysts.some((c) => dist(c.p, p) < c.r + r + 14)) continue;
      const ring8 = Array.from({ length: 10 }, (_, k) => [p[0] + Math.cos(k * 0.628) * (r + 6), p[1] + Math.sin(k * 0.628) * (r + 6)]);
      if (ring8.filter(inDense).length < 8) continue;
      cysts.push({ p, r, poly: blobPts(p[0], p[1], r, r * (0.7 + GC() * 0.25), { n: 11, wobble: 0.17, seed: seed + t, rot: GC() * 180 }) });
    }
  }
  for (let i = 0; i < nAlv; i++) {
    if (dense.has(i)) continue;
    const t = fib ? 3.4 + 10 * fv[i] : pneu ? 4 : vary(G, 3, 0.2);
    const ins = insetByDistance(cells[i], sites[i], t / 2);
    if (!ins || area(ins) < 40) continue; // slivers merge into the septum
    const { pts, corners } = roundCorners(ins, fib ? 3.5 : 4.5);
    const air = softAir(pts, G, fib ? 0.025 : 0.035);
    if (area(air) < 40) continue;
    airPolys.set(i, air);
    airCorners.set(i, corners);
  }
  const isDuct = (e) => ductEdges.includes(e), isOpen = (e) => isDuct(e) || openings.includes(e);
  const bothAir = (e) => e.j >= 0 && e.j < nAlv && airPolys.has(e.i) && airPolys.has(e.j);
  const wallNormal = (e, t, toward) => {
    const a = along(e, Math.max(0, t - 0.05)), b = along(e, Math.min(1, t + 0.05)), p = along(e, t);
    let n = [-(b[1] - a[1]), b[0] - a[0]];
    const nl = Math.hypot(...n) || 1;
    n = [n[0] / nl, n[1] / nl];
    const s = sites[toward];
    return (s[0] - p[0]) * n[0] + (s[1] - p[1]) * n[1] < 0 ? [-n[0], -n[1]] : n;
  };
  // septal capillaries: where a red cell sits the septum swells into a capillary profile, bulging into one
  // alveolus or the other (the airspace outline gives way round it)
  const caps = [];
  const GK = rng(seed + 200);
  for (const e of edges) {
    if (!bothAir(e) || isOpen(e) || e.len < 10) continue;
    const nC = pneu ? (GK() < 0.55 ? 2 : 1) : GK() < 0.5 ? (GK() < 0.2 ? 2 : 1) : 0;
    for (const t of unevenSpacing(nC, 1, GK, { cv: 0.3, start: 0.28, end: 0.72 })) {
      const p = along(e, t), side = GK() < 0.5 ? e.i : e.j, n = wallNormal(e, t, side);
      const a = along(e, Math.min(1, t + 0.05)), b = along(e, Math.max(0, t - 0.05)), ang = Math.atan2(a[1] - b[1], a[0] - b[0]) * R2D;
      const c = [p[0] + n[0] * 1.15, p[1] + n[1] * 1.15];
      if (caps.some((q) => dist(q.c, c) < 9)) continue;
      caps.push({ c, ang, rx: pneu ? 3.4 : 3.2, ry: pneu ? 2.3 : 2.1, e, t });
    }
  }
  for (const cp of caps) {
    for (const k of [cp.e.i, cp.e.j]) airPolys.set(k, dentEllipse(airPolys.get(k), cp.c, cp.rx + 1.2, cp.ry + 1.15, cp.ang));
  }
  for (const [, air] of airPolys) L.map.get("air").unite.push(smoothClosed(air.filter((_, k) => k % 2 === 0), 0.7));
  // openings through the middle of a wall (alveolar ducts, a few sac openings): the free septal ends at a duct
  // mouth are slightly thickened and tapered
  for (const e of [...ductEdges, ...openings]) {
    if (!airPolys.has(e.i) || !airPolys.has(e.j)) continue;
    const m = along(e, 0.5), ang = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * R2D;
    const wide = isDuct(e) ? 0.3 : 0.2, tw = fib ? 3.4 + 10 * Math.max(fv[e.i], fv[e.j]) : pneu ? 4 : 3;
    L.map.get("air").unite.push(ellipse(m[0], m[1], e.len * wide, fib ? 6 + 6 * Math.max(fv[e.i], fv[e.j]) : 5, ang));
    if (isDuct(e) && (!fib || Math.max(fv[e.i], fv[e.j]) < 0.5)) {
      const u = [(e.b[0] - e.a[0]) / e.len, (e.b[1] - e.a[1]) / e.len], reach = e.len * wide;
      for (const sgn of [-1, 1]) {
        const c = [m[0] + u[0] * (reach + 0.9) * sgn, m[1] + u[1] * (reach + 0.9) * sgn];
        L.add("tip", ellipse(c[0], c[1], vary(G, 3, 0.12), tw / 2 + 0.75, ang));
      }
    }
  }
  if (fib) {
    // dense scar: the fibrotic cells grown so neighbours overlap (one mass, no septal stubs inside it)
    for (const i of dense) L.map.get("scar").unite.push(polyD(offsetClosed(resampleClosed(cells[i], 2), 2.4)));
    for (const c of cysts) L.map.get("air").unite.push(smoothClosed(c.poly));
  }

  /* --- bronchovascular bundle --- */
  {
    const [cx, cy, r] = bron;
    const ring = (rr, n = 90, dir = 1) => Array.from({ length: n }, (_, k) => {
      const a = (dir * k * Math.PI * 2) / n;
      return [cx + Math.cos(a) * rr * (1 + 0.04 * Math.sin(a * 3 + 1)), cy + Math.sin(a) * rr * (1 + 0.04 * Math.sin(a * 3 + 1))];
    });
    L.add("bMuscle", polyD(ring(r)) + polyD(ring(r - 4.2).reverse()));
    const lum = ring(r - 12, 90, -1);
    L.add("bLumen", polyD(lum));
    for (const c of cellBand(lum, { rows: 1, thickness: 8, cellLen: 4.6, jitter: 0.2, seed: seed + 3 })) {
      L.add("bEpi", roundPoly(c.poly, 0.6));
      const n = c.poly.length / 2, ap = mean(c.poly.slice(0, n)), ba = mean(c.poly.slice(n));
      const np = [ap[0] + (ba[0] - ap[0]) * 0.62, ap[1] + (ba[1] - ap[1]) * 0.62];
      let nuc = blobPts(np[0], np[1], 1.6, 1.25, { n: 7, wobble: 0.05, seed: c.i, rot: Math.atan2(ba[1] - ap[1], ba[0] - ap[0]) * R2D });
      nuc = fitInside(nuc, c.poly, 0.35) ?? nuc;
      L.add("bNuc", smoothClosed(nuc));
      if (c.i % 2 === 0) {
        const tip = [ap[0] - (ba[0] - ap[0]) * 0.32, ap[1] - (ba[1] - ap[1]) * 0.32];
        L.add("cilia", `M${f(ap[0])} ${f(ap[1])}L${f(tip[0])} ${f(tip[1])}`);
      }
    }
    vessel(L, { cx: art[0], cy: art[1], rx: art[2], ry: art[2] * 0.9, rot: 20, kind: "art", rbcs: 2, seed: seed + 4 });
    if (pneu) for (const p of packIn(cx, cy, r - 17, r - 17, 9, 6.6, { seed: seed + 5 })) neutS(L, p, R, 0.85);
  }

  /* --- septal content --- */
  for (const cp of caps) {
    L.add("capLumen", ellipse(cp.c[0], cp.c[1], cp.rx, cp.ry, cp.ang));
    L.add("capRbc", ellipse(cp.c[0] + (R() - 0.5) * 0.4, cp.c[1] + (R() - 0.5) * 0.4, cp.rx - 0.75, cp.ry - 0.6, cp.ang + (R() - 0.5) * 12));
  }
  for (const e of edges) {
    if (!bothAir(e) || e.len < 9) continue;
    const ang = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * R2D;
    const fe = fib ? (fv[e.i] + fv[e.j]) / 2 : 0, tw = fib ? 3.4 + 10 * fe : pneu ? 4 : 3;
    // thickened septa at the edge of the fibrosis: collagen and a fibroblast in the widened interstitium
    if (fib && fe > 0.3 && e.len > 14) {
      // one collagen strand along the middle of the widened septum (kept clear of the junctions)
      if (e.len > 22 && fe > 0.5) L.add("collagen", smoothOpen([0.18, 0.39, 0.61, 0.82].map((t) => along(e, t))));
      if (R() < 0.5 && !caps.some((cp) => cp.e === e)) {
        const m = along(e, 0.5);
        L.add("fibro", spindle(m[0], m[1], Math.min(16, e.len * 0.6), 3.4, ang));
        L.add("fibroNuc", ellipse(m[0], m[1], 2.6, 1.1, ang));
      }
    }
    // type I pneumocyte nuclei: flat slivers inside the septum, just under the alveolar surface
    if ((!fib || fe < 0.6) && !isOpen(e) && R() < 0.42) {
      const t = 0.3 + R() * 0.4, p = along(e, t);
      if (caps.some((cp) => dist(cp.c, p) < 6.5)) continue;
      const side = R() < 0.5 ? e.i : e.j, n = wallNormal(e, t, side), o = tw / 2 - 0.75;
      L.add("t1Nuc", ellipse(p[0] + n[0] * o, p[1] + n[1] * o, 2.6, 0.55, ang));
    }
  }
  // type II pneumocytes: cuboidal cells with foamy cytoplasm sitting in the rounded corners of alveoli
  {
    const spots = [];
    for (const [i, cs] of airCorners) for (const v of cs) if (G() < 0.2) spots.push([i, v]);
    let made = 0;
    for (const [i, v0] of spots) {
      if (made >= (fib ? 20 : 16)) break;
      const air = airPolys.get(i), c0 = centroid(air);
      const v = air.reduce((b, q) => (dist(q, v0) < dist(b, v0) ? q : b), air[0]);
      const d = dist(v, c0) || 1, k = (pneu ? 2.6 : 2.3) / d;
      const c = [v[0] + (c0[0] - v[0]) * k, v[1] + (c0[1] - v[1]) * k];
      if (caps.some((cp) => dist(cp.c, c) < 6)) continue;
      L.add("t2", blob(c[0], c[1], 3.4, 3, { n: 7, wobble: 0.08, seed: Math.round(c[0] * 7 + c[1]) }));
      L.add("t2Nuc", circle(c[0] + (v[0] - c[0]) * 0.25, c[1] + (v[1] - c[1]) * 0.25, 1.45));
      for (const g of packIn(c[0] - (v[0] - c[0]) * 0.22, c[1] - (v[1] - c[1]) * 0.22, 1.5, 1.5, 3, 1.15, { seed: Math.round(c[0] + c[1]) })) L.add("t2Vac", circle(g[0], g[1], 0.5));
      made++;
    }
  }

  /* --- airspace contents --- */
  const inAir = (i, q, m) => checkInside([q], airPolys.get(i), m).ok;
  if (pneu) {
    let k = 0;
    for (const [i, air] of airPolys) {
      const a = area(air), box = (() => { const xs = air.map((p) => p[0]), ys = air.map((p) => p[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; })();
      const fill = 0.35 + 0.55 * R();
      for (const p of packWhere(box, Math.round((a / 70) * fill), 6.8, (q) => inAir(i, q, 4.2), { seed: seed + i })) neutS(L, p, R, 0.82);
      if (R() < 0.45) {
        const c = centroid(air), an = R() * Math.PI;
        const l = Math.sqrt(a) * 0.4;
        L.add("fibrinS", fibre(c[0] - Math.cos(an) * l, c[1] - Math.sin(an) * l, c[0] + Math.cos(an) * l, c[1] + Math.sin(an) * l, { amp: 1.6, waves: 1.5, phase: R() * 6 }));
      }
      if (R() < 0.35) for (const p of packWhere(box, 2, 5, (q) => inAir(i, q, 2.6), { seed: seed + i + 7 })) L.add("airRbc", ellipse(p[0], p[1], 2.4, 1.9, R() * 180));
      if (k++ % 6 === 2) {
        const p = packWhere(box, 1, 0, (q) => inAir(i, q, 6.4), { seed: seed + i + 9 })[0];
        if (p) macroS(L, p, R, 0.95);
      }
    }
  } else {
    // alveolar macrophages free in a few airspaces
    let made = 0;
    for (const [i, air] of airPolys) {
      if (made >= (fib ? 4 : 5) || G() > 0.16 || (fib && fv[i] > 0.5)) continue;
      const xs = air.map((p) => p[0]), ys = air.map((p) => p[1]);
      const p = packWhere({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, 1, 0, (q) => inAir(i, q, 7), { seed: seed + i })[0];
      if (p) {
        macroS(L, p, R, 1);
        made++;
      }
    }
  }
  if (fib) {
    const inScar = (p, m = 0) => [...dense].some((i) => checkInside([p], cells[i], -m).ok) && !cysts.some((c) => checkInside([p], c.poly, -1.5 - m).ok) && !inZone(p, 1);
    // collagen: a few long bundles of 2–3 strands curving round the cysts
    const GB = rng(seed + 31);
    for (const cy of cysts) {
      const a0 = GB() * 360, span = 140 + GB() * 80;
      for (const [rr, ph] of [[cy.r + 4.5, 0], [cy.r + 6.8, 1.3], [cy.r + 9.5, 2.1]]) {
        const pts = [];
        for (let k = 0; k <= 30; k++) {
          const a = ((a0 + (span * k) / 30) * Math.PI) / 180, r2 = rr * (1 + 0.04 * Math.sin(k * 0.6 + ph));
          pts.push([cy.p[0] + Math.cos(a) * r2 * 1.02, cy.p[1] + Math.sin(a) * r2 * 0.9]);
        }
        let run = [];
        const flush = () => {
          if (run.length > 5) L.add("collagen", smoothOpen(run));
          run = [];
        };
        for (const p of pts) (inScar(p, 1.2) ? run.push(p) : flush());
        flush();
      }
    }
    // small vessels in the scar (red cells only inside vessels)
    for (const p of packWhere({ x: X0, y: Y0, w: W, h: H }, 2, 40, (q) => inScar(q, 9), { seed: seed + 33 })) vessel(L, { cx: p[0], cy: p[1], rx: 5.2, ry: 4.2, rot: R() * 180, kind: "ven", rbcs: 2, seed: Math.round(p[0] + p[1]) });
    // honeycomb cysts: lined by bronchiolar-type epithelium (cuboidal to columnar, some ciliated, nuclei at the
    // base), with mucus
    for (const cy of cysts) {
      const outline = resample(catmull(cy.poly, 8, true), 1.2);
      const lumen = signedArea(outline) > 0 ? outline.slice().reverse() : outline;
      const thick = (u) => 5 + 1.8 * Math.sin(u * 17 + cy.r) * Math.sin(u * 5 + 1);
      const sd = seed + Math.round(cy.p[0]);
      let cellsL = cellBand(lumen, { rows: 1, thickness: thick, cellLen: 4.4, jitter: 0.35, seed: sd });
      if (cellsL.length && inside(outline, centroid(cellsL[0].poly))) cellsL = cellBand(lumen.slice().reverse(), { rows: 1, thickness: thick, cellLen: 4.4, jitter: 0.35, seed: sd });
      let muc = blobPts(cy.p[0] + cy.r * 0.15, cy.p[1] + cy.r * 0.2, cy.r * 0.5, cy.r * 0.36, { n: 8, wobble: 0.18, seed: seed + Math.round(cy.p[1]) });
      muc = fitInside(muc, cy.poly, 2) ?? muc;
      L.add("mucus", smoothClosed(muc));
      cellsL.forEach((c, k) => {
        L.add("cystEpi", roundPoly(c.poly, 0.5));
        const n = c.poly.length / 2, ap = mean(c.poly.slice(0, n)), ba = mean(c.poly.slice(n)), ang = Math.atan2(ba[1] - ap[1], ba[0] - ap[0]) * R2D;
        let nuc = blobPts(ap[0] + (ba[0] - ap[0]) * 0.68, ap[1] + (ba[1] - ap[1]) * 0.68, 1.35, 1, { n: 7, wobble: 0.05, seed: sd + k, rot: ang });
        nuc = fitInside(nuc, c.poly, 0.3) ?? nuc;
        L.add("cystNuc", smoothClosed(nuc));
        if (k % 3 === 1) {
          // a ciliated cell: short cilia on its apical surface
          const top = c.poly.slice(0, n);
          for (const q of [top[0], top[Math.floor(n / 2)], top[n - 1]]) {
            const tip = [q[0] - (ba[0] - ap[0]) * 0.32, q[1] - (ba[1] - ap[1]) * 0.32];
            L.add("cystCilia", `M${f(q[0])} ${f(q[1])}L${f(tip[0])} ${f(tip[1])}`);
          }
        }
      });
    }
    // fibroblastic focus: a convex dome (≈22 × 8) of pale myxoid matrix sitting on a straight, thickened wall between
    // the scar and an open alveolus at the leading edge of the fibrosis, 5–7 slender fibroblasts aligned with its
    // surface, covered by a row of cuboidal hyperplastic AT2 cells
    const walls = edges
      .filter((e) => e.j >= 0 && e.j < nAlv && e.len >= 18 && dense.has(e.i) !== dense.has(e.j) && airPolys.has(dense.has(e.i) ? e.j : e.i))
      .filter((e) => { const m = along(e, 0.5); return m[0] > X0 + 30 && m[0] < X0 + W - 30 && m[1] > Y0 + 26 && m[1] < Y0 + H - 26 && !inZone(m, 14); })
      .sort((a, b) => b.len - a.len);
    for (const e of walls) {
      const ai = dense.has(e.i) ? e.j : e.i, air = airPolys.get(ai), c0 = centroid(air);
      const h0 = Math.min(0.5, 11 / e.len), A0 = along(e, 0.5 - h0), B0 = along(e, 0.5 + h0);
      const cl = dist(A0, B0), tv = [(B0[0] - A0[0]) / cl, (B0[1] - A0[1]) / cl];
      let nv = [-tv[1], tv[0]];
      if ((c0[0] - A0[0]) * nv[0] + (c0[1] - A0[1]) * nv[1] < 0) nv = [-nv[0], -nv[1]];
      // the alveolar surface of the thickened septum lies half a septum thickness off the wall line
      const half = (3.4 + 10 * (fv[e.i] + fv[e.j]) / 2) / 2;
      const A = [A0[0] + nv[0] * half, A0[1] + nv[1] * half];
      const hgt = (u) => 7.5 * Math.pow(Math.sin(Math.PI * u), 0.7);
      const onArch = (u, k = 1) => [A[0] + tv[0] * cl * u + nv[0] * hgt(u) * k, A[1] + tv[1] * cl * u + nv[1] * hgt(u) * k];
      const arch = Array.from({ length: 21 }, (_, i) => onArch(i / 20));
      if (!checkInside(arch.slice(2, -2).map(([x, y]) => [x + nv[0] * 4.4, y + nv[1] * 4.4]), air, 0.6).ok) continue;
      if (arch.some((p) => cysts.some((c) => dist(p, c.p) < c.r + 6) || caps.some((cp) => dist(cp.c, p) < 4))) continue;
      const base = Array.from({ length: 11 }, (_, i) => [A[0] + tv[0] * cl * (1 - i / 10) - nv[0] * 2, A[1] + tv[1] * cl * (1 - i / 10) - nv[1] * 2]);
      L.add("focus", smoothClosed([...arch.slice(1, -1), ...base.slice(1, -1)], 0.7));
      // fibroblasts parallel to the surface, in two tiers
      for (const [fr, us] of [[0.3, [0.22, 0.48, 0.74]], [0.66, [0.34, 0.62]]]) {
        for (const u of us) {
          const p = onArch(u, fr), q0 = onArch(Math.max(0, u - 0.06), fr), q1 = onArch(Math.min(1, u + 0.06), fr);
          const slope = Math.atan2(q1[1] - q0[1], q1[0] - q0[0]) * R2D;
          L.add("focusFb", spindle(p[0], p[1], vary(R, 7, 0.12), 1.5, slope + (R() - 0.5) * 8));
          L.add("focusNuc", ellipse(p[0], p[1], 1.7, 0.5, slope));
        }
      }
      // hyperplastic AT2 cells: a row of cuboidal cells on the free surface
      for (const u of unevenSpacing(4, 1, R, { cv: 0.12, start: 0.1, end: 0.9 })) {
        const p = onArch(u), q0 = onArch(u - 0.03), q1 = onArch(u + 0.03), a = Math.atan2(q1[1] - q0[1], q1[0] - q0[0]);
        let nn = [-Math.sin(a), Math.cos(a)];
        if (nn[0] * nv[0] + nn[1] * nv[1] < 0) nn = [-nn[0], -nn[1]];
        const cc = [p[0] + nn[0] * 1.7, p[1] + nn[1] * 1.7];
        L.add("t2", ellipse(cc[0], cc[1], vary(R, 2.2, 0.08), 1.9, a * R2D));
        L.add("t2Nuc", circle(cc[0] - nn[0] * 0.3, cc[1] - nn[1] * 0.3, 0.95));
      }
      break;
    }
    // interstitial lymphocytes in the fibrotic zone
    for (const p of packWhere({ x: X0, y: Y0, w: W, h: H }, 16, 7.5, (q) => inScar(q, 4), { seed: seed + 23 })) lymphS(L, p, R() < 0.7 ? "T" : "B", R, 2.8);
  }
  return clampScene({ size: [300, 240], lineWidth: 1.3, parts: L.parts() }, [X0, Y0, X0 + W, Y0 + H]);
}

/* ===================== colon ===================== */

// Colon mucosa (320 × 240), one framing for both states. Plan, bottom → top:
//   submucosa (loose CT, collagen bundles, arteriole/venule/lymphatic) → lamina propria (the region
//   under one continuous lining line that runs along the flat surface and down into every crypt)
//   → muscularis mucosae (band + spindle nuclei) → LP capillaries → LP immune cells → epithelium
//   (colonocytes, goblet cells with mucin cups, basal nuclei) → exudate.
// Healthy: closely packed straight test-tube crypts reaching the muscularis mucosae, rich in goblet
// cells, opening onto a flat surface; a thin LP with scattered plasma cells, lymphocytes, eosinophils.
// Ulcerative colitis: crypt dropout, shortened crypts lifted off the muscularis mucosae (basal
// plasmacytosis fills the gap), a bifid crypt, a tilted crypt, a dilated crypt with a crypt abscess,
// goblet-cell (mucin) depletion, cryptitis, a dense mixed infiltrate and a surface erosion capped by
// fibrin and neutrophils.

/** Lumen keypoints of one crypt (from the surface left of it to the surface right of it). */
function cryptKeys(c, top) {
  const { x, D, h = 2.5, bend = 0, tilt = 0, dil = 0, hm = 1.4 } = c;
  const xc = (u) => x + bend * Math.sin(Math.PI * u) + tilt * u;
  const hw = (u) => h + dil * Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.3) / 0.75))));
  const m = 2.8; // small mouth rounding: a flat surface with narrow crypt openings
  if (c.fork) {
    const F = c.fork, S = c.spread, yb = top + D;
    return [
      [x - h - m, top], [x - h - m * 0.3, top + m * 0.3], [x - h, top + m],
      [x - h, top + F - 8], [x - h - S * 0.45, top + F + 12], [x - S - h, yb - 12], [x - S - h * 0.8, yb - 1.4], [x - S, yb], [x - S + h * 0.8, yb - 1.4],
      [x - S + h, yb - 12], [x - S * 0.42 + h, top + F + 22], [x - 3.2, top + F + 16.5], [x, top + F + 15.6], [x + 3.2, top + F + 16.5], [x + S * 0.42 - h, top + F + 22],
      [x + S - h, yb - 12], [x + S - h * 0.8, yb - 1.4], [x + S, yb], [x + S + h * 0.8, yb - 1.4], [x + S + h, yb - 12],
      [x + h + S * 0.45, top + F + 12], [x + h, top + F - 8], [x + h, top + m], [x + h + m * 0.3, top + m * 0.3], [x + h + m, top],
    ];
  }
  const left = [], right = [];
  for (const u of [0.1, 0.32, 0.55, 0.76, 0.92]) {
    left.push([xc(u) - hw(u), top + D * u]);
    right.push([xc(u) + hw(u), top + D * u]);
  }
  const hb = hw(0.97);
  return [
    [xc(0) - hm - m, top], [xc(0) - hm - m * 0.3, top + m * 0.3], [xc(0) - hm, top + m], ...left.slice(1),
    [xc(1) - hb * 0.8, top + D - hb * 0.5], [xc(1), top + D], [xc(1) + hb * 0.8, top + D - hb * 0.5],
    ...right.slice(1).reverse(), [xc(0) + hm, top + m], [xc(0) + hm + m * 0.3, top + m * 0.3], [xc(0) + hm + m, top],
  ];
}

function colon(colitis, seed = 71) {
  const R = rng(seed), L = new Layers();
  const W = 320, X0 = 8, X1 = 312, YB = 232, top = 30, mmTop = 180, mmBot = 193;
  const pal = {
    lp: colitis ? "#e49aa6" : "#e9a9b2", sub: "#fbebe8", rim: colitis ? "#cf7f8f" : "#d48b99", mm: "#ee9ca6", entero: "#f6d0d8", goblet: "#edeff9", mucin: "#cfdcf3", nuc: "#6f4a96",
  };
  L.def("sub", { fill: pal.sub, stroke: sw(shade(pal.sub, 0.1), 1), lineWidth: 1.2 })
    .def("subFib", { fill: "none", stroke: { color: "#efc6c4", width: 1.2, cap: "round" }, lineColor: "#dcaaa9", lineStrokeWidth: 0.7 })
    .def("lp", { fill: pal.lp, stroke: sw(shade(pal.lp, 0.1), 0.9), lineWidth: 1.1 })
    .def("mm", { fill: pal.mm, stroke: sw(shade(pal.mm, 0.14), 0.8), shade: "rim", lineWidth: 1 })
    .def("mmNuc", { fill: "#86589f", lineWidth: 0.3 });
  std(L, BLOOD);
  L.def("bmRim", { fill: pal.rim, line: false })
    .def("entero", { fill: pal.entero, stroke: sw(shade(pal.entero, 0.08), 0.45), lineWidth: 0.5 })
    .def("goblet", { fill: pal.goblet, stroke: sw(shade(pal.goblet, 0.1), 0.45), lineWidth: 0.5 })
    .def("mucin", { fill: pal.mucin, stroke: sw("#b7c8e6", 0.4), lineWidth: 0.4 })
    .def("epiNuc", { fill: pal.nuc, shade: "small", lineWidth: 0.3 })
    .def("fibrin", { fill: C.fibrin, stroke: sw(shade(C.fibrin, 0.14), 0.7), shade: "small", lineWidth: 0.8 });
  // immune cells after the epithelium: LP cells never overlap it (occupancy grid), and cryptitis and
  // exudate neutrophils must sit on top of it
  std(L, IMMUNE);
  L.def("eos", { fill: "#fae2d6", shade: "small", lineWidth: 0.5 })
    .def("eosGran", { fill: "#ef7b55", lineWidth: 0.2 })
    .def("eosNuc", { fill: "#6b58a8", lineWidth: 0.3 });

  /* --- crypts --- */
  const crypts = colitis
    ? [
        { x: 36, D: 112, bend: 2, h: 2.4 },
        { x: 100, D: 118, fork: 54, spread: 15 },
        { x: 166, D: 104, h: 2.6, dil: 5.5, abscess: true },
        { x: 262, D: 96, tilt: -7, bend: -2, h: 2.4 },
        { x: 296, D: 86, h: 2.2, bend: 1.5 },
      ]
    : (() => {
        // closely packed test-tube crypts: ~10–11 across, pitch ~29 (CV < 0.1), so the lamina propria between
        // neighbours is only 4–8 wide
        const out = [];
        for (let x = X0 + 6 + R() * 4; x < X1 - 9; x += vary(R, 29.5, 0.06)) out.push({ x, D: vary(R, 132, 0.04), bend: (R() - 0.5) * 3, tilt: (R() - 0.5) * 3, h: vary(R, 3, 0.07), dil: vary(R, 0.5, 0.5) });
        return out;
      })();

  // the lining line: flat surface → crypt → surface → … (gently undulating intercryptal surface)
  const keys = [[X0, top]];
  for (const c of crypts) {
    const k = cryptKeys(c, top);
    const prev = keys[keys.length - 1];
    if (k[0][0] - prev[0] > 9) keys.push([(prev[0] + k[0][0]) / 2, top]);
    keys.push(...k);
  }
  const lastX = keys[keys.length - 1][0];
  if (X1 - lastX > 9) keys.push([(lastX + X1) / 2, top]);
  keys.push([X1, top]);
  const line = resample(catmull(keys, 6), 1.15);

  // attenuated epithelium in the abscessed crypt; full height elsewhere
  const abs = crypts.find((c) => c.abscess);
  const thArr = line.map(([x, y]) => (abs && y > top + abs.D * 0.38 && Math.abs(x - abs.x) < 14 ? 5.4 : 8.6));
  const T = (u) => thArr[Math.min(thArr.length - 1, Math.round(u * (thArr.length - 1)))];
  const raw = cellBand(line, { rows: 1, thickness: T, cellLen: 4.2, jitter: 0.25, seed, nucleus: 0.3 });
  let cells = cleanCells(raw).filter((c) => c.ctr[0] > X0 + 1 && c.ctr[0] < X1 - 1);

  // surface erosion (colitis): epithelium lost over a stretch of the surface
  const ero = colitis ? [200, 238] : null;
  if (ero) cells = cells.filter((c) => !(c.ctr[0] > ero[0] && c.ctr[0] < ero[1] && c.ctr[1] < top + 16));

  /* --- base layers --- */
  L.add("sub", polyD([[X0, mmTop + 4], [X1, mmTop + 4], [X1, YB], [X0, YB]]));
  L.add("lp", polyD([...line, [X1, mmTop + 6], [X0, mmTop + 6]]));
  const mmLine = (y0, ph) => catmull([X0, 80, 160, 240, X1].map((x, i) => [x, y0 + 1.6 * Math.sin(i * 1.7 + ph)]), 12);
  const mmA = mmLine(mmTop, 0.3), mmB = mmLine(mmBot, 1.1);
  L.add("mm", polyD([...mmA, ...mmB.slice().reverse()]));
  for (const row of [0.33, 0.7]) {
    for (const s of unevenSpacing(22, X1 - X0 - 10, R, { cv: 0.35 })) {
      const x = X0 + 5 + s, y = mmTop + (mmBot - mmTop) * row + (R() - 0.5) * 2;
      L.add("mmNuc", ellipse(x, y, vary(R, 3.6, 0.2), 0.9, (R() - 0.5) * 8));
    }
  }

  // a thin, slightly darker rim along the base of the epithelium, so every crypt reads as a closed test tube
  {
    const nsL = normals(line), keep = (p) => !(ero && p[0] > ero[0] - 2 && p[0] < ero[1] + 2 && p[1] < top + 14);
    let run = [];
    const flush = () => {
      if (run.length > 3) L.add("bmRim", polyD([...run.map(([p, n, t]) => [p[0] + n[0] * (t - 0.15), p[1] + n[1] * (t - 0.15)]), ...run.map(([p, n, t]) => [p[0] + n[0] * (t + 1.1), p[1] + n[1] * (t + 1.1)]).reverse()]));
      run = [];
    };
    // (no rim where the lining turns sharply, at the crypt mouths: offset normals would cross there)
    const sharp = (i) => { const a = nsL[Math.max(0, i - 2)], b = nsL[Math.min(nsL.length - 1, i + 2)]; return a[0] * b[0] + a[1] * b[1] < 0.6; };
    // (the lining normal always points into the lamina propria — never upward; a flipped one marks a cusp)
    line.forEach((p, i) => (keep(p) && !sharp(i) && nsL[i][1] > -0.3 ? run.push([p, nsL[i], thArr[i]]) : flush()));
    flush();
  }
  // occupancy: epithelium, muscularis, vessels — for placing LP cells
  const G = new Grid(W, 240);
  for (const c of cells) G.mark(c.poly, 0.6);
  const lpPoly = [...line, [X1, mmTop + 1], [X0, mmTop + 1]];
  const inLP = (p, r) => inside(lpPoly, p) && p[1] - r > top + 9 && p[1] < mmTop - r && p[0] > X0 + r && p[0] < X1 - r && G.free(p, r + 0.4);

  /* --- vessels: pericryptal capillaries in the LP, a vessel trio in the submucosa --- */
  for (const p of packWhere({ x: X0, y: top, w: X1 - X0, h: mmTop - top }, colitis ? 10 : 9, 24, (q) => inLP(q, 3), { seed: seed + 2 })) {
    const rx = vary(R, 2.6, 0.12);
    vessel(L, { cx: p[0], cy: p[1], rx, ry: rx * 0.8, rot: R() * 180, kind: "cap", seed: Math.round(p[0] * 3 + p[1]) });
    G.disc(p[0], p[1], rx + 0.8);
  }
  vessel(L, { cx: 92, cy: 214, rx: 9, ry: 8, kind: "art", seed: seed + 3 });
  vessel(L, { cx: 120, cy: 212, rx: 14, ry: 8, rot: 6, kind: "ven", rbcs: 3, seed: seed + 4 });
  vessel(L, { cx: 246, cy: 211, rx: 11, ry: 6.5, rot: -8, kind: "lymph", seed: seed + 5 });
  vessel(L, { cx: 290, cy: 216, rx: 6.5, ry: 5, kind: "ven", rbcs: 1, seed: seed + 6 });
  for (const [y0, x0, len, ph] of [[203, 14, 60, 0.4], [222, 150, 80, 1.6], [200, 168, 70, 2.4], [226, 20, 50, 3.1], [205, 268, 40, 0.9]]) {
    for (const k of [-1.3, 1.3]) {
      const pts = [];
      for (let x = x0; x <= x0 + len; x += 3) pts.push([x, y0 + k + 2.6 * Math.sin(x / 17 + ph)]);
      if (!pts.some((p) => [[92, 214, 12], [120, 212, 17], [246, 211, 14], [290, 216, 9]].some(([cx, cy, r]) => dist(p, [cx, cy]) < r))) L.add("subFib", smoothOpen(pts));
    }
  }

  /* --- lamina propria cells --- */
  const place = (n, r, minD, test = () => true, s = 1) => {
    const out = packWhere({ x: X0, y: top, w: X1 - X0, h: mmTop - top }, n, minD, (q) => inLP(q, r) && test(q), { seed: seed + s });
    for (const p of out) G.disc(p[0], p[1], r + 0.3);
    return out;
  };
  if (colitis) {
    // basal plasmacytosis: plasma cells packed between the lifted crypt bases and the muscularis mucosae
    for (const p of place(46, 3.6, 7.4, (q) => q[1] > 140, 7)) plasmaS(L, p, R, 0.85);
    for (const p of place(34, 3.6, 7.6, () => true, 8)) plasmaS(L, p, R, 0.85);
    for (const p of place(46, 2.6, 5.8, () => true, 9)) lymphS(L, p, R() < 0.8 ? "T" : "B", R, 2.5);
    for (const p of place(16, 3.5, 8, () => true, 10)) neutS(L, p, R, 0.85);
    for (const p of place(12, 4, 9, () => true, 11)) eosinophil(L, p, R, 0.85);
    for (const p of place(5, 4.6, 13, () => true, 12)) macroS(L, p, R, 0.85);
  } else {
    // 1–2 cells per septum, a few more in the looser LP under the surface and above the muscularis
    for (const p of place(22, 3.5, 9, () => true, 7)) plasmaS(L, p, R, 0.8);
    for (const p of place(18, 2.5, 8, () => true, 9)) lymphS(L, p, R() < 0.75 ? "T" : "B", R, 2.4);
    for (const p of place(5, 3.9, 14, () => true, 11)) eosinophil(L, p, R, 0.82);
    for (const p of place(3, 4.4, 20, () => true, 12)) macroS(L, p, R, 0.8);
  }

  /* --- crypt abscess: neutrophils and debris packed in the dilated crypt lumen --- */
  if (abs) {
    const lum = cryptKeys(abs, top);
    const lumPoly = catmull(lum.slice(2, -2), 4);
    for (const p of packWhere({ x: abs.x - 12, y: top + 30, w: 24, h: abs.D }, 9, 6.6, (q) => checkInside([q], lumPoly, 3.8).ok && q[1] > top + abs.D * 0.4, { seed: seed + 13 })) neutS(L, p, R, 0.9);
  }

  /* --- epithelium: colonocytes and goblet cells, nuclei at the base --- */
  const gobletRate = (c) => (colitis ? (c.ctr[1] < top + 13 ? 0.04 : 0.08) : c.ctr[1] < top + 11 ? 0.22 : c.ctr[1] > top + 114 ? 0.32 : 0.62);
  for (const c of cells) {
    const n = c.poly.length / 2;
    const apex = mean(c.poly.slice(0, n)), base = mean(c.poly.slice(n));
    const at = (t) => [apex[0] + (base[0] - apex[0]) * t, apex[1] + (base[1] - apex[1]) * t];
    const ang = Math.atan2(base[1] - apex[1], base[0] - apex[0]) * R2D, hgt = dist(apex, base);
    const isG = R() < gobletRate(c);
    const poly = c.poly;
    L.add(isG ? "goblet" : "entero", roundPoly(poly, 0.8));
    if (isG) {
      const mp = at(0.36), wid = dist(poly[0], poly[n - 1]);
      let cup = blobPts(mp[0], mp[1], hgt * 0.31, Math.max(1.6, wid * 0.52), { n: 8, wobble: 0.05, seed: c.i, rot: ang });
      cup = fitInside(cup, poly, 0.45) ?? cup;
      L.add("mucin", smoothClosed(cup));
      const np = at(0.84);
      let nuc = blobPts(np[0], np[1], 1.1, 1.8, { n: 7, wobble: 0.05, seed: c.i + 1, rot: ang });
      nuc = fitInside(nuc, poly, 0.35) ?? nuc;
      L.add("epiNuc", smoothClosed(nuc));
    } else {
      const np = at(vary(R, 0.76, 0.05));
      let nuc = blobPts(np[0], np[1], hgt * 0.19, Math.min(1.35, dist(poly[0], poly[n - 1]) * 0.32), { n: 8, wobble: 0.06, seed: c.i + 2, rot: ang });
      nuc = fitInside(nuc, poly, 0.35) ?? nuc;
      L.add("epiNuc", smoothClosed(nuc));
    }
  }
  if (colitis) {
    // cryptitis: neutrophils squeezing through the crypt epithelium
    for (const c of cells.filter((c) => Math.abs(c.ctr[0] - 100) < 26 && c.ctr[1] > top + 60).filter((_, i) => i % 9 === 4).slice(0, 3)) neutS(L, c.ctr, R, 0.75);
    // the erosion: fibrin and neutrophils cap the exposed lamina propria
    const cap = [[ero[0] - 4, top + 3], [ero[0] + 4, top - 4], [219, top - 7], [ero[1] - 4, top - 4], [ero[1] + 4, top + 3], [219, top + 6]];
    L.add("fibrin", smoothClosed(cap, 0.8));
    for (const p of packWhere({ x: ero[0], y: top - 8, w: ero[1] - ero[0], h: 14 }, 5, 7.4, (q) => checkInside([q], cap, 3).ok, { seed: seed + 17 })) {
      neutS(L, p, R, 0.8);
    }
  }
  return clampScene({ size: [320, 240], lineWidth: 1.3, parts: L.parts() }, [X0, 0, X1, YB]);
}

/* ===================== liver ===================== */

// Liver lobule (300 × 240), one geometry for both states. Plan, bottom → top:
//   sinusoid background (pale, with RBCs) → portal tract stroma + collagen → hepatocytes (plates of
//   polygonal cells radiating from the central vein, sinusoids between plates) → fat droplets (steatosis)
//   → hepatocyte nuclei → Kupffer/endothelial nuclei and RBCs in the sinusoids → central vein (lumen,
//   endothelium, RBCs) → portal vein, hepatic artery, bile duct → lymphocytes.
// Plates: cord centrelines grow outward from the central vein with a gentle meander; a new cord starts
// where two diverge (plates branch and anastomose), cords merge where they converge. Cells are a ray-cast
// partition of sites along the cords; a cell is inset far where it faces another cord (a sinusoid) and
// barely where it faces its neighbour in the same plate (a cell junction).
// Steatosis (MASLD): macrovesicular droplets pushing the nucleus to the cell edge, densest round the
// central vein (zone 3), a few microvesicular cells, a small focus of lobular inflammation.

/** Ray-cast partition (Voronoi) of sites, stopped by obstacle discs and a rounded frame. */
function liverCells(sites, inFrame, obstacles, nRays = 64) {
  return sites.map((s, i) => {
    const poly = [], own = [];
    for (let k = 0; k < nRays; k++) {
      const a = (k / nRays) * Math.PI * 2, u = [Math.cos(a), Math.sin(a)];
      let best = 40, who = -1;
      for (let j = 0; j < sites.length; j++) {
        if (j === i) continue;
        const dx = sites[j][0] - s[0], dy = sites[j][1] - s[1], c = dx * dx + dy * dy;
        if (c > 50 * 50) continue;
        const b = u[0] * dx + u[1] * dy;
        if (b <= 0) continue;
        const r = c / (2 * b);
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
      // frame: walk back inside the rounded rectangle
      let lo = 0, hi = best;
      if (!inFrame([s[0] + u[0] * hi, s[1] + u[1] * hi])) {
        for (let it = 0; it < 18; it++) {
          const mid = (lo + hi) / 2;
          if (inFrame([s[0] + u[0] * mid, s[1] + u[1] * mid])) lo = mid;
          else hi = mid;
        }
        best = lo;
        who = -1;
      }
      poly.push([s[0] + u[0] * best, s[1] + u[1] * best]);
      own.push(who);
    }
    return { poly, own };
  });
}

function liver(steatosis, seed = 81) {
  const R = rng(seed), L = new Layers();
  const X0 = 8, Y0 = 8, W = 284, H = 224, cv = [150, 118], cvR = 15;
  const pal = { sinus: "#fbe8ea", hep: "#f2bccb", nuc: "#7a54a5", fat: "#fffaf0", fatEdge: "#ead9b6", kupffer: "#b17fc4", stroma: "#f7dfe3", duct: "#e9c3e9", cvWall: "#f3c7cf" };
  L.def("sinus", { fill: pal.sinus, lineWidth: 0.6 })
    .def("stroma", { fill: pal.stroma, stroke: sw(shade(pal.stroma, 0.1), 0.6), lineWidth: 0.7, line: true })
    .def("collagen", { fill: "none", stroke: { color: "#eebbc2", width: 1.2, cap: "round" }, lineColor: "#d9a2ab", lineStrokeWidth: 0.6 });
  // (line style: thin outlines in a light hepatocyte hue, so hundreds of cells do not turn the lobule grey)
  L.def("hep", { fill: pal.hep, stroke: sw(shade(pal.hep, 0.16), 0.7), lineWidth: 0.4, lineColor: "#c98a9c" })
    .def("fatDrop", { fill: pal.fat, stroke: sw(pal.fatEdge, 0.6), lineWidth: 0.4, lineColor: "#c9b07c" })
    .def("hepNuc", { fill: pal.nuc, shade: "small", lineWidth: 0.4 })
    .def("kupffer", { fill: pal.kupffer, lineWidth: 0.35 })
    .def("sinEndo", { fill: "#9a6bb4", lineWidth: 0.3 })
    .def("cvWall", { fill: pal.cvWall, stroke: sw(shade(pal.cvWall, 0.16), 0.7), lineWidth: 0.8 })
    .def("cvLumen", { fill: "#fdf0ef", lineWidth: 0.5 });
  std(L, ["artWall", "wall", "lumen", "rbc", "endo"]);
  L.def("duct", { fill: pal.duct, stroke: sw(shade(pal.duct, 0.16), 0.5), lineWidth: 0.55 })
    .def("ductNuc", { fill: "#6a4a9a", lineWidth: 0.3 })
    .def("ductLumen", { fill: "#fffaf8", lineWidth: 0.3 })
    .def("rbc2", { fill: C.rbc, shade: "small", lineWidth: 0.5 });
  std(L, ["tcell", "tnuc", "mac", "macNuc"]);

  const frame = rectPoly(X0, Y0, W, H);
  L.add("sinus", polyD(frame)); // a straight-cut block, square corners
  const inFrame = ([x, y]) => {
    const r = 2, xi = Math.min(Math.max(x, X0 + r), X0 + W - r), yi = Math.min(Math.max(y, Y0 + r), Y0 + H - r);
    return x >= X0 + 2 && x <= X0 + W - 2 && y >= Y0 + 2 && y <= Y0 + H - 2 && Math.hypot(x - xi, y - yi) <= r - 2;
  };

  /* --- portal tracts at three corners (cut by the frame) --- */
  const tracts = [
    { c: [24, 26], r: 34, pv: [30, 34, 12, 8, 30], ha: [50, 22, 4.6], bd: [18, 52, 6.2] },
    { c: [278, 218], r: 38, pv: [268, 213, 12, 8.5, -20], ha: [245, 211, 5], bd: [283, 191, 6.4] },
    { c: [290, 14], r: 22, pv: [284, 22, 8, 6, 60], ha: null, bd: [268, 14, 5] },
  ];
  const obstacles = [[cv[0], cv[1], cvR + 1.5], ...tracts.map((t) => [t.c[0], t.c[1], t.r])];

  /* --- plate centrelines --- */
  const G = rng(seed + 30);
  let cords = unevenAngles(9, G, { cv: 0.25 }).map((a) => ({ a: (a * Math.PI) / 180, id: 0, drift: (G() - 0.5) * 0.02 }));
  cords.forEach((c, i) => (c.id = i));
  let nextId = cords.length;
  const sites = [], cordOf = [];
  for (let r = cvR + 7; r < 200; r += vary(G, 10.5, 0.08)) {
    cords.sort((p, q) => p.a - q.a);
    // branch where plates diverge, merge where they converge (arc spacing ~ one plate + one sinusoid)
    const next = [];
    for (let i = 0; i < cords.length; i++) {
      const c = cords[i], d = cords[(i + 1) % cords.length];
      let gap = d.a - c.a;
      if (gap <= 0) gap += Math.PI * 2;
      next.push(c);
      if (gap * r > 32) next.push({ a: c.a + gap / 2 + (G() - 0.5) * 0.05, id: nextId++, drift: (G() - 0.5) * 0.02 });
    }
    cords = next.filter((c, i) => {
      const d = next[(i + 1) % next.length];
      let gap = d.a - c.a;
      if (gap <= 0) gap += Math.PI * 2;
      return gap * r > 11 || G() < 0.5;
    });
    for (const c of cords) {
      c.a += c.drift + (G() - 0.5) * 0.035;
      const p = [cv[0] + Math.cos(c.a) * r + (G() - 0.5) * 2, cv[1] + Math.sin(c.a) * r + (G() - 0.5) * 2];
      if (!inFrame(p) || obstacles.some(([ox, oy, orr]) => Math.hypot(p[0] - ox, p[1] - oy) < orr + 3)) continue;
      sites.push(p);
      cordOf.push(c.id);
    }
  }

  /* --- hepatocytes --- */
  const cells = liverCells(sites, inFrame, obstacles);
  const focus = [[96, 70, 11]];
  const sinusPts = [];
  cells.forEach(({ poly, own }, i) => {
    // inset: wide toward other plates (sinusoid), narrow toward the same plate (junction), small at vessels
    const s = sites[i];
    let pts = poly.map((p, k) => {
      const o = own[k], d = o >= 0 && cordOf[o] === cordOf[i] ? 0.6 : o === -2 ? 1.2 : o === -1 ? 0.4 : 2.7;
      const dl = Math.hypot(p[0] - s[0], p[1] - s[1]) || 1;
      if (o >= 0 && cordOf[o] !== cordOf[i] && G() < 0.06) sinusPts.push([p, Math.atan2(sites[o][1] - s[1], sites[o][0] - s[0]) * R2D + 90]);
      return [p[0] - ((p[0] - s[0]) / dl) * d, p[1] - ((p[1] - s[1]) / dl) * d];
    });
    for (let pass = 0; pass < 3; pass++) pts = pts.map((q, k) => {
      const a = pts[(k - 1 + pts.length) % pts.length], b = pts[(k + 1) % pts.length];
      return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
    });
    if (area(pts) < 40) return;
    // (steatosis) hepatocytes dropped out where the inflammatory focus sits
    if (steatosis && focus.some(([x, y, r]) => dist(centroid(pts), [x, y]) < r)) return;
    L.add("hep", smoothClosed(pts.filter((_, k) => k % 2 === 0), 0.7));
    const c = centroid(pts), rr = Math.sqrt(area(pts) / Math.PI);
    // zone 3 predominant: ≈70 % of hepatocytes next to the central vein, ≈15 % in zone 1 by the portal tracts
    if (steatosis && R() < 0.12 + 0.62 * Math.pow(Math.max(0, 1 - (dist(c, cv) - cvR) / 110), 1.2)) {
      if (R() < 0.92) {
        // macrovesicular: one droplet fills the cell, the nucleus squeezed flat against the membrane
        let drop = blobPts(c[0], c[1], rr * 0.9, rr * 0.86, { n: 9, wobble: 0.03, seed: i, rot: R() * 180 });
        drop = fitInside(drop, pts, 0.55) ?? drop;
        L.add("fatDrop", smoothClosed(drop));
        const a = R() * Math.PI * 2;
        let nuc = blobPts(c[0] + Math.cos(a) * rr * 0.8, c[1] + Math.sin(a) * rr * 0.8, 2.7, 1, { n: 7, wobble: 0.05, seed: i + 7, rot: (a * 180) / Math.PI + 90 });
        nuc = fitInside(nuc, pts, 0.4) ?? nuc;
        L.add("hepNuc", smoothClosed(nuc));
      } else {
        // microvesicular: many small droplets round a central nucleus
        for (const q of packIn(c[0], c[1], rr * 0.62, rr * 0.62, 6, 2.6, { seed: i, avoid: [[c[0], c[1], 3.4]] })) L.add("fatDrop", circle(q[0], q[1], 1.1));
        L.add("hepNuc", circle(c[0], c[1], 2.6));
      }
    } else {
      L.add("hepNuc", circle(c[0] + (R() - 0.5), c[1] + (R() - 0.5), vary(R, 3, 0.1)));
      if (R() < 0.08) L.add("hepNuc", circle(c[0] + rr * 0.4, c[1] - rr * 0.2, 2.5)); // binucleate hepatocyte
    }
  });
  // sinusoid contents: red cells in single file, flat endothelial and Kupffer nuclei along the plates
  sinusPts.forEach(([p, a], k) => {
    if (steatosis && focus.some(([x, y, r]) => dist(p, [x, y]) < r)) return;
    if (k % 4 === 3) L.add("kupffer", ellipse(p[0], p[1], 3.2, 1.3, a));
    else if (k % 4 === 1) L.add("sinEndo", ellipse(p[0], p[1], 2.4, 0.7, a));
    else L.add("rbc", ellipse(p[0], p[1], 1.9, 1.3, a));
  });

  /* --- central vein: thin wall, sinusoids open into it --- */
  L.add("cvWall", circle(cv[0], cv[1], cvR + 1.2));
  L.add("cvLumen", circle(cv[0], cv[1], cvR - 0.6));
  for (const a of unevenAngles(4, R)) {
    const ar = (a * Math.PI) / 180;
    L.add("endo", ellipse(cv[0] + Math.cos(ar) * (cvR - 0.6), cv[1] + Math.sin(ar) * (cvR - 0.6), 2.4, 0.8, a + 90));
  }
  for (const p of packIn(cv[0], cv[1], cvR * 0.55, cvR * 0.55, 4, 6.5, { seed })) L.add("rbc2", rbc(p[0], p[1], 2.9, R() * 180));

  /* --- portal tracts: connective tissue with portal vein, hepatic artery, bile duct --- */
  for (const t of tracts) {
    const out = blobPts(t.c[0], t.c[1], t.r - 1.5, t.r - 1.5, { n: 10, wobble: 0.08, seed: Math.round(t.c[0]) }).map((p) => [Math.min(Math.max(p[0], X0 + 0.5), X0 + W - 0.5), Math.min(Math.max(p[1], Y0 + 0.5), Y0 + H - 0.5)]);
    L.add("stroma", smoothClosed(out, 0.8));
    for (let k = 0; k < 4; k++) {
      const a0 = R() * Math.PI * 2, rr = t.r * (0.45 + R() * 0.4);
      const pts = Array.from({ length: 7 }, (_, q) => [t.c[0] + Math.cos(a0 + q * 0.16) * rr, t.c[1] + Math.sin(a0 + q * 0.16) * rr]);
      if (pts.every((p) => inFrame(p))) L.add("collagen", smoothOpen(pts));
    }
    const [px, py, prx, pry, prot] = t.pv;
    vessel(L, { cx: px, cy: py, rx: prx, ry: pry, rot: prot, kind: "ven", seed: Math.round(px) });
    if (t.ha) vessel(L, { cx: t.ha[0], cy: t.ha[1], rx: t.ha[2], kind: "art", seed: Math.round(t.ha[0]) });
    // bile duct: a ring of cuboidal cells round a small lumen
    const [bx, by, br] = t.bd;
    const n = 7 + Math.floor(R() * 2), a0 = R() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const s = a0 + (k / n) * Math.PI * 2, e = a0 + ((k + 1) / n) * Math.PI * 2, poly = [];
      for (let q = 0; q <= 3; q++) poly.push([bx + Math.cos(s + ((e - s) * q) / 3) * br, by + Math.sin(s + ((e - s) * q) / 3) * br]);
      for (let q = 3; q >= 0; q--) poly.push([bx + Math.cos(s + ((e - s) * q) / 3) * br * 0.45, by + Math.sin(s + ((e - s) * q) / 3) * br * 0.45]);
      L.add("duct", roundPoly(poly, 0.6));
      const m = (s + e) / 2;
      L.add("ductNuc", ellipse(bx + Math.cos(m) * br * 0.74, by + Math.sin(m) * br * 0.74, 1.3, 1.1, (m * 180) / Math.PI));
    }
    L.add("ductLumen", circle(bx, by, br * 0.43));
    for (const p of packWhere({ x: t.c[0] - t.r, y: t.c[1] - t.r, w: 2 * t.r, h: 2 * t.r }, 3, 7, (q) => dist(q, t.c) < t.r - 6 && [[-4, 0], [4, 0], [0, -4], [0, 4]].every(([dx, dy]) => inFrame([q[0] + dx, q[1] + dy])) && dist(q, [px, py]) > prx + 4 && dist(q, [bx, by]) > br + 4 && (!t.ha || dist(q, t.ha) > t.ha[2] + 4), { seed: Math.round(t.c[1]) })) lymphocyte(L, p, 2.9, "T", R);
  }
  if (steatosis) {
    // lobular inflammation: a small cluster of lymphocytes and a macrophage between plates
    for (const p of packIn(96, 70, 8, 6, 5, 6.2, { seed: seed + 2 })) lymphocyte(L, p, 3, "T", R);
  }
  return clampScene({ size: [300, 240], lineWidth: 1.3, parts: L.parts() }, [X0, Y0, X0 + W, Y0 + H]);
}

/* ===================== trabecular bone ===================== */

// Trabecular (cancellous) bone (240 × 240), one geometry for both states. Plan, bottom → top:
//   bone (the background block) → lamellar lines → osteocyte lacunae + osteocytes → marrow spaces (one
//   united shape: weighted-Voronoi spaces whose walls are the trabeculae, plus perforations and Howship
//   lacunae) → osteoid seams → adipocytes → haematopoietic cells (nucleated, erythroid) →
//   megakaryocyte → osteoblasts → osteoclasts.
// Healthy: thick, connected plates and struts of uneven width; red marrow with ~40 % fat.
// Osteoporosis: the same network thinned, perforated and disconnected (free strut ends, isolated
// fragments), fatty marrow, more osteoclasts in resorption pits, few osteoblasts.
function bone(osteoporosis, seed = 91) {
  const R = rng(seed), L = new Layers();
  const X0 = 10, Y0 = 10, S = 220;
  const pal = { bone: "#efd7a4", lamella: "#e2c385", lacuna: "#f8ebcc", ocyte: "#8a6a9a", marrow: "#f3cdd3", hema: "#8e5fb0", ery: "#d9434b", fat: "#fdf6dc", fatEdge: "#e5cf8f", osteoid: "#f4c9b0", blast: "#c9a6dc", blastNuc: "#6a4790", clast: "#e7a1b8", clastNuc: "#7a4f9c", mega: "#e6c2e8" };
  L.def("bone", { fill: pal.bone, lineWidth: 0.7 })
    .def("lamella", { fill: "none", stroke: { color: pal.lamella, width: 0.8, cap: "round" }, lineColor: "#c9a868", lineStrokeWidth: 0.45 })
    .def("lacuna", { fill: pal.lacuna, lineWidth: 0.3 })
    .def("ocyte", { fill: pal.ocyte, lineWidth: 0.3 })
    .def("marrow", { fill: pal.marrow, stroke: sw(shade(pal.bone, 0.2), 0.9), lineWidth: 1, unite: [] })
    .def("osteoid", { fill: pal.osteoid, lineWidth: 0.4 })
    .def("fat", { fill: pal.fat, stroke: sw(pal.fatEdge, 0.6), lineWidth: 0.6 })
    .def("hema", { fill: pal.hema, lineWidth: 0.25 })
    .def("ery", { fill: pal.ery, lineWidth: 0.25 })
    .def("mega", { fill: pal.mega, stroke: sw(shade(pal.mega, 0.16), 0.5), shade: "small", lineWidth: 0.6 })
    .def("megaNuc", { fill: "#7b4fa6", lineWidth: 0.3 })
    .def("blast", { fill: pal.blast, stroke: sw(shade(pal.blast, 0.16), 0.45), lineWidth: 0.5 })
    .def("blastNuc", { fill: pal.blastNuc, lineWidth: 0.25 })
    .def("clast", { fill: pal.clast, shade: "small", lineWidth: 0.7, unite: [] })
    .def("clastNuc", { fill: pal.clastNuc, lineWidth: 0.3 });

  const frame = rectPoly(X0, Y0, S, S);
  L.add("bone", polyD(frame)); // a straight-cut block, square corners
  const inFrame = ([x, y], m = 0) => {
    const r = 0, xi = Math.min(Math.max(x, X0 + r), X0 + S - r), yi = Math.min(Math.max(y, Y0 + r), Y0 + S - r);
    return x >= X0 + m && x <= X0 + S - m && y >= Y0 + m && y <= Y0 + S - m && Math.hypot(x - xi, y - yi) <= Math.max(0, r - m) + 1e-9;
  };

  /* --- marrow spaces (shared geometry) --- */
  const G = rng(seed + 100);
  const sites = [], radii = [];
  for (let t = 0; t < 6000 && sites.length < 30; t++) {
    const r = G() < 0.2 ? 30 + G() * 8 : 18 + G() * 10, p = [X0 + G() * S, Y0 + G() * S];
    if (sites.some((q, i) => dist(q, p) < (r + radii[i]) * 0.8)) continue;
    sites.push(p);
    radii.push(r);
  }
  const { cells, owners } = apollonius(sites, radii, [X0, Y0, S, S], 120);
  // strut thickness varies from space to space (wall = half of each side)
  const half = sites.map(() => (osteoporosis ? vary(G, 2.6, 0.35) : vary(G, 5.4, 0.3)));
  const spaces = cells.map((poly, i) => {
    let pts = poly.map((p, k) => {
      const o = owners[i][k], s = sites[i];
      let q = p;
      // spaces run off the frame (cut edge); pull points back inside the rounded corners
      if (o === -1) {
        let lo = 0, hi = 1;
        if (!inFrame(q, 0.6)) {
          for (let it = 0; it < 16; it++) {
            const mid = (lo + hi) / 2, m = [s[0] + (p[0] - s[0]) * mid, s[1] + (p[1] - s[1]) * mid];
            if (inFrame(m, 0.6)) lo = mid;
            else hi = mid;
          }
          q = [s[0] + (p[0] - s[0]) * lo, s[1] + (p[1] - s[1]) * lo];
        }
        return q;
      }
      const dl = dist(p, s) || 1, d = half[i];
      return [p[0] - ((p[0] - s[0]) / dl) * d, p[1] - ((p[1] - s[1]) / dl) * d];
    });
    for (let pass = 0; pass < 7; pass++) pts = pts.map((q, k) => {
      if (owners[i][k] === -1) return q;
      const a = pts[(k - 1 + pts.length) % pts.length], b = pts[(k + 1) % pts.length];
      return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
    });
    return pts;
  });
  // walls between neighbouring spaces (for perforations, osteoclast pits)
  const walls = [];
  owners.forEach((own, i) => {
    const n = own.length;
    for (let k = 0; k < n; k++) {
      const j = own[k];
      if (j > i && own[(k + 1) % n] === j && own[(k - 1 + n) % n] === j) walls.push({ i, j, p: cells[i][k], k });
    }
  });
  const marrow = L.map.get("marrow").unite;
  spaces.forEach((pts) => marrow.push(smoothClosed(pts.filter((_, k) => k % 2 === 0), 0.8)));
  // perforations: struts broken through (a few in health, many in osteoporosis) leave free ends
  const GP = rng(seed + 7);
  const used = new Set(), perfs = [];
  for (const w of walls) {
    const key = w.i + ":" + w.j;
    if (used.has(key) || GP() > (osteoporosis ? 0.16 : 0.025)) continue;
    const a = Math.atan2(sites[w.j][1] - sites[w.i][1], sites[w.j][0] - sites[w.i][0]) * R2D;
    const hole = ellipse(w.p[0], w.p[1], half[w.i] + half[w.j] + 2.4, vary(GP, 7, 0.25), a);
    if (!flatten(hole).flat().every((q) => inFrame(q, 1))) continue;
    used.add(key);
    perfs.push(w.p);
    marrow.push(hole);
  }
  const inSpace = (q, m = 0) => spaces.some((pts) => checkInside([q], pts, m).ok);

  /* --- lamellae and osteocytes in the bone --- */
  if (!osteoporosis) {
    spaces.forEach((pts, i) => {
      for (const off of [2.2, 4.2]) {
        if (off > half[i] * 1.6) continue;
        // follow the strut surface, in unbroken runs (never across a gap)
        const ring = offsetClosed(pts, off);
        let run = [];
        const flush = () => {
          if (run.length > 6) L.add("lamella", smoothOpen(run.filter((_, q) => q % 2 === 0 || q === run.length - 1)));
          run = [];
        };
        ring.forEach((q, k) => (owners[i][k] !== -1 && inFrame(q, 3) && !inSpace(q, -1.2) ? run.push(q) : flush()));
        flush();
      }
    });
  }
  for (const q of packWhere({ x: X0, y: Y0, w: S, h: S }, osteoporosis ? 22 : 48, 8, (p) => inFrame(p, 5) && !inSpace(p, -2.6), { seed: seed + 2 })) {
    // long axis parallel to the nearest trabecular surface
    let best = null, bd = Infinity;
    for (const pts of spaces) for (const v of pts) {
      const d = dist(v, q);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    const ang = Math.atan2(best[1] - q[1], best[0] - q[0]) * R2D + 90;
    L.add("lacuna", ellipse(q[0], q[1], 3, 1.7, ang));
    L.add("ocyte", ellipse(q[0], q[1], 2.1, 1, ang));
  }

  /* --- osteoclasts in Howship lacunae: a scalloped pit (two shallow arcs, ≈3.3 deep) is cut out of the bone
     surface (the pit joins the marrow, which paints over the bone); the cell's underside is the same two arcs, so
     it fills the pit flush, and its body bulges into the marrow, never over bone --- */
  const clasts = [];
  const GC = rng(seed + 9);
  const ellPts = (c, rx, ry, a, n = 28) => Array.from({ length: n }, (_, k) => {
    const t = (k / n) * Math.PI * 2, x = Math.cos(t) * rx, y = Math.sin(t) * ry;
    return [c[0] + x * Math.cos(a) - y * Math.sin(a), c[1] + x * Math.sin(a) + y * Math.cos(a)];
  });
  const big = walls.filter((w) => half[w.i] + half[w.j] > (osteoporosis ? 5.4 : 9) && !used.has(w.i + ":" + w.j));
  // osteoporosis: try the struts next to a perforation first (resorption that broke through)
  const order0 = osteoporosis ? big.slice().sort((a, b) => Math.min(...perfs.map((p) => dist(p, a.p)), 1e9) - Math.min(...perfs.map((p) => dist(p, b.p)), 1e9)) : big;
  for (let t = 0; t < 400 && clasts.length < (osteoporosis ? 3 : 2); t++) {
    const w = t < 12 && osteoporosis ? order0[t] : big[Math.floor(GC() * big.length)];
    if (!w || clasts.some((c) => dist(c.surf, w.p) < (osteoporosis ? 36 : 46))) continue;
    // the cell sits on the side of the wider marrow space
    const side = GC() < 0.5 ? w.i : w.j, s = sites[side], dl = dist(w.p, s), u = [(w.p[0] - s[0]) / dl, (w.p[1] - s[1]) / dl];
    const surf = [w.p[0] - u[0] * half[side], w.p[1] - u[1] * half[side]];
    if (!inFrame(surf, 18)) continue;
    const tg = [-u[1], u[0]], a = Math.atan2(tg[1], tg[0]), sc = osteoporosis ? 0.9 : 1;
    const pits = [-1, 1].map((k) => ({ c: [surf[0] + tg[0] * k * 4.2 * sc - u[0] * 0.9, surf[1] + tg[1] * k * 4.2 * sc - u[1] * 0.9], rx: 5.4 * sc, ry: 4.2 }));
    const body = { c: [surf[0] - u[0] * 4.4, surf[1] - u[1] * 4.4], rx: 9.2 * sc, ry: 5.4 };
    // the body must lie in this marrow space (or the pit), clear of every other strut
    const inPit = (q) => pits.some((p) => { const d = [q[0] - p.c[0], q[1] - p.c[1]]; const x = (d[0] * tg[0] + d[1] * tg[1]) / p.rx, y = (d[0] * u[0] + d[1] * u[1]) / p.ry; return x * x + y * y <= 1; });
    const bodyPts = ellPts(body.c, body.rx + 0.8, body.ry + 0.8, a).filter((q) => (q[0] - surf[0]) * u[0] + (q[1] - surf[1]) * u[1] < -0.5);
    if (!bodyPts.every((q) => (checkInside([q], spaces[side], 0.4).ok || inPit(q)) && inFrame(q, 4))) continue;
    for (const p of pits) marrow.push(polyD(ellPts(p.c, p.rx, p.ry, a)));
    clasts.push({ surf, u, tg, a, pits, body, i: side, ctr: body.c });
  }

  /* --- marrow: adipocytes and haematopoietic cells --- */
  const fatFrac = osteoporosis ? 0.82 : 0.4;
  const fats = [];
  spaces.forEach((pts, i) => {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const cand = packWhere(box, 40, 13, (q) => checkInside([q], pts, 6.4).ok && inFrame(q, 6) && !clasts.some((c) => dist(c.ctr, q) < 17), { seed: seed + 30 + i });
    // adipocytes cluster: take the candidates nearest a random point in the space
    const anchor = cand[Math.floor(R() * cand.length)] || [0, 0];
    cand.sort((a, b) => dist(a, anchor) - dist(b, anchor));
    for (const q of cand.slice(0, Math.round(cand.length * fatFrac * vary(R, 1, 0.3)))) {
      fats.push(q);
      L.add("fat", blob(q[0], q[1], vary(R, 6.6, 0.1), vary(R, 6.2, 0.1), { n: 7, wobble: 0.08, seed: Math.round(q[0] * 7 + q[1]) }));
    }
  });
  let mega = null;
  for (const q of packWhere({ x: X0, y: Y0, w: S, h: S }, osteoporosis ? 180 : 520, 3.4, (p) => inSpace(p, 2.2) && inFrame(p, 3) && !fats.some((f) => dist(f, p) < 8.2) && !clasts.some((c) => dist(c.ctr, p) < 12.5), { seed: seed + 5 })) {
    if (!osteoporosis && !mega && inSpace(q, 9) && !fats.some((f) => dist(f, q) < 16)) {
      mega = q;
      continue;
    }
    if (mega && dist(q, mega) < 9) continue;
    if (R() < 0.3) L.add("ery", circle(q[0], q[1], vary(R, 1.05, 0.1)));
    else L.add("hema", circle(q[0], q[1], vary(R, 1.35, 0.18)));
  }
  if (mega) {
    // megakaryocyte: a giant cell with a lobulated nucleus
    L.add("mega", blob(mega[0], mega[1], 7.5, 6.6, { n: 9, wobble: 0.1, seed: seed + 11 }));
    L.add("megaNuc", [0, 1, 2].map((k) => circle(mega[0] - 2 + k * 2.2, mega[1] + (k % 2 ? -1.2 : 1), 2.1)).join(""));
  }

  /* --- osteoblast seams (cuboidal cells on a pale osteoid band) --- */
  const seams = osteoporosis ? 1 : 4;
  const order = spaces.map((_, i) => i).filter((i) => half[i] > (osteoporosis ? 2.2 : 4.6) && inFrame(sites[i], 30)).slice(0, 12);
  let made = 0;
  for (const i of order) {
    if (made >= seams) break;
    const pts = spaces[i], own = owners[i];
    // a run of the outline on a strut (not the frame), about a fifth of the space
    const n = pts.length, k0 = Math.floor(R() * n), len = Math.round(n * (osteoporosis ? 0.12 : 0.2));
    const run = [];
    for (let k = 0; k < len; k++) {
      const idx = (k0 + k) % n;
      if (own[idx] < 0) break;
      run.push(pts[idx]);
    }
    if (run.length < len * 0.9 || clasts.some((c) => c.i === i)) continue;
    const line = resample(run, 1);
    const nrm = normals(line), c0 = sites[i];
    const dir = line.reduce((v, p, k) => v + Math.sign((c0[0] - p[0]) * nrm[k][0] + (c0[1] - p[1]) * nrm[k][1]), 0) >= 0 ? line : line.slice().reverse();
    L.add("osteoid", ribbon(dir, 2.4));
    for (const c of cellBand(dir, { rows: 1, thickness: 5.4, cellLen: 5.4, jitter: 0.18, seed: seed + i })) {
      const nn = c.poly.length / 2, base = meanOf(c.poly.slice(0, nn)), apex = meanOf(c.poly.slice(nn));
      const poly = c.poly.map(([x, y]) => [x + (apex[0] - base[0]) * 0.22, y + (apex[1] - base[1]) * 0.22]);
      L.add("blast", roundPoly(poly, 1.2));
      L.add("blastNuc", circle(base[0] + (apex[0] - base[0]) * 0.72, base[1] + (apex[1] - base[1]) * 0.72, 1.35));
    }
    made++;
  }

  /* --- osteoclasts: one silhouette per cell (pit arcs + body), 4–8 nuclei clustered irregularly in its centre --- */
  const clastU = L.map.get("clast").unite;
  for (const c of clasts) {
    const pieces = [...c.pits.map((p) => polyD(ellPts(p.c, p.rx, p.ry, c.a))), polyD(ellPts(c.body.c, c.body.rx, c.body.ry, c.a))];
    clastU.push(...pieces);
    const n = 4 + Math.floor(GC() * 5), nuc = [];
    for (let t = 0; t < 400 && nuc.length < n; t++) {
      const lx = (GC() * 2 - 1) * c.body.rx * 0.55, ly = (GC() * 2 - 1) * c.body.ry * 0.42;
      if ((lx / (c.body.rx * 0.6)) ** 2 + (ly / (c.body.ry * 0.5)) ** 2 > 1) continue;
      const q = [c.body.c[0] + lx * c.tg[0] + ly * c.u[0], c.body.c[1] + lx * c.tg[1] + ly * c.u[1]];
      if (nuc.some((o) => dist(o, q) < 2.5)) continue;
      nuc.push(q);
    }
    for (const q of nuc) L.add("clastNuc", ellipse(q[0], q[1], vary(GC, 1.35, 0.12), vary(GC, 1.15, 0.12), GC() * 180));
  }
  return clampScene({ size: [240, 240], lineWidth: 1.3, parts: L.parts() }, [X0, Y0, X0 + S, Y0 + S]);
}
const meanOf = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);

const H = ["healthy", "normal"];
const D = ["disease", "pathology"];
export const icons = [
  { slug: "artery-healthy", name: "Artery — healthy (cross-section)", category: "tissues", tags: ["artery", "blood vessel", "vascular wall", "intima", "media", "adventitia", "elastic lamina", "smooth muscle", "endothelium", ...H], scene: () => artery(false) },
  { slug: "artery-atherosclerosis", name: "Artery — atherosclerotic plaque", category: "tissues", tags: ["artery", "atherosclerosis", "atheroma", "plaque", "foam cells", "lipid core", "cholesterol crystals", "cholesterol clefts", "necrotic core", "fibrous cap", "calcification", "neovessel", "stenosis", "eccentric lumen", "coronary artery disease", "CAD", "cardiovascular", ...D], scene: () => artery(true) },
  { slug: "skin-healthy", name: "Skin — healthy (section)", category: "tissues", tags: ["skin", "epidermis", "dermis", "hypodermis", "keratinocytes", "stratum corneum", "rete ridges", "dermal papillae", "capillary loops", "subpapillary plexus", "stratum basale", "stratum spinosum", "stratum granulosum", "melanocyte", "H&E", "papillary dermis", "reticular dermis", "adnexa", "hair follicle", "sebaceous gland", "eccrine sweat gland", "collagen", ...H], scene: () => skin(false) },
  { slug: "skin-psoriasis", name: "Skin — psoriasis", category: "tissues", tags: ["skin", "psoriasis", "psoriatic plaque", "acanthosis", "parakeratosis", "Munro microabscess", "elongated rete ridges", "dilated capillaries", "tortuous capillaries", "hypogranulosis", "T cells", "dendritic cells", "IL-17", "IL-23", "plaque psoriasis", "psoriasis vulgaris", "inflammation", "dermatology", "hair follicle", "sebaceous gland", "eccrine sweat gland", ...D], scene: () => skin(true) },
  { slug: "lung-alveoli-healthy", name: "Lung alveoli — healthy", category: "tissues", tags: ["lung", "alveoli", "alveolar septa", "pneumocytes", "type I pneumocyte", "type II pneumocyte", "AT1", "AT2", "alveolar macrophage", "alveolar duct", "bronchiole", "capillaries", "gas exchange", "parenchyma", "pulmonary", "H&E", ...H], scene: () => lung("healthy") },
  { slug: "lung-alveoli-pneumonia", name: "Lung alveoli — pneumonia", category: "tissues", tags: ["lung", "alveoli", "pneumonia", "exudate", "neutrophils", "consolidation", "bronchopneumonia", "lobar pneumonia", "fibrin", "infection", "pulmonary", ...D], scene: () => lung("pneumonia") },
  { slug: "lung-alveoli-fibrosis", name: "Lung alveoli — pulmonary fibrosis", category: "tissues", tags: ["lung", "alveoli", "pulmonary fibrosis", "IPF", "interstitial lung disease", "ILD", "fibroblasts", "fibroblastic focus", "UIP", "usual interstitial pneumonia", "honeycombing", "thickened septa", ...D], scene: () => lung("fibrosis") },
  { slug: "colon-mucosa-healthy", name: "Colon mucosa — healthy", category: "tissues", tags: ["colon", "intestine", "large bowel", "crypts", "crypts of Lieberkühn", "colonic crypts", "colonocytes", "mucosa", "H&E", "goblet cells", "lamina propria", "muscularis mucosae", "epithelium", "gut", ...H], scene: () => colon(false) },
  { slug: "colon-mucosa-colitis", name: "Colon mucosa — ulcerative colitis", category: "tissues", tags: ["colon", "intestine", "ulcerative colitis", "IBD", "inflammatory bowel disease", "crypt abscess", "cryptitis", "crypt distortion", "crypt branching", "goblet cell depletion", "mucin depletion", "basal plasmacytosis", "erosion", "ulcer", "plasma cells", "neutrophils", "gut", ...D], scene: () => colon(true) },
  { slug: "liver-healthy", name: "Liver lobule — healthy", category: "tissues", tags: ["liver", "hepatic lobule", "hepatocytes", "hepatocyte plates", "central vein", "sinusoids", "Kupffer cells", "portal triad", "portal tract", "portal vein", "hepatic artery", "bile duct", "H&E", "hepatic", ...H], scene: () => liver(false) },
  { slug: "liver-steatosis", name: "Liver — steatosis (fatty liver)", category: "tissues", tags: ["liver", "steatosis", "fatty liver", "NAFLD", "MASLD", "NASH", "MASH", "lipid droplets", "macrovesicular steatosis", "microvesicular steatosis", "zone 3", "lobular inflammation", "hepatocytes", "hepatic", ...D], scene: () => liver(true) },
  { slug: "trabecular-bone-healthy", name: "Trabecular bone — healthy", category: "tissues", tags: ["bone", "trabecular bone", "cancellous", "spongy bone", "bone marrow", "haematopoietic marrow", "marrow adipocytes", "megakaryocyte", "osteocytes", "osteoblasts", "osteoid", "osteoclast", "Howship lacuna", "bone remodelling", ...H], scene: () => bone(false) },
  { slug: "trabecular-bone-osteoporosis", name: "Trabecular bone — osteoporosis", category: "tissues", tags: ["bone", "osteoporosis", "trabecular bone", "bone loss", "thin trabeculae", "trabecular perforation", "loss of connectivity", "fatty marrow", "osteoclast", "resorption pit", "bone resorption", ...D], scene: () => bone(true) },
];
