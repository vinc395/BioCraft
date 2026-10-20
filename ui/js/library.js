// Left panel: search and browse the icon library.

import { api, libUrl, isDesktop } from "./api.js";
import { placeIcon, brushWithIcon, replaceIcons, replaceable } from "./actions.js";
import { $, el, debounce, bus, toast, MOD } from "./util.js";
import { openMenu, modal } from "./menus.js";
import { state, selectedObjs, MM } from "./model.js";
import { documentSvg, visualBox } from "./render.js";
import { revealPanel } from "./layout.js";

const PAGE = 150;
const q = { q: "", category: "", pack: "", license: "", favorites: false, recent: false, mine: false };
let total = 0, offset = 0, loading = false, info = null, favs = new Set();
let widenedFrom = ""; // the chip a search left because nothing in it matched (until the search is cleared)
let full = 0; // how many of the results match every word of the search (the rest match some)

function applyInfo() {
  favs = new Set(info.favorites || []);
  fitSearchHint();
  const packSel = $("#lib-pack");
  packSel.replaceChildren(el("option", { value: "" }, "All sources"), ...info.packs.map((p) => el("option", { value: p.id }, `${p.name} (${p.count.toLocaleString()})`)));
  renderCats();
}

const EXAMPLES = "e.g. T cell, mitochondria, pipette";
let hintCtx = null;

/** The search box's hint: with examples while there is room for them, shorter in a narrow panel (the tooltip keeps them). */
function fitSearchHint() {
  const inp = $("#lib-search");
  if (!inp || !info) return;
  const n = info.total.toLocaleString();
  inp.title = `Search ${n} icons, ${EXAMPLES} (/ or ${MOD}F)`;
  const cs = getComputedStyle(inp);
  // (a search box keeps room for its clear button even while it is empty)
  const room = inp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (inp.type === "search" ? 18 : 0);
  if (room <= 0) return; // hidden in a collapsed panel: fitted when it shows again
  hintCtx ||= document.createElement("canvas").getContext("2d");
  hintCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const hints = [`Search ${n} icons… (${EXAMPLES})`, `Search ${n} icons…`, "Search icons…"];
  inp.placeholder = hints.find((t) => hintCtx.measureText(t).width <= room) || hints[hints.length - 1];
}

function emptyState() {
  $("#lib-grid").replaceChildren(el("div.lib-more", { style: { textAlign: "left", lineHeight: 1.5 } },
    el("b", {}, "No icon library found."), el("br"),
    "Choose the library folder (the one built by biocanvas-libbuild, containing index.json). ",
    "You can still draw shapes, arrows, membranes and text, and place your own SVG or PNG files.", el("br"), el("br"),
    el("button.btn", { onclick: chooseLibrary }, "Choose library folder…")));
  $("#lib-status").textContent = "";
}

export async function chooseLibrary() {
  try {
    const r = await api("app.setLibrary", {});
    if (r.cancelled) return;
    info = r;
    Object.assign(q, { q: "", category: "", pack: "", favorites: false, recent: false, mine: false });
    $("#lib-search").value = "";
    applyInfo();
    search();
    toast(`Library: ${info.total.toLocaleString()} icons`);
  } catch (e) {
    toast(e.message, true);
  }
}

