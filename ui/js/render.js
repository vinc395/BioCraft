// Object → SVG markup. The same markup is used on the canvas and in exported files, so what
// you see is exactly what the PNG/PDF renderer (resvg/svg2pdf) receives.

import { bbox, ctrlPt, docPx, isBox, moveObj, isElbow, elbowPts, MM } from "./model.js";
import { esc, clamp, rotPt } from "./util.js";
import { brushMarkup, brushKind } from "./brush.js";
import { hasLabels, labelInfo } from "./labels.js";
import { HEADS, TRIM, head, headSize, dashArray } from "./heads.js";

export { HEADS, dashArray };

/* Lines, membranes and groups are drawn relative to an origin and positioned with a
   translate, so moving them never rebuilds their markup (cheap drags, even for big groups). */
export function objOrigin(o) {
  if (o.type === "line") return [o.x1, o.y1];
  if (o.type === "membrane") return o.pts[0] || [0, 0];
  if (o.type === "group") {
    const b = bbox(o);
    return [b.x, b.y];
  }
  return [0, 0];
}
function relCopy(o) {
  const [ox, oy] = objOrigin(o);
  const c = JSON.parse(JSON.stringify(o));
  moveObj(c, -ox, -oy);
  return c;
}

const n = (v) => (Math.round(v * 1000) / 1000).toString();

/* ---------- icon assets ---------- */

const parsed = new Map(); // asset id → {vb:[x,y,w,h], inner}

export function assetParts(assetId, asset) {
  let p = parsed.get(assetId);
  if (p) return p;
  const svg = asset.svg;
  const open = svg.indexOf(">", svg.indexOf("<svg"));
  const close = svg.lastIndexOf("</svg>");
  const head = svg.slice(0, open);
  const vbm = head.match(/viewBox="([^"]+)"/);
  const vb = vbm ? vbm[1].trim().split(/[\s,]+/).map(Number) : [0, 0, asset.w || 100, asset.h || 100];
  p = { vb, inner: close > open ? svg.slice(open + 1, close) : "" };
  parsed.set(assetId, p);
  return p;
}

/** viewBox and inner markup an icon object draws: labels hidden ("hidden") or moved out as text ("detached"). */
export function iconParts(o, asset) {
  const base = assetParts(o.asset, asset);
  if (!o.labels || !hasLabels(asset)) return base;
  const li = labelInfo(o.asset, asset);
  if (o.labels === "hidden" && li.hiddenInner != null) return { vb: li.hiddenVb, inner: li.hiddenInner };
  if (o.labels === "detached" && li.textlessInner != null) return { vb: base.vb, inner: li.textlessInner };
  return base;
}

const PAINT = /(fill|stroke|stop-color|flood-color|lighting-color)="(#[0-9a-fA-F]{6})"/g;

/** Icon markup with ids made unique per instance and colours mapped. */
export function iconInner(assetId, asset, colors, prefix, inner = assetParts(assetId, asset).inner) {
  let s = inner;
  if (colors && Object.keys(colors).length) {
    s = s.replace(PAINT, (m, attr, hex) => {
      const to = colors[hex.toLowerCase()];
      return to ? `${attr}="${to}"` : m;
    });
  }
  if (prefix && s.includes('id="')) {
    s = s
      .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
      .replace(/(xlink:href|href)="#([^"]+)"/g, `$1="#${prefix}$2"`);
  }
  return s;
}

/* ---------- text ---------- */

const measureCtx = document.createElement("canvas").getContext("2d");

export function fontCss(o, size = o.fontSize) {
  return `${o.italic ? "italic " : ""}${o.bold ? 700 : 400} ${size}px ${o.fontFamily || "Arial"}`;
}

/** Update a text object's w/h from its content. */
export function measureText(o) {
  measureCtx.font = fontCss(o);
  const lines = String(o.text ?? "").split("\n");
  const w = Math.max(...lines.map((l) => measureCtx.measureText(l || " ").width));
  o.w = Math.max(4, w + 2);
  o.h = Math.max(4, lines.length * o.fontSize * (o.lineHeight || 1.25));
}

