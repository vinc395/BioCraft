// Editing commands shared by menus, shortcuts and panels.

import { api } from "./api.js";
import {
  state, getObj, selectedObjs, setSelection, docPx, bbox, selectionBox, moveObj, flipObj,
  rotateObjAbout, scaleObjAbout, cloneObjs, commit, isBox, MM, assetsUsed, detachConnectors, isFurniture, scaleFurniture, endPreviews,
} from "./model.js";
import { renderDoc, viewCenter, setTool } from "./canvas.js";
import { measureText, iconParts, assetParts, fitFurniture } from "./render.js";
import { labelInfo, hasLabels } from "./labels.js";
import { slotColorMap, overlayMap, grayMap, parseHex, toLch, normHex } from "./color.js";
import { applyPreset, setIconColors } from "./style.js";
import { bus, toast, uid, rotPt } from "./util.js";
import { copyPicture } from "./clipimage.js";

const assetCache = new Map();

/** Load a library icon into the document's assets (once) and return the asset. */
export async function loadAsset(id) {
  if (state.doc.assets[id]) return state.doc.assets[id];
  let data = assetCache.get(id);
  if (!data) {
    data = await api("library.icon", { id });
    assetCache.set(id, data);
  }
  const asset = assetFromIcon(data);
  state.doc.assets[id] = asset;
  return asset;
}

/** A document asset from a `library.icon` reply. */
export function assetFromIcon(data) {
  const m = data.meta;
  return {
    svg: data.svg,
    w: m.w,
    h: m.h,
    slots: m.slots || [],
    raster: m.raster,
    meta: {
      id: m.id, name: m.name, pack: m.pack, author: m.author, license: m.license,
      source_url: m.source_url, thumb: m.thumb, category: m.category,
      packName: data.pack?.name || m.pack, packCredit: data.pack?.credit || "", packUrl: data.pack?.url || "",
      variants: (data.variants || []).map((v) => ({ id: v.id, name: v.name, thumb: v.thumb })),
    },
  };
}

/** Add a library icon centred at `at` (document px), sized to a quarter of the shorter page side. */
export async function placeIcon(id, at = null) {
  try {
    const asset = await loadAsset(id);
    const { w: pw, h: ph } = docPx();
    const size = Math.min(pw, ph) * 0.22;
    const ar = asset.w / asset.h;
    const w = ar >= 1 ? size : size * ar, h = ar >= 1 ? size / ar : size;
    let [cx, cy] = at || viewCenter();
    if (!at) {
      // don't stack repeated clicks exactly on top of each other
      const step = 6 * MM;
      for (let i = 0; i < 12 && state.doc.objects.some((o) => o.type === "icon" && Math.abs(o.x + o.w / 2 - cx) < 2 && Math.abs(o.y + o.h / 2 - cy) < 2); i++) {
        cx += step;
        cy += step;
      }
    }
    const o = { id: uid(), type: "icon", asset: id, name: asset.meta.name, x: cx - w / 2, y: cy - h / 2, w, h, rot: 0, colors: {}, slotColors: [] };
    state.doc.objects.push(o);
    setSelection([o.id]);
    renderDoc();
    commit();
    api("library.recent", { id }).catch(() => {});
    bus.emit("library-recent");
    return o;
  } catch (e) {
    toast("Could not add icon: " + e.message, true);
  }
}

/** Place an SVG string (dropped/pasted file) as a recolourable icon. */
export async function placeSvgText(svg, name = "Imported SVG", at = null) {
  try {
    const c = await api("svg.clean", { svg });
    const id = "file/" + uid("f");
    state.doc.assets[id] = {
      svg: c.svg, w: c.w, h: c.h, slots: c.slots || [], raster: c.raster,
      meta: { id, name, pack: "file", author: "You", license: "USER", source_url: "", packName: "Your file" },
    };
    const { w: pw, h: ph } = docPx();
    const s = Math.min(1, (Math.min(pw, ph) * 0.5) / Math.max(c.w, c.h));
    const [cx, cy] = at || viewCenter();
    const o = { id: uid(), type: "icon", asset: id, name, x: cx - (c.w * s) / 2, y: cy - (c.h * s) / 2, w: c.w * s, h: c.h * s, rot: 0, colors: {}, slotColors: [] };
    state.doc.objects.push(o);
    setSelection([o.id]);
    renderDoc();
    commit();
  } catch (e) {
    toast("Could not read SVG: " + e.message, true);
  }
}