export async function initLibrary() {
  const grid = $("#lib-grid");
  try {
    info = await api("library.info");
  } catch (e) {
    $("#lib-status").textContent = "Library unavailable: " + e.message;
    return;
  }
  applyInfo();
  const packSel = $("#lib-pack");
  // the hint follows the panel's width
  new ResizeObserver(() => fitSearchHint()).observe($("#lib-search"));

  $("#lib-search").addEventListener("input", debounce((e) => {
    const v = e.target.value.trim();
    if (v === q.q) return; // searched already (Enter got there first)
    q.q = v;
    search();
  }, 140));
  $("#lib-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // the first result for the words in the box: while the tiles are still the last search's, search first
      const v = e.target.value.trim();
      const add = () => {
        const first = grid.querySelector(".tile");
        if (first) placeIcon(first.dataset.id);
      };
      if (v === q.q && !loading) add();
      else {
        q.q = v;
        const done = search(), mine = search.cur;
        done.then(() => search.cur === mine && add());
      }
    }
    if (e.key === "Escape") {
      e.target.value = "";
      q.q = "";
      search();
      e.target.blur();
    }
  });
  packSel.addEventListener("change", () => {
    q.pack = packSel.value;
    search();
  });
  $("#lib-license").addEventListener("change", (e) => {
    q.license = e.target.value;
    search();
  });
  grid.addEventListener("scroll", () => {
    if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 400) more();
  });
  grid.addEventListener("click", (e) => {
    const t = e.target.closest(".tile");
    if (t) placeIcon(t.dataset.id);
  });
  grid.addEventListener("contextmenu", (e) => {
    const t = e.target.closest(".tile");
    if (!t) return;
    e.preventDefault();
    const id = t.dataset.id;
    const mine = id.startsWith("user/");
    openMenu([
      { label: "Add to figure", run: () => placeIcon(id) },
      { label: "Paint along a path (brush)", run: () => brushWithIcon(id) },
      { label: favs.has(id) ? "Remove from favourites" : "Add to favourites", run: () => toggleFav(id) },
      ...(mine ? ["-", { label: "Rename, category & tags…", run: () => editUserIcon(t._item) }, { label: "Remove from My library", run: () => removeUser(id) }] : []),
    ], e.clientX, e.clientY);
  });
  grid.addEventListener("dragstart", (e) => {
    const t = e.target.closest(".tile");
    if (!t) return;
    e.dataTransfer.setData("application/x-biocanvas-icon", t.dataset.id);
    e.dataTransfer.setData("text/plain", t.dataset.id);
    e.dataTransfer.effectAllowed = "copy";
    const img = t.querySelector("img");
    if (img) e.dataTransfer.setDragImage(img, 38, 38);
  });
  bus.on("library-recent", () => q.recent && search());
  // drop files anywhere on the library panel to add them to My library
  const panel = $("#library");
  panel.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      panel.classList.add("dropping");
    }
  });
  panel.addEventListener("dragleave", (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove("dropping");
  });
  panel.addEventListener("drop", (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    panel.classList.remove("dropping");
    uploadFiles(e.dataTransfer.files);
  });
  if (!info.total) emptyState();
  else search();
  loadMine();
}

/* ---------- My library for Insert › From My library ---------- */

let mine = []; // the newest of your own icons (the menu can't wait for a search)

/** Reload the list (after My library changes). */
export async function loadMine() {
  try {
    mine = (await api("library.search", { pack: "user", offset: 0, limit: 30 })).items || [];
  } catch {
    mine = [];
  }
}

/** Your own icons, as last loaded (up to 30), and how many there are. */
export const myLibrary = () => ({ items: mine, total: info?.userCount ?? mine.length });

/** Show My library in the library panel (opening the panel if it was collapsed). */
export function showMyLibrary() {
  revealPanel("library");
  setCat({ mine: true });
}

function renderCats() {
  const box = $("#lib-cats");
  box.replaceChildren();
  // (a chip wider than a narrow panel ends in "…": its title has the whole name)
  const chip = (label, n, active, onclick, title = "") =>
    el("button.chip" + (active ? ".active" : ""), { onclick, title: title || (n != null ? `${label} (${n.toLocaleString()})` : label) }, label, n != null ? el("span.n", {}, n.toLocaleString()) : null);
  const none = !q.category && !q.favorites && !q.recent && !q.mine;
  box.append(
    chip("All", null, none, () => setCat({})),
    chip("📁 My library", info.userCount || 0, q.mine, () => setCat({ mine: true }), "Your own SVGs, pictures and saved figure parts"),
    chip("★ Favourites", null, q.favorites, () => setCat({ favorites: true })),
    chip("Recent", null, q.recent, () => setCat({ recent: true })),
  );
  for (const c of info.categories) box.append(chip(c.name, c.count, q.category === c.id, () => setCat({ category: c.id })));
  renderMineBar();
}

