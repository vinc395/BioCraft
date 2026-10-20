// Immune and blood cells, Servier-like: pastel cytoplasm, mauve/purple nuclei, light from top left.
import { blob, blobPts, smoothClosed, armsPts, circle, ellipse, scatter, capsule, ribbon, rng, f } from "../lib/geom.mjs";
import { shade, tint, flat, pathBox } from "../lib/style.mjs";
import { unevenAngles, assertInside, checkInside, flatten, insideShape, edgeDistance } from "../lib/organic.mjs";
import { kit } from "./cells.mjs";

/**
 * Short receptors sticking out of a round cell: "Y" (antibody/TCR-like), "stick" or "ball".
 * Spacing is uneven (coefficient of variation ≈ 0.3) and lengths vary ±15%, so the coat never reads as a
 * clock face. Returns { d: stalks (+ Y arms), tips: ball-tip circles (kind "ball") }.
 */
function receptors(cx, cy, r, n, { len = 9, arm = 5, kind = "Y", seed = 1, rad = 3.2 } = {}) {
  const R = rng(seed * 7 + 3);
  let d = "";
  const tips = [];
  for (const deg of unevenAngles(n, R, { cv: 0.3 })) {
    const a = (deg * Math.PI) / 180, l = len * (0.85 + R() * 0.3);
    const ux = Math.cos(a), uy = Math.sin(a);
    const x0 = cx + ux * (r - 4), y0 = cy + uy * (r - 4);
    const x1 = cx + ux * (r + l), y1 = cy + uy * (r + l);
    d += `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}`;
    if (kind === "Y") {
      for (const s of [-1, 1]) {
        const b = a + s * 0.62;
        d += `M${f(x1)} ${f(y1)}L${f(x1 + Math.cos(b) * arm)} ${f(y1 + Math.sin(b) * arm)}`;
      }
    }
    if (kind === "ball") tips.push(circle(cx + ux * (r + l + rad * 0.6), cy + uy * (r + l + rad * 0.6), rad));
  }
  return { d, tips };
}

const dots = (pts, r) => pts.map(([x, y]) => circle(x, y, r));

/** Lymphocyte-style round cell with a big round nucleus. */
function roundCell({ body, nucleus, seed = 1, rx = 72, ry = 69, nr = 50, nx = 104, ny = 106, recs = null, granules = null, chromatin = true }) {
  const parts = [];
  if (recs) {
    const rc = receptors(100, 100, Math.min(rx, ry), recs.n, { ...recs, seed });
    parts.push({ d: rc.d, fill: "none", stroke: { color: recs.color, width: recs.width || 2.6 } });
    if (recs.kind === "ball") parts.push({ unite: rc.tips, fill: recs.color, shade: "small", gloss: false });
  }
  parts.push({ d: blob(100, 100, rx, ry, { n: 9, wobble: 0.035, seed }), fill: body, shade: "body" });
  parts.push({ d: blob(nx, ny, nr, nr * 0.94, { n: 8, wobble: 0.07, seed: seed + 11 }), fill: nucleus, shade: "organelle", glossAt: [0.3, 0.25] });
  if (chromatin) parts.push({ unite: dots(scatter(nx, ny, nr * 0.62, nr * 0.58, 9, { seed: seed + 5, minDist: 9 }), 3.4), fill: shade(nucleus, 0.12), opacity: 0.55, line: false });
  if (granules) {
    const pts = scatter(100, 100, rx * 0.86, ry * 0.86, granules.n, { seed: seed + 9, minDist: granules.r * 2.6, avoid: [[nx, ny, nr + granules.r + 2]] });
    parts.push({ unite: dots(pts, granules.r), fill: granules.color, shade: "small", gloss: false });
  }
  return { size: [200, 200], parts };
}

/** A multi-lobed nucleus: lobes joined by thin strands. */
function lobed(points, r, strand = 0.35) {
  const shapes = points.map(([x, y], i) => circle(x, y, r * (i % 2 ? 0.92 : 1)));
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    shapes.push(capsule(a[0], a[1], b[0], b[1], r * strand));
  }
  return shapes;
}

/** Even arc-length resampling of a closed ring of points. */
function resampleRing(pts, step) {
  const src = [...pts, pts[0]], out = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const [ax, ay] = src[i - 1], [bx, by] = src[i], seg = Math.hypot(bx - ax, by - ay);
    let d = step - carry;
    while (d <= seg) { out.push([ax + ((bx - ax) * d) / seg, ay + ((by - ay) * d) / seg]); d += step; }
    carry = seg - (d - step);
  }
  if (out.length > 2 && Math.hypot(out[out.length - 1][0] - out[0][0], out[out.length - 1][1] - out[0][1]) < step * 0.5) out.pop();
  return out;
}

/**
 * Kidney-shaped nucleus made by a real difference (not by uniting lobes): an egg-shaped ellipse, one end fatter by
 * `egg`, minus a circle (the hilum) centred `biteDist` from the centre towards `biteAng`°. The two cut corners are
 * rounded by neighbour averaging. Returns the outline points.
 */
