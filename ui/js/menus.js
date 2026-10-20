// Dropdown menus (with nested submenus), context menus, popovers and modal dialogs.

import { $, el, bus, clamp } from "./util.js";

let openEl = null, openBtn = null;
// open menu panels, root first: {el, rows: [{row, it}], active, depth, timer, child, parent, parentIdx}
let levels = [];
let pop = null; // the open popover: {el, anchor, close}
let ownerAt = null; // where the open menu's button was when the menu opened (its rect)

const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const HOVER_MS = 140; // delay before hovering opens or switches a submenu

export function closeMenus() {
  for (const l of levels) {
    clearTimeout(l.timer);
    l.el.remove();
  }
  levels = [];
  document.removeEventListener("keydown", menuKey, true);
  pop?.close(); // runs its onClose
  openEl?.remove();
  openEl = null;
  openBtn?.classList.remove("open");
  openBtn = null;
  ownerAt = null;
}

export const menuOpen = () => levels.length > 0;

/**
 * items: [{label, kbd?, run?, disabled?, current?, checked?, img?, title?, submenu?: items | () => items} | "-" | {heading}]
 * (`current` marks the item that is already in use, e.g. the icon's own variant; `checked` true or
 * false makes it a checkable item, and every item of that menu gets the column for the tick).
 * Submenus open on hover or click and with the arrow keys, flip to the left when there is no
 * room on the right, and close together with their menu.
 */
export function openMenu(items, x, y, owner = null) {
  closeMenus();
  const lv = buildLevel(items, 0);
  const r = lv.el.getBoundingClientRect();
  lv.el.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + "px";
  lv.el.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + "px";
  openEl = lv.el;
  if (owner) {
    openBtn = owner;
    owner.classList.add("open");
    ownerAt = owner.getBoundingClientRect();
  }
  document.addEventListener("keydown", menuKey, true);
  return lv.el;
}

function buildLevel(items, depth) {
  const m = el("div.dropdown" + (depth ? ".submenu" : ""), { role: "menu" });
  const lv = { el: m, rows: [], active: -1, depth, timer: 0, child: null, parent: null, parentIdx: -1 };
  const checks = items.some((it) => it && typeof it === "object" && typeof it.checked === "boolean");
  for (const it of items) {
    if (!it) continue;
    if (it === "-") m.append(el("div.divider"));
    else if (it.heading) m.append(el("div.label", {}, it.heading));
    else {
      const idx = lv.rows.length;
      const checkable = typeof it.checked === "boolean";
      const row = el("div.item" + (it.disabled ? ".disabled" : "") + (it.current ? ".current" : "") + (it.submenu ? ".has-sub" : ""), {
        role: checkable ? "menuitemcheckbox" : "menuitem",
        "aria-checked": checkable ? String(it.checked) : null,
        "aria-disabled": it.disabled ? "true" : null,
        "aria-haspopup": it.submenu ? "menu" : null,
        title: it.title || null,
      },
        checks ? el("span.mi-check", { "aria-hidden": "true" }, it.checked ? "✓" : "") : null,
        it.img ? el("img.mi-img", { src: it.img, alt: "", draggable: "false" }) : null,
        el("span.mi-label", {}, it.label),
        it.kbd ? el("kbd", {}, it.kbd) : null,
        it.submenu ? el("span.chev", { html: CHEVRON }) : null);
      row.addEventListener("pointerenter", () => hover(lv, idx));
      row.addEventListener("click", () => activate(lv, idx, false));
      lv.rows.push({ row, it });
      m.append(row);
    }
  }
  m.addEventListener("contextmenu", (e) => e.preventDefault());
  m.addEventListener("pointerleave", () => {
    clearTimeout(lv.timer);
    setActive(lv, lv.child ? lv.child.parentIdx : -1);
  });
  levels.push(lv);
  document.body.append(m);
  return lv;
}

function setActive(lv, idx) {
  lv.active = idx;
  lv.rows.forEach(({ row }, i) => row.classList.toggle("active", i === idx));
}

/** Close every submenu at `depth` or deeper. */
function closeFrom(depth) {
  while (levels.length > depth) {
    const l = levels.pop();
    clearTimeout(l.timer);
    l.el.remove();
    if (l.parent) {
      l.parent.child = null;
      l.parent.rows[l.parentIdx]?.row.classList.remove("sub-open");
    }
  }
}