export function placeImage(dataUrl, name = "Image", at = null) {
  const img = new Image();
  img.onload = () => {
    const { w: pw, h: ph } = docPx();
    let w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, (Math.min(pw, ph) * 0.6) / Math.max(w, h));
    w *= s;
    h *= s;
    const [cx, cy] = at || viewCenter();
    const o = { id: uid(), type: "image", name, src: dataUrl, x: cx - w / 2, y: cy - h / 2, w, h, rot: 0 };
    state.doc.objects.push(o);
    setSelection([o.id]);
    renderDoc();
    commit();
  };
  img.onerror = () => toast("That image format can't be placed", true);
  img.src = dataUrl;
}

/** Place files from a drop or file picker: SVGs as icons, pictures as images, figures opened. */
export async function placeFiles(files, at = null, openDoc = null) {
  for (const f of files) {
    const name = f.name.replace(/\.[^.]+$/, "");
    if (/\.(biocraft|biocanvas|json)$/i.test(f.name) && openDoc) {
      openDoc(await f.text(), null, f.name);
      return;
    }
    if (/\.svgz?$/i.test(f.name) || f.type === "image/svg+xml") await placeSvgText(await f.text(), name, at);
    else if (f.type.startsWith("image/")) {
      const url = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(f);
      });
      placeImage(url, name, at);
    }
  }
}

/* ---------- clipboard ---------- */

let clip = null;

export function copySel() {
  endPreviews(); // copy the styles that are applied, not one being previewed
  const objs = selectedObjs();
  if (!objs.length) return false;
  const assets = {};
  for (const id of assetsUsed(objs)) assets[id] = state.doc.assets[id];
  clip = { objects: JSON.parse(JSON.stringify(objs)), assets };
  // and a picture of them on the system clipboard, for PowerPoint, Word, Teams…
  copyPicture(objs);
  return true;
}

export function cutSel() {
  if (copySel()) deleteSel();
}

export const hasClip = () => !!clip?.objects.length;

/** Paste the copied objects, offset from the originals or centred on `at` (document px). */
export function pasteClip(offset = 10, at = null) {
  if (!clip) return false;
  Object.assign(state.doc.assets, Object.fromEntries(Object.entries(clip.assets).filter(([k]) => !state.doc.assets[k])));
  const objs = unlocked(cloneObjs(clip.objects));
  const b = selectionBox(objs);
  const [dx, dy] = at ? [at[0] - (b.x + b.w / 2), at[1] - (b.y + b.h / 2)] : [offset, offset];
  objs.forEach((c) => moveObj(c, dx, dy));
  state.doc.objects.push(...objs);
  clip.objects = objs.map((o) => JSON.parse(JSON.stringify(o))); // successive pastes cascade
  setSelection(objs.map((o) => o.id));
  renderDoc();
  commit();
  return true;
}

/** Copies are free to move and edit, also copies of locked objects. */
function unlocked(copies) {
  for (const c of copies) delete c.locked;
  return copies;
}

export function duplicateSel() {
  endPreviews(); // duplicate the styles that are applied, not one being previewed
  const objs = selectedObjs();
  if (!objs.length) return;
  const copies = unlocked(cloneObjs(objs));
  copies.forEach((c) => moveObj(c, 12, 12));
  state.doc.objects.push(...copies);
  setSelection(copies.map((c) => c.id));
  renderDoc();
  commit();
}

export function deleteSel() {
  const ids = new Set(selectedObjs().filter((o) => !o.locked).map((o) => o.id));
  if (!ids.size) return;
  state.doc.objects = state.doc.objects.filter((o) => !ids.has(o.id));
  setSelection([]);
  renderDoc();
  commit();
}

export function selectAll() {
  setSelection(state.doc.objects.filter((o) => !o.locked && !o.hidden).map((o) => o.id));
}

