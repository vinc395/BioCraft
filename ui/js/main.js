// App start-up, menus, keyboard shortcuts, file handling, drag & drop, paste and autosave.

import { api, isDesktop, downloadResult, libUrl, sandbox } from "./api.js";
import { state, newDoc, resetHistory, takeHistory, adoptHistory, undo, redo, canUndo, canRedo, setSelection, selectedObjs, assetsUsed, MM, endPreviews, docPx } from "./model.js";
import { initCanvas, renderDoc, fitView, zoomAt, setTool, keys, screenToDoc, isEditingText, finishTextEdit, presetObjects, insertObject } from "./canvas.js";
import {
  placeIcon, placeFiles, placeSvgText, copySel, cutSel, pasteClip, hasClip, duplicateSel, deleteSel, selectAll, selectSame, nudge,
  groupSel, ungroupSel, arrange, align, distribute, flipSel, toggleLock,
} from "./actions.js";
import { initLibrary, importIcons, chooseLibrary, pickUploads, saveSelectionToLibrary, myLibrary, showMyLibrary } from "./library.js";
import { insertLegend, insertScaleBar, panelLabelsDialog } from "./furniture.js";
import { BRUSHES, BRUSH_PRESETS, brushMarkup } from "./brush.js";
import { objectMarkup, documentSvg } from "./render.js";
import { initPanels, refresh, showTab, openLink } from "./panels.js";
import { exportDialog } from "./exporter.js";
import { exportLicenceReport } from "./licence.js";
import { isOurPicture } from "./clipimage.js";
import { initHome, showHome, hideHome, homeOpen, homePrefs } from "./home.js";
import { openMenu, closeMenus, modal, askText } from "./menus.js";
import { initContextMenu, selectItems } from "./contextmenu.js";
import { initQuickbar, quickbarOn, setQuickbar } from "./quickbar.js";
import { initTheme, setTheme, themeChoice } from "./theme.js";
import { initLayout, panelOpen, togglePanel, revealPanel, focusMode, toggleFocus, resetPanels } from "./layout.js";
import { $, $$, el, bus, toast, debounce, MOD } from "./util.js";

const mod = MOD;

/* ---------- documents ---------- */

// Figures in the figures folder (the ones on Home) save themselves a moment after each change, and a
// new figure joins them at its first change, as "Untitled figure" in the folder it was created from;
// leaving one that is still called that asks for a name (once). A figure opened from elsewhere is
// saved when you press Save, as before. Each figure keeps its undo history while Home or another
// figure is open, until BioCraft closes.

const params = new URLSearchParams(location.search);
// a ?sandbox test page makes no figure files of its own (a Home test, ?sandbox&home, does)
const makesFiles = !sandbox || params.has("home");
const UNTITLED = /^Untitled figure( \d+)?$/;

const fig = {
  folder: "", // where a new figure's file goes (the Home folder it was created from)
  name: null, // a new figure's name, before its file exists
  rev: 0, // changes so far (one per "doc" event)
  timer: 0,
  saving: null, // the write in progress
  busy: false,
  error: null, // why the last write failed
  thumb: null, // the preview last written into the file for Home…
  thumbAt: 0, // …when it was made…
  thumbRev: 0, // …and after which change
};
const histories = new Map(); // gallery id or path → the undo history of a figure that isn't open
const keptName = new Set(); // figures whose "Untitled figure" the user kept (asked once a session)

const fileName = (path) => (path ? path.replace(/^.*[\\/]/, "") : "figure");
const folderOf = (id) => (id?.includes("/") ? id.slice(0, id.indexOf("/")) : "");
const figureName = () => (state.filePath ? fileName(state.filePath).replace(/\.[^.]+$/, "") : fig.name || "Untitled figure");
/** Whether the open figure saves itself: it is in the figures folder, or new (it goes there). */
const savesItself = () => !!state.galleryId || (!state.filePath && makesFiles);

function setDoc(doc, path = null, galleryId = null) {
  keepHistory();
  clearTimeout(fig.timer);
  Object.assign(fig, { folder: folderOf(galleryId), name: null, error: null, thumb: null, thumbAt: 0, thumbRev: fig.rev });
  state.doc = doc;
  state.filePath = path;
  state.galleryId = galleryId;
  state.selection = [];
  renderDoc();
  resetHistory();
  const key = galleryId || path;
  if (key && adoptHistory(histories.get(key))) histories.delete(key);
  fitView();
  bus.emit("selection");
  updateTitle();
}

/** Keep the open figure's undo history for when it is opened again (the most recent, ~100 MB in all). */
function keepHistory() {
  const key = state.galleryId || state.filePath;
  const h = takeHistory();
  if (!key || h.stack.length < 2) return;
  histories.delete(key);
  histories.set(key, h);
  let size = 0;
  for (const [k, v] of [...histories].reverse()) {
    size += v.stack.reduce((n, s) => n + s.length, 0);
    if (size > 50e6) histories.delete(k);
  }
}

/** A figure's file was renamed or moved: its kept undo history, and the editor if it is open, follow. */
function relinkFigure(from, to, path = null) {
  if (histories.has(from)) {
    histories.set(to, histories.get(from));
    histories.delete(from);
  }
  if (keptName.has(from)) keptName.add(to);
  if (state.galleryId !== from) return;
  state.galleryId = to;
  state.filePath = path || to;
  updateTitle();
}

/** The figure as saved; `thumbnail` (a small picture of the page) is stored for the home page. */
function serialize(thumbnail = null) {
  endPreviews(); // never save a style that is only being previewed
  const { thumbnail: _old, ...d } = state.doc;
  const used = assetsUsed(d.objects);
  const assets = Object.fromEntries(Object.entries(d.assets).filter(([k]) => used.has(k)));
  return JSON.stringify({ ...d, app: "BioCraft", version: 1, assets, ...(thumbnail ? { thumbnail } : {}) });
}