function hover(lv, idx) {
  setActive(lv, idx);
  clearTimeout(lv.timer);
  const { it } = lv.rows[idx];
  if (lv.child?.parentIdx === idx) return;
  if (!lv.child && !(it.submenu && !it.disabled)) return;
  lv.timer = setTimeout(() => {
    closeFrom(lv.depth + 1);
    if (it.submenu && !it.disabled) openSub(lv, idx, false);
  }, HOVER_MS);
}

function openSub(lv, idx, viaKey) {
  closeFrom(lv.depth + 1);
  const { row, it } = lv.rows[idx];
  const items = typeof it.submenu === "function" ? it.submenu() : it.submenu;
  const sub = buildLevel(items || [], lv.depth + 1);
  Object.assign(sub, { parent: lv, parentIdx: idx });
  lv.child = sub;
  row.classList.add("sub-open");
  const r = row.getBoundingClientRect(), pr = lv.el.getBoundingClientRect(), s = sub.el.getBoundingClientRect();
  let x = pr.right - 3;
  if (x + s.width > innerWidth - 6) x = Math.max(6, pr.left - s.width + 3);
  const y = Math.max(6, Math.min(r.top - 6, innerHeight - s.height - 6));
  sub.el.style.left = x + "px";
  sub.el.style.top = y + "px";
  sub.el.addEventListener("pointerenter", () => {
    clearTimeout(lv.timer);
    setActive(lv, idx);
  });
  if (viaKey) setActive(sub, step(sub, -1, 1));
}

function activate(lv, idx, viaKey) {
  const { it } = lv.rows[idx];
  if (it.disabled) return;
  if (it.submenu) {
    clearTimeout(lv.timer);
    if (lv.child?.parentIdx !== idx) openSub(lv, idx, viaKey);
    else if (viaKey) setActive(lv.child, step(lv.child, -1, 1));
    return;
  }
  closeMenus();
  it.run?.();
}

/** Next enabled row from `from` in direction `dir` (wrapping), or -1. */
function step(lv, from, dir) {
  const n = lv.rows.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (!lv.rows[i].it.disabled) return i;
  }
  return -1;
}

function menuKey(e) {
  if (!levels.length) return;
  // keys act on the deepest menu with a highlighted item
  let cur = levels[0];
  for (const l of levels) if (l.active >= 0) cur = l;
  const k = e.key;
  const it = cur.active >= 0 ? cur.rows[cur.active].it : null;
  if (k === "Escape") {
    // the innermost submenu first, then the menu
    const last = levels[levels.length - 1];
    if (last.depth > 0) {
      const p = last.parent, i = last.parentIdx;
      closeFrom(last.depth);
      setActive(p, i);
    } else closeMenus();
  } else if (k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End") {
    const down = k === "ArrowDown" || k === "Home";
    const from = k === "Home" ? -1 : k === "End" ? 0 : cur.active < 0 && k === "ArrowUp" ? 0 : cur.active;
    setActive(cur, step(cur, from, down ? 1 : -1));
    // a submenu opened by hovering closes when the highlight leaves its row
    if (cur.child && cur.child.parentIdx !== cur.active) closeFrom(cur.depth + 1);
  } else if (k === "ArrowRight") {
    if (it?.submenu && !it.disabled) activate(cur, cur.active, true);
  } else if (k === "ArrowLeft") {
    if (cur.depth > 0) {
      const p = cur.parent, i = cur.parentIdx;
      closeFrom(cur.depth);
      setActive(p, i);
    }
  } else if (k === "Enter" || k === " ") {
    if (it) activate(cur, cur.active, true);
  } else if (k === "Tab") {
    closeMenus();
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

/**
 * A floating panel anchored under/next to `anchor`; closes on outside click, Escape or when
 * another menu opens (onClose runs every time). Clicks on the anchor leave it open, so the
 * anchor's own handler can toggle it with popoverOpen().
 */
export function popover(anchor, content, { onClose } = {}) {
  closeMenus();
  const p = el("div.dropdown", {}, content);
  p.style.padding = "0";
  document.body.append(p);
  const a = anchor.getBoundingClientRect();
  const r = p.getBoundingClientRect();
  let x = a.left, y = a.bottom + 6;
  if (x + r.width > innerWidth - 8) x = innerWidth - r.width - 8;
  if (y + r.height > innerHeight - 8) y = Math.max(8, a.top - r.height - 6);
  p.style.left = Math.max(8, x) + "px";
  p.style.top = y + "px";
  openEl = p;
  const off = (e) => {
    if (!p.contains(e.target) && !anchor.contains(e.target)) close();
  };
  // Escape closes the popover only (not also the selection, as the canvas's Escape would)
  const esc = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    p.remove();
    if (openEl === p) openEl = null;
    if (pop?.el === p) pop = null;
    document.removeEventListener("pointerdown", off, true);
    document.removeEventListener("keydown", esc, true);
    onClose?.();
  };
  setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", off, true);
    document.addEventListener("keydown", esc, true);
  });
  pop = { el: p, anchor, close, at: a };
  return pop;
}

