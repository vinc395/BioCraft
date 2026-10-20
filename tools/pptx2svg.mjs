// PowerPoint (.pptx) drawings → standalone SVG files. No dependencies (Node 18+).
//
// Every top-level drawing on a slide (a group, or a shape that is not a text box or a title)
// becomes one SVG: DrawingML custom geometry (moveTo/lnTo/cubicBezTo/quadBezTo/arcTo/close,
// shape guides), common preset shapes, group transforms (off/ext/chOff/chExt, rot, flipH/flipV),
// solid and gradient fills (srgbClr/schemeClr/sysClr/prstClr with lumMod/lumOff/tint/shade/
// satMod/alpha…, theme colours from the slide master's theme), outlines (width, dash, caps,
// joins, arrow heads) and embedded PNG/JPEG pictures. Text, shadows/glows and EMF pictures are
// dropped. Coordinates are written in px (1 px = 9525 EMU).
//
//   node tools/pptx2svg.mjs kit.pptx out-dir [--slides 3,4]     → out-dir/s<slide>-<n>.svg + drawings.json
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- zip ----------------------------

/** Minimal ZIP reader: returns Map(name → () => Buffer). */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  let count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    // zip64 end of central directory locator just before the EOCD
    const loc = eocd - 20;
    if (buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOff = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const files = new Map();
  let p = cdOff;
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    let lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    // zip64 extra field
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = buf.readUInt16LE(x), sz = buf.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (lho === 0xffffffff) { lho = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      x += 4 + sz;
    }
    p = xend + clen;
    const off = lho;
    files.set(name, () => {
      const ln = buf.readUInt16LE(off + 26), lx = buf.readUInt16LE(off + 28);
      const start = off + 30 + ln + lx;
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`zip method ${method} not supported (${name})`);
    });
  }
  return files;
}

// ---------------------------------------------------------------- xml ----------------------------

const XML_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s) =>
  s.indexOf("&") < 0
    ? s
    : s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) =>
        e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENT[e] ?? m);

/** Small non-validating XML parser → {n: name, a: attrs, c: children, t: text}. */
export function parseXml(s) {
  const root = { n: "#root", a: {}, c: [] };
  const stack = [root];
  const tagRe = /<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const top = stack[stack.length - 1];
      if (top.n === "a:t") top.t = (top.t || "") + unxml(s.slice(i, lt));
    }
    const c = s.charCodeAt(lt + 1);
    if (c === 47) { // </
      stack.length > 1 && stack.pop();
      i = s.indexOf(">", lt) + 1;
      continue;
    }
    if (c === 63) { i = s.indexOf("?>", lt) + 2; continue; }
    if (c === 33) {
      if (s.startsWith("<!--", lt)) { i = s.indexOf("-->", lt) + 3; continue; }
      if (s.startsWith("<![CDATA[", lt)) {
        const e = s.indexOf("]]>", lt);
        const top = stack[stack.length - 1];
        if (top.n === "a:t") top.t = (top.t || "") + s.slice(lt + 9, e);
        i = e + 3;
        continue;
      }
      i = s.indexOf(">", lt) + 1;
      continue;
    }
    tagRe.lastIndex = lt;
    const m = tagRe.exec(s);
    if (!m) { i = lt + 1; continue; }
    const node = { n: m[1], a: {}, c: [] };
    if (m[2]) {
      attRe.lastIndex = 0;
      let am;
      while ((am = attRe.exec(m[2]))) node.a[am[1]] = unxml(am[2] ?? am[3]);
    }
    stack[stack.length - 1].c.push(node);
    if (!m[3]) stack.push(node);
    i = tagRe.lastIndex;
  }
  return root;
}

const kid = (node, name) => node?.c.find((x) => x.n === name) || null;
const kids = (node, name) => (node ? node.c.filter((x) => x.n === name) : []);
const path1 = (node, ...names) => names.reduce((n, k) => kid(n, k), node);
function* walk(node) {
  yield node;
  for (const c of node.c) yield* walk(c);
}
const textOf = (node) => {
  let t = "";
  for (const x of walk(node)) if (x.n === "a:t" && x.t) t += x.t;
    else if (x.n === "a:p" && t && !t.endsWith(" ")) t += " ";
    else if (x.n === "a:br") t += " ";
  return t.replace(/\s+/g, " ").trim();
};

// ---------------------------------------------------------------- colour -------------------------

const PRESET_COLORS = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", cyan: "00FFFF", magenta: "FF00FF", gray: "808080", grey: "808080", darkGray: "A9A9A9", lightGray: "D3D3D3", orange: "FFA500", purple: "800080", brown: "A52A2A", pink: "FFC0CB", navy: "000080", maroon: "800000", olive: "808000", teal: "008080", silver: "C0C0C0", lime: "00FF00", gold: "FFD700", darkRed: "8B0000", darkBlue: "00008B", darkGreen: "006400", ltGray: "D3D3D3", dkGray: "A9A9A9" };

