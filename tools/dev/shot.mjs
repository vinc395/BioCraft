// Screenshots of the running app (`biocraft --serve 8791`) in headless Chrome or Edge, driven over the
// DevTools protocol, for checking UI changes by eye when the in-app browser pane is hidden.
//
//   node tools/dev/shot.mjs <page-script.js> [--out dir] [--theme light|dark] [--size 1500x1000] [--base url] [--init file.js]
//
// --init: a script run in the page before the app starts (after the stubs below), e.g. to answer
// app.launchFile or doc.autoload with test data. Use --base http://localhost:8791/?sandbox for a page
// that starts empty.
//
// The page script runs in the app once it has started, as the body of an async function with
//   M (model.js), C (canvas.js), A (actions.js), P (panels.js), U (util.js)  — the app's modules
//   shot(name, selector?)  — save <out>/<name>.png of the element (or the whole page)
//   sleep(ms), frame()  — wait; frame() waits for two animation frames
//   viewport(w, h)  — resize the window (as a user would; the page gets its resize events)
//   mouse(type, x, y, {button, clickCount, modifiers})  — real mouse input at page coordinates
//     (type: "mousePressed", "mouseReleased" or "mouseMoved"; real double-clicks and pointer capture)
//   typeText(text)  — real typing into the focused field (it then fires change when it loses focus)
// Calls that would change the user's data (autosave, recent icons, favourites) are answered locally,
// and the browser runs with a throwaway profile.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const script = argv.find((a, i) => !a.startsWith("--") && !(argv[i - 1] || "").startsWith("--"));
if (!script) {
  console.log("usage: node tools/dev/shot.mjs <page-script.js> [--out dir] [--theme light|dark] [--size WxH]");
  process.exit(2);
}
const OUT = resolve(opt("--out", join(HERE, "out")));
const BASE = opt("--base", "http://localhost:8791");
const THEME = opt("--theme", "light");
const INIT = opt("--init", null);
const [W, H] = opt("--size", "1500x1000").split("x").map(Number);
const PORT = 9300 + Math.floor(Math.random() * 500);

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
];
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) throw new Error("no Chrome or Edge found");

const profile = mkdtempSync(join(tmpdir(), "biocraft-shot-"));
const proc = spawn(exe, [`--headless=new`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error("browser did not start");
}

const ws = new WebSocket(await target());
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let seq = 0;
const pending = new Map(), handlers = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  } else if (m.method) handlers.forEach((h) => h(m));
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

const QUIET = `(() => {
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => /\\/api\\/(doc\\.autosave|library\\.(recent|favorite))$/.test(String(u))
    ? Promise.resolve(new Response(JSON.stringify({ ok: true, result: { favorite: false } })))
    : real(u, o);
  try { localStorage.setItem("biocraft.theme", ${JSON.stringify(THEME)}); } catch {}
})();`;

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: QUIET });
  if (INIT) await send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(resolve(INIT), "utf8") });
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: THEME }] });
  await send("Runtime.addBinding", { name: "__shotReq" });
  mkdirSync(OUT, { recursive: true });
  handlers.push(async (m) => {
    if (m.method !== "Runtime.bindingCalled" || m.params.name !== "__shotReq") return;
    const req = JSON.parse(m.params.payload);
    if (req.op === "viewport") {
      await send("Emulation.setDeviceMetricsOverride", { width: req.w, height: req.h, deviceScaleFactor: 1, mobile: false });
    } else if (req.op === "mouse") {
      const buttons = req.type === "mouseReleased" || req.button === "none" ? 0 : { left: 1, right: 2, middle: 4 }[req.button || "left"];
      await send("Input.dispatchMouseEvent", { type: req.type, x: req.x, y: req.y, button: req.button || "left", buttons, clickCount: req.clickCount ?? (req.type === "mouseMoved" ? 0 : 1), modifiers: req.modifiers || 0 });
    } else if (req.op === "type") {
      await send("Input.insertText", { text: req.text });
    } else {
      const { name, clip } = req;
      const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      const file = join(OUT, name + ".png");
      writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log("  wrote " + file);
    }
    await send("Runtime.evaluate", { expression: `window.__shotDone(${JSON.stringify(req.key)})` });
  });
  const loaded = new Promise((r) => handlers.push((m) => m.method === "Page.loadEventFired" && r()));
  await send("Page.navigate", { url: BASE });
  await loaded;
  await sleep(1200); // start-up: session restore, library search
  const body = readFileSync(resolve(script), "utf8");
  const run = `(async () => {
    const waits = {};
    window.__shotDone = (k) => { waits[k]?.(); delete waits[k]; };
    let n = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const shot = async (name, sel) => {
      await frame();
      let clip = null;
      if (sel) {
        const e = typeof sel === "string" ? document.querySelector(sel) : sel;
        if (!e) throw new Error("no element " + sel);
        const b = e.getBoundingClientRect();
        clip = { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.max(1, b.width), height: Math.max(1, b.height) };
      }
      const key = "k" + n++;
      await new Promise((r) => { waits[key] = r; __shotReq(JSON.stringify({ name, clip, key })); });
    };
    const __ask = (req) => {
      const key = "k" + n++;
      return new Promise((r) => { waits[key] = r; __shotReq(JSON.stringify({ ...req, key })); });
    };
    const viewport = async (w, h) => {
      await __ask({ op: "viewport", w, h });
      await sleep(80);
      await frame();
    };
    const mouse = (type, x, y, o = {}) => __ask({ op: "mouse", type, x, y, ...o });
    const typeText = (text) => __ask({ op: "type", text });
    const [M, C, A, P, U] = await Promise.all(["model", "canvas", "actions", "panels", "util"].map((m) => import("/js/" + m + ".js")));
    ${body}
  })()`;
  const r = await send("Runtime.evaluate", { expression: run, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  if (r.result?.value !== undefined) console.log(JSON.stringify(r.result.value, null, 1));
} finally {
  try {
    await send("Browser.close");
  } catch {}
  ws.close();
  proc.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
