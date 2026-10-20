// Download Health Icons (https://healthicons.org, Resolve to Save Lives) into sources/healthicons/.
// Medical / public-health pictograms in filled and outline styles; licence recorded from the repo.
//
//   node tools/fetch-healthicons.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, download, pool, writeJson } from "./lib/net.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "sources", "healthicons");
const RAW = "https://raw.githubusercontent.com/resolvetosavelives/healthicons/main/";

const tree = await fetchJson("https://api.github.com/repos/resolvetosavelives/healthicons/git/trees/main?recursive=1");
const files = tree.tree.filter(
  (e) => e.type === "blob" && /^public\/icons\/svg\/(filled|outline)\/[^/]+\/[^/]+\.svg$/.test(e.path)
);
console.log(`Health Icons: ${files.length} SVG files`);
await download(RAW + "public/icons/meta-data.json", path.join(OUT, "meta-data.json"));
for (const f of ["LICENSE", "LICENSE.md", "README.md"]) {
  try { await download(RAW + f, path.join(OUT, f)); } catch {}
}
const manifest = [];
await pool(files, 12, async (f) => {
  const [, , , style, category, file] = f.path.split("/");
  const local = path.join(OUT, "svg", style, category, file);
  await download(RAW + f.path, local);
  manifest.push({ style, category, name: file.replace(/\.svg$/, ""), file: `svg/${style}/${category}/${file}` });
}, { label: "healthicons", every: 300 });
manifest.sort((a, b) => a.file.localeCompare(b.file));
writeJson(path.join(OUT, "manifest.json"), manifest);
console.log(`Done: ${manifest.length} icons`);