const hexToRgb = (h) => [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const toLin = (c) => Math.pow(c, 2.3);
const fromLin = (c) => Math.pow(clamp01(c), 1 / 2.3);

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const COLOR_TAGS = new Set(["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr", "a:scrgbClr", "a:hslClr"]);
const colorNode = (n) => n?.c.find((x) => COLOR_TAGS.has(x.n)) || null;

/** Resolve a colour element to {rgb:[0..1]x3, a}. `ctx.phClr` is the style placeholder colour. */
function resolveColor(node, ctx) {
  if (!node) return null;
  let rgb, a = 1;
  const v = node.a.val;
  switch (node.n) {
    case "a:srgbClr": rgb = hexToRgb(v || "000000"); break;
    case "a:sysClr": rgb = hexToRgb(node.a.lastClr || (v === "window" ? "FFFFFF" : "000000")); break;
    case "a:prstClr": rgb = hexToRgb(PRESET_COLORS[v] || "000000"); break;
    case "a:scrgbClr": rgb = [+node.a.r, +node.a.g, +node.a.b].map((x) => fromLin(x / 100000)); break;
    case "a:hslClr": rgb = hslToRgb([+node.a.hue / 21600000, +node.a.sat / 100000, +node.a.lum / 100000]); break;
    case "a:schemeClr": {
      if (v === "phClr") {
        if (!ctx.phClr) { rgb = [0, 0, 0]; break; }
        rgb = ctx.phClr.rgb.slice();
        a = ctx.phClr.a;
      } else {
        const key = ctx.theme.clrMap[v] || v;
        rgb = hexToRgb(ctx.theme.colors[key] || "000000");
      }
      break;
    }
    default: return null;
  }
  // modifiers, in document order
  for (const m of node.c) {
    const val = +m.a.val / 100000;
    switch (m.n) {
      case "a:alpha": a *= val; break;
      case "a:alphaMod": a *= val; break;
      case "a:alphaOff": a = clamp01(a + val); break;
      case "a:lumMod": { const hsl = rgbToHsl(rgb); hsl[2] = clamp01(hsl[2] * val); rgb = hslToRgb(hsl); break; }
      case "a:lumOff": { const hsl = rgbToHsl(rgb); hsl[2] = clamp01(hsl[2] + val); rgb = hslToRgb(hsl); break; }
      case "a:lum": { const hsl = rgbToHsl(rgb); hsl[2] = clamp01(val); rgb = hslToRgb(hsl); break; }
      case "a:satMod": { const hsl = rgbToHsl(rgb); hsl[1] = clamp01(hsl[1] * val); rgb = hslToRgb(hsl); break; }
      case "a:satOff": { const hsl = rgbToHsl(rgb); hsl[1] = clamp01(hsl[1] + val); rgb = hslToRgb(hsl); break; }
      case "a:sat": { const hsl = rgbToHsl(rgb); hsl[1] = clamp01(val); rgb = hslToRgb(hsl); break; }
      case "a:hueMod": { const hsl = rgbToHsl(rgb); hsl[0] = (hsl[0] * val) % 1; rgb = hslToRgb(hsl); break; }
      case "a:hueOff": { const hsl = rgbToHsl(rgb); hsl[0] = (((hsl[0] + +m.a.val / 21600000) % 1) + 1) % 1; rgb = hslToRgb(hsl); break; }
      case "a:hue": { const hsl = rgbToHsl(rgb); hsl[0] = +m.a.val / 21600000; rgb = hslToRgb(hsl); break; }
      case "a:tint": rgb = rgb.map((c) => fromLin(1 - (1 - toLin(c)) * val)); break;
      case "a:shade": rgb = rgb.map((c) => fromLin(toLin(c) * val)); break;
      case "a:comp": { const hsl = rgbToHsl(rgb); hsl[0] = (hsl[0] + 0.5) % 1; rgb = hslToRgb(hsl); break; }
      case "a:inv": rgb = rgb.map((c) => 1 - c); break;
      case "a:gray": { const y = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; rgb = [y, y, y]; break; }
      case "a:red": rgb[0] = clamp01(val); break;
      case "a:green": rgb[1] = clamp01(val); break;
      case "a:blue": rgb[2] = clamp01(val); break;
      case "a:redMod": rgb[0] = clamp01(rgb[0] * val); break;
      case "a:greenMod": rgb[1] = clamp01(rgb[1] * val); break;
      case "a:blueMod": rgb[2] = clamp01(rgb[2] * val); break;
      default: break;
    }
  }
  return { rgb: rgb.map(clamp01), a: clamp01(a) };
}

const hex2 = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
const cssColor = (c) => "#" + c.rgb.map(hex2).join("");
/** lighten/darken modifiers of preset sub-paths */
function shadeColor(c, mode) {
  if (!c || !mode || mode === "norm") return c;
  const f = { lighten: 0.4, lightenLess: 0.2, darken: -0.4, darkenLess: -0.2 }[mode] ?? 0;
  const rgb = c.rgb.map((v) => (f > 0 ? v + (1 - v) * f : v * (1 + f)));
  return { rgb, a: c.a };
}

// ---------------------------------------------------------------- theme --------------------------

function loadTheme(files, masterPath) {
  const theme = { colors: {}, clrMap: {}, fills: [], lines: [], fonts: {} };
  let themePath = "ppt/theme/theme1.xml";
  const rels = readRels(files, masterPath);
  for (const r of Object.values(rels)) if (/theme$/.test(r.type)) themePath = r.target;
  const read = (p) => (files.has(p) ? parseXml(files.get(p)().toString("utf8")) : null);
  const t = read(themePath);
  const scheme = t && [...walk(t)].find((x) => x.n === "a:clrScheme");
  if (scheme)
    for (const c of scheme.c) {
      const cn = colorNode(c);
      const key = c.n.slice(2);
      theme.colors[key] = cn?.n === "a:sysClr" ? cn.a.lastClr || (cn.a.val === "window" ? "FFFFFF" : "000000") : cn?.a.val || "000000";
    }
  const fmt = t && [...walk(t)].find((x) => x.n === "a:fmtScheme");
  if (fmt) {
    theme.fills = kid(fmt, "a:fillStyleLst")?.c || [];
    theme.lines = kid(fmt, "a:lnStyleLst")?.c || [];
  }
  const m = read(masterPath);
  const map = m && [...walk(m)].find((x) => x.n === "p:clrMap");
  theme.clrMap = map ? { ...map.a } : { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
  return theme;
}

function readRels(files, partPath) {
  const dir = path.posix.dirname(partPath), base = path.posix.basename(partPath);
  const relPath = `${dir}/_rels/${base}.rels`;
  const out = {};
  if (!files.has(relPath)) return out;
  const x = parseXml(files.get(relPath)().toString("utf8"));
  for (const r of walk(x))
    if (r.n === "Relationship") {
      const target = r.a.TargetMode === "External" ? r.a.Target : path.posix.normalize(path.posix.join(dir, r.a.Target));
      out[r.a.Id] = { type: r.a.Type || "", target, external: r.a.TargetMode === "External" };
    }
  return out;
}

// ---------------------------------------------------------------- matrices -----------------------

const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function rotFlip(cx, cy, rot, fh, fv) {
  if (!rot && !fh && !fv) return I;
  const t = (rot / 60000) * (Math.PI / 180), c = Math.cos(t), s = Math.sin(t);
  const sx = fh ? -1 : 1, sy = fv ? -1 : 1;
  // T(c) · R · F · T(-c)
  const r = [c * sx, s * sx, -s * sy, c * sy, 0, 0];
  r[4] = cx - (r[0] * cx + r[2] * cy);
  r[5] = cy - (r[1] * cx + r[3] * cy);
  return r;
}

function readXfrm(x) {
  if (!x) return null;
  const off = kid(x, "a:off"), ext = kid(x, "a:ext"), cho = kid(x, "a:chOff"), che = kid(x, "a:chExt");
  return {
    x: +(off?.a.x || 0), y: +(off?.a.y || 0), w: +(ext?.a.cx || 0), h: +(ext?.a.cy || 0),
    chx: cho ? +cho.a.x : null, chy: cho ? +cho.a.y : null, chw: che ? +che.a.cx : null, chh: che ? +che.a.cy : null,
    rot: +(x.a.rot || 0), fh: x.a.flipH === "1" || x.a.flipH === "true", fv: x.a.flipV === "1" || x.a.flipV === "true",
  };
}

function groupMatrix(xf) {
  if (!xf) return I;
  const chx = xf.chx ?? xf.x, chy = xf.chy ?? xf.y, chw = xf.chw ?? xf.w, chh = xf.chh ?? xf.h;
  const sx = chw ? xf.w / chw : 1, sy = chh ? xf.h / chh : 1;
  const m = [sx, 0, 0, sy, xf.x - chx * sx, xf.y - chy * sy];
  return mul(rotFlip(xf.x + xf.w / 2, xf.y + xf.h / 2, xf.rot, xf.fh, xf.fv), m);
}
const shapeMatrix = (xf) => mul(rotFlip(xf.x + xf.w / 2, xf.y + xf.h / 2, xf.rot, xf.fh, xf.fv), [1, 0, 0, 1, xf.x, xf.y]);

// ---------------------------------------------------------------- geometry -----------------------

const ANG = 60000; // 1 degree
const rad = (a) => (a / ANG) * (Math.PI / 180);

/** Evaluate DrawingML shape guides (avLst + gdLst) into a variable table. */
function guideVars(w, h, avDefaults, avNode, gdNode) {
  const v = Object.create(null);
  Object.assign(v, {
    w, h, l: 0, t: 0, r: w, b: h, hc: w / 2, vc: h / 2, wd2: w / 2, hd2: h / 2, wd3: w / 3, hd3: h / 3, wd4: w / 4, hd4: h / 4,
    wd5: w / 5, hd5: h / 5, wd6: w / 6, hd6: h / 6, wd8: w / 8, hd8: h / 8, wd10: w / 10, hd10: h / 10, wd12: w / 12, wd32: w / 32,
    ss: Math.min(w, h), ls: Math.max(w, h), cd2: 10800000, cd4: 5400000, cd8: 2700000, "3cd4": 16200000, "3cd8": 8100000,
    "5cd8": 13500000, "7cd8": 18900000,
  });
  for (const k of ["ssd2", "ssd4", "ssd6", "ssd8", "ssd16", "ssd32"]) v[k] = v.ss / +k.slice(3);
  Object.assign(v, avDefaults || {});
  const evalGd = (gd) => {
    const f = (gd.a.fmla || "").trim().split(/\s+/);
    const x = (i) => { const t = f[i]; if (t == null) return 0; const n = Number(t); return Number.isFinite(n) ? n : v[t] ?? 0; };
    let r;
    switch (f[0]) {
      case "val": r = x(1); break;
      case "*/": r = x(3) ? (x(1) * x(2)) / x(3) : 0; break;
      case "+-": r = x(1) + x(2) - x(3); break;
      case "+/": r = x(3) ? (x(1) + x(2)) / x(3) : 0; break;
      case "?:": r = x(1) > 0 ? x(2) : x(3); break;
      case "abs": r = Math.abs(x(1)); break;
      case "at2": r = (Math.atan2(x(2), x(1)) * 180 / Math.PI) * ANG; break;
      case "cat2": r = x(1) * Math.cos(Math.atan2(x(3), x(2))); break;
      case "sat2": r = x(1) * Math.sin(Math.atan2(x(3), x(2))); break;
      case "cos": r = x(1) * Math.cos(rad(x(2))); break;
      case "sin": r = x(1) * Math.sin(rad(x(2))); break;
      case "tan": r = x(1) * Math.tan(rad(x(2))); break;
      case "max": r = Math.max(x(1), x(2)); break;
      case "min": r = Math.min(x(1), x(2)); break;
      case "mod": r = Math.sqrt(x(1) ** 2 + x(2) ** 2 + x(3) ** 2); break;
      case "pin": r = x(2) < x(1) ? x(1) : x(2) > x(3) ? x(3) : x(2); break;
      case "sqrt": r = Math.sqrt(Math.max(0, x(1))); break;
      default: r = 0;
    }
    v[gd.a.name] = r;
  };
  for (const gd of kids(avNode, "a:gd")) evalGd(gd);
  for (const gd of kids(gdNode, "a:gd")) evalGd(gd);
  return v;
}

/** Append an elliptical arc (DrawingML arcTo: visual start angle + sweep) as cubic Béziers. */
function arcTo(cmds, cur, wR, hR, stAng, swAng) {
  if (!wR || !hR) return cur;
  const ts = rad(stAng), sw = rad(swAng), TAU = 2 * Math.PI;
  if (!sw) return cur;
  // angles are "visual" (polar) angles; the ellipse is drawn with parametric ones
  const ps = Math.atan2(wR * Math.sin(ts), hR * Math.cos(ts));
  const te = ts + sw;
  const pe = Math.atan2(wR * Math.sin(te), hR * Math.cos(te));
  let d = pe - ps; // (-2π, 2π)
  if (sw > 0) { if (d < -1e-9) d += TAU; else if (d < 0) d = 0; if (d < 1e-9 && sw > Math.PI) d = TAU; }
  else { if (d > 1e-9) d -= TAU; else if (d > 0) d = 0; if (d > -1e-9 && sw < -Math.PI) d = -TAU; }
  d += Math.sign(sw) * TAU * Math.floor((Math.abs(sw) - 1e-9) / TAU);
  if (!d) return cur;
  const cx = cur[0] - wR * Math.cos(ps), cy = cur[1] - hR * Math.sin(ps);
  const n = Math.max(1, Math.ceil(Math.abs(d) / (Math.PI / 2) - 1e-9));
  const step = d / n, k = (4 / 3) * Math.tan(step / 4);
  let a = ps;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const x0 = cx + wR * Math.cos(a), y0 = cy + hR * Math.sin(a);
    const x3 = cx + wR * Math.cos(b), y3 = cy + hR * Math.sin(b);
    cmds.push(["C", x0 - k * wR * Math.sin(a), y0 + k * hR * Math.cos(a), x3 + k * wR * Math.sin(b), y3 - k * hR * Math.cos(b), x3, y3]);
    a = b;
  }
  return [cx + wR * Math.cos(a), cy + hR * Math.sin(a)];
}

/** custGeom → [{cmds, fill, stroke}] in shape-local coordinates (0..w, 0..h). */
function customGeometry(geom, w, h) {
  const v = guideVars(w, h, null, kid(geom, "a:avLst"), kid(geom, "a:gdLst"));
  const num = (t) => { const n = Number(t); return Number.isFinite(n) ? n : v[t] ?? 0; };
  const out = [];
  for (const p of kids(kid(geom, "a:pathLst"), "a:path")) {
    const pw = +(p.a.w || 0), ph = +(p.a.h || 0);
    const sx = pw ? w / pw : 1, sy = ph ? h / ph : 1;
    const pt = (n) => [num(n.a.x) * sx, num(n.a.y) * sy];
    const cmds = [];
    let cur = [0, 0], start = [0, 0];
    for (const c of p.c) {
      const pts = kids(c, "a:pt");
      switch (c.n) {
        case "a:moveTo": cur = start = pt(pts[0]); cmds.push(["M", ...cur]); break;
        case "a:lnTo": cur = pt(pts[0]); cmds.push(["L", ...cur]); break;
        case "a:cubicBezTo": { const [a, b, d] = pts.map(pt); if (!d) break; cmds.push(["C", ...a, ...b, ...d]); cur = d; break; }
        case "a:quadBezTo": { const [a, b] = pts.map(pt); if (!b) break; cmds.push(["Q", ...a, ...b]); cur = b; break; }
        case "a:arcTo":
          cur = arcTo(cmds, cur, num(c.a.wR) * sx, num(c.a.hR) * sy, num(c.a.stAng), num(c.a.swAng));
          break;
        case "a:close": cmds.push(["Z"]); cur = start; break;
      }
    }
    if (cmds.length) out.push({ cmds, fill: p.a.fill || "norm", stroke: !(p.a.stroke === "0" || p.a.stroke === "false") });
  }
  return out;
}

// preset shapes: path builders over guide variables (subset of presetShapeDefinitions.xml)
function ellipseCmds(cx, cy, rx, ry, reverse = false) {
  const cmds = [["M", cx + rx, cy]];
  arcTo(cmds, [cx + rx, cy], rx, ry, 0, reverse ? -21600000 : 21600000);
  cmds.push(["Z"]);
  return cmds;
}
const poly = (pts, close = true) => {
  const c = pts.map((p, i) => [i ? "L" : "M", p[0], p[1]]);
  if (close) c.push(["Z"]);
  return c;
};
function roundRectCmds(w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return poly([[0, 0], [w, 0], [w, h], [0, h]]);
  const c = [["M", 0, r]];
  let cur = [0, r];
  cur = arcTo(c, cur, r, r, 10800000, 5400000); c.push(["L", w - r, 0]); cur = [w - r, 0];
  cur = arcTo(c, cur, r, r, 16200000, 5400000); c.push(["L", w, h - r]); cur = [w, h - r];
  cur = arcTo(c, cur, r, r, 0, 5400000); c.push(["L", r, h]); cur = [r, h];
  arcTo(c, cur, r, r, 5400000, 5400000); c.push(["Z"]);
  return c;
}
/** start point on the ellipse (visual angle), as the preset definitions compute it */
function ellPt(cx, cy, rx, ry, ang) {
  const t = rad(ang);
  const p = Math.atan2(rx * Math.sin(t), ry * Math.cos(t));
  return [cx + rx * Math.cos(p), cy + ry * Math.sin(p)];
}

const PRESETS = {
  rect: (w, h) => [{ cmds: poly([[0, 0], [w, 0], [w, h], [0, h]]) }],
  flowChartProcess: (w, h) => PRESETS.rect(w, h),
  roundRect: (w, h, a) => [{ cmds: roundRectCmds(w, h, (Math.min(w, h) * (a.adj ?? 16667)) / 100000) }],
  flowChartAlternateProcess: (w, h) => [{ cmds: roundRectCmds(w, h, Math.min(w, h) / 6) }],
  flowChartTerminator: (w, h) => [{ cmds: roundRectCmds(w, h, Math.min(w / 2, h / 2)) }],
  ellipse: (w, h) => [{ cmds: ellipseCmds(w / 2, h / 2, w / 2, h / 2) }],
  flowChartConnector: (w, h) => PRESETS.ellipse(w, h),
  line: (w, h) => [{ cmds: [["M", 0, 0], ["L", w, h]], fill: "none" }],
  straightConnector1: (w, h) => PRESETS.line(w, h),
  bentConnector2: (w, h) => [{ cmds: [["M", 0, 0], ["L", w, 0], ["L", w, h]], fill: "none" }],
  bentConnector3: (w, h, a) => { const x1 = (w * (a.adj1 ?? 50000)) / 100000; return [{ cmds: [["M", 0, 0], ["L", x1, 0], ["L", x1, h], ["L", w, h]], fill: "none" }]; },
  curvedConnector3: (w, h, a) => {
    const x2 = (w * (a.adj1 ?? 50000)) / 100000, x1 = x2 / 2, x3 = (w + x2) / 2;
    return [{ cmds: [["M", 0, 0], ["C", x1, 0, x2, h / 4, x2, h / 2], ["C", x2, (3 * h) / 4, x3, h, w, h]], fill: "none" }];
  },
  triangle: (w, h, a) => [{ cmds: poly([[0, h], [(w * (a.adj ?? 50000)) / 100000, 0], [w, h]]) }],
  flowChartExtract: (w, h) => [{ cmds: poly([[0, h], [w / 2, 0], [w, h]]) }],
  flowChartMerge: (w, h) => [{ cmds: poly([[0, 0], [w, 0], [w / 2, h]]) }],
  rtTriangle: (w, h) => [{ cmds: poly([[0, 0], [w, h], [0, h]]) }],
  diamond: (w, h) => [{ cmds: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) }],
  flowChartDecision: (w, h) => PRESETS.diamond(w, h),
  parallelogram: (w, h, a) => { const x = (Math.min(w, h) * (a.adj ?? 25000)) / 100000; return [{ cmds: poly([[0, h], [x, 0], [w, 0], [w - x, h]]) }]; },
  flowChartInputOutput: (w, h) => [{ cmds: poly([[0, h], [w / 5, 0], [w, 0], [(4 * w) / 5, h]]) }],
  trapezoid: (w, h, a) => { const x = (Math.min(w, h) * (a.adj ?? 25000)) / 100000; return [{ cmds: poly([[0, h], [x, 0], [w - x, 0], [w, h]]) }]; },
  pentagon: (w, h) => {
    const swd2 = (w / 2) * 1.05146, shd2 = (h / 2) * 1.10557, svc = (h / 2) * 1.10557;
    const dx1 = swd2 * Math.cos(rad(1080000)), dx2 = swd2 * Math.cos(rad(18360000));
    const dy1 = shd2 * Math.sin(rad(1080000)), dy2 = shd2 * Math.sin(rad(18360000));
    return [{ cmds: poly([[w / 2 - dx1, svc - dy1], [w / 2, 0], [w / 2 + dx1, svc - dy1], [w / 2 + dx2, svc - dy2], [w / 2 - dx2, svc - dy2]]) }];
  },
  hexagon: (w, h, a) => {
    const ss = Math.min(w, h), maxAdj = (50000 * w) / ss, aa = Math.max(0, Math.min(a.adj ?? 25000, maxAdj));
    const x1 = (ss * aa) / 100000, dy1 = (h / 2) * 1.1547 * Math.sin(Math.PI / 3);
    return [{ cmds: poly([[0, h / 2], [x1, h / 2 - dy1], [w - x1, h / 2 - dy1], [w, h / 2], [w - x1, h / 2 + dy1], [x1, h / 2 + dy1]]) }];
  },
  octagon: (w, h, a) => {
    const x1 = (Math.min(w, h) * (a.adj ?? 29289)) / 100000;
    return [{ cmds: poly([[0, x1], [x1, 0], [w - x1, 0], [w, x1], [w, h - x1], [w - x1, h], [x1, h], [0, h - x1]]) }];
  },
  plus: (w, h, a) => {
    const x1 = (Math.min(w, h) * (a.adj ?? 25000)) / 100000, x2 = w - x1, y2 = h - x1;
    return [{ cmds: poly([[0, x1], [x1, x1], [x1, 0], [x2, 0], [x2, x1], [w, x1], [w, y2], [x2, y2], [x2, h], [x1, h], [x1, y2], [0, y2]]) }];
  },
  donut: (w, h, a) => {
    const dr = (Math.min(w, h) * (a.adj ?? 25000)) / 100000;
    return [{ cmds: [...ellipseCmds(w / 2, h / 2, w / 2, h / 2), ...ellipseCmds(w / 2, h / 2, w / 2 - dr, h / 2 - dr, true)] }];
  },
  noSmoking: (w, h, a) => PRESETS.donut(w, h, a),
  star4: (w, h, a) => starCmds(w, h, 4, (a.adj ?? 12500) / 50000),
  star5: (w, h, a) => starCmds(w, h, 5, (a.adj ?? 19098) / 50000, 1.05146, 1.10557),
  star6: (w, h, a) => starCmds(w, h, 6, (a.adj ?? 28868) / 50000, 1.1547, 1),
  star7: (w, h, a) => starCmds(w, h, 7, (a.adj ?? 34601) / 50000, 1.02572, 1.05210),
  star8: (w, h, a) => starCmds(w, h, 8, (a.adj ?? 38250) / 50000),
  star10: (w, h, a) => starCmds(w, h, 10, (a.adj ?? 42533) / 50000, 1.05146, 1),
  star12: (w, h, a) => starCmds(w, h, 12, (a.adj ?? 37500) / 50000),
  star16: (w, h, a) => starCmds(w, h, 16, (a.adj ?? 37500) / 50000),
  star24: (w, h, a) => starCmds(w, h, 24, (a.adj ?? 37500) / 50000),
  star32: (w, h, a) => starCmds(w, h, 32, (a.adj ?? 37500) / 50000),
  rightArrow: (w, h, a) => arrowCmds(w, h, a, false),
  leftArrow: (w, h, a) => mirrorX(arrowCmds(w, h, a, false), w),
  downArrow: (w, h, a) => swapXY(arrowCmds(h, w, a, false)),
  upArrow: (w, h, a) => mirrorY(swapXY(arrowCmds(h, w, a, false)), h),
  leftRightArrow: (w, h, a) => {
    const ss = Math.min(w, h), a1 = Math.min(a.adj1 ?? 50000, 100000), a2 = Math.min(a.adj2 ?? 50000, (50000 * w) / ss);
    const x2 = (ss * a2) / 100000, x3 = w - x2, dy = (h * a1) / 200000, y1 = h / 2 - dy, y2 = h / 2 + dy;
    return [{ cmds: poly([[0, h / 2], [x2, 0], [x2, y1], [x3, y1], [x3, 0], [w, h / 2], [x3, h], [x3, y2], [x2, y2], [x2, h]]) }];
  },
  upDownArrow: (w, h, a) => swapXY(PRESETS.leftRightArrow(h, w, a)),
  notchedRightArrow: (w, h, a) => {
    const ss = Math.min(w, h), a1 = a.adj1 ?? 50000, a2 = a.adj2 ?? 50000;
    const dx2 = (ss * a2) / 100000, x2 = w - dx2, dy1 = (h * a1) / 200000, y1 = h / 2 - dy1, y2 = h / 2 + dy1, x1 = (dy1 * dx2) / (h / 2);
    return [{ cmds: poly([[0, y1], [x2, y1], [x2, 0], [w, h / 2], [x2, h], [x2, y2], [0, y2], [x1, h / 2]]) }];
  },
  chevron: (w, h, a) => {
    const ss = Math.min(w, h), x1 = (ss * Math.min(a.adj ?? 50000, (100000 * w) / ss)) / 100000, x2 = w - x1;
    return [{ cmds: poly([[0, 0], [x2, 0], [w, h / 2], [x2, h], [0, h], [x1, h / 2]]) }];
  },
  homePlate: (w, h, a) => {
    const ss = Math.min(w, h), x1 = w - (ss * Math.min(a.adj ?? 50000, (100000 * w) / ss)) / 100000;
    return [{ cmds: poly([[0, 0], [x1, 0], [w, h / 2], [x1, h], [0, h]]) }];
  },
  can: (w, h, a) => {
    const ss = Math.min(w, h), y1 = (ss * Math.min(a.adj ?? 25000, (50000 * h) / ss)) / 200000;
    const body = [["M", 0, y1], ["L", 0, h - y1]];
    arcTo(body, [0, h - y1], w / 2, y1, 10800000, -10800000);
    body.push(["L", w, y1]);
    arcTo(body, [w, y1], w / 2, y1, 0, 10800000);
    body.push(["Z"]);
    return [{ cmds: body }, { cmds: ellipseCmds(w / 2, y1, w / 2, y1), fill: "lighten" }];
  },
  flowChartMagneticDisk: (w, h) => PRESETS.can(w, h, { adj: (50000 * h) / Math.min(w, h) / 3 }),
  cube: (w, h, a) => {
    const y1 = (Math.min(w, h) * (a.adj ?? 25000)) / 100000, x4 = w - y1, y4 = h - y1;
    return [
      { cmds: poly([[0, y1], [x4, y1], [x4, h], [0, h]]) },
      { cmds: poly([[x4, y1], [w, 0], [w, y4], [x4, h]]), fill: "darkenLess" },
      { cmds: poly([[0, y1], [y1, 0], [w, 0], [x4, y1]]), fill: "lightenLess" },
    ];
  },
  heart: (w, h) => {
    const dx1 = (w * 49) / 48, dx2 = (w * 10) / 48, hc = w / 2, y1 = -h / 3, hd4 = h / 4;
    return [{ cmds: [["M", hc, hd4], ["C", hc + dx2, y1, hc + dx1, hd4, hc, h], ["C", hc - dx1, hd4, hc - dx2, y1, hc, hd4], ["Z"]] }];
  },
  pie: (w, h, a) => {
    const st = a.adj1 ?? 0, en = a.adj2 ?? 16200000, sw = (((en - st) % 21600000) + 21600000) % 21600000 || 21600000;
    const p = ellPt(w / 2, h / 2, w / 2, h / 2, st), c = [["M", ...p]];
    arcTo(c, p, w / 2, h / 2, st, sw);
    c.push(["L", w / 2, h / 2], ["Z"]);
    return [{ cmds: c }];
  },
  chord: (w, h, a) => {
    const st = a.adj1 ?? 2700000, en = a.adj2 ?? 16200000, sw = (((en - st) % 21600000) + 21600000) % 21600000 || 21600000;
    const p = ellPt(w / 2, h / 2, w / 2, h / 2, st), c = [["M", ...p]];
    arcTo(c, p, w / 2, h / 2, st, sw);
    c.push(["Z"]);
    return [{ cmds: c }];
  },
  arc: (w, h, a) => {
    const st = a.adj1 ?? 16200000, en = a.adj2 ?? 0, sw = (((en - st) % 21600000) + 21600000) % 21600000 || 21600000;
    const p = ellPt(w / 2, h / 2, w / 2, h / 2, st), c = [["M", ...p]];
    arcTo(c, p, w / 2, h / 2, st, sw);
    const f = [...c, ["L", w / 2, h / 2], ["Z"]];
    return [{ cmds: f, stroke: false }, { cmds: c, fill: "none" }];
  },
  blockArc: (w, h, a) => {
    const st = a.adj1 ?? 10800000, en = a.adj2 ?? 0, dr = (Math.min(w, h) * (a.adj3 ?? 25000)) / 100000;
    const sw = (((en - st) % 21600000) + 21600000) % 21600000 || 21600000;
    const p = ellPt(w / 2, h / 2, w / 2, h / 2, st), c = [["M", ...p]];
    arcTo(c, p, w / 2, h / 2, st, sw);
    const iw = w / 2 - dr, ih = h / 2 - dr;
    const q = ellPt(w / 2, h / 2, iw, ih, st + sw);
    c.push(["L", ...q]);
    arcTo(c, q, iw, ih, st + sw, -sw);
    c.push(["Z"]);
    return [{ cmds: c }];
  },
  moon: (w, h, a) => {
    const g0 = (Math.min(w, h) * (a.adj ?? 50000)) / 100000;
    const c = [["M", w, h]];
    arcTo(c, [w, h], w, h / 2, 5400000, 10800000);
    const g0w = (g0 * w) / Math.min(w, h);
    const rx = w - g0w;
    arcTo(c, [w, 0], rx, h / 2, 16200000, -10800000);
    c.push(["Z"]);
    return [{ cmds: c }];
  },
  teardrop: (w, h, a) => {
    const r2 = Math.SQRT2 * ((a.adj ?? 100000) / 100000), dx = (w / 2) * r2 * Math.cos(Math.PI / 4), dy = (h / 2) * r2 * Math.sin(Math.PI / 4);
    const x1 = w / 2 + dx, y1 = h / 2 - dy, x2 = (w / 2 + x1) / 2, y2 = (h / 2 + y1) / 2;
    const c = [["M", 0, h / 2]];
    arcTo(c, [0, h / 2], w / 2, h / 2, 10800000, 5400000);
    c.push(["Q", x2, 0, x1, y1], ["Q", w, y2, w, h / 2]);
    arcTo(c, [w, h / 2], w / 2, h / 2, 0, 10800000);
    c.push(["Z"]);
    return [{ cmds: c }];
  },
  frame: (w, h, a) => {
    const x1 = (Math.min(w, h) * (a.adj1 ?? 12500)) / 100000;
    return [{ cmds: [...poly([[0, 0], [w, 0], [w, h], [0, h]]), ...poly([[x1, x1], [x1, h - x1], [w - x1, h - x1], [w - x1, x1]])] }];
  },
  leftBracket: (w, h, a) => {
    const y1 = (Math.min(w, h) * (a.adj ?? 8333)) / 100000;
    const c = [["M", w, h]];
    let cur = arcTo(c, [w, h], w, y1, 5400000, 5400000);
    c.push(["L", 0, y1]); cur = [0, y1];
    arcTo(c, cur, w, y1, 10800000, 5400000);
    return [{ cmds: c, fill: "none" }];
  },
  rightBracket: (w, h, a) => mirrorX(PRESETS.leftBracket(w, h, a), w),
  leftBrace: (w, h, a) => {
    const ss = Math.min(w, h), a1 = a.adj1 ?? 8333, a2 = a.adj2 ?? 50000;
    const y1 = (ss * a1) / 100000, y3 = (h * a2) / 100000, wd2 = w / 2;
    const c = [["M", w, h]];
    let cur = arcTo(c, [w, h], wd2, y1, 5400000, 5400000);
    c.push(["L", wd2, y3 + y1]); cur = [wd2, y3 + y1];
    cur = arcTo(c, cur, wd2, y1, 0, -5400000);
    cur = arcTo(c, cur, wd2, y1, 5400000, -5400000);
    c.push(["L", wd2, y1]); cur = [wd2, y1];
    arcTo(c, cur, wd2, y1, 10800000, 5400000);
    return [{ cmds: c, fill: "none" }];
  },
  rightBrace: (w, h, a) => mirrorX(PRESETS.leftBrace(w, h, a), w),
  wedgeRectCallout: (w, h) => PRESETS.rect(w, h),
  wedgeRoundRectCallout: (w, h) => [{ cmds: roundRectCmds(w, h, Math.min(w, h) / 6) }],
  wedgeEllipseCallout: (w, h) => PRESETS.ellipse(w, h),
  snip1Rect: (w, h, a) => { const d = (Math.min(w, h) * (a.adj ?? 16667)) / 100000; return [{ cmds: poly([[0, 0], [w - d, 0], [w, d], [w, h], [0, h]]) }]; },
  round1Rect: (w, h, a) => [{ cmds: roundRectCmds(w, h, (Math.min(w, h) * (a.adj ?? 16667)) / 100000) }],
  round2SameRect: (w, h, a) => [{ cmds: roundRectCmds(w, h, (Math.min(w, h) * (a.adj1 ?? 16667)) / 100000) }],
  plaque: (w, h, a) => [{ cmds: roundRectCmds(w, h, (Math.min(w, h) * (a.adj ?? 16667)) / 100000) }],
  flowChartPredefinedProcess: (w, h) => [{ cmds: poly([[0, 0], [w, 0], [w, h], [0, h]]) }, { cmds: [["M", w / 8, 0], ["L", w / 8, h], ["M", (7 * w) / 8, 0], ["L", (7 * w) / 8, h]], fill: "none" }],
  flowChartDocument: (w, h) => {
    const y = (h * 17322) / 21600;
    return [{ cmds: [["M", 0, 0], ["L", w, 0], ["L", w, y], ["C", (w * 10800) / 21600, y, (w * 10800) / 21600, (h * 23922) / 21600, 0, (h * 20172) / 21600], ["Z"]] }];
  },
  flowChartManualInput: (w, h) => [{ cmds: poly([[0, h / 5], [w, 0], [w, h], [0, h]]) }],
  flowChartManualOperation: (w, h) => [{ cmds: poly([[0, 0], [w, 0], [(4 * w) / 5, h], [w / 5, h]]) }],
  flowChartPunchedCard: (w, h) => [{ cmds: poly([[0, h / 5], [w / 5, 0], [w, 0], [w, h], [0, h]]) }],
  flowChartOffpageConnector: (w, h) => [{ cmds: poly([[0, 0], [w, 0], [w, (4 * h) / 5], [w / 2, h], [0, (4 * h) / 5]]) }],
  flowChartDelay: (w, h) => {
    const c = [["M", 0, 0], ["L", w / 2, 0]];
    arcTo(c, [w / 2, 0], w / 2, h / 2, 16200000, 10800000);
    c.push(["L", 0, h], ["Z"]);
    return [{ cmds: c }];
  },
  corner: (w, h, a) => {
    const ss = Math.min(w, h), dx = (ss * (a.adj2 ?? 50000)) / 100000, dy = (ss * (a.adj1 ?? 50000)) / 100000;
    return [{ cmds: poly([[0, 0], [dx, 0], [dx, h - dy], [w, h - dy], [w, h], [0, h]]) }];
  },
  halfFrame: (w, h, a) => {
    const ss = Math.min(w, h), x1 = (ss * (a.adj2 ?? 33333)) / 100000, y1 = (ss * (a.adj1 ?? 33333)) / 100000;
    return [{ cmds: poly([[0, 0], [w, 0], [w - (w * y1) / h, y1], [x1, y1], [x1, h - (h * x1) / w], [0, h]]) }];
  },
  diagStripe: (w, h, a) => {
    const x2 = (w * (a.adj ?? 50000)) / 100000, y2 = (h * (a.adj ?? 50000)) / 100000;
    return [{ cmds: poly([[0, y2], [x2, 0], [w, 0], [0, h]]) }];
  },
  lightningBolt: (w, h) => {
    const P = [[8458, 0], [12180, 6908], [10606, 7642], [16529, 12320], [14940, 13063], [21600, 21600], [10014, 14019], [11602, 13274], [5765, 8744], [7385, 7988], [0, 3722]];
    return [{ cmds: poly(P.map(([x, y]) => [(x * w) / 21600, (y * h) / 21600])) }];
  },
  bevel: (w, h, a) => {
    const x1 = (Math.min(w, h) * (a.adj ?? 12500)) / 100000, x2 = w - x1, y2 = h - x1;
    return [
      { cmds: poly([[x1, x1], [x2, x1], [x2, y2], [x1, y2]]) },
      { cmds: poly([[0, 0], [w, 0], [x2, x1], [x1, x1]]), fill: "lightenLess" },
      { cmds: poly([[0, h], [x1, y2], [x2, y2], [w, h]]), fill: "darken" },
      { cmds: poly([[0, 0], [x1, x1], [x1, y2], [0, h]]), fill: "lighten" },
      { cmds: poly([[w, 0], [w, h], [x2, y2], [x2, x1]]), fill: "darkenLess" },
    ];
  },
  foldedCorner: (w, h, a) => {
    const dy2 = (Math.min(w, h) * (a.adj ?? 16667)) / 100000, x1 = w - dy2, y2 = h - dy2;
    return [{ cmds: poly([[0, 0], [w, 0], [w, y2], [x1, h], [0, h]]) }, { cmds: poly([[x1, h], [x1 + dy2 / 5, y2 + dy2 / 5], [w, y2]]), fill: "darkenLess" }];
  },
  smileyFace: (w, h) => {
    const eye = (cx) => ellipseCmds(cx, (h * 7610) / 21600, (w * 1270) / 21600, (h * 1270) / 21600);
    return [
      { cmds: ellipseCmds(w / 2, h / 2, w / 2, h / 2) },
      { cmds: [...eye((w * 7200) / 21600), ...eye((w * 14400) / 21600)], fill: "darkenLess" },
      { cmds: [["M", (w * 4600) / 21600, (h * 16000) / 21600], ["Q", w / 2, (h * 19500) / 21600, (w * 17000) / 21600, (h * 16000) / 21600]], fill: "none" },
    ];
  },
  sun: (w, h) => {
    const c = ellipseCmds(w / 2, h / 2, w / 4, h / 4);
    const rays = [];
    for (let i = 0; i < 8; i++) {
      const t = (i * Math.PI) / 4, t1 = t - 0.12, t2 = t + 0.12;
      rays.push(...poly([[w / 2 + (w / 2) * Math.cos(t), h / 2 + (h / 2) * Math.sin(t)], [w / 2 + w * 0.32 * Math.cos(t1), h / 2 + h * 0.32 * Math.sin(t1)], [w / 2 + w * 0.32 * Math.cos(t2), h / 2 + h * 0.32 * Math.sin(t2)]]));
    }
    return [{ cmds: [...c, ...rays] }];
  },
  cloud: (w, h) => {
    // lobes approximated with ellipses
    const L = [[0.29, 0.39, 0.22, 0.25], [0.5, 0.28, 0.2, 0.24], [0.71, 0.36, 0.2, 0.23], [0.8, 0.62, 0.18, 0.2], [0.58, 0.72, 0.22, 0.2], [0.33, 0.7, 0.22, 0.2], [0.17, 0.57, 0.16, 0.18]];
    return [{ cmds: L.flatMap(([x, y, rx, ry]) => ellipseCmds(x * w, y * h, rx * w, ry * h)), nonzero: true }];
  },
};

