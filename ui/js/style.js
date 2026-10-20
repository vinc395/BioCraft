// Icon styling like BioRender's Style panel: ready-made colour presets built from an icon's colour
// slots, heuristic names for its parts (body, nucleus, granules…), the colour overlay, and the
// saturation / lightness adjustments.
//
// Icon fields (all optional, so older figures load unchanged)
//   colors      {from: to} — the colours actually drawn (adjustments included), as before
//   slotColors  per-part target colours; tint "#hex" | "gray" — the recipe colors comes from
//   preset      id of the applied preset (outlined in the panel)
//   saturation  0–200 (100), lightness −100…100 (0): OKLCH adjustments applied on top
//   baseColors  the colour map before the adjustments (kept only while one is active)

import { state } from "./model.js";
import { assetParts, iconInner, iconParts } from "./render.js";
import { parseHex, toHex, toLch, fromLch, normHex, slotColorMap, grayMap, overlayMap, adjustHex } from "./color.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lch = (hex) => toLch(parseHex(hex) || [0, 0, 0]);
const hexL = ([L, C, H]) => toHex(fromLch(L, C, H));

/* ---------- every colour an icon draws ---------- */

const PAINT = /(?:fill|stroke|stop-color|flood-color|lighting-color)="(#[0-9a-fA-F]{6})"/g;
const colorCache = new Map();

/** Every hex colour painted in an asset's markup (lower case, once each). */
export function assetColors(assetId, asset) {
  let c = colorCache.get(assetId);
  if (!c) {
    c = [...new Set([...String(asset.svg || "").matchAll(PAINT)].map((m) => m[1].toLowerCase()))];
    colorCache.set(assetId, c);
  }
  return c;
}

const docAsset = (o) => state.doc?.assets?.[o.asset];
export const hasAdjust = (o) => (o.saturation ?? 100) !== 100 || (o.lightness ?? 0) !== 0;

/** Set an icon's colours from a recipe map, applying its saturation/lightness on top. */
export function setIconColors(o, base = {}, asset = docAsset(o)) {
  if (!hasAdjust(o) || !asset) {
    o.colors = base;
    delete o.baseColors;
    return o;
  }
  const out = {};
  for (const c of assetColors(o.asset, asset)) out[c] = adjustHex(base[c] || c, o.saturation ?? 100, o.lightness ?? 0);
  o.baseColors = base;
  o.colors = out;
  return o;
}

/** Change the saturation and/or lightness (undefined leaves one as it is). */
export function setAdjust(o, { saturation, lightness } = {}, asset = docAsset(o)) {
  const base = o.baseColors || o.colors || {};
  if (saturation != null) {
    if (Math.round(saturation) === 100) delete o.saturation;
    else o.saturation = clamp(Math.round(saturation), 0, 200);
  }
  if (lightness != null) {
    if (Math.round(lightness) === 0) delete o.lightness;
    else o.lightness = clamp(Math.round(lightness), -100, 100);
  }
  return setIconColors(o, base, asset);
}

/** Back to the library's own colours (and fully opaque). */
export function resetStyle(o) {
  o.colors = {};
  o.slotColors = [];
  for (const k of ["tint", "preset", "saturation", "lightness", "baseColors", "opacity"]) delete o[k];
  return o;
}

/** One part's colour; parts left alone keep the current overlay or preset look. */
export function setPartColor(o, i, hex, asset = docAsset(o)) {
  const slots = asset?.slots || [];
  const base = o.baseColors || o.colors || {};
  const t = o.slotColors?.some(Boolean) ? [...o.slotColors] : o.tint ? slots.map((s) => base[s.base.toLowerCase()] || null) : [];
  t[i] = hex ? normHex(hex) : null;
  o.slotColors = t;
  delete o.tint;
  delete o.preset;
  return setIconColors(o, slotColorMap(slots, t), asset);
}

/** Overall colour overlay (tint) from a swatch; "gray" for greyscale. */
export function applyOverlay(o, hex, asset = docAsset(o)) {
  const slots = asset?.slots || [];
  o.slotColors = [];
  delete o.preset;
  if (hex === "gray") {
    o.tint = "gray";
    return setIconColors(o, grayMap(slots), asset);
  }
  o.tint = normHex(hex);
  return setIconColors(o, overlayMap(slots, o.tint), asset);
}

/* ---------- part names ---------- */

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/iy;

