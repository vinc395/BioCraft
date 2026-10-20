// Text labels inside library icons. Many Servier and NIH drawings carry their own labels
// ("Esophagus", "Liver"…) with grey leader lines; these helpers find them so a figure can
// hide them (text, leader lines and their end dots, then crop to what is left) or turn them
// into ordinary text objects the user can reword, restyle or delete.
//
// The analysis runs once per icon in a hidden SVG host, where getBBox/getCTM give the
// icon's own (viewBox) coordinates.

const SVGNS = "http://www.w3.org/2000/svg";
const cache = new Map(); // asset id → analysis

/** Cheap check on the markup: does this icon contain text at all? */
export const hasLabels = (asset) => !!asset?.svg && asset.svg.includes("<text");

/**
 * {vb, hiddenVb, hiddenInner, textlessInner, labels:[{lines, x, y, w, h, fontSize, fill, fontFamily, bold, italic, align}]}
 * `hidden*` drops text, leader lines and their end dots; `textlessInner` drops only the text.
 */
export function labelInfo(assetId, asset) {
  let r = cache.get(assetId);
  if (!r) {
    r = analyse(asset);
    cache.set(assetId, r);
  }
  return r;
}

const SKIP = "defs, clipPath, mask, pattern, marker, symbol, text";

function analyse(asset) {
  const src = asset.svg;
  const open = src.indexOf(">", src.indexOf("<svg"));
  const vbm = src.slice(0, open).match(/viewBox="([^"]+)"/);
  const vb = vbm ? vbm[1].trim().split(/[\s,]+/).map(Number) : [0, 0, asset.w || 100, asset.h || 100];
  const plain = { vb, hiddenVb: vb, hiddenInner: null, textlessInner: null, labels: [] };
  const parsed = new DOMParser().parseFromString(src, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.nodeName !== "svg" || parsed.querySelector("parsererror")) return plain;

  // no viewBox on the host, so its user space *is* the icon's coordinate system
  const host = document.createElementNS(SVGNS, "svg");
  host.setAttribute("style", "position:absolute;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden;pointer-events:none");
  const g = document.createElementNS(SVGNS, "g");
  host.appendChild(g);
  for (const c of [...root.childNodes]) g.appendChild(document.importNode(c, true));
  // ids must not leak into (or collide with) the live page while we measure
  for (const e of g.querySelectorAll("[id]")) e.setAttribute("id", "lbl-" + e.getAttribute("id"));
  for (const e of g.querySelectorAll("*")) {
    for (const a of ["clip-path", "mask", "fill", "stroke", "filter", "style"]) {
      const v = e.getAttribute(a);
      if (v && v.includes("url(#")) e.setAttribute(a, v.replace(/url\(#/g, "url(#lbl-"));
    }
    for (const a of ["href", "xlink:href"]) {
      const v = e.getAttribute(a);
      if (v && v.startsWith("#")) e.setAttribute(a, "#lbl-" + v.slice(1));
    }
  }
  document.body.appendChild(host);
  try {
    const texts = [...g.querySelectorAll("text")].filter((t) => !t.parentElement.closest("defs, clipPath, mask, pattern, symbol"));
    if (!texts.length) return plain;
    const labels = mergeStacked(texts.map(readText).filter(Boolean));
    const diag = Math.hypot(vb[2], vb[3]);

    // leader lines: thin open strokes with one end at a label
    const remove = new Set(texts);
    const ends = [];
    const strokeOf = (e) => {
      const cs = getComputedStyle(e);
      return { stroke: cs.stroke, fill: cs.fill, width: parseFloat(cs.strokeWidth) || 1 };
    };
    const geom = [...g.querySelectorAll("path, line, polyline")].filter((e) => !e.closest(SKIP));
    for (const e of geom) {
      const st = strokeOf(e);
      if (!st.stroke || st.stroke === "none" || (st.fill && st.fill !== "none")) continue;
      if (e.tagName === "path" && ((e.getAttribute("d") || "").match(/[a-df-z]/gi) || []).length > 8) continue;
      const seg = ends2(e);
      if (!seg) continue;
      for (const lb of labels) {
        const tol = Math.max(lb.fontSize * 0.9, diag * 0.012);
        const d0 = distToBox(seg.a, lb), d1 = distToBox(seg.b, lb);
        if (Math.min(d0, d1) <= tol && seg.len >= lb.fontSize * 0.8 && seg.len <= diag * 0.8) {
          remove.add(e);
          ends.push({ p: d0 < d1 ? seg.b : seg.a, stroke: st.stroke, width: st.width * seg.scale });
          break;
        }
      }
    }
    // a leader drawn as two pieces (an elbow): same colour and width, starting where the first ends
    for (let pass = 0; pass < 2; pass++) {
      for (const e of geom) {
        if (remove.has(e)) continue;
        const st = strokeOf(e);
        if (!st.stroke || st.stroke === "none" || (st.fill && st.fill !== "none")) continue;
        if (e.tagName === "path" && ((e.getAttribute("d") || "").match(/[a-df-z]/gi) || []).length > 3) continue;
        const seg = ends2(e);
        if (!seg) continue;
        const hit = ends.find((en) => en.stroke === st.stroke && Math.abs(en.width - st.width * seg.scale) < 0.25 * en.width + 0.01 &&
          Math.min(dist(en.p, seg.a), dist(en.p, seg.b)) <= en.width * 1.5);
        if (hit) {
          remove.add(e);
          ends.push({ p: dist(hit.p, seg.a) < dist(hit.p, seg.b) ? seg.b : seg.a, stroke: st.stroke, width: hit.width });
        }
      }
    }
    // the small dot many leader lines end in
    const shapes = [...g.querySelectorAll("circle, ellipse, path, rect")].filter((e) => !e.closest(SKIP) && !remove.has(e));
    for (const e of shapes) {
      const cs = getComputedStyle(e);
      if (!cs.fill || cs.fill === "none") continue;
      const b = boxOf(e);
      if (!b) continue;
      const size = Math.hypot(b.w, b.h);
      const c = [b.x + b.w / 2, b.y + b.h / 2];
      for (const en of ends) {
        if (cs.fill === en.stroke && size <= Math.max(en.width * 8, diag * 0.02) && dist(c, en.p) <= size / 2 + en.width * 2) {
          remove.add(e);
          break;
        }
      }
    }

    const serialize = () => [...g.childNodes].map((c) => new XMLSerializer().serializeToString(c)).join("").replace(/\s?xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
    const unprefix = (s) => s.replace(/\bid="lbl-/g, 'id="').replace(/url\(#lbl-/g, "url(#").replace(/href="#lbl-/g, 'href="#');
    // text only
    for (const t of texts) t.remove();
    const textlessInner = unprefix(serialize());
    // text, leader lines and dots
    for (const e of remove) e.remove();
    const hiddenInner = unprefix(serialize());
    let hiddenVb = vb;
    try {
      const b = g.getBBox();
      if (b.width > 0 && b.height > 0) {
        const m = diag * 0.012;
        const x0 = Math.max(vb[0], b.x - m), y0 = Math.max(vb[1], b.y - m);
        const x1 = Math.min(vb[0] + vb[2], b.x + b.width + m), y1 = Math.min(vb[1] + vb[3], b.y + b.height + m);
        if (x1 - x0 > 1 && y1 - y0 > 1) hiddenVb = [x0, y0, x1 - x0, y1 - y0];
      }
    } catch {}
    return { vb, hiddenVb, hiddenInner, textlessInner, labels };
  } catch (e) {
    console.warn("label analysis failed", e);
    return plain;
  } finally {
    host.remove();
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distToBox([x, y], b) {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.w)), dy = Math.max(b.y - y, 0, y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

function xf(m, x, y) {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** Bounding box in icon coordinates. */
function boxOf(e) {
  try {
    const b = e.getBBox(), m = e.getCTM();
    if (!m) return null;
    const pts = [xf(m, b.x, b.y), xf(m, b.x + b.width, b.y), xf(m, b.x, b.y + b.height), xf(m, b.x + b.width, b.y + b.height)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  } catch {
    return null;
  }
}

/** End points and length of an open stroke, in icon coordinates. */
function ends2(e) {
  try {
    const L = e.getTotalLength();
    const m = e.getCTM();
    if (!(L > 0) || !m) return null;
    const p0 = e.getPointAtLength(0), p1 = e.getPointAtLength(L);
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    return { a: xf(m, p0.x, p0.y), b: xf(m, p1.x, p1.y), len: L * scale, scale };
  } catch {
    return null;
  }
}

/** One label: its lines of text, box and font, in icon coordinates. */
function readText(t) {
  const box = boxOf(t);
  if (!box || !box.w || !box.h) return null;
  const m = t.getCTM();
  const scale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1;
  // leaf runs (tspans without tspans inside, or the text itself)
  const leaves = [...t.querySelectorAll("tspan")].filter((s) => !s.querySelector("tspan") && s.textContent.length);
  const runs = (leaves.length ? leaves : [t]).map((s) => ({ s, b: boxOf(s) || box, txt: s.textContent }));
  const first = runs[0].s;
  const cs = getComputedStyle(first);
  const fontSize = (parseFloat(cs.fontSize) || box.h / 1.2) * scale;
  // group runs into lines by their vertical centre
  const lines = [];
  for (const r of runs.sort((a, b) => a.b.y + a.b.h / 2 - (b.b.y + b.b.h / 2) || a.b.x - b.b.x)) {
    const cy = r.b.y + r.b.h / 2;
    let ln = lines.find((l) => Math.abs(l.cy - cy) < fontSize * 0.45);
    if (!ln) lines.push((ln = { cy, runs: [] }));
    ln.runs.push(r);
  }
  lines.sort((a, b) => a.cy - b.cy);
  const text = lines.map((l) => {
    l.runs.sort((a, b) => a.b.x - b.b.x);
    let s = "";
    l.runs.forEach((r, i) => {
      const prev = l.runs[i - 1];
      if (prev && r.b.x - (prev.b.x + prev.b.w) > fontSize * 0.2 && !/\s$/.test(s) && !/^\s/.test(r.txt)) s += " ";
      s += r.txt;
    });
    return s.replace(/\s+/g, " ").trim();
  }).filter(Boolean);
  if (!text.length) return null;
  const anchor = getComputedStyle(t).textAnchor || cs.textAnchor;
  const weight = parseInt(cs.fontWeight, 10) || (cs.fontWeight === "bold" ? 700 : 400);
  return {
    lines: text, x: box.x, y: box.y, w: box.w, h: box.h, fontSize,
    fill: toHex(cs.fill) || "#1c2733",
    fontFamily: (cs.fontFamily || "Arial").split(",")[0].replace(/["']/g, "").trim() || "Arial",
    bold: weight >= 600, italic: cs.fontStyle === "italic",
    align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
  };
}

/** One label per block: lines stacked under each other (same font, aligned) were often drawn as separate texts. */
function mergeStacked(labels) {
  const out = [];
  for (const lb of [...labels].sort((a, b) => a.y - b.y)) {
    const fs = lb.fontSize;
    const key = (l) => (l.align === "center" ? l.x + l.w / 2 : l.align === "right" ? l.x + l.w : l.x);
    const g = out.find((o) => Math.abs(o.fontSize - fs) < fs * 0.08 && o.fill === lb.fill && o.align === lb.align &&
      Math.abs(key(o) - key(lb)) < fs * 0.7 && lb.y - (o.y + o.h) < fs * 0.6 && lb.y > o.y + o.h * 0.5);
    if (!g) {
      out.push({ ...lb, lines: [...lb.lines] });
      continue;
    }
    g.lines.push(...lb.lines);
    const x1 = Math.max(g.x + g.w, lb.x + lb.w), y1 = Math.max(g.y + g.h, lb.y + lb.h);
    g.x = Math.min(g.x, lb.x);
    g.w = x1 - g.x;
    g.h = y1 - g.y;
  }
  return out;
}

function toHex(c) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || "");
  if (!m) return /^#[0-9a-f]{6}$/i.test(c || "") ? c : null;
  return "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join("");
}
