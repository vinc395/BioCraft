// Floating quick toolbar above the selection, like BioRender's: Align, Group, Arrange, Flip,
// Transform, Replace (icons), Lock and ⋯ (the right-click menu). It follows the selection as it
// moves and as the view pans or zooms, hides while dragging or editing text, flips below the
// selection near the top edge, drops its labels on a canvas too narrow for them, and can be turned
// off in View › Quick toolbar.

import { state, selectedObjs, selectionBox, isBox, isFurniture, MM } from "./model.js";
import { docToScreen, isDragging, isEditingText } from "./canvas.js";
import { groupSel, ungroupSel, toggleLock, transformSel, replaceable } from "./actions.js";
import { alignItems, arrangeItems, flipItems, openContextMenu } from "./contextmenu.js";
import { replaceDialog } from "./library.js";
import { openMenu, closeMenus, popover, popoverOpen } from "./menus.js";
import { $, el, bus, clamp, fmtNum, MOD } from "./util.js";
import { isShape, shapePresetGrid, endShapePreview } from "./shapestyle.js";

const KEY = "biocraft.quickbar";
const GAP_HANDLE = 44, GAP = 14; // clearance from the selection box (more on the rotation-handle side)

const ICON = {
  align: '<path d="M12 3v18M6 7h12v4H6zM8 13h8v4H8z"/>',
  group: '<path d="M3 3h7v7H3zM14 14h7v7h-7z" fill-opacity=".5"/><path d="M2 2h20v20H2z" fill="none" stroke-width="1.5" stroke-dasharray="3 2"/>',
  ungroup: '<path d="M4 4h6v6H4zM14 14h6v6h-6z" fill-opacity=".5"/><path d="M2 2h10v10H2zM12 12h10v10H12z" fill="none" stroke-width="1.3" stroke-dasharray="2.4 1.8"/>',
  arrange: '<path d="M8 8h12v12H8z"/><path d="M4 4h12v3H7v9H4z" fill-opacity=".35"/>',
  flip: '<path d="M12 3v18M10 6L3 18h7zM14 6l7 12h-7z" fill-opacity=".35"/>',
  transform: '<path d="M6 6h12v12H6z" fill="none" stroke-width="1.4" stroke-dasharray="2.6 2"/><path d="M3 3h5v5H3zM16 3h5v5h-5zM3 16h5v5H3zM16 16h5v5h-5z"/>',
  replace: '<path d="M4 8.5h14M14.5 4.5l4 4-4 4M20 15.5H6M9.5 11.5l-4 4 4 4" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  style: '<path d="M12 3a9 9 0 000 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.1 0-.9.8-1.7 1.7-1.7H17a4.5 4.5 0 004.5-4.5C21.5 6.6 17.2 3 12 3z" fill-opacity=".3"/><circle cx="7" cy="11.5" r="1.6"/><circle cx="9.6" cy="7.2" r="1.6"/><circle cx="14.6" cy="7.2" r="1.6"/><circle cx="17.4" cy="11" r="1.6"/>',
  lock: '<path d="M7 11V8a5 5 0 0110 0v3h1v10H6V11zm2 0h6V8a3 3 0 00-6 0z"/>',
  unlock: '<path d="M7 11V8a5 5 0 019.7-1.7l-1.9.7A3 3 0 009 8v3h9v10H6V11z"/>',
  more: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>',
};

let bar = null, wrap = null, built = "";
let fullW = 0; // the toolbar's width with its labels (measured once per build)

export const quickbarOn = () => state.settings.quickbar !== false;

export function setQuickbar(on) {
  state.settings.quickbar = !!on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
  update();
}

