// Right panel: Design (context-sensitive properties), Layers and Credits.

import { api, libUrl } from "./api.js";
import { state, selectedObjs, setSelection, getObj, findObj, docPx, MM, isBox, isElbow, elbowAxis, commit, onPreviewEnd } from "./model.js";
import { renderDoc, startTextEdit } from "./canvas.js";
import { updateSel, align, distribute, flipSel, arrange, duplicateSel, deleteSel, groupSel, ungroupSel, toggleLock, setIconLabels, detachLabels, brushWithIcon, replaceIcons } from "./actions.js";
import { BRUSHES, brushKind, palette } from "./brush.js";
import { hasLabels } from "./labels.js";
import { normHex } from "./color.js";
import { pickColor } from "./colorpicker.js";
import { HEADS, measureText, fitFurniture, furnitureAnchor, legendRowKind, scaleLabel } from "./render.js";
import {
  partInfo, iconPresets, presetThumb, iconThumb, currentPreset, applyPreset, applyOverlay, setPartColor, setAdjust, resetStyle,
  PRESETS_FIRST, OVERLAYS, FLUORS, defaultGlow, canGlow,
} from "./style.js";
import { $, $$, el, bus, clamp, fmtNum, round, toast, MOD } from "./util.js";
import { isFav, toggleFavorite, saveSelectionToLibrary } from "./library.js";
import { missingLegendRows, EXTRA_ROWS, UNITS } from "./furniture.js";
import { openMenu, closeMenus } from "./menus.js";
import { head, TRIM, dashArray } from "./heads.js";
import { isShape, shapePresetGrid, endShapePreview } from "./shapestyle.js";
import { revealPanel } from "./layout.js";
import { creditsInfo, legendText, exportLicenceReport } from "./licence.js";

export const SIZES = [
  ["Journal, 1 column (85 × 85 mm)", 85, 85],
  ["Journal, 1.5 columns (114 × 100 mm)", 114, 100],
  ["Journal, 2 columns (178 × 120 mm)", 178, 120],
  ["Journal, full page (178 × 230 mm)", 178, 230],
  ["Graphical abstract (130 × 50 mm)", 130, 50],
  ["A4 portrait (210 × 297 mm)", 210, 297],
  ["A4 landscape (297 × 210 mm)", 297, 210],
  ["Letter (216 × 279 mm)", 215.9, 279.4],
  ["Slide 16:9 (338.7 × 190.5 mm)", 338.67, 190.5],
  ["Slide 4:3 (254 × 190.5 mm)", 254, 190.5],
  ["Poster A0 (841 × 1189 mm)", 841, 1189],
  ["Poster A1 (594 × 841 mm)", 594, 841],
  ["Square (100 × 100 mm)", 100, 100],
];

const FONTS = ["Arial", "Helvetica", "Calibri", "Segoe UI", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Times New Roman", "Cambria", "Garamond", "Courier New", "Consolas"];
const LIC_FREE = new Set(["CC0-1.0", "PD", "USER"]);

const ICON = {
  left: '<path d="M4 3v18M8 7h12v4H8zM8 13h8v4H8z"/>',
  hcenter: '<path d="M12 3v18M6 7h12v4H6zM8 13h8v4H8z"/>',
  right: '<path d="M20 3v18M4 7h12v4H4zM8 13h8v4H8z"/>',
  top: '<path d="M3 4h18M7 8v12h4V8zM13 8v8h4V8z"/>',
  vcenter: '<path d="M3 12h18M7 6v12h4V6zM13 8v8h4V8z"/>',
  bottom: '<path d="M3 20h18M7 4v12h4V4zM13 8v8h4V8z"/>',
  dh: '<path d="M4 4v16M20 4v16M9 8h6v8H9z"/>',
  dv: '<path d="M4 4h16M4 20h16M8 9h8v6H8z"/>',
  fliph: '<path d="M12 3v18M10 6L3 18h7zM14 6l7 12h-7z" fill-opacity=".35"/>',
  flipv: '<path d="M3 12h18M6 10L18 3v7zM6 14l12 7v-7z" fill-opacity=".35"/>',
  front: '<path d="M8 8h12v12H8z"/><path d="M4 4h12v3H7v9H4z" fill-opacity=".35"/>',
  back: '<path d="M4 4h12v12H4z" fill-opacity=".35"/><path d="M8 17h9V8h3v12H8z"/>',
  fwd: '<path d="M12 4l6 7h-4v9h-4v-9H6z"/>',
  bwd: '<path d="M12 20l6-7h-4V4h-4v9H6z"/>',
  dup: '<path d="M8 8h12v12H8z" fill="none" stroke-width="1.8"/><path d="M4 4h12v3H7v9H4z"/>',
  del: '<path d="M6 7h12l-1 14H7zM9 4h6v2H9zM4 6h16v1.5H4z"/>',
  lock: '<path d="M7 11V8a5 5 0 0110 0v3h1v10H6V11zm2 0h6V8a3 3 0 00-6 0z"/>',
  group: '<path d="M3 3h7v7H3zM14 14h7v7h-7z" fill-opacity=".5"/><path d="M2 2h20v20H2z" fill="none" stroke-width="1.5" stroke-dasharray="3 2"/>',
};
const ico = (k) => el("span", { html: `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`, style: { display: "contents" } });
const ibtn = (k, title, fn) => el("button.btn", { title, onclick: fn }, ico(k));

function section(title, ...kids) {
  return el("div.section", {}, title ? el("h3", {}, ...(Array.isArray(title) ? title : [title])) : null, ...kids);
}

function numField(label, value, onCommit, { step = 0.1, min = null, suffix = "", wide = false, title = "" } = {}) {
  const inp = el("input.num", { type: "number", step, value: fmtNum(value), title });
  if (min != null) inp.min = min;
  const apply = () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) onCommit(min != null ? Math.max(min, v) : v);
  };
  inp.addEventListener("change", apply);
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") inp.blur();
  });
  return el("div.field" + (wide ? ".wide" : ""), {}, label ? el("label", {}, label) : null, inp, suffix ? el("span.small.muted", {}, suffix) : null);
}

function swatchBtn(color, onPick, opts = {}) {
  const b = el("button.swatch" + (color ? "" : ".none"), { style: { background: color || "transparent" }, title: color || "None" });
  b.addEventListener("click", () =>
    pickColor(b, color, (hex, final) => {
      b.style.background = hex || "transparent";
      b.classList.toggle("none", !hex);
      onPick(hex, final);
    }, opts)
  );
  return b;
}

function selectField(label, value, options, onChange) {
  const s = el("select", {}, ...options.map(([v, t]) => el("option", { value: v, selected: v === value }, t)));
  s.addEventListener("change", () => onChange(s.value));
  return el("div.field.wide", {}, el("label", {}, label), s);
}

/* ---------- Design tab ---------- */

function docSection() {
  const d = state.doc;
  const preset = SIZES.find(([, w, h]) => Math.abs(w - d.width) < 0.1 && Math.abs(h - d.height) < 0.1);
  const sizeSel = el("select", {}, el("option", { value: "" }, preset ? "" : "Custom size"), ...SIZES.map(([t, w, h], i) => el("option", { value: i, selected: preset && preset[1] === w && preset[2] === h }, t)));
  sizeSel.addEventListener("change", () => {
    const s = SIZES[+sizeSel.value];
    if (!s) return;
    d.width = s[1];
    d.height = s[2];
    renderDoc();
    commit();
    bus.emit("fit");
  });
  const setSize = (k) => (v) => {
    d[k] = Math.max(5, v);
    renderDoc();
    commit();
    bus.emit("fit");
  };
  const bg = swatchBtn(d.background, (hex, final) => {
    d.background = hex;
    renderDoc();
    if (final) commit();
  }, { allowNone: true });
  const gridT = el("button.btn" + (state.settings.grid ? ".on" : ""), { onclick: () => { state.settings.grid = !state.settings.grid; renderDoc(); refresh(); } }, "Grid");
  const snapT = el("button.btn" + (state.settings.snap ? ".on" : ""), { onclick: () => { state.settings.snap = !state.settings.snap; refresh(); } }, "Smart guides");
  return [
    section("Figure", el("div.field", {}, sizeSel),
      el("div.grid2", {}, numField("W", d.width, setSize("width"), { suffix: "mm", min: 5 }), numField("H", d.height, setSize("height"), { suffix: "mm", min: 5 })),
      el("div.row", {}, el("span.small.muted", {}, "Background"), bg, el("span.small.muted", {}, d.background ? d.background : "transparent (PNG/TIFF/PDF)"))),
    section("Guides", el("div.row.wrap.guides", {}, gridT, numField("", state.settings.gridSize, (v) => { state.settings.gridSize = Math.max(0.5, v); renderDoc(); }, { suffix: "mm", min: 0.5, title: "Grid spacing" }), snapT)),
    section("Getting started", el("div.meta-line", {},
      "Search the library on the left and click or drag an icon onto the page. Select an icon to recolour its parts, like in BioRender. ",
      "Draw arrows (A), inhibition lines (I), membranes (M), shapes (R, O) and text (T). The Insert menu adds a legend of your icons, a scale bar and panel labels (A, B, C…). Export to PNG/TIFF at 300–1200 dpi, vector PDF or SVG. ",
      "The Credits tab writes the figure-legend attribution for you.")),
  ];
}

