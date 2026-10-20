// Turns a recipe's scene into VectorCraft drawing commands, in two house styles:
//   soft — Servier-like: pastel fills, a darker rim on the shadow side, a light crescent and a
//          gloss spot on the lit side (light from the top left), no outlines.
//   line — NIH BioArt-like: flat, lighter fills with a dark outline in the part's own hue.
// Crescents and gloss spots are cut with VectorCraft's exact path booleans, so the output is
// plain filled paths that recolour cleanly (shades stay in the part's hue family).

import { parseHex, toHex, toLch, fromLch } from "../../ui/js/color.js";

/* ---------- colour ---------- */

const lch = (hex) => toLch(parseHex(hex));
const hex = (L, C, H) => toHex(fromLch(L, C, H));
export const shade = (c, a = 0.1) => { const [L, C, H] = lch(c); return hex(L - a, C * 1.08, H); };
export const tint = (c, a = 0.1) => { const [L, C, H] = lch(c); return hex(Math.min(0.97, L + a), C * 0.7, H); };
export const outline = (c) => { const [L, C, H] = lch(c); return hex(Math.min(L * 0.55, 0.36), Math.min(C * 0.75, 0.08), H); };
export const flat = (c) => { const [L, C, H] = lch(c); return hex(L + (1 - L) * 0.18, C * 0.85, H); };

/* ---------- path bounds (absolute M L H V C Q Z only, as geom.mjs writes them) ---------- */

