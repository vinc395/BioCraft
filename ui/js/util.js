// Small DOM and maths helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el("div.cls#id", {attrs}, children...) */
export function el(spec, attrs = {}, ...children) {
  const m = spec.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement(m[1] || "div");
  for (const part of (m[2] || "").match(/[.#][\w-]+/g) || []) {
    if (part[0] === ".") node.classList.add(part.slice(1));
    else node.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "html") node.innerHTML = v;
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Shortcut prefix shown in menus: "⌘" on macOS, "Ctrl+" elsewhere. */
export const MOD = String(globalThis.navigator?.platform || "").toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

let seq = 0;
export const uid = (p = "o") => p + Date.now().toString(36).slice(-5) + (seq++).toString(36);

/** Tiny event bus */
const listeners = {};
export const bus = {
  on(ev, fn) {
    (listeners[ev] ||= []).push(fn);
  },
  off(ev, fn) {
    listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
  },
  emit(ev, data) {
    for (const fn of listeners[ev] || []) fn(data);
  },
};

let toastTimer;
export function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isError ? 5000 : 2400);
}

/** Rotate point (x,y) about (cx,cy) by deg. */
export function rotPt(x, y, cx, cy, deg) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export const fmtNum = (v) => {
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return (s.includes(".") ? s.replace(/\.?0+$/, "") : s) || "0";
};