const ico = (k) => el("span.qi", { html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>` });

function btn(icon, label, title, run, disabled = false) {
  const b = el("button", { title, disabled, "aria-label": label }, ico(icon), el("span.ql", {}, label));
  b.addEventListener("click", () => run(b));
  return b;
}

/** A button that drops down a menu (Align, Arrange, Flip, ⋯); a second click closes it. */
function menuBtn(icon, label, title, items, disabled = false) {
  return btn(icon, label, title, (b) => {
    if (b.classList.contains("open")) return closeMenus();
    const r = b.getBoundingClientRect();
    openMenu(items(), r.left, r.bottom + 6, b);
  }, disabled);
}

/* ---------- Transform popover ---------- */

function transformPop(anchor) {
  const open = popoverOpen(anchor);
  if (open) return open.close();
  const live = () => selectedObjs().filter((o) => !o.locked && !o.hidden);
  const single = (objs) => (objs.length === 1 && isBox(objs[0]) ? objs[0] : null);
  const first = single(live());
  const isText = first?.type === "text" || (!!first && isFurniture(first)); // these always keep their proportions
  // rotation applied by this panel, for groups, lines and several objects (they have no angle of their
  // own); undo, redo and edits made elsewhere start it again from 0
  let turned = 0, own = false;
  const keep = el("input", { type: "checkbox", checked: first ? first.type === "icon" || first.type === "image" || isText : true, disabled: isText });
  const fields = {};
  const field = (k, label, suffix, step) => {
    const inp = el("input.num", { type: "number", step });
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") inp.blur();
    });
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return sync();
      own = true;
      try {
        if (k === "rot") {
          if (single(live())) transformSel("rot", v);
          else {
            transformSel("rotBy", v - turned);
            turned = v;
          }
        } else transformSel(k, v * MM, keep.checked);
      } finally {
        own = false;
      }
      sync(true);
    });
    fields[k] = inp;
    return el("div.field", {}, el("label", {}, label), inp, el("span.small.muted", {}, suffix));
  };
  // after an edit every field shows the result; edits made elsewhere leave the field being typed in alone
  const sync = (all = false) => {
    const objs = live();
    if (!objs.length) return pop?.close();
    const one = single(objs);
    const b = one || selectionBox(objs);
    for (const k of ["x", "y", "w", "h"]) if (all || document.activeElement !== fields[k]) fields[k].value = fmtNum(b[k] / MM);
    fields.rot.value = fmtNum(one ? one.rot || 0 : turned);
    fields.rot.title = one ? "Rotation" : "Rotate everything about the centre of the selection";
  };
  const body = el("div.qb-transform", {},
    el("div.qb-title", {}, "Transform"),
    el("div.grid2", {}, field("x", "X", "mm", 0.1), field("y", "Y", "mm", 0.1), field("w", "W", "mm", 0.1), field("h", "H", "mm", 0.1)),
    el("div.grid2", {}, field("rot", "↻", "°", 1), el("label.qb-check", { title: isText ? "Text, legends and scale bars always keep their proportions" :"Change width and height together" }, keep, "Keep proportions")));
  let pop = null;
  sync();
  // follow undo/redo and edits made elsewhere while the panel is open
  const follow = () => {
    if (!pop?.el.isConnected) return bus.off("history", follow);
    if (!own) turned = 0;
    sync();
  };
  pop = popover(anchor, body, { onClose: () => { anchor.classList.remove("open"); bus.off("history", follow); } });
  anchor.classList.add("open");
  bus.on("history", follow);
  fields.x.focus();
  fields.x.select();
}

/* ---------- Style popover (shapes) ---------- */

/** The shape colour styles for the selected shapes, next to them; it stays open to try several. */
function stylePop(anchor) {
  const open = popoverOpen(anchor);
  if (open) return open.close();
  // the shapes are looked up every time: undo and redo put new objects in their place
  const live = () => selectedObjs().filter((o) => isShape(o) && !o.locked && !o.hidden);
  if (!live().length) return;
  let all = false, pop = null;
  const body = el("div.qb-style");
  const fill = () => {
    const objs = live();
    if (!objs.length) return pop?.close();
    const { grid, more } = shapePresetGrid(objs, objs[0], { all, onMore: () => { all = !all; fill(); } });
    body.replaceChildren(el("div.qb-title", {}, el("span", {}, "Shape styles"), more || ""), grid);
    if (pop) beside(pop.el, objs);
  };
  fill();
  // a style applied here, undo, redo and edits elsewhere redraw the thumbnails (the applied one outlined)
  const follow = () => (pop?.el.isConnected ? fill() : bus.off("history", follow));
  pop = popover(anchor, body, { onClose: () => { anchor.classList.remove("open"); endShapePreview(); bus.off("history", follow); } });
  beside(pop.el, live());
  anchor.classList.add("open");
  bus.on("history", follow);
}

/** Move a popover beside the selection rather than over it, so the shapes it previews stay in view. */
function beside(p, objs) {
  const r = p.getBoundingClientRect(), w = wrap.getBoundingClientRect(), s = $("#stage").getBoundingClientRect();
  const b = selectionBox(objs);
  const [x0, y0] = docToScreen(b.x, b.y), [x1] = docToScreen(b.x + b.w, b.y + b.h);
  let x = s.left + x1 + 16;
  if (x + r.width > w.right - 8) x = s.left + x0 - 16 - r.width;
  if (x < w.left + 8) return; // no room on either side: it stays under the toolbar
  p.style.left = x + "px";
  p.style.top = clamp(s.top + y0, w.top + 8, Math.max(w.top + 8, innerHeight - r.height - 8)) + "px";
}

/* ---------- placement ---------- */

function hide() {
  bar?.classList.remove("show");
  built = ""; // shown again, it is built for the selection of the moment
}

/**
 * The buttons for a selection. They act on the selection of the moment (undo and redo put new objects
 * in place of the ones the bar was built for); which ones show and work follows `barKey`.
 */
function build(objs) {
  const free = objs.filter((o) => !o.locked);
  const allLocked = !free.length;
  const ungroup = objs.length === 1 && objs[0].type === "group";
  const icons = replaceable(objs);
  const allIcons = icons.length > 0 && icons.length === objs.length;
  const allShapes = !allLocked && objs.every((o) => isShape(o) && !o.locked);
  // (replaceChildren would write a skipped button as the text "null")
  bar.replaceChildren(...[
    menuBtn("align", "Align", "Align and distribute", alignItems, allLocked),
    ungroup ? btn("ungroup", "Ungroup", `Ungroup (${MOD}Shift+G)`, ungroupSel) : btn("group", "Group", `Group (${MOD}G)`, groupSel, objs.length < 2),
    menuBtn("arrange", "Arrange", "Bring to front or send to back", arrangeItems),
    menuBtn("flip", "Flip", "Flip horizontally or vertically", flipItems, allLocked),
    btn("transform", "Transform", "Position, size and rotation", transformPop, allLocked),
    allIcons ? btn("replace", "Replace", "Replace with another icon", () => replaceDialog()) : null,
    allShapes ? btn("style", "Style", "Colour styles for this shape", stylePop) : null,
    btn(allLocked ? "unlock" : "lock", allLocked ? "Unlock" : "Lock", `${allLocked ? "Unlock" : "Lock"} (${MOD}L)`, toggleLock),
    el("span.qsep"),
    btn("more", "More", "More actions (the right-click menu)", (b) => {
      if (b.classList.contains("open")) return closeMenus();
      const r = b.getBoundingClientRect();
      openContextMenu(r.left, r.bottom + 6, null, b);
    }),
  ].filter(Boolean));
}

/** What the buttons depend on: each object's id, type, lock and whether it is a shape (a brush's pattern can make it one). */
const barKey = (objs) => objs.map((o) => o.id + o.type + (o.locked ? "L" : "") + (isShape(o) ? "S" : "")).join("|");

/** Show, rebuild and place the toolbar for the current selection (cheap: runs on every overlay redraw). */
export function update() {
  if (!bar) return;
  const objs = selectedObjs().filter((o) => !o.hidden);
  const tool = state.tool === "select" || state.tool === "hand";
  if (!quickbarOn() || !objs.length || !tool || isDragging() || isEditingText()) return hide();
  const key = barKey(objs);
  if (key !== built) {
    // a rebuild drops open menus anchored to the old buttons
    if (bar.querySelector("button.open")) closeMenus();
    build(objs);
    built = key;
    fullW = 0;
  }
  const b = selectionBox(objs);
  const [x0, y0] = docToScreen(b.x, b.y), [x1, y1] = docToScreen(b.x + b.w, b.y + b.h);
  const W = wrap.clientWidth, H = wrap.clientHeight - 24; // above the status bar
  if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) return hide();
  bar.classList.add("show");
  if (!fullW) {
    bar.classList.remove("compact");
    fullW = bar.offsetWidth;
  }
  // a canvas narrower than the labelled toolbar gets the buttons without their labels
  bar.classList.toggle("compact", fullW > W - 16);
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  // the rotation handle sits above the box, or below it when the object is turned upside down
  const one = objs.length === 1 && isBox(objs[0]) ? objs[0] : null;
  const down = !!one && (one.rot || 0) > 90 && (one.rot || 0) < 270;
  let top = y0 - (down ? GAP : GAP_HANDLE) - bh;
  const below = top < 8;
  if (below) top = y1 + (down ? GAP_HANDLE : GAP);
  top = clamp(top, 8, Math.max(8, H - bh - 8));
  bar.classList.toggle("below", below);
  bar.style.left = clamp((x0 + x1) / 2 - bw / 2, 8, Math.max(8, W - bw - 8)) + "px";
  bar.style.top = top + "px";
}

export function initQuickbar() {
  try {
    if (localStorage.getItem(KEY) === "0") state.settings.quickbar = false;
  } catch {}
  wrap = $("#stage-wrap");
  bar = el("div#quickbar", { role: "toolbar", "aria-label": "Selection" });
  // keep keyboard focus where it was (the canvas shortcuts, the text being edited)
  bar.addEventListener("mousedown", (e) => e.preventDefault());
  bar.addEventListener("contextmenu", (e) => e.preventDefault());
  // scrolling over the toolbar still pans and zooms the canvas
  bar.addEventListener("wheel", (e) => {
    e.preventDefault();
    $("#stage").dispatchEvent(new WheelEvent("wheel", e));
  }, { passive: false });
  wrap.append(bar);
  bus.on("overlay", update);
  bus.on("tool", update);
  update();
}
