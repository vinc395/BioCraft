// Tile icon preview PNGs into one contact-sheet PNG (via VectorCraft) for quick visual review.
//   node tools/vc/sheet.mjs out.png a.png b.png …      (or a folder, optionally with a name filter)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { findCli } from "./client.mjs";

let [out, ...inputs] = process.argv.slice(2);
let files = [];
for (const i of inputs) {
  if (fs.existsSync(i) && fs.statSync(i).isDirectory()) files.push(...fs.readdirSync(i).filter((f) => f.endsWith(".png")).map((f) => path.join(i, f)));
  else if (fs.existsSync(i)) files.push(i);
  else {
    // "folder/*filter*" style: folder + substring
    const dir = path.dirname(i), sub = path.basename(i).replace(/\*/g, "");
    if (fs.existsSync(dir)) files.push(...fs.readdirSync(dir).filter((f) => f.endsWith(".png") && f.includes(sub)).map((f) => path.join(dir, f)));
  }
}
files.sort();
const cell = 150, cols = Math.min(6, files.length || 1), rows = Math.ceil(files.length / cols);
const outDir = path.dirname(path.resolve(out));
let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cols * cell}" height="${rows * (cell + 18)}"><rect width="100%" height="100%" fill="#ffffff"/>`;
files.forEach((f, i) => {
  const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + 18);
  const b64 = fs.readFileSync(f).toString("base64");
  svg += `<rect x="${x + 2}" y="${y + 2}" width="${cell - 4}" height="${cell + 14}" fill="none" stroke="#e3e7ec"/>`;
  svg += `<image x="${x + 8}" y="${y + 6}" width="${cell - 16}" height="${cell - 16}" xlink:href="data:image/png;base64,${b64}" preserveAspectRatio="xMidYMid meet"/>`;
  svg += `<text x="${x + cell / 2}" y="${y + cell + 8}" font-family="Arial" font-size="10" text-anchor="middle" fill="#444">${path.basename(f, ".png").slice(0, 26)}</text>`;
});
svg += "</svg>";
const tmp = path.join(outDir, "_sheet.svg");
fs.writeFileSync(tmp, svg);
execFileSync(findCli(), ["convert", tmp, path.resolve(out)], { stdio: "ignore" });
fs.unlinkSync(tmp);
console.log(`${files.length} previews → ${out}`);