/** A small JPEG of the page for the home page's figure cards (null if it can't be drawn). */
async function figureThumbnail() {
  try {
    const d = state.doc;
    const url = URL.createObjectURL(new Blob([documentSvg(d, { background: d.background || "#ffffff" })], { type: "image/svg+xml" }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const { w, h } = docPx(d);
    const k = Math.min(520 / w, 400 / h);
    const c = el("canvas", { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) });
    const g = c.getContext("2d");
    g.fillStyle = d.background || "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return c.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

/** Open a figure from its text (`name`: a file from the browser, whose figure file gets its name). */
function openDocText(text, path, galleryId = null, { name = null, quiet = false } = {}) {
  try {
    const d = JSON.parse(text);
    if (!d || !Array.isArray(d.objects) || !d.width) throw new Error("not a BioCraft figure");
    d.assets ||= {};
    d.background = d.background === undefined ? "#ffffff" : d.background;
    delete d.thumbnail; // made again when the figure is saved
    setDoc(d, path, galleryId);
    if (!path && name) {
      fig.name = name.replace(/\.[^.]+$/, "");
      updateTitle();
    }
    hideHome();
    if (!quiet) toast("Opened " + figureName());
    return true;
  } catch (e) {
    toast("Could not open: " + e.message, true);
    return false;
  }
}

/* saving as you work */

/** After each change: a figure that saves itself is written a moment later. */
function changed() {
  fig.rev++;
  if (savesItself() && (state.galleryId || state.doc.objects.length)) {
    clearTimeout(fig.timer);
    fig.timer = setTimeout(() => saveFigure(), 1200);
  }
  showSaveState();
}

/**
 * Write the open figure to its file in the figures folder now. A new figure gets its file first
 * (`force`: even an empty one). The preview Home shows is made again when `fresh`, or when the last
 * one is more than 20 s old. True when the file holds the figure as it is.
 */
async function saveFigure({ fresh = false, force = false } = {}) {
  clearTimeout(fig.timer);
  while (fig.saving) await fig.saving;
  if (!savesItself()) return !state.dirty;
  if (!state.galleryId && !state.doc.objects.length && !force) return true; // new and empty: nothing to keep yet
  if (state.galleryId && !state.dirty && !(fresh && fig.thumbRev !== fig.rev)) return true;
  const doc = state.doc, id = state.galleryId, rev = fig.rev;
  fig.busy = true;
  showSaveState();
  fig.saving = (async () => {
    try {
      if (fresh || !fig.thumb || Date.now() - fig.thumbAt > 20000) {
        fig.thumb = await figureThumbnail();
        fig.thumbAt = Date.now();
        fig.thumbRev = rev;
      }
      if (state.doc !== doc) return false; // (another figure was opened meanwhile)
      const content = serialize(fig.thumb);
      if (id) await api("gallery.save", { id, content });
      else {
        const r = await api("gallery.create", { folder: fig.folder, name: fig.name || "Untitled figure", content });
        if (state.doc === doc) {
          state.galleryId = r.id;
          state.filePath = r.path || r.id;
          fig.name = null;
        }
      }
      fig.error = null;
      if (fig.rev === rev && state.doc === doc) state.dirty = false; // (a change made meanwhile is saved next)
      return true;
    } catch (e) {
      fig.error = e.message || String(e);
      return false;
    }
  })();
  const ok = await fig.saving;
  fig.saving = null;
  fig.busy = false;
  updateTitle();
  return ok && !state.dirty;
}

/**
 * Before the editor leaves the open figure. One that saves itself is saved now — when it is about to
 * be replaced (`replace`), a failed save asks what to do; for Home it just stays open. One from
 * elsewhere with unsaved changes asks whether to save them. `name`: ask for a name if it is still
 * "Untitled figure". False: stay.
 */
async function leaveFigure({ replace = false, name = false } = {}) {
  finishTextEdit();
  if (savesItself()) {
    while (!(await saveFigure({ fresh: true }))) {
      if (!replace) return true;
      const r = await modal("Not saved", el("div.meta-line", {}, `“${figureName()}” couldn't be saved: ${fig.error || "unknown error"}`), [
        { label: "Cancel", value: false },
        { label: "Don't save", value: "discard" },
        { label: "Try again", primary: true, value: "retry" },
      ]);
      if (r === "discard") return true;
      if (r !== "retry") return false;
    }
    return !name || (await askName());
  }
  if (!state.dirty || !state.doc.objects.length) return true;
  const r = await modal("Unsaved changes", el("div.meta-line", {}, `Save the changes to “${figureName()}”?`), [
    { label: "Cancel", value: false },
    { label: "Don't save", value: "discard" },
    { label: "Save", primary: true, value: "save" },
  ]);
  return r === "discard" || (r === "save" && (await saveDocument(false)));
}

/** The figure's title, to suggest as its name: its largest text (the highest of equals), if a phrase. */
function figureTitle() {
  let best = null;
  const walk = (objs) => {
    for (const o of objs) {
      if (o.type === "group") walk(o.children || []);
      else if (o.type === "text" && String(o.text ?? "").trim()) {
        const f = o.fontSize || 12, b = best?.fontSize || 12;
        if (!best || f > b + 0.01 || (Math.abs(f - b) <= 0.01 && o.y < best.y)) best = o;
      }
    }
  };
  walk(state.doc.objects);
  const t = best && String(best.text).replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return t && t.includes(" ") && !UNTITLED.test(t) ? t : null;
}

/**
 * "Name your file" for a figure still called "Untitled figure", once a session (Skip keeps the name).
 * False when the dialog is closed instead: stay in the editor.
 */
async function askName(intro = "Before leaving, give your figure a clear name to make it easy to find later.") {
  const id = state.galleryId;
  if (!id || keptName.has(id) || !UNTITLED.test(figureName()) || !state.doc.objects.length) return true;
  const title = figureTitle();
  const inp = el("input.num", { value: figureName(), "aria-label": "File name", maxlength: 80 });
  const use = () => {
    inp.value = title;
    inp.focus();
    inp.select();
  };
  const body = el("div.name-file", {},
    el("p.meta-line", {}, intro),
    el("div.field.wide", {}, el("label", {}, "File name"), inp),
    title ? el("button.name-suggest", { type: "button", title: "The largest text in your figure", onclick: use }, "Use the figure's title: ", el("b", {}, `“${title}”`)) : null);
  setTimeout(() => inp.select(), 0);
  const r = await modal("Name your file", body, [{ label: "Skip", value: "skip" }, { label: "Save", primary: true, value: "save" }], { enter: true, cls: "name-file" });
  if (!r) return false;
  keptName.add(id);
  const name = inp.value.trim();
  if (r === "skip" || !name || name === figureName()) return true;
  try {
    await renameOpen(name, true);
  } catch (e) {
    toast("Could not rename: " + e.message, true);
  }
  return true;
}

/** Rename the open figure's file (`unique`: a name already taken gets a number); a new figure's file will have it. */
async function renameOpen(name, unique = false) {
  if (!state.galleryId) {
    fig.name = name;
    return updateTitle();
  }
  await saveFigure();
  const from = state.galleryId;
  const r = await api("gallery.rename", { id: from, name, unique });
  relinkFigure(from, r.id, r.path);
}

/** The name in the top bar: rename the figure (its file in the figures folder). */
async function renameDialog() {
  if (!savesItself()) return; // (a figure from elsewhere: Save as… gives a copy another name)
  const name = await askText("Rename figure", "Name", figureName(), "Rename");
  if (!name || name === figureName()) return;
  try {
    await renameOpen(name);
    if (state.galleryId) keptName.add(state.galleryId);
    toast(`Renamed to “${figureName()}”`);
  } catch (e) {
    toast(e.message, true);
  }
}

/** Home (the logo, the home button, File › Home): the open figure is saved and named first. */
async function goHome() {
  if (homeOpen() || !(await leaveFigure({ name: true }))) return;
  await showHome();
}

async function newDocument() {
  if (!(await leaveFigure({ replace: true, name: true }))) return;
  const folder = folderOf(state.galleryId);
  setDoc(newDoc());
  fig.folder = folder; // (in the project folder of the figure you were in)
}

/** Home's Create new: a page of that size, whose file goes in `folder` at its first change. */
async function newFigure({ folder = "", width, height } = {}) {
  if (!(await leaveFigure({ replace: true }))) return false;
  setDoc(newDoc(width, height));
  fig.folder = folder;
  updateTitle();
  hideHome();
  return true;
}

/** Open a figure file from anywhere; true when one was opened. */
async function openDocument({ fromHome = false } = {}) {
  if (!(await leaveFigure({ replace: true, name: !fromHome }))) return false;
  if (isDesktop) {
    try {
      const r = await api("doc.open", {});
      return !r.cancelled && openDocText(r.content, r.path, r.galleryId || null);
    } catch (e) {
      toast("Could not open: " + e.message, true);
      return false;
    }
  }
  return new Promise((resolve) => {
    const inp = $("#file-input");
    inp.accept = ".biocraft,.biocanvas,.json";
    inp.onchange = async () => {
      const f = inp.files[0];
      inp.value = "";
      resolve(f ? openDocText(await f.text(), null, null, { name: f.name }) : false);
    };
    inp.click();
  });
}

/** A figure file dropped on the canvas. */
async function openDropped(text, _path, name) {
  if (await leaveFigure({ replace: true })) openDocText(text, null, null, { name });
}

/** Save (a figure that saves itself: now) or Save as…; true when it was saved. */
async function saveDocument(saveAs = false) {
  if (!saveAs && savesItself()) {
    if (!(await saveFigure({ fresh: true, force: true }))) {
      toast("Not saved: " + (fig.error || "unknown error"), true);
      return false;
    }
    await askName(`Your figure saves itself in ${folderOf(state.galleryId) || "My files"} as you work. Give it a clear name to make it easy to find later.`);
    toast("Saved");
    return true;
  }
  try {
    const content = serialize(await figureThumbnail());
    const r = await api("doc.save", { content, path: saveAs ? null : state.filePath, name: figureName() });
    if (r.cancelled) return false;
    if (r.base64) downloadResult(r);
    if (r.path) {
      state.filePath = r.path;
      state.galleryId = r.galleryId || null;
    }
    state.dirty = false;
    updateTitle();
    toast("Saved");
    return true;
  } catch (e) {
    toast("Save failed: " + e.message, true);
    return false;
  }
}

async function placeDialog() {
  if (isDesktop) {
    const r = await api("file.pickPlace", {});
    for (const f of r.files || []) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const type = f.ext === "svg" ? "image/svg+xml" : `image/${f.ext === "jpg" ? "jpeg" : f.ext}`;
      await placeFiles([new File([bytes], f.name, { type })]);
    }
  } else {
    const inp = $("#file-input");
    inp.accept = ".svg,.png,.jpg,.jpeg,.webp,.gif";
    inp.onchange = async () => {
      await placeFiles([...inp.files]);
      inp.value = "";
    };
    inp.click();
  }
}

function updateTitle() {
  const t = `${state.dirty && !savesItself() ? "• " : ""}${figureName()}${sandbox ? " (sandbox, not saved)" : ""} — BioCraft`;
  document.title = t;
  if (isDesktop) window.__TAURI__.window?.getCurrentWindow?.().setTitle(t).catch(() => {});
  const n = state.doc.objects.length;
  $("#status-doc").textContent = `${state.doc.width} × ${state.doc.height} mm · ${n} object${n === 1 ? "" : "s"}`;
  showSaveState();
}

const SAVE_ICONS = {
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  busy: '<path d="M12 4a8 8 0 108 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  warn: '<circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
  err: '<path d="M12 3.5l9.5 16.5h-19z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};

/** The figure's name in the top bar, and whether it is saved. */
function showSaveState() {
  const nameEl = $("#doc-name"), s = $("#save-state");
  if (!nameEl) return;
  const where = folderOf(state.galleryId) || "My files";
  let kind = "", text = "", tip = "";
  if (sandbox && !makesFiles) [kind, text, tip] = ["warn", "Sandbox", "A test page: nothing is saved"];
  else if (savesItself()) {
    if (fig.error) [kind, text, tip] = ["err", "Not saved", `Couldn't save: ${fig.error}. Click to try again.`];
    else if (fig.busy || (state.dirty && (state.galleryId || state.doc.objects.length))) [kind, text, tip] = ["busy", "Saving…", `Saving in ${state.galleryId ? where : fig.folder || "My files"}`];
    else if (state.galleryId) [kind, text, tip] = ["ok", "Saved", `Saved as you work, in ${where} on Home`];
    else tip = `A new figure: it is saved in ${fig.folder || "My files"} as soon as you add something`;
  } else if (state.dirty) [kind, text, tip] = ["warn", "Unsaved changes", `${state.filePath || ""}\nThis figure is outside your figures folder, so it is saved when you press ${mod}S. Click to save.`];
  else [kind, text, tip] = ["ok", "Saved", state.filePath || ""];
  if (nameEl.textContent !== figureName()) {
    nameEl.textContent = figureName();
    fitTopbar(); // (a longer or shorter name: the tools may fold or come back)
  }
  nameEl.title = savesItself() ? "Rename this figure" : state.filePath || "";
  nameEl.classList.toggle("fixed", !savesItself());
  s.className = kind;
  s.title = tip;
  s.setAttribute("aria-label", text ? `${text}. ${tip}` : tip);
  s.replaceChildren(...(kind ? [el("span.ss-icon", { html: `<svg viewBox="0 0 24 24" aria-hidden="true">${SAVE_ICONS[kind]}</svg>` }), el("span.ss-text", {}, text)] : []));
}

/* ---------- menus ---------- */

const MENUS = {
  file: () => [
    { label: "Home", run: goHome, title: "All your figures and project folders" },
    "-",
    { label: "New figure", kbd: mod + "N", run: newDocument },
    { label: "Open…", kbd: mod + "O", run: openDocument },
    launch ? { label: `Open ${fileName(launch.path)}`, run: openLaunched, title: "The figure BioCraft was started with" } : null,
    { label: "Save", kbd: mod + "S", run: () => saveDocument(false) },
    { label: "Save as…", kbd: mod + "Shift+S", run: () => saveDocument(true) },
    "-",
    { label: "Place image or SVG…", kbd: mod + "Shift+P", run: placeDialog },
    { label: "Add files to My library…", run: isDesktop ? importIcons : pickUploads },
    "-",
    { label: "Export…", kbd: mod + "E", run: exportDialog },
    { label: "Export licence report…", run: exportLicenceReport, title: "Every icon's source, author and licence and what the licences ask of you — PDF, Markdown and CSV" },
    "-",
    { label: "Open library folder", run: () => api("app.revealLibrary").catch((e) => toast(e.message, true)), disabled: !isDesktop },
    { label: "Choose icon library folder…", run: chooseLibrary, disabled: !isDesktop },
  ],
  edit: () => [
    { label: "Undo", kbd: mod + "Z", run: undo, disabled: !canUndo() },
    { label: "Redo", kbd: mod + "Shift+Z", run: redo, disabled: !canRedo() },
    "-",
    { label: "Cut", kbd: mod + "X", run: cutSel },
    { label: "Copy", kbd: mod + "C", run: copySel, title: "Also copies a picture with a transparent background, to paste into PowerPoint, Word or Teams" },
    { label: "Paste", kbd: mod + "V", run: () => pasteClip() },
    { label: "Duplicate", kbd: mod + "D", run: duplicateSel },
    { label: "Delete", kbd: "Del", run: deleteSel },
    "-",
    { label: "Save selection to My library…", run: saveSelectionToLibrary, disabled: !state.selection.length },
    "-",
    { label: "Select all", kbd: mod + "A", run: selectAll },
    { label: "Select all same icons", run: selectSame, disabled: !state.selection.length, title: "Same library icon; other objects of the same type and style" },
    { label: "Select", submenu: selectItems },
    { label: "Deselect", kbd: "Esc", run: () => setSelection([]) },
  ],
  insert: () => [
    { label: "Text", kbd: "T", run: () => insertObject("text"), title: "Add text in the middle of the view (T: click where it goes)" },
    { label: "Rectangle", kbd: "R", run: () => insertObject("rect"), title: "Add a rectangle in the middle of the view (R: drag one)" },
    { label: "Ellipse", kbd: "O", run: () => insertObject("ellipse"), title: "Add an ellipse in the middle of the view (O: drag one)" },
    { label: "Arrow", kbd: "A", run: () => insertObject("arrow"), title: "Add an arrow in the middle of the view (A: draw one)" },
    { label: "Brush…", kbd: "M", run: openBrushPicker, title: "Path arrows, circular arrows, plasmids, membranes, DNA, cells, vessels…" },
    "-",
    { label: "Legend", run: () => insertLegend(), title: "A key of the icons in your figure, with labels you can edit" },
    { label: "Scale bar", run: () => insertScaleBar(), title: "A bar with its length in nm, µm or mm" },
    { label: "Panel labels…", run: panelLabelsDialog, title: "Bold A, B, C… at the top-left of each selected object or group" },
    "-",
    { label: "Image or SVG…", kbd: mod + "Shift+P", run: placeDialog },
    { label: "From My library", submenu: myLibraryItems },
  ],
  arrange: () => [
    { label: "Bring to front", kbd: mod + "Shift+]", run: () => arrange("front") },
    { label: "Bring forward", kbd: mod + "]", run: () => arrange("forward") },
    { label: "Send backward", kbd: mod + "[", run: () => arrange("backward") },
    { label: "Send to back", kbd: mod + "Shift+[", run: () => arrange("back") },
    "-",
    { label: "Group", kbd: mod + "G", run: groupSel },
    { label: "Ungroup", kbd: mod + "Shift+G", run: ungroupSel },
    { label: "Lock / unlock", kbd: mod + "L", run: toggleLock },
    "-",
    { label: "Flip horizontally", kbd: "Shift+H", run: () => flipSel("h") },
    { label: "Flip vertically", kbd: "Shift+V", run: () => flipSel("v") },
    "-",
    { heading: "Align" },
    { label: "Left", run: () => align("left") },
    { label: "Centre", run: () => align("hcenter") },
    { label: "Right", run: () => align("right") },
    { label: "Top", run: () => align("top") },
    { label: "Middle", run: () => align("vcenter") },
    { label: "Bottom", run: () => align("bottom") },
    { label: "Distribute horizontally", run: () => distribute("h") },
    { label: "Distribute vertically", run: () => distribute("v") },
  ],
  view: () => [
    { label: "Zoom in", kbd: mod + "+", run: () => zoomAt(1.25) },
    { label: "Zoom out", kbd: mod + "−", run: () => zoomAt(0.8) },
    { label: "Fit figure", kbd: mod + "0", run: fitView },
    { label: "Actual size", kbd: mod + "1", run: actualSize },
    "-",
    { label: "Grid", kbd: mod + "'", checked: !!state.settings.grid, run: toggleGrid },
    { label: "Smart guides", checked: !!state.settings.snap, run: () => { state.settings.snap = !state.settings.snap; refresh(); } },
    { label: "Quick toolbar above the selection", checked: quickbarOn(), run: () => setQuickbar(!quickbarOn()) },
    "-",
    { label: "Library panel", kbd: mod + "B", checked: panelOpen("library"), run: () => togglePanel("library") },
    { label: "Inspector panel", kbd: mod + "Shift+B", checked: panelOpen("inspector"), run: () => togglePanel("inspector") },
    { label: "Focus mode", kbd: mod + "\\", checked: focusMode(), run: toggleFocus, title: "Collapse both side panels for the largest canvas" },
    { label: "Reset panels", run: resetPanels, title: "Both side panels open, at their usual widths" },
    "-",
    { heading: "Theme" },
    ...themeItems(),
  ],
  help: () => [
    { label: "Keyboard shortcuts", kbd: "?", run: shortcutsDialog },
    { label: "Icon sources & licences", run: sourcesDialog },
    { label: "About BioCraft", run: aboutDialog },
  ],
};

/** Insert › Brush…: the brush picker, beside the toolbar's brush button (under the Insert menu when the button is folded away). */
function openBrushPicker() {
  const b = $('#tools [data-tool="membrane"]');
  if (b.offsetParent) {
    const r = b.getBoundingClientRect();
    return openMenu(brushMenu(), r.right + 6, r.top, b);
  }
  const r = $('#menus [data-menu="insert"] button').getBoundingClientRect();
  openMenu(brushMenu(), r.left, r.bottom + 4);
}

/** Insert › From My library: your newest icons (click one to add it), then the panel. */
function myLibraryItems() {
  const { items, total } = myLibrary();
  const out = items.slice(0, 24).map((it) => ({ label: it.name, img: it.thumb ? libUrl(it.thumb) : null, run: () => placeIcon(it.id) }));
  if (!out.length) out.push({ label: "My library is empty", disabled: true });
  out.push("-",
    { label: total > out.length && items.length ? `Show all ${total} in the library panel` : "Show My library in the library panel", run: showMyLibrary },
    { label: "Add files to My library…", run: isDesktop ? importIcons : pickUploads });
  return out;
}

function actualSize() {
  state.view.zoom = 1;
  fitView();
  const z = state.view.zoom;
  zoomAt(1 / z);
}

function toggleGrid() {
  state.settings.grid = !state.settings.grid;
  renderDoc();
  refresh();
}

const themeItems = () => [["system", "Follow system"], ["light", "Light"], ["dark", "Dark"]].map(([v, label]) => ({
  label, checked: themeChoice() === v, run: () => setTheme(v),
}));

/* ---------- top bar: what doesn't fit the window goes into the ⋯ menu ---------- */

const FOLDS = 6; // index.html data-fold: 1 theme, 2 undo/redo, 3 zoom buttons, 4 drawing tools, 5 the other tools, 6 the figure's name
let folded = 0;
const TOOL_NAMES = {
  select: ["Select", "V"], hand: ["Pan", "H"], text: ["Text", "T"], rect: ["Rectangle", "R"], ellipse: ["Ellipse", "O"],
  line: ["Line", "L"], arrow: ["Arrow", "A"], inhibit: ["Inhibition ⊣", "I"], membrane: ["Brush", "M"],
};

/** Fold the top bar's least-needed buttons into the ⋯ menu, a group at a time, until the rest fits. */
function fitTopbar() {
  const bar = $("#topbar");
  const fold = (n) => {
    folded = n;
    for (const e of $$("[data-fold]", bar)) e.classList.toggle("folded", +e.dataset.fold <= n);
    $("#btn-more").classList.toggle("folded", !n);
  };
  const over = () => bar.scrollWidth > bar.clientWidth;
  fold(0);
  // the figure's name (up to 220 px of it) stays whole while the theme, undo/redo and zoom buttons
  // fold; then it may shorten before the drawing tools fold, and it goes last
  const name = $("#doc-name");
  name.style.minWidth = Math.min(name.scrollWidth + 2, 220) + "px";
  let n = 0;
  while (n < 3 && over()) fold(++n);
  name.style.minWidth = "";
  while (n < FOLDS && over()) fold(++n);
}

/** The ⋯ menu: the folded buttons, in the order the bar shows them. */
function moreItems() {
  const groups = [];
  const tools = $$("#tools [data-tool].folded").map((b) => {
    const t = b.dataset.tool, [label, kbd] = TOOL_NAMES[t];
    return t === "membrane" ? { label: "Brush", kbd, checked: state.tool === t, submenu: brushMenu } : { label, kbd, checked: state.tool === t, run: () => setTool(t) };
  });
  if (tools.length) groups.push([{ heading: "Tools" }, ...tools]);
  if (folded >= 2) groups.push([{ label: "Undo", kbd: mod + "Z", run: undo, disabled: !canUndo() }, { label: "Redo", kbd: mod + "Shift+Z", run: redo, disabled: !canRedo() }]);
  if (folded >= 1) groups.push([{ label: "Theme", submenu: themeItems }]);
  if (folded >= 3) groups.push([{ label: "Zoom in", kbd: mod + "+", run: () => zoomAt(1.25) }, { label: "Zoom out", kbd: mod + "−", run: () => zoomAt(0.8) }]);
  if (folded >= 6) groups.push([{ heading: figureName() }, { label: "Rename figure…", run: renameDialog, disabled: !savesItself() }]);
  return groups.flatMap((g, i) => (i ? ["-", ...g] : g));
}

function shortcutsDialog() {
  const rows = [
    ["V / H", "Select / pan tool (hold Space to pan)"], ["T", "Text"], ["R / O", "Rectangle / ellipse"],
    ["L / A / I", "Line / arrow / inhibition line (start or end on an object to connect it)"], ["M or B", "Brush: path arrows, circular arrows, plasmids, freeform shapes, membranes, DNA, cells, vessels, axons…"],
    ["Double-click a brush", "Add a point (double-click a point to remove it)"],
    ["Double-click a legend row", "Rename it (legends, scale bars and panel labels are in the Insert menu)"],["/ or " + mod + "F", "Search the library"],
    [mod + "Z / " + mod + "Shift+Z", "Undo / redo"], [mod + "C / X / V / D", "Copy / cut / paste / duplicate (Copy also gives PowerPoint, Word and Teams a transparent picture)"],
    ["Del", "Delete"], ["Arrows (Shift)", "Nudge 1 px (10 px)"], [mod + "G / " + mod + "Shift+G", "Group / ungroup"],
    [mod + "[ / ]", "Send backward / bring forward"], ["Shift+H / Shift+V", "Flip"], [mod + "L", "Lock"],
    ["Shift while dragging", "Keep proportions / snap angles to 15°"], ["Alt while dragging", "Copy (move), from centre (shapes), don't connect (line ends), resize only the path (a brush's corner handles)"],
    [mod.replace(/\+$/, "") + " while drawing a line", "Connect an end even to a drawing the line lies on, such as a tissue background"],
    ["Right-click", "Menu: flip, arrange, align, select same, replace, lock…"],
    [mod + "wheel", "Zoom"], [mod + "0 / 1", "Fit / actual size"], [mod + "S / O / E", "Save / open / export"],
    [mod + "B / " + mod + "Shift+B", "Show or hide the library / the inspector (drag a panel's inner edge to resize it)"],
    [mod + "\\", "Focus mode: collapse both side panels"],
  ];
  modal("Keyboard shortcuts", el("div.kbd-list", {}, ...rows.flatMap(([k, v]) => [el("kbd", {}, k), el("span", {}, v)])), [{ label: "Close", primary: true }]);
}

async function sourcesDialog() {
  const info = await api("library.info");
  const body = el("div", { style: { display: "grid", gap: "8px", maxHeight: "60vh", overflow: "auto" } },
    ...info.packs.map((p) => el("div.meta-line", {}, el("b", {}, `${p.name} — ${p.count.toLocaleString()} icons`), el("br"), p.description, el("br"), "Credit: ", p.credit,
      p.url ? el("span", {}, " · ", el("a", { onclick: () => openLink(p.url) }, p.url)) : null)),
    el("div.small.muted", {}, "Each icon keeps its own licence; the Credits tab lists what your figure needs."));
  modal("Icon sources & licences", body, [{ label: "Close", primary: true }]);
}

async function aboutDialog() {
  const a = await api("app.info").catch(() => ({}));
  modal("BioCraft", el("div.meta-line", {},
    `Version ${a.version || "?"} · ${a.platform || ""} · ${a.mode || ""}`, el("br"),
    "A lightweight, offline editor for scientific figures: Rust core (resvg, svg2pdf) with a Tauri window.", el("br"),
    "Library: ", a.library || "—"), [{ label: "Close", primary: true }]);
}

function initMenus() {
  for (const m of $$("#menus .menu")) {
    const btn = m.querySelector("button");
    btn.addEventListener("click", () => {
      const r = btn.getBoundingClientRect();
      if (btn.classList.contains("open")) return closeMenus();
      openMenu(MENUS[m.dataset.menu](), r.left, r.bottom + 4, btn);
    });
    btn.addEventListener("pointerenter", () => {
      const open = document.querySelector("#menus button.open");
      if (open && open !== btn) btn.click();
    });
  }
  for (const b of $$("#tools [data-tool]")) {
    b.addEventListener("click", () => {
      if (b.dataset.tool !== "membrane") return setTool(b.dataset.tool);
      const r = b.getBoundingClientRect();
      openMenu(brushMenu(), r.right + 6, r.top, b);
    });
  }
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-redo").addEventListener("click", redo);
  $("#btn-zoom-in").addEventListener("click", () => zoomAt(1.25));
  $("#btn-zoom-out").addEventListener("click", () => zoomAt(0.8));
  $("#zoom-label").addEventListener("click", fitView);
  $("#btn-export").addEventListener("click", exportDialog);
  const more = $("#btn-more");
  more.addEventListener("click", () => {
    if (more.classList.contains("open")) return closeMenus();
    const r = more.getBoundingClientRect();
    openMenu(moreItems(), r.left, r.bottom + 4, more);
  });
  fitTopbar();
  let raf = 0;
  window.addEventListener("resize", () => {
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      fitTopbar();
    });
  });
  const sync = () => {
    $("#btn-undo").disabled = !canUndo();
    $("#btn-redo").disabled = !canRedo();
    updateTitle();
  };
  bus.on("history", sync);
  sync();
}

/* ---------- brushes ---------- */

const PREVIEW_T = { bilayer: 9, dna: 11, rna: 6.5, cuboidal: 11, columnar: 15, squamous: 4.5, actin: 7, microtubule: 11, collagen: 8.5, vessel: 17, axon: 11, arrow: 2.2, freeform: 1.2 };

const previewSvg = (markup) => el("span.brush-prev", { html: `<svg viewBox="0 0 82 34" width="82" height="34" aria-hidden="true">${markup}</svg>` });

function brushPreview(kind) {
  const o = { type: "membrane", brush: kind, pts: [[6, 22], [28, 16], [52, 22], [76, 16]], thickness: PREVIEW_T[kind], closed: false, seed: 4, headColor: "#f0a35c", tailColor: "#e9c88f" };
  if (kind === "arrow") Object.assign(o, { pts: [[7, 25], [27, 11], [50, 24], [75, 10]], startHead: "none", endHead: "arrow" });
  if (kind === "freeform") Object.assign(o, { pts: [[16, 9], [42, 5], [68, 10], [72, 25], [45, 29], [15, 26]], closed: true, fill: "#d9ecf7", stroke: "#1d6fa5" });
  return previewSvg(brushMarkup(o, false));
}

/** A preset drawn small (without its labels). */
function presetPreview(name) {
  const box = name === "plasmid" ? { x: 19, y: -5, w: 44, h: 44 } : { x: 25, y: 2, w: 30, h: 30 };
  const strip = (o) => (o.children ? { ...o, children: o.children.filter((c) => c.type !== "text").map(strip) } : o);
  return previewSvg(presetObjects(name, box).map((o) => objectMarkup(strip(o), state.doc)).join(""));
}

function brushMenu() {
  const b = state.brush || {};
  const arm = (brush) => {
    state.brush = { asset: null, ...brush };
    setTool("membrane");
  };
  const item = (prev, name, on, brush) => ({ label: el("span.brush-item" + (on ? ".on" : ""), {}, prev, el("span", {}, name)), run: () => arm(brush) });
  const items = [{ heading: "Arrows and shapes — drag on the page" }];
  items.push(item(brushPreview("arrow"), BRUSHES.arrow.name, b.kind === "arrow" && !b.preset, { kind: "arrow" }));
  for (const [k, p] of Object.entries(BRUSH_PRESETS)) items.push(item(presetPreview(k), p.name, b.preset === k, { kind: p.kind, preset: k }));
  items.push(item(brushPreview("freeform"), BRUSHES.freeform.name, b.kind === "freeform", { kind: "freeform" }));
  items.push("-", { heading: "Brushes — drag on the page, then bend it" });
  for (const [k, def] of Object.entries(BRUSHES)) {
    if (k === "icon" || def.line || def.shape) continue;
    items.push(item(brushPreview(k), def.name, b.kind === k && !b.preset, { kind: k }));
  }
  items.push("-", { heading: "Any library icon: right-click it → Paint along a path" });
  return items;
}

/* ---------- keyboard ---------- */

const TOOL_KEYS = { v: "select", h: "hand", t: "text", r: "rect", o: "ellipse", e: "ellipse", l: "line", a: "arrow", i: "inhibit", m: "membrane", b: "membrane" };

function typing(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function onKey(e) {
  if (homeOpen()) return; // the home page has its own keys
  if (isEditingText()) return;
  if (document.querySelector(".modal-back")) return;
  const k = e.key.toLowerCase();
  const cmd = e.ctrlKey || e.metaKey;
  if (cmd && k === "f") {
    e.preventDefault();
    revealPanel("library");
    $("#lib-search").focus();
    $("#lib-search").select();
    return;
  }
  if (typing(e)) return;
  if (k === " ") {
    if (!keys.space) {
      keys.space = true;
      $("#stage").classList.add("panning");
    }
    e.preventDefault();
    return;
  }
  const run = (fn) => {
    e.preventDefault();
    fn();
  };
  if (cmd) {
    if (k === "z" && !e.shiftKey) return run(undo);
    if ((k === "z" && e.shiftKey) || k === "y") return run(redo);
    if (k === "c") return copySel() && e.preventDefault();
    if (k === "x") return run(cutSel);
    if (k === "d") return run(duplicateSel);
    if (k === "a") return run(selectAll);
    if (k === "g") return run(e.shiftKey ? ungroupSel : groupSel);
    if (k === "l") return run(toggleLock);
    if (k === "s") return run(() => saveDocument(e.shiftKey));
    if (k === "o") return run(openDocument);
    if (k === "n") return run(newDocument);
    if (k === "e") return run(exportDialog);
    if (k === "p" && e.shiftKey) return run(placeDialog);
    if (k === "b") return run(() => togglePanel(e.shiftKey ? "inspector" : "library"));
    if (k === "\\" || e.code === "Backslash") return run(toggleFocus);
    if (k === "0") return run(fitView);
    if (k === "1") return run(actualSize);
    if (k === "=" || k === "+") return run(() => zoomAt(1.25));
    if (k === "-") return run(() => zoomAt(0.8));
    if (k === "'") return run(toggleGrid);
    if (e.code === "BracketRight") return run(() => arrange(e.shiftKey ? "front" : "forward"));
    if (e.code === "BracketLeft") return run(() => arrange(e.shiftKey ? "back" : "backward"));
    return;
  }
  if (k === "delete" || k === "backspace") return run(deleteSel);
  if (k === "escape") return run(() => { setSelection([]); setTool("select"); });
  if (k.startsWith("arrow")) {
    const s = e.shiftKey ? 10 : 1;
    const d = { arrowleft: [-s, 0], arrowright: [s, 0], arrowup: [0, -s], arrowdown: [0, s] }[k];
    return run(() => nudge(...d));
  }
  if (e.shiftKey && k === "h") return run(() => flipSel("h"));
  if (e.shiftKey && k === "v") return run(() => flipSel("v"));
  if (k === "/") return run(() => {
    revealPanel("library");
    $("#lib-search").focus();
  });
  if (k === "?") return run(shortcutsDialog);
  if (TOOL_KEYS[k] && !e.altKey) return run(() => setTool(TOOL_KEYS[k]));
}

/* ---------- drag & drop, paste ---------- */

function initDrop() {
  const wrap = $("#stage-wrap");
  let depth = 0;
  const accept = (e) => [...e.dataTransfer.types].some((t) => t === "application/x-biocanvas-icon" || t === "Files");
  wrap.addEventListener("dragenter", (e) => {
    if (!accept(e)) return;
    depth++;
    wrap.classList.add("dropping");
  });
  wrap.addEventListener("dragleave", () => {
    if (--depth <= 0) {
      depth = 0;
      wrap.classList.remove("dropping");
    }
  });
  wrap.addEventListener("dragover", (e) => {
    if (accept(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  wrap.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    wrap.classList.remove("dropping");
    const at = screenToDoc(e.clientX, e.clientY);
    const id = e.dataTransfer.getData("application/x-biocanvas-icon");
    if (id) return placeIcon(id, at);
    if (e.dataTransfer.files.length) placeFiles([...e.dataTransfer.files], at, openDropped);
  });
  // stop the window from navigating to files dropped outside the canvas
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  document.addEventListener("paste", async (e) => {
    if (typing(e) || isEditingText()) return;
    const dt = e.clipboardData;
    const text = dt?.getData("text/plain") || "";
    const files = [...(dt?.files || [])];
    if (files.length) {
      e.preventDefault();
      // the picture Copy put there: paste the copied objects themselves, not a picture of them
      if (hasClip() && (await isOurPicture(files))) return pasteClip();
      return placeFiles(files);
    }
    const svg = dt?.getData("image/svg+xml") || (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text) ? text : "");
    if (svg) {
      e.preventDefault();
      return placeSvgText(svg, "Pasted SVG");
    }
    if (pasteClip()) e.preventDefault();
  });
}

/* ---------- autosave ---------- */

// Besides the figure's own file, the app keeps one copy of what is open (in its data folder), so a
// crash or a closed window loses nothing: it opens again at the next start.

let lastSaved = null;
async function autosave() {
  const about = JSON.stringify({ filePath: state.filePath, galleryId: state.galleryId || null, dirty: state.dirty, name: fig.name, folder: fig.folder });
  const content = `{"doc":${serialize()},${about.slice(1)}`;
  if (content === lastSaved) return;
  lastSaved = content;
  try {
    await api("doc.autosave", { content });
  } catch {}
}

async function restoreSession() {
  try {
    const r = await api("doc.autoload", {});
    if (!r.content) return false;
    const { doc, filePath, galleryId, dirty, name, folder } = JSON.parse(r.content);
    if (!doc?.objects) return false;
    if (galleryId && !dirty) {
      // its file is the newest copy (it may have changed since, e.g. synced from another computer)
      try {
        const f = await api("gallery.open", { id: galleryId });
        if (openDocText(f.content, f.path || f.id, f.id, { quiet: true })) return true;
      } catch {
        // gone from the figures folder: it stays open, as a new figure of that name
        setDoc(doc);
        Object.assign(fig, { name: fileName(galleryId).replace(/\.[^.]+$/, ""), folder: folderOf(galleryId) });
        updateTitle();
        return true;
      }
    }
    setDoc(doc, filePath || null, galleryId || null);
    if (!galleryId && !filePath) Object.assign(fig, { name: name || null, folder: folder || "" });
    state.dirty = !!dirty;
    updateTitle();
    if (state.dirty) changed(); // (changes its file didn't get yet are saved now)
    return true;
  } catch {}
  return false;
}

let launch = null; // {content, path, galleryId}: the figure the app was started with, not opened yet (File menu)

const samePath = (a, b) => !!a && !!b && (/^[a-z]:/i.test(a) ? a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase() : a === b);

/** The figure the app was started with (double-clicked or passed on the command line), once. */
async function openLaunchFile() {
  let r = null;
  try {
    r = await api("app.launchFile");
  } catch {}
  if (r?.content == null) return;
  launch = { content: r.content, path: r.path || null, galleryId: r.galleryId || null };
  if (state.dirty && samePath(state.filePath, launch.path)) {
    // the last session was this file, with changes not saved yet: those are newer than the file
    launch = null;
    return toast(`Kept your unsaved changes to ${fileName(state.filePath)} from last time`);
  }
  openLaunched();
}

/**
 * Open the launch file, once the figure from last time is saved (or, from elsewhere with unsaved
 * changes, the user said what to do with them). Cancelled, the file waits in the File menu, as it
 * can't be asked for again.
 */
async function openLaunched() {
  if (!launch) return;
  if (!(await leaveFigure({ replace: true }))) {
    if (launch) toast(`${fileName(launch.path)} is waiting in the File menu`);
    return;
  }
  if (!launch) return;
  const l = launch;
  launch = null;
  openDocText(l.content, l.path, l.galleryId);
}

/* ---------- start ---------- */

async function start() {
  initTheme();
  initLayout(); // (the panels' widths first: the canvas fits the page into what they leave)
  initCanvas();
  state.doc = newDoc();
  initMenus();
  initPanels();
  initContextMenu();
  initQuickbar();
  initDrop();
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      keys.space = false;
      $("#stage").classList.remove("panning");
    }
  });
  bus.on("fit", fitView);
  bus.on("doc", changed);
  bus.on("doc", updateTitle);
  // keep the autosave close behind the last edit: closing the window can't wait for a save
  bus.on("doc", debounce(autosave, 2000));
  // (a resized window or side panel moves the view with the canvas: canvas.js stageResized)
  setTool("select");
  // a ?sandbox test page leaves the shared session alone (api.js drops its autosaves)
  if (sandbox || !(await restoreSession())) setDoc(newDoc());
  initLibrary();
  initHome({
    openFigure: (r) => openDocText(r.content, r.path || r.id, r.id),
    newFigure,
    current: () => ({
      id: state.galleryId || null,
      name: figureName(),
      dirty: state.dirty,
      saves: savesItself(),
      empty: !state.doc.objects.length,
      get svg() {
        return documentSvg(state.doc, { background: state.doc.background || "#ffffff" }); // (drawn only when Home shows it)
      },
    }),
    leave: () => leaveFigure({ replace: true }),
    flush: () => saveFigure(),
    openFile: () => openDocument({ fromHome: true }),
    relinked: relinkFigure,
    // the open figure went to the trash: the editor starts a new one (its undo history is kept,
    // for if it is restored)
    unlinked: (id) => state.galleryId === id && setDoc(newDoc()),
  });
  const brand = $("#topbar .brand");
  brand.title = "Home: all your figures";
  brand.setAttribute("role", "button");
  brand.addEventListener("click", goHome);
  $("#btn-home").addEventListener("click", goHome);
  $("#doc-name").addEventListener("click", renameDialog);
  $("#save-state").addEventListener("click", () => {
    if (fig.error) saveFigure();
    else if (state.dirty && !savesItself()) saveDocument(false);
  });
  showSaveState();
  // the home page first (a test page only when asked: ?sandbox&home); a figure the app was
  // started with opens over it
  if ((!sandbox && homePrefs.atStart) || params.has("home")) showHome();
  // macOS: a figure double-clicked in the Finder while BioCraft is open (app/src/main.rs on_run_event)
  if (isDesktop) window.__TAURI__.event?.listen("open-file", () => openLaunchFile()).catch(() => {});
  // (not awaited: its question about unsaved changes holds up nothing else)
  if (!sandbox) openLaunchFile();
  setInterval(autosave, 15000);
  window.addEventListener("beforeunload", () => {
    saveFigure();
    autosave();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    saveFigure();
    autosave();
  });
  // the desktop window saves the open figure before it closes (waiting at most a few seconds), then
  // closes itself (capabilities: core:window:allow-destroy)
  if (isDesktop) {
    const wait = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
    window.__TAURI__.window?.getCurrentWindow?.().onCloseRequested(async () => {
      try {
        finishTextEdit();
        await wait(saveFigure(), 4000);
        await wait(autosave(), 1500);
      } catch {}
    }).catch(() => {});
  }
}

start();
