// Tiny raster helpers for recognising pictures (no dependencies): a PNG decoder, a polygon
// rasteriser for the simplified paint lists of tools/pptx2svg.mjs, and coarse colour
// "signatures" that compare a drawing with a preview image regardless of their sizes.
import zlib from "node:zlib";

/** Decode a non-interlaced PNG (any colour type, 1–16 bit) → {w, h, data: RGBA bytes}. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8, w = 0, h = 0, depth = 8, ctype = 6, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (interlace) throw new Error("interlaced PNG");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = (w * channels * depth + 7) >> 3;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  const max = (1 << depth) - 1;
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1), f = raw[base];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = raw[base + 1 + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    const sample = (idx) => {
      if (depth === 8) return cur[idx];
      if (depth === 16) return cur[idx * 2];
      const bit = idx * depth, byte = cur[bit >> 3];
      return (byte >> (8 - depth - (bit & 7))) & max;
    };
    const to8 = (v) => (depth < 8 && ctype !== 3 ? Math.round((v * 255) / max) : v);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r, g, b, al = 255;
      if (ctype === 3) { const i = sample(x); r = palette[i * 3]; g = palette[i * 3 + 1]; b = palette[i * 3 + 2]; al = trns && i < trns.length ? trns[i] : 255; }
      else if (ctype === 0) { r = g = b = to8(sample(x)); }
      else if (ctype === 4) { r = g = b = sample(x * 2); al = sample(x * 2 + 1); }
      else if (ctype === 2) { r = sample(x * 3); g = sample(x * 3 + 1); b = sample(x * 3 + 2); }
      else { r = sample(x * 4); g = sample(x * 4 + 1); b = sample(x * 4 + 2); al = sample(x * 4 + 3); }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = al;
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

/** Coverage (0..1 per pixel, 2×2 samples) of polygons with the even-odd or non-zero rule. */
function coverage(polys, W, H, s, evenOdd) {
  const SS = 2, rows = H * SS;
  const xs = Array.from({ length: rows }, () => []);
  for (const p of polys) {
    const n = p.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let x0 = p[i * 2] * s, y0 = p[i * 2 + 1] * s, x1 = p[j * 2] * s, y1 = p[j * 2 + 1] * s;
      if (y0 === y1) continue;
      const dir = y1 > y0 ? 1 : -1;
      if (dir < 0) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
      // sub-scanline centres at (k + 0.5) / SS
      const k0 = Math.max(0, Math.ceil(y0 * SS - 0.5)), k1 = Math.min(rows - 1, Math.ceil(y1 * SS - 0.5) - 1);
      for (let k = k0; k <= k1; k++) {
        const y = (k + 0.5) / SS;
        xs[k].push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0), dir);
      }
    }
  }
  const cov = new Float32Array(W * H);
  const add = 1 / (SS * SS);
  for (let k = 0; k < rows; k++) {
    const row = xs[k];
    if (!row.length) continue;
    const pairs = [];
    for (let i = 0; i < row.length; i += 2) pairs.push([row[i], row[i + 1]]);
    pairs.sort((a, b) => a[0] - b[0]);
    const py = Math.floor(k / SS);
    let wind = 0;
    for (let i = 0; i < pairs.length - 1; i++) {
      wind += evenOdd ? 1 : pairs[i][1];
      const inside = evenOdd ? wind % 2 === 1 : wind !== 0;
      if (!inside) continue;
      const xa = pairs[i][0], xb = pairs[i + 1][0];
      // sample columns at (m + 0.5) / SS
      const m0 = Math.max(0, Math.ceil(xa * SS - 0.5)), m1 = Math.min(W * SS - 1, Math.ceil(xb * SS - 0.5) - 1);
      for (let m = m0; m <= m1; m++) cov[py * W + Math.floor(m / SS)] += add;
    }
  }
  return cov;
}

function strokePolys(polys, hw) {
  const out = [];
  for (const p of polys)
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i], y0 = p[i + 1], x1 = p[i + 2], y1 = p[i + 3];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (!len) continue;
      const nx = (-(y1 - y0) / len) * hw, ny = ((x1 - x0) / len) * hw;
      out.push([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny]);
    }
  return out;
}

