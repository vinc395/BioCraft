// Copy as a picture. Along with the copied objects (actions.js copySel), the selection goes onto the
// system clipboard as a transparent PNG at 300 dpi. It pastes into PowerPoint, Word, Teams and other
// programs at the size it has in BioCraft. The Windows desktop app writes the clipboard itself, in
// the formats Office reads best (app/src/clipboard.rs); elsewhere the page copies the PNG through the
// Clipboard API. Pasting back into BioCraft pastes the objects, not a picture of them (isOurPicture,
// main.js).

import { api, isDesktop, sandbox } from "./api.js";
import { state, MM } from "./model.js";
import { documentSvg, visualBox } from "./render.js";

const DPI = 300;
const WINDOWS = /Windows/i.test(globalThis.navigator?.userAgent || "");
let last = null; // {width, height} of the picture copied last

/** The objects as an SVG cropped round them (a hair of margin keeps strokes whole), on no background. */
export function pictureSvg(objs) {
  const b = visualBox(objs), m = 0.5 * MM;
  return documentSvg(state.doc, { objects: objs, crop: { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m }, background: null });
}

/**
 * Put the objects on the system clipboard as a picture. Call it from the key press or click that
 * copies: the page's Clipboard API only works then. A ?sandbox test page leaves the clipboard alone.
 */
export function copyPicture(objs) {
  if (sandbox || !objs.length) return;
  let svg;
  try {
    svg = pictureSvg(objs);
  } catch {
    return;
  }
  last = null;
  if (isDesktop && WINDOWS) {
    api("clipboard.picture", { svg, dpi: DPI }).then((r) => (last = r)).catch(() => {});
    return;
  }
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return;
  // (the PNG is made after the copy starts: the item takes a promise of it)
  const png = api("clipboard.picture", { svg, dpi: DPI }).then((r) => {
    last = r;
    return new Blob([Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))], { type: "image/png" });
  });
  navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).catch(() => {});
}

/** Whether pasted `files` are the picture BioCraft copied last, so the copied objects are pasted instead. */
export async function isOurPicture(files) {
  if (!last) return false;
  if (isDesktop && WINDOWS) return (await api("clipboard.isOurs", {}).catch(() => ({}))).ours === true;
  if (files.length !== 1 || !/^image\//.test(files[0].type)) return false;
  const bmp = await createImageBitmap(files[0]).catch(() => null);
  return !!bmp && bmp.width === last.width && bmp.height === last.height;
}