/** What "Select all same icons" matches: the library icon, or for other objects their type and look. */
export function sameKey(o) {
  switch (o.type) {
    case "icon": return "icon " + o.asset;
    case "membrane": return `brush ${o.brush || "bilayer"} ${o.asset || ""}`;
    case "text": return `text ${o.fontFamily || "Arial"} ${Math.round(o.fontSize * 10)} ${o.color || ""} ${!!o.bold} ${!!o.italic}`;
    case "rect":
    case "ellipse": return `${o.type} ${o.fill || "none"} ${o.stroke || "none"} ${o.strokeWidth ?? 1.5} ${o.dash || ""}`;
    case "line": return `line ${o.stroke || ""} ${o.strokeWidth ?? 2} ${o.dash || ""} ${o.startHead || "none"} ${o.endHead || "none"}`;
    case "image": return `image ${o.src.length} ${o.src.slice(-64)}`;
    default: return o.type;
  }
}

/** Ids of the visible, unlocked objects that look like the given ones (they stay selected even if locked). */
export function sameIds(objs = selectedObjs()) {
  const keys = new Set(objs.map(sameKey));
  const keep = new Set(objs.map((o) => o.id));
  return state.doc.objects.filter((o) => !o.hidden && (!o.locked || keep.has(o.id)) && keys.has(sameKey(o))).map((o) => o.id);
}

export function selectSame() {
  if (state.selection.length) setSelection(sameIds());
}

/** The Select… submenu: object kinds that can be selected in one go. */
export const SELECT_KINDS = [
  ["icons", "All icons", (o) => o.type === "icon"],
  ["text", "All text", (o) => o.type === "text"],
  ["lines", "All arrows and lines", (o) => o.type === "line" || (o.type === "membrane" && o.brush === "arrow")],
  ["shapes", "All shapes", (o) => o.type === "rect" || o.type === "ellipse"],
  ["brushes", "All brushes", (o) => o.type === "membrane"],
  ["locked", "All locked", (o) => !!o.locked],
];

/** Ids of the visible objects of one kind (locked ones only for "locked"). */
export function kindIds(kind) {
  const test = SELECT_KINDS.find(([k]) => k === kind)?.[2];
  if (!test) return [];
  return state.doc.objects.filter((o) => !o.hidden && (kind === "locked" || !o.locked) && test(o)).map((o) => o.id);
}

export function selectKind(kind) {
  setSelection(kindIds(kind));
}

export function invertSelection() {
  const sel = new Set(state.selection);
  setSelection(state.doc.objects.filter((o) => !o.hidden && !o.locked && !sel.has(o.id)).map((o) => o.id));
}

export function nudge(dx, dy) {
  const objs = selectedObjs().filter((o) => !o.locked);
  if (!objs.length) return;
  detachConnectors(objs);
  objs.forEach((o) => moveObj(o, dx, dy));
  renderDoc();
  commitSoon();
}

let commitTimer;
function commitSoon() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commit, 350);
}

/* ---------- grouping & order ---------- */

export function groupSel() {
  const objs = state.doc.objects.filter((o) => state.selection.includes(o.id));
  if (objs.length < 2) return;
  const top = Math.max(...objs.map((o) => state.doc.objects.indexOf(o)));
  const g = { id: uid(), type: "group", name: "Group", children: objs };
  const rest = state.doc.objects.filter((o) => !objs.includes(o));
  const at = top - objs.length + 1;
  rest.splice(at, 0, g);
  state.doc.objects = rest;
  setSelection([g.id]);
  renderDoc();
  commit();
}

export function ungroupSel() {
  const out = [];
  let changed = false;
  const sel = [];
  for (const o of state.doc.objects) {
    if (o.type === "group" && state.selection.includes(o.id)) {
      out.push(...o.children);
      sel.push(...o.children.map((c) => c.id));
      changed = true;
    } else out.push(o);
  }
  if (!changed) return;
  state.doc.objects = out;
  setSelection(sel);
  renderDoc();
  commit();
}

export function arrange(how) {
  const objs = state.doc.objects;
  const sel = new Set(state.selection);
  if (!sel.size) return;
  let next;
  if (how === "front") next = [...objs.filter((o) => !sel.has(o.id)), ...objs.filter((o) => sel.has(o.id))];
  else if (how === "back") next = [...objs.filter((o) => sel.has(o.id)), ...objs.filter((o) => !sel.has(o.id))];
  else {
    next = objs.slice();
    const idx = next.map((o, i) => (sel.has(o.id) ? i : -1)).filter((i) => i >= 0);
    if (how === "forward") {
      for (const i of idx.reverse()) if (i < next.length - 1 && !sel.has(next[i + 1].id)) [next[i], next[i + 1]] = [next[i + 1], next[i]];
    } else {
      for (const i of idx) if (i > 0 && !sel.has(next[i - 1].id)) [next[i], next[i - 1]] = [next[i - 1], next[i]];
    }
  }
  state.doc.objects = next;
  renderDoc();
  commit();
}

