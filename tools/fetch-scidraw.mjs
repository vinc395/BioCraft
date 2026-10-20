// SciDraw (scidraw.io): free scientific drawings made by researchers — rodents and other model
// organisms, neuroscience set-ups, cells, molecules — each archived on Zenodo with a DOI and
// licensed CC BY 4.0 (a few CC0). Reads the gallery through the site's own API (/api/v1), keeps
// each drawing's category, authors, licence and DOI, downloads the drawing (SVG; PNG and JPEG
// pictures are wrapped in an SVG so the library can show them) and writes
// sources/scidraw/{pack.json, manifest.json, svg/} for the library builder:
//
//   node tools/fetch-scidraw.mjs [--limit N]
//   target/release/biocanvas-libbuild --only scidraw --update
//
// Re-runs reuse what was downloaded (sources/scidraw/api and files) and only fetch new drawings.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "sources/scidraw");
const API = "https://scidraw.io/api/v1";
const argv = process.argv.slice(2);
const LIMIT = argv.includes("--limit") ? +argv[argv.indexOf("--limit") + 1] : Infinity;
for (const d of ["api", "files", "svg"]) fs.mkdirSync(path.join(OUT, d), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, as = "json", tries = 4) {
  url = url.replace(/^http:/, "https:");
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "BioCraft library importer (local, open-source scientific illustration app)" } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return null;
      return as === "json" ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await sleep(1500 * i);
    }
  }
}
/** Run `fn` over `items` a few at a time, politely. */
async function pool(items, n, fn) {
  let next = 0, done = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      if (++done % 50 === 0) console.log(`  ${done}/${items.length}`);
      await sleep(150);
    }
  }));
  return out;
}

/* ---------- names, categories, licences ---------- */

/** "AmericanCockroachOlfactorySensillum_PBas" → "American cockroach olfactory sensillum PBas". */
function cleanName(s) {
  let t = String(s || "").replace(/[_]+/g, " ").replace(/\s*\.(svg|png|jpe?g)$/i, "");
  // split camelCase words ("MouseOnSensor"); an acronym after at least three lower-case letters
  // ("brainMRI") too, but not "cAMP", "mRNA" or "ssTEM"
  t = t.replace(/([a-z])([A-Z][a-z])/g, "$1 $2").replace(/([a-z]{3,})([A-Z]{2,})/g, "$1 $2");
  t = t.replace(/\s+/g, " ").trim();
  // lower-case ordinary words after the first; keep acronyms and names with inner capitals
  t = t.split(" ").map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) && !/^(Drosophila|Xenopus|Aplysia|Purkinje|Golgi|Schwann|Petri|Eppendorf|Falcon)$/.test(w) ? w.toLowerCase() : w)).join(" ");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}
// SciDraw's categories, as a source category the library's keyword rules understand
const CATEGORY = {
  mouse: ["Animals, Rodents, mouse", ["mouse", "rodent", "Mus musculus"]],
  rat: ["Animals, Rodents, rat", ["rat", "rodent", "Rattus norvegicus"]],
  fish: ["Animals, Fishes", ["fish"]],
  drosophila: ["Animals, Arthropods, insects", ["Drosophila", "fruit fly", "insect"]],
  bird: ["Animals, Birds", ["bird"]],
  human: ["People, human", ["human"]],
  cell: ["Cells", ["cell"]],
  other: ["", []],
};
const LICENSE = { "cc-by": "CC-BY-4.0", "cc-by-4.0": "CC-BY-4.0", cc0: "CC0-1.0", "cc0-1.0": "CC0-1.0" };