function setCat({ category = "", favorites = false, recent = false, mine = false }) {
  widenedFrom = "";
  restoreScope = null; // a chip chosen now stays chosen
  Object.assign(q, { category, favorites, recent, mine });
  renderCats();
  search();
}

/* ---------- My library: your own icons ---------- */

function renderMineBar() {
  let bar = $("#lib-mine");
  if (!bar) {
    bar = el("div#lib-mine.lib-mine");
    $("#lib-status").before(bar);
  }
  bar.style.display = q.mine ? "" : "none";
  bar.replaceChildren(
    el("div.row", {},
      el("button.btn", { onclick: pickUploads, title: "SVG, SVGZ, PNG, JPG or GIF" }, "+ Add files…"),
      el("button.btn", { onclick: saveSelectionToLibrary, title: "Save the selected objects as one reusable icon (with your colours)" }, "Save selection"),
      isDesktop ? el("button.btn", { onclick: () => api("app.revealUserLibrary").catch((e) => toast(e.message, true)), title: "Open the folder that holds My library" }, "Folder") : null),
    el("div.small.muted", {}, "Drop SVG or picture files anywhere on this panel to add them. Right-click an icon to rename, re-categorise or remove it."));
}

const UPLOAD_TYPES = /\.(svgz?|png|jpe?g|gif)$/i;

function readAsBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/** Send files to My library (from the picker or a drop). */
export async function uploadFiles(files) {
  const list = [...files].filter((f) => UPLOAD_TYPES.test(f.name) || f.type.startsWith("image/"));
  if (!list.length) return toast("Choose SVG, PNG, JPG or GIF files", true);
  toast(`Adding ${list.length} file${list.length > 1 ? "s" : ""} to My library…`);
  try {
    const items = [];
    for (const f of list) items.push({ name: f.name.replace(/\.[^.]+$/, ""), base64: await readAsBase64(f) });
    const r = await api("library.importData", { items, note: "Uploaded" });
    afterImport(r);
  } catch (e) {
    toast("Could not add files: " + e.message, true);
  }
}

async function afterImport(r) {
  if (r.added?.length) toast(`Added ${r.added.length} icon${r.added.length > 1 ? "s" : ""} to My library`);
  if (r.errors?.length) toast(`${r.errors.length} file(s) could not be read: ${r.errors[0].error}`, true);
  info = await api("library.info");
  applyInfo();
  setCat({ mine: true });
  loadMine();
}

export function pickUploads() {
  const inp = $("#file-input");
  inp.accept = ".svg,.svgz,.png,.jpg,.jpeg,.gif";
  inp.onchange = () => {
    const files = [...inp.files];
    inp.value = "";
    if (files.length) uploadFiles(files);
  };
  inp.click();
}

/** Ask for a name and category (shared by "Save selection" and "Rename"). */
async function nameDialog(title, { name = "", category = "", tags = [] } = {}) {
  const nameIn = el("input.num", { value: name, placeholder: "Name" });
  const catSel = el("select", {}, el("option", { value: "" }, "Choose automatically"),
    ...(info.allCategories || info.categories).map((c) => el("option", { value: c.id, selected: c.id === category }, c.name)));
  const tagsIn = el("input.num", { value: tags.join(", "), placeholder: "e.g. synovium, RA, my lab" });
  for (const i of [nameIn, tagsIn]) i.addEventListener("keydown", (e) => e.stopPropagation());
  const body = el("div", { style: { display: "grid", gap: "8px" } },
    el("div.field.wide", {}, el("label", {}, "Name"), nameIn),
    el("div.field.wide", {}, el("label", {}, "Category"), catSel),
    el("div.field.wide", {}, el("label", {}, "Tags"), tagsIn));
  setTimeout(() => nameIn.select(), 30);
  const ok = await modal(title, body, [{ label: "Cancel", value: false }, { label: "Save", primary: true, value: true }]);
  if (!ok) return null;
  return { name: nameIn.value.trim(), category: catSel.value, tags: tagsIn.value.split(",").map((t) => t.trim()).filter(Boolean) };
}

