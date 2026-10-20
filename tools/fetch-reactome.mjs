// Download the Reactome Icon Library (https://reactome.org/icon-lib) into sources/reactome/.
// Icons used in Reactome's Enhanced High-Level Diagrams: proteins, receptors, compounds, cell
// types, organelles, tissues… Licensed CC BY 4.0 (https://reactome.org/license). The SVGs and
// their XML metadata (name, description, categories, designer/curator, references, synonyms)
// come from Reactome's own repository (github.com/reactome/reactome_illustrations, icons/).
//
//   node tools/fetch-reactome.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, download, pool, writeJson } from "./lib/net.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "sources", "reactome");
const REPO = "reactome/reactome_illustrations";
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;

const unxml = (s) =>
  String(s ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
const all = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => ({ attrs: m[1], text: unxml(m[2]) }));
const one = (xml, tag) => all(xml, tag)[0]?.text || "";
const attr = (attrs, k) => new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)?.[1] || "";

function parseMeta(xml) {
  return {
    name: one(xml, "name"),
    description: one(xml, "description"),
    categories: all(xml, "category").map((c) => c.text).filter(Boolean),
    people: all(xml, "person").map((p) => ({ name: p.text, role: attr(p.attrs, "role"), url: attr(p.attrs, "url"), orcid: attr(p.attrs, "orcid") })),
    synonyms: all(xml, "synonym").map((s) => s.text).filter(Boolean),
    refs:[...xml.matchAll(/<reference>\s*<db>([^<]*)<\/db>\s*<id>([^<]*)<\/id>/g)].map((m) => `${unxml(m[1])}:${unxml(m[2]).replace(/^[A-Za-z]+:/, "")}`),
    skip: /<skip>\s*true\s*<\/skip>/i.test(xml),
  };
}

const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "icon";
const words = (s) => String(s).replace(/_/g, " ").trim();

const tree = await fetchJson(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`);
const blobs = new Set(tree.tree.filter((e) => e.type === "blob").map((e) => e.path));
const ids = [...blobs].map((p) => /^icons\/(R-ICO-\d+)\.svg$/.exec(p)?.[1]).filter(Boolean).sort();
console.log(`Reactome icons: ${ids.length} SVGs listed${tree.truncated ? " (tree truncated!)" : ""}`);
for (const f of ["LICENSE", "README.md", "VERSION"]) {
  try { await download(RAW + f, path.join(OUT, f)); } catch {}
}

const manifest = [], failures = [];
const usedSlugs = new Set();
await pool(
  ids,
  4,
  async (id) => {
    const svgFile = path.join(OUT, "svg", `${id}.svg`), xmlFile = path.join(OUT, "meta", `${id}.xml`);
    try {
      await download(RAW + `icons/${id}.svg`, svgFile);
      if (blobs.has(`icons/${id}.xml`)) await download(RAW + `icons/${id}.xml`, xmlFile);
    } catch (e) {
      failures.push({ id, error: String(e.message || e) });
      return;
    }
    const meta = fs.existsSync(xmlFile) ? parseMeta(fs.readFileSync(xmlFile, "utf8")) : { name: "", categories: [], people: [], synonyms: [], refs: [], skip: false };
    manifest.push({ id, meta });
  },
  { label: "reactome", every: 250 }
);

manifest.sort((a, b) => a.id.localeCompare(b.id));
const entries = manifest.map(({ id, meta }) => {
  const name = meta.name || id;
  let slug = slugify(name);
  if (usedSlugs.has(slug)) slug = slugify(`${name}-${id.slice(6)}`);
  usedSlugs.add(slug);
  const designers = meta.people.filter((p) => p.role === "designer").map((p) => p.name);
  const curators = meta.people.filter((p) => p.role === "curator").map((p) => p.name);
  const author = ["Reactome", designers.length ? `designed by ${designers.join(", ")}` : "", curators.length ? `curated by ${curators.join(", ")}` : ""].filter(Boolean).join("; ");
  return {
    slug,
    name,
    file: `svg/${id}.svg`,
    category: words(meta.categories[0] || ""),
    tags: [...new Set([...meta.categories.map(words), ...meta.synonyms, id])],
    author,
    license: "CC-BY-4.0",
    source_url: `https://reactome.org/content/detail/${id}`,
    description: meta.description,
    reactome_id: id,
    references: meta.refs.length ? meta.refs : undefined,
    in_library: !meta.skip,
  };
});
writeJson(path.join(OUT, "manifest.json"), entries);
writeJson(path.join(OUT, "pack.json"), {
  id: "reactome",
  name: "Reactome Icon Library",
  description: "Icons from Reactome's Enhanced High-Level Diagrams: proteins, receptors, compounds, cells, organelles and tissues",
  url: "https://reactome.org/icon-lib",
  credit: "Reactome Icon Library (reactome.org/icon-lib), licensed under CC BY 4.0",
});
if (failures.length) writeJson(path.join(OUT, "failures.json"), failures);
const cats = {};
for (const e of entries) cats[e.category || "(none)"] = (cats[e.category || "(none)"] || 0) + 1;
console.log(`Done: ${entries.length} icons (${entries.filter((e) => e.in_library).length} shown in the online library), ${failures.length} failed`);
console.log("  categories:", Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