function transformSection(o, withOpacity = true) {
  const set = (fn) => updateSel(fn);
  const keep = o.type === "icon" || o.type === "image" || o.type === "text";
  const rows = [
    el("div.grid2", {},
      numField("X", o.x / MM, (v) => set((x) => (x.x = v * MM)), { suffix: "mm" }),
      numField("Y", o.y / MM, (v) => set((x) => (x.y = v * MM)), { suffix: "mm" }),
      numField("W", o.w / MM, (v) => set((x) => {
        const s = (v * MM) / x.w;
        const cx = x.x + x.w / 2, cy = x.y + x.h / 2;
        x.w = v * MM;
        if (keep) x.h *= s;
        if (x.type === "text") x.fontSize *= s;
        x.x = cx - x.w / 2;
        x.y = cy - x.h / 2;
      }), { suffix: "mm", min: 0.1 }),
      numField("H", o.h / MM, (v) => set((x) => {
        const s = (v * MM) / x.h;
        const cx = x.x + x.w / 2, cy = x.y + x.h / 2;
        x.h = v * MM;
        if (keep) x.w *= s;
        if (x.type === "text") x.fontSize *= s;
        x.x = cx - x.w / 2;
        x.y = cy - x.h / 2;
      }), { suffix: "mm", min: 0.1 })),
    el("div.grid2", {},
      numField("↻", o.rot || 0, (v) => set((x) => (x.rot = ((v % 360) + 360) % 360)), { suffix: "°", step: 1, title: "Rotation" }),
      el("div.row", {}, ibtn("fliph", "Flip horizontally", () => flipSel("h")), ibtn("flipv", "Flip vertically", () => flipSel("v")))),
  ];
  return section("Position & size", ...rows, withOpacity ? opacityRow(o) : null);
}

function opacityRow(o) {
  const r = el("input", { type: "range", min: 0, max: 1, step: 0.01, value: o.opacity ?? 1 });
  const lab = el("span.small.muted", { style: { width: "34px", textAlign: "right" } }, Math.round((o.opacity ?? 1) * 100) + "%");
  r.addEventListener("input", () => {
    lab.textContent = Math.round(r.value * 100) + "%";
    updateSel((x) => (x.opacity = +r.value), true);
  });
  r.addEventListener("change", () => commit());
  return el("div.row", {}, el("span.small.muted", { style: { width: "52px" } }, "Opacity"), r, lab);
}

function arrangeSection(multi = false) {
  return section("Arrange",
    el("div.iconbtns", {},
      ibtn("front", "Bring to front (Ctrl+Shift+])", () => arrange("front")),
      ibtn("fwd", "Bring forward (Ctrl+])", () => arrange("forward")),
      ibtn("bwd", "Send backward (Ctrl+[)", () => arrange("backward")),
      ibtn("back", "Send to back (Ctrl+Shift+[)", () => arrange("back")),
      ibtn("dup", "Duplicate (Ctrl+D)", duplicateSel),
      ibtn("del", "Delete (Del)", deleteSel)),
    el("div.iconbtns", {},
      ibtn("left", multi ? "Align left" : "Align left on page", () => align("left")),
      ibtn("hcenter", "Align centres horizontally", () => align("hcenter")),
      ibtn("right", "Align right", () => align("right")),
      ibtn("top", "Align top", () => align("top")),
      ibtn("vcenter", "Align middles", () => align("vcenter")),
      ibtn("bottom", "Align bottom", () => align("bottom"))),
    multi ? el("div.iconbtns", {},
      ibtn("dh", "Distribute horizontally", () => distribute("h")),
      ibtn("dv", "Distribute vertically", () => distribute("v")),
      ibtn("group", "Group (Ctrl+G)", groupSel),
      ibtn("lock", "Lock / unlock", toggleLock)) : el("div.iconbtns", {}, ibtn("lock", "Lock / unlock (Ctrl+L)", toggleLock)));
}

function licBadge(lic) {
  return el("span.lic." + (LIC_FREE.has(lic) ? "free" : "attr"), { title: LIC_FREE.has(lic) ? "No attribution required" : "Attribution required — see the Credits tab" }, lic === "PD" ? "Public domain" : lic === "USER" ? "Your file" : lic);
}

function iconSections(o) {
  const asset = state.doc.assets[o.asset];
  if (!asset) return [section("Icon", el("div.muted", {}, "Missing icon data"))];
  const m = asset.meta;
  const out = [];
  const nameIn = el("input.num", { value: o.name || m.name });
  nameIn.addEventListener("change", () => updateSel((x) => (x.name = nameIn.value)));
  nameIn.addEventListener("keydown", (e) => e.stopPropagation());
  const fav = m.pack !== "file" ? el("button.btn", { title: "Favourite", onclick: async () => { const on = await toggleFavorite(m.id); fav.textContent = on ? "★" : "☆"; } }, isFav(m.id) ? "★" : "☆") : null;
  out.push(section("Icon",
    el("div.row", {}, nameIn, fav),
    el("div.meta-line", {}, m.packName || m.pack, " · ", licBadge(m.license), m.author ? ` · ${m.author}` : "",
      m.source_url ? el("span", {}, " · ", el("a", { onclick: () => openLink(m.source_url) }, "source")) : null),
    asset.raster ? el("div.small.muted", {}, "Contains bitmap parts — only the vector parts recolour.") : null));

  out.push(...styleSections(o, asset), glowSection(o));
  if (hasLabels(asset)) out.push(labelSection(o));
  if (asset.meta.variants?.length) {
    out.push(section("Variants", el("div.variants", {}, ...asset.meta.variants.map((v) =>
      el("img", { src: libUrl(v.thumb), title: v.name, onclick: () => swapAsset(o, v.id) })))));
  }
  return out;
}

/* ---------- Style: presets, parts, colour overlay and adjustments (icons and icon brushes) ---------- */

let seeMore = null; // presets: the drawing whose "See more" is open
let preview = null; // [[object, saved style]] while a preset thumbnail is hovered
let glowColor = "#39ff5a"; // the colour a glow is switched on with

const STYLE_KEYS = ["colors", "slotColors", "tint", "preset", "saturation", "lightness", "baseColors"];
const saveStyle = (o) => JSON.parse(JSON.stringify(Object.fromEntries(STYLE_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))));
function putStyle(o, s) {
  for (const k of STYLE_KEYS) delete o[k];
  Object.assign(o, JSON.parse(JSON.stringify(s)));
}

/** Show a preset on the selected icons without recording it (hovering its thumbnail). */
function previewPreset(objs, id) {
  preview ||= objs.map((o) => [o, saveStyle(o)]);
  for (const [o, s] of preview) {
    putStyle(o, s);
    applyPreset(o, id);
  }
  renderDoc();
}

/** Put back what the hover preview changed. */
function endPreview() {
  if (!preview) return;
  for (const [o, s] of preview) putStyle(o, s);
  preview = null;
  renderDoc();
}
// undo steps, saves, copies and exports never take a style that is only previewed
onPreviewEnd(endPreview);

/** The selected objects that share `o`'s drawing (the ones the Style controls change). */
const styleObjs = (o) => selectedObjs().filter((x) => x.type === o.type && x.asset === o.asset && !x.locked);
const updateStyle = (o, fn, live = false) => updateSel((x) => x.type === o.type && x.asset === o.asset && !x.locked && fn(x), live);