/** Save the selected figure objects as one icon in My library — colours, text and all. */
export async function saveSelectionToLibrary() {
  const objs = selectedObjs();
  if (!objs.length) return toast("Select the objects to save first");
  const first = objs[0];
  const d = await nameDialog("Save selection to My library", { name: objs.length === 1 ? first.name || state.doc.assets[first.asset]?.meta?.name || "" : "" });
  if (!d) return;
  const b = visualBox(objs), m = 1.5 * MM; // glows reach past the selection box
  const svg = documentSvg(state.doc, { objects: state.doc.objects.filter((o) => state.selection.includes(o.id)), crop: { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m }, background: null });
  try {
    const r = await api("library.importData", { items: [{ name: d.name || "My icon", svg, tags: d.tags }], category: d.category || null, note: "Saved from a figure" });
    afterImport(r);
  } catch (e) {
    toast("Could not save: " + e.message, true);
  }
}

async function editUserIcon(it) {
  const d = await nameDialog("Edit icon", { name: it.name, category: it.category, tags: it.tags || [] });
  if (!d) return;
  try {
    await api("library.updateUser", { id: it.id, name: d.name, category: d.category || null, tags: d.tags });
    info = await api("library.info");
    applyInfo();
    search();
    loadMine();
  } catch (e) {
    toast(e.message, true);
  }
}

function tile(it) {
  const t = el("div.tile", { draggable: "true", "data-id": it.id, title: `${it.name}\n${packName(it.pack)} · ${it.license}${it.author ? " · " + it.author : ""}` },
    el("img", { src: libUrl(it.thumb), loading: "lazy", alt: "" }),
    el("span.nm", {}, it.name));
  if (it.variants) t.append(el("span.badge", { title: `${it.variants + 1} colour/style variants` }, `+${it.variants}`));
  if (favs.has(it.id)) t.append(el("span.fav", {}, "★"));
  t._item = it;
  return t;
}

export const packName = (id) => info?.packs.find((p) => p.id === id)?.name || id;

async function fetchPage() {
  const { mine, ...rest } = q;
  return api("library.search", { ...rest, ...(mine ? { pack: "user" } : {}), offset, limit: PAGE });
}

/** The chip the list is limited to ("Immune & blood cells", "Favourites"…), or null for All. */
function scopeName() {
  if (q.mine) return "My library";
  if (q.favorites) return "Favourites";
  if (q.recent) return "Recent";
  return q.category ? info?.categories.find((c) => c.id === q.category)?.name || q.category : null;
}

let restoreScope = null; // the chip a search widened away from, chosen again when the search is cleared

/** Search every category (the source and licence filters stay). */
function widen() {
  restoreScope ||= { category: q.category, favorites: q.favorites, recent: q.recent, mine: q.mine };
  Object.assign(q, { category: "", favorites: false, recent: false, mine: false });
  renderCats();
}

export async function search() {
  const grid = $("#lib-grid");
  offset = 0;
  loading = true;
  const my = Symbol();
  search.cur = my;
  try {
    if (!q.q) {
      widenedFrom = "";
      // the search is cleared: back to the chip it widened away from
      if (restoreScope) {
        Object.assign(q, restoreScope);
        restoreScope = null;
        renderCats();
      }
    }
    // the Recent list is not searchable: a search there looks through everything
    if (q.q && q.recent) widen();
    let res = await fetchPage();
    if (search.cur !== my) return;
    const from = scopeName();
    if (q.q && !(res.full ?? res.total) && from) {
      // nothing in this category matches every word: show what the whole library has rather
      // than stop at "Nothing found"
      widen();
      widenedFrom = from;
      res = await fetchPage();
      if (search.cur !== my) return;
    }
    total = res.total;
    full = res.full ?? res.total;
    grid.replaceChildren(...res.items.map(tile));
    grid.scrollTop = 0;
    offset = res.items.length;
    status();
  } catch (e) {
    $("#lib-status").textContent = "Search failed: " + e.message;
  } finally {
    // a search overtaken by a newer one leaves `loading` to that one
    if (search.cur === my) loading = false;
  }
}

