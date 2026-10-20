// Shared histology pieces for tissue recipes: layer collector, palette, vessels and cells.
import { circle, ellipse, capsule, blob, rng } from "./geom.mjs";
import { shade } from "./style.mjs";
import { rbc, lobes, packIn } from "./tissue.mjs";

export const C = {
  fls: "#f4c3d1", mls: "#e3caee", nucleus: "#8b63b3",
  matrix: "#fbe3e1", matrixRA: "#f8d3d3", matrixFib: "#f7dcd6",
  collagen: "#eebaba", fibro: "#ef9fbf",
  wall: "#f29a9e", lumen: "#fdebe9", rbc: "#d9434b", endo: "#a974b9", artWall: "#e3828b",
  lymph: "#bfe3c8", lymphLumen: "#effaf1",
  fat: "#fbe8a6", fatBorder: "#e2c470", fatNuc: "#b392c7",
  fibrin: "#f6e6a4", tcell: "#9fcaf0", tnuc: "#4e63ad", bcell: "#c2e3a1", bnuc: "#4f7c3a", gc: "#e2f1fb",
  plasma: "#f3b8cd", plasmaNuc: "#7b4c9c", mac: "#f6c09d", macNuc: "#9a6aa9", mast: "#f2dcc0", mastGran: "#8e4aa6",
  neut: "#f8d9e4", neutNuc: "#7b4a9e",
};

/** Collects shapes by layer so each colour becomes one compound path (one draw call). */
export class Layers {
  constructor() {
    this.keys = [];
    this.map = new Map();
  }
  def(key, style) {
    if (!this.map.has(key)) {
      this.keys.push(key);
      this.map.set(key, { ...style, ds: [] });
    }
    return this;
  }
  add(key, d) {
    this.map.get(key).ds.push(...[].concat(d).filter(Boolean));
  }
  parts() {
    return this.keys
      .map((k) => {
        const { ds, ...st } = this.map.get(k);
        if (st.unite) return st; // one shape merged from several paths by VectorCraft
        return ds.length ? { ...st, d: ds.join("") } : null;
      })
      .filter(Boolean);
  }
}

export const sw = (color, width = 0.9) => ({ color, width });

export function defineLayers(L, matrixFill) {
  L.def("matrix", { fill: matrixFill, stroke: sw(shade(matrixFill, 0.1), 1), lineWidth: 1.2 })
    .def("collagen", { fill: "none", stroke: { color: C.collagen, width: 1.5, cap: "round" }, lineColor: "#dca5a8", lineStrokeWidth: 1 })
    .def("fat", { fill: C.fat, stroke: sw(C.fatBorder, 1.3), lineWidth: 1 })
    .def("fatNuc", { fill: C.fatNuc, lineWidth: 0.5 })
    .def("lymphWall", { fill: C.lymph, stroke: sw(shade(C.lymph, 0.2), 0.8), lineWidth: 0.9 })
    .def("lymphLumen", { fill: C.lymphLumen, lineWidth: 0.5 })
    .def("artWall", { fill: C.artWall, stroke: sw(shade(C.artWall, 0.16)), shade: "small", lineWidth: 1 })
    .def("wall", { fill: C.wall, stroke: sw(shade(C.wall, 0.16)), shade: "small", lineWidth: 0.9 })
    .def("lumen", { fill: C.lumen, lineWidth: 0.5 })
    .def("rbc", { fill: C.rbc, shade: "small", lineWidth: 0.5 })
    .def("endo", { fill: C.endo, lineWidth: 0.4 })
    .def("fibro", { fill: C.fibro, stroke: sw(shade(C.fibro, 0.14), 0.7), shade: "small", lineWidth: 0.8 })
    .def("fibroNuc", { fill: C.nucleus, lineWidth: 0.5 })
    .def("gc", { fill: C.gc, opacity: 0.95, lineWidth: 0.8 })
    .def("bcell", { fill: C.bcell, shade: "small", lineWidth: 0.6 })
    .def("bnuc", { fill: C.bnuc, lineWidth: 0.4 })
    .def("tcell", { fill: C.tcell, shade: "small", lineWidth: 0.6 })
    .def("tnuc", { fill: C.tnuc, lineWidth: 0.4 })
    .def("plasma", { fill: C.plasma, shade: "small", lineWidth: 0.6 })
    .def("plasmaNuc", { fill: C.plasmaNuc, lineWidth: 0.4 })
    .def("mac", { fill: C.mac, stroke: sw(shade(C.mac, 0.14), 0.6), shade: "small", lineWidth: 0.7 })
    .def("macNuc", { fill: C.macNuc, lineWidth: 0.4 })
    .def("mast", { fill: C.mast, shade: "small", lineWidth: 0.7 })
    .def("mastGran", { fill: C.mastGran, lineWidth: 0.3 })
    .def("fls", { fill: C.fls, stroke: sw(shade(C.fls, 0.16)), lineWidth: 0.8 })
    .def("mls", { fill: C.mls, stroke: sw(shade(C.mls, 0.16)), lineWidth: 0.8 })
    .def("liningNuc", { fill: C.nucleus, shade: "small", lineWidth: 0.5 })
    .def("fibrin", { fill: C.fibrin, stroke: sw(shade(C.fibrin, 0.14), 0.8), shade: "small", lineWidth: 0.9 })
    .def("neut", { fill: C.neut, shade: "small", lineWidth: 0.6 })
    .def("neutNuc", { fill: C.neutNuc, lineWidth: 0.4 });
}