/** The colour a part is drawn in now (presets, overlay and adjustments included). */
const partColor = (o, slot) => (o.colors || {})[slot.base.toLowerCase()] || slot.base.toLowerCase();

/** A labelled slider with a number field, kept in step; onChange(value, live). */
function rangeField(label, value, { min, max, step = 1, title = "" }, onChange) {
  title ||= null;
  const r = el("input", { type: "range", min, max, step, value, title });
  const num = el("input.num", { type: "number", min, max, step, value: fmtNum(value), title });
  r.addEventListener("input", () => {
    num.value = r.value;
    onChange(+r.value, true);
  });
  r.addEventListener("change", () => onChange(+r.value, false));
  num.addEventListener("change", () => {
    const v = clamp(parseFloat(num.value) || 0, min, max);
    num.value = fmtNum(v);
    r.value = v;
    onChange(v, false);
  });
  num.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") num.blur();
  });
  return el("div.adj", {}, el("label", { title }, label), r, num);
}

/** Ready-made colour styles shown as live thumbnails of this icon; hovering previews one. */
function presetSection(o, asset) {
  const list = iconPresets(o.asset, asset);
  if (list.length < 2) return null;
  const cur = currentPreset(o);
  // all of them with "See more", or when the applied one is further down
  const open = seeMore === o.asset, forced = !open && list.findIndex((p) => p.id === cur) >= PRESETS_FIRST;
  const shown = open || forced ? list : list.slice(0, PRESETS_FIRST);
  const grid = el("div.presets", {}, ...shown.map((p) => el("button.preset" + (p.id === cur ? ".on" : ""), {
    title: p.name, "aria-label": p.name, "data-preset": p.id,
    onpointerenter: () => previewPreset(styleObjs(o), p.id),
    onclick: () => {
      endPreview();
      updateStyle(o, (x) => applyPreset(x, p.id));
    },
  }, el("img", { src: presetThumb(o, asset, p), alt: "", draggable: "false" }))));
  grid.addEventListener("pointerleave", endPreview);
  const more = list.length > PRESETS_FIRST && !forced
    ? el("button.linkbtn", { onclick: () => { seeMore = open ? null : o.asset; refresh(); } }, open ? "See fewer" : `See more (${list.length - PRESETS_FIRST})`)
    : null;
  return section(["Presets", more], grid);
}

let shapeMore = false; // the shape styles' "See more" is open

/** Ready-made colour styles for the selected shapes, drawn on this shape; hovering previews one. */
function shapePresetSection(o) {
  const objs = selectedObjs().filter((x) => isShape(x) && !x.locked);
  if (!objs.length) return null;
  const { grid, more } = shapePresetGrid(objs, o, { all: shapeMore, onMore: () => { shapeMore = !shapeMore; refresh(); } });
  return section(["Presets", more], grid);
}

/** One button per colour part, named (Cell, Nucleus, Granules…); each opens a colour picker. */
function partsSection(o, asset) {
  const slots = asset.slots || [];
  if (!slots.length) return null;
  const rows = partInfo(o.asset, asset).parts.map((p) => {
    const s = slots[p.i];
    const sw = el("span.swatch", { style: { background: partColor(o, s) } });
    const b = el("button.part" + (o.slotColors?.[p.i] ? ".changed" : ""), {
      "data-part": p.i,
      title: `${p.name} · ${s.members.length} shade${s.members.length > 1 ? "s" : ""}, ${Math.round(s.weight * 100)}% of the drawing\nClick to recolour; highlights and shadows are kept`,
    }, sw, el("span.nm", {}, p.name));
    b.addEventListener("click", () => pickColor(b, partColor(o, s), (hex, final) => {
      if (!hex) return;
      sw.style.background = hex;
      updateStyle(o, (x) => setPartColor(x, p.i, hex), !final);
    }, { resetLabel: "Reset part", onReset: () => updateStyle(o, (x) => setPartColor(x, p.i, null)) }));
    return b;
  });
  return section("Parts", el("div.parts", {}, ...rows));
}

/** Colour overlay swatches, transparency, saturation and lightness, and Reset styles. */
function overlaySection(o, asset, withOpacity = true) {
  const rows = [];
  if (asset.slots?.length) {
    const tint = o.tint && o.tint !== "gray" ? o.tint : null;
    const custom = tint && !OVERLAYS.some(([h]) => h === tint) ? tint : null;
    const plus = el("button.swatch.ov.add" + (custom ? ".on.custom" : ""), { title: "Custom overlay colour", style: custom ? { background: custom } : null }, custom ? "" : "+");
    plus.addEventListener("click", () => pickColor(plus, tint || "#4aa9d0", (hex, final) => hex && updateStyle(o, (x) => applyOverlay(x, hex), !final)));
    rows.push(el("div.overlays", {}, ...OVERLAYS.map(([hex, name]) =>
      el("button.swatch.ov" + (tint === hex ? ".on" : ""), { style: { background: hex }, title: `${name} overlay`, onclick: () => updateStyle(o, (x) => applyOverlay(x, hex)) })), plus));
  }
  if (withOpacity) {
    rows.push(rangeField("Transparency", Math.round((1 - (o.opacity ?? 1)) * 100), { min: 0, max: 100, title: "0 = opaque, 100 = invisible" }, (v, live) =>
      updateStyle(o, (x) => (v > 0 ? (x.opacity = Math.round(100 - v) / 100) : delete x.opacity), live)));
  }
  if (asset.slots?.length) {
    rows.push(rangeField("Saturation", o.saturation ?? 100, { min: 0, max: 200, title: "100 = as drawn, 0 = grey" }, (v, live) => updateStyle(o, (x) => setAdjust(x, { saturation: v }), live)));
    rows.push(rangeField("Lightness", o.lightness ?? 0, { min: -100, max: 100, title: "0 = as drawn" }, (v, live) => updateStyle(o, (x) => setAdjust(x, { lightness: v }), live)));
  }
  const reset = el("button.btn.small", {
    title: withOpacity ? "Back to the library colours, fully opaque" : "Back to the library colours",
    onclick: () => updateStyle(o, (x) => {
      const op = x.opacity;
      resetStyle(x);
      if (!withOpacity && op != null) x.opacity = op;
    }),
  }, "Reset styles");
  return section(["Colour overlay", reset], ...rows);
}

/** The Style sections for an icon (or every selected copy of it) or an icon brush. */
function styleSections(o, asset, { opacity = true } = {}) {
  return [presetSection(o, asset), partsSection(o, asset), overlaySection(o, asset, opacity)].filter(Boolean);
}

/** Glow (fluorescence): on/off, colour and strength, for icons, shapes and brushes. */
function glowSection(o) {
  const g = o.glow;
  const update = (fn, live) => updateSel((x) => canGlow(x) && !x.locked && x.glow && (x.glow = { ...x.glow, ...fn() }), live);
  const toggle = el("button.btn.small" + (g ? ".on" : ""), {
    title: g ? "Turn the glow off" : "Add a fluorescent glow",
    onclick: () => updateSel((x) => {
      if (!canGlow(x) || x.locked) return;
      if (g) delete x.glow;
      else x.glow = defaultGlow(x, glowColor);
    }),
  }, g ? "On" : "Off");
  if (!g) return section(["Glow", toggle], el("div.small.muted", {}, "A soft fluorescent halo (GFP, mCherry, DAPI…), exported with the figure."));
  const cur = normHex(g.color) || "#39ff5a";
  const known = FLUORS.some(([h]) => h === cur);
  const pick = (hex, live = false) => {
    glowColor = hex;
    update(() => ({ color: hex }), live);
  };
  const custom = el("button.swatch.ov.add" + (known ? "" : ".on.custom"), { title: "Custom glow colour", style: known ? null : { background: cur } }, known ? "+" : "");
  custom.addEventListener("click", () => pickColor(custom, cur, (hex, final) => hex && pick(normHex(hex), !final)));
  return section(["Glow", toggle],
    el("div.overlays", {}, ...FLUORS.map(([hex, name]) =>
      el("button.swatch.ov" + (cur === hex ? ".on" : ""), { style: { background: hex }, title: name, onclick: () => pick(hex) })), custom),
    rangeField("Strength", g.size ?? 6, { min: 1, max: 40, step: 0.5, title: "How far the glow spreads" }, (v, live) => update(() => ({ size: v }), live)));
}