/* ---------- align, distribute, flip ---------- */

export function align(how) {
  const objs = selectedObjs().filter((o) => !o.locked);
  if (!objs.length) return;
  const page = docPx();
  const ref = objs.length === 1 ? { x: 0, y: 0, w: page.w, h: page.h } : selectionBox(objs);
  detachConnectors(objs);
  for (const o of objs) {
    const b = bbox(o);
    let dx = 0, dy = 0;
    if (how === "left") dx = ref.x - b.x;
    if (how === "hcenter") dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    if (how === "right") dx = ref.x + ref.w - (b.x + b.w);
    if (how === "top") dy = ref.y - b.y;
    if (how === "vcenter") dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    if (how === "bottom") dy = ref.y + ref.h - (b.y + b.h);
    moveObj(o, dx, dy);
  }
  renderDoc();
  commit();
}

export function distribute(axis) {
  const objs = selectedObjs().filter((o) => !o.locked);
  if (objs.length < 3) return toast("Select three or more objects to distribute");
  detachConnectors(objs);
  const items = objs.map((o) => ({ o, b: bbox(o) }));
  const k = axis === "h" ? "x" : "y", s = axis === "h" ? "w" : "h";
  items.sort((a, b) => a.b[k] - b.b[k]);
  const first = items[0].b, last = items[items.length - 1].b;
  const total = items.reduce((a, it) => a + it.b[s], 0);
  const gap = (last[k] + last[s] - first[k] - total) / (items.length - 1);
  let pos = first[k];
  for (const it of items) {
    const d = pos - it.b[k];
    if (axis === "h") moveObj(it.o, d, 0);
    else moveObj(it.o, 0, d);
    pos += it.b[s] + gap;
  }
  renderDoc();
  commit();
}

export function flipSel(axis) {
  const objs = selectedObjs().filter((o) => !o.locked);
  if (!objs.length) return;
  const b = selectionBox(objs);
  detachConnectors(objs);
  for (const o of objs) flipObj(o, axis, b.x + b.w / 2, b.y + b.h / 2);
  renderDoc();
  commit();
}

/**
 * Set the selection's position, size or rotation (document px, degrees) from the Transform fields.
 * One box object: x/y are its top-left, w/h resize about its centre (`keep` scales the other side too;
 * text, legends and scale bars always keep their proportions)
 * and rot is absolute. Anything else: x/y/w/h are the selection bounds, sizes scale about their
 * centre, and "rotBy" turns everything about the centre.
 */
export function transformSel(prop, value, keep = true) {
  const objs = selectedObjs().filter((o) => !o.locked && !o.hidden);
  if (!objs.length || !Number.isFinite(value)) return;
  detachConnectors(objs);
  const one = objs.length === 1 && isBox(objs[0]) ? objs[0] : null;
  if (one) {
    const o = one, cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    if (prop === "x") o.x = value;
    else if (prop === "y") o.y = value;
    else if (prop === "rot" || prop === "rotBy") o.rot = ((((prop === "rot" ? 0 : o.rot || 0) + value) % 360) + 360) % 360;
    else if (prop === "w" || prop === "h") {
      const s = Math.max(0.1, value) / o[prop];
      if (o.type === "text") {
        o.fontSize = Math.max(1, o.fontSize * s);
        measureText(o);
      } else if (isFurniture(o)) {
        scaleFurniture(o, s);
        fitFurniture(o);
      } else {
        o[prop] *= s;
        if (keep) o[prop === "w" ? "h" : "w"] *= s;
      }
      o.x = cx - o.w / 2;
      o.y = cy - o.h / 2;
    }
  } else {
    const b = selectionBox(objs), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (prop === "x" || prop === "y") objs.forEach((o) => moveObj(o, prop === "x" ? value - b.x : 0, prop === "y" ? value - b.y : 0));
    else if (prop === "rotBy" || prop === "rot") objs.forEach((o) => rotateObjAbout(o, cx, cy, value));
    else if (prop === "w" || prop === "h") {
      const s = Math.max(0.1, value) / (b[prop] || 1);
      // rotated boxes keep their shape only under uniform scaling (as with the corner handles)
      const uniform = keep || objs.some((o) => isBox(o) && o.rot);
      const sx = prop === "w" || uniform ? s : 1, sy = prop === "h" || uniform ? s : 1;
      objs.forEach((o) => scaleObjAbout(o, cx, cy, sx, sy));
    }
  }
  renderDoc();
  commit();
}

