// Proteins: antibodies, signalling proteins and membrane receptors, Servier-like.
// Protein domains are rounded capsules ("beads"); light from the top left. Membrane proteins sit
// in a short lipid-bilayer patch (orange heads, peach core, grey tails).
import { blob, blobPts, circle, ellipse, rect, capsule, ribbon, smoothClosed, smoothOpen, polygon, polyline, rng, f } from "../lib/geom.mjs";
import { shade, tint, pathBox } from "../lib/style.mjs";

const RAD = Math.PI / 180;
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/* ---------- colours ---------- */

const COL = {
  heavy: "#5b8bd9", // antibody heavy chains
  light: "#f0a35c", // antibody light chains
  heavy2: "#3fae94", // second antibody (secondary / bispecific arm)
  light2: "#f2d052",
};
const MEM = { head: "#f2a541", core: "#fcd9ad", tail: "#c2a78f" };

/* ---------- placement: local → world (scale, rotation in degrees clockwise, optional mirror) ---------- */

function place({ x = 0, y = 0, s = 1, rot = 0, mirror = false } = {}) {
  const c = Math.cos(rot * RAD), sn = Math.sin(rot * RAD), m = mirror ? -1 : 1;
  const P = ([px, py]) => [x + (m * px * c - py * sn) * s, y + (m * px * sn + py * c) * s];
  return { P, s, rot, mirror };
}

function boundsOf(parts) {
  return pathBox(parts.flatMap((p) => p.unite || (Array.isArray(p.d) ? p.d : [p.d])));
}

/** Build parts with the placement that fits them (centred) into box [x0, y0, x1, y1]. */
function fitted(build, box = [10, 10, 190, 190], { maxS = Infinity, rot = 0 } = {}) {
  const b = boundsOf(build(place({ rot })));
  const s = Math.min((box[2] - box[0]) / b.w, (box[3] - box[1]) / b.h, maxS);
  const x = (box[0] + box[2]) / 2 - (b.x + b.w / 2) * s, y = (box[1] + box[3]) / 2 - (b.y + b.h / 2) * s;
  return build(place({ x, y, s, rot }));
}

/* ---------- parts ---------- */

/** A rounded domain (capsule a→b, radius r, world coords). The gloss sits inside the cap nearer the light. */
function dom(a, b, r, fill, o = {}) {
  const d = capsule(a[0], a[1], b[0], b[1], r);
  const box = pathBox(d);
  const cap = a[0] + a[1] <= b[0] + b[1] ? a : b;
  const g = [cap[0] - r * 0.3, cap[1] - r * 0.34];
  return {
    d, fill, shade: o.shade ?? "organelle",
    glossAt: [(g[0] - box.x) / box.w, (g[1] - box.y) / box.h],
    glossSize: o.glossSize ?? (r * 0.3) / Math.max(box.w, box.h),
    ...(o.part || {}),
  };
}
const tdom = (t, a, b, r, fill, o) => dom(t.P(a), t.P(b), r * t.s, fill, o);

/**
 * Four-helix-bundle cytokine (class I/II helical cytokines: IL-2, IL-4, IL-6, GM-CSF, IFN-γ, EPO…),
 * "up-up-down-down" topology seen slightly from the left:
 *   canvas 200 × 200; paint order: loops behind → back helices B, C (+ turn marks) → loops in front of
 *   the back pair (AB and CD crossover loops, termini) → front helices A, D (+ turn marks).
 *   Helices: one colour (back pair a shade darker for depth), loops a darker rose so users can recolour
 *   them apart. α-helix turns are drawn as "/"-slanted arcs (right-handed helix, front half visible).
 */