/** Select an icon and open one part's colour picker in the Style panel (from the Layers list). */
export function editPart(id, i) {
  setSelection([id]);
  showTab("design");
  const b = $(`#tab-design .part[data-part="${i}"]`);
  if (!b) return;
  b.scrollIntoView({ block: "nearest" });
  b.click();
}

/** Labels drawn inside the icon: show, hide (with their leader lines) or turn into editable text. */
function labelSection(o) {
  const mode = o.labels || "";
  const b = (m, label, title, run) => el("button.btn" + (mode === m ? ".on" : ""), { title, onclick: run }, label);
  return section("Labels",
    el("div.row.wrap", {},
      b("", "Show", "Show the labels drawn in this icon", () => { updateSel((x) => setIconLabels(x, null)); refresh(); }),
      b("hidden", "Hide", "Hide the text, its leader lines and dots, and crop to the drawing", () => { updateSel((x) => setIconLabels(x, "hidden")); refresh(); }),
      b("detached", "Edit as text", "Turn each label into a text object you can reword, restyle, move or delete", () => detachLabels(o))),
    el("div.small.muted", {}, mode === "detached" ? "The labels are separate text objects now; Show brings back the original ones." : "This drawing has its own text labels."));
}

/** Show a colour variant: the same swap as Replace, with the variant's own colours. */
async function swapAsset(o, id) {
  const cur = getObj(o.id);
  if (cur) await replaceIcons(id, [cur], { colors: false });
  refresh();
}

function textSections(o) {
  const ta = el("textarea.txt", {}, o.text);
  ta.addEventListener("input", () => updateSel((x) => (x.text = ta.value), true));
  ta.addEventListener("change", () => commit());
  ta.addEventListener("keydown", (e) => e.stopPropagation());
  const pt = (px) => round(px * 0.75, 1);
  const fam = el("select", {}, ...FONTS.map((f) => el("option", { value: f, selected: f === o.fontFamily, style: { fontFamily: f } }, f)));
  fam.addEventListener("change", () => updateSel((x) => (x.fontFamily = fam.value)));
  const tog = (k, label, title) => el("button.btn" + (o[k] ? ".on" : ""), { title, onclick: () => { updateSel((x) => (x[k] = !x[k])); refresh(); } }, label);
  const al = (v, label) => el("button.btn" + ((o.align || "left") === v ? ".on" : ""), { onclick: () => { updateSel((x) => (x.align = v)); refresh(); } }, label);
  return [
    section("Text", ta, el("div.field", {}, fam),
      el("div.row", {},
        numField("Size", pt(o.fontSize), (v) => updateSel((x) => (x.fontSize = Math.max(1, v) / 0.75)), { suffix: "pt", step: 0.5, min: 1 }),
        swatchBtn(o.color, (hex, final) => hex && updateSel((x) => (x.color = hex), !final))),
      el("div.row.wrap.tight", {}, tog("bold", "B", "Bold"), tog("italic", "I", "Italic"), al("left", "Left"), al("center", "Centre"), al("right", "Right")),
      el("div.row", {}, el("button.btn", { onclick: () => startTextEdit(o) }, "Edit on canvas"), el("span.small.muted", {}, "or double-click the text"))),
    section("Position", el("div.grid2", {},
      numField("X", o.x / MM, (v) => updateSel((x) => (x.x = v * MM)), { suffix: "mm" }),
      numField("Y", o.y / MM, (v) => updateSel((x) => (x.y = v * MM)), { suffix: "mm" }),
      numField("↻", o.rot || 0, (v) => updateSel((x) => (x.rot = v)), { suffix: "°", step: 1 })), opacityRow(o)),
  ];
}

const DASHES = [["", "Solid"], ["dash", "Dashed"], ["long", "Long dash"], ["dot", "Dotted"]];

function shapeSections(o) {
  const strokePt = (o.strokeWidth ?? 1.5) * 0.75;
  return [
    shapePresetSection(o),
    section(o.type === "rect" ? "Rectangle" : "Ellipse",
      el("div.row", {}, el("span.small.muted", { style: { width: "40px" } }, "Fill"), swatchBtn(o.fill === "none" ? null : o.fill, (hex, final) => updateSel((x) => (x.fill = hex || "none"), !final), { allowNone: true }),
        el("span.small.muted", { style: { width: "44px", marginLeft: "10px" } }, "Stroke"), swatchBtn(o.stroke === "none" ? null : o.stroke, (hex, final) => updateSel((x) => (x.stroke = hex || "none"), !final), { allowNone: true })),
      el("div.grid2", {},
        numField("Width", strokePt, (v) => updateSel((x) => (x.strokeWidth = v / 0.75)), { suffix: "pt", step: 0.25, min: 0 }),
        o.type === "rect" ? numField("Corner", (o.radius || 0) / MM, (v) => updateSel((x) => (x.radius = v * MM)), { suffix: "mm", min: 0 }) : el("span")),
      selectField("Line style", o.dash || "", DASHES, (v) => updateSel((x) => (x.dash = v)))),
    glowSection(o),
    transformSection(o),
  ].filter(Boolean);
}

const HEAD_NAMES = { none: "None", arrow: "Arrow ▶", open: "Open arrow >", bar: "Inhibition ⊣", dot: "Dot ●", diamond: "Diamond ◆" };
const headOptions = () => HEADS.map((h) => [h, HEAD_NAMES[h]]);

/** Head size slider shared by lines and path arrows. */
function headSizeRow(o) {
  const hs = el("input", { type: "range", min: 0.3, max: 3, step: 0.05, value: o.headScale || 1 });
  hs.addEventListener("input", () => updateSel((x) => (x.headScale = +hs.value), true));
  hs.addEventListener("change", () => commit());
  return el("div.row", {}, el("span.small.muted", { style: { width: "74px" } }, "Head size"), hs);
}

/** Straight, curved (a bulge) or elbow (right angles with one sliding bend). */
function setRoute(x, route) {
  for (const k of ["route", "axis", "bend", "elbowAt"]) delete x[k];
  if (route === "elbow") {
    Object.assign(x, { route: "elbow", axis: Math.abs(x.x2 - x.x1) >= Math.abs(x.y2 - x.y1) ? "h" : "v", bend: 0.5, curve: 0 });
  } else if (route === "curved") {
    if (Math.abs(x.curve || 0) < 0.01) x.curve = Math.hypot(x.x2 - x.x1, x.y2 - x.y1) * 0.2;
  } else x.curve = 0;
}

/** Point a line (or path arrow) the other way: the heads swap ends; its path and connections stay. */
function reverseHeads(x) {
  [x.startHead, x.endHead] = [x.endHead || "none", x.startHead || "none"];
}

/** Which objects the ends follow, with Detach, and the gap they keep. */
function connectorSection(o) {
  const rows = [["from", "Start"], ["to", "End"]].map(([k, label]) => {
    const t = o[k] && findObj(o[k].id);
    return el("div.row.conn-row", {},
      el("span.small.muted", { style: { width: "34px" } }, label),
      t ? el("span.conn-name", { title: "This end follows the object when it moves, turns or is resized" }, "Connected to ", el("b", {}, layerName(t)))
        : el("span.small.muted.conn-name", {}, "Not connected"),
      t ? el("button.btn.small", { title: "Let this end go; it stays where it is", onclick: () => { updateSel((x) => delete x[k]); refresh(); } }, "Detach") : null);
  });
  const any = o.from || o.to;
  return section("Connector", ...rows,
    any ? numField("End padding", o.pad ?? 2, (v) => updateSel((x) => (x.pad = v)), { suffix: "px", step: 0.5, min: 0, wide: true, title: "Gap between a connected end and the object's outline" }) : null,
    el("div.small.muted", {}, any ? "Drag a connected end off its object (or hold Alt) to let it go." : "Drag an end onto an object to connect it; it then follows the object. Hold Alt to keep it free."),
    o.from && o.to ? null : el("div.small.muted", {}, `A drawing the whole line lies on (a tissue background) is left out; hold ${MOD.replace(/\+$/, "")} while dragging to connect an end to it.`));
}