export function pathBox(d) {
  const ds = Array.isArray(d) ? d : [d];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of ds) {
    let cx = 0, cy = 0;
    const toks = s.match(/[MLHVCQZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
    let cmd = "M";
    for (let i = 0; i < toks.length; ) {
      if (/[a-z]/i.test(toks[i])) {
        cmd = toks[i++].toUpperCase();
        if (cmd === "Z") continue;
      }
      const take = (k) => toks.slice(i, (i += k)).map(Number);
      const add = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
      if (cmd === "M" || cmd === "L") { [cx, cy] = take(2); add(cx, cy); }
      else if (cmd === "H") { [cx] = take(1); add(cx, cy); }
      else if (cmd === "V") { [cy] = take(1); add(cx, cy); }
      else if (cmd === "C") { const v = take(6); add(v[0], v[1]); add(v[2], v[3]); [cx, cy] = [v[4], v[5]]; add(cx, cy); }
      else if (cmd === "Q") { const v = take(4); add(v[0], v[1]); [cx, cy] = [v[2], v[3]]; add(cx, cy); }
      else i++;
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Bounding boxes of each subpath ("M…" run) of path data or of each `unite` member. */
function subBoxes(part) {
  const list = part.unite ? part.unite : String(part.d).split(/(?=M)/).filter((s) => s.trim());
  return list.map((d) => pathBox(d)).filter((b) => Number.isFinite(b.w));
}

/** Many separate shapes (granules, cells) rather than overlapping pieces of one shape (lobed nucleus). */
function isScattered(part) {
  const boxes = subBoxes(part);
  if (boxes.length < 2) return false;
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const sum = boxes.reduce((a, b) => a + b.w * b.h, 0);
  return sum < (x1 - x0) * (y1 - y0) * 0.45;
}

/** Size used to scale shading: the median size of the shapes in the part (not their union). */
function typicalSize(part) {
  const sizes = subBoxes(part).map((b) => Math.max(b.w, b.h)).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
}

/* ---------- drawing ---------- */

async function opaque(vc, ids, opacity) {
  if (opacity != null && opacity < 1) await vc.cmd("transparency.set", { ids, opacity: Math.round(opacity * 100) });
}

/** Draw one shape (a path, or the union of several) and return its id. */
async function shape(vc, part, fill, stroke = null) {
  const sw = stroke ? stroke.width : 0;
  const base = { fill: fill || "none", stroke: stroke ? stroke.color : "none", ...(sw ? { strokeWidth: sw } : {}) };
  if (part.unite) {
    const ids = [];
    for (const d of part.unite) ids.push((await vc.tool("draw_path", { d, ...base })).id);
    const r = await vc.tool("pathfinder", { operation: "unite", ids });
    return r.ids[0];
  }
  return (await vc.tool("draw_path", { d: part.d, ...base })).id;
}

async function strokeStyle(vc, id, stroke) {
  if (!stroke) return;
  await vc.cmd("stroke.set", { ids: [id], weight: stroke.width, cap: stroke.cap || "round", join: stroke.join || "round", ...(stroke.dash ? { dash: stroke.dash } : {}) });
}

/**
 * (shape scaled by `inset`%) − (the same, moved by dx,dy): a crescent hugging the edge opposite
 * the move, set `inset` inside the outline. inset 100 → the crescent touches the outline (a rim).
 */
async function crescent(vc, part, fill, dx, dy, inset, opacity) {
  const a = await shape(vc, part, fill);
  const b = await shape(vc, part, fill);
  if (inset !== 100) await vc.tool("transform", { ids: [a, b], scale: inset });
  await vc.tool("transform", { ids: [b], dx, dy });
  const r = await vc.tool("pathfinder", { operation: "minusFront", ids: [a, b] });
  const ids = r.ids || [];
  await opaque(vc, ids, opacity);
  return ids;
}

/** Specular dots (Servier-style): one oval and one tiny dot near the lit edge, clipped to the shape. */
async function gloss(vc, part, box, size, opacity = 0.75) {
  const s = Math.max(box.w, box.h);
  const at = part.glossAt || [0.27, 0.24];
  const spots = [
    [box.x + box.w * at[0], box.y + box.h * at[1], s * size, s * size * 0.62],
    [box.x + box.w * (at[0] + 0.1), box.y + box.h * (at[1] - 0.045), s * size * 0.38, s * size * 0.38],
  ];
  for (const [cx, cy, rx, ry] of spots) {
    const g = (await vc.tool("draw_shape", { shape: "ellipse", x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry, fill: "#ffffff", stroke: "none" })).id;
    await vc.tool("transform", { ids: [g], rotate: 38 });
    const c = await shape(vc, part, "#ffffff");
    const r = await vc.tool("pathfinder", { operation: "intersect", ids: [c, g] });
    await opaque(vc, r.ids || [], opacity);
  }
}

const SHADE = {
  // rim: dark crescent on the shadow side; hi: light band inside the lit edge; gloss: dot size
  body: { rim: 0.032, rimDark: 0.09, hi: 0.05, hiInset: 88, hiLight: 0.1, hiAlpha: 0.85, gloss: 0.05 },
  organelle: { rim: 0.04, rimDark: 0.1, hi: 0.06, hiInset: 84, hiLight: 0.12, hiAlpha: 0.8, gloss: 0.045 },
  small: { rim: 0.12, rimDark: 0.1 },
  rim: { rim: 0.045, rimDark: 0.12 },
  // a hollow (biconcave centre, well, pit): shadow on the lit side, light on the far side
  dip: { rim: -0.07, rimDark: 0.1, hi: -0.06, hiInset: 100, hiLight: 0.08, hiAlpha: 0.7 },
};

async function drawSoftPart(vc, part) {
  const ds = Array.isArray(part.d) && !part.unite ? part.d : [part.d];
  for (const d of ds) {
    const p = part.unite ? part : { ...part, d };
    const stroke = part.stroke ? { ...part.stroke, color: part.stroke.color || shade(part.fill || "#888888", 0.25) } : null;
    const id = await shape(vc, p, part.fill === "none" ? null : part.fill, stroke);
    await strokeStyle(vc, id, stroke);
    await opaque(vc, [id], part.opacity);
    const lv = SHADE[part.shade];
    if (!lv || !part.fill || part.fill === "none") continue;
    const box = pathBox(part.unite || d);
    const many = isScattered(p);
    // offsets scale with each shape's own size; a compound of many granules shades each one
    const s = many ? typicalSize(p) : Math.max(box.w, box.h);
    const op = part.opacity ?? 1;
    if (lv.rim) await crescent(vc, p, shade(part.fill, lv.rimDark), -lv.rim * s, -lv.rim * s, 100, op);
    // inset highlights scale about the whole compound's centre, so only single shapes get them
    if (lv.hi && part.highlight !== false && !many) await crescent(vc, p, tint(part.fill, lv.hiLight), lv.hi * s, lv.hi * s, lv.hiInset, op * lv.hiAlpha);
    if (lv.gloss && part.gloss !== false && !many) await gloss(vc, p, box, part.glossSize ?? lv.gloss, 0.8 * op);
  }
}

async function drawLinePart(vc, part, lineW) {
  const ds = Array.isArray(part.d) && !part.unite ? part.d : [part.d];
  for (const d of ds) {
    const p = part.unite ? part : { ...part, d };
    if (part.stroke && (!part.fill || part.fill === "none")) {
      const st = { ...part.stroke, color: part.lineColor || outline(part.stroke.color || "#555555"), width: part.lineStrokeWidth ?? part.stroke.width };
      const id = await shape(vc, p, null, st);
      await strokeStyle(vc, id, st);
      continue;
    }
    const w = part.lineWidth ?? (part.shade === "small" || part.thin ? lineW * 0.7 : lineW);
    const st = { color: part.lineColor || outline(part.fill), width: w };
    const id = await shape(vc, p, flat(part.fill), st);
    await strokeStyle(vc, id, st);
    await opaque(vc, [id], part.opacity);
  }
}

/**
 * Render `scene` ({size:[w,h], parts:[…]}) in `style` into a fresh VectorCraft document.
 * Part fields: d (string or array of strings) | unite (array → one shape), fill, stroke {color,width,cap,dash},
 *              shade: body|organelle|small|rim, opacity, gloss:false, soft:false (skip in soft), line:false (skip in line).
 */
export async function renderScene(vc, scene, style) {
  const [w, h] = scene.size || [200, 200];
  await vc.cmd("file.new", { width: w, height: h });
  const lineW = scene.lineWidth ?? Math.max(w, h) / 120;
  for (const part of scene.parts) {
    if (style === "soft" && part.soft === false) continue;
    if (style === "line" && part.line === false) continue;
    if (style === "soft") await drawSoftPart(vc, part);
    else await drawLinePart(vc, part, lineW);
  }
}