function textMarkup(o) {
  const fs = o.fontSize, lh = fs * (o.lineHeight || 1.25);
  const anchor = o.align === "center" ? "middle" : o.align === "right" ? "end" : "start";
  const x = o.align === "center" ? o.w / 2 : o.align === "right" ? o.w - 1 : 1;
  const lines = String(o.text ?? "").split("\n");
  let s = `<text font-family="${esc(o.fontFamily || "Arial")}" font-size="${n(fs)}" font-weight="${o.bold ? 700 : 400}" font-style="${o.italic ? "italic" : "normal"}" fill="${o.color || "#1c2733"}" text-anchor="${anchor}" xml:space="preserve" style="white-space:pre">`;
  lines.forEach((ln, i) => {
    s += `<tspan x="${n(x)}" y="${n(i * lh + (lh - fs) / 2 + fs * 0.88)}">${esc(ln) || " "}</tspan>`;
  });
  return s + "</text>";
}

/* ---------- legends & scale bars ---------- */

function textWidth(s, size, bold, family) {
  measureCtx.font = `${bold ? 700 : 400} ${size}px ${family || "Arial"}`;
  return measureCtx.measureText(s || " ").width;
}

/** A text line whose box (one line high) starts at y, as textMarkup draws it. */
function textLine(s, x, y, size, { family = "Arial", bold = false, color = "#1c2733", anchor = "start" } = {}) {
  const lh = size * 1.25;
  return `<text x="${n(x)}" y="${n(y + (lh - size) / 2 + size * 0.88)}" font-family="${esc(family)}" font-size="${n(size)}" font-weight="${bold ? 700 : 400}" fill="${color}"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""} xml:space="preserve" style="white-space:pre">${esc(s || "")}</text>`;
}

/** What a legend row shows: a library icon, a line sample (arrow, inhibition…) or a colour square. */
export const legendRowKind = (r) => (r.asset ? "icon" : r.line ? "line" : "swatch");

/**
 * A legend's natural layout in its own px: rows fill `columns` columns top to bottom, each a swatch
 * (iconSize square) and its label; an optional bold title above; padding when it has a frame.
 * anchor is the point kept still when the content changes (the top-left corner).
 */
export function legendLayout(o) {
  const fs = o.fontSize || 12, S = o.iconSize || fs * 2, fam = o.fontFamily || "Arial";
  const pad = o.border || (o.fill && o.fill !== "none") ? fs * 0.7 : 0;
  const gap = fs * 0.6, rowGap = fs * 0.45, colGap = fs * 1.6, rh = Math.max(S, fs * 1.3);
  const tail = fs * 0.12; // room for a last letter that reaches past its advance (like text objects' margin)
  const rows = o.rows || [];
  const C = clamp(Math.round(o.columns || 1), 1, Math.max(1, rows.length));
  const R = Math.max(1, Math.ceil(rows.length / C));
  const tsize = fs * 1.15, th = o.title ? tsize * 1.25 + fs * 0.45 : 0;
  const colW = [];
  rows.forEach((r, i) => {
    const c = Math.floor(i / R);
    colW[c] = Math.max(colW[c] || 0, S + gap + textWidth(r.label, fs, o.bold, fam) + tail);
  });
  const colX = [];
  colW.reduce((x, w, c) => ((colX[c] = x), x + w + colGap), pad);
  const cells = rows.map((r, i) => {
    const c = Math.floor(i / R);
    return { x: colX[c], y: pad + th + (i % R) * (rh + rowGap), w: colW[c], h: rh };
  });
  const body = colW.length ? colW.reduce((a, b) => a + b, 0) + (colW.length - 1) * colGap : fs * 4;
  const w = 2 * pad + Math.max(body, o.title ? textWidth(o.title, tsize, true, fam) + tail : 0);
  const h = 2 * pad + th + R * rh + (R - 1) * rowGap;
  return { w, h, pad, S, gap, rh, fs, tsize, cells, anchor: [0, 0] };
}