function starCmds(w, h, n, ratio, hf = 1, vf = 1) {
  const rx = (w / 2) * hf, ry = (h / 2) * vf, cy = (h / 2) * vf, cx = w / 2;
  const pts = [];
  for (let i = 0; i < 2 * n; i++) {
    const t = -Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? ratio : 1;
    pts.push([cx + rx * r * Math.cos(t), cy + ry * r * Math.sin(t)]);
  }
  return [{ cmds: poly(pts) }];
}
function arrowCmds(w, h, a) {
  const ss = Math.min(w, h), a1 = Math.max(0, Math.min(a.adj1 ?? 50000, 100000)), a2 = Math.max(0, Math.min(a.adj2 ?? 50000, (100000 * w) / ss));
  const x1 = w - (ss * a2) / 100000, dy1 = (h * a1) / 200000, y1 = h / 2 - dy1, y2 = h / 2 + dy1;
  return [{ cmds: poly([[0, y1], [x1, y1], [x1, 0], [w, h / 2], [x1, h], [x1, y2], [0, y2]]) }];
}
const mapPaths = (paths, f) => paths.map((p) => ({ ...p, cmds: p.cmds.map((c) => { const o = [c[0]]; for (let i = 1; i < c.length; i += 2) o.push(...f(c[i], c[i + 1])); return o; }) }));
const mirrorX = (paths, w) => mapPaths(paths, (x, y) => [w - x, y]);
const mirrorY = (paths, h) => mapPaths(paths, (x, y) => [x, h - y]);
const swapXY = (paths) => mapPaths(paths, (x, y) => [y, x]);

