// Right-click menu for the canvas (also behind the quick toolbar's ⋯ button), laid out like
// BioRender's: clipboard, Flip/Arrange/Align submenus, grouping and selection, Replace and
// favourites for icons, and Lock. Items that don't apply are disabled rather than hidden.

import { libUrl } from "./api.js";
import { state, selectedObjs } from "./model.js";
import {
  cutSel, copySel, pasteClip, hasClip, duplicateSel, deleteSel, flipSel, arrange, align, distribute,
  groupSel, ungroupSel, selectAll, selectSame, selectKind, kindIds, invertSelection, SELECT_KINDS,
  toggleLock, replaceable, replaceIcons,
} from "./actions.js";
import { isFav, toggleFavorite, saveSelectionToLibrary, replaceDialog } from "./library.js";
import { openMenu } from "./menus.js";
import { bus, toast, MOD } from "./util.js";

const unlocked = () => selectedObjs().filter((o) => !o.locked);

export const flipItems = () => {
  const off = !unlocked().length;
  return [
    { label: "Horizontal", kbd: "Shift+H", run: () => flipSel("h"), disabled: off },
    { label: "Vertical", kbd: "Shift+V", run: () => flipSel("v"), disabled: off },
  ];
};

export const arrangeItems = () => {
  const off = !state.selection.length;
  return [
    { label: "Bring to front", kbd: MOD + "Shift+]", run: () => arrange("front"), disabled: off },
    { label: "Bring forward", kbd: MOD + "]", run: () => arrange("forward"), disabled: off },
    { label: "Send backward", kbd: MOD + "[", run: () => arrange("backward"), disabled: off },
    { label: "Send to back", kbd: MOD + "Shift+[", run: () => arrange("back"), disabled: off },
  ];
};

export const alignItems = () => {
  const n = unlocked().length;
  const page = n === 1 ? " (to the page)" : "";
  const a = (label, how) => ({ label, title: label + page, run: () => align(how), disabled: !n });
  return [
    a("Left", "left"), a("Centre", "hcenter"), a("Right", "right"),
    "-",
    a("Top", "top"), a("Middle", "vcenter"), a("Bottom", "bottom"),
    "-",
    { label: "Distribute horizontally", run: () => distribute("h"), disabled: n < 3, title: "Needs three or more objects" },
    { label: "Distribute vertically", run: () => distribute("v"), disabled: n < 3, title: "Needs three or more objects" },
  ];
};

/** Select… submenu: every kind, disabled when the figure has none. */
export const selectItems = () => [
  ...SELECT_KINDS.map(([k, label]) => ({ label, run: () => selectKind(k), disabled: !kindIds(k).length })),
  "-",
  { label: "Invert selection", run: invertSelection, disabled: !state.doc.objects.some((o) => !o.hidden && !o.locked) },
];

/** The library icon shared by every selected icon, or null. */
function sharedAsset(objs) {
  const ids = new Set(objs.map((o) => o.asset));
  return ids.size === 1 ? state.doc.assets[[...ids][0]] || null : null;
}

/** Replace submenu: the search dialog, then the icon's colour/style variants with thumbnails. */
export function replaceItems() {
  const objs = replaceable();
  const asset = sharedAsset(objs);
  const items = [{ label: "Replace with another icon…", run: () => replaceDialog(objs) }];
  const vars = asset?.meta?.variants || [];
  if (!asset) return items;
  items.push("-", { heading: "Variants" });
  if (!vars.length) return [...items, { label: "No variants for this icon", disabled: true }];
  const m = asset.meta;
  items.push({ label: m.name, img: m.thumb ? libUrl(m.thumb) : null, kbd: "✓", disabled: true, current: true, title: "The icon in your figure" });
  for (const v of vars) items.push({ label: v.name, img: v.thumb ? libUrl(v.thumb) : null, run: () => replaceIcons(v.id, objs, { colors: false }) });
  return items;
}

/** The full right-click menu. `at` (document px) is where Paste puts the copied objects. */
export function contextItems(at = null) {
  const sel = selectedObjs();
  const free = sel.filter((o) => !o.locked);
  const icons = replaceable(sel);
  const allIcons = icons.length > 0 && icons.length === sel.length;
  const fav = allIcons ? sharedAsset(icons) : null;
  const favOk = !!fav && fav.meta?.pack !== "file";
  const favOn = favOk && isFav(fav.meta.id);
  const allLocked = sel.length > 0 && sel.every((o) => o.locked);
  return [
    { label: "Cut", kbd: MOD + "X", run: cutSel, disabled: !free.length },
    { label: "Copy", kbd: MOD + "C", run: copySel, disabled: !sel.length },
    { label: "Duplicate", kbd: MOD + "D, Alt+Drag", run: duplicateSel, disabled: !sel.length },
    { label: "Paste", kbd: MOD + "V", run: () => pasteClip(10, at), disabled: !hasClip() },
    { label: "Delete", kbd: "Delete, Backspace", run: deleteSel, disabled: !free.length },
    "-",
    { label: "Flip", submenu: flipItems, disabled: !free.length },
    { label: "Arrange", submenu: arrangeItems, disabled: !sel.length },
    { label: "Align", submenu: alignItems, disabled: !free.length },
    "-",
    { label: "Group", kbd: MOD + "G", run: groupSel, disabled: sel.length < 2 },
    { label: "Ungroup", kbd: MOD + "Shift+G", run: ungroupSel, disabled: !sel.some((o) => o.type === "group") },
    { label: "Select All", kbd: MOD + "A", run: selectAll, disabled: !state.doc.objects.some((o) => !o.hidden && !o.locked) },
    { label: "Select All Same Icons", run: selectSame, disabled: !sel.length, title: "Same library icon; other objects of the same type and style" },
    { label: "Select…", submenu: selectItems },
    "-",
    { label: "Replace", submenu: replaceItems, disabled: !allIcons },
    {
      label: favOn ? "Remove From Favourites" : "Add To Favourites", disabled: !favOk,
      run: async () => {
        const on = await toggleFavorite(fav.meta.id);
        toast(on ? `Added “${fav.meta.name}” to Favourites` : `Removed “${fav.meta.name}” from Favourites`);
      },
    },
    { label: "Save to My library", run: saveSelectionToLibrary, disabled: !sel.length },
    "-",
    { label: allLocked ? "Unlock" : "Lock", kbd: MOD + "L", run: toggleLock, disabled: !sel.length },
  ];
}

export function openContextMenu(x, y, at = null, owner = null) {
  return openMenu(contextItems(at), x, y, owner);
}

export function initContextMenu() {
  bus.on("context-menu", ({ x, y, at }) => openContextMenu(x, y, at));
}
