// Render app/icons/icon.svg to every PNG size the installers need, then pack .ico and .icns.
// Uses a running `biocraft --serve <port>` (resvg) for rasterising:
//   node tools/make-icons.mjs [port]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const port = process.argv[2] || "8791";
const dir = path.resolve("app/icons");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const render = async (px, file) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "png", svg, dpi: (96 * px) / 512, name: "icon" }),
  }).then((r) => r.json());
  if (!r.ok) throw new Error(r.error);
  fs.writeFileSync(path.join(dir, file), Buffer.from(r.result.base64, "base64"));
};
for (const px of [16, 32, 48, 64, 128, 256, 512, 1024]) await render(px, `icon-${px}.png`);
fs.copyFileSync(path.join(dir, "icon-32.png"), path.join(dir, "32x32.png"));
fs.copyFileSync(path.join(dir, "icon-128.png"), path.join(dir, "128x128.png"));
fs.copyFileSync(path.join(dir, "icon-256.png"), path.join(dir, "128x128@2x.png"));
fs.copyFileSync(path.join(dir, "icon-512.png"), path.join(dir, "icon.png"));
fs.copyFileSync(path.join(dir, "icon-64.png"), path.resolve("ui/favicon.png"));
const ico = ["16", "32", "48", "256"].map((s) => path.join(dir, `icon-${s}.png`));
execFileSync(process.execPath, ["tools/make-ico.mjs", path.join(dir, "icon.ico"), ...ico], { stdio: "inherit" });
const icns = ["128", "256", "512", "1024"].map((s) => path.join(dir, `icon-${s}.png`));
execFileSync(process.execPath, ["tools/make-icns.mjs", path.join(dir, "icon.icns"), ...icns], { stdio: "inherit" });