function presetGeometry(geom, w, h, warn) {
  const name = geom.a.prst;
  const av = {};
  for (const gd of kids(kid(geom, "a:avLst"), "a:gd")) {
    const f = (gd.a.fmla || "").trim().split(/\s+/);
    if (f[0] === "val") av[gd.a.name] = +f[1];
  }
  const fn = PRESETS[name];
  if (!fn) {
    warn(`preset ${name} drawn as its bounding box`);
    return PRESETS.rect(w, h);
  }
  return fn(w, h, av);
}

// ---------------------------------------------------------------- fills & lines ------------------

const DASHES = { dot: [1, 3], dash: [4, 3], lgDash: [8, 3], dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDash: [3, 1], sysDot: [1, 1], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1] };
const FILL_TAGS = new Set(["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"]);
const fillNode = (n) => n?.c.find((x) => FILL_TAGS.has(x.n)) || null;

/** Resolve a fill element to {type:'none'|'solid'|'grad', color, stops, ...}. */
function resolveFill(fn, ctx, groupFill) {
  if (!fn) return null;
  switch (fn.n) {
    case "a:noFill": return { type: "none" };
    case "a:solidFill": { const c = resolveColor(colorNode(fn), ctx); return c ? { type: "solid", color: c } : { type: "none" }; }
    case "a:grpFill": return groupFill || { type: "none" };
    case "a:pattFill": { const c = resolveColor(colorNode(kid(fn, "a:fgClr")), ctx); return c ? { type: "solid", color: c, approx: "pattern" } : { type: "none" }; }
    case "a:gradFill": {
      const stops = kids(kid(fn, "a:gsLst"), "a:gs")
        .map((g) => ({ pos: +g.a.pos / 100000, color: resolveColor(colorNode(g), ctx) }))
        .filter((s) => s.color)
        .sort((a, b) => a.pos - b.pos);
      if (!stops.length) return { type: "none" };
      if (stops.length === 1) return { type: "solid", color: stops[0].color };
      const lin = kid(fn, "a:lin"), pth = kid(fn, "a:path");
      if (pth) {
        const r = kid(pth, "a:fillToRect")?.a || {};
        return { type: "radial", stops, kind: pth.a.path || "circle", ftr: ["l", "t", "r", "b"].map((k) => +(r[k] || 0) / 100000) };
      }
      return { type: "linear", stops, ang: lin ? +lin.a.ang || 0 : 0, scaled: lin?.a.scaled === "1" };
    }
    case "a:blipFill": return { type: "none", approx: "picture fill" };
  }
  return null;
}

