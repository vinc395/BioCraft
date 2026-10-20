// Side panels: drag the inner edge of the library (left) or the inspector (right) to resize it
// (double-click the edge for its usual width), or collapse either to a slim rail with the chevron
// at its top (click the rail to open it again). Focus mode collapses both. View › Library panel,
// Inspector panel and Focus mode, Ctrl+B, Ctrl+Shift+B and Ctrl+\ share this one state; widths and
// states are remembered on this computer. A window narrower than NARROW collapses the inspector by
// itself until it is wide enough again or the inspector is asked for. The canvas keeps its view
// centre (or refits a fitted page) as the stage changes size: canvas.js stageResized.
//
// The state is drawn on <html>: --library-w / --inspector-w and data-library / data-inspector =
// "collapsed" (index.html sets them from the saved state before the first paint).

import { state } from "./model.js";
import { $, $$, bus, clamp } from "./util.js";

const KEY = "biocraft.panels";
/** dir: which way dragging the inner edge widens the panel. (index.html's first-paint script repeats the limits and NARROW.) */
export const PANELS = {
  library: { min: 220, max: 560, def: 330, dir: 1, name: "library", keys: "Ctrl+B" },
  inspector: { min: 240, max: 480, def: 300, dir: -1, name: "inspector", keys: "Ctrl+Shift+B" },
};
const RAIL = 28; // a collapsed panel's width (app.css)
const STAGE_MIN = 360; // the room the canvas keeps beside two wide panels
export const NARROW = 1100; // a window narrower than this collapses the inspector by itself

/** {library: {width, open}, inspector: {width, open}, before: the panels open before Focus mode {library, inspector, auto} | null} */
let prefs = null;
let autoClosed = false; // the inspector was collapsed by a narrow window, not by the user
let narrow = false;
const scrolls = new Map(); // scroll positions of a collapsed panel's lists: element → [scrollTop, first child]

function load() {
  const p = { before: null };
  for (const [k, P] of Object.entries(PANELS)) p[k] = { width: P.def, open: true };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    for (const [k, P] of Object.entries(PANELS)) {
      const w = +s[k]?.width;
      if (Number.isFinite(w) && w > 0) p[k].width = clamp(Math.round(w), P.min, P.max);
      if (typeof s[k]?.open === "boolean") p[k].open = s[k].open;
    }
    if (s.before && typeof s.before === "object") p.before = { library: s.before.library !== false, inspector: s.before.inspector !== false, auto: s.before.auto === true };
  } catch {}
  return p;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
}

/** Whether a panel is open (not collapsed to its rail). */
export const panelOpen = (k) => !prefs || (prefs[k].open && !(k === "inspector" && autoClosed));

/** Focus mode: both panels collapsed. */
export const focusMode = () => !panelOpen("library") && !panelOpen("inspector");

/**
 * The width each open panel gets: its chosen width, narrowed towards its minimum when the window
 * can't fit both beside a usable canvas.
 */
function widths() {
  const open = Object.keys(PANELS).filter(panelOpen);
  const w = Object.fromEntries(open.map((k) => [k, prefs[k].width]));
  const over = open.reduce((s, k) => s + w[k], 0) - (innerWidth - STAGE_MIN - (2 - open.length) * RAIL);
  const slack = open.reduce((s, k) => s + w[k] - PANELS[k].min, 0);
  if (over > 0 && slack > 0) for (const k of open) w[k] -= Math.min(1, over / slack) * (w[k] - PANELS[k].min);
  return w;
}

/** The widest a panel can be dragged in this window (the other panel as it is now). */
function maxWidth(k) {
  const other = k === "library" ? "inspector" : "library";
  const room = innerWidth - STAGE_MIN - (panelOpen(other) ? widths()[other] : RAIL);
  return Math.max(PANELS[k].min, Math.min(PANELS[k].max, room));
}

/** Draw the state on the page. */
function apply() {
  const root = document.documentElement, w = widths();
  for (const k of Object.keys(PANELS)) {
    const open = panelOpen(k);
    if (open) {
      root.style.setProperty(`--${k}-w`, Math.round(w[k]) + "px");
      delete root.dataset[k];
    } else root.dataset[k] = "collapsed";
    for (const b of $$(`.panel-toggle[data-panel="${k}"], .rail[data-panel="${k}"]`)) b.setAttribute("aria-expanded", String(open));
    const s = $(`.splitter[data-panel="${k}"]`);
    if (s) {
      s.setAttribute("aria-valuenow", Math.round(w[k] || 0));
      s.setAttribute("aria-valuemin", PANELS[k].min);
      s.setAttribute("aria-valuemax", Math.round(maxWidth(k)));
    }
  }
  syncRail();
}

/** Before a panel collapses: a value being typed in it is kept (leaving the field commits it) and its lists remember where they were scrolled to. */
function stow(k) {
  const p = $("#" + k);
  if (!p) return;
  if (p.contains(document.activeElement)) document.activeElement.blur();
  for (const e of p.querySelectorAll(".lib-grid, .lib-cats, .tab")) scrolls.set(e, [e.scrollTop, e.firstChild]);
}

/** After it opens again: the lists scroll back (unless their content was rebuilt meanwhile). */
function unstow(k) {
  const p = $("#" + k);
  for (const [e, [top, first]] of scrolls) {
    if (!p?.contains(e)) continue;
    if (e.firstChild === first) e.scrollTop = top;
    scrolls.delete(e);
  }
}