export function toggleLock() {
  const objs = selectedObjs();
  const lock = !objs.every((o) => o.locked);
  objs.forEach((o) => (o.locked = lock));
  renderDoc();
  commit();
  bus.emit("selection");
}

/** Change properties of every selected object (used by the inspector). */
export function updateSel(fn, live = false) {
  const objs = selectedObjs();
  for (const o of objs) {
    fn(o);
    if (o.type === "text") measureText(o);
  }
  renderDoc();
  if (!live) commit();
}

export { isBox, getObj, MM };

/* ---------- replace ---------- */

/**
 * An icon's overall tint: "#hex", "gray" or null. Figures saved before tints were recorded are
 * read from the colour map (a recolour with no per-part colours is a tint or greyscale).
 */
export function iconTint(o, asset) {
  if (o.tint) return o.tint;
  const cols = Object.values(o.colors || {});
  if (!cols.length || o.slotColors?.some(Boolean) || !asset?.slots?.length) return null;
  if (cols.every((h) => {
    const p = parseHex(h);
    return p && toLch(p)[1] < 0.004;
  })) return "gray";
  const main = [...asset.slots].filter((s) => s.kind === "color").sort((a, b) => b.weight - a.weight)[0] || asset.slots[0];
  return normHex(o.colors[main.base.toLowerCase()]) || null;
}

/**
 * Swap an icon object's drawing for `asset` in place. It keeps its centre, rotation, flips and
 * opacity and is fitted into the old box (same width or height, aspect kept). With `colors`, part
 * colours carry over when both drawings have as many parts, otherwise an overall tint does.
 */
export function replaceIconObj(o, id, asset, { colors = true } = {}) {
  const old = state.doc.assets[o.asset];
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const [, , vw, vh] = assetParts(id, asset).vb;
  const ar = vw / vh || 1;
  const [w, h] = ar >= o.w / o.h ? [o.w, o.w / ar] : [o.h * ar, o.h];
  // a colour preset is re-made for the new drawing's parts; otherwise part colours, then a tint
  const preset = colors && o.preset && o.preset !== "original" && asset.slots?.length ? o.preset : null;
  const parts = colors && !preset && o.slotColors?.some(Boolean) && (old?.slots?.length || 0) === (asset.slots?.length || 0) ? [...o.slotColors] : null;
  const tint = colors && !preset && !parts ? iconTint(o, old) : null;
  const adjust = { saturation: o.saturation, lightness: o.lightness };
  if (!o.name || o.name === old?.meta?.name) o.name = asset.meta?.name || o.name;
  Object.assign(o, { asset: id, x: cx - w / 2, y: cy - h / 2, w, h });
  delete o.labels; // the new box is sized from the whole drawing
  delete o.tint;
  delete o.preset;
  delete o.baseColors;
  if (preset && applyPreset(o, preset, asset)) {
    // applyPreset starts from the plain preset: keep the saturation/lightness
  } else if (parts) {
    o.slotColors = parts;
    o.colors = slotColorMap(asset.slots, parts);
  } else if (tint) {
    o.slotColors = [];
    o.colors = tint === "gray" ? grayMap(asset.slots || []) : overlayMap(asset.slots || [], tint);
    o.tint = tint;
  } else {
    o.colors = {};
    o.slotColors = [];
  }
  if (adjust.saturation != null) o.saturation = adjust.saturation;
  if (adjust.lightness != null) o.lightness = adjust.lightness;
  setIconColors(o, o.colors, asset);
  return o;
}

/** Selected icons that Replace would change. */
export const replaceable = (objs = selectedObjs()) => objs.filter((o) => o.type === "icon" && !o.locked);

/**
 * Replace icons with library icon `id` in one undo step (variants: `colors: false` shows their own
 * colours). The icons are looked up by id when the drawing has loaded: menus and dialogs hold on to
 * objects that undo or redo may since have put new copies in place of.
 */