// ---------------------------------------------------------------- drawing walker -----------------

class Drawing {
  constructor(ctx) {
    this.ctx = ctx;
    this.items = []; // {d, fill, stroke, ...} in slide EMU
    this.defs = [];
    this.warn = new Set();
    this.bbox = [Infinity, Infinity, -Infinity, -Infinity];
    this.gid = 0;
  }
  grow(x, y, pad = 0) {
    const b = this.bbox;
    if (x - pad < b[0]) b[0] = x - pad;
    if (y - pad < b[1]) b[1] = y - pad;
    if (x + pad > b[2]) b[2] = x + pad;
    if (y + pad > b[3]) b[3] = y + pad;
  }
}

/** Walk a shape tree element (p:sp, p:grpSp, p:cxnSp, p:pic) with a parent matrix. */
function drawElement(el, m, D, groupFill) {
  if (el.n === "mc:AlternateContent") {
    const alt = kid(el, "mc:Fallback") || kid(el, "mc:Choice");
    if (alt) for (const c of alt.c) drawElement(c, m, D, groupFill);
    return;
  }
  const nv = el.c.find((x) => x.n.startsWith("p:nv"));
  const cNvPr = nv && kid(nv, "p:cNvPr");
  if (cNvPr?.a.hidden === "1" || cNvPr?.a.hidden === "true") return;
  if (el.n === "p:grpSp") {
    const gp = kid(el, "p:grpSpPr");
    const xf = readXfrm(kid(gp, "a:xfrm"));
    const gm = mul(m, groupMatrix(xf));
    const gf = resolveFill(fillNode(gp), D.ctx, groupFill) || groupFill;
    for (const c of el.c) if (["p:sp", "p:grpSp", "p:cxnSp", "p:pic", "mc:AlternateContent"].includes(c.n)) drawElement(c, gm, D, gf);
    return;
  }
  if (el.n === "p:graphicFrame") { D.warn.add("table/chart/SmartArt frame skipped"); return; }
  if (el.n === "p:pic") return drawPicture(el, m, D);
  if (el.n !== "p:sp" && el.n !== "p:cxnSp") return;
  const sp = kid(el, "p:spPr");
  const xf = readXfrm(kid(sp, "a:xfrm"));
  if (!xf) return;
  const sm = mul(m, shapeMatrix(xf));
  const style = kid(el, "p:style");
  const ctx = D.ctx;
  const warn = (w) => D.warn.add(w);
  let geom;
  const cg = kid(sp, "a:custGeom"), pg = kid(sp, "a:prstGeom");
  if (cg) geom = customGeometry(cg, xf.w, xf.h);
  else if (pg) geom = presetGeometry(pg, xf.w, xf.h, warn);
  else return;
  // fill
  let fill = resolveFill(fillNode(sp), ctx, groupFill);
  if (!fill && style) {
    const ref = kid(style, "a:fillRef"), idx = +(ref?.a.idx || 0);
    const phClr = resolveColor(colorNode(ref), ctx);
    if (idx > 0 && idx < 1000) {
      const st = ctx.theme.fills[idx - 1];
      fill = st ? resolveFill(st, { ...ctx, phClr }, groupFill) : phClr ? { type: "solid", color: phClr } : null;
    }
  }
  fill = fill || { type: "none" };
  // line
  const ln = kid(sp, "a:ln");
  let lineFill = ln ? resolveFill(fillNode(ln), ctx, groupFill) : null;
  let lw = ln?.a.w != null ? +ln.a.w : null;
  let lnSrc = ln;
  if ((!lineFill || lw == null) && style) {
    const ref = kid(style, "a:lnRef"), idx = +(ref?.a.idx || 0);
    const phClr = resolveColor(colorNode(ref), ctx);
    const st = idx > 0 ? ctx.theme.lines[idx - 1] : null;
    if (!lineFill && idx > 0) lineFill = st ? resolveFill(fillNode(st), { ...ctx, phClr }, groupFill) || (phClr && { type: "solid", color: phClr }) : phClr && { type: "solid", color: phClr };
    if (lw == null && st?.a.w) lw = +st.a.w;
    if (!lnSrc) lnSrc = st;
  }
  if (!lineFill) lineFill = { type: "none" };
  if (lw == null) lw = 9525;
  if (fill.approx) warn(`${fill.approx} drawn as a flat colour`);
  if (kid(sp, "a:effectLst")?.c.length) warn("shadow/glow effects dropped");
  const stroke = lineFill.type !== "none" && lw > 0 ? { fill: lineFill, w: lw, ln: lnSrc } : null;
  for (const g of geom) {
    const f = g.fill === "none" ? { type: "none" } : g.fill && g.fill !== "norm" && fill.type === "solid" ? { type: "solid", color: shadeColor(fill.color, g.fill) } : fill;
    const s = g.stroke === false ? null : stroke;
    if (f.type === "none" && !s) continue;
    emitPath(g, sm, f, s, D, xf, !!g.nonzero);
  }
}

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml" };

