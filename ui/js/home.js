// Home page: the figure gallery shown at start-up and from the BioCraft logo. Create a new figure
// (page-size presets), browse My files with a preview of every canvas, keep figures in project
// folders, search, sort, grid or list, and each figure's actions (open, rename, duplicate, move to
// a folder, trash). The figures are ordinary .biocraft files in the figures folder, one level of
// folders deep (app/src/gallery.rs), so they can be backed up or synced like any other files.

import { api } from "./api.js";
import { el, toast } from "./util.js";
import { modal, openMenu, closeMenus, askText as ask } from "./menus.js";

const KEY = "biocraft.home";
const prefs = (() => {
  const d = { sort: "opened", layout: "grid", atStart: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return d;
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: remembered for this session only */
  }
};
export const homePrefs = prefs;

/** Page sizes offered by Create new (mm). */
export const SIZES = [
  { label: "Single-column figure", w: 89, h: 80 },
  { label: "1.5-column figure", w: 120, h: 90 },
  { label: "Double-column figure", w: 183, h: 120 },
  { label: "Slide (16:9)", w: 254, h: 143 },
  { label: "A4 page or poster panel", w: 210, h: 297 },
  { label: "Square", w: 120, h: 120 },
];

/**
 * What Home needs from the editor: current() → {id, name, dirty, saves, empty, svg} for the figure
 * open now; leave() → bool before another figure replaces it (it is saved, or the user is asked);
 * openFigure({id, path, name, content}); newFigure({folder, width, height}) → bool (its file is made
 * at its first change); openFile() → bool (a file from elsewhere); flush() before Home changes the
 * open figure's file; relinked(oldId, newId, path) when a figure is renamed or moved, and
 * unlinked(id) when one goes to the trash.
 */
let hooks = null;
export function initHome(h) {
  hooks = h;
}

const view = { folder: null, trash: false, query: "", data: null, trashFiles: [] };
let root = null, side = null, files = null, heading = null, search = null, previewUrl = null;
export const homeOpen = () => !!root && !root.hidden;

export async function showHome() {
  if (!root) build();
  root.hidden = false;
  document.body.classList.add("home-open");
  await refreshHome();
  root.querySelector(".home-main").scrollTop = 0;
  search.focus({ preventScroll: true });
}

export function hideHome() {
  if (!root) return;
  root.hidden = true;
  document.body.classList.remove("home-open");
  closeMenus();
}

/** Back to the figure that is open in the editor. */
function backToEditor() {
  hideHome();
}

export async function refreshHome() {
  try {
    view.data = await api("gallery.list", {});
    if (view.trash) view.trashFiles = (await api("gallery.trashList", {})).files || [];
  } catch (e) {
    toast("Could not read your figures: " + e.message, true);
    view.data = view.data || { folders: [], files: [], trash: 0, root: "" };
  }
  if (view.folder && !view.data.folders.some((f) => f.name === view.folder)) view.folder = null;
  render();
}

/* ---------- building ---------- */

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  files: '<rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 15l3-4 3 3 2-2 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  folder: '<path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v7a2 2 0 01-2 2h-13a2 2 0 01-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  open: '<path d="M4 7.5a2 2 0 012-2h4l2 2h6a2 2 0 012 2V11M3.5 18.5l2.5-7h15l-2.5 7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  back: '<path d="M14 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
};
const icon = (k) => el("span.hicon", { html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>` });

function build() {
  root = el("div#home", { hidden: true, role: "region", "aria-label": "Home" });
  const brand = document.querySelector("#topbar .brand")?.cloneNode(true) || el("div.brand", {}, "BioCraft");
  const back = el("button.btn.home-back", { onclick: backToEditor, title: "Back to the figure you are editing (Esc)" }, icon("back"), el("span.back-name"));
  const top = el("header.home-top", {}, brand, el("span.home-title", {}, "Home"), el("div.spacer"), back);
  const create = el("button.primary.home-create", { onclick: (e) => createMenu(e.currentTarget) }, icon("plus"), "Create new");
  side = el("nav.home-side", { "aria-label": "Folders" });
  heading = el("h2.home-h");
  search = el("input.num.home-search", { type: "search", placeholder: "Search all figures", "aria-label": "Search all figures" });
  search.addEventListener("input", () => {
    view.query = search.value.trim().toLowerCase();
    renderFiles();
  });
  const sort = el("select.num.home-sort", { "aria-label": "Sort by" },
    ...[["opened", "Last opened"], ["modified", "Last edited"], ["created", "Date created"], ["name", "Name"]].map(([v, t]) => el("option", { value: v, selected: prefs.sort === v }, t)));
  sort.addEventListener("change", () => {
    prefs.sort = sort.value;
    savePrefs();
    renderFiles();
  });
  const layoutBtn = (k, t) => el("button.btn.small.home-layout" + (prefs.layout === k ? ".on" : ""), { title: t, "aria-label": t, "data-layout": k, onclick: () => {
    prefs.layout = k;
    savePrefs();
    root.querySelectorAll(".home-layout").forEach((b) => b.classList.toggle("on", b.dataset.layout === k));
    renderFiles();
  } }, icon(k));
  files = el("div.home-files");
  const hero = el("section.home-hero", {},
    el("h1", {}, "What would you like to create today?"),
    el("div.home-quick", {},
      ...SIZES.slice(0, 4).map((s) => quickCard(s.label, `${s.w} × ${s.h} mm`, () => createFigure(s))),
      quickCard("Open a figure file", "a .biocraft file from elsewhere", () => openElsewhere(), "open")));
  const main = el("main.home-main", {},
    hero,
    el("section.home-list", {},
      el("div.home-list-head", {}, heading, el("button.primary.small-create", { onclick: (e) => createMenu(e.currentTarget) }, icon("plus"), "Create new")),
      el("div.home-tools", {}, search, sort, layoutBtn("grid", "Grid"), layoutBtn("list", "List")),
      files));
  root.append(top, el("div.home-body", {}, el("aside.home-aside", {}, create, side), main));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector(".modal-back") && hooks?.current()) {
      e.preventDefault();
      backToEditor();
    }
  });
  document.body.append(root);
}

function quickCard(title, sub, run, ic = "plus") {
  return el("button.home-qcard", { onclick: run }, icon(ic), el("span.q-title", {}, title), el("span.q-sub", {}, sub));
}

/* ---------- rendering ---------- */

function render() {
  const d = view.data;
  const cur = hooks?.current();
  const back = root.querySelector(".home-back");
  back.hidden = !cur;
  if (cur) back.querySelector(".back-name").textContent = `Back to ${cur.name}`;
  const item = (label, ic, count, active, onclick, extra = {}) =>
    el("button.side-item" + (active ? ".on" : ""), { onclick, ...extra }, icon(ic), el("span.side-label", {}, label), count == null ? null : el("span.side-count", {}, String(count)));
  const folderItem = (f) => {
    const b = item(f.name, "folder", f.count, !view.trash && view.folder === f.name, () => go(f.name, false), { title: f.name });
    const more = el("span.side-more", { role: "button", tabindex: 0, title: "Folder actions", "aria-label": `${f.name}: folder actions`, onclick: (e) => {
      e.stopPropagation();
      folderMenu(f, more);
    } }, "⋯");
    b.append(more);
    // drop a figure card on a folder to move it there
    b.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/biocraft-figure")) { e.preventDefault(); b.classList.add("drop"); } });
    b.addEventListener("dragleave", () => b.classList.remove("drop"));
    b.addEventListener("drop", (e) => {
      b.classList.remove("drop");
      const id = e.dataTransfer.getData("text/biocraft-figure");
      if (id) moveFigure(id, f.name);
    });
    return b;
  };
  const all = item("My files", "files", d.files.length, !view.trash && !view.folder, () => go(null, false));
  all.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/biocraft-figure")) { e.preventDefault(); all.classList.add("drop"); } });
  all.addEventListener("dragleave", () => all.classList.remove("drop"));
  all.addEventListener("drop", (e) => {
    all.classList.remove("drop");
    const id = e.dataTransfer.getData("text/biocraft-figure");
    if (id) moveFigure(id, "");
  });
  side.replaceChildren(
    el("div.side-h", {}, "Created by me"),
    all,
    ...d.folders.map(folderItem),
    el("button.side-item.side-new", { onclick: newFolder }, icon("plus"), el("span.side-label", {}, "New folder")),
    el("div.side-sep"),
    item("Trash", "trash", d.trash || null, view.trash, () => go(null, true)),
    el("label.qb-check.side-start", {}, el("input", { type: "checkbox", checked: prefs.atStart, onchange: (e) => { prefs.atStart = e.target.checked; savePrefs(); } }), "Show Home when BioCraft starts"),
    el("div.side-root", { title: d.root }, el("div.small.muted", {}, "Figures folder"), el("div.side-path", {}, d.root),
      el("div.side-links", {},
        d.canReveal ? el("a", { onclick: () => api("gallery.reveal", { folder: view.folder || "" }).catch((e) => toast(e.message, true)) }, "Show in folder") : null,
        d.canReveal ? el("a", { onclick: changeRoot }, "Change…") : null)));
  renderFiles();
}

function go(folder, trash) {
  view.folder = folder;
  view.trash = trash;
  if (trash) refreshHome();
  else render();
}

const dateFmt = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

function sorted(list) {
  const key = prefs.sort;
  const out = [...list];
  if (key === "name") out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  else out.sort((a, b) => ((b[key] || (key === "opened" ? 0 : b.modified) || 0) - (a[key] || (key === "opened" ? 0 : a.modified) || 0)) || (b.modified || 0) - (a.modified || 0));
  return out;
}

function renderFiles() {
  if (!view.data) return;
  const q = view.query;
  files.className = "home-files " + prefs.layout;
  if (view.trash) {
    heading.textContent = "Trash";
    const list = view.trashFiles.filter((f) => !q || f.name.toLowerCase().includes(q));
    files.replaceChildren(...(list.length ? list.map(trashCard) : [el("div.home-empty", {}, "The trash is empty.")]));
    return;
  }
  heading.textContent = view.folder || "My files";
  const list = sorted(view.data.files.filter((f) => (q ? (f.name + " " + f.folder).toLowerCase().includes(q) : view.folder == null || f.folder === view.folder)));
  const cards = list.map(card);
  const cur = hooks?.current();
  // the figure open in the editor, when it isn't one of these files (not saved yet) or has unsaved changes
  if (cur && !q && view.folder == null && (!cur.id || cur.dirty) && !cur.empty) cards.unshift(currentCard(cur));
  files.replaceChildren(...(cards.length ? cards : [el("div.home-empty", {}, q ? `No figures match “${search.value}”.` : view.folder ? "This folder is empty. Create a figure here, or drag figures onto the folder in the list." : "No figures yet. Create one above.")]));
}

function sizeText(f) {
  return f.width && f.height ? `${Math.round(f.width)} × ${Math.round(f.height)} mm` : "";
}

function dateText(f) {
  if (prefs.sort === "opened" && f.opened) return "Opened " + dateFmt(f.opened);
  if (prefs.sort === "created" && f.created) return "Created " + dateFmt(f.created);
  return "Edited " + dateFmt(f.modified);
}

function thumbEl(src) {
  return src ? el("img", { src, alt: "", loading: "lazy", draggable: false }) : el("div.card-none", {}, "No preview");
}

function card(f) {
  const isOpen = hooks?.current()?.id === f.id;
  const more = el("button.card-more", { title: "More actions", "aria-label": `${f.name}: more actions`, onclick: (e) => {
    e.stopPropagation();
    figureMenu(f, more);
  } }, "⋯");
  const c = el("div.card" + (isOpen ? ".open" : ""), { tabindex: 0, role: "button", title: f.folder ? `${f.folder} / ${f.name}` : f.name, draggable: true, onclick: () => openFigure(f) },
    el("div.card-thumb", {}, thumbEl(f.thumb), isOpen ? el("span.card-badge", {}, "Open now") : null),
    el("div.card-body", {},
      el("div.card-text", {}, el("div.card-name", {}, f.name),
        el("div.card-date", {}, [dateText(f), prefs.layout === "list" && f.folder ? f.folder : null, prefs.layout === "list" ? sizeText(f) : null].filter(Boolean).join(" · "))),
      more));
  c.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openFigure(f);
  });
  c.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    figureMenu(f, null, e.clientX, e.clientY);
  });
  c.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/biocraft-figure", f.id);
    e.dataTransfer.effectAllowed = "move";
  });
  return c;
}

function currentCard(cur) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(new Blob([cur.svg], { type: "image/svg+xml" }));
  const badge = !cur.dirty ? "Open now" : cur.saves ? "Not saved" : "Unsaved changes";
  return el("div.card.current", { tabindex: 0, role: "button", title: "Back to the figure you are editing", onclick: backToEditor },
    el("div.card-thumb", {}, thumbEl(previewUrl), el("span.card-badge", {}, badge)),
    el("div.card-body", {}, el("div.card-text", {}, el("div.card-name", {}, cur.name), el("div.card-date", {}, cur.saves ? "Open in the editor" : "Open from elsewhere"))));
}

function trashCard(f) {
  const more = el("button.card-more", { title: "More actions", onclick: (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    openMenu([
      { label: "Restore", run: () => restore(f) },
      "-",
      { label: "Delete forever…", run: () => deleteForever(f) },
    ], r.left, r.bottom + 4, more);
  } }, "⋯");
  return el("div.card.trashed", { tabindex: 0, title: f.from ? `From ${f.from}` : f.name, onclick: () => restore(f) },
    el("div.card-thumb", {}, thumbEl(f.thumb)),
    el("div.card-body", {}, el("div.card-text", {}, el("div.card-name", {}, f.name), el("div.card-date", {}, f.trashed ? "Moved to trash " + dateFmt(f.trashed) : "In the trash")), more));
}

/* ---------- actions ---------- */

async function createFigure(size) {
  const folder = view.folder || "";
  if (await hooks.newFigure({ folder, width: size.w, height: size.h })) toast(`New figure: it saves itself in ${folder || "My files"} as you work`);
}

function createMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const d = view.data;
  openMenu([
    { heading: view.folder ? `New figure in ${view.folder}` : "New figure" },
    ...SIZES.map((s) => ({ label: `${s.label}  ·  ${s.w} × ${s.h} mm`, run: () => createFigure(s) })),
    "-",
    { label: "Open a figure file…", run: openElsewhere },
    d?.canReveal ? { label: "Add figure files to this folder…", run: importFiles } : null,
    { label: "New folder…", run: newFolder },
  ].filter(Boolean), r.left, r.bottom + 4, anchor);
}

async function openFigure(f) {
  const cur = hooks.current();
  if (cur?.id === f.id) return backToEditor(); // (the same figure, with its undo history)
  if (!(await hooks.leave())) return;
  try {
    const r = await api("gallery.open", { id: f.id });
    hooks.openFigure(r);
    hideHome();
  } catch (e) {
    toast("Could not open: " + e.message, true);
  }
}

async function openElsewhere() {
  if (await hooks.openFile()) hideHome();
}

async function importFiles() {
  try {
    const r = await api("gallery.import", { folder: view.folder || "" });
    if (r.ids?.length) toast(`Added ${r.ids.length} figure${r.ids.length === 1 ? "" : "s"}`);
    await refreshHome();
  } catch (e) {
    toast(e.message, true);
  }
}

async function newFolder() {
  const name = await ask("New folder", "Name", "New project", "Create");
  if (!name) return;
  try {
    const r = await api("gallery.newFolder", { name });
    view.folder = r.name;
    view.trash = false;
    await refreshHome();
  } catch (e) {
    toast(e.message, true);
  }
}

function folderMenu(f, anchor) {
  const r = anchor.getBoundingClientRect();
  openMenu([
    { label: "Rename…", run: async () => {
      const name = await ask("Rename folder", "Name", f.name, "Rename");
      if (!name || name === f.name) return;
      try {
        if (hooks.current()?.id?.startsWith(f.name + "/")) await hooks.flush();
        const res = await api("gallery.renameFolder", { folder: f.name, name });
        const root = view.data.root, sep = root.includes("\\") ? "\\" : "/";
        for (const x of view.data.files.filter((x) => x.folder === f.name)) {
          const to = res.name + x.id.slice(f.name.length);
          hooks.relinked(x.id, to, view.data.canReveal ? root + sep + to.replace("/", sep) : null);
        }
        if (view.folder === f.name) view.folder = res.name;
        await refreshHome();
      } catch (e) {
        toast(e.message, true);
      }
    } },
    view.data.canReveal ? { label: "Show in folder", run: () => api("gallery.reveal", { folder: f.name }).catch((e) => toast(e.message, true)) } : null,
    "-",
    { label: "Delete folder", disabled: f.count > 0, title: f.count ? "Move its figures out or to the trash first" : "", run: async () => {
      try {
        await api("gallery.deleteFolder", { folder: f.name });
        if (view.folder === f.name) view.folder = null;
        await refreshHome();
      } catch (e) {
        toast(e.message, true);
      }
    } },
  ].filter(Boolean), r.left, r.bottom + 4, anchor);
}

function figureMenu(f, anchor, x, y) {
  const d = view.data;
  const r = anchor?.getBoundingClientRect();
  const folders = [{ name: "", label: "My files (no folder)" }, ...d.folders.map((x) => ({ name: x.name, label: x.name }))];
  openMenu([
    { label: "Open", run: () => openFigure(f) },
    { label: "Rename…", run: () => renameFigure(f) },
    { label: "Duplicate", run: async () => {
      try {
        if (hooks.current()?.id === f.id) await hooks.flush();
        await api("gallery.duplicate", { id: f.id });
        await refreshHome();
      } catch (e) {
        toast(e.message, true);
      }
    } },
    { label: "Move to", submenu: [
      ...folders.map((x) => ({ label: x.label, current: f.folder === x.name, disabled: f.folder === x.name, run: () => moveFigure(f.id, x.name) })),
      "-",
      { label: "New folder…", run: async () => {
        const name = await ask("New folder", "Name", "New project", "Create and move");
        if (!name) return;
        try {
          const res = await api("gallery.newFolder", { name });
          await moveFigure(f.id, res.name);
        } catch (e) {
          toast(e.message, true);
        }
      } },
    ] },
    d.canReveal ? { label: "Show in folder", run: () => api("gallery.reveal", { id: f.id }).catch((e) => toast(e.message, true)) } : null,
    "-",
    { label: "Move to trash", run: () => trashFigure(f) },
  ].filter(Boolean), r ? r.left : x, r ? r.bottom + 4 : y, anchor);
}

async function renameFigure(f) {
  const name = await ask("Rename figure", "Name", f.name, "Rename");
  if (!name || name === f.name) return;
  try {
    if (hooks.current()?.id === f.id) await hooks.flush();
    const r = await api("gallery.rename", { id: f.id, name });
    hooks.relinked(f.id, r.id, r.path);
    await refreshHome();
  } catch (e) {
    toast(e.message, true);
  }
}

async function moveFigure(id, folder) {
  try {
    if (hooks.current()?.id === id) await hooks.flush();
    const r = await api("gallery.move", { id, folder });
    hooks.relinked(id, r.id, r.path);
    await refreshHome();
    toast(folder ? `Moved to ${folder}` : "Moved to My files");
  } catch (e) {
    toast(e.message, true);
  }
}

async function trashFigure(f) {
  try {
    if (hooks.current()?.id === f.id) await hooks.flush();
    await api("gallery.trash", { id: f.id });
    hooks.unlinked(f.id);
    await refreshHome();
    toast(`“${f.name}” moved to the trash`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function restore(f) {
  try {
    const r = await api("gallery.restore", { id: f.id });
    await refreshHome();
    toast(`Restored “${f.name}”` + (r.id.includes("/") ? ` to ${r.id.split("/")[0]}` : ""));
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteForever(f) {
  const ok = await modal("Delete forever", el("div.meta-line", {}, `Delete “${f.name}” permanently? This can't be undone.`), [{ label: "Cancel", value: false }, { label: "Delete", primary: true, value: true }]);
  if (!ok) return;
  try {
    await api("gallery.deleteForever", { id: f.id });
    await refreshHome();
  } catch (e) {
    toast(e.message, true);
  }
}

async function changeRoot() {
  try {
    const r = await api("gallery.setRoot", {});
    if (!r.cancelled) {
      view.folder = null;
      await refreshHome();
    }
  } catch (e) {
    toast(e.message, true);
  }
}
