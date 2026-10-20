// Pages for naming the Servier kit drawings whose names say little about them: drawings named after
// their slide (no text label beside them, no match on the Servier website: "Hematopoiesis" ×23)
// and website titles shared by many different drawings ("Channel" ×112). Slides are rebuilt from
// their drawings and text boxes; each page shows a slide with the drawings to name outlined and
// numbered, next to those drawings enlarged. Slides are grouped into batches of about 120
// drawings (one naming task each). The names chosen go in sources/overrides/names.json, which the
// library builder applies (ids stay the same, so figures keep working).
//
//   node tools/servier-names.mjs [--out dir] [--kits Genetics,Blood-immunology] [--batch 120]
//                                [--base http://127.0.0.1:8791]    (renders PNGs through the running app)
//
// Reads sources/servier-kits (the PowerPoint kits and manifest) and library/index.json; writes only
// into --out (default tools/dev/out/servier-names): batches.json and batches/<id>-p<n>.png.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = path.resolve(opt("--out", path.join(ROOT, "tools/dev/out/servier-names")));
const BASE = opt("--base", "http://127.0.0.1:8791");
const ONLY_KITS = (opt("--kits", "") || "").split(",").filter(Boolean).map((k) => k.toLowerCase());
const BATCH = +opt("--batch", 120);
const SHARED = 6; // a website title shared by this many drawings says little about each
const KITS = path.join(ROOT, "sources/servier-kits");
const EMU = 9525;

// --merge: gather the names chosen (names/<batch>-p<page>.json: slug → "keep" | {name, tags}) into
// sources/overrides/names.json, keeping entries made earlier for other icons
if (argv.includes("--merge")) {
  const target = path.join(ROOT, "sources/overrides/names.json");
  const prev = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
  const icons = { ...(prev.icons || {}) };
  const decided = new Map();
  const ndir = path.join(OUT, "names");
  for (const f of fs.existsSync(ndir) ? fs.readdirSync(ndir).filter((f) => f.endsWith(".json")) : []) {
    try {
      for (const [slug, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(ndir, f), "utf8")))) decided.set(slug, v);
    } catch (e) {
      console.log(`  ${f}: unreadable (${e.message})`);
    }
  }
  let renamed = 0, kept = 0, missing = 0;
  const lost = [];
  for (const f of fs.readdirSync(path.join(OUT, "batches")).filter((f) => /^b\d+\.json$/.test(f))) {
    const b = JSON.parse(fs.readFileSync(path.join(OUT, "batches", f), "utf8"));
    for (const s of b.slides) {
      for (const it of s.items) {
        const v = decided.get(it.slug);
        if (v === undefined) {
          missing++;
          lost.push(`${b.id} ${s.kit} s${s.slide} #${it.n}`);
          continue;
        }
        const name = typeof v === "object" && v ? String(v.name || "").trim().replace(/\.$/, "") : "";
        if (!name || name === it.name) {
          kept++;
          continue;
        }
        const tags = [...new Set((Array.isArray(v.tags) ? v.tags : []).map((t) => String(t).trim()).filter((t) => t && t.toLowerCase() !== name.toLowerCase()))].slice(0, 6);
        icons["servier/" + it.slug] = tags.length ? { name: name.slice(0, 90), tags } : { name: name.slice(0, 90) };
        renamed++;
      }
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    note: "Names for library icons whose own names say little about them (made with tools/servier-names.mjs). Applied by the library builder after every build; ids stay the same and the old name becomes a tag.",
    icons: Object.fromEntries(Object.entries(icons).sort(([a], [b]) => a.localeCompare(b))),
  }, null, 1) + "\n");
  console.log(`renamed ${renamed}, kept ${kept}, not named yet ${missing} → ${target} (${Object.keys(icons).length} entries)`);
  if (lost.length) console.log("  not named yet: " + lost.slice(0, 20).join("; ") + (lost.length > 20 ? " …" : ""));
  process.exit(0);
}

const P = await import(pathToFileURL(path.join(ROOT, "tools/pptx2svg.mjs")).href);

/* ---------- which drawings to name ---------- */