/** The media of a picture: the SVG version if PowerPoint stored one (svgBlip), else the bitmap. */
function pictureMedia(el, ctx) {
  const blip = path1(el, "p:blipFill", "a:blip");
  if (!blip) return null;
  const svgBlip = [...walk(blip)].find((x) => x.n === "asvg:svgBlip" || x.n.endsWith(":svgBlip"));
  const get = (rid) => {
    const rel = rid && ctx.rels[rid];
    if (!rel || rel.external || !ctx.files.has(rel.target)) return null;
    const ext = rel.target.split(".").pop().toLowerCase();
    return { ext, mime: MIME[ext] || null, data: ctx.files.get(rel.target)(), name: rel.target };
  };
  const bitmap = get(blip.a["r:embed"]);
  const svg = svgBlip ? get(svgBlip.a["r:embed"]) : null;
  return { bitmap, svg: svg?.ext === "svg" ? svg : null };
}

function drawPicture(el, m, D) {
  const sp = kid(el, "p:spPr");
  const xf = readXfrm(kid(sp, "a:xfrm"));
  const media = xf && pictureMedia(el, D.ctx);
  const pic = media?.svg || media?.bitmap;
  if (!pic) return;
  if (!pic.mime) { D.warn.add(`${pic.ext.toUpperCase()} picture skipped`); return; }
  const sm = mul(m, shapeMatrix(xf));
  for (const [x, y] of [[0, 0], [xf.w, 0], [0, xf.h], [xf.w, xf.h]]) D.grow(...ap(sm, x, y));
  D.items.push({ image: { mime: pic.mime, data: pic.data, w: xf.w, h: xf.h, m: sm, crop: kid(kid(el, "p:blipFill"), "a:srcRect")?.a } });
  D.hasRaster = true;
}

/** A picture placed on its own on a slide: its SVG version as it is, or the bitmap in an SVG. */
function topPicture(el, ctx, minPx) {
  const xf = readXfrm(kid(kid(el, "p:spPr"), "a:xfrm"));
  const media = xf && pictureMedia(el, ctx);
  if (!media) return null;
  const w = xf.w / EMU_PX, h = xf.h / EMU_PX;
  if (media.svg) {
    let svg = media.svg.data.toString("utf8").replace(/^﻿/, "").replace(/<\?xml[^>]*\?>\s*/, "").replace(/<!DOCTYPE[^>]*>\s*/i, "");
    // give the drawing the size it has on the slide (keeps its viewBox)
    svg = svg.replace(/<svg\b([^>]*)>/, (m0, at) => `<svg${at.replace(/\s(width|height)="[^"]*"/g, "")} width="${fmt(w)}" height="${fmt(h)}">`);
    if (!/viewBox=/.test(svg.slice(0, svg.indexOf(">")))) return null;
    return { svg, w, h, png: media.bitmap?.ext === "png" ? media.bitmap.data : null, vector: true };
  }
  const b = media.bitmap;
  if (!b?.mime || b.mime === "image/svg+xml") return null;
  // pixel size: skip bullets and tiny symbols
  let px = 0;
  if (b.ext === "png" && b.data.length > 24) px = Math.max(b.data.readUInt32BE(16), b.data.readUInt32BE(20));
  if (b.ext === "png" && px < minPx) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(w)}" height="${fmt(h)}" viewBox="0 0 ${fmt(w)} ${fmt(h)}"><image width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="none" xlink:href="data:${b.mime};base64,${b.data.toString("base64")}"/></svg>\n`;
  return { svg, w, h, png: b.ext === "png" ? b.data : null, vector: false };
}

// flatten for the bbox and the matching raster
function flatten(cmds, m) {
  const polys = [];
  let cur = null, pts = null, start = null;
  const push = (x, y) => pts.push(x, y);
  for (const c of cmds) {
    switch (c[0]) {
      case "M": { const p = ap(m, c[1], c[2]); pts = [p[0], p[1]]; polys.push(pts); cur = p; start = p; break; }
      case "L": { if (!pts) { pts = []; polys.push(pts); } const p = ap(m, c[1], c[2]); push(...p); cur = p; break; }
      case "C": {
        if (!pts) { pts = []; polys.push(pts); cur = ap(m, 0, 0); }
        const p1 = ap(m, c[1], c[2]), p2 = ap(m, c[3], c[4]), p3 = ap(m, c[5], c[6]);
        const len = Math.hypot(p1[0] - cur[0], p1[1] - cur[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
        const n = Math.max(2, Math.min(24, Math.ceil(len / 40000)));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push(u * u * u * cur[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * cur[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]);
        }
        cur = p3;
        break;
      }
      case "Q": {
        if (!pts) { pts = []; polys.push(pts); cur = ap(m, 0, 0); }
        const p1 = ap(m, c[1], c[2]), p2 = ap(m, c[3], c[4]);
        for (let i = 1; i <= 8; i++) { const t = i / 8, u = 1 - t; push(u * u * cur[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * cur[1] + 2 * u * t * p1[1] + t * t * p2[1]); }
        cur = p2;
        break;
      }
      case "Z": if (start) { cur = start; pts = null; } break;
    }
  }
  return polys.filter((p) => p.length >= 4);
}

function emitPath(g, m, fill, stroke, D, xf, nonzero) {
  const polys = flatten(g.cmds, m);
  if (!polys.length) return;
  const pad = stroke ? stroke.w / 2 : 0;
  for (const p of polys) for (let i = 0; i < p.length; i += 2) D.grow(p[i], p[i + 1], pad);
  D.items.push({ cmds: g.cmds, m, fill, stroke, polys, xf, nonzero });
}

// ---------------------------------------------------------------- SVG output ---------------------

const EMU_PX = 9525;
const fmt = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

function pathData(cmds, m, ox, oy) {
  let d = "";
  const P = (x, y) => { const p = ap(m, x, y); return fmt((p[0] - ox) / EMU_PX) + " " + fmt((p[1] - oy) / EMU_PX); };
  for (const c of cmds) {
    if (c[0] === "M") d += "M" + P(c[1], c[2]);
    else if (c[0] === "L") d += "L" + P(c[1], c[2]);
    else if (c[0] === "C") d += "C" + P(c[1], c[2]) + " " + P(c[3], c[4]) + " " + P(c[5], c[6]);
    else if (c[0] === "Q") d += "Q" + P(c[1], c[2]) + " " + P(c[3], c[4]);
    else if (c[0] === "Z") d += "Z";
  }
  return d;
}

function paintAttrs(kind, f, item, D, ox, oy) {
  if (!f || f.type === "none") return ` ${kind}="none"`;
  if (f.type === "solid") return ` ${kind}="${cssColor(f.color)}"${f.color.a < 1 ? ` ${kind}-opacity="${fmt(f.color.a)}"` : ""}`;
  // gradient over the shape's own box, mapped by the shape matrix (then into px)
  const id = `g${++D.gid}`;
  const { w, h } = item.xf;
  const gm = mul([1 / EMU_PX, 0, 0, 1 / EMU_PX, -ox / EMU_PX, -oy / EMU_PX], item.m);
  const tr = `gradientTransform="matrix(${gm.map((v) => +v.toPrecision(8)).join(" ")})"`;
  const stops = f.stops.map((s) => `<stop offset="${fmt(s.pos)}" stop-color="${cssColor(s.color)}"${s.color.a < 1 ? ` stop-opacity="${fmt(s.color.a)}"` : ""}/>`).join("");
  if (f.type === "linear") {
    let t = rad(f.ang);
    if (f.scaled && w && h) t = Math.atan2(Math.sin(t) * h, Math.cos(t) * w) ; // angle in the shape box
    const dx = Math.cos(t), dy = Math.sin(t);
    const L = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    D.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(w / 2 - dx * L)}" y1="${fmt(h / 2 - dy * L)}" x2="${fmt(w / 2 + dx * L)}" y2="${fmt(h / 2 + dy * L)}" ${tr}>${stops}</linearGradient>`);
  } else {
    const [l, t, r, b] = f.ftr;
    const cx = (w * (l + (1 - r))) / 2, cy = (h * (t + (1 - b))) / 2;
    const rr = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)) || 1;
    // path gradients: stop 0 at the focus (centre), the last stop at the edge
    D.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(rr)}" ${tr}>${stops}</radialGradient>`);
  }
  return ` ${kind}="url(#${id})"`;
}

