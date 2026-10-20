// Render icons large for review, using a running `biocraft --serve <port>` (resvg).
//   node tools/vc/big.mjs <scale> <slug|file.svg> [...] [--sheet name] [--port 8791]
// Slugs are looked up in originals/out/svg/; any other argument ending in .svg is read as a path
// (e.g. a Servier reference drawing). Output: tools/vc/.big/<slug or sheet>.png — Read it to look.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const take = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const sheet = take("--sheet");
const port = take("--port") || "8791";
const scale = parseFloat(args.shift());
if (!(scale > 0) || !args.length) {
  console.error("usage: node tools/vc/big.mjs <scale> <slug|file.svg> [...] [--sheet name]");
  process.exit(1);
}
const OUT = path.join(here, ".big");
fs.mkdirSync(OUT, { recursive: true });
const SRC = path.resolve(here, "../../originals/out/svg");
const fileOf = (a) => (a.toLowerCase().endsWith(".svg") && fs.existsSync(a) ? a : path.join(SRC, a + ".svg"));
const nameOf = (a) => path.basename(a).replace(/\.svg$/i, "");

async function render(svg, name) {
  const r = await fetch(`http://127.0.0.1:${port}/api/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "png", svg, dpi: 96 * scale, name, background: "#ffffff" }),
  }).then((r) => r.json());
  if (!r.ok) throw new Error(r.error);
  const out = path.join(OUT, name + ".png");
  fs.writeFileSync(out, Buffer.from(r.result.base64, "base64"));
  console.log(out);
}
const inner = (s) => s.slice(s.indexOf(">", s.indexOf("<svg")) + 1, s.lastIndexOf("</svg>"));
const vbOf = (s) => {
  const vb = s.match(/viewBox="([^"]+)"/)?.[1];
  if (vb) return vb.trim().split(/[\s,]+/).map(Number);
  const w = parseFloat(s.match(/\bwidth="([\d.]+)/)?.[1] || "200"), h = parseFloat(s.match(/\bheight="([\d.]+)/)?.[1] || "200");
  return [0, 0, w, h];
};

if (!sheet) {
  for (const a of args) await render(fs.readFileSync(fileOf(a), "utf8"), nameOf(a));
} else {
  // a wrapped grid, each icon at its own size, with its slug under it
  let x = 0, y = 0, rowH = 0, W = 0, out = "";
  const maxW = 1500;
  for (const a of args) {
    const s = fs.readFileSync(fileOf(a), "utf8");
    const [vx, vy, vw, vh] = vbOf(s);
    if (x + vw > maxW && x > 0) {
      x = 0;
      y += rowH + 34;
      rowH = 0;
    }
    out += `<svg x="${x}" y="${y}" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}">${inner(s)}</svg>`;
    out += `<text x="${x}" y="${y + vh + 14}" font-family="Arial" font-size="11" fill="#555">${nameOf(a)}</text>`;
    x += vw + 24;
    rowH = Math.max(rowH, vh);
    W = Math.max(W, x);
  }
  const H = y + rowH + 20;
  await render(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out}</svg>`, sheet);
}
