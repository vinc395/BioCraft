// Colour maths (OKLab), the BioRender-style slot recolouring, and palettes.

export function parseHex(h) {
  h = String(h || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export const toHex = ([r, g, b]) => "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
export const normHex = (h) => {
  const p = parseHex(h);
  return p ? toHex(p) : null;
};

const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (x) => {
  x = Math.max(0, Math.min(1, x));
  return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
};

export function toOklab([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (lab) => oklabToLinear(lab).every((c) => c >= -0.0005 && c <= 1.0005);

export function toLch(rgb) {
  const [L, a, b] = toOklab(rgb);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.hypot(a, b), h];
}
export function fromLch(L, C, h) {
  L = Math.max(0, Math.min(1, L));
  const lab = (c) => [L, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
  let lo = 0, hi = C;
  if (!inGamut(lab(C))) {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(lab(mid))) lo = mid;
      else hi = mid;
    }
    C = lo;
  }
  return oklabToLinear(lab(C)).map(gam);
}

/** Move `member` the way `base` moves to `target`, keeping its shading offsets (as the Rust side). */
export function shiftLike(member, base, target) {
  const [ml, mc, mh] = toLch(parseHex(member));
  const [bl, bc, bh] = toLch(parseHex(base));
  const [tl, tc, th] = toLch(parseHex(target));
  // pale bases: shift chroma additively (a ratio would explode); otherwise scale, capped
  const c = bc > 0.06 ? mc * Math.min(2.2, tc / bc) : Math.max(0, mc + (tc - bc));
  let dh = 0;
  if (bc > 0.02 && mc > 0.02) dh = ((mh - bh + 540) % 360) - 180;
  const dl = ml - bl;
  const l = dl >= 0 ? tl + dl * Math.min(1.5, (1 - tl) / Math.max(0.05, 1 - bl)) : tl + dl * Math.min(1.5, tl / Math.max(0.05, bl));
  return toHex(fromLch(l, c, th + dh));
}

/** Colour map for an icon from its slots and the per-slot target colours (null = unchanged). */
export function slotColorMap(slots, targets) {
  const map = {};
  slots.forEach((slot, i) => {
    const t = targets?.[i];
    if (!t) return;
    for (const m of slot.members) map[m.toLowerCase()] = m.toLowerCase() === slot.base.toLowerCase() ? normHex(t) : shiftLike(m, slot.base, t);
  });
  return map;
}

/** Map every chromatic colour onto one hue (a "tint" like BioRender's monochrome option). */
export function tintMap(slots, target) {
  const map = {};
  const [, tc, th] = toLch(parseHex(target));
  for (const slot of slots) {
    for (const m of slot.members) {
      const [l, c] = toLch(parseHex(m));
      map[m.toLowerCase()] = toHex(fromLch(l, slot.kind === "color" ? Math.max(c, tc * 0.6) : c * 0.5 + tc * 0.15, th));
    }
  }
  return map;
}

export function grayMap(slots) {
  const map = {};
  for (const slot of slots) for (const m of slot.members) {
    const [l] = toLch(parseHex(m));
    map[m.toLowerCase()] = toHex(fromLch(l, 0, 0));
  }
  return map;
}

/**
 * Colour overlay (BioRender's quick swatches): like tintMap, but the drawing also moves part of the
 * way towards the swatch's lightness (a rust or black overlay darkens it), keeping every shading
 * offset. Grey and black swatches give a neutral result.
 */
export function overlayMap(slots, target) {
  const map = {};
  const [tl, tc, th] = toLch(parseHex(target));
  const body = [...slots].filter((s) => s.kind === "color").sort((a, b) => b.weight - a.weight)[0] || [...slots].sort((a, b) => b.weight - a.weight)[0];
  const shift = body ? (tl - toLch(parseHex(body.base))[0]) * 0.6 : 0;
  const gray = tc < 0.025;
  for (const slot of slots) {
    for (const m of slot.members) {
      const [l, c] = toLch(parseHex(m));
      const L = l + shift * (slot.kind === "color" ? 1 : 0.5);
      const C = gray ? 0 : slot.kind === "color" ? Math.max(c, tc * 0.6) : c * 0.5 + tc * 0.15;
      map[m.toLowerCase()] = toHex(fromLch(Math.max(0.04, Math.min(0.99, L)), C, th));
    }
  }
  return map;
}

/** Saturation (0–200 %, 100 = unchanged) and lightness (−100…100, 0 = unchanged) in OKLCH. */
export function adjustHex(hex, sat = 100, light = 0) {
  const p = parseHex(hex);
  if (!p) return hex;
  let [L, C, H] = toLch(p);
  C *= Math.max(0, sat) / 100;
  const k = Math.max(-1, Math.min(1, light / 100));
  L = k >= 0 ? L + (1 - L) * k : L * (1 + k);
  return toHex(fromLch(L, C, H));
}

// Pastels in the Servier spirit, then saturated, then neutrals.
export const PALETTE = [
  "#f7c6c7", "#f9d7b4", "#fbeeb0", "#d9efb6", "#b9e4cf", "#b6e0ee", "#bcd3f2", "#d4c8f0", "#efc6e6", "#e9dcd0",
  "#e86f74", "#f0a35c", "#f2cf4a", "#9ccc65", "#4fb59a", "#4aa9d0", "#5b8bd9", "#9473d6", "#d465b5", "#b98b6b",
  "#b8323b", "#c76b1f", "#b89412", "#4f8a2c", "#1f7a62", "#1f6f99", "#2d4fa3", "#5b3d9e", "#99307a", "#7a5034",
  "#ffffff", "#e6e9ed", "#c4cad2", "#9aa3ad", "#6c7682", "#4a525b", "#30363d", "#1c2127", "#0d1014", "#000000",
];

/** Okabe–Ito colour-blind-safe set, handy for figures. */
export const SAFE = ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#000000"];