function strokeAttrs(s, item, D, ox, oy) {
  if (!s) return "";
  let a = paintAttrs("stroke", s.fill, item, D, ox, oy);
  const w = s.w / EMU_PX;
  // PowerPoint draws hairlines (w="0", or a few EMU) one device pixel wide
  a += ` stroke-width="${fmt(Math.max(w, 0.5))}"`;
  const ln = s.ln;
  const cap = { rnd: "round", sq: "square", flat: "butt" }[ln?.a.cap];
  if (cap && cap !== "butt") a += ` stroke-linecap="${cap}"`;
  if (kid(ln, "a:round")) a += ` stroke-linejoin="round"`;
  else if (kid(ln, "a:bevel")) a += ` stroke-linejoin="bevel"`;
  else { const lim = kid(ln, "a:miter")?.a.lim; if (lim) a += ` stroke-miterlimit="${fmt(Math.max(1, +lim / 100000))}"`; }
  const dash = kid(ln, "a:prstDash")?.a.val;
  const cust = kid(ln, "a:custDash");
  let arr = dash && DASHES[dash];
  if (cust) arr = kids(cust, "a:ds").flatMap((d) => [+d.a.d / 100000, +d.a.sp / 100000]);
  if (arr) a += ` stroke-dasharray="${arr.map((v) => fmt(v * Math.max(w, 0.5))).join(" ")}"`;
  return a;
}

/** Arrow heads (headEnd at the first point, tailEnd at the last) as filled polygons. */
function lineEnds(item, ox, oy) {
  const s = item.stroke;
  if (!s?.ln || s.fill.type !== "solid") return "";
  let out = "";
  const poly0 = item.polys[0], polyN = item.polys[item.polys.length - 1];
  const w = Math.max(s.w, 9525);
  const sizes = { sm: 2, med: 3, lg: 5 };
  for (const [tag, pts, atStart] of [["a:headEnd", poly0, true], ["a:tailEnd", polyN, false]]) {
    const e = kid(s.ln, tag);
    const type = e?.a.type;
    if (!type || type === "none" || pts.length < 4) continue;
    const n = pts.length;
    let [x, y, px, py] = atStart ? [pts[0], pts[1], pts[2], pts[3]] : [pts[n - 2], pts[n - 1], pts[n - 4], pts[n - 3]];
    // direction from the previous distinct point
    for (let k = 2; Math.hypot(x - px, y - py) < 1 && k * 2 + 1 < n; k++) {
      [px, py] = atStart ? [pts[k * 2], pts[k * 2 + 1]] : [pts[n - 2 - k * 2], pts[n - 1 - k * 2]];
    }
    const len = Math.hypot(x - px, y - py) || 1, ux = (x - px) / len, uy = (y - py) / len;
    const hw = (w * (sizes[e.a.w] || 3)) / 2, hl = w * (sizes[e.a.len] || 3);
    const P = (a, b) => fmt((a - ox) / EMU_PX) + " " + fmt((b - oy) / EMU_PX);
    const bx = x - ux * hl, by = y - uy * hl, nx = -uy, ny = ux;
    const col = cssColor(s.fill.color), op = s.fill.color.a < 1 ? ` fill-opacity="${fmt(s.fill.color.a)}"` : "";
    if (type === "oval") {
      out += `<ellipse cx="${fmt((x - ox) / EMU_PX)}" cy="${fmt((y - oy) / EMU_PX)}" rx="${fmt(hw / EMU_PX)}" ry="${fmt(hw / EMU_PX)}" fill="${col}"${op}/>`;
    } else if (type === "diamond") {
      out += `<path d="M${P(x + ux * hl / 2, y + uy * hl / 2)}L${P(x + nx * hw, y + ny * hw)}L${P(x - ux * hl / 2, y - uy * hl / 2)}L${P(x - nx * hw, y - ny * hw)}Z" fill="${col}"${op}/>`;
    } else if (type === "arrow") {
      out += `<path d="M${P(bx + nx * hw, by + ny * hw)}L${P(x, y)}L${P(bx - nx * hw, by - ny * hw)}" fill="none" stroke="${col}" stroke-width="${fmt(s.w / EMU_PX)}"${op}/>`;
    } else if (type === "stealth") {
      const mx = x - ux * hl * 0.6, my = y - uy * hl * 0.6;
      out += `<path d="M${P(x, y)}L${P(bx + nx * hw, by + ny * hw)}L${P(mx, my)}L${P(bx - nx * hw, by - ny * hw)}Z" fill="${col}"${op}/>`;
    } else {
      out += `<path d="M${P(x, y)}L${P(bx + nx * hw, by + ny * hw)}L${P(bx - nx * hw, by - ny * hw)}Z" fill="${col}"${op}/>`;
    }
  }
  return out;
}

function toSvg(D, title) {
  const [x0, y0, x1, y1] = D.bbox;
  const ox = x0, oy = y0;
  const W = (x1 - x0) / EMU_PX, H = (y1 - y0) / EMU_PX;
  let body = "";
  for (const it of D.items) {
    if (it.image) {
      const { mime, data, w, h, m, crop } = it.image;
      const gm = mul([1 / EMU_PX, 0, 0, 1 / EMU_PX, -ox / EMU_PX, -oy / EMU_PX], m);
      // srcRect crops (in 1/1000 %) are applied by scaling the image beyond its frame and clipping
      let ix = 0, iy = 0, iw = w, ih = h, clip = "";
      if (crop && (crop.l || crop.t || crop.r || crop.b)) {
        const [l, t, r, b] = ["l", "t", "r", "b"].map((k) => +(crop[k] || 0) / 100000);
        iw = w / (1 - l - r || 1); ih = h / (1 - t - b || 1); ix = -l * iw; iy = -t * ih;
        const cid = `c${++D.gid}`;
        D.defs.push(`<clipPath id="${cid}"><rect width="${fmt(w)}" height="${fmt(h)}"/></clipPath>`);
        clip = ` clip-path="url(#${cid})"`;
      }
      body += `<g transform="matrix(${gm.map((v) => +v.toPrecision(8)).join(" ")})"${clip}><image x="${fmt(ix)}" y="${fmt(iy)}" width="${fmt(iw)}" height="${fmt(ih)}" preserveAspectRatio="none" xlink:href="data:${mime};base64,${data.toString("base64")}"/></g>`;
      continue;
    }
    const d = pathData(it.cmds, it.m, ox, oy);
    const fr = it.fill.type !== "none" && !it.nonzero ? ` fill-rule="evenodd"` : "";
    body += `<path d="${d}"${paintAttrs("fill", it.fill, it, D, ox, oy)}${fr}${strokeAttrs(it.stroke, it, D, ox, oy)}/>`;
    body += lineEnds(it, ox, oy);
  }
  const defs = D.defs.length ? `<defs>${D.defs.join("")}</defs>` : "";
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const xl = D.hasRaster ? ` xmlns:xlink="http://www.w3.org/1999/xlink"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${xl} width="${fmt(W)}" height="${fmt(H)}" viewBox="0 0 ${fmt(W)} ${fmt(H)}">${title ? `<title>${esc(title)}</title>` : ""}${defs}${body}</svg>\n`;
}

/** Simplified paint list for rasterising (matching against preview images): px coordinates. */
function rasterItems(D) {
  const [x0, y0] = D.bbox;
  const out = [];
  for (const it of D.items) {
    if (it.image) continue;
    const tx = (p) => { const o = new Float64Array(p.length); for (let i = 0; i < p.length; i += 2) { o[i] = (p[i] - x0) / EMU_PX; o[i + 1] = (p[i + 1] - y0) / EMU_PX; } return o; };
    const polys = it.polys.map(tx);
    const avg = (f) => f.type === "solid" ? f.color : f.stops ? { rgb: [0, 1, 2].map((k) => f.stops.reduce((s, st) => s + st.color.rgb[k], 0) / f.stops.length), a: f.stops.reduce((s, st) => s + st.color.a, 0) / f.stops.length } : null;
    const fc = it.fill.type !== "none" ? avg(it.fill) : null;
    if (fc) out.push({ polys, rgba: [...fc.rgb, fc.a], evenOdd: !it.nonzero });
    if (it.stroke) { const sc = avg(it.stroke.fill); if (sc) out.push({ polys, rgba: [...sc.rgb, sc.a], stroke: it.stroke.w / EMU_PX }); }
  }
  return out;
}

// ---------------------------------------------------------------- slides -------------------------