function kidneyPts(cx, cy, rx, ry, rot, { biteAng = -90, biteDist = 30, biteR = 18, egg = 0.1, round = 5 } = {}) {
  const rr = (rot * Math.PI) / 180;
  let pts = [];
  for (let i = 0; i < 200; i++) {
    const t = (i / 200) * 2 * Math.PI, x = rx * Math.cos(t), y = ry * Math.sin(t) * (1 + egg * Math.cos(t));
    pts.push([cx + x * Math.cos(rr) - y * Math.sin(rr), cy + x * Math.sin(rr) + y * Math.cos(rr)]);
  }
  const ba = (biteAng * Math.PI) / 180, B = [cx + Math.cos(ba) * biteDist, cy + Math.sin(ba) * biteDist];
  const isIn = (p) => Math.hypot(p[0] - B[0], p[1] - B[1]) < biteR;
  const k0 = pts.findIndex((p) => !isIn(p));
  pts = [...pts.slice(k0), ...pts.slice(0, k0)];
  const ins = pts.map(isIn), i0 = ins.indexOf(true), i1 = ins.lastIndexOf(true);
  if (i0 > 0) {
    const E1 = pts[i0 - 1], E2 = pts[(i1 + 1) % pts.length];
    const a1 = Math.atan2(E1[1] - B[1], E1[0] - B[0]), a2 = Math.atan2(E2[1] - B[1], E2[0] - B[0]);
    const ac = Math.atan2(cy - B[1], cx - B[0]); // the arc must pass on the side facing the nucleus centre
    let da = a2 - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da <= -Math.PI) da += 2 * Math.PI;
    const within = (d) => { let x = (ac - a1) * Math.sign(d); while (x < 0) x += 2 * Math.PI; while (x >= 2 * Math.PI) x -= 2 * Math.PI; return x <= Math.abs(d); };
    if (!within(da)) da -= Math.sign(da) * 2 * Math.PI;
    const m = 24, arcPts = [];
    for (let k = 1; k < m; k++) arcPts.push([B[0] + biteR * Math.cos(a1 + (da * k) / m), B[1] + biteR * Math.sin(a1 + (da * k) / m)]);
    pts = [...pts.slice(0, i0), ...arcPts, ...pts.slice(i1 + 1)];
  }
  pts = resampleRing(pts, 2.5);
  for (let pass = 0; pass < round; pass++) {
    const n = pts.length;
    pts = pts.map((p, i) => { const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n]; return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4]; });
  }
  return pts;
}
const kidney = (...a) => smoothClosed(resampleRing(kidneyPts(...a), 5));

/**
 * Segmented nucleus shaded by hand (the renderer's shading breaks on thin strands): shadow copies of the lobes only,
 * a flat united silhouette of lobes + strands, one light band per lobe and gloss dots on the largest lobe.
 * lobes: [{c, rx, ry, rot, seed}] · strands: path data.
 */
function lobedNucleus(lobes, strands, fill) {
  const pcs = lobes.map((l) => kit.blobPiece(l.c[0], l.c[1], l.rx, l.ry, { n: 7, wobble: l.wob ?? 0.09, seed: l.seed, rot: l.rot }, 1.6));
  const big = lobes.reduce((a, l, i) => (l.rx * l.ry > lobes[a].rx * lobes[a].ry ? i : a), 0), L = lobes[big];
  return {
    pieces: pcs,
    parts: [
      { unite: pcs.map((p) => p.sd), fill: shade(fill, 0.15), line: false },
      { unite: [...pcs.map((p) => p.d), ...strands], fill },
      { d: pcs.map((p) => kit.litBand(p.outline, { inset: 1.8, width: 4.4 })).filter(Boolean), fill: tint(fill, 0.14), opacity: 0.8, line: false },
      { unite: kit.glossDots(L.c[0] - 0.3 * L.rx, L.c[1] - 0.35 * L.ry, 2.5), fill: "#ffffff", opacity: 0.8, line: false },
    ],
  };
}

/** A thin chromatin strand from lobe centre a to lobe centre b, bowed sideways by `bow`. */
function strand(a, b, bow, w = 4.6) {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mid = [(a[0] + b[0]) / 2 + (-(b[1] - a[1]) / l) * bow, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / l) * bow];
  return ribbon([a, [(a[0] + mid[0]) / 2, (a[1] + mid[1]) / 2], mid, [(mid[0] + b[0]) / 2, (mid[1] + b[1]) / 2], b], w);
}

