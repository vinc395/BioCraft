// Draw the BioCraft Originals with VectorCraft.
//
//   node originals/build.mjs                       every recipe file, both styles
//   node originals/build.mjs immune.mjs lab.mjs    only these recipe files
//   node originals/build.mjs --only t-cell,b-cell  only these icons
//   node originals/build.mjs --styles soft         one style
//   node originals/build.mjs --merge               combine per-recipe results into out/manifest.json + out/sheet.html
//
// Recipe files (originals/recipes/*.mjs) export `icons`: [{slug, name, category, tags, description?, scene()}]
// where scene() returns {size:[w,h], parts:[…]} (see lib/style.mjs).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VectorCraft } from "../tools/vc/client.mjs";
import { renderScene } from "./lib/style.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "out");
const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const only = opt("--only")?.split(",");
const styles = (opt("--styles") || "soft,line").split(",");

if (args.includes("--merge")) {
  merge();
  process.exit(0);
}

const files = args.length ? args : fs.readdirSync(path.join(here, "recipes")).filter((f) => f.endsWith(".mjs"));
for (const dir of ["svg", "preview", "meta"]) fs.mkdirSync(path.join(OUT, dir), { recursive: true });

const vc = await new VectorCraft({ root: OUT }).init();
let made = 0, failed = 0;
for (const file of files) {
  const mod = await import(pathToFileURL(path.join(here, "recipes", path.basename(file))).href + `?t=${Date.now()}`);
  const metaFile = path.join(OUT, "meta", path.basename(file, ".mjs") + ".json");
  const prev = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : [];
  const entries = new Map(prev.map((e) => [e.slug, e]));
  for (const icon of mod.icons) {
    if (only && !only.includes(icon.slug)) continue;
    for (const style of styles) {
      const slug = style === "soft" ? icon.slug : `${icon.slug}-line`;
      try {
        const scene = icon.scene(style);
        await renderScene(vc, scene, style);
        await vc.tool("export", { path: path.join(OUT, "svg", slug + ".svg"), options: { styling: "presentation", decimals: 2 } });
        await vc.tool("export", { path: path.join(OUT, "preview", slug + ".png"), options: { ppi: 72, background: "transparent" } });
        entries.set(slug, {
          slug,
          name: style === "soft" ? icon.name : `${icon.name} (line art)`,
          category: icon.category,
          tags: [...(icon.tags || []), style === "soft" ? "soft" : "line art", "outline"].filter((t, i, a) => style === "soft" ? t !== "outline" : true),
          description: icon.description || "",
          style,
          file: `svg/${slug}.svg`,
          recipe: path.basename(file),
          // line art is offered as a variant of the soft icon (one tile per subject in the library)
          ...(style === "soft" ? {} : { variant_of: icon.slug }),
        });
        made++;
        process.stdout.write(`  ✓ ${slug}\n`);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${slug}: ${e.message}\n${vc.stderr.slice(-400)}`);
      }
    }
  }
  fs.writeFileSync(metaFile, JSON.stringify([...entries.values()], null, 1));
}
vc.close();
console.log(`\n${made} drawn, ${failed} failed`);
merge();

function merge() {
  const metaDir = path.join(OUT, "meta");
  const all = fs.existsSync(metaDir)
    ? fs.readdirSync(metaDir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(fs.readFileSync(path.join(metaDir, f), "utf8")))
    : [];
  const live = all.filter((e) => fs.existsSync(path.join(OUT, e.file)));
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(live, null, 1));
  const cards = live
    .map((e) => `<figure title="${e.slug}"><img src="preview/${e.slug}.png"><figcaption>${e.name}</figcaption></figure>`)
    .join("\n");
  fs.writeFileSync(
    path.join(OUT, "sheet.html"),
    `<!doctype html><meta charset="utf-8"><title>BioCraft Originals</title><style>body{font:12px system-ui;margin:12px;background:#fff}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}figure{margin:0;border:1px solid #e3e7ec;border-radius:8px;padding:6px;text-align:center}img{width:110px;height:110px;object-fit:contain}figcaption{color:#555;font-size:11px}</style><h3>BioCanvas Originals — ${live.length} icons</h3><main>${cards}</main>`
  );
  console.log(`manifest: ${live.length} icons → ${path.join(OUT, "manifest.json")}`);
}