function isTextOnly(el) {
  // text boxes and placeholders are labels, not drawings
  const nvSp = kid(el, "p:nvSpPr");
  if (path1(nvSp, "p:nvPr", "p:ph")) return true;
  if (kid(nvSp, "p:cNvSpPr")?.a.txBox === "1") return true;
  const tx = kid(el, "p:txBody");
  if (!tx || !textOf(tx)) return false;
  const sp = kid(el, "p:spPr");
  const f = fillNode(sp), ln = kid(sp, "a:ln");
  const hasFill = f && f.n !== "a:noFill";
  const hasLine = ln && fillNode(ln) && fillNode(ln).n !== "a:noFill";
  return !hasFill && !hasLine && !kid(el, "p:style");
}

function elementBox(el, m) {
  // rough box of a top-level element from its xfrm (for label placement)
  const pr = kid(el, "p:spPr") || kid(el, "p:grpSpPr");
  const xf = readXfrm(kid(pr, "a:xfrm"));
  if (!xf) return null;
  return [xf.x, xf.y, xf.x + xf.w, xf.y + xf.h];
}

/**
 * Convert a .pptx buffer. Returns {title, slides, drawings:[{slide, index, slideTitle, label,
 * labels, svg, w, h, raster, warnings}], skipped}.
 */
export function convertPptx(buf, { name = "", slides: only = null, minSize = 6, minPicturePx = 96, debug = false } = {}) {
  const files = readZip(buf);
  const pres = parseXml(files.get("ppt/presentation.xml")().toString("utf8"));
  const presRels = readRels(files, "ppt/presentation.xml");
  const slideIds = kids(path1(pres, "p:presentation", "p:sldIdLst"), "p:sldId");
  const slidePaths = slideIds.map((s) => presRels[s.a["r:id"]]?.target).filter(Boolean);
  const out = { title: "", slides: slidePaths.length, drawings: [], composites: 0, skipped: { text: 0, tiny: 0, pictures: 0, empty: 0, lines: 0, background: 0 } };
  const sz = path1(pres, "p:presentation", "p:sldSz");
  const slideW = +(sz?.a.cx || 12192000), slideH = +(sz?.a.cy || 6858000);
  const themes = new Map();
  slidePaths.forEach((sp, si) => {
    const slideNo = si + 1;
    if (only && !only.includes(slideNo)) return;
    if (!files.has(sp)) return;
    const rels = readRels(files, sp);
    // slide → layout → master → theme
    const layout = Object.values(rels).find((r) => /slideLayout$/.test(r.type))?.target;
    const master = layout ? Object.values(readRels(files, layout)).find((r) => /slideMaster$/.test(r.type))?.target : null;
    const mkey = master || "ppt/slideMasters/slideMaster1.xml";
    if (!themes.has(mkey)) themes.set(mkey, loadTheme(files, mkey));
    const xml = parseXml(files.get(sp)().toString("utf8"));
    const tree = path1(xml, "p:sld", "p:cSld", "p:spTree");
    if (!tree) return;
    let theme = themes.get(mkey);
    const ovr = path1(xml, "p:sld", "p:clrMapOvr", "a:overrideClrMapping");
    if (ovr) theme = { ...theme, clrMap: { ...ovr.a } };
    const ctx = { theme, files, rels };
    const top = tree.c.filter((c) => !["p:nvGrpSpPr", "p:grpSpPr", "p:extLst"].includes(c.n));
    let slideTitle = "";
    const labels = [];
    const draws = [];
    for (const el of top) {
      if (el.n === "p:sp" && isTextOnly(el)) {
        const t = textOf(kid(el, "p:txBody") || { c: [] });
        const ph = path1(kid(el, "p:nvSpPr"), "p:nvPr", "p:ph");
        if (ph && /title/i.test(ph.a.type || "")) slideTitle = slideTitle || t;
        else if (t) labels.push({ text: t, box: elementBox(el) });
        out.skipped.text++;
        continue;
      }
      if (el.n === "p:pic") {
        const nv = path1(el, "p:nvPicPr", "p:cNvPr");
        const pic = nv?.a.hidden === "1" ? null : topPicture(el, ctx, minPicturePx);
        const box = elementBox(el);
        if (!pic || !box) { out.skipped.pictures++; continue; }
        draws.push({ pic, bbox: box, w: pic.w, h: pic.h, el });
        continue;
      }
      if (el.n === "p:graphicFrame") { out.skipped.text++; continue; }
      const D = new Drawing(ctx);
      drawElement(el, I, D, null);
      if (!D.items.length || !Number.isFinite(D.bbox[0])) { out.skipped.empty++; continue; }
      const w = (D.bbox[2] - D.bbox[0]) / EMU_PX, h = (D.bbox[3] - D.bbox[1]) / EMU_PX;
      if (Math.max(w, h) < minSize) { out.skipped.tiny++; continue; }
      if (D.items.every((it) => !it.image && it.fill.type === "none" && it.polys.every((p) => p.length <= 4))) { out.skipped.empty++; continue; } // a lone line
      // a small or hairline unfilled shape on its own is a stray stroke, not a drawing
      if (el.n !== "p:grpSp" && D.items.every((it) => !it.image && it.fill.type === "none") && (Math.max(w, h) < 48 || D.items.every((it) => !it.stroke || it.stroke.w < 3175))) { out.skipped.lines++; continue; }
      // a single shape behind everything that covers the slide is a background
      if (el.n === "p:sp" && D.bbox[2] - D.bbox[0] > 0.9 * slideW && D.bbox[3] - D.bbox[1] > 0.9 * slideH) { out.skipped.background++; continue; }
      draws.push({ D, bbox: D.bbox, w, h, el });
    }
    if (si < 2 && !out.title && slideTitle) out.title = slideTitle;
    // Overlays: a later drawing that lies inside an earlier, larger one is drawn on top of it
    // (organs over a body, clothes over a person, veins over a leg). Each such stack is also
    // offered as one composite drawing, which is what the website usually shows.
    const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const inter = (a, b) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
    const parent = new Map();
    for (let j = 0; j < draws.length; j++) {
      if (draws[j].pic) continue;
      let best = -1;
      for (let i = 0; i < j; i++) {
        if (draws[i].pic) continue;
        const bi = draws[i].bbox, bj = draws[j].bbox;
        if (area(bj) > area(bi) || inter(bi, bj) < 0.85 * area(bj)) continue;
        if (best < 0 || area(bi) < area(draws[best].bbox)) best = i;
      }
      if (best >= 0) parent.set(j, best);
    }
    const stacks = new Map();
    for (const j of parent.keys()) {
      let r = j;
      while (parent.has(r)) r = parent.get(r);
      (stacks.get(r) || stacks.set(r, [r]).get(r)).push(j);
    }
    const singles = draws.length;
    for (const [r, members] of stacks) {
      members.sort((a, b) => a - b);
      const D = new Drawing(ctx);
      for (const m of members) drawElement(draws[m].el, I, D, null);
      if (!D.items.length || !Number.isFinite(D.bbox[0])) continue;
      draws.push({ D, bbox: D.bbox, w: (D.bbox[2] - D.bbox[0]) / EMU_PX, h: (D.bbox[3] - D.bbox[1]) / EMU_PX, el: null, members, root: r });
      out.composites++;
    }
    // labels → nearest drawing (text boxes placed next to a drawing)
    for (const L of labels) {
      if (!L.box || L.text.length > 60) continue;
      const cx = (L.box[0] + L.box[2]) / 2, cy = (L.box[1] + L.box[3]) / 2;
      let best = null, bd = Infinity;
      for (const d of draws.slice(0, singles)) {
        const b = d.bbox;
        const dx = Math.max(b[0] - cx, 0, cx - b[2]), dy = Math.max(b[1] - cy, 0, cy - b[3]);
        const dist = Math.hypot(dx, dy) / Math.max(1, Math.min(b[2] - b[0], b[3] - b[1]));
        if (dist < bd) { bd = dist; best = d; }
      }
      if (best && bd < 0.6) (best.labels ||= []).push({ text: L.text, dist: bd });
    }
    draws.forEach((d, i) => {
      if (d.members) d.labels = draws[d.root].labels;
      const labs = (d.labels || []).sort((a, b) => a.dist - b.dist);
      out.drawings.push({
        slide: slideNo,
        index: i + 1,
        slideTitle,
        label: labs[0]?.text || "",
        labels: labs.map((l) => l.text),
        svg: d.pic ? d.pic.svg : toSvg(d.D, labs[0]?.text || slideTitle || name),
        w: d.w,
        h: d.h,
        raster: d.pic ? null : rasterItems(d.D),
        png: d.pic?.png || null,
        picture: d.pic ? (d.pic.vector ? "svg" : "bitmap") : null,
        hasRaster: d.pic ? !d.pic.vector : !!d.D.hasRaster,
        warnings: d.pic ? [] : [...d.D.warn],
        composite: d.members ? d.members.map((m) => m + 1) : undefined,
        ...(debug ? { node: d.el } : {}),
      });
    });
  });
  return out;
}

// ---------------------------------------------------------------- CLI ----------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, outDir, ...rest] = process.argv.slice(2);
  if (!file || !outDir) {
    console.log("usage: node tools/pptx2svg.mjs kit.pptx out-dir [--slides 3,4]");
    process.exit(1);
  }
  const si = rest.indexOf("--slides");
  const slides = si >= 0 ? rest[si + 1].split(",").map(Number) : null;
  const t0 = Date.now();
  const res = convertPptx(fs.readFileSync(file), { name: path.basename(file, ".pptx"), slides });
  fs.mkdirSync(outDir, { recursive: true });
  const meta = [];
  for (const d of res.drawings) {
    const f = `s${d.slide}-${d.index}.svg`;
    fs.writeFileSync(path.join(outDir, f), d.svg);
    meta.push({ file: f, slide: d.slide, index: d.index, slideTitle: d.slideTitle, label: d.label, labels: d.labels, w: +d.w.toFixed(1), h: +d.h.toFixed(1), warnings: d.warnings });
  }
  fs.writeFileSync(path.join(outDir, "drawings.json"), JSON.stringify({ title: res.title, slides: res.slides, skipped: res.skipped, drawings: meta }, null, 1));
  console.log(`${res.drawings.length} drawings from ${res.slides} slides → ${outDir} (${Date.now() - t0} ms)`, res.skipped);
}