function lineSections(o) {
  const elbow = isElbow(o);
  const route = elbow ? "elbow" : Math.abs(o.curve || 0) > 0.01 ? "curved" : "straight";
  const shape = [selectField("Routing", route, [["straight", "Straight"], ["curved", "Curved"], ["elbow", "Elbow (right angles)"]], (v) => { updateSel((x) => setRoute(x, v)); refresh(); })];
  if (elbow) {
    shape.push(selectField("Leaves start", elbowAxis(o), [["h", "Sideways"], ["v", "Up or down"]], (v) => { updateSel((x) => { x.axis = v; delete x.elbowAt; }); refresh(); }),
      el("div.row", {}, el("button.btn.small", { title: "Put the bend halfway between the ends", onclick: () => updateSel((x) => (x.bend = 0.5)) }, "Centre the bend"),
        el("span.small.muted", {}, "or drag the yellow handle")));
  } else {
    const curve = el("input", { type: "range", min: -150, max: 150, step: 1, value: Math.max(-150, Math.min(150, o.curve || 0)) });
    curve.addEventListener("input", () => updateSel((x) => (x.curve = +curve.value), true));
    curve.addEventListener("change", () => { commit(); refresh(); });
    shape.push(el("div.row", {}, el("span.small.muted", { style: { width: "74px" } }, "Curve"), curve, el("button.btn.small", { onclick: () => { updateSel((x) => (x.curve = 0)); refresh(); } }, "Straight")));
  }
  return [
    section("Line",
      el("div.row", {}, el("span.small.muted", { style: { width: "40px" } }, "Colour"), swatchBtn(o.stroke, (hex, final) => hex && updateSel((x) => (x.stroke = hex), !final)),
        numField("", (o.strokeWidth ?? 2) * 0.75, (v) => updateSel((x) => (x.strokeWidth = Math.max(0.1, v / 0.75))), { suffix: "pt", step: 0.25, min: 0.1 })),
      selectField("Line style", o.dash || "", DASHES, (v) => updateSel((x) => (x.dash = v))),
      selectField("Start", o.startHead || "none", headOptions(), (v) => updateSel((x) => (x.startHead = v))),
      selectField("End", o.endHead || "none", headOptions(), (v) => updateSel((x) => (x.endHead = v))),
      headSizeRow(o),
      ...shape,
      el("div.row", {}, el("button.btn", { title: "Swap the start and end heads", onclick: () => { updateSel(reverseHeads); refresh(); } }, "Reverse direction")),
      opacityRow(o)),
    connectorSection(o),
    arrangeSection(),
  ];
}

function slider(label, value, min, max, step, onInput, width = "74px") {
  const r = el("input", { type: "range", min, max, step, value });
  r.addEventListener("input", () => onInput(+r.value, true));
  r.addEventListener("change", () => onInput(+r.value, false));
  return el("div.row", {}, el("span.small.muted", { style: { width, flex: "none" } }, label), r);
}

const SPACING_LABEL = { dna: "Pitch", rna: "Base spacing", cuboidal: "Cell width", columnar: "Cell width", squamous: "Cell width", actin: "Spacing", microtubule: "Subunit size", collagen: "Banding", vessel: "Cell spacing", axon: "Internodes", icon: "Spacing" };

function brushSections(o) {
  const kind = brushKind(o);
  const def = BRUSHES[kind];
  const T = o.thickness ?? def.T;
  const kinds = Object.entries(BRUSHES).filter(([k]) => k !== "icon" || o.asset).map(([k, b]) => [k, b.name]);
  const rows = [selectField("Pattern", kind, kinds, (v) => { updateSel((x) => setBrushKind(x, v)); refresh(); })];
  // widths of path arrows and outlines read in points, as on lines and shapes
  const ptField = (label, wide) => numField(label, T * 0.75, (v) => updateSel((x) => (x.thickness = clamp(v / 0.75, def.min, def.max))), { suffix: "pt", step: 0.25, min: def.min * 0.75, wide });
  if (def.line) {
    // path arrow: colour, width, dashes, heads and direction, as on straight arrows
    rows.push(el("div.row", {}, el("span.small.muted", { style: { width: "40px", flex: "none" } }, "Colour"),
      swatchBtn(palette(o).line, (hex, final) => hex && updateSel((x) => (x.palette = { ...(x.palette || {}), line: normHex(hex) }), !final)), ptField("")),
    selectField("Line style", o.dash || "", DASHES, (v) => updateSel((x) => (x.dash = v))));
    if (!o.closed) {
      rows.push(selectField("Start", o.startHead || "none", headOptions(), (v) => updateSel((x) => (x.startHead = v))),
        selectField("End", o.endHead || "none", headOptions(), (v) => updateSel((x) => (x.endHead = v))), headSizeRow(o),
        el("div.row", {}, el("button.btn", { title: "Swap the start and end heads", onclick: () => { updateSel(reverseHeads); refresh(); } }, "Reverse direction")));
    }
  } else if (def.shape) {
    // freeform shape: fill (with its own opacity) and outline
    rows.push(el("div.row", {}, el("span.small.muted", { style: { width: "40px", flex: "none" } }, "Fill"), swatchBtn(o.fill === "none" ? null : o.fill, (hex, final) => updateSel((x) => (x.fill = hex || "none"), !final), { allowNone: true }),
      el("span.small.muted", { style: { width: "50px", flex: "none", marginLeft: "10px" } }, "Outline"), swatchBtn(o.stroke === "none" ? null : o.stroke, (hex, final) => updateSel((x) => (x.stroke = hex || "none"), !final), { allowNone: true })),
    rangeField("Fill opacity", Math.round((o.fillOpacity ?? 1) * 100), { min: 0, max: 100, title: "0 = clear, 100 = solid" }, (v, live) => updateSel((x) => (x.fillOpacity = v / 100), live)),
    ptField("Line width", true),
    selectField("Line style", o.dash || "", DASHES, (v) => updateSel((x) => (x.dash = v))));
  } else {
    // (resizing the brush scales its pattern too, so it can end up outside the usual range)
    rows.push(slider(kind === "icon" ? "Icon size" : "Thickness", T, Math.min(def.min, T), Math.max(def.max, T), 0.5, (v, live) => updateSel((x) => (x.thickness = v), live)));
    if (def.spacing) rows.push(slider(SPACING_LABEL[kind] || "Spacing", o.spacing ?? 1, 0.4, 2.5, 0.05, (v, live) => updateSel((x) => (x.spacing = v), live)));
  }
  // colours
  if (kind === "bilayer") {
    rows.push(el("div.row", {},
      el("span.small.muted", { style: { width: "40px" } }, "Heads"), swatchBtn(o.headColor, (hex, final) => hex && updateSel((x) => (x.headColor = hex), !final)),
      el("span.small.muted", { style: { width: "36px", marginLeft: "10px" } }, "Tails"), swatchBtn(o.tailColor, (hex, final) => hex && updateSel((x) => (x.tailColor = hex), !final))));
  } else if (def.palette && !def.line) {
    const pal = palette(o);
    rows.push(el("div.slots.brush-pal", {}, ...def.palette.map(([k, label]) => el("div.slot", {},
      swatchBtn(pal[k], (hex, final) => hex && updateSel((x) => (x.palette = { ...(x.palette || {}), [k]: normHex(hex) }), !final)),
      el("span", {}, label)))));
  }
  // pattern options
  const opts = [];
  const toggle = (on, label, title, fn) => el("button.btn" + (on ? ".on" : ""), { title, onclick: () => { updateSel(fn); refresh(); } }, label);
  if (def.cells || kind === "rna" || kind === "icon") opts.push(el("button.btn", { title: "Put the pattern on the other side of the line", onclick: () => updateSel((x) => (x.side = x.side === 1 ? -1 : 1)) }, "Flip side"));
  if (kind === "icon") opts.push(toggle(o.follow !== false, "Follow the path", "Turn each copy along the path (off: keep them upright)", (x) => (x.follow = x.follow === false)));
  if (["dna", "rna", "cuboidal", "columnar", "squamous", "vessel", "icon"].includes(kind)) opts.push(el("button.btn", { title: "New random variation (base sequence, cell sizes, scatter)", onclick: () => updateSel((x) => (x.seed = Math.floor(Math.random() * 1e6))) }, "Shuffle"));
  if (opts.length) rows.push(el("div.row.wrap", {}, ...opts));
  if (def.cells) {
    rows.push(selectField("Apical surface", o.apical || "none", [["none", "Smooth"], ["microvilli", "Microvilli (brush border)"], ["cilia", "Cilia"]], (v) => updateSel((x) => (x.apical = v))));
    rows.push(el("div.row", {}, toggle(o.basement !== false, "Basement membrane", "Draw the basement membrane under the cells", (x) => (x.basement = x.basement === false))));
  }
  if (kind === "icon") rows.push(slider("Scatter", o.jitter || 0, 0, 1, 0.05, (v, live) => updateSel((x) => (x.jitter = v), live)));
  if (!def.shape) {
    rows.push(el("div.row", {},
      el("button.btn" + (o.closed ? ".on" : ""), { onclick: () => { updateSel((x) => { x.closed = !x.closed; if (x.closed && x.pts.length < 3) x.pts.splice(1, 0, bulge(x.pts[0], x.pts[1])); }); refresh(); } }, o.closed ? "Closed loop" : "Open path"),
      o.closed ? el("span.small.muted", {}, "Fill") : null,
      o.closed ? swatchBtn(o.fill === "none" ? null : o.fill, (hex, final) => updateSel((x) => (x.fill = hex || "none"), !final), { allowNone: true }) : null));
  }
  rows.push(el("div.small.muted", {}, def.shape
    ? "Drag the round handles to reshape it. Double-click the outline to add a point; double-click a point to remove it."
    : "Drag the round handles to bend the path, or drag an end to extend it. Double-click the path to add a point; double-click a point to remove it."
      + (def.line ? "" : ` Corner handles resize the whole brush, ${kind === "icon" ? "icons" : "pattern"} too (Alt: only the path).`)));
  rows.push(opacityRow(o));
  const out = [def.shape ? shapePresetSection(o) : null, section("Brush", ...rows)].filter(Boolean);
  if (kind === "icon" && o.asset && state.doc.assets[o.asset]) out.push(...styleSections(o, state.doc.assets[o.asset], { opacity: false }));
  out.push(glowSection(o), arrangeSection());
  return out;
}