function legendMarkup(o, doc, L) {
  const { S, gap, fs } = L, fam = o.fontFamily || "Arial", color = o.color || "#1c2733";
  let s = "";
  if (L.pad) {
    const sw = o.border ? Math.max(0.5, fs * 0.06) : 0;
    s += `<rect x="${n(sw / 2)}" y="${n(sw / 2)}" width="${n(L.w - sw)}" height="${n(L.h - sw)}" rx="${n(fs * 0.35)}" fill="${o.fill && o.fill !== "none" ? o.fill : "none"}"${sw ? ` stroke="${o.border === true ? "#9aa5b1" : o.border}" stroke-width="${n(sw)}"` : ""}/>`;
  }
  if (o.title) s += textLine(o.title, L.pad, L.pad, L.tsize, { family: fam, bold: true, color });
  (o.rows || []).forEach((r, i) => {
    const c = L.cells[i], cy = c.y + c.h / 2;
    const kind = legendRowKind(r);
    if (kind === "icon") {
      const asset = doc?.assets?.[r.asset];
      if (!asset) s += `<rect x="${n(c.x)}" y="${n(cy - S / 2)}" width="${n(S)}" height="${n(S)}" fill="#f3d6d6" stroke="#c0392b"/>`;
      else {
        const parts = iconParts({ asset: r.asset, labels: r.labels }, asset);
        const [vx, vy, vw, vh] = parts.vb, k = Math.min(S / vw, S / vh);
        s += `<g transform="translate(${n(c.x + (S - vw * k) / 2 - vx * k)} ${n(cy - (vh * k) / 2 - vy * k)}) scale(${n(k)})">${iconInner(r.asset, asset, r.colors, `${o.id}-r${i}-`, parts.inner)}</g>`;
      }
    } else if (kind === "line") {
      const sw = Math.max(1, fs * 0.13), hs = headSize(sw), col = r.color || "#2b3440";
      const x0 = c.x + sw, x1 = c.x + S - sw, hd = r.line.head || "none";
      s += `<path d="M${n(x0)} ${n(cy)}L${n(x1 - hs * (TRIM[hd] ?? 0))} ${n(cy)}" stroke="${col}" stroke-width="${n(sw)}" fill="none" stroke-linecap="${r.line.dash ? "butt" : "round"}"${r.line.dash ? ` stroke-dasharray="${dashArray(r.line.dash, sw)}"` : ""}/>` + head(hd, [x1, cy], [1, 0], hs, col, sw);
    } else {
      const q = Math.min(S, fs * 1.2);
      s += `<rect x="${n(c.x + (S - q) / 2)}" y="${n(cy - q / 2)}" width="${n(q)}" height="${n(q)}" rx="${n(q * 0.14)}" fill="${r.color || "#4aa9d0"}" stroke="#000000" stroke-opacity="0.18" stroke-width="${n(Math.max(0.5, fs * 0.05))}"/>`;
    }
    s += textLine(r.label, c.x + S + gap, cy - (fs * 1.25) / 2, fs, { family: fam, bold: o.bold, color });
  });
  return s;
}

/** A scale bar's label, e.g. "10 µm". */
export const scaleLabel = (o) => `${+(+o.value || 0).toFixed(3)} ${o.unit || "µm"}`;

/** A scale bar's natural layout: the bar centred under (or over) its label; anchor = the bar's middle. */
export function scalebarLayout(o) {
  const fs = o.fontSize || 12, T = o.thickness ?? 3, len = o.length ?? 15 * MM, pos = o.labelPos || "above";
  const lw = pos === "none" ? 0 : textWidth(scaleLabel(o), fs, o.bold, o.fontFamily) + fs * 0.24; // centred, with a little room each side
  const lh = pos === "none" ? 0 : fs * 1.25, gap = pos === "none" ? 0 : Math.max(1, fs * 0.2);
  const w = Math.max(len, lw), h = T + gap + lh;
  const barY = pos === "above" ? lh + gap : 0;
  return { w, h, fs, bar: { x: (w - len) / 2, y: barY, w: len, h: T }, labelY: pos === "none" ? null : pos === "above" ? 0 : T + gap, anchor: [w / 2, barY + T / 2] };
}