// SciDraw's "other" and "human" drawings: a source category the keyword rules settle on.
// Organisms take the category of the same species (or genus) in the library's PhyloPic pack.
const HINTS = [
  [/electrode|probe|utah array|neuronexus|objective|ferrule|optogenetic|implant|headstage|chamber|cage|scanner|illumina|sequencer|fed3|\bepm\b|cpp box|\b(fib|sb|gcib|atum|ss)?sem\b|\btem\b|em slice|dry bath|thermometer|weight|scissors|pellet|\bled\b|tips|microtube|pestle|syringe|pump|shock|maze|lever|sensor|laboratory|electromyography|\bemg\b|elisa|recording rig|microscope|camera|laser/i, "Lab apparatus, neuroscience"],
  [/\bacid\b|\w+ose\b|caffeine|cannabidiol|adenosine|\bc ?amp\b|\bc ?gmp\b|\bgtp\b|\batp\b|haem|heme|ganglioside|glyceride|urea|cholesterol|dopamine|serotonin|glutamate|gaba\b/i, "Chemistry"],
  [/network|\brnn\b|spike train|neural recording|trace|raster/i, "Scientific graphs"],
  [/nerve|cns|brain|medulla|myelencephalon|molar|tooth|spinal|cortex|chiasm|retina|\beye\b|hand|finger|head\b|skull/i, "Anatomy, human"],
];
const NOT_SCIENCE = /^(sci ?draw (icon|logo)|啊+)$/i;
const RENAME = { "植物": "Plant" };
// species and genera already filed by PhyloPic
const phylo = new Map(), genus = new Map();
try {
  for (const m of JSON.parse(fs.readFileSync(path.join(ROOT, "library/index.json"), "utf8")).icons) {
    if (m.pack !== "phylopic" || !m.subcategory) continue;
    const key = m.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").trim();
    phylo.set(key, m.subcategory);
    const g = key.split(" ")[0];
    if (g.length > 3) genus.set(g, genus.has(g) && genus.get(g) !== m.subcategory ? m.subcategory.split(",").slice(0, 2).join(",") : m.subcategory);
  }
} catch {}
const ORGANISM = /\b(frog|lizard|snake|python|cobra|monitor|monkey|macaque|marmoset|sheep|rabbit|bat|chameleon|salamander|alpaca|squirrel|cat|pig|ant|cockroach|mosquito|jellyfish|worm|planarian|hydra|tardigrade|songbird|finch|owl|cricket|bee)\b/i;
function sourceCategory(cat, name) {
  if (cat !== "other" && cat !== "human") return CATEGORY[cat]?.[0] ?? "";
  const key = name.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").trim();
  if (cat === "other") {
    if (phylo.has(key)) return phylo.get(key);
    const g = key.split(" ")[0];
    if (genus.has(g)) return genus.get(g);
  }
  for (const [re, src] of HINTS) if (re.test(name)) return cat === "human" && src.startsWith("Chemistry") ? "People, human" : src;
  if (cat === "other" && ORGANISM.test(name)) return "Animals";
  return cat === "human" ? "People, human" : "";
}
const cleanAuthors = (names) => {
  const xs = names.map((n) => String(n || "").replace(/\s+/g, " ").replace(/\s*,\s*$/, "").trim()).filter(Boolean);
  const real = xs.filter((n) => !/^sci ?draw$/i.test(n));
  return (real.length ? real : xs.map(() => "SciDraw")).filter((n, i, a) => a.indexOf(n) === i);
};

/* ---------- pictures wrapped as SVG ---------- */

function pictureSize(buf) {
  // PNG: IHDR width/height; JPEG: the first SOFn frame
  if (buf.slice(1, 4).toString() === "PNG") return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  return null;
}
function wrapPicture(buf, mime) {
  const sz = pictureSize(buf);
  if (!sz) return null;
  const [w, h] = sz;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" xlink:href="data:${mime};base64,${buf.toString("base64")}"/></svg>\n`;
}

/**
 * Many drawings were exported on a whole page with a white page rectangle behind them, so the
 * icon would be the page with a small drawing in it. The first shape, when it is a white
 * rectangle at the top-left covering (nearly) the whole page, is dropped; the library then crops
 * to the drawing.
 */