/** A vessel cut across: wall, lumen, red cells and endothelial nuclei. */
export function vessel(L, { cx, cy, rx, ry = rx, rot = 0, kind = "cap", rbcs = 1, seed = 1 }) {
  const R = rng(seed);
  if (kind === "lymph") {
    L.add("lymphWall", blob(cx, cy, rx, ry, { n: 9, wobble: 0.1, seed, rot }));
    L.add("lymphLumen", blob(cx, cy, rx - 1.8, ry - 1.8, { n: 9, wobble: 0.12, seed: seed + 1, rot }));
    return;
  }
  const wall = kind === "art" ? Math.max(3.5, Math.min(rx, ry) * 0.42) : Math.max(1.8, Math.min(rx, ry) * 0.24);
  L.add(kind === "art" ? "artWall" : "wall", ellipse(cx, cy, rx, ry, rot));
  L.add("lumen", ellipse(cx, cy, rx - wall, ry - wall, rot));
  const ir = Math.min(rx, ry) - wall;
  const pts = rbcs > 1 ? packIn(cx, cy, (rx - wall) * 0.55, (ry - wall) * 0.55, rbcs, ir * 0.75, { seed }) : [[cx, cy]];
  for (const [x, y] of pts) L.add("rbc", rbc(x, y, Math.min(3.6, ir * 0.62), R() * 180));
  const a0 = R() * 360, rr = (rot * Math.PI) / 180;
  for (let k = 0; k < 3; k++) {
    const a = ((a0 + k * 120) * Math.PI) / 180;
    const lx = Math.cos(a) * (rx - wall * 1.05), ly = Math.sin(a) * (ry - wall * 1.05);
    const x = cx + lx * Math.cos(rr) - ly * Math.sin(rr), y = cy + lx * Math.sin(rr) + ly * Math.cos(rr);
    L.add("endo", ellipse(x, y, 2.3, 1.1, (Math.atan2(ly, lx) * 180) / Math.PI + rot + 90));
  }
}

/** A capillary cut lengthwise with red cells in single file. */
export function capillaryAlong(L, x0, y0, x1, y1, r = 5, seed = 2) {
  L.add("wall", capsule(x0, y0, x1, y1, r));
  L.add("lumen", capsule(x0, y0, x1, y1, r - 1.7));
  const n = Math.max(2, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 11));
  const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    L.add("rbc", ellipse(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1.9, r - 2.2, ang));
  }
}

export const lymphocyte = (L, [x, y], r, kind, R) => {
  L.add(kind === "B" ? "bcell" : "tcell", circle(x, y, r));
  L.add(kind === "B" ? "bnuc" : "tnuc", circle(x + (R() - 0.5) * r * 0.3, y + (R() - 0.5) * r * 0.3, r * 0.68));
};
export const plasmaCell = (L, [x, y], R) => {
  const a = R() * 180, ar = (a * Math.PI) / 180;
  L.add("plasma", ellipse(x, y, 6.2, 4.4, a));
  L.add("plasmaNuc", circle(x + Math.cos(ar) * 2.3, y + Math.sin(ar) * 2.3, 2.5));
};
export const macrophage = (L, [x, y], seed, s = 1) => {
  L.add("mac", blob(x, y, 7.8 * s, 6.6 * s, { n: 7, wobble: 0.3, seed }));
  L.add("macNuc", circle(x - 1.3 * s, y + 0.6 * s, 2.7 * s) + circle(x + 1.6 * s, y - 0.5 * s, 2.3 * s));
};
export const neutrophil = (L, [x, y], R) => {
  L.add("neut", circle(x, y, 6));
  L.add("neutNuc", lobes(x, y, 4.3, 3, R() * 360));
};
export const mastCell = (L, [x, y], seed) => {
  L.add("mast", blob(x, y, 9, 7, { n: 8, wobble: 0.12, seed }));
  for (const [gx, gy] of packIn(x, y, 7, 5.2, 14, 2.6, { seed })) L.add("mastGran", circle(gx, gy, 0.95));
};