function scalebarMarkup(o, L) {
  const color = o.color || "#1c2733", b = L.bar;
  let s = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="${color}"/>`;
  if (L.labelY != null) s += textLine(scaleLabel(o), L.w / 2, L.labelY, L.fs, { family: o.fontFamily || "Arial", bold: o.bold, color, anchor: "middle" });
  return s;
}

export const furnitureLayout = (o) => (o.type === "legend" ? legendLayout(o) : scalebarLayout(o));

/** The document point a legend or scale bar keeps still while its content changes (see layouts' anchor). */
export function furnitureAnchor(o) {
  const L = furnitureLayout(o), cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  return rotPt(cx + L.anchor[0] - L.w / 2, cy + L.anchor[1] - L.h / 2, cx, cy, o.rot || 0);
}

/** Size a legend or scale bar to its content; with `at` (from furnitureAnchor, taken before the change) its anchor stays there. */
export function fitFurniture(o, at = null) {
  const L = furnitureLayout(o);
  o.w = Math.max(1, L.w);
  o.h = Math.max(1, L.h);
  if (at) {
    const [dx, dy] = rotPt(L.anchor[0] - L.w / 2, L.anchor[1] - L.h / 2, 0, 0, o.rot || 0);
    o.x = at[0] - dx - o.w / 2;
    o.y = at[1] - dy - o.h / 2;
  }
  return o;
}

/**
 * Which legend row (index) a document point is on, or -1; for double-click editing. The drawing
 * sits centred in the object's box.
 */
export function legendRowAt(o, [px, py]) {
  const L = legendLayout(o), cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const [lx, ly] = rotPt(px, py, cx, cy, -(o.rot || 0));
  const x = lx - (cx - L.w / 2), y = ly - (cy - L.h / 2);
  return L.cells.findIndex((c) => x >= c.x - 2 && x <= c.x + c.w + 2 && y >= c.y - 2 && y <= c.y + c.h + 2);
}

/* ---------- lines & arrowheads ---------- */

/** An elbow line: right-angled segments with slightly rounded corners, heads on the end segments. */
function elbowMarkup(o, sw, color, s) {
  // drop zero-length segments (a bend at an end gives an L, both ends in line a straight line)
  const pts = elbowPts(o).filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 0.01);
  if (pts.length < 2) pts.push([o.x2, o.y2]);
  const unit = (a, b) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const k = pts.length - 1;
  const dEnd = unit(pts[k - 1], pts[k]), dStart = unit(pts[1], pts[0]);
  const segLen = (i) => Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const tS = Math.min(s * (TRIM[o.startHead] ?? 0), segLen(0) * 0.9), tE = Math.min(s * (TRIM[o.endHead] ?? 0), segLen(k - 1) * 0.9);
  const body = pts.map((p) => [p[0], p[1]]);
  body[0] = [pts[0][0] - dStart[0] * tS, pts[0][1] - dStart[1] * tS];
  body[k] = [pts[k][0] - dEnd[0] * tE, pts[k][1] - dEnd[1] * tE];
  let d = `M${n(body[0][0])} ${n(body[0][1])}`;
  for (let i = 1; i < k; i++) {
    // a small round at each corner, never more than half the shorter neighbouring segment
    const r = Math.min(sw * 1.5 + 2, segLen(i - 1) / 2, segLen(i) / 2);
    const a = unit(body[i], body[i - 1]), b = unit(body[i], body[i + 1]);
    d += `L${n(body[i][0] + a[0] * r)} ${n(body[i][1] + a[1] * r)}Q${n(body[i][0])} ${n(body[i][1])} ${n(body[i][0] + b[0] * r)} ${n(body[i][1] + b[1] * r)}`;
  }
  d += `L${n(body[k][0])} ${n(body[k][1])}`;
  const out = `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(sw)}" stroke-linecap="${o.dash ? "butt" : "round"}" stroke-linejoin="round"${o.dash ? ` stroke-dasharray="${dashArray(o.dash, sw)}"` : ""}/>` +
    head(o.endHead, pts[k], dEnd, s, color, sw) + head(o.startHead, pts[0], dStart, s, color, sw);
  return { d, out };
}