export async function replaceIcons(id, objs = replaceable(), opts = {}) {
  if (!objs.length) return;
  try {
    const asset = await loadAsset(id);
    objs = replaceable(objs.map((o) => getObj(o.id)).filter(Boolean));
    if (!objs.length) return;
    for (const o of objs) replaceIconObj(o, id, asset, opts);
    renderDoc();
    commit();
    bus.emit("selection");
    api("library.recent", { id }).catch(() => {});
    bus.emit("library-recent");
  } catch (e) {
    toast("Could not replace: " + e.message, true);
  }
}

/* ---------- icon labels ---------- */

/**
 * Show (null), hide ("hidden") or detach ("detached") the text labels drawn inside an icon.
 * Hiding also crops the icon to what is left, so the box stays tight and the drawing keeps its
 * size and place on the page.
 */
export function setIconLabels(o, mode) {
  const asset = state.doc.assets[o.asset];
  if (!asset || o.type !== "icon") return;
  const before = iconParts(o, asset).vb;
  if (mode) o.labels = mode;
  else delete o.labels;
  const after = iconParts(o, asset).vb;
  if (before.every((v, i) => Math.abs(v - after[i]) < 1e-6)) return;
  const sx = o.w / before[2], sy = o.h / before[3];
  // offset of the new box centre from the old one, in the icon's own (unrotated) frame
  let dx = (after[0] - before[0]) * sx + (after[2] * sx - o.w) / 2;
  let dy = (after[1] - before[1]) * sy + (after[3] * sy - o.h) / 2;
  if (o.flipX) dx = -dx;
  if (o.flipY) dy = -dy;
  const [rx, ry] = rotPt(dx, dy, 0, 0, o.rot || 0);
  const cx = o.x + o.w / 2 + rx, cy = o.y + o.h / 2 + ry;
  o.w = after[2] * sx;
  o.h = after[3] * sy;
  o.x = cx - o.w / 2;
  o.y = cy - o.h / 2;
}

/** Turn an icon's labels into ordinary text objects placed exactly over the drawing. */
export function detachLabels(o) {
  const asset = state.doc.assets[o.asset];
  if (!asset || !hasLabels(asset)) return toast("This icon has no text labels");
  setIconLabels(o, null);
  const li = labelInfo(o.asset, asset);
  if (!li.labels.length) return toast("No readable labels found in this icon");
  const [vx, vy, vw, vh] = li.vb;
  const sx = o.w / vw, sy = o.h / vh, sc = Math.sqrt(sx * sy);
  const toDoc = (px, py) => {
    let lx = (px - vx) * sx - o.w / 2, ly = (py - vy) * sy - o.h / 2;
    if (o.flipX) lx = -lx;
    if (o.flipY) ly = -ly;
    const [rx, ry] = rotPt(lx, ly, 0, 0, o.rot || 0);
    return [o.x + o.w / 2 + rx, o.y + o.h / 2 + ry];
  };
  const texts = li.labels.map((lb) => {
    const t = {
      id: uid(), type: "text", name: lb.lines.join(" ").slice(0, 40), text: lb.lines.join("\n"),
      x: 0, y: 0, w: 10, h: 10, rot: o.rot || 0, fontSize: Math.max(2, lb.fontSize * sc), fontFamily: lb.fontFamily,
      color: lb.fill, align: lb.align, bold: lb.bold, italic: lb.italic, lineHeight: 1.2,
    };
    measureText(t);
    const [cx, cy] = toDoc(lb.x + lb.w / 2, lb.y + lb.h / 2);
    t.x = cx - t.w / 2;
    t.y = cy - t.h / 2;
    return t;
  });
  setIconLabels(o, "detached");
  const i = state.doc.objects.indexOf(o);
  state.doc.objects.splice(i + 1, 0, ...texts);
  setSelection([o.id, ...texts.map((t) => t.id)]);
  renderDoc();
  commit();
  toast(`${texts.length} label${texts.length > 1 ? "s" : ""} are now editable text — double-click one to change it`);
}

/* ---------- brushes ---------- */

/** Arm the brush tool to paint a library icon along a path. */
export async function brushWithIcon(id) {
  try {
    await loadAsset(id);
    state.brush = { kind: "icon", asset: id };
    setTool("membrane");
    toast("Drag on the page to paint the icon along a path (click for a straight row)");
  } catch (e) {
    toast("Could not load icon: " + e.message, true);
  }
}
