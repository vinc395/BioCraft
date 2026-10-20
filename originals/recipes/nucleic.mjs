// Nucleic acids, chromosomes and the machinery that reads them — Servier-like.
// Light from the top left. DNA is right-handed: on a horizontal helix the strand in front runs
// from upper left to lower right ("\"), on a vertical one from lower left to upper right ("/").
import { circle, ellipse, rect, capsule, smoothClosed, smoothOpen, polygon, rotate, rng, f } from "../lib/geom.mjs";
import { shade, tint } from "../lib/style.mjs";

/* ---------- palette (hues ≥ 35° apart so each stays its own recolour slot) ---------- */

const COL = {
  s1: "#4b7fd1", // strand 1 backbone (blue)
  s2: "#d9609a", // strand 2 backbone (rose)
  A: "#74c267", // adenine (green)
  T: "#f4c84a", // thymine / uracil (yellow)
  G: "#f08b45", // guanine (orange)
  C: "#45bdd0", // cytosine (cyan)
};
const PAIR = { A: "T", T: "A", G: "C", C: "G" };
const BASES = ["A", "T", "G", "C"];

/** Deterministic base sequence. */
function sequence(n, seed = 1) {
  const R = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(BASES[Math.floor(R() * 4)]);
  return out;
}

/** Closed band along points with a width per point (butt ends). */
function band(pts, widths) {
  const L = [], Rt = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const w = (Array.isArray(widths) ? widths[i] : widths) / 2;
    L.push([pts[i][0] - (dy / l) * w, pts[i][1] + (dx / l) * w]);
    Rt.push([pts[i][0] + (dy / l) * w, pts[i][1] - (dx / l) * w]);
  }
  return smoothOpen(L) + "L" + smoothOpen(Rt.reverse()).slice(1) + "Z";
}

/** A quad (4 local points) mapped to the page. */
const quad = (pts, map) => polygon(pts.map(map));

/** Group rung pieces by base letter into one part per colour. */
function basesToParts(pieces, extra = {}) {
  const by = {};
  for (const [b, d] of pieces) (by[b] ||= []).push(d);
  return BASES.filter((b) => by[b]).map((b) => ({ d: by[b], fill: COL[b], shade: "rim", gloss: false, highlight: false, lineWidth: 1.1, ...extra }));
}

/**
 * Right-handed double helix along a straight local axis x0 → x1 (y = cy), mapped onto the page
 * by `map`. Backbones are flat ribbons, wide where they face the viewer and narrow at the edges.
 * Returns { back, rungs, front } part lists (draw in that order).
 */
function helix(o) {
  const { x0, x1, cy = 0, amp, period, phase = 0, width = 10, minW = 0.42, rungW = 5.5, seed = 1,
    map = (p) => p, c1 = COL.s1, c2 = COL.s2, backDark = 0.12, step = period / 9, shadeKind = "rim" } = o;
  const k = (2 * Math.PI) / period;
  const th = (x) => k * (x - x0) + phase;
  const X = (t) => x0 + (t - phase) / k;
  const Y = [null, (t) => cy + amp * Math.cos(t), (t) => cy - amp * Math.cos(t)];
  const wAt = (t) => width * (minW + (1 - minW) * Math.abs(Math.sin(t)));
  const segs = { f1: [], b1: [], f2: [], b2: [] };
  const t0 = th(x0), t1 = th(x1);
  for (let m = Math.floor(t0 / Math.PI); m * Math.PI < t1; m++) {
    const ta = Math.max(t0, m * Math.PI), tb = Math.min(t1, (m + 1) * Math.PI);
    if (tb - ta < 0.04) continue;
    const odd = ((m % 2) + 2) % 2 === 1;
    for (const s of [1, 2]) {
      const pts = [], ws = [];
      const N = Math.max(4, Math.round(((tb - ta) / Math.PI) * 16));
      for (let i = 0; i <= N; i++) {
        const t = ta + ((tb - ta) * i) / N;
        pts.push(map([X(t), Y[s](t)]));
        ws.push(wAt(t));
      }
      // z1 = −sin t: strand 1 is in front on odd half-turns, strand 2 on even ones
      const front = s === 1 ? odd : !odd;
      segs[(front ? "f" : "b") + s].push(band(pts, ws));
    }
  }
  // base pairs
  const pieces = [];
  const n = Math.floor((x1 - x0) / step);
  const seq = o.seq || sequence(n, seed);
  for (let i = 0; i < n; i++) {
    const x = x0 + (i + 0.5) * step, t = th(x);
    const ya = Y[1](t), yb = Y[2](t);
    if (Math.abs(ya - yb) < width * 1.5) continue;
    const front1 = -Math.sin(t) > 0;
    const w = wAt(t) / 2;
    // the rung runs from the front strand's centre to the back strand's inner edge
    const ea = front1 ? ya : ya + Math.sign(cy - ya) * (w - 0.6);
    const eb = front1 ? yb + Math.sign(cy - yb) * (w - 0.6) : yb;
    const b1 = seq[i], b2 = PAIR[b1];
    const h = rungW / 2;
    pieces.push([b1, quad([[x - h, ea], [x + h, ea], [x + h, cy], [x - h, cy]], map)]);
    pieces.push([b2, quad([[x - h, cy], [x + h, cy], [x + h, eb], [x - h, eb]], map)]);
  }
  const strand = (ds, fill) => ({ d: ds, fill, shade: shadeKind, gloss: false });
  return {
    back: [strand(segs.b1, shade(c1, backDark)), strand(segs.b2, shade(c2, backDark))].filter((p) => p.d.length),
    rungs: basesToParts(pieces),
    front: [strand(segs.f1, c1), strand(segs.f2, c2)].filter((p) => p.d.length),
  };
}
const helixParts = (h) => [...h.back, ...h.rungs, ...h.front];

const DNA_TAGS = ["DNA", "dsDNA", "double-stranded DNA", "double helix", "deoxyribonucleic acid", "genome", "genomic DNA", "gDNA", "genetic material", "gene", "genetics", "base pairs", "bp", "nucleotides", "A T G C", "Watson-Crick", "sugar-phosphate backbone", "major groove", "minor groove", "sequencing", "genomics"];

export const icons = [
  {
    slug: "dna-double-helix", name: "DNA double helix", category: "nucleic-acids",
    tags: [...DNA_TAGS, "B-DNA", "helix", "horizontal"],
    scene: () => ({ size: [300, 140], parts: helixParts(helix({ x0: 12, x1: 288, cy: 70, amp: 44, period: 92, phase: Math.PI * 0.3, width: 12, seed: 3 })) }),
  },
  {
    slug: "dna-double-helix-vertical", name: "DNA double helix (vertical)", category: "nucleic-acids",
    tags: [...DNA_TAGS, "B-DNA", "helix", "vertical"],
    scene: () => ({ size: [140, 300], parts: helixParts(helix({ x0: 12, x1: 288, cy: 70, amp: 44, period: 92, phase: Math.PI * 0.3, width: 12, seed: 5, map: ([x, y]) => [y, 300 - x] })) }),
  },
];