function dropPage(text) {
  const num = (v) => parseFloat(String(v || "").replace(/px$/, ""));
  const root = /<svg\b[^>]*>/i.exec(text)?.[0] || "";
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const pw = vb?.[2] || num(/\swidth\s*=\s*["']([^"']+)["']/i.exec(root)?.[1]);
  const ph = vb?.[3] || num(/\sheight\s*=\s*["']([^"']+)["']/i.exec(root)?.[1]);
  // the first drawn element after the root (groups and definitions don't count)
  const first = /<(rect|path|circle|ellipse|polygon|polyline|line|image|text|use)\b[^>]*>/i.exec(text.slice(text.indexOf(root) + root.length));
  if (!first || first[1].toLowerCase() !== "rect") return text;
  const r = first[0];
  const attr = (k) => new RegExp(`\\s${k}\\s*=\\s*["']([^"']*)["']`, "i").exec(r)?.[1];
  const style = attr("style") || "";
  const fill = (attr("fill") || /fill\s*:\s*([^;]+)/i.exec(style)?.[1] || "").trim().toLowerCase();
  const stroke = (attr("stroke") || /stroke\s*:\s*([^;]+)/i.exec(style)?.[1] || "none").trim().toLowerCase();
  if (!/^(#fff|#ffffff|white|rgb\(255,\s*255,\s*255\))$/.test(fill) || stroke !== "none") return text;
  if (num(attr("x") || 0) > 1 || num(attr("y") || 0) > 1 || attr("transform")) return text;
  const w = num(attr("width")), h = num(attr("height"));
  // with no page size on the root, a white rectangle from the corner that is the first thing drawn is the page
  if (pw && ph && (w < pw * 0.9 || h < ph * 0.9)) return text;
  if (!pw && !(w > 100 && h > 100)) return text;
  return text.replace(r, "");
}

/* ---------- gallery ---------- */

console.log("SciDraw: reading the gallery…");
const list = [];
for (let url = `${API}/drawings/?page=1`; url && list.length < LIMIT; ) {
  const page = await get(url);
  if (!page) break;
  list.push(...(page.results || []));
  url = page.next;
  await sleep(200);
}
const drawings = list.slice(0, LIMIT);
console.log(`  ${drawings.length} drawings`);

const details = await pool(drawings, 3, async (d) => {
  const f = path.join(OUT, "api", `${d.slug}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const j = (await get(`${API}/drawings/${d.slug}/`)) || d;
  fs.writeFileSync(f, JSON.stringify(j, null, 1));
  return j;
});

const manifest = [];
const seen = new Map(); // content hash → slug (the same drawing uploaded twice)
const skipped = { licence: 0, type: 0, download: 0, duplicate: 0 };
await pool(details, 3, async (d) => {
  const license = LICENSE[String(d.license || "").toLowerCase()];
  if (!license) return skipped.licence++;
  const type = String(d.image_type || "").toLowerCase();
  const ext = type === "svg" ? "svg" : type === "png" ? "png" : type === "jpg" || type === "jpeg" ? "jpg" : null;
  if (!ext) return skipped.type++;
  const raw = path.join(OUT, "files", `${d.slug}.${ext}`);
  let buf = fs.existsSync(raw) ? fs.readFileSync(raw) : null;
  if (!buf) {
    buf = await get(d.image_url || d.image, "buffer").catch(() => null);
    if (!buf) return skipped.download++;
    fs.writeFileSync(raw, buf);
  }
  const hash = crypto.createHash("sha1").update(buf).digest("hex");
  if (seen.has(hash)) return skipped.duplicate++;
  seen.set(hash, d.slug);
  // A few of SciDraw's stored copies are damaged (stray "</svg>" tags, NUL bytes); the Zenodo
  // archive of the same DOI is intact, so that copy is used. A JPEG labelled PNG is told by its bytes.
  const damaged = (b) => b.includes(0) || (b.toString("utf8").match(/<\/svg\s*>/g) || []).length > (b.toString("utf8").match(/<svg[\s>]/g) || []).length;
  if (ext === "svg" && damaged(buf) && d.doi) {
    const f = path.join(OUT, "zenodo", `${d.slug}.svg`);
    let z = fs.existsSync(f) ? fs.readFileSync(f) : null;
    if (!z) {
      const rec = await get(`https://zenodo.org/api/records/${d.doi.split(".").pop()}`).catch(() => null);
      const file = (rec?.files || []).find((x) => /\.svg$/i.test(x.key));
      z = file ? await get(file.links.self, "buffer").catch(() => null) : null;
      if (z) fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, z);
    }
    if (z && !damaged(z)) buf = z;
  }
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const svg = ext === "svg" ? dropPage(buf.toString("utf8")) : wrapPicture(buf, jpeg ? "image/jpeg" : "image/png");
  if (!svg) return skipped.type++;
  fs.writeFileSync(path.join(OUT, "svg", `${d.slug}.svg`), svg);
  const cat = d.category?.slug || d.category_slug || "other";
  const catTags = (CATEGORY[cat] || ["", []])[1];
  const authors = cleanAuthors(d.authors?.length ? d.authors.map((a) => a.full_name || `${a.first_name || ""} ${a.last_name || ""}`.trim()) : [d.primary_author?.full_name]);
  const name = RENAME[String(d.name).trim()] || cleanName(d.name) || cleanName(cat) + " drawing";
  if (NOT_SCIENCE.test(name)) return skipped.type++;
  const srcCat = sourceCategory(cat, name);
  manifest.push({
    slug: d.slug,
    name,
    file: `svg/${d.slug}.svg`,
    category: srcCat,
    tags: [...new Set([...catTags, "SciDraw"])],
    author: authors.join(", ") || "SciDraw contributor",
    license,
    source_url: d.doi ? `https://doi.org/${d.doi}` : `https://scidraw.io/drawing/${d.slug}`,
    description: [ext === "svg" ? "" : "Picture (not recolourable).", `SciDraw drawing${d.created_at ? `, uploaded ${d.created_at.slice(0, 10)}` : ""}.`].filter(Boolean).join(" "),
    ...(ext === "svg" ? {} : { style: "picture" }),
  });
});
manifest.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(OUT, "pack.json"), JSON.stringify({
  id: "scidraw",
  name: "SciDraw",
  description: "Scientific drawings shared by researchers on scidraw.io (rodents and other model organisms, neuroscience, cells), each archived on Zenodo with a DOI",
  url: "https://scidraw.io",
  credit: "SciDraw (scidraw.io) — drawings by their authors, licensed under CC BY 4.0 (some CC0); see each drawing's DOI",
}, null, 1));
const vec = manifest.filter((m) => !m.style).length;
console.log(`\n${manifest.length} drawings (${vec} vector, ${manifest.length - vec} pictures) → ${OUT}`, skipped);
