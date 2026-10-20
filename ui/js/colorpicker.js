// Colour popover: palette, colour-blind-safe set, OKLCH-based sliders, hex input.

import { PALETTE, SAFE, normHex, parseHex, toLch, fromLch, toHex } from "./color.js";
import { popover } from "./menus.js";
import { el } from "./util.js";

const recent = [];

/**
 * Open a colour picker under `anchor`.
 * onChange(hex|null, final) fires live while dragging (final=false) and once on commit.
 */
export function pickColor(anchor, initial, onChange, { allowNone = false, resetLabel = null, onReset = null } = {}) {
  let cur = normHex(initial) || "#4aa9d0";
  let [L, C, H] = toLch(parseHex(cur));
  const hexIn = el("input.num", { value: cur, spellcheck: "false", style: { width: "92px" } });
  const preview = el("div.swatch", { style: { background: cur, width: "34px", height: "28px" } });
  const mk = (min, max, step, val) => el("input", { type: "range", min, max, step, value: val });
  const sL = mk(0, 1, 0.005, L), sC = mk(0, 0.33, 0.002, C), sH = mk(0, 360, 1, H);
  const vL = el("span.small"), vC = el("span.small"), vH = el("span.small");

  const paintTracks = () => {
    const stops = (f) => Array.from({ length: 13 }, (_, i) => toHex(f(i / 12))).join(",");
    sL.style.background = `linear-gradient(90deg,${stops((t) => fromLch(t, C, H))})`;
    sC.style.background = `linear-gradient(90deg,${stops((t) => fromLch(L, t * 0.33, H))})`;
    sH.style.background = `linear-gradient(90deg,${stops((t) => fromLch(L, Math.max(C, 0.08), t * 360))})`;
    vL.textContent = Math.round(L * 100);
    vC.textContent = Math.round(C * 100);
    vH.textContent = Math.round(H);
  };
  const set = (hex, final = false, fromSliders = false) => {
    cur = hex;
    if (!fromSliders && hex) [L, C, H] = toLch(parseHex(hex));
    if (!fromSliders && hex) {
      sL.value = L;
      sC.value = C;
      sH.value = H;
    }
    preview.style.background = hex || "transparent";
    preview.classList.toggle("none", !hex);
    hexIn.value = hex || "none";
    paintTracks();
    onChange(hex, final);
    if (final && hex && !recent.includes(hex)) {
      recent.unshift(hex);
      recent.length = Math.min(recent.length, 10);
    }
  };
  const fromSl = (final) => {
    [L, C, H] = [+sL.value, +sC.value, +sH.value];
    set(toHex(fromLch(L, C, H)), final, true);
  };
  for (const s of [sL, sC, sH]) {
    s.addEventListener("input", () => fromSl(false));
    s.addEventListener("change", () => fromSl(true));
  }
  hexIn.addEventListener("change", () => {
    const h = normHex(hexIn.value);
    if (h) set(h, true);
    else if (allowNone && /none|transparent/i.test(hexIn.value)) set(null, true);
  });
  const sw = (hex) => el("button", { title: hex, style: { background: hex }, onclick: () => set(hex, true) });
  const body = el("div.colorpop", {},
    el("div.palette", {}, ...PALETTE.map(sw)),
    el("div.small.muted", {}, "Colour-blind safe (Okabe–Ito)"),
    el("div.palette", {}, ...SAFE.map(sw)),
    recent.length ? el("div.small.muted", {}, "Recent") : null,
    recent.length ? el("div.palette", {}, ...recent.map(sw)) : null,
    el("div.hsl", {},
      el("label", {}, "L", sL, vL),
      el("label", {}, "C", sC, vC),
      el("label", {}, "H", sH, vH)),
    el("div.row", {}, preview, hexIn,
      allowNone ? el("button.btn", { onclick: () => set(null, true), title: "No colour" }, "None") : null,
      onReset ? el("button.btn", { onclick: () => { onReset(); pop.close(); } }, resetLabel || "Reset") : null),
  );
  paintTracks();
  const pop = popover(anchor, body);
  return pop;
}