/** Elliptical arc a0 → a1 (degrees, y down) as cubic segments, with its leading M. */
function arcPath(cx, cy, rx, ry, a0, a1) {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 45)), da = (a1 - a0) / n;
  const P = (x, y) => `${f(x)} ${f(y)}`;
  let s = `M${P(cx + rx * Math.cos((a0 * Math.PI) / 180), cy + ry * Math.sin((a0 * Math.PI) / 180))}`;
  for (let i = 0; i < n; i++) {
    const t0 = ((a0 + da * i) * Math.PI) / 180, t1 = ((a0 + da * (i + 1)) * Math.PI) / 180, k = (4 / 3) * Math.tan((t1 - t0) / 4);
    s += `C${P(cx + rx * Math.cos(t0) - k * rx * Math.sin(t0), cy + ry * Math.sin(t0) + k * ry * Math.cos(t0))} ` +
      `${P(cx + rx * Math.cos(t1) + k * rx * Math.sin(t1), cy + ry * Math.sin(t1) - k * ry * Math.cos(t1))} ${P(cx + rx * Math.cos(t1), cy + ry * Math.sin(t1))}`;
  }
  return s;
}

export const icons = [
  {
    slug: "t-cell", name: "T cell (helper, CD4+)", category: "immune-cells",
    tags: ["T cell", "T lymphocyte", "CD4", "CD4+ T cell", "CD3", "helper T cell", "Th", "Th1", "Th2", "Th17", "Tfh", "Tph", "peripheral helper T cell", "memory T cell", "naive T cell", "lymphocyte", "adaptive immunity", "TCR", "T cell receptor", "CD3E", "IL7R"],
    scene: () => roundCell({ body: "#a9d6ee", nucleus: "#8a7fc6", seed: 3, recs: { n: 13, color: "#3f6fa6", kind: "Y" } }),
  },
  {
    slug: "cytotoxic-t-cell", name: "Cytotoxic T cell (CD8+)", category: "immune-cells",
    tags: ["CTL", "CD8", "CD8+ T cell", "cytotoxic T lymphocyte", "killer T cell", "T cell", "T lymphocyte", "TCR", "granzyme", "GZMB", "GZMK", "perforin", "PRF1", "effector T cell", "exhausted T cell", "tumour-infiltrating lymphocyte", "TIL"],
    scene: () => roundCell({ body: "#bfe5cf", nucleus: "#6f8fc4", seed: 5, recs: { n: 13, color: "#2f7a5a", kind: "Y" }, granules: { n: 8, r: 4.2, color: "#e2677f" } }),
  },
  {
    slug: "regulatory-t-cell", name: "Regulatory T cell (Treg)", category: "immune-cells",
    tags: ["Treg", "regulatory T cell", "FOXP3", "CD25", "IL2RA", "CTLA-4", "CTLA4", "T cell", "T lymphocyte", "suppressor T cell", "immune tolerance", "immunosuppression"],
    scene: () => roundCell({ body: "#f6d9ab", nucleus: "#9c78b8", seed: 7, recs: { n: 12, color: "#b9772a", kind: "stick", len: 8 } }),
  },
  {
    slug: "b-cell", name: "B cell", category: "immune-cells",
    tags: ["B cell", "B lymphocyte", "BCR", "B cell receptor", "CD19", "CD20", "MS4A1", "CD79A", "naive B cell", "memory B cell", "germinal centre B cell", "antibody", "humoral immunity", "lymphocyte", "rituximab target"],
    scene: () => roundCell({ body: "#cfe8a8", nucleus: "#8b78bf", seed: 9, recs: { n: 12, color: "#5f8f2f", kind: "Y", len: 10, arm: 6 } }),
  },
  {
    slug: "nk-cell", name: "Natural killer (NK) cell", category: "immune-cells",
    tags: ["NK cell", "natural killer cell", "natural killer", "innate lymphoid cell", "ILC", "CD56", "NCAM1", "CD16", "FCGR3A", "NKG7", "GNLY", "granulysin", "NKG2D", "KIR", "granules", "perforin", "cytotoxic", "ADCC"],
    scene: () => roundCell({ body: "#f7e6a8", nucleus: "#8d7cc4", seed: 11, rx: 76, ry: 72, nr: 46, nx: 110, ny: 104, recs: { n: 11, color: "#b0892a", kind: "ball", len: 7, rad: 3 }, granules: { n: 11, r: 4.4, color: "#d9534f" } }),
  },
  {
    slug: "plasma-cell", name: "Plasma cell", category: "immune-cells",
    tags: ["plasma cell", "plasmacyte", "plasmablast", "antibody-secreting cell", "ASC", "B cell", "CD138", "SDC1", "CD38", "JCHAIN", "MZB1", "XBP1", "PRDM1", "immunoglobulin", "antibody production", "rough ER", "clock-face nucleus", "cartwheel chromatin", "hof", "perinuclear halo"],
    scene: () => {
      // 200 × 200. Paint order: cytoplasm → hof (pale Golgi zone touching the nucleus on the side towards the cell
      // centre) → RER lamellae → eccentric nucleus → clock-face chromatin.
      // The RER is drawn as smooth cubic elliptical arcs of uneven length, concentric round the nucleus and hof. Each
      // lamella is trimmed so it stays ≥ 4 units inside the membrane, ≥ 4 outside the hof and ≥ 3 off the nucleus.
      const cell = blob(100, 100, 82, 62, { n: 10, wobble: 0.03, seed: 13, rot: -8 });
      const NC = [130, 98], NR = 30, HC = [92, 96], HR = [17, 14.5];
      const ok = (p) => {
        const hof = Math.hypot((p[0] - HC[0]) / (HR[0] + 4), (p[1] - HC[1]) / (HR[1] + 4)) > 1;
        const nuc = Math.hypot(p[0] - NC[0], p[1] - NC[1]) > NR + 4;
        return hof && nuc && checkInside([p], cell, 4).ok;
      };
      const lams = [ // centre, rx, ry, start°, end° (y down: 0 right, 90 bottom, 180 left, 270 top)
        // interrupted at different angles, so the stack reads as RER cisternae rather than a target
        [[118, 97], 52, 40, 72, 190], [[118, 97], 52, 40, 206, 296],
        [[118, 97], 61, 45, 46, 150], [[118, 97], 61, 45, 166, 252], [[118, 97], 61, 45, 268, 318],
        [[118, 97], 70, 49, 100, 214], [[118, 97], 70, 49, 230, 266],
        [[118, 97], 79, 53, 124, 200], [[118, 97], 79, 53, 214, 244], [[118, 97], 89, 57, 150, 206],
        [NC, 39, 39, -64, 62], [NC, 46, 45, -40, 44],
      ];
      const er = [];
      for (const [c, rx, ry, a0, a1] of lams) {
        const pt = (a) => [c[0] + rx * Math.cos((a * Math.PI) / 180), c[1] + ry * Math.sin((a * Math.PI) / 180)];
        let s = a0, e = a1;
        while (s < e && !ok(pt(s))) s += 1;
        while (e > s && !ok(pt(e))) e -= 1;
        let good = e - s > 12;
        for (let a = s; good && a <= e; a += 2) good = ok(pt(a));
        if (good) er.push(arcPath(c[0], c[1], rx, ry, s, e));
      }
      const parts = [];
      parts.push({ d: cell, fill: "#f3c9d6", shade: "body" });
      parts.push({ d: ellipse(HC[0], HC[1], HR[0], HR[1], -10), fill: "#fbe4eb", opacity: 0.9, lineColor: flat("#fbe4eb") });
      parts.push({ d: er.join(""), fill: "none", stroke: { color: "#d58aa4", width: 2.2 } });
      parts.push({ d: blob(NC[0], NC[1], NR, NR, { n: 8, wobble: 0.05, seed: 14 }), fill: "#8c5ea3", shade: "organelle" });
      // "clock-face" (cartwheel) chromatin: coarse clumps against the envelope, unevenly spaced and sized;
      // in line style a flat darker fill with no outline, so the defining cue survives there too
      const cf = [];
      const R = rng(15);
      for (const deg of unevenAngles(8, R, { cv: 0.3 })) {
        const a = (deg * Math.PI) / 180, rr = 17 + R() * 4;
        cf.push(blob(NC[0] + Math.cos(a) * rr, NC[1] + Math.sin(a) * rr, 3.4 + R() * 2.2, 3 + R() * 1.6, { n: 6, wobble: 0.15, seed: 20 + Math.round(deg), rot: deg }));
      }
      cf.push(blob(NC[0] - 2, NC[1] + 1, 5, 4.2, { n: 6, wobble: 0.15, seed: 19 }));
      for (const [i, d] of cf.entries()) assertInside("plasma-cell chromatin " + i, d, blob(NC[0], NC[1], NR, NR, { n: 8, wobble: 0.05, seed: 14 }), 1);
      const cfc = shade("#8c5ea3", 0.14);
      parts.push({ unite: cf, fill: cfc, opacity: 0.7, lineColor: flat(cfc), lineWidth: 0.4 });
      return { size: [200, 200], parts };
    },
  },
  {
    slug: "macrophage", name: "Macrophage", category: "immune-cells",
    tags: ["macrophage", "phagocyte", "phagocytosis", "myeloid", "CD68", "CD14", "CD163", "CD64", "tissue-resident macrophage", "monocyte-derived macrophage", "TAM", "tumour-associated macrophage", "synovial macrophage", "MerTK", "TREM2", "M1", "M2", "innate immunity", "pseudopod", "antigen-presenting cell"],
    scene: () => macrophage({ body: "#f5c6a5", nucleus: "#a17cba", vac: "#fbe3d1", seed: 17 }),
  },
  {
    slug: "macrophage-m1", name: "M1 macrophage (pro-inflammatory)", category: "immune-cells",
    tags: ["M1", "M1 macrophage", "classically activated macrophage", "pro-inflammatory macrophage", "macrophage", "inflammation", "TNF", "IL-1β", "IL1B", "IL-6", "iNOS", "NOS2", "CD80", "CD86", "LPS", "IFN-γ"],
    scene: () => macrophage({ body: "#f2a7a0", nucleus: "#8e6aa8", vac: "#fad6d1", seed: 19 }),
  },
  {
    slug: "macrophage-m2", name: "M2 macrophage (anti-inflammatory)", category: "immune-cells",
    tags: ["M2", "M2 macrophage", "alternatively activated macrophage", "anti-inflammatory macrophage", "pro-resolving macrophage", "macrophage", "repair", "tissue repair", "IL-10", "TGF-β", "CD163", "CD206", "MRC1", "Arg1", "IL-4", "IL-13"],
    scene: () => macrophage({ body: "#b8dcc4", nucleus: "#7d76b8", vac: "#e1f2e7", seed: 21 }),
  },
  {
    slug: "monocyte", name: "Monocyte", category: "immune-cells",
    tags: ["monocyte", "classical monocyte", "non-classical monocyte", "CD14", "CD16", "FCGR3A", "LYZ", "S100A8", "myeloid", "blood", "PBMC", "kidney-shaped nucleus", "leukocyte", "white blood cell", "mononuclear phagocyte"],
    scene: () => {
      // 200 × 200. Paint order: cytoplasm → small vacuoles → nucleus.
      // Kidney-shaped, eccentric nucleus made by a difference: an egg-shaped ellipse (one end ≈ 20% fatter) minus a
      // circle, which leaves one shallow hilum on its upper side. It is not a union of lobes, which reads as ears.
      const cell = blob(100, 100, 74, 71, { n: 10, wobble: 0.05, seed: 23 });
      // (16 smoothing passes round the two horns of the hilum, ≈ 6 units radius, so they are not pointed)
      const nuc = kidney(92, 108, 46, 35, -15, { biteAng: -72, biteDist: 45, biteR: 23, egg: 0.11, round: 16 });
      assertInside("monocyte nucleus", nuc, cell, 5);
      const parts = [];
      parts.push({ d: cell, fill: "#cfe1f4", shade: "body" });
      parts.push({ unite: dots(scatter(100, 100, 60, 56, 10, { seed: 24, minDist: 12, avoid: [[92, 108, 52]] }), 2.6), fill: "#b8a5d8", line: false });
      parts.push({ d: nuc, fill: "#8e74bd", shade: "organelle", glossAt: [0.3, 0.3] });
      return { size: [200, 200], parts };
    },
  },
  {
    slug: "neutrophil", name: "Neutrophil", category: "immune-cells",
    tags: ["neutrophil", "neutrophil granulocyte", "PMN", "polymorphonuclear leukocyte", "segmented neutrophil", "multilobed nucleus", "granulocyte", "CD66b", "CEACAM8", "MPO", "myeloperoxidase", "elastase", "S100A8", "S100A9", "CXCR2", "NETs", "NETosis", "neutrophil extracellular traps", "innate immunity", "white blood cell"],
    scene: () => {
      // 200 × 200. Paint order: cytoplasm → fine specific granules → segmented nucleus (lobe shadows → flat lobes +
      // strands → lobe light bands → gloss on the largest lobe).
      // Mature neutrophil after Servier neutrophil-granulocyte-1/-3: 4 large, irregular nuclear lobes (rx 20–24) of
      // uneven size and tilt in an open C-shaped chain (not a ring) that spans most of the cell. Neighbouring lobes are
      // only 8–11 units apart, each linked to the next by a short, thin, slightly bowed chromatin strand, so the lobes
      // dominate (not a ball-and-stick look). Shaded by hand, because the renderer's crescents break on thin strands.
      const cell = blob(100, 100, 74, 72, { n: 10, wobble: 0.04, seed: 25 });
      const lobes = [
        { c: [66, 80], rx: 21, ry: 16, rot: 35, seed: 41, wob: 0.12 },
        { c: [110, 62], rx: 23, ry: 15, rot: -10, seed: 42, wob: 0.12 },
        { c: [138, 99], rx: 20, ry: 17, rot: 70, seed: 43, wob: 0.12 },
        { c: [103, 134], rx: 24, ry: 16, rot: -18, seed: 44, wob: 0.12 },
      ];
      const bows = [5, -4, 6];
      const strands = lobes.slice(1).map((l, i) => strand(lobes[i].c, l.c, bows[i], 4.6));
      const N = lobedNucleus(lobes, strands, "#7d4b9f");
      for (const [i, p] of N.pieces.entries()) assertInside("neutrophil lobe " + i, p.d, cell, 7);
      const parts = [];
      parts.push({ d: cell, fill: "#f6dde6", shade: "body" });
      parts.push({ unite: dots(scatter(100, 100, 64, 62, 38, { seed: 26, minDist: 8 }), 2.3), fill: "#e8a9c2", line: false });
      parts.push(...N.parts);
      return { size: [200, 200], parts };
    },
  },
  {
    slug: "eosinophil", name: "Eosinophil", category: "immune-cells",
    tags: ["eosinophil", "eosinophil granulocyte", "granulocyte", "Siglec-8", "CCR3", "EPX", "major basic protein", "MBP", "IL-5", "allergy", "asthma", "parasite", "helminth", "bilobed nucleus", "eosinophilic granules", "white blood cell"],
    scene: () => {
      // 200 × 200. Paint order: cytoplasm → bilobed nucleus (hand-shaded like the neutrophil's) → granules.
      // After Servier eosinophil-granulocyte-1: two large, irregular lobes of clearly unequal size and orientation — a
      // big, nearly horizontal lower-left lobe (31×21) and a narrower, steeply tilted upper-right lobe (27×16) — only
      // ≈ 4 units apart and joined by a short, broad strand, so the nucleus reads as one bent, constricted bilobed mass.
      // Not two equal round lenses side by side on a bar, which reads as sunglasses. Dense, slightly uneven specific
      // granules (≈ 60) cover the cytoplasm and the lobe edges.
      const cell = blob(100, 100, 74, 72, { n: 10, wobble: 0.04, seed: 27 });
      const lobes = [
        { c: [76, 106], rx: 31, ry: 21, rot: -16, seed: 51, wob: 0.12 },
        { c: [126, 84], rx: 27, ry: 16, rot: -64, seed: 52, wob: 0.12 },
      ];
      const N = lobedNucleus(lobes, [strand(lobes[0].c, lobes[1].c, 2, 8)], "#6b58a8");
      for (const [i, p] of N.pieces.entries()) assertInside("eosinophil lobe " + i, p.d, cell, 8);
      const R = rng(28);
      const gr = scatter(100, 100, 62, 60, 62, { seed: 28, minDist: 8.2, avoid: [[76, 106, 15], [126, 84, 10]] });
      const parts = [];
      parts.push({ d: cell, fill: "#fae2d6", shade: "body" });
      parts.push(...N.parts);
      parts.push({ unite: gr.map(([x, y]) => circle(x, y, 3.5 + R() * 0.6)), fill: "#ef7b55", shade: "small", gloss: false });
      return { size: [200, 200], parts };
    },
  },
  {
    slug: "basophil", name: "Basophil", category: "immune-cells",
    tags: ["basophil", "basophil granulocyte", "granulocyte", "FcεRI", "FCER1A", "CD203c", "ENPP3", "CD123", "IL3RA", "CCR3", "HDC", "histamine", "IL-4", "IgE", "allergy", "basophilic granules", "polymorphonuclear", "white blood cell", "leukocyte"],
    scene: () => {
      const parts = [];
      parts.push({ d: blob(100, 100, 72, 70, { n: 10, wobble: 0.04, seed: 29 }), fill: "#e6def4", shade: "body" });
      // three lobes plus a filler at their centroid, so no hole is left where they meet
      parts.push({ unite: [...lobed([[78, 92], [118, 86], [112, 124]], 24, 0.4), circle(102.7, 100.7, 11)], fill: "#7a68b2", shade: "organelle" });
      parts.push({ unite: dots(scatter(100, 100, 64, 62, 34, { seed: 30, minDist: 10 }), 4.6), fill: "#4b3a7d", shade: "small", gloss: false });
      return { size: [200, 200], parts };
    },
  },
  {
    slug: "mast-cell", name: "Mast cell", category: "immune-cells",
    tags: ["mast cell", "mastocyte", "KIT", "CD117", "tryptase", "TPSAB1", "CPA3", "chymase", "FcεRI", "histamine", "heparin", "degranulation", "allergy", "anaphylaxis", "IgE", "granules"],
    scene: () => {
      const parts = [];
      parts.push({ d: blob(100, 100, 82, 66, { n: 11, wobble: 0.06, seed: 31, rot: 12 }), fill: "#f4e3c8", shade: "body" });
      parts.push({ d: blob(98, 102, 30, 27, { n: 8, wobble: 0.05, seed: 32 }), fill: "#8a68b0", shade: "organelle" });
      parts.push({ unite: dots(scatter(100, 100, 74, 58, 46, { seed: 33, minDist: 9.6, avoid: [[98, 102, 34]] }), 4.2), fill: "#8e4aa6", shade: "small", gloss: false });
      return { size: [200, 200], parts };
    },
  },
  {
    slug: "dendritic-cell", name: "Dendritic cell", category: "immune-cells",
    tags: ["dendritic cell", "DC", "cDC", "cDC1", "cDC2", "conventional dendritic cell", "pDC", "plasmacytoid dendritic cell", "mature DC", "migratory DC",
      "antigen-presenting cell", "APC", "antigen presentation", "MHC II", "HLA-DR", "CD11c", "ITGAX", "CLEC9A", "CD1c", "XCR1", "CCR7", "LAMP3",
      "dendrites", "veils", "Langerhans cell", "CD207", "langerin", "interdigitating cell"],
    scene: () => {
      // 200 × 200, after Servier dendritic-cell-2. Paint order: shadow copy → united cell (body + 5 long sinuous
      // dendrites, two of them branched, + 2 broad veils) → lit band → gloss → indented nucleus.
      // The dendrites are grouped on two sides (three to the upper right, two to the lower left), are wavy (26°) and
      // bent (up to 42°), and end in blunt rounded tips (half-width 2.7). Branches start at 0.8× the parent's
      // half-width, rooted 2.5 units back inside it. The veils are sheet-like lobes (≈ 30 wide × 24 long) with wavy
      // free edges, set in the gaps between the dendrite groups. The kidney nucleus is cut by a real difference.
      const { procFit, rootBack, dirAt, fanPiece, blobPiece, litBand, softCell, smooth, dist, checkFrame } = kit;
      const W = 200, H = 200, fill = "#bfe4da", cx = 94, cy = 104;
      const body = blobPiece(cx, cy, 38, 33, { n: 8, wobble: 0.08, seed: 36, rot: 15 }, 2.8);
      const box = [W, H, 5];
      const R = rng(35);
      const arms = [ // angle°, length, base half-width, bend°, branch at point k (0 = none)
        [-80, 56, 8.5, 34, 0], [-42, 74, 9, -30, 3], [-4, 60, 8, 42, 0], [116, 70, 9, -36, 2], [158, 54, 8, 28, 0],
      ];
      const ps = [], roots = [];
      for (const [i, [a, len, base, bend, k]] of arms.entries()) {
        const r0 = 20, x0 = cx + Math.cos((a * Math.PI) / 180) * r0, y0 = cy + Math.sin((a * Math.PI) / 180) * r0;
        roots.push([cx + Math.cos((a * Math.PI) / 180) * 34, cy + Math.sin((a * Math.PI) / 180) * 30]);
        const q = procFit(x0, y0, a, len + 16, { bend, base, tip: 2.7, p: 1.5, seg: 6, wave: 26, seed: 400 + i }, box);
        ps.push(q);
        if (k) {
          const s = bend > 0 ? -1 : 1;
          ps.push(procFit(...rootBack(q, k), dirAt(q, k) + s * (36 + R() * 10), len * 0.4, { bend: s * -22, base: 0.8 * q.hw(k / q.seg), tip: 2.3, p: 1.3, seg: 4, wave: 24, seed: 500 + i }, box));
        }
      }
      // broad veils in the gaps between the dendrite groups
      const veils = [[-134, 38, 9, 15, 61], [56, 35, 9, 13.5, 62]].map(([a, len, hw0, hw1, seed]) => {
        roots.push([cx + Math.cos((a * Math.PI) / 180) * 34, cy + Math.sin((a * Math.PI) / 180) * 30]);
        return fanPiece([cx + Math.cos((a * Math.PI) / 180) * 16, cy + Math.sin((a * Math.PI) / 180) * 14], a, len, hw0, hw1, { seed, wav: 0.06, sh: 2.8, bulge: 0.26, m: 5 });
      });
      // (no light band: the lit side of this small body is taken by the upper-left veil and dendrite roots)
      const band = null;
      // indented (kidney), eccentric nucleus: an ellipse minus a circle on its lower side
      const nuc = kidney(cx + 6, cy + 2, 23.5, 17, -24, { biteAng: 62, biteDist: 26, biteR: 13.5, egg: 0.1, round: 9 });
      assertInside("DC nucleus", nuc, body.d, 3);
      checkFrame("dendritic-cell", [body, ...ps, ...veils], W, H, 4);
      return {
        size: [W, H],
        parts: [
          ...softCell([body, ...ps, ...veils], fill, { band, gloss: [cx - 19, cy - 21, 3.6], rim: 0.12 }),
          { d: nuc, fill: "#6f8cc4", shade: "organelle", glossAt: [0.3, 0.28] },
        ],
      };
    },
  },
  {
    slug: "platelet", name: "Platelet (thrombocyte)", category: "immune-cells",
    tags: ["platelet", "thrombocyte", "PLT", "CD41", "ITGA2B", "CD61", "PF4", "PPBP", "alpha granules", "dense granules", "clotting", "coagulation", "haemostasis", "hemostasis", "thrombosis", "blood"],
    scene: () => {
      const parts = [];
      parts.push({ d: blob(100, 100, 70, 48, { n: 9, wobble: 0.08, seed: 37, rot: -12 }), fill: "#ead0f2", shade: "body" });
      parts.push({ unite: dots(scatter(100, 100, 48, 30, 9, { seed: 38, minDist: 13 }), 5), fill: "#a86cc1", shade: "small", gloss: false });
      return { size: [200, 200], parts };
    },
  },
  {
    slug: "red-blood-cell", name: "Red blood cell (erythrocyte)", category: "immune-cells",
    tags: ["erythrocyte", "RBC", "red blood cell", "red cell", "haemoglobin", "hemoglobin", "HBB", "biconcave disc", "biconcave", "anucleate", "oxygen transport", "blood"],
    scene: () => ({
      size: [200, 200],
      parts: [
        { d: circle(100, 100, 74), fill: "#e04b4f", shade: "body", gloss: false },
        { d: circle(100, 100, 38), fill: "#ea6a66", shade: "dip", thin: true },
      ],
    }),
  },
  {
    slug: "hematopoietic-stem-cell", name: "Haematopoietic stem cell", category: "immune-cells",
    tags: ["HSC", "hematopoietic stem cell", "haematopoietic stem cell", "HSPC", "stem cell", "bone marrow", "progenitor", "CD34", "CD133", "PROM1", "CD90", "LSK", "haematopoiesis", "hematopoiesis", "blood stem cell"],
    scene: () => roundCell({ body: "#ddd5f5", nucleus: "#9584d8", seed: 39, nr: 54, nx: 100, ny: 104, recs: { n: 10, color: "#7461b8", kind: "stick", len: 7 } }),
  },
];