/** Rough bounds of each subpath of path data (end and control points; no transforms). */
export function pathBoxes(d) {
  let i = 0, x = 0, y = 0, sx = 0, sy = 0, cmd = "";
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const boxes = [];
  const flush = () => {
    if (x1 >= x0) boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    x0 = y0 = Infinity;
    x1 = y1 = -Infinity;
  };
  const add = (px, py) => {
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  };
  const ws = () => {
    while (i < d.length && (d[i] === " " || d[i] === "," || d[i] === "\n" || d[i] === "\t" || d[i] === "\r")) i++;
  };
  const num = () => {
    ws();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return null;
    i = NUM.lastIndex;
    return +m[0];
  };
  const flag = () => {
    ws();
    const c = d[i];
    if (c !== "0" && c !== "1") return null;
    i++;
    return +c;
  };
  const nums = (k) => {
    const out = [];
    for (let j = 0; j < k; j++) {
      const v = num();
      if (v == null) return null;
      out.push(v);
    }
    return out;
  };
  for (let guard = 0; guard < 200000; guard++) {
    ws();
    if (i >= d.length) break;
    if (/[a-z]/i.test(d[i])) {
      cmd = d[i++];
      if (cmd === "M" || cmd === "m") flush();
      if (cmd === "z" || cmd === "Z") {
        x = sx;
        y = sy;
        continue;
      }
    } else if (!cmd || cmd === "z" || cmd === "Z") break;
    const rel = cmd !== cmd.toUpperCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    let a;
    if (C === "M" || C === "L" || C === "T") {
      if (!(a = nums(2))) break;
      [x, y] = [ox + a[0], oy + a[1]];
      if (C === "M") {
        [sx, sy] = [x, y];
        cmd = rel ? "l" : "L";
      }
    } else if (C === "H") {
      if (!(a = nums(1))) break;
      x = ox + a[0];
    } else if (C === "V") {
      if (!(a = nums(1))) break;
      y = oy + a[0];
    } else if (C === "C") {
      if (!(a = nums(6))) break;
      add(ox + a[0], oy + a[1]);
      add(ox + a[2], oy + a[3]);
      [x, y] = [ox + a[4], oy + a[5]];
    } else if (C === "S" || C === "Q") {
      if (!(a = nums(4))) break;
      add(ox + a[0], oy + a[1]);
      [x, y] = [ox + a[2], oy + a[3]];
    } else if (C === "A") {
      const r = nums(3), fa = flag(), fs = flag(), e = nums(2);
      if (!r || fa == null || fs == null || !e) break;
      [x, y] = [ox + e[0], oy + e[1]];
    } else break;
    add(x, y);
  }
  flush();
  return boxes;
}

const attr = (s, k) => {
  const m = new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(s);
  return m ? m[1] : null;
};

/** Bounds of a shape element (one per subpath for paths). */
function shapeBoxes(tag, a) {
  const f = (k) => parseFloat(attr(a, k)) || 0;
  if (tag === "path") return pathBoxes(attr(a, "d") || "");
  if (tag === "circle") return [{ x: f("cx") - f("r"), y: f("cy") - f("r"), w: 2 * f("r"), h: 2 * f("r") }];
  if (tag === "ellipse") return [{ x: f("cx") - f("rx"), y: f("cy") - f("ry"), w: 2 * f("rx"), h: 2 * f("ry") }];
  if (tag === "rect") return [{ x: f("x"), y: f("y"), w: f("width"), h: f("height") }];
  if (tag === "line") return [{ x: Math.min(f("x1"), f("x2")), y: Math.min(f("y1"), f("y2")), w: Math.abs(f("x2") - f("x1")), h: Math.abs(f("y2") - f("y1")) }];
  const p = (attr(a, "points") || "").trim().split(/[\s,]+/).map(Number);
  if (p.length < 4) return [];
  const xs = p.filter((_, j) => j % 2 === 0), ys = p.filter((_, j) => j % 2 === 1);
  return [{ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }];
}

