// Download every Bioicons SVG plus its metadata into sources/bioicons/.
// Bioicons: https://bioicons.com (Simon Dürr) — each icon keeps its author's licence
// (CC0, CC-BY 3.0/4.0, CC-BY-SA, MIT, BSD). Includes ~1,370 Servier Medical Art icons.
//
//   node tools/fetch-bioicons.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, download, pool, writeJson } from "./lib/net.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "sources", "bioicons");
const RAW = "https://raw.githubusercontent.com/duerrsimon/bioicons/main/";

const tree = await fetchJson(
  "https://api.github.com/repos/duerrsimon/bioicons/git/trees/main?recursive=1"
);
const files = tree.tree.filter(
  (e) => e.type === "blob" && e.path.startsWith("static/icons/") && e.path.endsWith(".svg")
);
console.log(`Bioicons: ${files.length} SVG files listed`);

for (const meta of ["icons.json", "authors.json", "categories.json"]) {
  await download(RAW + "static/icons/" + meta, path.join(OUT, meta));
}
for (const lic of ["bsd", "cc-0", "cc-by-3.0", "cc-by-4.0", "cc-by-sa-3.0", "cc-by-sa-4.0", "mit"]) {
  try {
    await download(RAW + `static/icons/${lic}/LICENSE`, path.join(OUT, "licenses", lic + ".txt"));
  } catch {}
}

const manifest = [];
await pool(
  files,
  12,
  async (f) => {
    const rel = f.path.slice("static/icons/".length); // license/category/author/name.svg
    const [license, category, author, ...rest] = rel.split("/");
    const name = rest.join("/").replace(/\.svg$/, "");
    const local = path.join(OUT, "svg", license, category, author, rest.join("/"));
    const url = RAW + f.path.split("/").map(encodeURIComponent).join("/");
    await download(url, local);
    manifest.push({ license, category, author, name, file: path.relative(OUT, local).split(path.sep).join("/"), size: f.size });
  },
  { label: "bioicons", every: 250 }
);
manifest.sort((a, b) => a.file.localeCompare(b.file));
writeJson(path.join(OUT, "manifest.json"), manifest);
console.log(`Done: ${manifest.length} icons in ${OUT}`);