/** Switch a brush to another pattern, giving it what that pattern needs (a freeform shape is a filled loop). */
function setBrushKind(x, v) {
  x.brush = v;
  x.thickness = BRUSHES[v].T;
  if (x.name && Object.values(BRUSHES).some((b) => b.name === x.name)) x.name = BRUSHES[v].name;
  if (v === "freeform") {
    x.closed = true;
    if (x.pts.length < 3) x.pts.splice(1, 0, bulge(x.pts[0], x.pts[x.pts.length - 1]));
    if (!x.fill || x.fill === "none") x.fill = "#d9ecf7";
    x.stroke ||= "#1d6fa5";
  }
  if (v === "arrow" && x.endHead == null) Object.assign(x, { startHead: "none", endHead: "arrow" });
}

/** A third point off the line between a and b, so a two-point path can close into a loop. */
function bulge(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  return [(a[0] + b[0]) / 2 - (dy / l) * l * 0.6, (a[1] + b[1]) / 2 + (dx / l) * l * 0.6];
}

/* ---------- legends and scale bars ---------- */

/**
 * Change a legend or scale bar (the one shown, by id: undo replaces objects) and size it to its new
 * content; its anchor stays put (the legend's top-left corner, the middle of the bar).
 */
function editFurniture(o, fn, live = false) {
  const x = getObj(o.id);
  if (!x || x.locked) return;
  const at = furnitureAnchor(x);
  fn(x);
  fitFurniture(x, at);
  renderDoc();
  if (!live) commit();
}

/** X, Y, rotation and opacity: legends and scale bars are sized by their content. */
function placeSection(o) {
  return section("Position",
    el("div.grid2", {},
      numField("X", o.x / MM, (v) => updateSel((x) => (x.x = v * MM)), { suffix: "mm" }),
      numField("Y", o.y / MM, (v) => updateSel((x) => (x.y = v * MM)), { suffix: "mm" }),
      numField("↻", o.rot || 0, (v) => updateSel((x) => (x.rot = ((v % 360) + 360) % 360)), { suffix: "°", step: 1, title: "Rotation" })),
    opacityRow(o));
}

/** Font, size, colour and bold. */
function furnitureTextRows(o, up) {
  const fam = el("select", {}, ...FONTS.map((f) => el("option", { value: f, selected: f === (o.fontFamily || "Arial"), style: { fontFamily: f } }, f)));
  fam.addEventListener("change", () => up((x) => (x.fontFamily = fam.value)));
  return [
    el("div.field", {}, fam),
    el("div.row", {},
      numField("Size", round((o.fontSize || 12) * 0.75, 1), (v) => up((x) => (x.fontSize = Math.max(1, v) / 0.75)), { suffix: "pt", step: 0.5, min: 1 }),
      swatchBtn(o.color || "#1c2733", (hex, final) => hex && up((x) => (x.color = hex), !final)),
      el("button.btn" + (o.bold ? ".on" : ""), { title: "Bold", onclick: () => up((x) => (x.bold = !x.bold)) }, "B")),
  ];
}

/** A line row's sample (arrow, inhibition…) for its swatch button. */
function lineSample(r) {
  const c = r.color || "#2b3440", hd = r.line?.head || "none", s = 7;
  return `<svg viewBox="0 0 30 16" aria-hidden="true"><path d="M3 8H${27 - s * (TRIM[hd] ?? 0)}" stroke="${c}" stroke-width="1.8" fill="none"${r.line?.dash ? ` stroke-dasharray="${dashArray(r.line.dash, 1.8)}"` : ""}/>${head(hd, [27, 8], [1, 0], s, c, 1.8)}</svg>`;
}