/** Stop colours of every gradient, by id (following href to a gradient's template). */
function gradientStops(svg) {
  const stops = new Map(), href = new Map();
  for (const m of svg.matchAll(/<(linearGradient|radialGradient)\b([^>]*?)(\/?)>/g)) {
    const id = attr(m[2], "id");
    if (!id) continue;
    const h = attr(m[2], "xlink:href") ?? attr(m[2], "href");
    if (h?.startsWith("#")) href.set(id, h.slice(1));
    const end = m[3] ? -1 : svg.indexOf(`</${m[1]}>`, m.index);
    const inner = end < 0 ? "" : svg.slice(m.index + m[0].length, end);
    stops.set(id, [...inner.matchAll(/stop-color="(#[0-9a-fA-F]{6})"/g)].map((x) => x[1].toLowerCase()));
  }
  const resolve = (id, depth = 0) => {
    const s = stops.get(id) || [];
    return s.length || depth > 4 || !href.has(id) ? s : resolve(href.get(id), depth + 1);
  };
  return new Map([...stops.keys()].map((id) => [id, resolve(id)]));
}

/**
 * Shapes per colour: {fills: [box], strokes: n, grads: Set(gradient id)}, with fill/stroke inherited
 * from groups. A gradient fill counts for each of its stop colours (and records the gradient, so
 * shades that share one are known to shade the same shape).
 */