/** Open or collapse panels: {library?: bool, inspector?: bool}. What the user asks for overrides a narrow window's auto-collapse. */
export function setPanels(want) {
  if (!prefs) return;
  const changed = Object.keys(want).filter((k) => PANELS[k] && panelOpen(k) !== !!want[k]);
  for (const k of changed) if (!want[k]) stow(k);
  for (const k of Object.keys(want)) {
    if (!PANELS[k]) continue;
    prefs[k].open = !!want[k];
    if (k === "inspector") autoClosed = false;
  }
  if (!focusMode()) prefs.before = null; // (Focus mode was left another way: nothing to go back to)
  apply();
  for (const k of changed) if (want[k]) unstow(k);
  save();
  if (changed.length) bus.emit("panels");
}

export const togglePanel = (k) => setPanels({ [k]: !panelOpen(k) });

/** Open a panel if it is collapsed (to show something in it). */
export function revealPanel(k) {
  if (!panelOpen(k)) setPanels({ [k]: true });
}

/** Focus mode on (both panels collapsed) or off (the ones open before it open again). */
export function toggleFocus() {
  if (!prefs) return;
  if (focusMode()) {
    const b = prefs.before;
    prefs.before = null;
    setPanels(b && (b.library || b.inspector) ? { library: b.library, inspector: b.inspector } : { library: true, inspector: true });
    if (b && b.auto && !b.inspector && narrow) {
      // the inspector was only collapsed by the narrow window: it is again, and opens when the window is wide
      prefs.inspector.open = autoClosed = true;
      apply();
      save();
    }
  } else {
    prefs.before = { library: panelOpen("library"), inspector: panelOpen("inspector"), auto: autoClosed };
    setPanels({ library: false, inspector: false });
  }
}

/** Both panels open at their usual widths. */
export function resetPanels() {
  for (const [k, P] of Object.entries(PANELS)) prefs[k].width = P.def;
  prefs.before = null;
  setPanels({ library: true, inspector: true });
}

/** Set a panel's width (clamped to its limits and to what the window leaves room for). */
function setWidth(k, w, keep = true) {
  prefs[k].width = Math.round(clamp(w, PANELS[k].min, maxWidth(k)));
  apply();
  if (keep) save();
}

/** A panel's chosen width (px); set: setPanelWidth(k, px). */
export const panelWidth = (k) => prefs?.[k].width ?? PANELS[k].def;
export const setPanelWidth = (k, w) => prefs && PANELS[k] && setWidth(k, w);

/** The inspector's rail shows a dot while something is selected: there are properties to edit. */
function syncRail() {
  const rail = $('.rail[data-panel="inspector"]');
  if (!rail) return;
  const n = state.selection.length;
  rail.classList.toggle("has-sel", n > 0);
  rail.title = n
    ? `Show the inspector: ${n === 1 ? "the selected object" : n + " selected objects"} (${PANELS.inspector.keys})`
    : `Show the inspector (${PANELS.inspector.keys})`;
}

/** Dragging, double-clicking and the arrow keys on a panel's inner edge. */
function initSplitter(s) {
  const k = s.dataset.panel, P = PANELS[k];
  let drag = null, raf = 0;
  const end = (e) => {
    if (!drag) return;
    drag = null;
    cancelAnimationFrame(raf);
    raf = 0;
    s.classList.remove("dragging");
    document.body.classList.remove("resizing");
    try {
      s.releasePointerCapture(e.pointerId);
    } catch {}
    save();
  };
  s.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX, x: e.clientX, w0: $("#" + k).getBoundingClientRect().width };
    s.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  // live, at most once a frame
  s.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.x = e.clientX;
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      if (drag) setWidth(k, drag.w0 + P.dir * (drag.x - drag.x0), false);
    });
  });
  s.addEventListener("pointerup", end);
  s.addEventListener("pointercancel", end);
  s.addEventListener("lostpointercapture", end);
  s.addEventListener("dblclick", () => setWidth(k, P.def));
  s.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 50 : 10, cur = prefs[k].width;
    const by = { ArrowLeft: -step * P.dir, ArrowRight: step * P.dir }[e.key];
    if (by) setWidth(k, cur + by);
    else if (e.key === "Home") setWidth(k, P.min);
    else if (e.key === "End") setWidth(k, P.max);
    else if (e.key === "Enter") {
      setPanels({ [k]: false });
      $(`.rail[data-panel="${k}"]`)?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

/** The window changed size: a narrow one collapses the inspector (a wide one opens it again), and the panels fit. */
function resized() {
  const now = innerWidth < NARROW;
  if (now !== narrow) {
    narrow = now;
    if (now && prefs.inspector.open && !autoClosed) {
      stow("inspector");
      autoClosed = true;
    } else if (!now && autoClosed) {
      autoClosed = false;
      apply();
      unstow("inspector");
      return bus.emit("panels");
    }
  }
  apply();
}

export function initLayout() {
  prefs = load();
  narrow = innerWidth < NARROW;
  autoClosed = narrow && prefs.inspector.open;
  for (const s of $$(".splitter[data-panel]")) initSplitter(s);
  for (const b of $$(".panel-toggle[data-panel]")) {
    b.addEventListener("click", () => {
      const k = b.dataset.panel, had = document.activeElement === b;
      setPanels({ [k]: false });
      if (had) $(`.rail[data-panel="${k}"]`)?.focus(); // keyboard focus stays on the same spot
    });
  }
  for (const r of $$(".rail[data-panel]")) {
    r.addEventListener("click", () => {
      const k = r.dataset.panel, had = document.activeElement === r;
      setPanels({ [k]: true });
      if (had) $(`.panel-toggle[data-panel="${k}"]`)?.focus();
    });
  }
  let raf = 0;
  window.addEventListener("resize", () => {
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      resized();
    });
  });
  bus.on("selection", syncRail);
  apply();
}