/** A picture of a colour square or line row, for the Add row menu. */
const rowPreview = (r) => "data:image/svg+xml," + encodeURIComponent(r.line
  ? lineSample(r).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')
  : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><rect x="8" y="8" width="14" height="14" rx="2" fill="${r.color || "#4aa9d0"}"/></svg>`);

/** A legend row's swatch: the icon as the legend draws it, or a button that recolours the square or line. */
function legendSwatch(o, r, i) {
  const kind = legendRowKind(r);
  if (kind === "icon") {
    const asset = state.doc.assets[r.asset];
    return el("span.lsw", { title: asset?.meta?.name || r.asset },
      asset ? el("img", { src: iconThumb({ asset: r.asset, labels: r.labels, colors: r.colors || {} }, asset), alt: "" }) : "?");
  }
  const b = el("button.lsw" + (kind === "line" ? ".line" : ".sq"), { title: "Change the colour", "aria-label": "Colour", html: kind === "line" ? lineSample(r) : "" });
  if (kind === "swatch") b.style.background = r.color || "#4aa9d0";
  b.addEventListener("click", () => pickColor(b, r.color, (hex, final) => {
    if (!hex) return;
    hex = normHex(hex);
    if (kind === "line") b.innerHTML = lineSample({ ...r, color: hex });
    else b.style.background = hex;
    editFurniture(o, (x) => x.rows[i] && (x.rows[i].color = hex), !final);
  }));
  return b;
}

/** Menu of rows to add: the figure's icons the legend doesn't list yet, then colour squares and arrows. */
function addRowMenu(o, anchor) {
  if (anchor.classList.contains("open")) return closeMenus();
  const miss = missingLegendRows(getObj(o.id) || o);
  const thumb = (r) => {
    const a = state.doc.assets[r.asset];
    return a ? iconThumb({ asset: r.asset, labels: r.labels, colors: r.colors || {} }, a) : null;
  };
  const items = [{ heading: "Icons in the figure" }];
  if (miss.length) items.push(...miss.map((r) => ({ label: r.label, img: thumb(r), run: () => editFurniture(o, (x) => x.rows.push(r)) })));
  else items.push({ label: "Every icon in the figure is listed", disabled: true });
  items.push("-", { heading: "Other rows" }, ...EXTRA_ROWS.map(([name, r]) => ({ label: name, img: rowPreview(r), run: () => editFurniture(o, (x) => x.rows.push(JSON.parse(JSON.stringify(r)))) })));
  const b = anchor.getBoundingClientRect();
  openMenu(items, b.left, b.bottom + 4, anchor);
}

const rowIcon = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ROW_ICON = { up: rowIcon("M4 10l4-4 4 4"), down: rowIcon("M4 6l4 4 4-4"), remove: rowIcon("M4.5 4.5l7 7M11.5 4.5l-7 7") };

function legendSections(o) {
  const rows = o.rows || [];
  const up = (fn, live) => editFurniture(o, fn, live);
  const list = el("div.lrows", {}, ...rows.map((r, i) => {
    const inp = el("input.num.lname", { value: r.label || "", placeholder: "Label", "data-row": i, "aria-label": `Row ${i + 1} label` });
    inp.addEventListener("input", () => up((x) => x.rows[i] && (x.rows[i].label = inp.value), true));
    inp.addEventListener("change", () => commit());
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") inp.blur();
    });
    const move = (d) => up((x) => x.rows.splice(i + d, 0, ...x.rows.splice(i, 1)));
    return el("div.lrow", { "data-row": i }, legendSwatch(o, r, i), inp,
      el("button.lbtn", { title: "Move up", "aria-label": "Move up", disabled: i === 0, onclick: () => move(-1), html: ROW_ICON.up }),
      el("button.lbtn", { title: "Move down", "aria-label": "Move down", disabled: i === rows.length - 1, onclick: () => move(1), html: ROW_ICON.down }),
      el("button.lbtn", { title: rows.length < 2 ? "A legend keeps at least one row" : "Remove this row", "aria-label": "Remove", disabled: rows.length < 2, onclick: () => up((x) => x.rows.splice(i, 1)), html: ROW_ICON.remove }));
  }));
  const add = el("button.btn.small", { title: "Add an icon from the figure, a colour square or an arrow", onclick: () => addRowMenu(o, add) }, "+ Add row");
  const sync = el("button.btn.small", {
    title: "Add every icon in the figure that the legend doesn't list yet",
    onclick: () => {
      const miss = missingLegendRows(getObj(o.id) || o);
      if (!miss.length) return toast("The legend already lists every icon in the figure");
      up((x) => x.rows.push(...miss));
      toast(`Added ${miss.length} row${miss.length > 1 ? "s" : ""}`);
    },
  }, "Update from figure");
  const title = el("input.num", { value: o.title || "", placeholder: "Title (optional)" });
  title.addEventListener("input", () => up((x) => (title.value ? (x.title = title.value) : delete x.title), true));
  title.addEventListener("change", () => commit());
  title.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") title.blur();
  });
  return [
    section(["Legend", sync], list, el("div.row", {}, add, el("span.small.muted", {}, "or double-click a row on the page")), el("div.field", {}, title)),
    section("Style",
      ...furnitureTextRows(o, up),
      numField("Icon size", (o.iconSize || (o.fontSize || 12) * 2) / MM, (v) => up((x) => (x.iconSize = Math.max(0.5, v) * MM)), { suffix: "mm", step: 0.5, min: 0.5, wide: true, title: "Size of the icon swatches" }),
      numField("Columns", o.columns || 1, (v) => up((x) => (x.columns = clamp(Math.round(v), 1, 8))), { step: 1, min: 1, wide: true, title: "Rows fill the first column, then the next" }),
      el("div.row.wrap", {},
        el("button.btn" + (o.border ? ".on" : ""), { title: "A thin frame around the legend", onclick: () => up((x) => (x.border ? delete x.border : (x.border = "#9aa5b1"))) }, "Border"),
        o.border ? swatchBtn(o.border === true ? "#9aa5b1" : o.border, (hex, final) => hex && up((x) => (x.border = hex), !final)) : null,
        el("span.small.muted", { style: { marginLeft: "8px" } }, "Background"),
        swatchBtn(o.fill && o.fill !== "none" ? o.fill : null, (hex, final) => up((x) => (hex ? (x.fill = hex) : delete x.fill), !final), { allowNone: true }))),
    placeSection(o),
    arrangeSection(),
  ];
}

function scalebarSections(o) {
  const up = (fn, live) => editFurniture(o, fn, live);
  const unit = el("select", { title: "Units" }, ...UNITS.map((u) => el("option", { value: u, selected: u === (o.unit || "µm") }, u)));
  unit.addEventListener("change", () => up((x) => (x.unit = unit.value)));
  const value = numField("Length", o.value ?? 10, (v) => up((x) => (x.value = v)), { min: 0, step: 1, wide: true, title: "The length the bar stands for" });
  value.querySelector("input").dataset.f = "value";
  const pos = (v, label) => el("button" + ((o.labelPos || "above") === v ? ".on" : ""), { onclick: () => up((x) => (x.labelPos = v)) }, label);
  return [
    section("Scale bar",
      el("div.row.sb-len", {}, value, unit),
      numField("Bar on page", (o.length ?? 15 * MM) / MM, (v) => up((x) => (x.length = Math.max(0.2, v) * MM)), { suffix: "mm", step: 0.5, min: 0.2, wide: true, title: "How long the bar is drawn on the page" }),
      el("div.field.wide", {}, el("label", {}, "Label"), el("div.seg.sb-pos", {}, pos("above", "Above"), pos("below", "Below"), pos("none", "None"))),
      el("div.row", {},
        el("span.small.muted", { style: { width: "40px", flex: "none" } }, "Colour"),
        swatchBtn(o.color || "#1c2733", (hex, final) => hex && up((x) => (x.color = hex), !final)),
        numField("Bar", (o.thickness ?? 3) * 0.75, (v) => up((x) => (x.thickness = Math.max(0.1, v) / 0.75)), { suffix: "pt", step: 0.25, min: 0.1, title: "Thickness of the bar" })),
      el("div.row", {},
        numField("Text", round((o.fontSize || 12) * 0.75, 1), (v) => up((x) => (x.fontSize = Math.max(1, v) / 0.75)), { suffix: "pt", step: 0.5, min: 1 }),
        el("button.btn" + (o.bold ? ".on" : ""), { title: "Bold", onclick: () => up((x) => (x.bold = !x.bold)) }, "B")),
      el("div.small.muted", {}, "Set the bar on the page to match your image, or drag its side handles; the label keeps its value.")),
    placeSection(o),
    arrangeSection(),
  ];
}

/** Double-clicking a legend or scale bar (or inserting one) shows its settings; a row's label gets the focus. */
function editFurnitureFocus({ row = -1, focus = true } = {}) {
  if (focus) revealPanel("inspector"); // (a double-click asks for the settings, even with the panel collapsed)
  if (tab !== "design") showTab("design");
  if (!focus) return;
  const pane = $("#tab-design");
  const t = row >= 0 ? pane.querySelector(`.lname[data-row="${row}"]`) : pane.querySelector(".lname, [data-f=value]");
  if (!t) return;
  t.scrollIntoView({ block: "nearest" });
  t.focus();
  t.select?.();
}

function designTab() {
  const objs = selectedObjs();
  if (!objs.length) return docSection();
  if (objs.length > 1) {
    // several copies of one icon share the Style panel; glowing kinds share the glow
    const o = objs[0], asset = o.type === "icon" ? state.doc.assets[o.asset] : null;
    const sameIcon = !!asset && objs.every((x) => x.type === "icon" && x.asset === o.asset && !x.locked);
    const glow = objs.every((x) => canGlow(x) && !x.locked);
    return [section(sameIcon ? `${objs.length} × ${asset.meta?.name || "icon"}` : `${objs.length} objects selected`, el("div.row.wrap", {},
      el("button.btn", { onclick: groupSel }, "Group"),
      el("button.btn", { onclick: () => flipSel("h") }, "Flip H"),
      el("button.btn", { onclick: () => flipSel("v") }, "Flip V")),
      el("div.row", {}, el("button.btn", { onclick: saveSelectionToLibrary, title: "Keep these objects as one icon in My library" }, "Save to My library"))),
    ...(sameIcon ? styleSections(o, asset) : []),
    // several shapes share the shape styles
    objs.every((x) => isShape(x) && !x.locked) ? shapePresetSection(o) : null,
    glow ? glowSection(o) : null,
    arrangeSection(true)].filter(Boolean);
  }
  const o = objs[0];
  if (o.locked) {
    return [section("Locked", el("div.meta-line", {}, `This ${o.type} is locked.`), el("button.btn", { onclick: toggleLock }, "Unlock"))];
  }
  switch (o.type) {
    case "icon": return [...iconSections(o), transformSection(o, !state.doc.assets[o.asset]), arrangeSection(),
      section("Reuse", el("div.row.wrap", {},
        el("button.btn", { title: "Paint this icon along a path you can bend and extend", onclick: () => brushWithIcon(o.asset) }, "Repeat along a path"),
        el("button.btn", { title: "Keep a copy (with your colours) in My library", onclick: saveSelectionToLibrary }, "Save to My library")))];
    case "text": return [...textSections(o), arrangeSection()];
    case "rect":
    case "ellipse": return [...shapeSections(o), arrangeSection()];
    case "line": return lineSections(o);
    case "membrane": return brushSections(o);
    case "image": return [section("Picture", el("div.meta-line", {}, "Embedded bitmap image")), transformSection(o), arrangeSection()];
    case "legend": return legendSections(o);
    case "scalebar": return scalebarSections(o);
    case "group": return [section("Group", el("div.meta-line", {}, `${o.children.length} objects`), el("div.row.wrap", {}, el("button.btn", { onclick: ungroupSel }, "Ungroup"), el("button.btn", { onclick: saveSelectionToLibrary, title: "Keep this group as one icon in My library" }, "Save to My library")), opacityRow(o)), arrangeSection()];
  }
  return [];
}

