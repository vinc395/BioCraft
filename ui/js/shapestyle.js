// Ready-made colour styles for shapes (rectangles, ellipses and freeform shapes), offered as soon as
// a shape is selected: in the Design panel and from the quick toolbar's Style button. They use the
// icon colour styles' hues (style.js), so a teal box matches a teal cell: a soft pastel fill with a
// darker outline of the same hue (Servier's and BioRender's look), two-tone and vivid fills,
// outlines, dashed regions and neutrals. A style sets the fill, the outline colour and the line
// style; the outline width, corner radius and transparency stay as they are.

import { commit, onPreviewEnd } from "./model.js";
import { renderDoc } from "./canvas.js";
import { STYLES } from "./style.js";
import { toHex, fromLch, normHex } from "./color.js";
import { BRUSHES, brushKind, smoothPolyline } from "./brush.js";
import { el } from "./util.js";

/** Rectangles, ellipses and freeform shapes: the objects shape styles apply to. */
export const isShape = (o) => o.type === "rect" || o.type === "ellipse" || (o.type === "membrane" && brushKind(o) === "freeform");

const hexL = ([L, C, H]) => toHex(fromLch(L, C, H));
const HUE = Object.fromEntries(STYLES.map(([id, name, body, inner]) => [id, { name, body, inner }]));
const P = (id, name, fill, stroke, dash = "") => ({ id, name, fill, stroke, dash });
/** The icon style's body colour as the fill, its inner (nucleus) colour as the outline. */
const soft = (k) => P(k, HUE[k].name, hexL(HUE[k].body), hexL(HUE[k].inner));
const outline = (k, name) => P(k + "-outline", name, null, hexL(HUE[k].inner));
const region = (k, name) => P(k + "-region", name, hexL([0.96, HUE[k].body[1] * 0.45, HUE[k].body[2]]), hexL(HUE[k].inner), "dash");

/** Shown before "See more". */
export const SHAPE_PRESETS_FIRST = 10;

export const SHAPE_PRESETS = [
  ...["teal", "sky", "peach", "coral", "butter", "sage", "lavender", "rose", "grey-blue"].map(soft),
  P("white", "White card", "#ffffff", "#b8c0cc"),
  ...["mint", "apricot", "slate", "purple", "warm-grey"].map(soft),
  ...["vivid-blue", "vivid-red", "vivid-green", "vivid-orange", "vivid-violet", "vivid-magenta"].map(soft),
  ...["peach-purple", "mint-violet", "sky-coral", "butter-teal", "lavender-apricot", "rose-blue", "sage-plum", "coral-teal"].map(soft),
  outline("teal", "Teal outline"), outline("vivid-blue", "Blue outline"), outline("vivid-red", "Red outline"),
  outline("vivid-green", "Green outline"), outline("purple", "Purple outline"),
  P("charcoal-outline", "Charcoal outline", null, "#3a4452"),
  P("grey-region", "Dashed region, grey", null, "#8a94a3", "dash"),
  region("teal", "Dashed region, teal"), region("coral", "Dashed region, coral"),
  P("light-grey", "Light grey, no outline", "#e4e8ed", null),
  P("charcoal", "Charcoal, no outline", "#3a4452", null),
];

const paintKey = (c) => (c && c !== "none" ? normHex(c) : null);

/** The style a shape shows now (its fill, outline and line style match one), else null. */
export function currentShapePreset(o) {
  const f = paintKey(o.fill), s = paintKey(o.stroke), d = o.dash || "";
  return SHAPE_PRESETS.find((p) => paintKey(p.fill) === f && paintKey(p.stroke) === s && (p.dash || "") === d)?.id ?? null;
}

/** Give a shape a style: fill, outline colour and line style (an outline gets a width if it had none). */
export function applyShapePreset(o, p) {
  o.fill = p.fill || "none";
  o.stroke = p.stroke || "none";
  if (p.dash) o.dash = p.dash;
  else delete o.dash;
  if (!p.stroke) return;
  if (o.type === "membrane") {
    if (!(o.thickness > 0)) o.thickness = BRUSHES.freeform.T;
  } else if (!(o.strokeWidth > 0)) o.strokeWidth = 1.5;
}

/* ---------- hover preview ---------- */

const KEYS = ["fill", "stroke", "dash", "strokeWidth", "thickness"];
let preview = null; // [[object, saved paint]] while a style thumbnail is hovered

