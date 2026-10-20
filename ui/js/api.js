// Bridge to the Rust backend: Tauri `invoke` on desktop, HTTP when served by `biocraft --serve`.

const tauri = window.__TAURI__;
export const isDesktop = !!(tauri && tauri.core);

/**
 * A browser page opened with `?sandbox` (for testing) starts with an empty figure and never writes
 * the autosave that every window shares, the recent icons or the favourites.
 */
export const sandbox = !isDesktop && /[?&]sandbox(=|&|$)/.test(globalThis.location?.search || "");
const SANDBOXED = { "doc.autosave": {}, "library.recent": {}, "library.favorite": { favorite: false } };

export async function api(cmd, args = {}) {
  if (isDesktop) {
    return tauri.core.invoke("api", { cmd, args });
  }
  if (sandbox && Object.hasOwn(SANDBOXED, cmd)) return { ...SANDBOXED[cmd] };
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || "request failed");
  return body.result;
}

/** URL of a file inside the library folder (thumbnails, SVGs). */
export function libUrl(rel) {
  if (isDesktop) return tauri.core.convertFileSrc(rel, "lib");
  return "/lib/" + rel.split("/").map(encodeURIComponent).join("/");
}

/** In the browser build, hand exported bytes to the user as a download. */
export function downloadResult(res) {
  if (!res || !res.base64) return;
  const bin = atob(res.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = res.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