/** The open popover anchored to `anchor`, if any. */
export const popoverOpen = (anchor) => (pop && pop.anchor === anchor ? pop : null);

/**
 * After the layout changes (a side panel resized or collapsed, the window resized): the open menu and
 * popover move with the button they hang from, or close when it is hidden (in a collapsed panel). One
 * whose button was rebuilt meanwhile stays where it is; a context menu stays at its click.
 */
function followAnchors() {
  const follow = (anchor, at, els, close) => {
    if (!anchor?.isConnected || !at) return at;
    const r = anchor.getBoundingClientRect();
    if (!r.width && !r.height) {
      close();
      return null;
    }
    const dx = r.left - at.left, dy = r.top - at.top;
    if (dx || dy) {
      for (const e of els) {
        const b = e.getBoundingClientRect();
        e.style.left = clamp(b.left + dx, 6, Math.max(6, innerWidth - b.width - 6)) + "px";
        e.style.top = clamp(b.top + dy, 6, Math.max(6, innerHeight - b.height - 6)) + "px";
      }
    }
    return r;
  };
  if (levels.length && openBtn) ownerAt = follow(openBtn, ownerAt, levels.map((l) => l.el), closeMenus);
  const p = pop;
  if (p) p.at = follow(p.anchor, p.at, [p.el], p.close);
}
bus.on("layout", followAnchors);

/**
 * Modal dialog; resolves with the value passed to close().
 * opts.cls adds classes to the dialog box ("wide"); opts.bind(close) lets the body close it;
 * opts.enter: Enter in one of its fields chooses the primary button.
 */
export function modal(title, body, actions, { cls = "", bind = null, enter = false } = {}) {
  return new Promise((resolve) => {
    const back = el("div.modal-back");
    const close = (v) => {
      back.remove();
      document.removeEventListener("keydown", key, true);
      resolve(v);
    };
    const primary = actions.find((a) => a.primary);
    const key = (e) => {
      if (e.key === "Escape") close(null);
      else if (enter && primary && e.key === "Enter" && e.target?.tagName === "INPUT" && back.contains(e.target)) {
        e.preventDefault();
        close(primary.value ?? primary.label);
      }
      e.stopPropagation();
    };
    const box = el("div.modal" + (cls ? "." + cls.split(/\s+/).join(".") : ""), { role: "dialog", "aria-label": title }, el("h2", {}, title), body,
      el("div.actions", {}, ...actions.map((a) => el("button" + (a.primary ? ".primary" : ".btn"), { onclick: () => close(a.value ?? a.label) }, a.label))));
    back.append(box);
    back.addEventListener("pointerdown", (e) => e.target === back && close(null));
    document.body.append(back);
    document.addEventListener("keydown", key, true);
    bind?.(close);
    box.querySelector("input,select,button.primary")?.focus();
  });
}

/** Ask for a line of text, such as a name: the text, or null when cancelled. */
export async function askText(title, label, value, ok) {
  const inp = el("input.num", { value, "aria-label": label });
  const body = el("div.field.wide", {}, el("label", {}, label), inp);
  setTimeout(() => inp.select(), 0);
  const r = await modal(title, body, [{ label: "Cancel", value: false }, { label: ok, primary: true, value: true }], { enter: true });
  return r ? inp.value.trim() : null;
}

document.addEventListener("pointerdown", (e) => {
  if (levels.length) {
    if (!levels.some((l) => l.el.contains(e.target)) && !openBtn?.contains(e.target)) closeMenus();
    return;
  }
  if (pop?.anchor.contains(e.target)) return;
  if (openEl && !openEl.contains(e.target) && !openBtn?.contains(e.target) && openEl.classList.contains("dropdown") && !openEl.querySelector(".colorpop")) closeMenus();
});
window.addEventListener("blur", () => closeMenus());
export const menuRoot = () => $("#popover-root");