async function more() {
  if (loading || offset >= total) return;
  loading = true;
  try {
    const res = await fetchPage();
    $("#lib-grid").append(...res.items.map(tile));
    offset += res.items.length;
    status();
  } finally {
    loading = false;
  }
}

function status() {
  const st = $("#lib-status");
  // results that match only some of the words come after the ones that match them all
  const some = q.q && total > full ? (full ? ` · then ${(total - full).toLocaleString()} matching some of the words` : "") : "";
  if (widenedFrom && q.q && total) {
    st.textContent = `Nothing in ${widenedFrom}, so all categories: ${full ? full.toLocaleString() + " for" : "closest matches for"} “${q.q}”${some}`;
    return;
  }
  if (q.q && total && !full) {
    st.textContent = `No icon matches every word of “${q.q}” — ${total.toLocaleString()} closest matches`;
    return;
  }
  if (some) {
    st.textContent = `${full.toLocaleString()} icons for “${q.q}”${some}`;
    return;
  }
  if (q.mine && !total && !q.q) {
    st.textContent = "My library is empty — add files or save a selection from your figure.";
    return;
  }
  if (q.q && !total && (q.pack || q.license)) {
    // the source or licence filter hides everything: say so, with a way out
    const where = [q.pack && packName(q.pack), q.license && $("#lib-license").selectedOptions[0]?.textContent].filter(Boolean).join(", ");
    st.replaceChildren(`Nothing found for “${q.q}” in ${where}. `, el("button.linkbtn", {
      onclick: () => {
        q.pack = q.license = "";
        $("#lib-pack").value = $("#lib-license").value = "";
        search();
      },
    }, "Search all sources"));
    return;
  }
  const what = q.mine ? "of your icons" : q.favorites ? "favourites" : q.recent ? "recent icons" : "icons";
  $("#lib-status").textContent = total ? `${total.toLocaleString()} ${what}${q.q ? ` for “${q.q}”` : ""}` : q.q ? `Nothing found for “${q.q}”. Try a broader word.` : `No ${what} yet`;
}

async function toggleFav(id) {
  const r = await api("library.favorite", { id });
  if (r.favorite) favs.add(id);
  else favs.delete(id);
  if (q.favorites) search();
  else {
    const t = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
    if (t?._item) t.replaceWith(tile(t._item));
  }
  bus.emit("favorites", favs);
}

/* ---------- Replace: swap selected icons for another library icon ---------- */

const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke-width="2"/><path d="M15.5 15.5L21 21" stroke-width="2"/></svg>';

/**
 * Search the library for the icon to put in place of the selected icon(s). They keep their
 * place, fitted size, rotation, flips and opacity (see replaceIconObj); one undo step.
 */