function cytokineParts() {
  const base = "#e9748a", back = shade(base, 0.07), loopC = "#c4587a", r = 15;
  // helix axes [bottom, top]; the back pair sits up and right of the front pair
  const H = {
    A: [[57, 166], [69, 62]],
    D: [[97, 168], [109, 64]],
    B: [[83, 143], [95, 39]],
    C: [[123, 145], [135, 41]],
  };
  const helix = (k, fill) => {
    const [a, b] = H[k];
    return { ...dom(a, b, r, fill), glossSize: 0.07 };
  };
  /** "/"-slanted arcs across a helix (front half of each turn). */
  const turns = (k) => {
    const [p0, p1] = H[k];
    const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const ax = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L], nr = [-ax[1], ax[0]];
    // nr points to the screen right when the helix points up
    const P = (u, v) => [p0[0] + ax[0] * u + nr[0] * v, p0[1] + ax[1] * u + nr[1] * v];
    let d = "";
    for (const u of [0.2, 0.36, 0.52, 0.68, 0.84].map((t) => t * L)) {
      d += smoothOpen([P(u - r * 0.3, -r * 0.82), P(u - r * 0.34, -r * 0.2), P(u - r * 0.05, r * 0.45), P(u + r * 0.3, r * 0.82)]);
    }
    return d;
  };
  const turnPart = (k, fill) => ({ d: turns(k), fill: "none", stroke: { color: shade(fill, 0.22), width: 1.7 }, opacity: 0.5, lineStrokeWidth: 1, lineColor: shade(fill, 0.45) });
  /** A loop: a round-ended ribbon through `pts`. */
  const loop = (pts, w = 6) => ({
    unite: [ribbon(pts, w), circle(...pts[0], w / 2), circle(...pts[pts.length - 1], w / 2)],
    fill: loopC, shade: "rim", gloss: false, highlight: false, thin: true,
  });
  return [
    // short B→C loop over the top, behind both back helices
    loop([[95, 42], [101, 26], [115, 18], [129, 25], [135, 44]]),
    helix("B", back), turnPart("B", back),
    helix("C", back), turnPart("C", back),
    // long A→B crossover: from the top of A down the left flank, tucking under A to the foot of B
    loop([[69, 60], [58, 42], [41, 50], [33, 84], [35, 124], [50, 152], [72, 156], [84, 146]]),
    // long C→D crossover: from the foot of C round the right flank and across the top of C to D
    loop([[123, 146], [138, 164], [157, 158], [165, 124], [164, 86], [156, 62], [134, 56], [111, 62]]),
    // N- and C-termini: short tails (≈ 10–12 units beyond the helix caps) that leave sideways, gently curved, with no
    // upward curl (J-hooks beside the helix feet read as little feet)
    loop([[60, 171], [49, 180], [36, 184]], 5.2),
    loop([[95, 173], [107, 181], [120, 183]], 5.2),
    helix("A", base), turnPart("A", base),
    helix("D", base), turnPart("D", base),
  ];
}

/* ---------- lipid bilayer ---------- */

/** A short bilayer patch centred on y: orange heads in two rows, peach core, grey tails. */
function bilayer({ x0 = 4, x1 = 196, y = 130, th = 44, hr = 5, gaps = [], tails = true } = {}) {
  const top = y - th / 2, bot = y + th / 2;
  const pitch = 2 * hr + 1.1;
  const n = Math.floor((x1 - x0 - 2 * hr) / pitch) + 1;
  const start = (x0 + x1) / 2 - ((n - 1) * pitch) / 2;
  const heads = [];
  let tl = "";
  const wig = (x, y0, y1) => smoothOpen([[x, y0], [x + 0.8, y0 + (y1 - y0) * 0.35], [x - 0.8, y0 + (y1 - y0) * 0.7], [x, y1]]);
  for (let i = 0; i < n; i++) {
    const x = start + i * pitch;
    if (gaps.some(([a, b]) => x > a - hr * 0.5 && x < b + hr * 0.5)) continue;
    heads.push(circle(x, top + hr, hr), circle(x, bot - hr, hr));
    for (const dx of [-1.6, 1.6]) tl += wig(x + dx, top + 2 * hr - 1, y - 1.2) + wig(x + dx, bot - 2 * hr + 1, y + 1.2);
  }
  const parts = [{ d: rect(x0, top + hr, x1 - x0, th - 2 * hr), fill: MEM.core, thin: true }];
  if (tails && tl) parts.push({ d: tl, fill: "none", stroke: { color: MEM.tail, width: 1 } });
  parts.push({ d: heads, fill: MEM.head, shade: "small" });
  return parts;
}