function colorUse(svg) {
  const use = new Map();
  const get = (c) => {
    let u = use.get(c);
    if (!u) use.set(c, (u = { fills: [], strokes: 0, grads: new Set() }));
    return u;
  };
  const grads = gradientStops(svg);
  // the hex colours a paint value uses, and the gradient it comes from
  const paint = (v) => {
    const g = /^url\(#([^)]+)\)$/.exec(v || "");
    if (g) return { cols: grads.get(g[1]) || [], grad: g[1] };
    const h = (v || "").toLowerCase();
    return { cols: /^#[0-9a-f]{6}$/.test(h) ? [h] : [], grad: null };
  };
  const stack = [{ fill: null, stroke: null }];
  const TAG = /<(\/?)(g|path|circle|ellipse|rect|polygon|polyline|line)\b([^>]*?)(\/?)>/g;
  for (const m of svg.matchAll(TAG)) {
    const [, close, tag, a, self] = m;
    const top = stack[stack.length - 1];
    if (tag === "g") {
      if (close) stack.length > 1 && stack.pop();
      else if (!self) stack.push({ fill: attr(a, "fill") ?? top.fill, stroke: attr(a, "stroke") ?? top.stroke });
      continue;
    }
    if (close) continue;
    const fill = paint(attr(a, "fill") ?? top.fill), stroke = paint(attr(a, "stroke") ?? top.stroke);
    if (fill.cols.length) {
      const boxes = shapeBoxes(tag, a);
      for (const c of new Set(fill.cols)) {
        const u = get(c);
        u.fills.push(...boxes);
        if (fill.grad) u.grads.add(fill.grad);
      }
    }
    for (const c of stroke.cols) get(c).strokes++;
  }
  return use;
}

/** Bounds of several boxes, or null. */
function union(boxes) {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** Overlap of two boxes: intersection over union (0–1). */
function iou(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h;
  return i / (a.w * a.h + b.w * b.h - i || 1);
}

const CELLISH =/cell|cyte|phage|phil\b|phils\b|blast|neuron|platelet|bacteri|microbe|yeast|sperm|oocyte|ovum|zygote|embryo|amoeba|protist|parasite/i;
// library categories that never hold a single cell, whatever the name says ("Flow cytometer cell sorter")
const NOT_CELLS = /^(lab|methods|shapes|charts|computing|people|animals|plants|anatomy|tissues|molecules|proteins|nucleic-acids|organelles|membranes)$/;
export function isCellIcon(asset) {
  const cat = asset?.meta?.category || "";
  if (/cell/i.test(cat)) return true;
  return !NOT_CELLS.test(cat) && CELLISH.test(asset?.meta?.name || "");
}

const partsCache = new Map();

/**
 * Per slot: {i, kind, weight, L, C, H, name, role}. Names are heuristics: the heaviest light-to-mid
 * chromatic part is the body ("Cell" in cell icons), a darker round purple/blue part the nucleus (its
 * darker rim "Nucleus outline"), a darker part as large as the body or drawn only as strokes the
 * outline, lighter shades of the body highlights, small repeated shapes granules, receptors or
 * details, neutral parts outline or highlights; anything else "Part n".
 * Roles drive the presets: body, rim (body hue, darker), inner (the nucleus or main darker part),
 * dark (inner hue, darker), light (body hue, lighter) or neutral (left as drawn).
 */
export function partInfo(assetId, asset) {
  let p = partsCache.get(assetId);
  if (p) return p;
  const slots = asset.slots || [];
  const cell = isCellIcon(asset);
  const [vx, vy, vw, vh] = assetParts(assetId, asset).vb;
  const D = Math.max(vw, vh) || 1;
  const use = colorUse(String(asset.svg || ""));
  const info = slots.map((s, i) => {
    const [L, C, H] = lch(s.base);
    const members = s.members.map((m) => m.toLowerCase());
    const base = use.get(s.base.toLowerCase());
    const all = members.flatMap((m) => use.get(m)?.fills || []);
    const shapes = base?.fills.length ? base.fills : all;
    const strokes = members.reduce((n, m) => n + (use.get(m)?.strokes || 0), 0);
    const grads = new Set(members.flatMap((m) => [...(use.get(m)?.grads || [])]));
    // the largest shape in any shade (a body's base colour may only be used for small details)
    const big = all.reduce((a, b) => (!a || b.w * b.h > a.w * a.h ? b : a), null);
    let ext = null;
    for (const b of all) {
      ext = ext ? { x: Math.min(ext.x, b.x), y: Math.min(ext.y, b.y), x1: Math.max(ext.x1, b.x + b.w), y1: Math.max(ext.y1, b.y + b.h) } : { x: b.x, y: b.y, x1: b.x + b.w, y1: b.y + b.h };
    }
    const sizes = shapes.map((b) => Math.max(b.w, b.h) / D).sort((a, b) => a - b);
    return {
      i, kind: s.kind, weight: s.weight, L, C, H, name: "", role: "neutral",
      n: shapes.length, shapes, grads, strokeOnly: !all.length && strokes > 0,
      ext: ext && { x: ext.x, y: ext.y, w: ext.x1 - ext.x, h: ext.y1 - ext.y },
      big, median: sizes.length ? sizes[sizes.length >> 1] : 0,
      aspect: big && big.h > 0 ? big.w / big.h : 1,
    };
  });
  const chrom = info.filter((s) => s.kind === "color" && !s.strokeOnly);
  const heaviest = (xs) => [...xs].sort((a, b) => b.weight - a.weight)[0];
  let body = heaviest(chrom.filter((s) => s.L >= 0.55)) || heaviest(chrom);
  if (!body) body = heaviest(info.filter((s) => s.kind === "light" && s.weight >= 0.15 && !s.strokeOnly));
  if (body) {
    body.role = "body";
    body.name = cell ? "Cell" : "Body";
  }
  const area = (b) => (b ? b.w * b.h : 0);
  // the body's extent; a body drawn only in shades of other parts falls back to all of them, then the viewBox
  const ref = body?.ext || union(info.map((s) => s.ext).filter(Boolean)) || { x: vx, y: vy, w: vw, h: vh };
  // how far a part's shapes sit from the body's centre (0 centre, 1 its edge)
  const edge = (s) => {
    if (!s.shapes.length) return 0;
    const cx = ref.x + ref.w / 2, cy = ref.y + ref.h / 2;
    const d = s.shapes.map((b) => Math.hypot((b.x + b.w / 2 - cx) / (ref.w / 2 || 1), (b.y + b.h / 2 - cy) / (ref.h / 2 || 1))).sort((a, b) => a - b);
    return d[d.length >> 1];
  };
  const darker = (s, by) => !!body && s !== body && s.L < body.L - by;
  const hueNear = (s, t, deg) => s.C < 0.03 || Math.abs(((s.H - t.H + 540) % 360) - 180) < deg;
  const sameShading = (s, t) => !!t && [...s.grads].some((g) => t.grads.has(g));
  // rims: a darker part drawn as large as the body, behind it (curve control points can inflate the
  // body's box past the drawing, so the viewBox caps the size to reach)
  for (const s of chrom) {
    if (darker(s, 0.08) && s.n <= 4 && s.big && s.big.w >= Math.min(ref.w, vw) * 0.85 && s.big.h >= Math.min(ref.h, vh) * 0.85) {
      s.name = "Outline";
      s.role = "rim";
    }
  }
  const bluish = (s) => s.H > 230 && s.H < 345;
  // the nucleus: a darker, roundish blob (or a few lobes) inside the body; purple/blue, or any hue in a cell
  let nucleus = heaviest(chrom.filter((s) => !s.name && darker(s, 0.04) && s.n >= 1 && s.n <= 6 && s.big && s.C > 0.02 &&
    (cell || bluish(s)) && edge(s) < 0.75 &&
    s.aspect > (bluish(s) ? 0.3 : 0.5) && s.aspect < (bluish(s) ? 3.3 : 2) &&
    area(s.big) > area(ref) * (bluish(s) ? 0.003 : 0.03) && area(s.big) < area(ref) * 0.75));
  if (nucleus) {
    // a nucleus drawn as a fill with a darker rim of the same size: the darker one is its outline
    const twin = chrom.find((s) => s !== nucleus && s !== body && !s.name && s.big && iou(s.big, nucleus.big) > 0.5);
    if (twin) {
      const [fill, rim] = twin.L > nucleus.L ? [twin, nucleus] : [nucleus, twin];
      rim.name = "Nucleus outline";
      nucleus = fill;
    }
    nucleus.name = "Nucleus";
  }
  // lighter shades of the body (or nucleus): in its gradient, or a same-hue patch on it
  for (const s of chrom) {
    if (s.name || !body || s === body || s.L < body.L + 0.06) continue;
    const onBody = s.n <= 2 && s.shapes.length && s.shapes.every((b) => b.x >= ref.x - 1 && b.y >= ref.y - 1 && b.x + b.w <= ref.x + ref.w + 1 && b.y + b.h <= ref.y + ref.h + 1);
    if (sameShading(s, body) || sameShading(s, nucleus) || (onBody && hueNear(s, body, 25) && s.C <= Math.max(0.06, body.C * 0.8))) {
      s.name = "Highlights";
      s.role = "light";
    }
  }
  for (const s of info) {
    if (s.name) continue;
    if (s.kind !== "color") s.name = s.kind === "dark" || s.strokeOnly ? "Outline" : "Highlights";
    else if (s.strokeOnly) s.name = "Outline";
    else if (s.n >= 3 && s.median < 0.2) {
      const long = s.aspect > 2.2 || s.aspect < 0.45, dark = body && s.L < body.L + 0.02;
      s.name = cell && dark && long && edge(s) > 0.7 ? "Receptors" : cell && dark && !long && edge(s) < 1 ? "Granules" : "Details";
    } else s.name = `Part ${s.i + 1}`;
  }
  // roles for the presets: chromatic outlines follow the body's hue, other darker parts the nucleus's
  for (const s of info) if (s.strokeOnly && s.kind === "color") s.role = "rim";
  const inner = nucleus || heaviest(chrom.filter((s) => s.role === "neutral" && darker(s, 0.04)));
  if (inner) inner.role = "inner";
  for (const s of chrom) if (s.role === "neutral") s.role = darker(s, 0.04) ? (inner ? "dark" : "inner") : "light";
  // the same name twice gets numbered
  const seen = {};
  for (const s of info) {
    seen[s.name] = (seen[s.name] || 0) + 1;
    if (seen[s.name] > 1) s.name += " " + seen[s.name];
  }
  p = { parts: info, bodyL: body?.L ?? 0.85, innerL: inner?.L ?? 0.5, cell };
  partsCache.set(assetId, p);
  return p;
}

/* ---------- presets ---------- */

// [id, name, body [L, C, H], inner [L, C, H]] in OKLCH: a soft pastel body and a darker, slightly
// more saturated inner part (nucleus), as in BioRender's and Servier's colour styles. Shapes use
// the same hues (shapestyle.js), so a teal box matches a teal cell.
export const STYLES = [
  ["teal", "Teal", [0.85, 0.07, 188], [0.58, 0.1, 194]],
  ["sky", "Sky blue", [0.87, 0.06, 236], [0.6, 0.12, 252]],
  ["peach", "Peach", [0.89, 0.055, 55], [0.68, 0.11, 42]],
  ["coral", "Coral pink", [0.81, 0.1, 18], [0.6, 0.15, 16]],
  ["butter", "Butter yellow", [0.94, 0.085, 98], [0.76, 0.13, 82]],
  ["sage", "Sage green", [0.85, 0.06, 135], [0.6, 0.085, 140]],
  ["lavender", "Lavender", [0.86, 0.06, 300], [0.58, 0.12, 300]],
  ["peach-purple", "Peach and purple", [0.89, 0.055, 55], [0.55, 0.13, 305]],
  ["slate", "Slate teal", [0.66, 0.05, 212], [0.43, 0.06, 220]],
  ["apricot", "Apricot", [0.84, 0.1, 65], [0.66, 0.14, 52]],
  ["mint", "Mint", [0.91, 0.07, 165], [0.66, 0.11, 168]],
  ["grey-blue", "Grey-blue", [0.81, 0.03, 250], [0.56, 0.055, 256]],
  ["rose", "Rose", [0.85, 0.07, 350], [0.6, 0.13, 356]],
  ["purple", "Deep purple", [0.64, 0.11, 305], [0.42, 0.13, 300]],
  ["warm-grey", "Warm grey", [0.84, 0.015, 70], [0.56, 0.02, 60]],
  ["mint-violet", "Mint and violet", [0.91, 0.07, 165], [0.55, 0.13, 290]],
  ["sky-coral", "Sky blue and coral", [0.87, 0.06, 236], [0.65, 0.15, 25]],
  ["butter-teal", "Butter and teal", [0.94, 0.085, 98], [0.56, 0.09, 200]],
  ["lavender-apricot", "Lavender and apricot", [0.86, 0.06, 300], [0.7, 0.13, 55]],
  ["rose-blue", "Rose and blue", [0.85, 0.07, 350], [0.52, 0.12, 258]],
  ["sage-plum", "Sage and plum", [0.85, 0.06, 135], [0.5, 0.11, 335]],
  ["coral-teal", "Coral and teal", [0.81, 0.1, 18], [0.55, 0.09, 195]],
  ["vivid-blue", "Vivid blue", [0.72, 0.13, 250], [0.48, 0.17, 262]],
  ["vivid-red", "Vivid red", [0.68, 0.17, 25], [0.48, 0.17, 22]],
  ["vivid-green", "Vivid green", [0.76, 0.15, 145], [0.52, 0.13, 150]],
  ["vivid-orange", "Vivid orange", [0.78, 0.15, 60], [0.58, 0.16, 45]],
  ["vivid-violet", "Vivid violet", [0.66, 0.16, 300], [0.45, 0.18, 298]],
  ["vivid-magenta", "Vivid magenta", [0.7, 0.18, 345], [0.5, 0.18, 350]],
];
/** Shown before "See more". */
export const PRESETS_FIRST = 10;

/** Per-slot target colours for a two-tone style (null = leave the part as it is). */
export function styleTargets(assetId, asset, [body, inner]) {
  const { parts, bodyL, innerL } = partInfo(assetId, asset);
  // a part only a little darker than the body (a large pale nucleus) stays fairly light
  const span = Math.max(0.02, body[0] - inner[0]);
  const iL = body[0] - clamp((bodyL - innerL) * 1.5, Math.min(0.12, span), span);
  return parts.map((s) => {
    switch (s.role) {
      case "body": return hexL(body);
      case "rim": return hexL([clamp(body[0] - (bodyL - s.L) * 0.9, 0.22, body[0] - 0.15), clamp(body[1] * 1.5, 0.04, 0.16), body[2]]);
      case "inner": return hexL([iL, inner[1], inner[2]]);
      case "dark": return hexL([clamp(iL + (s.L - innerL), 0.22, body[0] - 0.1), inner[1], inner[2]]);
      case "light": return hexL([clamp(body[0] + (s.L - bodyL), Math.min(0.96, body[0] - 0.05), 0.98), body[1] * 0.8, body[2]]);
      default: return null;
    }
  });
}

/** A colour map's visible changes, for comparing presets. */
const mapKey = (m) => JSON.stringify(Object.entries(m || {}).filter(([k, v]) => k !== v.toLowerCase()).sort());

const presetCache = new Map();

/**
 * The colour styles offered for an icon: Original, the hue styles and greyscale, each
 * {id, name, map, targets?, tint?}. Styles that would look the same on this icon are dropped.
 */
export function iconPresets(assetId, asset) {
  let list = presetCache.get(assetId);
  if (list) return list;
  const slots = asset.slots || [];
  list = [{ id: "original", name: "Original", map: {} }];
  const seen = new Set([mapKey({})]);
  const add = (p) => {
    const k = mapKey(p.map);
    if (seen.has(k)) return;
    seen.add(k);
    list.push(p);
  };
  if (slots.length) {
    const styled = STYLES.map(([id, name, b, i]) => {
      const targets = styleTargets(assetId, asset, [b, i]);
      return { id, name, targets, map: slotColorMap(slots, targets) };
    });
    styled.slice(0, PRESETS_FIRST - 2).forEach(add);
    add({ id: "gray", name: "Greyscale", tint: "gray", map: grayMap(slots) });
    styled.slice(PRESETS_FIRST - 2).forEach(add);
  }
  presetCache.set(assetId, list);
  return list;
}

/** The preset an icon shows: its recorded one, "original" when uncoloured, else null. */
export function currentPreset(o) {
  if (o.preset) return o.preset;
  if (!o.tint && !o.slotColors?.some(Boolean) && !Object.keys(o.baseColors || o.colors || {}).length) return "original";
  return null;
}

/** Apply a preset by id (adjustments are reset: a preset is a complete look). False if unknown. */
export function applyPreset(o, id, asset = docAsset(o)) {
  if (!asset) return false;
  const p = iconPresets(o.asset, asset).find((x) => x.id === id) || (id === "gray" ? { id, tint: "gray", map: grayMap(asset.slots || []) } : null);
  const st = !p && STYLES.find((s) => s[0] === id);
  delete o.saturation;
  delete o.lightness;
  delete o.baseColors;
  if (id === "original") {
    o.colors = {};
    o.slotColors = [];
    delete o.tint;
    delete o.preset;
    return true;
  }
  if (!p && !st) return false;
  const targets = p ? p.targets : styleTargets(o.asset, asset, [st[2], st[3]]);
  o.preset = id;
  if (p?.tint) {
    o.tint = p.tint;
    o.slotColors = [];
    o.colors = { ...p.map };
  } else {
    delete o.tint;
    o.slotColors = [...targets];
    o.colors = slotColorMap(asset.slots || [], targets);
  }
  return true;
}

/* ---------- thumbnails ---------- */

const thumbs = new Map(); // key → image URL

/** A standalone SVG of an icon object's drawing in the given colours. */
export function iconSvg(o, asset, map) {
  const parts = iconParts(o, asset);
  const [vx, vy, vw, vh] = parts.vb;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vx} ${vy} ${vw} ${vh}">${iconInner(o.asset, asset, map, "", parts.inner)}</svg>`;
}

/**
 * A thumbnail image URL, cached by `key`: an SVG blob, so the panel can be rebuilt on every edit
 * without parsing the drawings again (the browser keeps the decoded images).
 */
function thumbUrl(o, asset, map, key) {
  let u = thumbs.get(key);
  if (u) return u;
  const svg = iconSvg(o, asset, map);
  u = globalThis.URL?.createObjectURL && globalThis.Blob ? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })) : "data:image/svg+xml," + encodeURIComponent(svg);
  thumbs.set(key, u);
  if (thumbs.size > 400) {
    const [k, old] = thumbs.entries().next().value;
    thumbs.delete(k);
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
  }
  return u;
}

