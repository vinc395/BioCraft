// Pack PNGs into a macOS .icns (PNG-compressed entries).
//   node tools/make-icns.mjs out.icns icon-128.png icon-256.png icon-512.png icon-1024.png
import fs from "node:fs";

const TYPES = { 16: "icp4", 32: "icp5", 64: "icp6", 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10" };
const [out, ...pngs] = process.argv.slice(2);
const chunks = pngs.map((p) => {
  const data = fs.readFileSync(p);
  const w = data.readUInt32BE(16);
  const type = TYPES[w];
  if (!type) throw new Error(`${p}: ${w}px has no icns slot`);
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(chunks);
const head = Buffer.alloc(8);
head.write("icns", 0, "ascii");
head.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(out, Buffer.concat([head, body]));
console.log(`wrote ${out}`);