/* ---------- antibodies ---------- */

const AB = { r: 9, h: 6 }; // domain radius and half-length (a domain is 30 × 18)

/**
 * Antibody chain geometry in local coordinates: hinge centre at the origin, Fc down (+y), Fab arms up.
 * kind "igg": 2 Fc domain pairs + flexible hinge (IgG, IgA, IgD); "igm": 3 pairs, no hinge (IgM, IgE).
 */
function abGeom({ kind = "igg", theta = 38, arms = [true, true], fc = true, hinge = true } = {}) {
  const { r, h } = AB, o = r + 0.3;
  const g = { dom: [], hinge: [], ss: [], tip: [], base: [], fcEnd: [0, 0] };
  const fcN = kind === "igg" ? 2 : 3, fcTop = kind === "igg" ? 11 : -6;
  if (fc) {
    for (let k = 0; k < fcN; k++) for (const side of [-1, 1]) {
      const cy = fcTop + 15 + k * 32;
      g.dom.push({ a: [side * o, cy - h], b: [side * o, cy + h], chain: side < 0 ? "hL" : "hR" });
    }
    g.fcEnd = [0, fcTop + fcN * 32 - 2];
  }
  const sn = Math.sin(theta * RAD), cs = Math.cos(theta * RAD);
  const strands = [];
  [-1, 1].forEach((side, i) => {
    if (!arms[i]) return;
    const u = [side * sn, -cs], nin = [-side * cs, -sn];
    const A0 = kind === "igg" ? [side * 20.5, -3.5] : [side * 19.8, -7.3];
    for (const [k, t] of [[0, 15], [1, 47]]) {
      for (const [w, chain] of [[o, side < 0 ? "hL" : "hR"], [-o, side < 0 ? "lL" : "lR"]]) {
        const c = add(add(A0, u, t), nin, w);
        g.dom.push({ a: add(c, u, -h), b: add(c, u, h), chain, arm: i, k });
      }
    }
    g.tip[i] = add(A0, u, 64);
    g.base[i] = add(A0, nin, o);
    if (hinge) {
      const from = [side * o, kind === "igg" ? 10 : fcTop + 3];
      const to = add(add(A0, nin, o), u, 4);
      g.hinge.push({ a: from, b: to, side });
      strands[i] = [from, to];
    }
  });
  if (kind === "igg" && hinge && strands[0] && strands[1]) {
    for (const yy of [4, -2]) {
      const xAt = ([a, b]) => a[0] + ((yy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      const xl = xAt(strands[0]) + 2.2, xr = xAt(strands[1]) - 2.2;
      g.ss.push([[xl, yy], [xr, yy]]);
    }
  }
  return g;
}

/** Parts for an antibody geometry under placement t. Colours per chain: hL, hR (heavy), lL, lR (light). */
function abParts(t, g, { hL = COL.heavy, hR = hL, lL = COL.light, lR = lL } = {}) {
  const fills = { hL, hR, lL, lR };
  const parts = [];
  for (const s of g.hinge) {
    parts.push({ d: capsule(...t.P(s.a), ...t.P(s.b), 2.6 * t.s), fill: s.side < 0 ? hL : hR, shade: "rim", thin: true, gloss: false, highlight: false });
  }
  if (g.ss.length) {
    parts.push({ d: g.ss.map(([a, b]) => polyline([t.P(a), t.P(b)])).join(""), fill: "none", stroke: { color: shade(hL, 0.2), width: 1.8 * t.s } });
  }
  for (const d of g.dom) parts.push(tdom(t, d.a, d.b, AB.r, fills[d.chain]));
  return parts;
}

/* ---------- icons ---------- */

export const icons = [
  {
    slug: "igg-antibody", name: "IgG antibody", category: "proteins",
    tags: ["IgG", "immunoglobulin G", "antibody", "Ab", "mAb", "monoclonal antibody", "polyclonal antibody", "primary antibody", "therapeutic antibody", "biologic", "immunoglobulin", "Ig", "heavy chain", "light chain", "Fab", "Fc", "hinge", "disulfide bond", "variable domain", "constant domain", "paratope", "Y-shaped", "anti-TNF", "ELISA", "flow cytometry", "immunohistochemistry", "IHC"],
    scene: () => ({ size: [200, 200], parts: fitted((t) => abParts(t, abGeom())) }),
  },
  {
    slug: "gpcr-g-protein", name: "GPCR with G protein", category: "membranes",
    tags: ["GPCR", "G protein-coupled receptor", "7TM", "seven-transmembrane receptor", "serpentine receptor", "heterotrimeric G protein", "G alpha", "G beta gamma", "Gαβγ", "Gs", "Gi", "Gq", "cAMP", "adenylyl cyclase", "chemokine receptor", "CXCR4", "CCR7", "S1P receptor", "ligand", "agonist", "signal transduction", "cell signalling", "membrane receptor", "transmembrane protein", "lipid bilayer", "plasma membrane", "drug target"],
    scene: () => {
      const y = 86, rec = "#4f9fd0";
      const parts = bilayer({ y, th: 46 });
      const xs = [43, 62, 81, 100, 119, 138, 157];
      const top = y - 27, bot = y + 27;
      // loops (behind the helices): N-terminus up, then alternating intra/extracellular loops, C-terminus down
      const loops = [ribbon([[xs[0], top + 4], [34, top - 10], [40, top - 22], [30, top - 32]], 4.4, { taper: 0.3 })];
      for (let i = 0; i < 6; i++) {
        const up = i % 2 === 1, yy = up ? top + 4 : bot - 4, peak = up ? top - 13 - (i === 3 ? 6 : 0) : bot + 12;
        loops.push(ribbon([[xs[i], yy], [xs[i] + 2, peak], [xs[i + 1] - 2, peak], [xs[i + 1], yy]], 4.4));
      }
      loops.push(ribbon([[xs[6], bot - 4], [166, bot + 12], [162, bot + 24], [170, bot + 34]], 4.4, { taper: 0.3 }));
      parts.push({ d: loops, fill: shade(rec, 0.04), shade: "rim", gloss: false, highlight: false });
      xs.forEach((x, i) => parts.push(dom([x + (i % 2 ? 1.5 : -1.5), top], [x - (i % 2 ? 1.5 : -1.5), bot], 7.6, rec)));
      // ligand in the extracellular pocket
      parts.push({ d: polygon([[100, 32], [109, 37], [109, 47], [100, 52], [91, 47], [91, 37]]), fill: "#e8607a", shade: "small" });
      // heterotrimeric G protein under the receptor
      parts.push({ unite: [ellipse(96, 150, 33, 22), circle(68, 140, 17)], fill: "#9b86d6", shade: "organelle" });
      parts.push({ d: blob(140, 160, 24, 20, { n: 8, wobble: 0.05, seed: 3 }), fill: "#7cc46a", shade: "organelle" });
      parts.push({ d: ellipse(162, 134, 15, 7.5, -24), fill: "#e9c34f", shade: "organelle", glossSize: 0.07 });
      return { size: [200, 200], parts };
    },
  },
  {
    slug: "cytokine", name: "Cytokine", category: "proteins",
    tags: ["cytokine", "interleukin", "IL", "IL-2", "IL-6", "IL-4", "IL-10", "IL-21", "IL-1β", "IL-1 beta", "IL-17", "IL-23", "TNF", "TNF-α", "TNF alpha", "cytokine storm", "GM-CSF", "interferon", "IFN-γ", "IFN gamma", "EPO", "four-helix bundle", "4-helix bundle", "helical cytokine", "alpha helix", "chemokine", "growth factor", "signalling protein", "signaling protein", "ligand", "secreted protein", "soluble factor", "inflammatory mediator", "JAK-STAT"],
    scene: () => ({ size: [200, 200], parts: cytokineParts() }),
  },
];