/** The icon in a preset's colours. */
export const presetThumb = (o, asset, preset) => thumbUrl(o, asset, preset.map, `${o.asset}|${o.labels || ""}|${preset.id}`);

/** The icon as an object draws it (its own colours), for the Layers list. */
export const iconThumb = (o, asset) => thumbUrl(o, asset, o.colors || {}, `${o.asset}|${o.labels || ""}|${JSON.stringify(o.colors || {})}`);

/** Overlay swatches (BioRender's quick colours). */
export const OVERLAYS = [
  ["#2e8b57", "Green"], ["#7cc36e", "Light green"], ["#c8389b", "Magenta"], ["#222222", "Black"],
  ["#f0901e", "Orange"], ["#b4532a", "Rust"], ["#d33b3b", "Red"], ["#2f6fd6", "Blue"],
  ["#179c94", "Teal"], ["#f07b6e", "Coral"], ["#6272a4", "Slate blue"], ["#8a5cc9", "Purple"],
];

/** Glow colours for fluorescence figures. */
export const FLUORS = [["#39ff5a", "GFP"], ["#ff3b3b", "RFP / mCherry"], ["#3d7bff", "DAPI"], ["#ffe23d", "YFP"], ["#ff3df0", "Cy5 (false colour)"], ["#3dfcff", "CFP"]];

/** A new glow sized for the object (document px). */
export function defaultGlow(o, color = "#39ff5a") {
  const w = o.w ?? 60, h = o.h ?? 60;
  const s = o.type === "membrane" ? (o.thickness || 10) * 0.8 : Math.min(w, h) * 0.12;
  return { color, size: Math.round(clamp(s, 3, 24) * 10) / 10 };
}
export const canGlow = (o) => o.type === "icon" || o.type === "rect" || o.type === "ellipse" || o.type === "membrane";
