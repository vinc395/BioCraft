// Pack PNG files into a Windows .ico (PNG-compressed entries, Vista+).
//   node tools/make-ico.mjs out.ico a-16.png a-32.png a-48.png a-256.png
import fs from "node:fs";

const [out, ...pngs] = process.argv.slice(2);
const images = pngs.map((p) => {
  const data = fs.readFileSync(p);
  // width/height live in the IHDR chunk at offsets 16 and 20
  return { data, w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
});
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map((img) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(img.w >= 256 ? 0 : img.w, 0);
  e.writeUInt8(img.h >= 256 ? 0 : img.h, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(img.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.data.length;
  return e;
});
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log(`wrote ${out} (${images.map((i) => i.w).join(", ")} px)`);