const manifest = JSON.parse(fs.readFileSync(path.join(KITS, "manifest.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, "library/index.json"), "utf8")).icons;
const byId = new Map(index.map((m) => [m.id, m]));
const visible = manifest.filter((x) => x.kit && byId.get("servier/" + x.slug) && !byId.get("servier/" + x.slug).hidden);
const perSlide = new Map(), perName = new Map();
for (const x of visible) {
  const k = x.kit + "#" + x.slide;
  perSlide.set(k, (perSlide.get(k) || 0) + 1);
  perName.set(x.name, (perName.get(x.name) || 0) + 1);
}
const isTarget = (x) => (!x.matched && (perSlide.get(x.kit + "#" + x.slide) >= 2 || perName.get(x.name) >= 2)) || (x.matched && perName.get(x.name) >= SHARED);
const kitName = (kit) => kit.replace(/^SMART-/, "").replace(/\.pptx$/, "");
const byKit = new Map();
for (const x of visible.filter(isTarget)) {
  if (ONLY_KITS.length && !ONLY_KITS.includes(kitName(x.kit).toLowerCase())) continue;
  (byKit.get(x.kit) || byKit.set(x.kit, []).get(x.kit)).push(x);
}

/* ---------- slide XML helpers ---------- */

const kid = (n, name) => (n?.c || []).find((c) => c.n === name);
const kids = (n, name) => (n?.c || []).filter((c) => c.n === name);
const path1 = (n, ...ps) => ps.reduce((a, p) => kid(a, p), n);
function textOf(n) {
  const parts = [];
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (x.n === "a:p") parts.push("\n");
    if (x.n === "a:t") parts.push(x.t ?? (x.c || []).map((c) => (typeof c === "string" ? c : c.t || "")).join(""));
    for (const c of x.c || []) walk(c);
  };
  walk(n);
  return parts.join("").split("\n").map((s) => s.trim()).filter(Boolean).join(" / ");
}
function boxOf(el) {
  const pr = kid(el, "p:spPr") || kid(el, "p:grpSpPr");
  const xf = kid(pr, "a:xfrm");
  const off = kid(xf, "a:off"), ext = kid(xf, "a:ext");
  if (!off || !ext) return null;
  return [+off.a.x / EMU, +off.a.y / EMU, (+off.a.x + +ext.a.cx) / EMU, (+off.a.y + +ext.a.cy) / EMU];
}
const union = (bs) => bs.filter(Boolean).reduce((a, b) => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b), null);
const edgeDist = (b, c) => Math.hypot(Math.max(b[0] - c[2], 0, c[0] - b[2]), Math.max(b[1] - c[3], 0, c[1] - b[3]));
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f1 = (v) => (+v).toFixed(1);

let uid = 0;
/** A drawing's SVG content with ids unique on the page. */
function inner(svg) {
  const pre = `u${++uid}-`;
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1] || "0 0 10 10";
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/\bid="([^"]+)"/g, `id="${pre}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${pre}$1)`).replace(/href="#([^"]+)"/g, `href="#${pre}$1"`);
  return { vb, body };
}

/* ---------- slides ---------- */

const slides = []; // {kit, kitDir, slide, slideTitle, W, H, labels, draws:[{svg,w,h,box}], items}
for (const [kit, xs] of byKit) {
  const buf = fs.readFileSync(path.join(KITS, "pptx", kit));
  const res = P.convertPptx(buf, { name: kit.replace(/\.pptx$/, ""), debug: true });
  const files = P.readZip(buf);
  const pres = P.parseXml(files.get("ppt/presentation.xml")().toString("utf8"));
  const sz = path1(pres, "p:presentation", "p:sldSz");
  const W = +(sz?.a.cx || 12192000) / EMU, H = +(sz?.a.cy || 6858000) / EMU;
  const relsXml = P.parseXml(files.get("ppt/_rels/presentation.xml.rels")().toString("utf8"));
  const rel = Object.fromEntries(kids(kid(relsXml, "Relationships") || relsXml, "Relationship").map((r) => [r.a.Id, "ppt/" + r.a.Target.replace(/^\/?ppt\//, "")]));
  const slidePaths = kids(path1(pres, "p:presentation", "p:sldIdLst"), "p:sldId").map((s) => rel[s.a["r:id"]]);
  const kitDir = path.dirname(xs[0].file).split("/").pop();
  for (const slide of [...new Set(xs.map((x) => x.slide))].sort((a, b) => a - b)) {
    const draws = res.drawings.filter((d) => d.slide === slide);
    const boxes = new Map();
    for (const d of draws) if (d.node) boxes.set(d.index, boxOf(d.node));
    for (const d of draws) if (d.composite) boxes.set(d.index, union(d.composite.map((m) => boxes.get(m))));
    const xml = P.parseXml(files.get(slidePaths[slide - 1])().toString("utf8"));
    const tree = path1(xml, "p:sld", "p:cSld", "p:spTree");
    const drawingNodes = new Set(draws.map((d) => d.node).filter(Boolean));
    const labels = [];
    for (const el of (tree?.c || []).filter((c) => c.n === "p:sp" && !drawingNodes.has(c))) {
      const t = textOf(kid(el, "p:txBody"));
      const b = boxOf(el);
      if (t && b && !/title/i.test(path1(kid(el, "p:nvSpPr"), "p:nvPr", "p:ph")?.a.type || "")) labels.push({ text: t, box: b });
    }
    const want = new Map(xs.filter((x) => x.slide === slide).map((x) => [path.basename(x.file), x]));
    const items = [];
    const placed = [];
    for (const d of draws) {
      const b = boxes.get(d.index);
      if (!b) continue;
      if (!d.composite) placed.push({ svg: d.svg, w: d.w, h: d.h, box: b });
      const x = want.get(`s${slide}-${d.index}.svg`);
      if (!x) continue;
      const near = labels.map((L) => ({ text: L.text, d: edgeDist(b, L.box) })).filter((L) => L.d < 40).sort((p, q) => p.d - q.d).map((L) => L.text);
      items.push({ n: items.length + 1, slug: x.slug, name: x.name, from: x.matched ? "website" : "slide", inner: d.node ? textOf(d.node) : "", near, svg: d.svg, w: d.w, h: d.h, box: b, composite: !!d.composite });
    }
    if (!items.length) continue;
    const slideTitle = draws[0]?.slideTitle || "";
    slides.push({ kit: kitName(kit), kitDir, slide, slideTitle, W, H, labels, placed, items });
  }
  console.log(`${kitName(kit)}: ${xs.length} drawings`);
}

/* ---------- pages ---------- */

const THUMB = 620, COLS = 6, CELL = 150, GAP = 24, PAD = 16, HEAD = 30, PAGE_MAX = 1900;
const PAGE_W = PAD * 2 + THUMB + GAP + COLS * CELL;

function slideBlock(s, y) {
  const tw = THUMB, th = (THUMB * s.H) / s.W;
  const rows = Math.ceil(s.items.length / COLS);
  const h = HEAD + Math.max(th, rows * CELL);
  let g = `<text x="${PAD}" y="${y + 20}" font-family="Arial" font-size="16" font-weight="bold" fill="#1d2733">${esc(`${s.kit} — slide ${s.slide}: ${s.slideTitle || "(no title)"}`)}</text>`;
  // the slide, with the drawings to name outlined and numbered
  let page = "";
  for (const d of s.placed) {
    const { vb, body } = inner(d.svg);
    page += `<svg x="${f1(d.box[0])}" y="${f1(d.box[1])}" width="${f1(Math.max(1, d.w))}" height="${f1(Math.max(1, d.h))}" viewBox="${vb}" preserveAspectRatio="none" overflow="visible">${body}</svg>`;
  }
  for (const L of s.labels) {
    const fs_ = Math.max(7, Math.min(16, (L.box[3] - L.box[1]) * 0.55));
    page += `<text x="${f1(L.box[0])}" y="${f1(L.box[1] + fs_)}" font-family="Arial" font-size="${f1(fs_)}" fill="#6b7480">${esc(L.text.slice(0, 80))}</text>`;
  }
  const k = s.W / THUMB; // badges keep a readable size on the small slide
  for (const it of s.items) {
    const [x0, y0, x1, y1] = it.box;
    page += `<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(x1 - x0)}" height="${f1(y1 - y0)}" fill="none" stroke="#e0301e" stroke-width="${f1(1.2 * k)}"${it.composite ? ` stroke-dasharray="${f1(5 * k)} ${f1(3 * k)}"` : ""}/>`
      + `<circle cx="${f1(x0)}" cy="${f1(y0)}" r="${f1(8 * k)}" fill="#e0301e"/><text x="${f1(x0)}" y="${f1(y0 + 3.4 * k)}" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="${f1((it.n > 99 ? 7 : 9.5) * k)}" fill="#fff">${it.n}</text>`;
  }
  g += `<rect x="${PAD}" y="${y + HEAD}" width="${f1(tw)}" height="${f1(th)}" fill="#fff" stroke="#c5ccd6"/>`
    + `<svg x="${PAD}" y="${y + HEAD}" width="${f1(tw)}" height="${f1(th)}" viewBox="0 0 ${f1(s.W)} ${f1(s.H)}">${page}</svg>`;
  // the drawings to name, enlarged
  const gx = PAD + THUMB + GAP;
  s.items.forEach((it, i) => {
    const cx = gx + (i % COLS) * CELL, cy = y + HEAD + Math.floor(i / COLS) * CELL;
    const { vb, body } = inner(it.svg);
    const bw = CELL - 12, bh = CELL - 36;
    g += `<rect x="${cx + 3}" y="${cy + 3}" width="${CELL - 6}" height="${CELL - 6}" rx="6" fill="#fff" stroke="#d5dbe3"/>`
      + `<svg x="${cx + 6}" y="${cy + 8}" width="${bw}" height="${bh}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${body}</svg>`
      + `<circle cx="${cx + 15}" cy="${cy + 15}" r="10" fill="#e0301e"/><text x="${cx + 15}" y="${cy + 19}" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="${it.n > 99 ? 8 : 11}" fill="#fff">${it.n}</text>`
      + `<text x="${cx + CELL / 2}" y="${cy + CELL - 12}" text-anchor="middle" font-family="Arial" font-size="10" fill="#6b7480">${esc(it.name.slice(0, 26))}</text>`;
  });
  return { g, h };
}