function lineMarkup(o, hit) {
  const sw = o.strokeWidth ?? 2, color = o.stroke || "#2b3440";
  const s = headSize(sw, o.headScale);
  if (isElbow(o)) {
    const { d, out } = elbowMarkup(o, sw, color, s);
    return out + (hit ? `<path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="${n(Math.max(12, sw + 10))}"/>` : "");
  }
  const [cx, cy] = ctrlPt(o);
  const curved = Math.abs(o.curve || 0) > 0.01;
  const dir = (ax, ay, bx, by) => {
    const l = Math.hypot(bx - ax, by - ay) || 1;
    return [(bx - ax) / l, (by - ay) / l];
  };
  // tangent directions pointing *into* each end
  const dEnd = curved ? dir(cx, cy, o.x2, o.y2) : dir(o.x1, o.y1, o.x2, o.y2);
  const dStart = curved ? dir(cx, cy, o.x1, o.y1) : dir(o.x2, o.y2, o.x1, o.y1);
  const tS = s * (TRIM[o.startHead] ?? 0), tE = s * (TRIM[o.endHead] ?? 0);
  const sx = o.x1 - dStart[0] * tS, sy = o.y1 - dStart[1] * tS;
  const ex = o.x2 - dEnd[0] * tE, ey = o.y2 - dEnd[1] * tE;
  const d = curved ? `M${n(sx)} ${n(sy)}Q${n(cx)} ${n(cy)} ${n(ex)} ${n(ey)}` : `M${n(sx)} ${n(sy)}L${n(ex)} ${n(ey)}`;
  let out = `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(sw)}" stroke-linecap="${o.dash ? "butt" : "round"}"${o.dash ? ` stroke-dasharray="${dashArray(o.dash, sw)}"` : ""}/>`;
  out += head(o.endHead, [o.x2, o.y2], dEnd, s, color, sw) + head(o.startHead, [o.x1, o.y1], dStart, s, color, sw);
  if (hit) out += `<path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="${n(Math.max(12, sw + 10))}"/>`;
  return out;
}

/* ---------- objects ---------- */