/** Show a style on the shapes without recording it (hovering its thumbnail). */
function previewShapes(objs, p) {
  // a preview of other objects (undo put new ones in their place) is put back first
  if (preview && (preview.length !== objs.length || preview.some(([o], i) => o !== objs[i]))) endShapePreview();
  preview ||= objs.map((o) => [o, Object.fromEntries(KEYS.map((k) => [k, o[k]]))]);
  for (const [o, s] of preview) {
    restore(o, s);
    applyShapePreset(o, p);
  }
  renderDoc();
}

function restore(o, s) {
  for (const k of KEYS) {
    if (s[k] === undefined) delete o[k];
    else o[k] = s[k];
  }
}

/** Put back what the hover preview changed. */
export function endShapePreview() {
  if (!preview) return;
  for (const [o, s] of preview) restore(o, s);
  preview = null;
  renderDoc();
}
// undo steps, saves, copies and exports never take a style that is only previewed
onPreviewEnd(endShapePreview);

/* ---------- thumbnails ---------- */

const f1 = (v) => Math.round(v * 10) / 10;

/** The shape `o` (its outline, its proportions) in style `p`, as a small SVG. */
export function shapeThumb(o, p) {
  const S = 36, room = 28, sw = p.stroke ? 1.8 : 0;
  const paint = `fill="${p.fill || "none"}" stroke="${p.stroke || "none"}" stroke-width="${sw}" stroke-linejoin="round"`
    + (p.dash ? ` stroke-dasharray="${p.dash === "dot" ? "0.1 3.4" : "4.2 2.6"}" stroke-linecap="round"` : "");
  let shape;
  if (o.type === "membrane") {
    const pts = smoothPolyline(o.pts, true, 6);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const k = room / Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0, 1e-6);
    const ox = (S - (Math.max(...xs) - x0) * k) / 2, oy = (S - (Math.max(...ys) - y0) * k) / 2;
    shape = `<path d="M${pts.map(([x, y]) => `${f1(ox + (x - x0) * k)} ${f1(oy + (y - y0) * k)}`).join("L")}Z" ${paint}/>`;
  } else {
    // the shape's own proportions, within reason (a long banner still reads as a box)
    const ar = Math.min(2.2, Math.max(0.5, (o.w || 1) / (o.h || 1)));
    const w = ar >= 1 ? room : room * ar, h = ar >= 1 ? room / ar : room;
    const x = (S - w) / 2, y = (S - h) / 2;
    if (o.type === "ellipse") shape = `<ellipse cx="${S / 2}" cy="${S / 2}" rx="${f1(w / 2)}" ry="${f1(h / 2)}" ${paint}/>`;
    else {
      const r = Math.min((o.radius || 0) * (w / (o.w || w)), w / 2, h / 2);
      shape = `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(r)}" ${paint}/>`;
    }
  }
  return `<svg viewBox="0 0 ${S} ${S}" aria-hidden="true">${shape}</svg>`;
}

/**
 * The style thumbnails for `objs` (drawn as `o`, the first of them): hovering one previews it,
 * clicking applies it as one undo step. `all` shows every style; otherwise the first ten and a
 * "See more" link (`more`), which calls onMore. Returns {grid, more}.
 */
export function shapePresetGrid(objs, o, { all = false, onMore = null, onApply = null } = {}) {
  const cur = currentShapePreset(o);
  // every style, also when the applied one is further down
  const forced = !all && SHAPE_PRESETS.findIndex((p) => p.id === cur) >= SHAPE_PRESETS_FIRST;
  const shown = all || forced ? SHAPE_PRESETS : SHAPE_PRESETS.slice(0, SHAPE_PRESETS_FIRST);
  const grid = el("div.presets.shape-presets", {}, ...shown.map((p) => el("button.preset" + (p.id === cur ? ".on" : ""), {
    title: p.name, "aria-label": p.name, "data-preset": p.id, html: shapeThumb(o, p),
    onpointerenter: () => previewShapes(objs, p),
    onclick: () => {
      endShapePreview();
      for (const x of objs) applyShapePreset(x, p);
      renderDoc();
      commit();
      onApply?.(p);
    },
  })));
  grid.addEventListener("pointerleave", endShapePreview);
  const more = onMore && !forced
    ? el("button.linkbtn", { onclick: onMore }, all ? "See fewer" : `See more (${SHAPE_PRESETS.length - SHAPE_PRESETS_FIRST})`)
    : null;
  return { grid, more };
}