async function render(svg, file) {
  const r = await fetch(`${BASE}/api/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "png", svg, dpi: 96 }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  fs.writeFileSync(file, Buffer.from(j.result.base64, "base64"));
}

// batches of whole slides, about BATCH drawings each, a kit's slides together where they fit
const batches = [];
let cur = null;
for (const s of slides) {
  if (!cur || cur.count + s.items.length > BATCH * 1.25 || (cur.count >= BATCH * 0.6 && cur.kit !== s.kit)) {
    cur = { id: `b${String(batches.length + 1).padStart(2, "0")}`, kit: s.kit, count: 0, slides: [] };
    batches.push(cur);
  }
  cur.slides.push(s);
  cur.count += s.items.length;
}
const dir = path.join(OUT, "batches");
fs.mkdirSync(dir, { recursive: true });
const summary = [];
for (const b of batches) {
  const pages = [];
  let body = "", y = PAD;
  const flush = async () => {
    if (!body) return;
    const file = path.join(dir, `${b.id}-p${pages.length + 1}.png`);
    await render(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${PAGE_W}" height="${Math.ceil(y + PAD)}" viewBox="0 0 ${PAGE_W} ${Math.ceil(y + PAD)}"><rect width="100%" height="100%" fill="#f4f6f9"/>${body}</svg>`, file);
    pages.push(file);
    body = "";
    y = PAD;
  };
  for (const s of b.slides) {
    const blk = slideBlock(s, y);
    if (y > PAD && y + blk.h > PAGE_MAX) {
      await flush();
      const again = slideBlock(s, y);
      body += again.g;
      y += again.h + GAP;
    } else {
      body += blk.g;
      y += blk.h + GAP;
    }
  }
  await flush();
  const entry = {
    id: b.id, count: b.count, pages,
    slides: b.slides.map((s) => ({
      kit: s.kit, slide: s.slide, slideTitle: s.slideTitle, labels: s.labels.map((L) => L.text),
      items: s.items.map(({ n, slug, name, from, inner: t, near }) => ({ n, slug, name, from, ...(t ? { inner: t } : {}), ...(near.length ? { near } : {}) })),
    })),
  };
  // each batch on its own too, for whoever names it
  fs.writeFileSync(path.join(dir, `${b.id}.json`), JSON.stringify(entry, null, 1));
  summary.push(entry);
  console.log(`${b.id}: ${b.count} drawings, ${b.slides.length} slides, ${pages.length} page(s) — ${[...new Set(b.slides.map((s) => s.kit))].join(", ")}`);
}
fs.writeFileSync(path.join(OUT, "batches.json"), JSON.stringify(summary, null, 1));
console.log(`\n${summary.reduce((a, b) => a + b.count, 0)} drawings in ${summary.length} batches → ${OUT}`);