/** Local-space content of an object (box objects are drawn in [0,w]×[0,h]; icons in their viewBox). */
export function contentMarkup(o, doc, hit = false) {
  if (!isBox(o)) o = relCopy(o);
  switch (o.type) {
    case "icon": {
      const asset = doc.assets[o.asset];
      if (!asset) return `<rect width="${n(o.w)}" height="${n(o.h)}" fill="#f3d6d6" stroke="#c0392b"/>`;
      const parts = iconParts(o, asset);
      const [vx, vy, vw, vh] = parts.vb;
      const inner = iconInner(o.asset, asset, o.colors, o.id + "-", parts.inner);
      return `<g transform="translate(${n(-vx)} ${n(-vy)})">${inner}</g>` + (hit ? `<rect class="hit" width="${n(vw)}" height="${n(vh)}" fill="transparent"/>` : "");
    }
    case "text":
      return textMarkup(o) + (hit ? `<rect class="hit" width="${n(o.w)}" height="${n(o.h)}" fill="transparent"/>` : "");
    case "rect": {
      const sw = o.stroke && o.stroke !== "none" ? o.strokeWidth ?? 1.5 : 0;
      return `<rect width="${n(o.w)}" height="${n(o.h)}" rx="${n(Math.min(o.radius || 0, o.w / 2, o.h / 2))}" fill="${o.fill || "none"}"${sw ? ` stroke="${o.stroke}" stroke-width="${n(sw)}"` : ""}${o.dash && sw ? ` stroke-dasharray="${dashArray(o.dash, sw)}"` : ""}/>` + (hit && (!o.fill || o.fill === "none") ? `<rect class="hit" width="${n(o.w)}" height="${n(o.h)}" fill="none" stroke="transparent" stroke-width="10"/>` : "");
    }
    case "ellipse": {
      const sw = o.stroke && o.stroke !== "none" ? o.strokeWidth ?? 1.5 : 0;
      return `<ellipse cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" rx="${n(o.w / 2)}" ry="${n(o.h / 2)}" fill="${o.fill || "none"}"${sw ? ` stroke="${o.stroke}" stroke-width="${n(sw)}"` : ""}${o.dash && sw ? ` stroke-dasharray="${dashArray(o.dash, sw)}"` : ""}/>` + (hit && (!o.fill || o.fill === "none") ? `<ellipse class="hit" cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" rx="${n(o.w / 2)}" ry="${n(o.h / 2)}" fill="none" stroke="transparent" stroke-width="10"/>` : "");
    }
    case "image":
      return `<image width="${n(o.w)}" height="${n(o.h)}" preserveAspectRatio="none" xlink:href="${o.src}"/>`;
    case "legend":
    case "scalebar": {
      // drawn at its natural size, centred in the box (fitFurniture keeps the two the same)
      const L = furnitureLayout(o);
      const inner = o.type === "legend" ? legendMarkup(o, doc, L) : scalebarMarkup(o, L);
      const dx = (o.w - L.w) / 2, dy = (o.h - L.h) / 2;
      // (a thin scale bar without a label gets a wider click area)
      return (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3 ? `<g transform="translate(${n(dx)} ${n(dy)})">${inner}</g>` : inner) +
        (hit ? `<rect class="hit" width="${n(o.w)}" height="${n(o.h)}" fill="transparent"${o.type === "scalebar" ? ' stroke="transparent" stroke-width="8"' : ""}/>` : "");
    }
    case "line":
      return lineMarkup(o, hit);
    case "membrane": {
      // icon brushes repeat a library icon along the path
      let icon = null;
      if (brushKind(o) === "icon" && o.asset && doc.assets[o.asset]) {
        const asset = doc.assets[o.asset];
        const parts = assetParts(o.asset, asset);
        icon = { vb: parts.vb, prefix: o.id + "-", inner: iconInner(o.asset, asset, o.colors, o.id + "-", parts.inner) };
      }
      return brushMarkup(o, hit, icon);
    }
    case "group":
      return o.children.map((c) => objectMarkup(c, doc, hit)).join("");
    default:
      return "";
  }
}

/** Transform attribute for box objects (icons also map their viewBox onto w×h). */
export function objTransform(o, doc) {
  if (!isBox(o)) {
    const [ox, oy] = objOrigin(o);
    return ox || oy ? `translate(${n(ox)} ${n(oy)})` : "";
  }
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  let t = `translate(${n(cx)} ${n(cy)})`;
  if (o.rot) t += ` rotate(${n(o.rot)})`;
  if (o.flipX || o.flipY) t += ` scale(${o.flipX ? -1 : 1} ${o.flipY ? -1 : 1})`;
  t += ` translate(${n(-o.w / 2)} ${n(-o.h / 2)})`;
  if (o.type === "icon") {
    const asset = doc.assets[o.asset];
    if (asset) {
      const [, , vw, vh] = iconParts(o, asset).vb;
      t += ` scale(${n(o.w / vw)} ${n(o.h / vh)})`;
    }
  }
  return t;
}

/** Content key: when it changes, the canvas rebuilds an object's inner markup. */
export function contentKey(o) {
  if (o.type === "icon") return "i" + o.asset + (o.labels || "") + JSON.stringify(o.colors || {});
  if (o.type === "image") return "m" + o.src.length + o.src.slice(-40) + o.w + o.h;
  if (!isBox(o)) {
    const { opacity, name, locked, hidden, ...rest } = relCopy(o);
    return JSON.stringify(rest);
  }
  const { x, y, rot, flipX, flipY, opacity, name, locked, hidden, ...rest } = o;
  return JSON.stringify(rest);
}

/* ---------- glow ---------- */

