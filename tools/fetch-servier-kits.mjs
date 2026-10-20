// Download the Servier Medical Art PowerPoint kits (https://smart.servier.com, CC BY 4.0) and turn
// every drawing in them into an SVG → sources/servier-kits/ (pack "servier"; the library builder
// then drops the smaller Servier subset that ships inside Bioicons).
//
// 1. crawl /smart_pptx/page/N/ for each image's title, category, preview PNG and kit URL
// 2. download every kit once (pptx/), and the small preview PNGs (previews/) used to name drawings
// 3. convert each top-level drawing of each slide with tools/pptx2svg.mjs (svg/)
// 4. name drawings: the website image whose preview looks the same (same kit), else the nearest
//    label on the slide, else the slide title → manifest.json + pack.json
//
//   node tools/fetch-servier-kits.mjs [--offline] [--kit SMART-Lipids] [--no-convert]
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchText, download, pool, writeJson, sleep } from "./lib/net.mjs";

// loaded only for the convert step, so the download step runs on its own
let convertPptx, decodePng, rasterizeSvgPaths, signature, sigDistance;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "sources", "servier-kits");
const BASE = "https://smart.servier.com";
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OFFLINE = flag("--offline");
const ONLY_KIT = opt("--kit");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ouml: "ö", uuml: "ü", auml: "ä", deg: "°", micro: "µ", times: "×", alpha: "α", beta: "β", gamma: "γ", kappa: "κ" };
export const decodeEntities = (t) =>
  String(t ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

/** Parse the image tiles of one /smart_pptx/ listing page. */
function parseListing(html) {
  const items = [];
  for (const art of html.split('<article class="result-thumbnail').slice(1)) {
    const body = art.slice(0, art.indexOf("</article>") + 1 || undefined);
    const id = +(/id="result-thumbnail-(\d+)"/.exec(body)?.[1] || 0);
    const page = /class="result-thumbnail-image" href="([^"]+)"/.exec(body)?.[1] || null;
    const img = /<img ([^>]*)>/.exec(body)?.[1] || "";
    const attr = (k) => new RegExp(`\\b${k}="([^"]*)"`).exec(img)?.[1] || null;
    const title = /<h3><a [^>]*>([\s\S]*?)<\/a><\/h3>/.exec(body)?.[1];
    const cat = /<p>\s*<a href="([^"]+)" title="([^"]*)"/.exec(body);
    const png = /<a download href="([^"]+)"[^>]*class="btn-dl "/.exec(body)?.[1] || null;
    const kit = /<a download href="([^"]+)"[^>]*class="btn-dl-entire /.exec(body)?.[1] || null;
    if (!id || !title) continue;
    const catPath = cat ? cat[1].replace(/^.*\/category\//, "").replace(/\/$/, "") : "";
    items.push({
      id,
      title: decodeEntities(title),
      page,
      category: cat ? decodeEntities(cat[2]) : "",
      categoryPath: catPath ? catPath.split("/") : [],
      alt: decodeEntities(attr("alt") || ""),
      thumb: attr("src"),
      thumbW: +attr("width") || 0,
      thumbH: +attr("height") || 0,
      png,
      kit,
    });
  }
  const last = Math.max(1, ...[...html.matchAll(/\/smart_pptx\/page\/(\d+)\//g)].map((m) => +m[1]));
  return { items, last };
}

async function crawl() {
  const dir = path.join(OUT, "pages");
  fs.mkdirSync(dir, { recursive: true });
  const get = async (n) => {
    const file = path.join(dir, `page-${n}.html`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) return fs.readFileSync(file, "utf8");
    if (OFFLINE) return "";
    const html = await fetchText(n === 1 ? `${BASE}/smart_pptx/` : `${BASE}/smart_pptx/page/${n}/`);
    fs.writeFileSync(file, html);
    await sleep(250);
    return html;
  };
  const first = parseListing(await get(1));
  console.log(`Servier listing: ${first.last} pages`);
  const pages = Array.from({ length: first.last - 1 }, (_, i) => i + 2);
  const rest = await pool(pages, 2, async (n) => parseListing(await get(n)).items, { label: "listing pages", every: 20 });
  const all = [...first.items, ...rest.flatMap((r) => (Array.isArray(r) ? r : []))];
  const seen = new Set();
  const items = all.filter((it) => !seen.has(it.id) && seen.add(it.id));
  writeJson(path.join(OUT, "listing.json"), items);
  console.log(`  ${items.length} images, ${new Set(items.map((i) => i.kit).filter(Boolean)).size} kits`);
  return items;
}

const kitName = (url) => decodeURIComponent(url.split("/").pop()).replace(/\.pptx$/i, "");

async function fetchKits(items) {
  const kits = [...new Set(items.map((i) => i.kit).filter(Boolean))].sort();
  if (!OFFLINE)
    await pool(kits, 2, async (url) => {
      const r = await download(url, path.join(OUT, "pptx", kitName(url) + ".pptx"), { timeoutMs: 600000 });
      if (r === "ok") await sleep(500);
    }, { label: "kits", every: 5 });
  // preview thumbnails (≤300 px) to recognise which drawing each web image shows
  if (!OFFLINE)
    await pool(items.filter((i) => i.thumb && /\.png$/i.test(i.thumb)), 3, async (it) => {
      const r = await download(it.thumb, path.join(OUT, "previews", `${it.id}.png`));
      if (r === "ok") await sleep(100);
    }, { label: "previews", every: 250 });
  return kits;
}

// ---- naming: match drawings to website images by appearance ----------------------------------

const SIG = 20; // signature raster size
const ONE_TO_ONE = 0.09; // pairs closer than this are the same picture
const SHARED = 0.04; // a further drawing may take an already used title (copies, colour variants)
const SURE = 0.06; // above this, the title must also share a word with the slide title or labels

const singular = (w) => (w.length <= 4 || w.endsWith("ss") ? w : w.endsWith("ies") ? w.slice(0, -3) + "y" : w.endsWith("s") ? w.slice(0, -1) : w);
const STOP = new Set(["the", "and", "with", "from", "for", "of", "in", "on", "view", "side", "front", "frontal", "part", "type"]);
const wordSet = (...texts) =>
  new Set(texts.join(" ").toLowerCase().normalize("NFKD").split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(singular));
const related = (web, d) => {
  const a = wordSet(web.title), b = wordSet(d.slideTitle || "", d.label || "", ...(d.labels || []));
  for (const w of a) if (b.has(w)) return true;
  return false;
};

function safeSig(fn) {
  try { return fn(); } catch { return null; }
}
const drawingSig = (d) =>
  d.raster ? safeSig(() => signature(rasterizeSvgPaths(d.raster, d.w, d.h, 96), SIG)) : d.png ? safeSig(() => signature(decodePng(d.png), SIG)) : null;

/** Website image → drawing: one-to-one, best pairs first; then close duplicates may share. */
function assign(drawings, webItems) {
  const pairs = [];
  const best = new Map();
  for (let wi = 0; wi < webItems.length; wi++) {
    const ws = webItems[wi].sig;
    if (!ws) continue;
    for (let di = 0; di < drawings.length; di++) {
      const ds = drawings[di].sig;
      if (!ds) continue;
      const d = sigDistance(ws, ds);
      pairs.push([d, wi, di]);
      if (!best.has(di) || d < best.get(di)[0]) best.set(di, [d, wi]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const usedW = new Set(), out = new Map();
  for (const [d, wi, di] of pairs) {
    if (d > ONE_TO_ONE) break;
    if (usedW.has(wi) || out.has(di)) continue;
    if (d > SURE && !related(webItems[wi], drawings[di])) continue;
    usedW.add(wi);
    out.set(di, { web: webItems[wi], dist: d });
  }
  for (const [di, [d, wi]] of best) if (!out.has(di) && d <= SHARED) out.set(di, { web: webItems[wi], dist: d, shared: true });
  return out;
}

const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "drawing";
const words = (s) => String(s).replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
const cleanTitle = (t) => words(t).replace(/\s*\((\d+)\)\s*$/, "").replace(/\s*-\s*$/, "").replace(/^\d+\s*[-–.]\s*/, "");
const geometryKey = (svg) =>
  svg.replace(/<title>.*?<\/title>/, "").replace(/(fill|stroke|stop-color)="#[0-9a-f]{6}"/gi, "").replace(/(fill|stroke|stop)-opacity="[^"]*"/g, "");
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const items = await crawl();
  const kits = await fetchKits(items);
  if (flag("--no-convert")) return;
  ({ convertPptx } = await import("./pptx2svg.mjs"));
  ({ decodePng, rasterizeSvgPaths, signature, sigDistance } = await import("./lib/raster.mjs"));

  const byKit = new Map();
  for (const it of items) if (it.kit) (byKit.get(kitName(it.kit)) || byKit.set(kitName(it.kit), []).get(kitName(it.kit))).push(it);
  const manifest = [], failures = [], report = [];
  const seenExact = new Map(); // svg hash → manifest entry (the same drawing on two slides or in two kits)
  let duplicates = 0;
  let kitList = kits.map(kitName);
  if (ONLY_KIT) kitList = kitList.filter((k) => ONLY_KIT.split(",").includes(k));
  for (const kit of kitList) {
    const file = path.join(OUT, "pptx", kit + ".pptx");
    if (!fs.existsSync(file)) { failures.push({ kit, error: "kit not downloaded" }); continue; }
    const t0 = Date.now();
    let res;
    try {
      res = convertPptx(fs.readFileSync(file), { name: kit });
    } catch (e) {
      failures.push({ kit, error: String(e.stack || e) });
      console.log(`  ${kit}: FAILED ${e.message}`);
      continue;
    }
    const kitSlug = slugify(kit.replace(/^SMART-/, ""));
    const svgDir = path.join(OUT, "svg", kitSlug);
    fs.rmSync(svgDir, { recursive: true, force: true });
    fs.mkdirSync(svgDir, { recursive: true });
    const web = (byKit.get(kit) || []).map((w) => ({ ...w, sig: safeSig(() => signature(decodePng(fs.readFileSync(path.join(OUT, "previews", `${w.id}.png`))), SIG)) }));
    for (const d of res.drawings) d.sig = drawingSig(d);
    const matches = assign(res.drawings, web);
    const kitTopic = cleanTitle(res.title || kit.replace(/^SMART-/, ""));
    const kitCat = (mostCommon(web.map((w) => w.categoryPath.join("/"))) || "").split("/").filter(Boolean);
    const primaries = new Map(); // geometry → slug of the first drawing with it (colour variants)
    const used = new Set(manifest.map((m) => m.slug));
    let kept = 0, variants = 0;
    let composites = 0;
    res.drawings.forEach((d, di) => {
      const m = matches.get(di);
      // a stack of overlapping drawings is only worth keeping when the website shows it as one
      if (d.composite && !m) return;
      if (d.composite) composites++;
      const slideTitle = cleanTitle(d.slideTitle || "");
      const name = m ? m.web.title : d.label ? cleanTitle(d.label) : slideTitle || kitTopic;
      const exact = hash(d.svg.replace(/<title>.*?<\/title>/, ""));
      const tags0 = [kitTopic, slideTitle, d.label && cleanTitle(d.label), ...(d.labels || []).map(cleanTitle), m?.web.category];
      if (seenExact.has(exact)) {
        // the same drawing again: keep one, with both names as tags
        const first = seenExact.get(exact);
        first.tags = [...new Set([...first.tags, name, ...tags0].filter((t) => t && t.length > 1 && t.length < 60))];
        duplicates++;
        return;
      }
      // category: the website's for a recognised drawing, else a recognised neighbour's on the slide
      let catPath = m?.web.categoryPath;
      if (!catPath) {
        const near = res.drawings
          .map((x, i) => [Math.abs(i - di), x.slide === d.slide && matches.get(i)])
          .filter((x) => x[1])
          .sort((p, q) => p[0] - q[0])[0];
        catPath = near ? near[1].web.categoryPath : kitCat;
      }
      let slug = slugify(m && !m.shared ? m.web.page?.replace(/\/$/, "").split("/").pop() || m.web.title : `${kitSlug}-${name}`);
      for (let n = 2; used.has(slug); n++) slug = slugify(`${kitSlug}-${name}`) + "-" + n;
      used.add(slug);
      const geo = hash(geometryKey(d.svg));
      const variantOf = primaries.get(geo);
      if (!variantOf) primaries.set(geo, slug);
      const rel = `svg/${kitSlug}/s${d.slide}-${d.index}.svg`;
      fs.writeFileSync(path.join(OUT, rel), d.svg);
      const entry = {
        slug,
        name,
        file: rel,
        category: catPath.length ? catPath.map(words).join(", ") : kitTopic,
        tags: [...new Set([...tags0, ...catPath.map(words)].filter((t) => t && t.length > 1 && t.length < 60))],
        author: "Servier Medical Art",
        license: "CC-BY-4.0",
        source_url: m?.web.page || kitUrl(items, kit),
        description: [slideTitle && slideTitle.toLowerCase() !== name.toLowerCase() ? slideTitle : "", `Servier Medical Art kit "${kitTopic}", slide ${d.slide}`].filter(Boolean).join(". ") + ".",
        variant_of: variantOf || undefined,
        kit: kit + ".pptx",
        slide: d.slide,
        picture: d.picture || undefined,
        composite: d.composite,
        matched: m ? { id: m.web.id, dist: +m.dist.toFixed(3), shared: m.shared || undefined } : null,
        warnings: d.warnings?.length ? d.warnings : undefined,
      };
      if (variantOf) variants++;
      Object.defineProperty(entry, "sig", { value: d.sig, enumerable: false });
      seenExact.set(exact, entry);
      manifest.push(entry);
      kept++;
    });
    const named = [...matches.values()].filter((x) => !x.shared).length;
    report.push({ kit, slides: res.slides, drawings: res.drawings.length - res.composites, composites: `${composites}/${res.composites}`, kept, variants, web: web.length, webMatched: named, shared: matches.size - named, skipped: res.skipped, warnings: countWarnings(res.drawings), ms: Date.now() - t0 });
    console.log(`  ${kit}: ${res.drawings.length - res.composites} drawings + ${composites}/${res.composites} composites (${kept} kept, ${variants} colour variants), ${named}/${web.length} website images recognised (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  // (needs every kit: a single-kit test run would find most earlier icons "missing")
  const legacy = ONLY_KIT ? { known: 0, kept: 0 } : keepLegacyIds(manifest);
  if (!ONLY_KIT) {
    writeJson(path.join(OUT, "manifest.json"), manifest);
    writeJson(path.join(OUT, "pack.json"), {
      id: "servier",
      name: "Servier Medical Art",
      description: "Servier Medical Art drawings converted from the official PowerPoint kits",
      url: BASE,
      credit: "Servier Medical Art (smart.servier.com), licensed under CC BY 4.0",
    });
  } else writeJson(path.join(OUT, `manifest-${slugify(ONLY_KIT)}.json`), manifest);
  writeJson(path.join(OUT, "report.json"), { kits: report, failures, duplicates, legacy });
  const matched = manifest.filter((m) => m.matched).length;
  console.log(`Done: ${manifest.length} drawings from ${report.length} kits (${duplicates} exact duplicates dropped, ${manifest.filter((m) => m.variant_of).length} colour variants); ${matched} named after a website image; ${legacy.kept}/${legacy.known} earlier Servier ids matched, ${legacy.carriedOver || 0} carried over from Bioicons; ${failures.length} kit failures`);
}

// ---- keep the library ids of the Servier icons that used to come from Bioicons ----------------

const LEGACY = 0.05; // the same drawing

/** Signatures of the earlier (Bioicons) Servier icons, from the built library's thumbnails; cached. */
function legacyIcons() {
  const cache = path.join(OUT, "legacy-ids.json");
  const unpack = (e) => ({ ...e, sig: { n: e.n, aspect: e.aspect, cells: Float32Array.from(Buffer.from(e.cells, "base64"), (v) => v / 255) } });
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8")).map(unpack);
  const lib = path.join(ROOT, "library");
  let index;
  try { index = JSON.parse(fs.readFileSync(path.join(lib, "index.json"), "utf8")); } catch { return []; }
  const old = index.icons.filter((i) => i.pack === "servier" && !/\/smart_image\/|\.pptx$/.test(i.source_url || ""));
  const out = [];
  for (const i of old) {
    const sig = safeSig(() => signature(decodePng(fs.readFileSync(path.join(lib, i.thumb))), SIG));
    if (sig) out.push({ slug: i.id.split("/")[1], name: i.name, tags: i.tags || [], n: sig.n, aspect: sig.aspect, cells: Buffer.from(Uint8Array.from(sig.cells, (v) => Math.round(v * 255))).toString("base64") });
  }
  if (out.length) writeJson(cache, out);
  return out.map(unpack);
}

/** Give drawings that are the same as an earlier Servier icon that icon's slug (and name if none). */
function keepLegacyIds(manifest) {
  const old = legacyIcons();
  if (!old.length) return { known: 0, kept: 0 };
  const pairs = [];
  for (let oi = 0; oi < old.length; oi++)
    for (let ei = 0; ei < manifest.length; ei++) {
      const es = manifest[ei].sig;
      if (!es || Math.abs(Math.log(es.aspect / old[oi].sig.aspect)) > 0.2) continue;
      const d = sigDistance(old[oi].sig, es);
      if (d <= LEGACY) pairs.push([d, oi, ei]);
    }
  pairs.sort((a, b) => a[0] - b[0]);
  const usedO = new Set(), byEntry = new Map();
  for (const [d, oi, ei] of pairs) {
    if (usedO.has(oi) || byEntry.has(ei)) continue;
    usedO.add(oi);
    byEntry.set(ei, { ...old[oi], dist: d });
  }
  // reserve the old slugs, move other entries off them, then rename (variant_of follows)
  const reserved = new Set([...byEntry.values()].map((o) => o.slug));
  const rename = new Map();
  const taken = new Set(manifest.map((m) => m.slug));
  manifest.forEach((m, ei) => {
    const o = byEntry.get(ei);
    if (o) { rename.set(m.slug, o.slug); return; }
    if (!reserved.has(m.slug)) return;
    let n = 2, s = m.slug + "-" + n;
    while (taken.has(s) || reserved.has(s)) s = m.slug + "-" + ++n;
    taken.add(s);
    rename.set(m.slug, s);
  });
  manifest.forEach((m, ei) => {
    const o = byEntry.get(ei);
    if (rename.has(m.slug)) m.slug = rename.get(m.slug);
    if (m.variant_of && rename.has(m.variant_of)) m.variant_of = rename.get(m.variant_of);
    if (!o) return;
    m.legacy_id = true;
    // the closer of the two matches names the drawing (Bioicons kept Servier's own file names)
    const sameName = o.name.replace(/\s+\d+$/, "").toLowerCase() === m.name.toLowerCase();
    if (!m.matched || (o.dist + 0.01 < m.matched.dist && !sameName)) {
      if (m.matched && m.name !== o.name) m.tags = [...m.tags, m.name];
      m.name = o.name;
    }
    m.tags = [...new Set([...m.tags, o.name, ...o.tags.map(words)])];
  });
  const added = addLegacyLeftovers(manifest, old.filter((o) => !usedO.has(old.indexOf(o))));
  return { known: old.length, kept: byEntry.size, carriedOver: added };
}

const rustSlug = (t) => {
  let o = "";
  for (const ch of t) if (/[A-Za-z0-9]/.test(ch)) o += ch.toLowerCase(); else if (o && !o.endsWith("-")) o += "-";
  o = o.replace(/-+$/, "");
  return o ? o.slice(0, 80) : "icon";
};
const BIOICONS_LICENSE = { "cc-0": "CC0-1.0", "cc-by-3.0": "CC-BY-3.0", "cc-by-4.0": "CC-BY-4.0" };

/** Earlier Servier icons with no counterpart in the kits stay in the pack, from Bioicons' copy. */
function addLegacyLeftovers(manifest, leftovers) {
  const dir = path.join(ROOT, "sources", "bioicons");
  let bio;
  try { bio = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { return 0; }
  const bySlug = new Map(bio.filter((e) => e.author === "Servier").map((e) => [rustSlug(e.name), e]));
  const outDir = path.join(OUT, "bioicons");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const taken = new Set(manifest.map((m) => m.slug));
  let n = 0;
  for (const o of leftovers) {
    const e = bySlug.get(o.slug);
    if (!e || taken.has(o.slug) || !fs.existsSync(path.join(dir, e.file))) continue;
    fs.copyFileSync(path.join(dir, e.file), path.join(outDir, o.slug + ".svg"));
    manifest.push({
      slug: o.slug,
      name: o.name,
      file: `bioicons/${o.slug}.svg`,
      category: e.category,
      tags: [...new Set([words(e.category), ...o.tags.map(words)])],
      author: "Servier Medical Art",
      license: BIOICONS_LICENSE[e.license] || "CC-BY-3.0",
      source_url: "https://bioicons.com",
      description: "Servier Medical Art drawing, via Bioicons (not found in the current PowerPoint kits).",
      legacy_id: true,
      via: "bioicons",
    });
    taken.add(o.slug);
    n++;
  }
  return n;
}

function kitUrl(items, kit) {
  return items.find((i) => i.kit && kitName(i.kit) === kit)?.kit || BASE + "/smart_pptx/";
}

function countWarnings(drawings) {
  const c = {};
  for (const d of drawings) for (const w of d.warnings || []) c[w] = (c[w] || 0) + 1;
  return c;
}

function mostCommon(arr) {
  const c = new Map();
  for (const a of arr) if (a) c.set(a, (c.get(a) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