export async function replaceDialog(objs = replaceable()) {
  if (!objs.length) return toast("Select an icon to replace");
  if (!info?.total) return toast("No icon library is loaded", true);
  const cur = state.doc.assets[objs[0].asset];
  const curName = cur?.meta?.name || objs[0].name || "";
  // shown: the search (source + words) the grid holds
  const rq = { q: curName, pack: "", offset: 0, total: 0, loading: false, seq: 0, shown: null };
  const grid = el("div.lib-grid.replace-grid", { tabindex: "0" });
  const status = el("div.lib-status");
  const input = el("input", { type: "search", value: rq.q, placeholder: "Search icons…", autocomplete: "off", spellcheck: "false" });
  let close = null, searching = null;
  const pick = (id) => id && close?.(id);
  const asked = () => rq.pack + "\n" + rq.q;
  // Enter takes the first result for the words in the box, so it waits for their search when it is still to come
  const submit = async () => {
    await research();
    if (rq.shown === asked()) pick(grid.querySelector(".tile")?.dataset.id);
  };
  const form = el("form.search", { onsubmit: (e) => { e.preventDefault(); submit(); } },
    el("span", { html: SEARCH_ICON, style: { display: "contents" } }), input);
  const packSel = el("select", { title: "Source" }, el("option", { value: "" }, "All sources"),
    ...info.packs.map((p) => el("option", { value: p.id }, `${p.name} (${p.count.toLocaleString()})`)));
  const page = async (reset) => {
    if (!reset && (rq.loading || rq.offset >= rq.total)) return;
    const my = ++rq.seq, key = asked();
    rq.loading = true;
    try {
      const res = await api("library.search", { q: rq.q, pack: rq.pack, offset: reset ? 0 : rq.offset, limit: 90 });
      if (my !== rq.seq) return;
      const tiles = res.items.map((it) => {
        const t = tile(it);
        t.draggable = false;
        if (cur && it.id === cur.meta.id) t.classList.add("current");
        return t;
      });
      if (reset) {
        grid.replaceChildren(...tiles);
        grid.scrollTop = 0;
        rq.offset = 0;
        rq.shown = key;
      } else grid.append(...tiles);
      rq.total = res.total;
      rq.offset += res.items.length;
      status.textContent = rq.total ? `${rq.total.toLocaleString()} icons${rq.q ? ` for “${rq.q}”` : ""} — click one to use it` : `Nothing found for “${rq.q}”. Try a broader word.`;
    } catch (e) {
      status.textContent = "Search failed: " + e.message;
    } finally {
      if (my === rq.seq) rq.loading = false;
    }
  };
  /** Search for the words in the box (once: typing and Enter share it); resolves when it is shown. */
  const research = () => {
    const v = input.value.trim();
    if (v !== rq.q || !searching) {
      rq.q = v;
      searching = page(true);
    }
    return searching;
  };
  input.addEventListener("input", debounce(research, 140));
  packSel.addEventListener("change", () => {
    rq.pack = packSel.value;
    searching = page(true);
  });
  grid.addEventListener("scroll", () => grid.scrollTop + grid.clientHeight > grid.scrollHeight - 300 && page(false));
  grid.addEventListener("click", (e) => pick(e.target.closest(".tile")?.dataset.id));
  const body = el("div.replace-body", {},
    el("div.row", {}, form, packSel), status, grid,
    el("div.small.muted", {}, "Keeps the position, size, rotation, flips and opacity. Part colours carry over when both icons have the same number of parts; otherwise an overall tint does."));
  searching = page(true);
  setTimeout(() => input.select(), 30);
  const title = objs.length > 1 ? `Replace ${objs.length} icons` : `Replace “${curName}”`;
  const id = await modal(title, body, [{ label: "Cancel", value: false }], { cls: "wide", bind: (c) => (close = c) });
  if (id) await replaceIcons(id, objs);
}

export const isFav = (id) => favs.has(id);
export async function toggleFavorite(id) {
  await toggleFav(id);
  return favs.has(id);
}

async function removeUser(id) {
  const name = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`)?._item?.name || "this icon";
  const ok = await modal("Remove from My library", el("div.meta-line", {}, `Delete “${name}” from My library? Figures that already use it keep their copy.`),
    [{ label: "Cancel", value: false }, { label: "Remove", primary: true, value: true }]);
  if (!ok) return;
  try {
    await api("library.remove", { id });
  } catch (e) {
    return toast(e.message, true);
  }
  info = await api("library.info");
  applyInfo();
  search();
  loadMine();
}

export async function importIcons() {
  try {
    const r = await api("library.import", {});
    if (r.cancelled) return;
    afterImport(r);
  } catch (e) {
    toast("Import failed: " + e.message, true);
  }
}

export const libraryInfo = () => info;