/** Filter id of an object's glow (unique per object; copies get fresh ids). */
export const glowId = (o) => "bcglow-" + o.id;

/** How far a glow reaches past the object's bounds (document px). */
export const glowReach = (g) => (g ? Math.max(0.5, +g.size || 6) * 1.6 + 2 : 0);

/**
 * Glow (fluorescence, e.g. GFP) as an SVG filter: the object's alpha, blurred and strengthened, is
 * flooded with the glow colour. The filter region is in the document coordinates of the object's
 * outer group (bounds plus the glow's reach), so it never clips. With `merge` the object is drawn
 * on top inside the filter (the canvas); without, the filter gives the glow alone (exports, see
 * objectMarkup).
 */
export function glowFilter(o, merge = false) {
  const g = o.glow, s = Math.max(0.5, +g.size || 6), b = bbox(o), p = glowReach(g);
  return `<filter id="${glowId(o)}" filterUnits="userSpaceOnUse" x="${n(b.x - p)}" y="${n(b.y - p)}" width="${n(b.w + 2 * p)}" height="${n(b.h + 2 * p)}" color-interpolation-filters="sRGB">` +
    `<feGaussianBlur in="SourceAlpha" stdDeviation="${n(s / 2)}" result="b"/>` +
    `<feComponentTransfer in="b" result="a"><feFuncA type="linear" slope="1.7"/></feComponentTransfer>` +
    `<feFlood flood-color="${g.color || "#39ff5a"}" result="c"/>` +
    `<feComposite in="c" in2="a" operator="in" result="glow"/>` +
    (merge ? `<feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>` : "") + `</filter>`;
}

/** Bounds of what objects draw, including effects that reach past their geometry (glow). */
export function visualBox(objs) {
  const pad = (o) => Math.max(o.glow && !o.hidden ? glowReach(o.glow) : 0, ...(o.children || []).map(pad));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objs) {
    const b = bbox(o), p = pad(o);
    x0 = Math.min(x0, b.x - p);
    y0 = Math.min(y0, b.y - p);
    x1 = Math.max(x1, b.x + b.w + p);
    y1 = Math.max(y1, b.y + b.h + p);
  }
  return x1 >= x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

export function objectMarkup(o, doc, hit = false) {
  if (o.hidden) return "";
  const t = objTransform(o, doc);
  const op = o.opacity != null && o.opacity < 1 ? ` opacity="${n(o.opacity)}"` : "";
  if (!o.glow) return `<g${t ? ` transform="${t}"` : ""}${op}>${contentMarkup(o, doc, hit)}</g>`;
  // the glow is a filtered copy (ids renamed) under the object, on an untransformed wrapper so the
  // filter region is in document px; only the copy is filtered, so PDF export (which rasterises
  // filtered groups) keeps the object itself as vectors
  const copy = `<g${t ? ` transform="${t}"` : ""}>${contentMarkup({ ...o, id: o.id + "-glow" }, doc, false)}</g>`;
  return `<g${op}><defs>${glowFilter(o)}</defs><g filter="url(#${glowId(o)})">${copy}</g><g${t ? ` transform="${t}"` : ""}>${contentMarkup(o, doc, hit)}</g></g>`;
}

/** The whole figure as a standalone SVG (mm-sized for print). */
export function documentSvg(doc, { objects = doc.objects, crop = null, background = doc.background } = {}) {
  const { w, h } = docPx(doc);
  const vb = crop || { x: 0, y: 0, w, h };
  const mmw = vb.w / (96 / 25.4), mmh = vb.h / (96 / 25.4);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(mmw)}mm" height="${n(mmh)}mm" viewBox="${n(vb.x)} ${n(vb.y)} ${n(vb.w)} ${n(vb.h)}">`;
  s += `<title>BioCraft figure</title>`;
  if (background) s += `<rect x="${n(vb.x)}" y="${n(vb.y)}" width="${n(vb.w)}" height="${n(vb.h)}" fill="${background}"/>`;
  for (const o of objects) s += objectMarkup(o, doc, false);
  return s + "</svg>";
}