/** Paint items [{polys (px), rgba (0..1), evenOdd, stroke?}] → RGBA image, long side `size` px. */
export function rasterizeSvgPaths(items, w, h, size) {
  const s = size / Math.max(w, h, 1e-6);
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const acc = new Float32Array(W * H * 4); // premultiplied
  for (const it of items) {
    const [r, g, b] = it.rgba;
    let a = it.rgba[3];
    if (a <= 0) continue;
    let cov;
    if (it.stroke) {
      // lines thinner than a pixel: one pixel wide, with the ink they would have
      const hw = it.stroke / 2, minHw = 0.5 / s;
      if (hw < minHw) a *= hw / minHw;
      cov = coverage(strokePolys(it.polys, Math.max(hw, minHw)), W, H, s, false);
    } else cov = coverage(it.polys, W, H, s, it.evenOdd);
    for (let i = 0; i < W * H; i++) {
      const c = Math.min(1, cov[i]) * a;
      if (!c) continue;
      const o = i * 4;
      acc[o] = r * c + acc[o] * (1 - c);
      acc[o + 1] = g * c + acc[o + 1] * (1 - c);
      acc[o + 2] = b * c + acc[o + 2] * (1 - c);
      acc[o + 3] = c + acc[o + 3] * (1 - c);
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = acc[i * 4 + 3];
    data[i * 4 + 3] = Math.round(a * 255);
    if (a > 0) for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round(Math.min(1, acc[i * 4 + k] / a) * 255);
  }
  return { w: W, h: H, data };
}

/** Coarse look of an image: n×n average colours over white of its non-white bounding box. */
export function signature(img, n = 20) {
  if (!img) return null;
  const { w, h, data } = img;
  const comp = new Float32Array(w * h * 3);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = data[i * 4 + 3] / 255;
      let ink = false;
      for (let k = 0; k < 3; k++) {
        const v = (data[i * 4 + k] / 255) * a + (1 - a);
        comp[i * 3 + k] = v;
        if (v < 0.94) ink = true;
      }
      if (ink) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, side = Math.max(bw, bh);
  const ox = (side - bw) / 2, oy = (side - bh) / 2;
  const sum = new Float32Array(n * n * 3), cnt = new Float32Array(n * n);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const cx = Math.min(n - 1, Math.floor(((x - x0 + ox + 0.5) / side) * n));
      const cy = Math.min(n - 1, Math.floor(((y - y0 + oy + 0.5) / side) * n));
      const c = cy * n + cx, i = y * w + x;
      cnt[c]++;
      for (let k = 0; k < 3; k++) sum[c * 3 + k] += comp[i * 3 + k];
    }
  const cells = new Float32Array(n * n * 3).fill(1);
  for (let c = 0; c < n * n; c++) if (cnt[c]) for (let k = 0; k < 3; k++) cells[c * 3 + k] = sum[c * 3 + k] / cnt[c];
  return { cells, aspect: bw / bh, n };
}

/**
 * 0 = identical; ~0.03 the same picture at another size; > 0.1 a different picture. Half of it is
 * measured over the inked cells only, so thin line art in another colour does not look alike
 * just because both are mostly white.
 */
export function sigDistance(a, b) {
  if (!a || !b || a.n !== b.n) return Infinity;
  let all = 0, inked = 0, cells = 0;
  for (let c = 0; c < a.n * a.n; c++) {
    let d = 0, ink = false;
    for (let k = 0; k < 3; k++) {
      const x = a.cells[c * 3 + k], y = b.cells[c * 3 + k];
      d += Math.abs(x - y);
      if (x < 0.96 || y < 0.96) ink = true;
    }
    all += d;
    if (ink) { inked += d; cells++; }
  }
  const global = all / a.cells.length, local = cells ? inked / (cells * 3) : 0;
  return 0.5 * global + 0.5 * local + 0.12 * Math.abs(Math.log(a.aspect / b.aspect));
}

/** The previous measure (whole-image mean), kept for comparison. */
export function sigDistanceGlobal(a, b) {
  if (!a || !b || a.n !== b.n) return Infinity;
  let s = 0;
  for (let i = 0; i < a.cells.length; i++) s += Math.abs(a.cells[i] - b.cells[i]);
  return s / a.cells.length + 0.12 * Math.abs(Math.log(a.aspect / b.aspect));
}

/** Encode RGBA bytes as a PNG (for debugging / contact sheets). */
export function encodePng({ w, h, data }) {
  const crcTable = encodePng.t || (encodePng.t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type, "latin1"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