/* ---------- Layers tab ---------- */

const TYPE_GLYPH = { text: "T", rect: "▭", ellipse: "◯", line: "↗", membrane: "≋", image: "🖼", group: "▣", legend: "☷", scalebar: "⊢" };
const BRUSH_GLYPH = { arrow: "↝", freeform: "⬠" };

function layerName(o, depth = 0) {
  if (o.name) return o.name;
  if (o.type === "text") return o.text.split("\n")[0].slice(0, 40) || "Text";
  if (o.type === "line") {
    const base = o.endHead === "bar" ? "Inhibition" : o.endHead !== "none" || o.startHead !== "none" ? "Arrow" : "Line";
    // a connector says what it joins
    const ends = [o.from, o.to].map((e) => e && findObj(e.id));
    if (depth || !ends.some(Boolean)) return base;
    return `${base}: ${ends.map((t) => (t ? layerName(t, 1) : "…")).join(" → ")}`;
  }
  if (o.type === "scalebar") return "Scale bar " + scaleLabel(o);
  if (o.type === "legend") return o.title?.trim() ? "Legend: " + o.title.trim() : "Legend";
  return o.type[0].toUpperCase() + o.type.slice(1);
}

const expanded = new Set(); // icons whose colour parts are listed in Layers
const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** An icon's colour parts as child rows of its layer; clicking one opens its colour in the Style panel. */
function partRows(o, asset) {
  return partInfo(o.asset, asset).parts.map((p) => {
    const hex = partColor(o, asset.slots[p.i]);
    return el("div.layer.part-row", { "data-id": o.id, "data-part": p.i, title: `Recolour “${p.name}”`, onclick: () => editPart(o.id, p.i) },
      el("span.swatch.mini", { style: { background: hex } }),
      el("span.nm", {}, p.name),
      el("span.hex", {}, hex));
  });
}

function layersTab() {
  const list = el("div");
  const objs = [...state.doc.objects].reverse();
  if (!objs.length) list.append(el("div.section", {}, el("div.muted", {}, "No objects yet")));
  for (const o of objs) {
    const asset = o.type === "icon" ? state.doc.assets[o.asset] : null;
    // recoloured icons are drawn as they look; others use the library thumbnail
    const thumb = asset && Object.keys(o.colors || {}).length ? el("img", { src: iconThumb(o, asset) })
      : asset?.meta?.thumb ? el("img", { src: libUrl(asset.meta.thumb) }) : el("span.muted", {}, (o.type === "membrane" && BRUSH_GLYPH[o.brush]) || TYPE_GLYPH[o.type] || "•");
    const hasParts = !!asset?.slots?.length;
    const open = hasParts && expanded.has(o.id);
    const twisty = hasParts
      ? el("button.twisty" + (open ? ".open" : ""), {
        title: open ? "Hide the colour parts" : "Show the colour parts", "aria-expanded": open ? "true" : "false", html: CHEVRON,
        onclick: (e) => {
          e.stopPropagation();
          if (open) expanded.delete(o.id);
          else expanded.add(o.id);
          refresh();
        },
      })
      : el("span.twisty");
    const row = el("div.layer" + (state.selection.includes(o.id) ? ".sel" : "") + (o.hidden ? ".hidden-obj" : ""), { draggable: "true", "data-id": o.id },
      twisty,
      el("div.thumb", {}, thumb),
      el("span.nm", { title: "Double-click to rename" }, layerName(o)),
      el("button", { title: o.hidden ? "Show" : "Hide", onclick: (e) => { e.stopPropagation(); o.hidden = !o.hidden; renderDoc(); commit(); } }, o.hidden ? "◌" : "👁"),
      el("button", { title: o.locked ? "Unlock" : "Lock", onclick: (e) => { e.stopPropagation(); o.locked = !o.locked; renderDoc(); commit(); } }, o.locked ? "🔒" : "🔓"));
    row.addEventListener("click", (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) setSelection(state.selection.includes(o.id) ? state.selection.filter((s) => s !== o.id) : [...state.selection, o.id]);
      else setSelection([o.id]);
    });
    row.addEventListener("dblclick", () => {
      const nm = row.querySelector(".nm");
      const inp = el("input.num", { value: layerName(o) });
      nm.replaceWith(inp);
      inp.focus();
      inp.select();
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") inp.blur();
      });
      inp.addEventListener("blur", () => {
        o.name = inp.value.trim();
        commit();
      });
    });
    row.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/layer", o.id));
    row.addEventListener("dragover", (e) => e.preventDefault());
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/layer");
      if (!id || id === o.id) return;
      const arr = state.doc.objects;
      const from = arr.findIndex((x) => x.id === id);
      const [moved] = arr.splice(from, 1);
      const to = arr.findIndex((x) => x.id === o.id);
      arr.splice(to + 1, 0, moved); // dropping on a row puts the layer above it
      renderDoc();
      commit();
    });
    list.append(row);
    if (open) list.append(...partRows(o, asset));
  }
  return [list];
}

/* ---------- Credits tab ---------- */

function creditsTab() {
  const byPack = creditsInfo();
  if (!byPack.size) return [section("Credits", el("div.meta-line", {}, "Icons you add appear here with their source and licence, and the figure-legend text is written for you."))];
  const out = [];
  const txt = el("textarea.txt.credit-text", { readonly: true }, legendText());
  out.push(section(["Figure legend", el("span.credit-btns", {},
    el("button.btn.small", { onclick: () => { navigator.clipboard.writeText(txt.value); toast("Copied to clipboard"); } }, "Copy"),
    el("button.btn.small", { onclick: exportLicenceReport, title: "Every icon's source, author and licence, what the licences ask of you and what you changed — as PDF, Markdown and CSV" }, "Licence report (PDF)…"))], txt,
    el("div.small.muted", {}, "CC BY and MIT licences require this credit; CC BY icons you changed are credited as “adapted from”. Public-domain and CC0 icons don't need it, but citing them is good practice.")));
  for (const [pack, g] of byPack) {
    out.push(section(g.name, ...g.items.map(({ meta: m, changes }) =>
      el("div.credit-item", {}, m.thumb ? el("img", { src: libUrl(m.thumb) }) : null,
        el("div.meta-line", {}, el("b", {}, m.name), el("br"), licBadge(m.license), m.author ? ` ${m.author}` : "",
          m.source_url ? el("span", {}, " · ", el("a", { onclick: () => openLink(m.source_url) }, "source")) : null,
          changes.length ? el("div.small.muted", { title: "Changed from the library drawing" }, "Changed: " + changes.join(", ")) : null)))));
  }
  return out;
}

export function openLink(url) {
  api("app.openExternal", { url }).catch(() => window.open(url, "_blank"));
}

/* ---------- wiring ---------- */

let tab = "design";

export function refresh() {
  endPreview(); // a hovered preset never outlives its panel
  endShapePreview();
  const pane = $("#tab-" + tab);
  const make = { design: designTab, layers: layersTab, credits: creditsTab }[tab];
  const scroll = pane.scrollTop;
  pane.replaceChildren(...make());
  pane.scrollTop = scroll;
}

export function showTab(t) {
  tab = t;
  $$("#inspector .tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  $$("#inspector .tab").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t));
  refresh();
}

export function initPanels() {
  $$("#inspector .tabs [data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  bus.on("selection", refresh);
  bus.on("edit-furniture", editFurnitureFocus);
  bus.on("history", () => {
    // don't rebuild under the user's cursor while they type in the panel
    const a = document.activeElement;
    if (a && $("#inspector").contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    refresh();
  });
  refresh();
}