/**
 * Macrophage: ruffled cell with pointed pseudopods, phagocytic vacuoles and an eccentric kidney nucleus.
 * The nucleus is cut by a real difference and varies per seed: shifted 10–15 units towards the longest pseudopod,
 * rotated ±20°, sized ±10%, with its hilum on one long side.
 */
function macrophage({ body, nucleus, vac, seed }) {
  const parts = [];
  // armsPts with a large angular jitter can step backwards where two arms overlap, which draws a small loop in the
  // outline (seen on the M1 cell). Keep the outline star-shaped: drop every point whose angle round the centre does
  // not move on from the previous kept point.
  const raw = armsPts(100, 100, 62, { arms: 6, reach: 0.42, width: 0.5, seed, n: 8, jitter: 0.5 });
  const pts = [];
  let prev = null, maxA = -Infinity, a0 = null;
  for (const p of raw) {
    let a = Math.atan2(p[1] - 100, p[0] - 100);
    if (prev != null) { while (a <= prev - Math.PI) a += 2 * Math.PI; while (a > prev + Math.PI) a -= 2 * Math.PI; }
    prev = a;
    if (a0 == null) a0 = a;
    if (a > maxA + 0.03 && a < a0 + 2 * Math.PI - 0.03) { pts.push(p); maxA = a; }
  }
  const cell = smoothClosed(pts, 0.95);
  parts.push({ d: cell, fill: body, shade: "body" });
  const R = rng(seed + 3);
  // nucleus: towards the longest pseudopod
  const far = pts.reduce((a, p) => (Math.hypot(p[0] - 100, p[1] - 100) > Math.hypot(a[0] - 100, a[1] - 100) ? p : a));
  const fa = Math.atan2(far[1] - 100, far[0] - 100), off = 10 + R() * 5, sz = 0.9 + R() * 0.2;
  const rot = -24 + (R() * 2 - 1) * 20, side = R() < 0.5 ? -1 : 1;
  const nc = [100 + Math.cos(fa) * off, 100 + Math.sin(fa) * off], rx = 28 * sz, ry = 20 * sz;
  let nucD = kidney(nc[0], nc[1], rx, ry, rot, { biteAng: rot + side * 90, biteDist: ry + 13 - 7, biteR: 13, egg: 0.1, round: 9 });
  if (!checkInside(nucD, cell, 4).ok) {
    // pull it back towards the cell centre until it fits
    for (let k = 0.85; k > 0; k -= 0.15) {
      const c2 = [100 + (nc[0] - 100) * k, 100 + (nc[1] - 100) * k];
      nucD = kidney(c2[0], c2[1], rx, ry, rot, { biteAng: rot + side * 90, biteDist: ry + 13 - 7, biteR: 13, egg: 0.1, round: 9 });
      if (checkInside(nucD, cell, 4).ok) break;
    }
  }
  assertInside("macrophage nucleus", nucD, cell, 3);
  // phagocytic vacuoles of uneven size: inside the cell (≥ 4 units from the membrane), clear of the nucleus
  const vacs = [], nPolys = flatten(nucD);
  for (const [x, y] of scatter(100, 100, 52, 52, 60, { seed: seed + 4, minDist: 20 })) {
    const r = 5 + R() * 5;
    const d = circle(x, y, r);
    if (vacs.length < 4 && checkInside(d, cell, 4).ok && !insideShape(nPolys, [x, y]) && edgeDistance(nPolys, [x, y]) >= r + 4) vacs.push(d);
  }
  parts.push({ unite: vacs, fill: vac, shade: "small", gloss: false });
  // gloss on a point surely inside the nucleus (its bbox corner may fall in the hilum)
  const nb = pathBox(nucD);
  let g = nc;
  for (const k of [1, 0.85, 0.7, 0.55, 0.4]) {
    const q = [nb.x + nb.w * (0.5 - 0.25 * k), nb.y + nb.h * (0.5 - 0.27 * k)];
    if (insideShape(nPolys, q) && edgeDistance(nPolys, q) > 5) { g = q; break; }
  }
  parts.push({ d: nucD, fill: nucleus, shade: "organelle", glossAt: [(g[0] - nb.x) / nb.w, (g[1] - nb.y) / nb.h] });
  return { size: [200, 200], parts };
}
