// People and human-body anatomy, Servier-like (soft) and NIH-BioArt-like (line).
//
// Figures are built in "head units" (hu): an adult is 7.5 hu tall (crown y=0, sole y=7.5), x=0 is the
// midline. Body proportions come from standard figure-drawing canons and adult anthropometry:
// chin 1.0, jugular notch ~1.35, nipples 2.0, navel ~3.0, pubis ~3.75, knee ~5.45, ankle ~7.1.
// Skin, hair, clothing, shoes and accessories are separate parts (one colour each) so users can
// recolour skin tone, hair and clothes like in BioRender. Faces are minimal (eyes, brows, nose, mouth).
// Every scene is translated so its drawing sits 9 units inside the art box (fit()).
import { circle, ellipse, rect, capsule, smoothClosed, smoothOpen, polygon, rotate, rotatePts, rng, f } from "../lib/geom.mjs";
import { shade, tint, pathBox } from "../lib/style.mjs";
import { assertInside, fitInside, inFrame, vary, flatten, insideShape, edgeDistance, clustered } from "../lib/organic.mjs";

/* ---------------- palette ---------------- */

const SKIN = { fair: "#f6d9c6", light: "#f2cdb4", medium: "#dca57f", tan: "#c68a63", brown: "#a56b4a", deep: "#7d4e37" };
const HAIR = { brown: "#8a5a3c", dark: "#55402f", black: "#3f3430", blonde: "#e2b866", auburn: "#a95a3b", grey: "#cdd2d8" };
const EYE = "#3a2f2c";
const LIP = "#bf6f61";
const COAT = "#f2f5f8"; // white coat (never pure white)
const STETH = "#3f4a57"; // stethoscope tubing
const METAL = "#b9c3cc";

/* ---------------- path utilities ---------------- */

/** Translate absolute path data (M L H V C Q Z). */
function moveD(d, dx, dy) {
  const toks = d.match(/[MLHVCQZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
  let out = "", cmd = "", k = 0;
  for (const t of toks) {
    if (/[a-z]/i.test(t)) { cmd = t.toUpperCase(); k = 0; out += cmd; continue; }
    let v = parseFloat(t);
    if (cmd === "H") v += dx;
    else if (cmd === "V") v += dy;
    else v += k % 2 === 0 ? dx : dy;
    k++;
    out += (/[\d.]$/.test(out) ? " " : "") + f(v);
  }
  return out;
}

/** Shift all parts so the drawing sits `margin` inside the art box; returns the scene. */
function fit(parts, { margin = 9, lineWidth = 1.5, minW = 0, minH = 0 } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) {
    const ds = p.unite ? p.unite : Array.isArray(p.d) ? p.d : [p.d];
    const sw = p.stroke ? p.stroke.width / 2 : 0;
    for (const d of ds) {
      const b = pathBox(d);
      x0 = Math.min(x0, b.x - sw); y0 = Math.min(y0, b.y - sw);
      x1 = Math.max(x1, b.x + b.w + sw); y1 = Math.max(y1, b.y + b.h + sw);
    }
  }
  const W = Math.max(minW, Math.ceil(x1 - x0 + 2 * margin)), H = Math.max(minH, Math.ceil(y1 - y0 + 2 * margin));
  const dx = (W - (x1 - x0)) / 2 - x0, dy = (H - (y1 - y0)) / 2 - y0;
  const mv = (d) => moveD(d, dx, dy);
  const out = parts.map((p) => {
    const q = { ...p };
    if (p.unite) q.unite = p.unite.map(mv);
    else q.d = Array.isArray(p.d) ? p.d.map(mv) : mv(p.d);
    return q;
  });
  return { size: [W, H], lineWidth, parts: out };
}

/** Right half outline (top centre → around the +x side → bottom centre) → full closed loop. */
const mirrorLoop = (half) => [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
const mx = (pts) => pts.map(([x, y]) => [-x, y]);
/** Mirror limb keys (x → −x); the left/right-of-travel widths swap so limb(mxK(k)) outlines mx(limb(k)). */
const mxK = (keys) => keys.map((k) => ({ p: [-k.p[0], k.p[1]], a: k.b, b: k.a }));
const lerp = (a, b, t) => a + (b - a) * t;
const ellPts = (cx, cy, rx, ry, n = 12, rot = 0) =>
  Array.from({ length: n }, (_, i) => rotate([cx + Math.cos((i / n) * 2 * Math.PI) * rx, cy + Math.sin((i / n) * 2 * Math.PI) * ry], cx, cy, rot));

/** Catmull-Rom sampling of limb key points; widths a (left of travel) and b (right of travel) interpolate. */
function spine(keys, per = 6) {
  const out = [], n = keys.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = keys[Math.max(0, i - 1)].p, p1 = keys[i].p, p2 = keys[i + 1].p, p3 = keys[Math.min(n - 1, i + 2)].p;
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ p: [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])], a: lerp(keys[i].a, keys[i + 1].a, t), b: lerp(keys[i].b, keys[i + 1].b, t) });
    }
  }
  out.push({ ...keys[n - 1] });
  return out;
}
const K = (x, y, a, b = a) => ({ p: [x, y], a, b });

/** Closed outline points of a limb along `keys`; `from`/`to` cut it (fractions), caps round the ends. */
function limb(keys, { per = 6, capA = 0.6, capB = 0.6, grow = 0, from = 0, to = 1 } = {}) {
  let s = spine(keys, per);
  const i0 = Math.round(from * (s.length - 1)), i1 = Math.round(to * (s.length - 1));
  s = s.slice(i0, i1 + 1);
  const L = [], R = [];
  const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  for (let i = 0; i < s.length; i++) {
    const [tx, ty] = unit(s[Math.max(0, i - 1)].p, s[Math.min(s.length - 1, i + 1)].p);
    const nx = -ty, ny = tx, wa = s[i].a + grow, wb = s[i].b + grow;
    L.push([s[i].p[0] + nx * wa, s[i].p[1] + ny * wa]);
    R.push([s[i].p[0] - nx * wb, s[i].p[1] - ny * wb]);
  }
  const e = s[s.length - 1], te = unit(s[s.length - 2].p, e.p);
  const b0 = s[0], tb = unit(s[1].p, b0.p);
  const capE = capB ? [[e.p[0] + te[0] * capB * (e.a + e.b + 2 * grow) / 2, e.p[1] + te[1] * capB * (e.a + e.b + 2 * grow) / 2]] : [];
  const capS = capA ? [[b0.p[0] + tb[0] * capA * (b0.a + b0.b + 2 * grow) / 2, b0.p[1] + tb[1] * capA * (b0.a + b0.b + 2 * grow) / 2]] : [];
  return [...L, ...capE, ...R.reverse(), ...capS];
}
/** Point on a limb spine at fraction t. */
function along(keys, t, per = 6) {
  const s = spine(keys, per);
  return s[Math.round(t * (s.length - 1))];
}

/* ---------------- body proportions (right half, hu) ---------------- */

const BODIES = {
  male: {
    head: [[0, 0], [0.19, 0.03], [0.3, 0.14], [0.345, 0.33], [0.34, 0.52], [0.315, 0.68], [0.265, 0.83], [0.17, 0.94], [0.07, 0.995], [0, 1]],
    ear: [0.345, 0.56, 0.06, 0.115], neck: 0.205, neckY: [0.72, 1.45],
    torso: [[0, 1.22], [0.21, 1.17], [0.45, 1.29], [0.72, 1.39], [0.86, 1.5], [0.86, 1.72], [0.76, 1.98], [0.72, 2.3], [0.66, 2.65], [0.63, 2.95], [0.66, 3.25], [0.72, 3.55], [0.7, 3.85], [0.35, 3.98], [0, 4]],
    arm: [K(0.8, 1.6, 0.17, 0.19), K(0.86, 2.0, 0.165, 0.17), K(0.92, 2.55, 0.14), K(0.95, 2.88, 0.12, 0.125), K(0.98, 3.2, 0.13, 0.14), K(1.02, 3.78, 0.085, 0.09)],
    hand: 0.72, handW: 1,
    leg: [K(0.37, 3.6, 0.36, 0.37), K(0.37, 4.3, 0.27, 0.31), K(0.34, 5.0, 0.2, 0.22), K(0.33, 5.45, 0.165, 0.175), K(0.34, 5.95, 0.21, 0.18), K(0.34, 6.6, 0.135, 0.13), K(0.34, 7.1, 0.09)],
    foot: 1, sole: 7.5,
  },
  female: {
    head: [[0, 0], [0.18, 0.03], [0.29, 0.14], [0.33, 0.33], [0.325, 0.52], [0.3, 0.68], [0.245, 0.83], [0.14, 0.945], [0.06, 0.99], [0, 0.995]],
    ear: [0.33, 0.56, 0.055, 0.105], neck: 0.165, neckY: [0.72, 1.45],
    torso: [[0, 1.24], [0.17, 1.2], [0.4, 1.3], [0.64, 1.39], [0.76, 1.5], [0.75, 1.7], [0.66, 1.95], [0.665, 2.15], [0.6, 2.45], [0.52, 2.75], [0.56, 3.0], [0.72, 3.35], [0.8, 3.62], [0.77, 3.88], [0.38, 4.0], [0, 4.02]],
    arm: [K(0.7, 1.6, 0.15, 0.16), K(0.76, 2.0, 0.145, 0.135), K(0.81, 2.5, 0.12), K(0.85, 2.85, 0.1, 0.105), K(0.89, 3.15, 0.115, 0.12), K(0.95, 3.75, 0.075, 0.08)],
    hand: 0.68, handW: 0.88,
    leg: [K(0.4, 3.6, 0.38, 0.4), K(0.38, 4.3, 0.27, 0.33), K(0.32, 5.0, 0.18, 0.21), K(0.29, 5.45, 0.15, 0.16), K(0.3, 5.95, 0.19, 0.16), K(0.31, 6.6, 0.12, 0.115), K(0.32, 7.1, 0.08)],
    foot: 0.88, sole: 7.45,
  },
  neutral: {
    head: [[0, 0], [0.185, 0.03], [0.295, 0.14], [0.338, 0.33], [0.333, 0.52], [0.308, 0.68], [0.255, 0.83], [0.155, 0.945], [0.065, 0.993], [0, 0.998]],
    ear: [0.338, 0.56, 0.057, 0.11], neck: 0.185, neckY: [0.72, 1.45],
    torso: [[0, 1.23], [0.19, 1.18], [0.42, 1.3], [0.68, 1.39], [0.8, 1.5], [0.8, 1.72], [0.71, 1.98], [0.69, 2.3], [0.62, 2.68], [0.6, 2.95], [0.64, 3.25], [0.72, 3.55], [0.72, 3.85], [0.36, 3.98], [0, 4]],
    arm: [K(0.75, 1.6, 0.16, 0.175), K(0.81, 2.0, 0.15, 0.15), K(0.86, 2.55, 0.13), K(0.89, 2.87, 0.11, 0.115), K(0.93, 3.17, 0.12, 0.13), K(0.98, 3.77, 0.08, 0.085)],
    hand: 0.7, handW: 0.94,
    leg: [K(0.38, 3.6, 0.37, 0.37), K(0.37, 4.3, 0.27, 0.31), K(0.33, 5.0, 0.19, 0.21), K(0.31, 5.45, 0.155, 0.165), K(0.32, 5.95, 0.2, 0.17), K(0.33, 6.6, 0.125, 0.12), K(0.33, 7.1, 0.085)],
    foot: 0.94, sole: 7.48,
  },
  child: { // ~7 years: about 6.2 heads tall, short legs, round face, narrow shoulders
    head: [[0, 0], [0.2, 0.03], [0.32, 0.15], [0.36, 0.36], [0.352, 0.55], [0.315, 0.72], [0.24, 0.865], [0.13, 0.955], [0, 0.99]],
    ear: [0.355, 0.57, 0.06, 0.11], neck: 0.15, neckY: [0.75, 1.3],
    torso: [[0, 1.12], [0.15, 1.07], [0.38, 1.16], [0.6, 1.25], [0.7, 1.36], [0.69, 1.58], [0.61, 1.8], [0.6, 2.1], [0.585, 2.4], [0.6, 2.65], [0.62, 2.9], [0.6, 3.12], [0.3, 3.2], [0, 3.22]],
    arm: [K(0.63, 1.44, 0.13, 0.14), K(0.69, 1.85, 0.12), K(0.73, 2.3, 0.1), K(0.755, 2.55, 0.105), K(0.79, 2.95, 0.075)],
    hand: 0.56, handW: 0.82,
    // thigh → slim knee (4.2) → calf bulge (4.65) → ankle
    leg: [K(0.3, 2.95, 0.3, 0.3), K(0.3, 3.5, 0.22, 0.24), K(0.295, 3.92, 0.155, 0.165), K(0.29, 4.2, 0.122, 0.128), K(0.29, 4.42, 0.145, 0.145), K(0.293, 4.65, 0.162, 0.155), K(0.29, 5.0, 0.128, 0.122), K(0.29, 5.4, 0.094), K(0.29, 5.78, 0.08)],
    foot: 0.85, sole: 6.15,
  },
  older: { // ~7.2 heads: height loss, rounded shoulders, softer waist, slightly flexed knees
    head: [[0, 0], [0.19, 0.03], [0.3, 0.14], [0.345, 0.33], [0.34, 0.52], [0.315, 0.68], [0.27, 0.83], [0.175, 0.945], [0.075, 0.995], [0, 1]],
    ear: [0.35, 0.57, 0.065, 0.13], neck: 0.2, neckY: [0.74, 1.42],
    torso: [[0, 1.2], [0.21, 1.15], [0.45, 1.3], [0.7, 1.43], [0.82, 1.56], [0.83, 1.76], [0.75, 2.0], [0.72, 2.3], [0.7, 2.65], [0.69, 2.95], [0.7, 3.25], [0.72, 3.5], [0.7, 3.78], [0.35, 3.9], [0, 3.92]],
    arm: [K(0.77, 1.65, 0.17, 0.18), K(0.84, 2.05, 0.155, 0.16), K(0.9, 2.55, 0.13), K(0.94, 2.86, 0.115, 0.12), K(0.98, 3.17, 0.125, 0.13), K(1.03, 3.72, 0.085, 0.09)],
    hand: 0.72, handW: 1,
    leg: [K(0.36, 3.5, 0.36, 0.37), K(0.37, 4.2, 0.27, 0.31), K(0.35, 4.85, 0.2, 0.22), K(0.34, 5.27, 0.17, 0.18), K(0.34, 5.75, 0.2, 0.18), K(0.34, 6.4, 0.13), K(0.34, 6.88, 0.09)],
    foot: 1, sole: 7.25,
  },
};

/** Hanging hand (front view, palm toward the thigh, thumb forward-medial) from the wrist point; side +1 right, −1 left. */
function handHang(w, len, side = 1, sw = 1) {
  const [x, y] = w;
  const pts = [[-0.085, -0.08], [0.09, -0.08], [0.115, 0.15], [0.12, 0.36], [0.1, 0.56], [0.06, 0.68], [0.0, 0.72], [-0.05, 0.66], [-0.075, 0.5], [-0.1, 0.42], [-0.13, 0.32], [-0.12, 0.2], [-0.095, 0.08]];
  return pts.map(([a, b]) => [x + side * a * sw, y + (b * len) / 0.72]);
}

/** A loose fist (hand round a cane or a handle), front view, from the wrist point. */
function handFist(w, side = 1) {
  const [x, y] = w;
  return [[-0.09, -0.08], [0.09, -0.08], [0.125, 0.1], [0.135, 0.28], [0.11, 0.41], [0.02, 0.46], [-0.07, 0.44], [-0.12, 0.36], [-0.135, 0.22], [-0.115, 0.06]].map(([a, b]) => [x + side * a, y + b]);
}

/** Shoe or bare foot, front view, from the ankle centre; toes point slightly outward. */
function footFront(a, side = 1, s = 1, sole) {
  const [x, y] = a;
  const h = sole - y;
  const pts = [[-0.11, -0.1], [0.11, -0.1], [0.15, 0.25], [0.22, 0.5], [0.25, 0.75], [0.22, 0.95], [0.12, 1], [-0.1, 1], [-0.17, 0.93], [-0.175, 0.65], [-0.15, 0.3]];
  return pts.map(([u, v]) => [x + side * u * s, y + v * (h + 0.04)]);
}

/* ---------------- standing figure builder ---------------- */

const U = 37.6; // px per head unit for adult figures (7.5 hu ≈ 282 px)

/**
 * Standing front-view person. Returns {parts, X, B, geo} where parts are in drawing order and named
 * (layer field) so icons can splice accessories in. o: {body, skin, hair:{style,color}, top, bottom, shoes, ...}
 */
function standing(o) {
  const B = BODIES[o.body];
  const u = o.u ?? U;
  const X = (pts) => pts.map(([x, y]) => [x * u, y * u]);
  const S = (pts) => smoothClosed(X(pts));
  const SO = (pts) => smoothOpen(X(pts));
  const parts = [];
  const add = (layer, part) => parts.push({ layer, ...part });
  const skin = o.skin, hairC = o.hair.color;

  const armR = o.armR ?? B.arm, armL = o.armL ?? B.arm;
  const wristR = armR[armR.length - 1].p, wristL = armL[armL.length - 1].p;
  const legEnd = B.leg[B.leg.length - 1].p;
  const handR = o.handR ?? handHang(wristR, B.hand, 1, B.handW);
  const handL = o.handL ?? mx(handHang(wristL, B.hand, 1, B.handW));
  const footR = footFront(legEnd, 1, B.foot, B.sole), footL = mx(footR);
  const geo = { wristR, wristL, legEnd, handR, handL };

  // hair behind the head (long styles)
  if (o.hair.back) add("hairBack", { d: S(o.hair.back), fill: hairC, shade: "organelle", gloss: false });

  // legs: skin shows below skirts and shorts; a narrow light band down each leg's lit (left) side instead of the
  // library's inset highlight (which spreads over most of a thin limb)
  if (o.bottom.style !== "trousers") {
    add("legs", { d: [S(limb(B.leg, { capA: 0, capB: 0.3 })), S(mx(limb(B.leg, { capA: 0, capB: 0.3 })))], fill: skin, shade: "organelle", gloss: false, highlight: false });
    add("legsHi", { d: [B.leg, mxK(B.leg)].flatMap((k) => tubeBands(k, { kind: "hi", frac: 0.22, from: 0.3, to: 0.97 })).map(S), fill: tint(skin, 0.12), opacity: 0.85, line: false });
  }
  // bottoms
  const bc = o.bottom.color;
  if (o.bottom.style === "trousers") {
    const tk = o.bottom.keys ?? trouserKeys(B, o.top.half);
    add("bottom", { d: [S(limb(tk, { capA: 0, capB: 0 })), S(mx(limb(tk, { capA: 0, capB: 0 })))], fill: bc, shade: "body", gloss: false });
  } else if (o.bottom.style === "shorts") {
    const tk = o.bottom.keys ?? trouserKeys(B, o.top.half);
    add("bottom", { d: [S(limb(tk, { capA: 0, capB: 0, to: o.bottom.to ?? 0.42 })), S(mx(limb(tk, { capA: 0, capB: 0, to: o.bottom.to ?? 0.42 })))], fill: bc, shade: "body", gloss: false });
  } else if (o.bottom.style === "skirt") {
    add("bottom", { d: S(mirrorLoop(o.bottom.half)), fill: bc, shade: "body", gloss: false });
  }
  // shoes
  add("shoes", { d: [S(footR), S(footL)], fill: o.shoes, shade: "organelle", gloss: false });

  // hands (and bare forearms for short sleeves)
  // arms: [arm keys (right-side coords), hand (final coords), mirror]; o.skip: ["L"|"R"] lets an icon pose that arm itself
  const sides = [["R", armR, handR, (q) => q], ["L", armL, handL, mx]].filter(([k]) => !(o.skip || []).includes(k));
  if (o.top.sleeve === "short") {
    for (const [, arm, hand, m] of sides) add("arms", { unite: [S(m(limb(arm, { capA: 0.4, capB: 0, from: 0.15 }))), S(hand)], fill: skin, shade: "organelle", gloss: false });
  } else {
    add("hands", { d: sides.map(([, , hand]) => S(hand)), fill: o.handFill ?? skin, shade: "organelle", gloss: false });
  }

  // neck (a touch darker: it sits in the shadow of the jaw): a straight column ending in a U that the garment's
  // neckline hides — never wider than the neck, so nothing bulges past the shoulder line
  const nw = B.neck, [ny0, ny1] = B.neckY;
  const vd = o.vDepth ?? 0;
  const neckHalf = [[nw, ny0], [nw, ny1 - 0.3], [nw * 0.97, ny1 - 0.16], [nw * 0.78, ny1 + vd * 0.6], [0, ny1 + 0.16 + vd]];
  add("neck", { d: S([...neckHalf, ...rev(mx(neckHalf)).slice(1)]), fill: shade(skin, 0.04), shade: "rim" });

  // top garment: torso and sleeves are ONE united silhouette (smooth neck → trapezius → deltoid → arm line);
  // the armhole seam is a thin line and each sleeve gets a straight light band down its lit side
  const sTo = o.top.sleeve === "short" ? 0.4 : o.top.sleeve === "three-quarter" ? 0.75 : 0.955;
  const ownSleeves = !o.top.sleeveColor || o.top.sleeveColor === o.top.color;
  const sleeveArms = sides.map(([, arm, , m]) => ({ keys: arm, m, to: sTo }));
  const sleevesD = sleeveArms.map(({ keys, m, to }) => S(m(limb(keys, { capA: 0.6, capB: 0, to, grow: 0.03 }))));
  const topHalf = shoulderFix(o.top.half, null, armR[0]);
  add("top", { unite: [S(mirrorLoop(topHalf)), ...(ownSleeves ? sleevesD : []), ...(o.top.extraUnite || [])], fill: o.top.color, shade: "body", gloss: false, highlight: false });
  if (o.top.extra) for (const e of o.top.extra) add("topExtra", e);
  /** Seam + light band for sleeves (list of {keys, m, to}) in `color`; the seam runs from the sleeve cap down its
   * inner edge to where the arm leaves the torso outline (`torsoHalf`). */
  const sleeveDetails = (list, color, torsoHalf = o.top.half) => {
    const torso = [mirrorLoop(torsoHalf)];
    const seams = [], his = [];
    for (const { keys, m, to } of list) {
      const lp = limb(keys, { capA: 0.6, capB: 0, to, grow: 0.03 });
      const n = Math.round(to * (spine(keys).length - 1)) + 1; // inner (medial) edge = first n points
      const inner = lp.slice(0, n);
      let j = inner.findIndex((p) => !insideShape(torso, p));
      if (j < 0) j = inner.length;
      seams.push(SO(m([lp.at(-1), ...inner.slice(0, Math.max(2, j + 1))])));
      const g = keys.map((k) => ({ ...k, a: k.a + 0.03, b: k.b + 0.03 }));
      his.push(...tubeBands(m === mx ? mxK(g) : g, { kind: "hi", frac: 0.2, from: 0.22, to: to - 0.03 }));
    }
    return [
      { layer: "sleeveSeam", d: seams, fill: "none", stroke: { color: shade(color, 0.12), width: 0.022 * u, cap: "round" }, lineStrokeWidth: 0.02 * u },
      { layer: "sleeveHi", d: his.map(S), fill: tint(color, 0.1), opacity: 0.85, line: false },
    ];
  };
  if (ownSleeves) parts.push(...sleeveDetails(sleeveArms, o.top.color));

  // head + ears
  const [ex, ey, erx, ery] = B.ear;
  add("head", { unite: [S(mirrorLoop(B.head)), S(ellPts(ex, ey, erx, ery, 10)), S(ellPts(-ex, ey, erx, ery, 10))], fill: skin, shade: "body", gloss: false });

  // face
  const fy = o.faceY ?? 0;
  add("eyes", { d: [S(ellPts(0.125, 0.52 + fy, 0.028, 0.036, 8)), S(ellPts(-0.125, 0.52 + fy, 0.028, 0.036, 8))], fill: EYE });
  add("brows", { d: [SO([[0.07, 0.445 + fy], [0.13, 0.425 + fy], [0.195, 0.44 + fy]]), SO([[-0.07, 0.445 + fy], [-0.13, 0.425 + fy], [-0.195, 0.44 + fy]])], fill: "none", stroke: { color: o.browColor ?? shade(hairC, 0.08), width: 0.032 * u, cap: "round" }, lineStrokeWidth: 0.026 * u });
  add("nose", { d: SO([[0.015, 0.56 + fy], [0.04, 0.66 + fy], [0.0, 0.685 + fy]]), fill: "none", stroke: { color: shade(skin, 0.16), width: 0.022 * u, cap: "round" }, lineStrokeWidth: 0.02 * u });
  add("mouth", { d: SO([[-0.075, 0.785 + fy], [0, 0.808 + fy], [0.075, 0.785 + fy]]), fill: "none", stroke: { color: LIP, width: 0.026 * u, cap: "round" }, lineStrokeWidth: 0.022 * u });

  // hair (long styles: rim only — an inset highlight on locks that frame the face would veil the face)
  if (o.hair.front) add("hair", { ...(Array.isArray(o.hair.front[0][0]) ? { unite: o.hair.front.map(S) } : { d: S(o.hair.front) }), fill: hairC, shade: o.hair.rimOnly ? "rim" : "organelle", gloss: false });
  if (o.hair.strands) add("hairStrands", { d: o.hair.strands.map(SO), fill: "none", stroke: { color: tint(hairC, 0.15), width: 0.018 * u, cap: "round" }, line: false });

  return { parts, X, S, SO, B, u, geo, sleevesD, sleeveArms, sleeveDetails, sTo };
}

/**
 * Smooth shoulder for a garment outline: the trapezius line poly[i1] → poly[i1+1] continues straight to its
 * tangent point on a deltoid arc (a circle round the arm's first key, lowered until it touches that line, radius
 * = the sleeve's lateral half-width), follows the arc to the sleeve's outer edge, and drops the old lateral
 * shoulder corners. United with the sleeve this gives one neck → trapezius → deltoid → arm contour.
 */
function shoulderFix(poly, i1, k0, grow = 0.03) {
  if (i1 == null) { // trapezius point: the top-edge point nearest 0.3 hu medial of the shoulder joint
    const iMax = poly.reduce((b, p, i) => (p[0] > poly[b][0] ? i : b), 0);
    i1 = 0;
    for (let i = 1; i < iMax; i++) if (Math.abs(poly[i][0] - (k0.p[0] - 0.3)) < Math.abs(poly[i1][0] - (k0.p[0] - 0.3))) i1 = i;
  }
  const T1 = poly[i1], T2 = poly[i1 + 1];
  const s = (T2[1] - T1[1]) / (T2[0] - T1[0]);
  const R = k0.b + grow, cx = k0.p[0];
  const cy = k0.p[1] + R * Math.hypot(1, s) - (k0.p[1] - T1[1] - s * (cx - T1[0]));
  const f0 = -Math.PI / 2 + Math.atan(s);
  const arc = Array.from({ length: 6 }, (_, i) => { const a = f0 * (1 - i / 5); return [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  let j = i1 + 2;
  while (j < poly.length && poly[j][1] <= cy + 0.05) j++;
  return [...poly.slice(0, i1 + 1), ...arc, ...poly.slice(j)];
}

/** Lateral half-width of a right-half garment outline at height y (−Infinity if y is outside it). */
function halfWidthAt(half, y) {
  let best = -Infinity;
  for (let i = 0; i < half.length - 1; i++) {
    const [x0, y0] = half[i], [x1, y1] = half[i + 1];
    if (y0 !== y1 && (y - y0) * (y - y1) <= 0) best = Math.max(best, x0 + ((x1 - x0) * (y - y0)) / (y1 - y0));
  }
  return best;
}

/**
 * Straight-cut trouser legs from the waist (under the top) to just above the shoe. With the top garment's half
 * outline, the hip keys are narrowed so the trousers never stick out past the garment above or at its hem.
 */
function trouserKeys(B, topHalf = null) {
  const L = B.leg;
  const end = L[L.length - 1].p, knee = L[3].p;
  const keys = [K(L[0].p[0] - 0.06, L[0].p[1] - 0.6, L[0].a - 0.04, L[0].b - 0.1), K(L[0].p[0], L[0].p[1], L[0].a + 0.02, L[0].b + 0.03), K(L[1].p[0], L[1].p[1], L[1].a + 0.03, L[1].b + 0.03),
    K(knee[0], knee[1], 0.2, 0.21), K(end[0], end[1] + 0.02, 0.17, 0.18)];
  if (!topHalf) return keys;
  const mxX = Math.max(...topHalf.map((p) => p[0]));
  const corner = [...topHalf].reverse().find((p) => p[0] > 0.6 * mxX); // lateral end of the hem
  for (const k of keys) {
    const y = k.p[1];
    const lim = y <= corner[1] ? halfWidthAt(topHalf, y) : y <= corner[1] + 0.1 ? corner[0] : Infinity;
    if (Number.isFinite(lim)) k.b = Math.min(k.b, lim - 0.03 - k.p[0]);
  }
  return keys;
}

/** Insert parts after the last part of `layer`. */
function insertAfter(parts, layer, extra) {
  let i = -1;
  parts.forEach((p, k) => { if (p.layer === layer) i = k; });
  parts.splice(i + 1, 0, ...extra);
  return parts;
}

/* ---------------- hairstyles (head coordinates: crown y=0, chin y=1) ---------------- */

const HAIRSTYLE = {
  short: { front: [[0, -0.075], [0.2, -0.045], [0.33, 0.06], [0.385, 0.22], [0.375, 0.4], [0.355, 0.52], [0.322, 0.5], [0.315, 0.36], [0.27, 0.25], [0.16, 0.2], [0.03, 0.18], [-0.12, 0.155], [-0.24, 0.2], [-0.31, 0.3], [-0.322, 0.5], [-0.355, 0.52], [-0.375, 0.4], [-0.385, 0.22], [-0.33, 0.06], [-0.2, -0.045]] },
  long: {
    back: [[0, -0.07], [0.27, -0.03], [0.41, 0.14], [0.45, 0.45], [0.46, 0.9], [0.5, 1.35], [0.53, 1.78], [0.44, 1.98], [0.22, 1.9], [0, 1.82], [-0.22, 1.9], [-0.44, 1.98], [-0.53, 1.78], [-0.5, 1.35], [-0.46, 0.9], [-0.45, 0.45], [-0.41, 0.14], [-0.27, -0.03]],
    front: [[0, -0.075], [0.25, -0.04], [0.385, 0.1], [0.425, 0.35], [0.43, 0.72], [0.45, 1.1], [0.5, 1.5], [0.47, 1.86], [0.39, 1.8], [0.345, 1.4], [0.322, 0.95], [0.325, 0.6], [0.31, 0.33], [0.2, 0.19], [0.06, 0.15], [0.0, 0.09], [-0.06, 0.15], [-0.2, 0.19], [-0.31, 0.33], [-0.325, 0.6], [-0.322, 0.95], [-0.345, 1.4], [-0.39, 1.8], [-0.47, 1.86], [-0.5, 1.5], [-0.45, 1.1], [-0.43, 0.72], [-0.425, 0.35], [-0.385, 0.1], [-0.25, -0.04]],
    // light strand streaks from the parting down the lit (viewer's left) side only
    strands: [[[-0.04, -0.03], [-0.18, 0.0], [-0.3, 0.08], [-0.37, 0.22], [-0.39, 0.45], [-0.395, 0.75], [-0.42, 1.05]], [[-0.1, 0.06], [-0.22, 0.12], [-0.3, 0.22], [-0.35, 0.4], [-0.355, 0.62]], [[-0.4, 1.2], [-0.445, 1.48], [-0.44, 1.7]]],
  },
  tousled: { front: [[0, -0.1], [0.25, -0.07], [0.39, 0.06], [0.44, 0.27], [0.43, 0.5], [0.39, 0.64], [0.345, 0.6], [0.335, 0.42], [0.285, 0.29], [0.15, 0.25], [0.02, 0.28], [-0.12, 0.23], [-0.25, 0.2], [-0.325, 0.33], [-0.34, 0.58], [-0.39, 0.64], [-0.435, 0.48], [-0.445, 0.25], [-0.385, 0.05], [-0.22, -0.075]] },
  child: { front: [[0, -0.08], [0.22, -0.05], [0.36, 0.07], [0.41, 0.25], [0.4, 0.45], [0.37, 0.56], [0.34, 0.52], [0.33, 0.38], [0.27, 0.29], [0.17, 0.3], [0.08, 0.26], [-0.02, 0.3], [-0.12, 0.27], [-0.22, 0.3], [-0.31, 0.32], [-0.34, 0.52], [-0.37, 0.56], [-0.4, 0.45], [-0.41, 0.25], [-0.36, 0.07], [-0.22, -0.05]] },
  bald: { // older man: fringe of hair round the sides and back, thin crown
    front: [
      [[0.2, 0.06], [0.31, 0.15], [0.37, 0.3], [0.375, 0.47], [0.355, 0.55], [0.33, 0.5], [0.325, 0.36], [0.29, 0.22]],
      [[-0.2, 0.06], [-0.31, 0.15], [-0.37, 0.3], [-0.375, 0.47], [-0.355, 0.55], [-0.33, 0.5], [-0.325, 0.36], [-0.29, 0.22]],
    ],
  },
  bun: {
    front: [
      [[0, -0.065], [0.21, -0.035], [0.34, 0.08], [0.375, 0.27], [0.36, 0.48], [0.33, 0.5], [0.318, 0.36], [0.26, 0.24], [0.14, 0.19], [0.0, 0.16], [-0.14, 0.19], [-0.26, 0.24], [-0.318, 0.36], [-0.33, 0.5], [-0.36, 0.48], [-0.375, 0.27], [-0.34, 0.08], [-0.21, -0.035]],
      ellPts(0.02, -0.11, 0.17, 0.13, 12),
    ],
  },
};

/* ---------------- garments (right halves, hu) ---------------- */

const TOPS = {
  maleSweater: [[0, 1.3], [0.2, 1.21], [0.45, 1.29], [0.74, 1.4], [0.88, 1.52], [0.88, 1.74], [0.78, 2.0], [0.74, 2.3], [0.68, 2.7], [0.67, 3.0], [0.7, 3.3], [0.74, 3.58], [0.4, 3.62], [0, 3.63]],
  femaleTop: [[0, 1.42], [0.055, 1.36], [0.11, 1.297], [0.162, 1.238], [0.4, 1.31], [0.65, 1.4], [0.78, 1.52], [0.77, 1.72], [0.68, 1.96], [0.685, 2.16], [0.62, 2.45], [0.55, 2.74], [0.58, 2.95], [0.61, 3.08], [0.3, 3.1], [0, 3.1]],
  tee: [[0, 1.3], [0.19, 1.22], [0.42, 1.31], [0.69, 1.4], [0.82, 1.52], [0.82, 1.74], [0.73, 1.99], [0.72, 2.3], [0.66, 2.7], [0.65, 3.0], [0.69, 3.3], [0.74, 3.55], [0.4, 3.6], [0, 3.6]],
  childTee: [[0, 1.17], [0.15, 1.1], [0.38, 1.18], [0.61, 1.27], [0.72, 1.38], [0.71, 1.6], [0.63, 1.82], [0.63, 2.1], [0.62, 2.4], [0.635, 2.65], [0.66, 2.85], [0.3, 2.9], [0, 2.9]],
  scrubV: [[0, 1.72], [0.17, 1.22], [0.45, 1.29], [0.74, 1.4], [0.88, 1.52], [0.88, 1.74], [0.78, 2.0], [0.74, 2.3], [0.68, 2.7], [0.67, 3.0], [0.7, 3.3], [0.74, 3.58], [0.4, 3.62], [0, 3.63]],
  labCoat: [[0, 1.58], [0.15, 1.22], [0.4, 1.3], [0.65, 1.4], [0.79, 1.52], [0.79, 1.75], [0.7, 1.98], [0.7, 2.2], [0.69, 2.5], [0.69, 2.75], [0.73, 3.1], [0.81, 3.55], [0.86, 4.3], [0.89, 4.95], [0.45, 4.98], [0, 4.96]],
  oldShirt: [[0, 1.3], [0.2, 1.2], [0.45, 1.31], [0.72, 1.44], [0.85, 1.58], [0.86, 1.78], [0.77, 2.02], [0.75, 2.3], [0.73, 2.65], [0.72, 2.95], [0.73, 3.25], [0.75, 3.5], [0.4, 3.55], [0, 3.56]],
};

const femaleSkirt = [[0, 2.8], [0.5, 2.8], [0.55, 3.02], [0.72, 3.45], [0.8, 4.0], [0.84, 5.02], [0.6, 5.07], [0.3, 5.09], [0, 5.07]];

/* ---------------- icons: standing people ---------------- */

function personMale(style) {
  const fig = standing({
    body: "male", skin: SKIN.light, hair: { color: HAIR.brown, front: HAIRSTYLE.short.front },
    top: { half: TOPS.maleSweater, color: "#8fbde0" }, bottom: { style: "trousers", color: "#cbb593" }, shoes: "#4d5866",
  });
  // crew neck rib
  insertAfter(fig.parts, "top", [{ d: fig.SO([[-0.22, 1.215], [0, 1.31], [0.22, 1.215]]), fill: "none", stroke: { color: shade("#8fbde0", 0.12), width: 0.05 * U, cap: "round" }, lineStrokeWidth: 0.03 * U }]);
  return fit(fig.parts);
}

function personFemale(style) {
  const fig = standing({
    body: "female", skin: SKIN.tan, hair: { color: HAIR.dark, back: HAIRSTYLE.long.back, front: HAIRSTYLE.long.front, rimOnly: true, strands: HAIRSTYLE.long.strands },
    top: { half: TOPS.femaleTop, color: "#f0907f" }, bottom: { style: "skirt", half: femaleSkirt, color: "#4f6fa3" }, shoes: "#8c4a55",
  });
  return fit(fig.parts);
}

function personNeutral(style) {
  const fig = standing({
    body: "neutral", skin: SKIN.medium, hair: { color: HAIR.black, front: HAIRSTYLE.tousled.front },
    top: { half: TOPS.tee, color: "#e9c25c", sleeve: "short" }, bottom: { style: "trousers", color: "#4f7a80" }, shoes: "#e3e7eb",
  });
  return fit(fig.parts);
}

function personChild(style) {
  const fig = standing({
    body: "child", u: 33, skin: SKIN.fair, hair: { color: HAIR.blonde, front: HAIRSTYLE.child.front },
    top: { half: TOPS.childTee, color: "#f28b6b", sleeve: "short" }, bottom: { style: "shorts", color: "#6d93cf", to: 0.5 }, shoes: "#e3e7eb",
  });
  return fit(fig.parts);
}

function personOlder(style) {
  const fig = standing({
    body: "older", skin: SKIN.light, hair: { color: HAIR.grey, front: HAIRSTYLE.bald.front }, browColor: "#a9afb6",
    top: { half: TOPS.oldShirt, color: "#9fc0a6" }, bottom: { style: "trousers", color: "#8d939c" }, shoes: "#4f4a48",
    handL: mx(handFist(BODIES.older.arm.at(-1).p)),
  });
  const { S, SO, X } = fig;
  const card = "#9fc0a6", shirt = "#e6edf3", wood = "#9a6a45";
  const RP = (pts, r) => roundPoly(X(pts), r * U);
  // shirt in the cardigan's V-neck with two pointed collar tips, cardigan front edge, buttons
  insertAfter(fig.parts, "top", [
    { d: RP([[0, 1.86], [0.245, 1.2], [0.2, 1.165], [0, 1.2], [-0.2, 1.165], [-0.245, 1.2]], 0.02), fill: shirt, shade: "rim" },
    { d: [RP([[0.205, 1.15], [0.25, 1.2], [0.105, 1.4], [0.025, 1.235]], 0.012), RP([[-0.205, 1.15], [-0.025, 1.235], [-0.105, 1.4], [-0.25, 1.2]], 0.012)], fill: shirt, shade: "rim" },
    { d: SO([[0.24, 1.2], [0.1, 1.55], [0, 1.88], [0, 3.52]]), fill: "none", stroke: { color: shade(card, 0.14), width: 0.035 * U, cap: "round" }, lineStrokeWidth: 0.03 * U },
    { d: [2.15, 2.55, 2.95, 3.33].map((y) => S(ellPts(0.06, y, 0.035, 0.035, 8))), fill: "#e9dcc2", shade: "small" },
  ]);
  // walking cane in the right hand (viewer's left): crook handle curling out of the fist's lateral side, shaft
  // from the fist to the floor, rubber ferrule
  const top = [-1.05, 3.8], tip = [-1.2, 7.1];
  const crook = [[-1.05, 3.84], [-1.15, 3.8], [-1.24, 3.785], [-1.31, 3.82], [-1.335, 3.89], [-1.315, 3.955]];
  insertAfter(fig.parts, "shoes", [
    { unite: [capsule(...X([top])[0], ...X([tip])[0], 0.038 * U), S(tubePts(crook, 0.076))], fill: wood, shade: "small" },
    { d: S([[tip[0] - 0.055, tip[1] - 0.06], [tip[0] + 0.055, tip[1] - 0.06], [tip[0] + 0.06, tip[1] + 0.12], [tip[0] - 0.06, tip[1] + 0.12]]), fill: "#4f4a48", shade: "small" },
  ]);
  // fingers wrapped round the handle
  insertAfter(fig.parts, "hands", [
    { d: [SO([[-1.14, 3.93], [-1.05, 3.95], [-0.95, 3.93]]), SO([[-1.13, 4.03], [-1.05, 4.05], [-0.96, 4.03]])], fill: "none", stroke: { color: shade(SKIN.light, 0.16), width: 0.018 * U, cap: "round" }, lineStrokeWidth: 0.016 * U },
  ]);
  // glasses
  insertAfter(fig.parts, "hair", [
    { d: [S(ellPts(0.13, 0.525, 0.092, 0.07, 12)), S(ellPts(-0.13, 0.525, 0.092, 0.07, 12)), SO([[0.04, 0.51], [0, 0.495], [-0.04, 0.51]]), SO([[0.222, 0.5], [0.33, 0.485]]), SO([[-0.222, 0.5], [-0.33, 0.485]])],
      fill: "none", stroke: { color: "#5b6068", width: 0.026 * U, cap: "round" }, lineStrokeWidth: 0.024 * U },
  ]);
  return fit(fig.parts);
}

/* ---------------- professionals ---------------- */

/** Stethoscope draped round the neck: tubing both sides, chest piece on one side, binaurals on the other. */
function stethoscope(S, SO, u, { x = 0, y = 0, s = 1 } = {}) {
  const P = (pts) => pts.map(([a, b]) => [x + a * s, y + b * s]);
  return [
    { d: [SO(P([[0.215, 1.2], [0.3, 1.5], [0.31, 1.95], [0.265, 2.28]])), SO(P([[-0.215, 1.2], [-0.3, 1.5], [-0.3, 1.86]]))], fill: "none", stroke: { color: STETH, width: 0.06 * u * s, cap: "round" }, lineStrokeWidth: 0.045 * u * s },
    { d: [SO(P([[-0.3, 1.86], [-0.355, 2.0], [-0.37, 2.17]])), SO(P([[-0.3, 1.86], [-0.25, 2.0], [-0.235, 2.17]]))], fill: "none", stroke: { color: METAL, width: 0.04 * u * s, cap: "round" }, lineStrokeWidth: 0.035 * u * s },
    { d: [S(P(ellPts(-0.37, 2.2, 0.035, 0.04, 8))), S(P(ellPts(-0.235, 2.2, 0.035, 0.04, 8)))], fill: STETH, shade: "small" },
    { d: S(P(ellPts(0.255, 2.36, 0.085, 0.085, 14))), fill: METAL, shade: "organelle", gloss: false },
    { d: S(P(ellPts(0.255, 2.36, 0.05, 0.05, 12))), fill: shade(METAL, 0.12), shade: "dip" },
  ];
}

function clinicianDoctor(style) {
  const scrub = "#5fb3ad";
  const fig = standing({
    body: "male", skin: SKIN.brown, hair: { color: HAIR.black, front: HAIRSTYLE.short.front }, vDepth: 0.15,
    top: { half: TOPS.scrubV, color: scrub, sleeveColor: COAT }, bottom: { style: "trousers", color: scrub }, shoes: "#4d5866",
  });
  const { S, SO } = fig;
  const seam = shade(COAT, 0.2);
  // inside of the coat's back panel, seen between the legs
  fig.parts.unshift({ d: S([[-0.72, 3.55], [0.72, 3.55], [0.84, 5.0], [0, 5.02], [-0.84, 5.0]]), fill: "#dde3ea", shade: "rim" });
  // open white coat: two front panels, lapels, pockets, a pen in the breast pocket
  const panel = shoulderFix([[0.19, 1.17], [0.45, 1.28], [0.75, 1.4], [0.9, 1.53], [0.9, 1.78], [0.8, 2.02], [0.77, 2.4], [0.74, 2.8], [0.75, 3.2], [0.8, 3.6], [0.85, 4.3], [0.88, 4.98], [0.5, 5.03], [0.135, 5.01], [0.125, 4.0], [0.12, 3.0], [0.125, 2.45], [0.15, 2.0], [0.18, 1.55], [0.18, 1.3]], 1, BODIES.male.arm[0]);
  const lapel = [[0.165, 1.1], [0.27, 1.15], [0.33, 1.35], [0.45, 1.62], [0.395, 1.665], [0.435, 1.75], [0.125, 2.45], [0.15, 1.95], [0.175, 1.5]];
  // coat front panels and both sleeves are one united silhouette (smooth shoulders), seams as thin lines
  insertAfter(fig.parts, "top", [
    { unite: [S(panel), S(mx(panel)), ...fig.sleevesD], fill: COAT, shade: "body", gloss: false, highlight: false },
    ...fig.sleeveDetails(fig.sleeveArms, COAT, TOPS.scrubV),
    { d: S([[0.47, 1.98], [0.53, 1.98], [0.53, 2.24], [0.47, 2.24]]), fill: "#3f6fa6", shade: "small" },
    { d: S([[0.4, 2.2], [0.68, 2.19], [0.67, 2.52], [0.41, 2.53]]), fill: COAT, shade: "rim" },
    { d: [SO([[0.36, 3.72], [0.72, 3.74]]), SO([[-0.36, 3.72], [-0.72, 3.74]])], fill: "none", stroke: { color: seam, width: 0.035 * U, cap: "round" }, lineStrokeWidth: 0.03 * U },
    { d: [S(lapel), S(mx(lapel))], fill: COAT, shade: "organelle", gloss: false },
    ...stethoscope(S, SO, U),
  ]);
  return fit(fig.parts);
}

const GLOVE = "#7f9fe0"; // blue nitrile

/** Single-channel air-displacement pipette (P200-style), vertical, tip down; x = axis, y0 = top of the button. */
function pipetteParts(X, x, y0, s = 1, liquid = "#f4a3bf") {
  const P = (pts) => X(pts.map(([a, b]) => [x + a * s, y0 + b * s]));
  const Rr = (x0, y1, x1, y2, r) => { const [[ax, ay], [bx, by]] = P([[x0, y1], [x1, y2]]); return rect(ax, ay, bx - ax, by - ay, r); };
  const Pg = (pts) => polygon(P(pts));
  return [
    { d: Rr(-0.013, 0.05, 0.013, 0.17, 0.3), fill: "#c9d3dc", shade: "small" }, // plunger rod
    { d: Rr(-0.055, 0.0, 0.055, 0.075, 1.2), fill: "#f2c14e", shade: "small" }, // button (P200 yellow)
    { unite: [Rr(-0.066, 0.14, 0.066, 0.72, 1.6), smoothClosed(P([[0.05, 0.16], [0.105, 0.17], [0.125, 0.23], [0.1, 0.29], [0.05, 0.3]]))], fill: "#dfe5ea", shade: "organelle", gloss: false }, // handle + finger hook
    { d: Rr(-0.07, 0.7, 0.07, 0.8, 0.8), fill: "#97a4b1", shade: "small" }, // tip-ejector collar
    { d: Pg([[-0.052, 0.79], [0.052, 0.79], [0.02, 1.15], [-0.02, 1.15]]), fill: "#cdd6de", shade: "small" }, // shaft
    { d: Pg([[-0.028, 1.13], [0.028, 1.13], [0.006, 1.43], [-0.006, 1.43]]), fill: "#e6eef4", shade: "rim", thin: true }, // disposable tip
    { d: Pg([[-0.013, 1.31], [0.013, 1.31], [0.006, 1.42], [-0.006, 1.42]]), fill: liquid, thin: true }, // sample in the tip
  ];
}

function scientistResearcher(style) {
  const B = BODIES.female;
  // raised arm (figure's right, viewer's left): upper arm down (part of the coat silhouette), forearm across the
  // chest to the pipette (a separate shape in front)
  const upper = [K(0.7, 1.6, 0.15, 0.16), K(0.78, 2.1, 0.14, 0.135), K(0.83, 2.52, 0.115)];
  const fore = [K(0.84, 2.56, 0.112), K(0.64, 2.4, 0.12, 0.115), K(0.42, 2.24, 0.08)];
  const Su = (pts) => smoothClosed(pts.map(([x, y]) => [x * U, y * U]));
  const fig = standing({
    body: "female", skin: "#eac0a0", hair: { color: HAIR.auburn, front: HAIRSTYLE.bun.front }, vDepth: 0.1,
    top: { half: TOPS.labCoat, color: COAT, extraUnite: [Su(mx(limb(upper, { capA: 0.6, capB: 1, grow: 0.03 })))] }, bottom: { style: "trousers", color: "#4a5a78" }, shoes: "#4d5866", handFill: GLOVE, skip: ["L"],
  });
  const { S, SO } = fig;
  const seam = shade(COAT, 0.2);
  insertAfter(fig.parts, "sleeveHi", fig.sleeveDetails([{ keys: upper, m: mx, to: 1 }], COAT));
  const px = 0.27, py = 1.62; // pipette axis and button top
  const arm = [
    { d: S(mx(limb(fore, { capA: 1, capB: 0.5, grow: 0.03 }).map(([a, b]) => [a + 0.04, b + 0.07]))), fill: "#cdd6df", opacity: 0.7, line: false },
    { d: S(mx(limb(fore, { capA: 1, capB: 0, to: 0.86, grow: 0.03 }))), fill: COAT, shade: "body", gloss: false },
    ...pipetteParts(fig.X, -px, py, 1),
    { unite: [
      S(mx([[0.5, 2.36], [0.4, 2.24], [0.34, 2.1], [0.33, 1.94], [0.39, 1.87], [0.46, 1.94], [0.51, 2.08], [0.57, 2.25]])),
      capsule(...fig.X([[-0.555, 2.33], [-0.45, 2.24]]).flat(), 0.088 * U),
      ...[[1.885, 0.205], [1.955, 0.205], [2.025, 0.215], [2.09, 0.235]].map(([y, x1]) => capsule(...fig.X([[-0.37, y], [-x1, y + 0.01]]).flat(), 0.037 * U)),
      capsule(...fig.X([[-0.215, 1.9], [-0.25, 1.668]]).flat(), 0.04 * U),
    ], fill: GLOVE, shade: "organelle", gloss: false },
    { d: [1.92, 1.99, 2.058].map((y) => SO([[-0.215, y], [-0.33, y + 0.005]])), fill: "none", stroke: { color: shade(GLOVE, 0.18), width: 0.016 * U, cap: "round" }, lineStrokeWidth: 0.016 * U },
  ];
  insertAfter(fig.parts, "sleeveHi", arm);
  // glove cuff over the hanging arm's sleeve
  const w = B.arm.at(-1).p;
  insertAfter(fig.parts, "sleeveHi", [{ d: capsule(...fig.X([[w[0] - 0.008, w[1] - 0.13]])[0], ...fig.X([[w[0], w[1] + 0.02]])[0], 0.1 * U), fill: GLOVE, shade: "organelle", gloss: false }]);
  // blouse in the coat's V, button placket, pockets
  insertAfter(fig.parts, "top", [
    { d: S([[0, 1.62], [0.155, 1.22], [0.1, 1.2], [0, 1.4], [-0.1, 1.2], [-0.155, 1.22]]), fill: "#a8c8e8", shade: "rim" },
    { d: [SO([[0, 1.6], [0, 4.94]]), SO([[0.32, 3.78], [0.7, 3.8]]), SO([[-0.32, 3.78], [-0.7, 3.8]]), SO([[0.36, 2.3], [0.6, 2.3]])], fill: "none", stroke: { color: seam, width: 0.03 * U, cap: "round" }, lineStrokeWidth: 0.026 * U },
    { d: [2.05, 2.6, 3.15, 3.7, 4.25].map((y) => S(ellPts(0.045, y, 0.03, 0.03, 8))), fill: "#cfd8e0", shade: "small" },
    { d: [S([[0.15, 1.14], [0.25, 1.2], [0.3, 1.36], [0.03, 1.66]]), S(mx([[0.15, 1.14], [0.25, 1.2], [0.3, 1.36], [0.03, 1.66]]))], fill: COAT, shade: "organelle", gloss: false },
  ]);
  // wrap-around safety glasses
  insertAfter(fig.parts, "hair", [
    { d: S([[-0.32, 0.45], [0, 0.435], [0.32, 0.45], [0.33, 0.56], [0.22, 0.625], [0.07, 0.6], [0, 0.565], [-0.07, 0.6], [-0.22, 0.625], [-0.33, 0.56]]), fill: "#cfe7f3", opacity: 0.6 },
    { d: [SO([[-0.33, 0.47], [-0.15, 0.44], [0, 0.435], [0.15, 0.44], [0.33, 0.47]]), SO([[0.33, 0.47], [0.36, 0.5]]), SO([[-0.33, 0.47], [-0.36, 0.5]])], fill: "none", stroke: { color: "#5f86a8", width: 0.035 * U, cap: "round" }, lineStrokeWidth: 0.03 * U },
  ]);
  return fit(fig.parts);
}

/* ---------------- bare body: one united silhouette (outline, RA joints, anatomy backgrounds) ---------------- */

const tr = (pts, o, deg, s = 1) => pts.map(([x, y]) => rotate([o[0] + x * s, o[1] + y * s], o[0], o[1], deg));

/*
 * Bare-body proportions (right half, hu; +x is the figure's left = viewer's right). Limb widths follow
 * adult anthropometry: thigh ~0.6 hu, knee ~0.42, calf ~0.46, ankle ~0.27, upper arm ~0.39, wrist ~0.25 hu.
 * Limb keys: K(x, y, a, b) where a is the medial (−x) half-width and b the lateral one.
 */
const BARE = {
  neutral: {
    torso: [[0, 1.3], [0.13, 1.25], [0.29, 1.255], [0.45, 1.31], [0.68, 1.39], [0.8, 1.5], [0.81, 1.72], [0.72, 1.98], [0.69, 2.3], [0.62, 2.68], [0.6, 2.95], [0.64, 3.2], [0.67, 3.42], [0.64, 3.62], [0.5, 3.85], [0.25, 3.97], [0.1, 3.99], [0, 3.94]],
    arm: [K(0.79, 1.6, 0.19, 0.2), K(0.85, 2.0, 0.18, 0.195), K(0.9, 2.5, 0.155, 0.16), K(0.93, 2.85, 0.15, 0.155), K(0.965, 3.15, 0.17, 0.165), K(1.0, 3.5, 0.145, 0.14), K(1.02, 3.76, 0.125, 0.125)],
    leg: [K(0.36, 3.28, 0.3, 0.28), K(0.365, 3.68, 0.34, 0.37), K(0.35, 4.05, 0.3, 0.33), K(0.33, 4.6, 0.255, 0.285), K(0.31, 5.15, 0.205, 0.22), K(0.3, 5.45, 0.2, 0.205), K(0.3, 5.9, 0.235, 0.215), K(0.295, 6.5, 0.16, 0.15), K(0.29, 7.02, 0.13, 0.13)],
    hand: 1, foot: 1,
  },
  male: {
    torso: [[0, 1.3], [0.14, 1.24], [0.31, 1.245], [0.48, 1.3], [0.72, 1.39], [0.86, 1.5], [0.87, 1.72], [0.77, 1.98], [0.72, 2.3], [0.66, 2.65], [0.63, 2.95], [0.65, 3.2], [0.66, 3.42], [0.63, 3.62], [0.5, 3.85], [0.25, 3.97], [0.1, 3.99], [0, 3.94]],
    arm: [K(0.84, 1.6, 0.2, 0.21), K(0.9, 2.0, 0.19, 0.205), K(0.95, 2.5, 0.16, 0.165), K(0.98, 2.85, 0.155, 0.16), K(1.01, 3.15, 0.175, 0.17), K(1.04, 3.5, 0.15, 0.145), K(1.06, 3.76, 0.13, 0.13)],
    leg: [K(0.36, 3.28, 0.3, 0.28), K(0.36, 3.68, 0.335, 0.355), K(0.35, 4.05, 0.3, 0.33), K(0.33, 4.6, 0.255, 0.285), K(0.31, 5.15, 0.21, 0.225), K(0.3, 5.45, 0.205, 0.21), K(0.3, 5.9, 0.24, 0.22), K(0.295, 6.5, 0.165, 0.155), K(0.29, 7.02, 0.135, 0.135)],
    hand: 1.03, foot: 1.03,
  },
  female: {
    torso: [[0, 1.3], [0.12, 1.26], [0.27, 1.265], [0.42, 1.31], [0.64, 1.39], [0.75, 1.5], [0.75, 1.7], [0.67, 1.95], [0.665, 2.15], [0.62, 2.45], [0.58, 2.75], [0.6, 3.0], [0.68, 3.28], [0.72, 3.45], [0.68, 3.65], [0.52, 3.86], [0.25, 3.97], [0.1, 3.99], [0, 3.94]],
    arm: [K(0.74, 1.6, 0.165, 0.175), K(0.79, 2.0, 0.16, 0.17), K(0.84, 2.5, 0.135, 0.14), K(0.87, 2.85, 0.13, 0.135), K(0.9, 3.15, 0.15, 0.145), K(0.93, 3.5, 0.125, 0.12), K(0.95, 3.74, 0.11, 0.11)],
    leg: [K(0.39, 3.28, 0.33, 0.3), K(0.395, 3.62, 0.37, 0.39), K(0.37, 4.05, 0.32, 0.355), K(0.33, 4.6, 0.26, 0.29), K(0.3, 5.15, 0.195, 0.21), K(0.29, 5.45, 0.19, 0.19), K(0.29, 5.9, 0.215, 0.195), K(0.29, 6.5, 0.145, 0.135), K(0.29, 7.0, 0.115, 0.115)],
    hand: 0.93, foot: 0.92,
  },
};
const BARE_HEAD = { neutral: "neutral", male: "male", female: "female" };

/**
 * Open hand, palm forward (anatomical position), local coords: wrist at 0,0, fingers toward +y, thumb toward +x
 * (lateral). Returns {palm, fingers:[outline pts], joints:{mcp, pip, dip, thumbMcp, thumbIp}} in local coords.
 */
function openHandLocal() {
  // the palm starts inside the forearm (y −0.1, narrower than the wrist) and widens gradually to the knuckles
  const palm = [[-0.105, -0.1], [0.1, -0.1], [0.118, 0.0], [0.142, 0.08], [0.172, 0.2], [0.17, 0.32], [0.15, 0.41], [0.05, 0.44], [-0.06, 0.435], [-0.15, 0.4], [-0.166, 0.29], [-0.152, 0.15], [-0.128, 0.04], [-0.12, -0.02]];
  // [base x, base y, spread deg (+ toward the thumb), length, base radius]
  const F = [[0.107, 0.4, 4, 0.32, 0.039], [0.034, 0.42, 0.5, 0.36, 0.04], [-0.041, 0.415, -3, 0.34, 0.037], [-0.112, 0.385, -7, 0.27, 0.032]];
  const fingers = [], mcp = [], pip = [], dip = [];
  for (const [x, y, a, len, r] of F) {
    const dx = Math.sin((a * Math.PI) / 180), dy = Math.cos((a * Math.PI) / 180);
    const at = (t) => [x + dx * len * t, y + dy * len * t];
    fingers.push(limb([K(x - dx * 0.06, y - dy * 0.06, r, r), K(...at(0.5), r * 0.93), K(...at(1), r * 0.82)], { capA: 0, capB: 1, per: 3 }));
    mcp.push(at(0.0)); pip.push(at(0.45)); dip.push(at(0.76));
  }
  const ta = 33, tl = 0.31, tb = [0.118, 0.12];
  const tdx = Math.sin((ta * Math.PI) / 180), tdy = Math.cos((ta * Math.PI) / 180);
  const tat = (t) => [tb[0] + tdx * tl * t, tb[1] + tdy * tl * t];
  fingers.push(limb([K(...tb, 0.06), K(...tat(0.45), 0.048), K(...tat(1), 0.04)], { capA: 0, capB: 1, per: 3 }));
  return { palm, fingers, joints: { mcp, pip, dip, thumbMcp: tat(0.42), thumbIp: tat(0.74) } };
}

/** Bare foot, front view (dorsum + toes), local coords: ankle centre 0,0, +x lateral; returns outline pieces and joints. */
function bareFootLocal() {
  // starts inside the shin (y −0.14) and widens gradually over the malleoli to the forefoot
  const foot = [[-0.1, -0.14], [0.1, -0.14], [0.12, -0.02], [0.148, 0.1], [0.195, 0.23], [0.235, 0.33], [0.23, 0.39], [0.1, 0.425], [-0.06, 0.435], [-0.175, 0.415], [-0.19, 0.32], [-0.165, 0.16], [-0.128, 0.03], [-0.12, -0.05]];
  // toe ellipses [x, y, rx, ry], hallux first (medial)
  const toes = [[-0.115, 0.43, 0.068, 0.062], [-0.02, 0.45, 0.04, 0.046], [0.052, 0.447, 0.037, 0.043], [0.118, 0.432, 0.034, 0.039], [0.18, 0.408, 0.03, 0.034]];
  const mtp = toes.slice(1).map(([x, y]) => [x - 0.008 * Math.sign(x || 1), y - 0.085]);
  return { foot, toes, mtp, hallux: [-0.11, 0.35] };
}

/**
 * Unclothed body as ONE united silhouette (no seams in either style). o: {body: "neutral"|"male"|"female",
 * abduct (deg), handScale, footScale, crop (hu: cut the legs flat at this height), genital ("male"), u}.
 * Returns {outline: unite list, X, S, SO, u, P, joints, arm, wrist, legKeys}.
 */
function bareBody(o = {}) {
  const kind = o.body ?? "neutral";
  const P = BARE[kind], B = BODIES[BARE_HEAD[kind]];
  const u = o.u ?? U;
  const X = (pts) => pts.map(([x, y]) => [x * u, y * u]);
  const S = (pts) => smoothClosed(X(pts));
  const SO = (pts) => smoothOpen(X(pts));
  const ab = o.abduct ?? 12, hs = (o.handScale ?? 1) * P.hand, fs = (o.footScale ?? 1) * P.foot;
  const joints = { mcp: [], pip: [], dip: [], thumb: [], wrist: [], knee: [], ankle: [], mtp: [], elbow: [], shoulder: [], hip: [] };
  const sh = P.arm[0].p;
  const arm = P.arm.map((k) => ({ ...k, p: rotate(k.p, sh[0], sh[1], -ab) }));
  const wrist = arm.at(-1).p, prev = arm.at(-2).p;
  const dir = (Math.atan2(wrist[0] - prev[0], wrist[1] - prev[1]) * 180) / Math.PI; // deg from straight down, + lateral
  const H = openHandLocal();
  const handT = (pts) => tr(pts, [wrist[0], wrist[1] - 0.02], -dir, hs);
  const legKeys = P.leg;
  const legEnd = legKeys.at(-1).p;
  const FT = bareFootLocal();
  const footT = (pts) => tr(pts, legEnd, 0, fs);
  const crop = o.crop ?? null;
  const out = [];
  // outline-only limb keys: the leg starts inside the torso (y 2.98, narrower than the flank there) so its top
  // corners are buried; the forearm and shin end at least as wide as the (scaled) palm and foot they meet, so the
  // wrist and ankle run smoothly with no bracelet step
  const end = (keys, w) => keys.map((k, i) => (i === keys.length - 1 ? { ...k, a: Math.max(k.a, w), b: Math.max(k.b, w) } : k));
  const L0 = legKeys[0];
  const legO = [K(L0.p[0] - 0.02, 2.98, L0.a - 0.06, L0.b - 0.07), ...end(legKeys, 0.122 * fs)];
  const armO = end(arm, 0.118 * hs);

  for (const m of [(q) => q, mx]) {
    // leg (+ foot and toes)
    out.push(S(m(limb(legO, { capA: 0, capB: crop ? 0 : 0.3, to: crop ? cropT(legO, crop) : 1 }))));
    if (!crop) {
      out.push(S(m(footT(FT.foot))));
      for (const [x, y, rx, ry] of FT.toes) out.push(S(m(footT(ellPts(x, y, rx, ry, 10)))));
    }
    // arm, palm, fingers, thumb
    out.push(S(m(limb(armO, { capA: 0.8, capB: 0 }))));
    out.push(S(m(handT(H.palm))));
    for (const fpts of H.fingers) out.push(S(m(handT(fpts))));
  }
  out.push(S(mirrorLoop(P.torso)));
  const nw = B.neck, [ny0, ny1] = B.neckY;
  out.push(S([[nw, ny0], [nw, ny1 - 0.3], [nw + 0.1, ny1 - 0.12], [0, ny1 - 0.05], [-nw - 0.1, ny1 - 0.12], [-nw, ny1 - 0.3], [-nw, ny0]]));
  const [ex, ey, erx, ery] = B.ear;
  out.push(S(mirrorLoop(B.head)), S(ellPts(ex, ey, erx, ery, 10)), S(ellPts(-ex, ey, erx, ery, 10)));
  if (o.genital === "male") {
    out.push(S([[0, 3.86], [0.09, 3.9], [0.15, 4.01], [0.158, 4.15], [0.12, 4.245], [0.06, 4.27], [0, 4.25], [-0.06, 4.27], [-0.12, 4.245], [-0.158, 4.15], [-0.15, 4.01], [-0.09, 3.9]]));
  }

  // joint centres (both sides)
  for (const m of [(q) => q, mx]) {
    joints.mcp.push(...m(handT(H.joints.mcp)));
    joints.pip.push(...m(handT(H.joints.pip)));
    joints.dip.push(...m(handT(H.joints.dip)));
    joints.thumb.push(...m(handT([H.joints.thumbMcp, H.joints.thumbIp])));
    joints.wrist.push(...m([[wrist[0], wrist[1] + 0.02]]));
    joints.elbow.push(...m([along(arm, 0.55).p]));
    joints.shoulder.push(...m([sh]));
    joints.hip.push(...m([[legKeys[0].p[0], 3.72]]));
    joints.knee.push(...m([legKeys.reduce((b, k) => (Math.abs(k.p[1] - 5.45) < Math.abs(b.p[1] - 5.45) ? k : b)).p]));
    joints.ankle.push(...m([legEnd]));
    joints.mtp.push(...m(footT(FT.mtp)));
  }
  return { outline: out, X, S, SO, u, P, B, joints, arm, wrist, legKeys, legO, armO };
}

/** Fraction along a limb's sampled spine where y first reaches `y`. */
function cropT(keys, y) {
  const s = spine(keys);
  const i = s.findIndex((q) => q.p[1] >= y);
  return i < 0 ? 1 : i / (s.length - 1);
}

/** The silhouette as one flat part (Servier silhouettes are flat with a thin outline). */
const silhouettePart = (outline, fill, style, w = 1.3) =>
  ({ unite: outline, fill, ...(style === "soft" ? { stroke: { color: shade(fill, 0.2), width: w } } : {}), lineWidth: 1.6 });

const BODY_GREY = "#e2e7ee";

function bodyOutline(style) {
  const fig = bareBody({ body: "neutral", abduct: 13 });
  return fit([silhouettePart(fig.outline, BODY_GREY, style)], { lineWidth: 1.6 });
}

const RA = { core: "#de4f4a", halo: "#f39a8a" };

function raJoints(style) {
  const fig = bareBody({ body: "neutral", abduct: 17, handScale: 1.3, footScale: 1.2 });
  const { S, joints: J } = fig;
  const small = [...J.mcp, ...J.pip, ...J.thumb];
  const halo = [], core = [];
  const dot = (p, r1, r2) => { halo.push(S(ellPts(p[0], p[1], r2, r2, 12))); core.push(S(ellPts(p[0], p[1], r1, r1, 12))); };
  for (const p of small) dot(p, 0.034, 0.068);
  for (const p of J.wrist) dot(p, 0.07, 0.115);
  for (const p of J.knee) dot(p, 0.1, 0.165);
  for (const p of J.mtp) dot(p, 0.032, 0.062);
  // shoulders and elbows (also in the DAS28 count, less often involved): faint halo-only markers
  const faint = [...J.shoulder, ...J.elbow].map((p) => S(ellPts(p[0], p[1], 0.1, 0.1, 14)));
  return fit([
    silhouettePart(fig.outline, BODY_GREY, style),
    { d: faint, fill: RA.halo, opacity: 0.35, thin: true },
    { d: halo, fill: RA.halo, opacity: 0.55, line: false },
    { d: core, fill: RA.core, shade: "small", thin: true },
  ], { lineWidth: 1.6 });
}

/* ---------------- internal organs (anatomy) ---------------- */

/*
 * Plan — human-body-internal-organs-male / -female.
 * Canvas: bare silhouette (bareBody, u = 56) cropped at mid-thigh (y 4.7 hu) so the organs are big enough
 * to read as a library thumbnail; arms slightly abducted. +x = the figure's left (viewer's right).
 * Positions (hu from the crown; adult landmarks): larynx C4–C6 (y 1.08–1.25) with the thyroid just below
 * (lobes 1.14–1.33, inside the neck above the jugular notch); carina at the sternal angle (1.82); lung apices 2.5 cm above the clavicles (1.3); right
 * diaphragm dome higher than the left; heart left of the midline (right border −0.16, apex +0.39 at 2.2);
 * liver under the right dome, inferior border along the costal margin (to 2.75 laterally); gallbladder fundus at
 * the 9th costal cartilage; stomach J-shaped in the left upper quadrant, pylorus on the transpyloric plane
 * (~2.62) just right of the midline; spleen posterolateral left (ribs 9–11); pancreas head in the duodenal C,
 * tail to the splenic hilum (behind the stomach); kidneys T12–L3, the right ~0.06 hu lower, upper poles behind
 * the liver / stomach, adrenals on top; colon framing the small intestine; bladder behind the pubis; uterus,
 * tubes and ovaries above/behind the bladder (female); prostate under the bladder neck, seminal vesicles behind
 * it, vas deferens to the testes in the scrotum (male).
 * Paint order (back → front): body · brain · oesophagus · larynx/trachea/bronchi · thyroid · kidneys, adrenals,
 * ureters · lungs (+ fissures) · SVC · heart (+ groove) · aortic arch · spleen · duodenum · pancreas ·
 * gallbladder · stomach · liver (left lobe over the lesser curvature) · small-bowel mass + loops + ileum · colon · pelvic organs · bladder (· prostate, testes, epididymis).
 * Female thoraco-abdominal organs are narrowed (x·0.89 above the waist, blending to 1 in the pelvis) to fit the
 * narrower female trunk; the brain is narrowed to the smaller head.
 * Variation: small-bowel loops are clustered (clustered()), with seeded radius, span and orientation; brain sulci differ left vs right.
 */
const ORGC = {
  body: "#e6eaf0", brain: "#f2c3c3", cart: "#cddfeb", thyroid: "#c9566b", lung: "#f5c4d6", heart: "#d6565d",
  aorta: "#ef4d3c", vein: "#6f99d3", liver: "#9a4d58", gall: "#8fbd68", stomach: "#efa08b", spleen: "#8c4f8e",
  pancreas: "#f4d36f", kidney: "#c9705a", adrenal: "#f1bd57", ureter: "#e0ae6a", si: "#f2adba", colon: "#dfc39a",
  bladder: "#e7858e", uterus: "#d9789b", ovary: "#f4c49b", prostate: "#d48c5c", vesicle: "#e7b178", testis: "#f0b4a2",
  vas: "#c6865f", oesoph: "#e99aa3", epid: "#d98f86",
};

/** Closed outline (hu points) of a tube of width w along a smooth path; optional haustra every `sacc` hu and round caps. */
function tubePts(path, w, { sacc = 0, per = 8, capA = true, capB = true, taper = null } = {}) {
  const s = spine(path.map(([x, y]) => K(x, y, w / 2)), per);
  const Ls = [0];
  for (let i = 1; i < s.length; i++) Ls.push(Ls[i - 1] + Math.hypot(s[i].p[0] - s[i - 1].p[0], s[i].p[1] - s[i - 1].p[1]));
  const left = [], right = [];
  for (let i = 0; i < s.length; i++) {
    const a = s[Math.max(0, i - 1)].p, b = s[Math.min(s.length - 1, i + 1)].p;
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
    let hw = w / 2;
    if (taper) hw *= taper(i / (s.length - 1));
    if (sacc) hw *= 0.86 + 0.2 * Math.sqrt(Math.abs(Math.sin((Math.PI * Ls[i]) / sacc)));
    left.push([s[i].p[0] + nx * hw, s[i].p[1] + ny * hw]);
    right.push([s[i].p[0] - nx * hw, s[i].p[1] - ny * hw]);
  }
  const cap = (i, j, sign) => {
    const p = s[i].p, q = s[j].p, l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
    return [[p[0] + ((p[0] - q[0]) / l) * w * 0.42 * sign, p[1] + ((p[1] - q[1]) / l) * w * 0.42 * sign]];
  };
  return [...left, ...(capB ? cap(s.length - 1, s.length - 2, 1) : []), ...right.reverse(), ...(capA ? cap(0, 1, 1) : [])];
}

/** Bean-shaped kidney outline centred at c, hilum facing −x·side (medial), tilted `rot` degrees. */
const kidneyPts = (c, side, rot) =>
  [[0, -0.235], [0.075, -0.215], [0.122, -0.13], [0.132, 0], [0.12, 0.12], [0.075, 0.215], [-0.01, 0.24], [-0.085, 0.2], [-0.112, 0.11], [-0.07, 0.035], [-0.068, -0.045], [-0.112, -0.105], [-0.09, -0.195]]
    .map(([x, y]) => rotate([c[0] + side * x, c[1] + y], c[0], c[1], side * rot));

function internalOrgans(sex, style) {
  const female = sex === "female";
  const u = 56;
  const fig = bareBody({ body: sex, abduct: 7, crop: 4.7, genital: female ? null : "male", u });
  const { X } = fig;
  const R = rng(female ? 731 : 517);
  // female: narrower trunk above the pelvis
  const kx = (y) => (!female ? 1 : y < 2.95 ? 0.89 : y > 3.3 ? 1 : 0.89 + ((y - 2.95) / 0.35) * 0.11);
  const W = (pts) => pts.map(([x, y]) => [x * kx(y), y]);
  const S = (pts) => smoothClosed(X(W(pts)));
  const SO = (pts) => smoothOpen(X(W(pts)));
  const both = (pts) => [pts, mx(pts)];
  const parts = [silhouettePart(fig.outline, ORGC.body, style, 1.4)];
  const line = (d, color, w, extra = {}) => ({ d, fill: "none", stroke: { color, width: w * u, cap: "round" }, lineStrokeWidth: w * u * 0.8, ...extra });

  // brain: two hemispheres (longitudinal fissure between), temporal lobes bulging low at the sides
  const bk = female ? 0.95 : 1;
  const hemi = [[0.016, 0.085], [0.12, 0.072], [0.22, 0.102], [0.283, 0.178], [0.303, 0.3], [0.298, 0.42], [0.283, 0.505], [0.252, 0.578], [0.2, 0.612], [0.142, 0.588], [0.1, 0.535], [0.05, 0.505], [0.016, 0.495]].map(([x, y]) => [x * bk, y]);
  parts.push({ d: both(hemi).map((p) => smoothClosed(X(p))), fill: ORGC.brain, shade: "organelle", gloss: false });
  const sulciR = [[[0.05, 0.14], [0.11, 0.19], [0.09, 0.27]], [[0.19, 0.13], [0.235, 0.22], [0.18, 0.31]], [[0.07, 0.36], [0.15, 0.37], [0.21, 0.34], [0.27, 0.37]], [[0.27, 0.47], [0.2, 0.44], [0.15, 0.47]], [[0.05, 0.43], [0.1, 0.46]]];
  const sulciL = [[[0.06, 0.16], [0.12, 0.2], [0.11, 0.3]], [[0.2, 0.15], [0.24, 0.25], [0.2, 0.32]], [[0.06, 0.35], [0.14, 0.39], [0.22, 0.36], [0.27, 0.4]], [[0.27, 0.49], [0.19, 0.45], [0.14, 0.48]], [[0.17, 0.53], [0.22, 0.56]]];
  parts.push(line([...sulciR.map((p) => smoothOpen(X(p.map(([x, y]) => [x * bk, y])))), ...sulciL.map((p) => smoothOpen(X(mx(p.map(([x, y]) => [x * bk, y])))))], shade(ORGC.brain, 0.16), 0.014, { thin: true }));

  // oesophagus (behind trachea and heart; reaches the stomach cardia)
  parts.push({ d: S(tubePts([[0.0, 1.22], [0.01, 1.6], [0.03, 1.95], [0.08, 2.2], [0.13, 2.33]], 0.075, { capA: false })), fill: ORGC.oesoph, shade: "rim" });
  // larynx (thyroid cartilage), trachea, main bronchi
  parts.push({ unite: [S(tubePts([[0, 1.18], [0, 1.83]], 0.095, { capA: false, capB: false })), S(tubePts([[0, 1.8], [-0.07, 1.86], [-0.17, 1.98]], 0.07, { capA: false })), S(tubePts([[0, 1.8], [0.09, 1.85], [0.2, 1.93]], 0.065, { capA: false }))], fill: ORGC.cart, shade: "rim" });
  parts.push(line([1.3, 1.37, 1.44, 1.51, 1.58, 1.65, 1.72].map((y) => SO([[-0.045, y - 0.008], [0, y + 0.008], [0.045, y - 0.008]])), shade(ORGC.cart, 0.18), 0.012, { thin: true }));
  parts.push({ d: S([[0, 1.03], [0.07, 1.035], [0.095, 1.09], [0.08, 1.17], [0.04, 1.205], [0, 1.215], [-0.04, 1.205], [-0.08, 1.17], [-0.095, 1.09], [-0.07, 1.035]]), fill: ORGC.cart, shade: "organelle", gloss: false });
  // aortic-arch branches (brachiocephalic, left common carotid, left subclavian) pass behind the thyroid and lung apex
  parts.push({ d: [S(tubePts([[-0.005, 1.6], [-0.04, 1.5], [-0.075, 1.39]], 0.042)), S(tubePts([[0.045, 1.58], [0.06, 1.48], [0.075, 1.38]], 0.034)), S(tubePts([[0.1, 1.6], [0.13, 1.5], [0.17, 1.4]], 0.036))], fill: ORGC.aorta, shade: "rim" });
  // thyroid (C5–T1, inside the neck, above the jugular notch): lobes beside the lower larynx and upper trachea,
  // isthmus over the 2nd–4th tracheal rings
  const lobe = [[0.03, 1.16], [0.075, 1.14], [0.115, 1.18], [0.122, 1.26], [0.1, 1.32], [0.055, 1.33], [0.035, 1.29]];
  parts.push({ unite: [S(lobe), S(mx(lobe)), S([[-0.05, 1.215], [0.05, 1.215], [0.05, 1.265], [-0.05, 1.265]])], fill: ORGC.thyroid, shade: "organelle", gloss: false });

  // kidneys (right lower), adrenals, ureters to the bladder
  const kL = [0.335, 2.76], kR = [-0.335, 2.82];
  parts.push(line([SO([[0.26, 2.8], [0.22, 3.1], [0.17, 3.45], [0.1, 3.68]]), SO([[-0.26, 2.86], [-0.22, 3.12], [-0.17, 3.45], [-0.1, 3.68]])], ORGC.ureter, 0.026));
  parts.push({ d: [S(kidneyPts(kL, 1, -12)), S(kidneyPts(kR, -1, -12))], fill: ORGC.kidney, shade: "organelle", gloss: false });
  parts.push({ d: [S([[0.245, 2.56], [0.29, 2.48], [0.35, 2.495], [0.375, 2.55], [0.315, 2.55]]), S([[-0.245, 2.62], [-0.29, 2.54], [-0.35, 2.555], [-0.375, 2.61], [-0.315, 2.61]])], fill: ORGC.adrenal, shade: "small" });

  // lungs: right 3 lobes (horizontal + oblique fissures), left 2 lobes with the cardiac notch; right dome higher
  const lungR = [[-0.2, 1.3], [-0.3, 1.34], [-0.42, 1.46], [-0.52, 1.62], [-0.585, 1.82], [-0.615, 2.05], [-0.62, 2.28], [-0.6, 2.45], [-0.5, 2.37], [-0.36, 2.25], [-0.22, 2.2], [-0.12, 2.2], [-0.09, 2.0], [-0.085, 1.75], [-0.1, 1.55], [-0.135, 1.39]];
  const lungL = [[0.2, 1.3], [0.3, 1.34], [0.42, 1.46], [0.52, 1.62], [0.585, 1.82], [0.615, 2.05], [0.625, 2.28], [0.605, 2.5], [0.5, 2.43], [0.38, 2.31], [0.27, 2.27], [0.3, 2.17], [0.31, 2.05], [0.24, 1.94], [0.12, 1.84], [0.09, 1.62], [0.105, 1.48], [0.14, 1.37]];
  parts.push({ d: [S(lungR), S(lungL)], fill: ORGC.lung, shade: "organelle", gloss: false });
  parts.push(line([SO([[-0.095, 1.96], [-0.3, 1.97], [-0.48, 1.95], [-0.6, 1.99]]), SO([[-0.6, 2.0], [-0.48, 2.08], [-0.36, 2.17], [-0.27, 2.21]]), SO([[0.6, 1.8], [0.52, 1.95], [0.43, 2.12], [0.35, 2.27]])], shade(ORGC.lung, 0.16), 0.014, { thin: true }));

  // superior vena cava, heart (apex left), anterior interventricular groove, aortic arch
  const heart = [[-0.06, 1.77], [0.08, 1.75], [0.2, 1.8], [0.3, 1.92], [0.37, 2.06], [0.395, 2.19], [0.33, 2.215], [0.15, 2.215], [-0.05, 2.2], [-0.145, 2.15], [-0.17, 2.02], [-0.16, 1.88], [-0.12, 1.8]];
  parts.push({ d: S(tubePts([[-0.01, 1.85], [-0.035, 1.7], [-0.01, 1.6], [0.05, 1.56], [0.12, 1.59], [0.15, 1.68], [0.15, 1.88]], 0.088, { capA: false, capB: false })), fill: ORGC.aorta, shade: "small" });
  parts.push({ d: S(heart), fill: ORGC.heart, shade: "organelle", gloss: false });
  parts.push(line(SO([[0.1, 1.8], [0.17, 1.95], [0.25, 2.1], [0.32, 2.2]]), shade(ORGC.heart, 0.14), 0.016, { thin: true }));

  // spleen (behind the stomach), duodenum, pancreas
  parts.push({ d: S([[0.53, 2.22], [0.595, 2.29], [0.615, 2.42], [0.585, 2.56], [0.52, 2.61], [0.485, 2.52], [0.505, 2.4], [0.485, 2.29]]), fill: ORGC.spleen, shade: "organelle", gloss: false });
  // duodenum: C-loop round the pancreas head, 4th part up to the duodenojejunal flexure (0.1–0.2, 2.93), then the
  // jejunum turns down behind the transverse colon into the small-bowel mass (its end is hidden under the loops)
  parts.push({ d: S(tubePts([[-0.11, 2.665], [-0.21, 2.71], [-0.25, 2.83], [-0.22, 2.95], [-0.11, 3.0], [0.0, 2.99], [0.07, 2.955], [0.125, 2.93], [0.175, 2.945], [0.205, 2.995], [0.215, 3.07], [0.2, 3.3]], 0.075, { capB: false })), fill: ORGC.si, shade: "rim" });
  parts.push({ d: S([[-0.19, 2.75], [-0.12, 2.72], [-0.03, 2.75], [0.1, 2.71], [0.22, 2.64], [0.36, 2.56], [0.48, 2.52], [0.5, 2.57], [0.4, 2.62], [0.27, 2.69], [0.14, 2.78], [0.02, 2.82], [-0.07, 2.86], [-0.12, 2.93], [-0.19, 2.91], [-0.21, 2.83]]), fill: ORGC.pancreas, shade: "organelle", gloss: false });

  // gallbladder fundus peeking below the liver, stomach, then the liver (its left lobe lies in front of the
  // stomach's lesser curvature and cardia), falciform line
  parts.push({ d: S([[-0.33, 2.55], [-0.28, 2.58], [-0.27, 2.68], [-0.3, 2.75], [-0.35, 2.73], [-0.36, 2.64]]), fill: ORGC.gall, shade: "small" });
  const stomach = [[0.1, 2.3], [0.17, 2.21], [0.29, 2.18], [0.41, 2.22], [0.49, 2.33], [0.505, 2.47], [0.465, 2.6], [0.38, 2.7], [0.25, 2.755], [0.11, 2.755], [-0.01, 2.725], [-0.1, 2.7], [-0.13, 2.69], [-0.135, 2.635], [-0.1, 2.625], [-0.02, 2.635], [0.08, 2.625], [0.15, 2.57], [0.16, 2.45], [0.135, 2.36]];
  parts.push({ d: S(stomach), fill: ORGC.stomach, shade: "organelle", gloss: false });
  const liver = [[0.28, 2.262], [0.2, 2.232], [0.0, 2.205], [-0.2, 2.17], [-0.38, 2.13], [-0.52, 2.16], [-0.6, 2.27], [-0.62, 2.45], [-0.6, 2.62], [-0.54, 2.75], [-0.42, 2.71], [-0.27, 2.635], [-0.1, 2.53], [-0.03, 2.485], [0.03, 2.455], [0.13, 2.395], [0.23, 2.32], [0.275, 2.285]];
  parts.push({ d: S(liver), fill: ORGC.liver, shade: "organelle", gloss: false });
  parts.push(line(SO([[-0.05, 2.215], [-0.03, 2.33], [-0.02, 2.47]]), shade(ORGC.liver, 0.1), 0.012, { thin: true }));

  // small bowel: a scalloped mass of coiled loops inside the colon frame (no tray). Behind: the deeper loops as a
  // united mass whose outline is made of the loop discs. In front: 11 loops with uneven radius (±30%), arc span
  // (120–300°) and orientation, clustered (dense centre, sparser edge); each loop is its own shape (own rim /
  // outline). Terminal ileum enters the caecum from the medial side. Same extent in both sexes.
  const inSB = ([x, y]) => ((x - 0.02) / 0.4) ** 2 + ((y - 3.4) / 0.19) ** 2 <= 1;
  const cen = clustered(R, { x: -0.36, y: 3.22, w: 0.76, h: 0.36 }, 13, { clusters: 3, spread: 0.6, minDist: 0.095, test: inSB });
  const loops = cen.map((c) => {
    const rad = vary(R, 0.072, 0.3), ex = vary(R, 1.12, 0.15), a0 = R() * 360, span = 120 + R() * 180, w = vary(R, 0.07, 0.08);
    const arc = Array.from({ length: 9 }, (_, k) => { const a = ((a0 + (span * k) / 8) * Math.PI) / 180; return [c[0] + Math.cos(a) * rad * ex, c[1] + Math.sin(a) * (rad / ex)]; });
    return { c, rad, arc, w, pts: tubePts(arc, w, { per: 4 }) };
  }).sort((a, b) => a.c[1] - b.c[1]);
  const massDiscs = [...loops.map(({ c, rad }) => ellPts(c[0], c[1], rad * 1.2 + 0.055, rad * 1.05 + 0.05, 14)), ellPts(0.03, 3.4, 0.3, 0.14, 16)];
  parts.push({ unite: massDiscs.map(S), fill: shade(ORGC.si, 0.13), shade: "rim", thin: true });
  const ileumPath = [[-0.22, 3.46], [-0.3, 3.465], [-0.38, 3.44], [-0.45, 3.41], [-0.49, 3.4]];
  parts.push({ d: [S(tubePts(ileumPath, 0.066, { capA: false })), ...loops.map((l) => S(l.pts))], fill: ORGC.si, shade: "small" });
  // each loop's own light band on its top-left side (soft only), so the loops read as tubes; a band is only
  // drawn along the stretches of its loop that no later-painted loop covers
  const hiBands = [];
  loops.forEach((l, i) => {
    const later = loops.slice(i + 1).map((q) => [q.pts]);
    const keys = spine(l.arc.map(([x, y]) => K(x, y, l.w / 2)), 3);
    let run = [];
    const flush = () => { if (run.length >= 4) hiBands.push(...tubeBands(run, { kind: "hi", frac: 0.22, per: 2, trim: 0.06 })); run = []; };
    for (const k of keys) {
      const covered = later.some((poly) => insideShape(poly, k.p) || edgeDistance(poly, k.p) < l.w * 0.6);
      if (covered) flush(); else run.push(k);
    }
    flush();
  });
  parts.push({ d: hiBands.map(S), fill: tint(ORGC.si, 0.1), opacity: 0.9, line: false });

  // colon: caecum + appendix, ascending, transverse (sagging), round splenic flexure (r ≈ 0.1), descending,
  // sigmoid, rectum. Rim-only shading + a hand-made light band (the library's inset highlight drifts off a frame
  // shape this large)
  const colonPath = [[-0.48, 3.47], [-0.505, 3.3], [-0.525, 3.12], [-0.51, 3.0], [-0.44, 2.97], [-0.32, 3.06], [-0.15, 3.14], [0.05, 3.16], [0.25, 3.11], [0.36, 3.045], [0.42, 2.99], [0.48, 2.965], [0.535, 2.98], [0.565, 3.04], [0.567, 3.13], [0.55, 3.3], [0.49, 3.47], [0.3, 3.6], [0.12, 3.63], [0.03, 3.71], [0.0, 3.82]];
  parts.push({ unite: [S(tubePts(colonPath, 0.115, { sacc: 0.085, per: 6, capB: false })), S(tubePts([[-0.47, 3.48], [-0.42, 3.56], [-0.38, 3.61]], 0.03))], fill: ORGC.colon, shade: "rim" });
  parts.push({ d: tubeBands(colonPath.map(([x, y]) => K(x, y, 0.05)), { kind: "hi", frac: 0.2, trim: 0.03 }).map(S), fill: tint(ORGC.colon, 0.12), opacity: 0.85, line: false });

  // pelvic organs
  if (female) {
    // uterus (fundus 3.48) overlapping the lowest bowel loops, tubes arching out to the ovaries, cervix and
    // vagina running down behind the bladder; the vagina reappears below the bladder base
    const ut = [[0, 3.475], [0.07, 3.482], [0.105, 3.52], [0.1, 3.59], [0.07, 3.65], [0.045, 3.71], [0.04, 3.76], [0, 3.775], [-0.04, 3.76], [-0.045, 3.71], [-0.07, 3.65], [-0.1, 3.59], [-0.105, 3.52], [-0.07, 3.482]];
    const tube = [[0.085, 3.5], [0.16, 3.468], [0.23, 3.452], [0.29, 3.47], [0.318, 3.51]];
    const ovary = ellPts(0.265, 3.54, 0.048, 0.03, 12, -10);
    parts.push({ d: [S(ovary), S(mx(ovary))], fill: ORGC.ovary, shade: "small" });
    parts.push({ unite: [S(ut), S(tubePts(tube, 0.026, { taper: (t) => 0.8 + t * 0.7 })), S(tubePts(mx(tube), 0.026, { taper: (t) => 0.8 + t * 0.7 })), S(tubePts([[0, 3.74], [0, 4.0]], 0.06))], fill: ORGC.uterus, shade: "organelle", gloss: false });
    parts.push({ d: S([[0, 3.615], [0.1, 3.625], [0.155, 3.685], [0.15, 3.78], [0.09, 3.85], [0.035, 3.885], [0, 3.9], [-0.035, 3.885], [-0.09, 3.85], [-0.15, 3.78], [-0.155, 3.685], [-0.1, 3.625]]), fill: ORGC.bladder, shade: "organelle", gloss: false });
  } else {
    // seminal vesicles behind the bladder; vas deferens from the epididymis up the spermatic cord to the deep
    // inguinal ring (±0.25, 3.53), over the ureter and down behind the bladder (its end is hidden there);
    // prostate under the bladder neck; testes ~0.4 × kidney length with the epididymis on the lateral side
    parts.push({ d: [S([[0.1, 3.73], [0.16, 3.71], [0.2, 3.76], [0.17, 3.82], [0.11, 3.81]]), S(mx([[0.1, 3.73], [0.16, 3.71], [0.2, 3.76], [0.17, 3.82], [0.11, 3.81]]))], fill: ORGC.vesicle, shade: "small" });
    const vas = [[0.1, 4.03], [0.125, 3.92], [0.17, 3.78], [0.215, 3.64], [0.245, 3.56], [0.235, 3.515], [0.195, 3.51], [0.16, 3.54], [0.13, 3.6], [0.11, 3.7], [0.07, 3.82]];
    parts.push(line([SO(vas), SO(mx(vas))], ORGC.vas, 0.018));
    parts.push({ d: S([[0, 3.57], [0.1, 3.58], [0.155, 3.64], [0.15, 3.74], [0.09, 3.81], [0.04, 3.84], [0, 3.86], [-0.04, 3.84], [-0.09, 3.81], [-0.15, 3.74], [-0.155, 3.64], [-0.1, 3.58]]), fill: ORGC.bladder, shade: "organelle", gloss: false });
    parts.push({ d: S([[0, 3.84], [0.06, 3.845], [0.085, 3.885], [0.07, 3.94], [0.03, 3.965], [0, 3.97], [-0.03, 3.965], [-0.07, 3.94], [-0.085, 3.885], [-0.06, 3.845]]), fill: ORGC.prostate, shade: "small" });
    const testis = ellPts(0.064, 4.11, 0.05, 0.095, 14, -6), epi = [[0.085, 4.0], [0.118, 4.012], [0.135, 4.07], [0.132, 4.15], [0.112, 4.19], [0.1, 4.16], [0.113, 4.08], [0.1, 4.03]];
    parts.push({ d: [S(testis), S(mx(testis))], fill: ORGC.testis, shade: "small" });
    parts.push({ d: [S(epi), S(mx(epi))], fill: ORGC.epid, shade: "small", thin: true });
  }
  return fit(parts, { lineWidth: 1.6 });
}

/* ---------------- skeleton (anatomy) ---------------- */

/*
 * Plan — human-skeleton-front.
 * Front view, anatomical position (palms forward), drawn on the same hu grid and limb keys as the neutral
 * bare body (BARE.neutral, arms abducted 12°) so it overlays human-body-outline. u = 58 → ~450 px tall.
 * Landmarks (hu from the crown): skull 0–0.985; C2–C7 0.9–1.33; jugular notch 1.38; T1–T12 1.43–2.53 (behind
 * the ribcage); sternum 1.37–2.35 (sternal angle 1.6, xiphoid 2.22–2.35); 12 rib pairs, 1–7 reach the
 * sternum by their own costal cartilage, 8–10 join the cartilage above (costal margin, infrasternal angle
 * ~95°), 11–12 float; L1–L5 2.64–3.28; iliac crests 3.04 (± 0.62); sacrum 3.3–3.72; femoral heads ± 0.37 at
 * 3.6; knee joint 5.45; ankle 7.02. Long-bone lengths follow the outline figure's joints.
 * Paint order (back → front): scapulae · posterior ribs (darker: farther) · disc column (cartilage) ·
 * vertebrae · sacrum + coccyx · sacral foramina · hip bones (+ iliac fossa, obturator foramen as a real hole) ·
 * costal cartilages · anterior ribs · sternum · clavicles · humeri · ulnae · radii · hand bones · fibulae ·
 * tibiae · menisci · femora · patellae · foot bones · skull (cranium, orbits/nasal aperture, mandible, teeth).
 * Colours: bone #efdfb0 (Servier ivory), cartilage #cfe0ea (as ORGC.cart), openings #7d6a55 (never black).
 * Bones of one kind on one side are separate subpaths of one part, so each small bone gets its own rim.
 */
const SKC = { bone: "#ecd59c", cart: "#cfe0ea", hole: "#7d6a55", teeth: "#f8f0d8" };

/** Reverse a point list (gives a subpath the opposite winding → a hole under the nonzero rule). */
const rev = (pts) => [...pts].reverse();

/** Vertebra seen from the front: body (half-width hw, half-height hh) with transverse processes to ±tw. */
function vertebraPts(cy, hw, hh, tw) {
  const half = [[0, cy - hh - 0.004], [hw * 0.8, cy - hh], [hw, cy - hh * 0.75], [hw * 1.02, cy - hh * 0.5], [tw * 0.8, cy - hh * 0.62], [tw, cy - hh * 0.4],
    [tw + 0.008, cy - hh * 0.05], [tw * 0.85, cy + hh * 0.15], [hw * 1.03, cy + hh * 0.3], [hw, cy + hh * 0.8], [hw * 0.8, cy + hh], [0, cy + hh + 0.004]];
  return mirrorLoop(half);
}

/**
 * Shading bands along a limb-like shape (soft style only). The library's crescent rim scales with a shape's
 * length, which turns a thin long bone half dark; these bands scale with the local width instead.
 * kind "rim": a dark band inside the edge that faces the light's far side (bottom right), tapering where the
 * tube runs along the light direction; kind "hi": a light band inset from the lit edge. Returns point lists (hu).
 */
function tubeBands(keys, { per = 6, frac = 0.3, trim = 0.05, from = trim, to = 1 - trim, kind = "rim" } = {}) {
  const s = spine(keys, per), n = s.length, k2 = Math.SQRT1_2;
  const runs = [];
  let cur = null;
  for (let i = Math.round(from * (n - 1)); i <= Math.round(to * (n - 1)); i++) {
    const a = s[Math.max(0, i - 1)].p, b = s[Math.min(n - 1, i + 1)].p;
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    const nx = -ty, ny = tx; // left of travel
    const k = (nx + ny) * k2; // > 0: the left edge faces bottom right (shadow)
    let side = k >= 0 ? 1 : -1;
    if (kind === "hi") side = -side;
    const w = side > 0 ? s[i].a : s[i].b, tot = s[i].a + s[i].b, p = s[i].p;
    const g = Math.min(1, Math.abs(k) * 1.6 + 0.15);
    const [o, q] = kind === "rim" ? [w, w - frac * tot * g] : [w - 0.12 * tot, w - (0.12 + frac * g) * tot];
    if (!cur || cur.side !== side) { cur = { side, o: [], q: [] }; runs.push(cur); }
    cur.o.push([p[0] + side * nx * o, p[1] + side * ny * o]);
    cur.q.push([p[0] + side * nx * q, p[1] + side * ny * q]);
  }
  return runs.filter((r) => r.o.length > 2).map((r) => [...r.o, ...r.q.reverse()]);
}

function skeletonFront(style) {
  const u = 58;
  const X = (pts) => pts.map(([x, y]) => [x * u, y * u]);
  const S = (pts) => smoothClosed(X(pts));
  const SO = (pts) => smoothOpen(X(pts));
  const both = (pts) => [S(pts), S(mx(pts))];
  const P = BARE.neutral;
  const bone = SKC.bone, back = shade(SKC.bone, 0.07);
  const rimC = (c) => shade(c, 0.11), hiC = (c) => tint(c, 0.1);
  const parts = [];
  const add = (p) => parts.push(p);
  const B = (keys, o = {}) => limb(keys, { per: 5, capA: 0.5, capB: 0.5, ...o });
  const caps = (a, b, r) => limb([K(...a, r), K(...b, r)], { per: 2, capA: 1, capB: 1 });
  // soft-only shading bands for a list of key sets (both sides)
  // bands are computed separately for each side (on mirrored keys), so both sides are lit from the top left
  const bands = (keyList, c, { hi = false, frac = 0.3, mirror = true } = {}) => {
    const sets = mirror ? [...keyList, ...keyList.map(mxK)] : keyList;
    add({ d: sets.flatMap((k) => tubeBands(k, { frac })).map(S), fill: rimC(c), line: false });
    if (hi) add({ d: sets.flatMap((k) => tubeBands(k, { frac: 0.18, kind: "hi" })).map(S), fill: hiC(c), opacity: 0.85, line: false });
  };

  // ---- limb frames shared with the outline figure
  const ab = 12, sh = P.arm[0].p;
  const arm = P.arm.map((k) => ({ ...k, p: rotate(k.p, sh[0], sh[1], -ab) }));
  const E = arm[3].p, Wr = arm.at(-1).p, prev = arm.at(-2).p;
  const dir = (Math.atan2(Wr[0] - prev[0], Wr[1] - prev[1]) * 180) / Math.PI;
  const handT = (pts) => tr(pts, [Wr[0], Wr[1] - 0.02], -dir, P.hand);
  const legEnd = P.leg.at(-1).p;
  const footT = (pts) => tr(pts, legEnd, 0, P.foot);

  // ---- scapulae (behind the ribcage): lateral border, glenoid neck, coracoid hook, acromion
  const scap = [[0.42, 1.44], [0.56, 1.45], [0.6, 1.4], [0.7, 1.38], [0.8, 1.4], [0.81, 1.45], [0.74, 1.47], [0.68, 1.5], [0.7, 1.58], [0.66, 1.68], [0.62, 1.86], [0.57, 2.06], [0.52, 2.22], [0.47, 2.16], [0.43, 1.9], [0.4, 1.62]];
  add({ d: both(scap), fill: back, shade: "rim", thin: true });

  // ---- ribs: [head y, lateral x, lateral y, costochondral junction]
  const RIBS = [
    [1.4, 0.34, 1.42, [0.2, 1.49]], [1.5, 0.46, 1.56, [0.25, 1.68]], [1.6, 0.545, 1.7, [0.29, 1.85]], [1.7, 0.6, 1.83, [0.33, 2.0]],
    [1.8, 0.64, 1.96, [0.37, 2.14]], [1.9, 0.665, 2.08, [0.41, 2.27]], [2.0, 0.68, 2.2, [0.46, 2.4]], [2.1, 0.685, 2.32, [0.52, 2.52]],
    [2.2, 0.68, 2.44, [0.57, 2.62]], [2.3, 0.665, 2.55, [0.61, 2.7]],
  ];
  const postK = [], antK = [], cartK = [];
  RIBS.forEach(([yh, xl, yl, [cx, cy]], i) => {
    const w = i === 0 ? 0.034 : 0.028;
    postK.push([K(0.06, yh, w * 0.8), K(0.2, yh - 0.012, w), K(0.36, yh + 0.012, w), K(xl - 0.05, yl - 0.07, w), K(xl, yl, w)]);
    const mid = [lerp(xl, cx, 0.45) + 0.045, lerp(yl, cy, 0.55) + 0.02];
    antK.push([K(xl - 0.005, yl - 0.04, w), K(xl, yl, w), K(...mid, w), K(cx, cy, w * 0.95)]);
  });
  // floating ribs 11–12: short posterior arcs ending free at the flank
  postK.push([K(0.07, 2.4, 0.022), K(0.25, 2.42, 0.026), K(0.45, 2.5, 0.025), K(0.6, 2.66, 0.02)]);
  postK.push([K(0.07, 2.5, 0.02), K(0.2, 2.53, 0.022), K(0.36, 2.6, 0.02), K(0.45, 2.68, 0.016)]);
  // costal cartilages: 1–7 to the sternum, 8–10 to the cartilage above (costal margin)
  const CART = [
    [[0.2, 1.49], [0.14, 1.49], [0.09, 1.48]], [[0.25, 1.68], [0.16, 1.65], [0.07, 1.61]], [[0.29, 1.85], [0.18, 1.79], [0.065, 1.73]],
    [[0.33, 2.0], [0.2, 1.93], [0.065, 1.86]], [[0.37, 2.14], [0.22, 2.06], [0.065, 1.98]], [[0.41, 2.27], [0.24, 2.17], [0.065, 2.1]],
    [[0.46, 2.4], [0.3, 2.33], [0.16, 2.26], [0.06, 2.19]], [[0.52, 2.52], [0.44, 2.45], [0.37, 2.37]], [[0.57, 2.62], [0.52, 2.55], [0.48, 2.49]],
    [[0.61, 2.7], [0.57, 2.64], [0.54, 2.59]],
  ];
  for (const c of CART) cartK.push(c.map((p) => K(...p, 0.022)));
  const ribsD = (list, o) => { const r = list.map((k) => B(k, o)); return [...r.map(S), ...r.map((p) => S(mx(p)))]; };
  add({ d: ribsD(postK, { capB: 0 }), fill: back, thin: true });
  bands(postK, back);

  // ---- vertebral column: intervertebral discs (cartilage strip) behind the vertebrae
  const disc = mirrorLoop([[0, 0.85], [0.045, 0.86], [0.05, 1.35], [0.06, 1.42], [0.075, 2.5], [0.095, 2.64], [0.11, 3.28], [0, 3.3]]);
  add({ d: S(disc), fill: SKC.cart, shade: "rim", thin: true });
  const verts = [];
  [0.9, 0.98, 1.06, 1.14, 1.22, 1.3].forEach((y, i) => verts.push(vertebraPts(y, 0.048 + i * 0.002, 0.031, 0.085)));
  for (let i = 0; i < 12; i++) verts.push(vertebraPts(1.43 + i * 0.1, 0.055 + i * 0.0022, 0.04, 0.11 - i * 0.002));
  [2.69, 2.825, 2.96, 3.095, 3.23].forEach((y, i) => verts.push(vertebraPts(y, 0.1 + i * 0.004, 0.05, [0.16, 0.19, 0.215, 0.2, 0.185][i])));
  add({ d: verts.map(S), fill: bone, shade: "small", thin: true });

  // ---- pubic symphysis disc, articular cartilage of the hip sockets
  add({ d: S(mirrorLoop([[0, 3.66], [0.04, 3.665], [0.04, 3.81], [0, 3.815]])), fill: SKC.cart, thin: true });

  // ---- sacrum (alae to apex) + coccyx; anterior sacral foramina (shallow pits)
  const sac = mirrorLoop([[0, 3.29], [0.12, 3.29], [0.19, 3.31], [0.2, 3.36], [0.15, 3.47], [0.11, 3.58], [0.07, 3.68], [0.035, 3.73], [0, 3.74]]);
  add({ unite: [S(sac), S(mirrorLoop([[0, 3.72], [0.025, 3.73], [0.018, 3.79], [0, 3.81]]))], fill: bone, shade: "organelle", gloss: false });
  add({ d: [[3.4, 0.02], [3.48, 0.017], [3.56, 0.014], [3.63, 0.011]].flatMap(([y, r]) => both(ellPts(0.072 - (y - 3.4) * 0.22, y, r, r * 0.75, 10))), fill: shade(bone, 0.2), shade: "dip", thin: true });

  // ---- hip bones: ilium wing (fossa, arcuate line), acetabulum, pubis, ischium; obturator foramen is a hole
  const hip = [[0.15, 3.22], [0.22, 3.11], [0.34, 3.045], [0.47, 3.05], [0.575, 3.11], [0.635, 3.2], [0.632, 3.29], [0.6, 3.335], [0.578, 3.375], [0.566, 3.43], [0.53, 3.48], [0.5, 3.53],
    [0.49, 3.62], [0.475, 3.71], [0.44, 3.8], [0.41, 3.9], [0.37, 3.96], [0.31, 3.97], [0.25, 3.93], [0.15, 3.865], [0.07, 3.835], [0.042, 3.8], [0.04, 3.68],
    [0.08, 3.66], [0.17, 3.635], [0.26, 3.59], [0.3, 3.53], [0.24, 3.47], [0.18, 3.41], [0.15, 3.33]];
  const obt = ellPts(0.225, 3.78, 0.075, 0.052, 12, -25);
  // the library's inset highlight would fall into the obturator hole, so the hip bones get rim shading and a
  // hand-made light band just under the iliac crest (soft only)
  add({ d: [S(hip) + S(rev(obt)), S(mx(hip)) + S(rev(mx(obt)))], fill: bone, shade: "organelle", gloss: false, highlight: false });
  const crest = [[0.2, 3.15], [0.25, 3.1], [0.34, 3.06], [0.47, 3.065], [0.565, 3.12], [0.615, 3.2]];
  const crestBand = [...crest.map(([x, y]) => [x, y + 0.008]), ...rev(crest).map(([x, y], i, a) => [x - 0.012, y + (i === 0 || i === a.length - 1 ? 0.012 : 0.032)])];
  add({ d: both(crestBand), fill: hiC(bone), opacity: 0.85, line: false });
  const fossa = [[0.22, 3.15], [0.33, 3.09], [0.46, 3.09], [0.56, 3.14], [0.6, 3.22], [0.57, 3.31], [0.48, 3.38], [0.36, 3.42], [0.26, 3.4], [0.2, 3.32], [0.19, 3.23]];
  add({ d: both(fossa), fill: shade(bone, 0.045), shade: "dip", line: false });
  add({ d: [SO([[0.17, 3.39], [0.23, 3.45], [0.29, 3.52]]), SO(mx([[0.17, 3.39], [0.23, 3.45], [0.29, 3.52]]))], fill: "none", stroke: { color: shade(bone, 0.16), width: 0.014 * u, cap: "round" }, lineStrokeWidth: 0.012 * u });
  add({ d: both(ellPts(0.39, 3.605, 0.1, 0.1, 14)), fill: SKC.cart, shade: "rim", thin: true });

  // ---- thorax front: costal cartilages, anterior ribs, sternum (manubrium, body, xiphoid)
  add({ d: ribsD(cartK, { capA: 0.2, capB: 0.6 }), fill: SKC.cart, thin: true });
  bands(cartK, SKC.cart);
  add({ d: ribsD(antK, { capA: 0.3, capB: 0.2 }), fill: bone, thin: true });
  bands(antK, bone);
  const sternum = mirrorLoop([[0, 1.395], [0.04, 1.37], [0.085, 1.385], [0.105, 1.43], [0.1, 1.49], [0.07, 1.56], [0.058, 1.605], [0.068, 1.65], [0.074, 1.9], [0.068, 2.13], [0.045, 2.21], [0.028, 2.24], [0.02, 2.32], [0, 2.35]]);
  add({ d: S(sternum), fill: bone, shade: "organelle", gloss: false });
  add({ d: SO([[-0.058, 1.607], [0, 1.6], [0.058, 1.607]]), fill: "none", stroke: { color: shade(bone, 0.14), width: 0.012 * u, cap: "round" }, lineStrokeWidth: 0.01 * u });

  // ---- clavicles (S-curve from the manubrium to the acromion)
  const clavK = [K(0.075, 1.405, 0.03), K(0.2, 1.43, 0.026), K(0.36, 1.41, 0.024), K(0.52, 1.37, 0.023), K(0.66, 1.372, 0.026), K(0.775, 1.42, 0.028)];
  add({ d: both(B(clavK, { capA: 0.7, capB: 0.6 })), fill: bone });
  bands([clavK], bone);

  // ---- humerus: head in the glenoid (cartilage cap), greater tubercle, shaft, epicondyles at the elbow
  const axis = [E[0] - sh[0], E[1] - sh[1]], al = Math.hypot(...axis), ax = [axis[0] / al, axis[1] / al], nrm = [ax[1], -ax[0]];
  const at = (p, t, n = 0) => [p[0] + ax[0] * t + nrm[0] * n, p[1] + ax[1] * t + nrm[1] * n];
  add({ d: both(ellPts(0.73, 1.555, 0.098, 0.1, 14)), fill: SKC.cart, shade: "rim", thin: true });
  const humK = [K(...at(sh, 0.0, 0.01), 0.075), K(...at(sh, 0.18, 0.0), 0.05), K(...at(sh, 0.7, 0.0), 0.042), K(...at(E, -0.17, 0), 0.05), K(...at(E, -0.07, 0), 0.105), K(...at(E, 0.0, 0), 0.09)];
  const hum = [ellPts(0.735, 1.555, 0.086, 0.09, 14), B(humK, { capA: 0.6, capB: 0.15 }), ellPts(...at(sh, 0.03, 0.06), 0.06, 0.07, 10)];
  const pair = (list, extra = {}) => { add({ unite: list.map(S), fill: bone, ...extra }); add({ unite: list.map((p) => S(mx(p))), fill: bone, ...extra }); };
  pair(hum);
  bands([humK], bone, { hi: true });

  // ---- forearm (supinated: radius lateral, ulna medial, parallel)
  const fa = [Wr[0] - E[0], Wr[1] - E[1]], fl = Math.hypot(...fa), fx = [fa[0] / fl, fa[1] / fl], fn = [fx[1], -fx[0]];
  const fat = (p, t, n) => [p[0] + fx[0] * t + fn[0] * n, p[1] + fx[1] * t + fn[1] * n];
  const ulnaK = [K(...fat(E, 0.0, -0.045), 0.04), K(...fat(E, 0.1, -0.05), 0.034), K(...fat(E, fl * 0.5, -0.055), 0.022), K(...fat(Wr, -0.08, -0.058), 0.02), K(...fat(Wr, -0.01, -0.058), 0.027)];
  const radK = [K(...fat(E, 0.03, 0.05), 0.03), K(...fat(E, 0.1, 0.05), 0.022), K(...fat(E, fl * 0.5, 0.05), 0.026), K(...fat(Wr, -0.1, 0.045), 0.04), K(...fat(Wr, -0.01, 0.04), 0.05)];
  add({ d: both(B(ulnaK, { capA: 0.8, capB: 0.6 })), fill: bone, thin: true });
  bands([ulnaK], bone);
  add({ d: both(B(radK, { capA: 0.8, capB: 0.3 })), fill: bone, thin: true });
  bands([radK], bone);

  // ---- hand: carpals, metacarpals, phalanges (local hand frame of openHandLocal: thumb toward +x)
  const F = [[0.107, 0.4, 4, 0.32], [0.034, 0.42, 0.5, 0.36], [-0.041, 0.415, -3, 0.34], [-0.112, 0.385, -7, 0.27]];
  const carp = [[0.072, 0.04, 0.04, 0.03, 30], [0.0, 0.035, 0.034, 0.03, 0], [-0.066, 0.045, 0.03, 0.028, -20], [-0.098, 0.068, 0.019, 0.019, 0],
    [0.105, 0.105, 0.03, 0.027, 20], [0.055, 0.113, 0.024, 0.026, 0], [0.0, 0.118, 0.031, 0.04, 0], [-0.063, 0.112, 0.032, 0.036, -8]];
  const handBones = [], carpals = carp.map(([x, y, rx, ry, r]) => ellPts(x, y, rx, ry, 10, r));
  const mcBase = [0.07, 0.024, -0.024, -0.068];
  F.forEach(([x, y, a, len], i) => {
    const dx = Math.sin((a * Math.PI) / 180), dy = Math.cos((a * Math.PI) / 180);
    const fp = (t) => [x + dx * len * t, y + dy * len * t];
    const m = [x - dx * 0.035, y - dy * 0.035];
    const r = [0.02, 0.021, 0.019, 0.017][i];
    handBones.push(limb([K(mcBase[i], 0.158, r * 0.9), K((mcBase[i] + m[0]) / 2, (0.158 + m[1]) / 2, r * 0.7), K(...m, r * 1.05)], { per: 3, capA: 0.6, capB: 0.9 }));
    handBones.push(caps([m[0] + dx * 0.022, m[1] + dy * 0.022], fp(0.42), r * 0.82));
    handBones.push(caps(fp(0.5), fp(0.72), r * 0.72));
    handBones.push(limb([K(...fp(0.79), r * 0.62), K(...fp(0.93), r * 0.5), K(...fp(0.98), r * 0.62)], { per: 2, capA: 0.8, capB: 0.8 }));
  });
  { // thumb: metacarpal on the trapezium, two phalanges
    const ta = 33, tl = 0.31, tb = [0.118, 0.12];
    const dx = Math.sin((ta * Math.PI) / 180), dy = Math.cos((ta * Math.PI) / 180);
    const tp = (t) => [tb[0] + dx * tl * t, tb[1] + dy * tl * t];
    handBones.push(limb([K(0.122, 0.135, 0.02), K(...tp(0.22), 0.017), K(...tp(0.4), 0.023)], { per: 3, capA: 0.6, capB: 0.9 }));
    handBones.push(caps(tp(0.5), tp(0.72), 0.019));
    handBones.push(limb([K(...tp(0.8), 0.017), K(...tp(0.93), 0.013), K(...tp(0.99), 0.015)], { per: 2, capA: 0.8, capB: 0.8 }));
  }
  const handD = (list, m) => list.map((p) => S(m(handT(p)))).join("");
  add({ d: [handD(carpals, (q) => q), handD(carpals, mx)], fill: bone, shade: "small", thin: true });
  add({ d: [handD(handBones, (q) => q), handD(handBones, mx)], fill: bone, shade: "small", thin: true });

  // ---- lower limb: fibula behind the tibia, menisci, femur in the hip socket, patella
  const fibK = [K(0.43, 5.555, 0.036), K(0.425, 5.66, 0.02), K(0.405, 6.4, 0.017), K(0.385, 6.93, 0.024), K(0.378, 7.06, 0.034)];
  add({ d: both(B(fibK, { capA: 0.8, capB: 0.7 })), fill: bone, thin: true });
  bands([fibK], bone);
  const tibK = [K(0.305, 5.47, 0.135, 0.13), K(0.31, 5.6, 0.085, 0.075), K(0.305, 5.9, 0.055, 0.05), K(0.295, 6.5, 0.045, 0.042), K(0.29, 6.86, 0.06, 0.05), K(0.285, 6.99, 0.07, 0.06)];
  pair([B(tibK, { capA: 0.05, capB: 0.25 }), caps([0.235, 6.93], [0.228, 7.055], 0.027)]);
  bands([tibK], bone, { hi: true });
  add({ d: [...both(ellPts(0.235, 5.452, 0.062, 0.014, 10)), ...both(ellPts(0.385, 5.452, 0.054, 0.014, 10))], fill: SKC.cart, shade: "small", thin: true });
  const femK = [K(0.57, 3.74, 0.06), K(0.52, 4.1, 0.055), K(0.425, 4.7, 0.05), K(0.35, 5.12, 0.058), K(0.315, 5.3, 0.12)];
  pair([ellPts(0.39, 3.605, 0.083, 0.083, 14), caps([0.39, 3.615], [0.565, 3.715], 0.046), ellPts(0.6, 3.7, 0.055, 0.072, 12, 10), ellPts(0.5, 3.87, 0.03, 0.028, 8),
    B(femK, { capA: 0.3, capB: 0 }), ellPts(0.245, 5.375, 0.078, 0.056, 12), ellPts(0.39, 5.38, 0.07, 0.052, 12)]);
  bands([femK], bone, { hi: true });
  const pat = [[0.315, 5.15], [0.37, 5.165], [0.39, 5.23], [0.37, 5.3], [0.318, 5.355], [0.265, 5.3], [0.243, 5.23], [0.262, 5.165]];
  add({ d: both(pat), fill: bone, shade: "small" });

  // ---- foot (front view, foreshortened): talus, tarsals, metatarsals, phalanges
  const FT = bareFootLocal();
  const tars = [ellPts(0.0, 0.045, 0.085, 0.048, 12), ellPts(0.085, 0.08, 0.05, 0.04, 10), ellPts(-0.06, 0.12, 0.06, 0.03, 10), ellPts(0.105, 0.145, 0.052, 0.038, 10),
    ellPts(-0.112, 0.19, 0.034, 0.03, 8), ellPts(-0.045, 0.186, 0.028, 0.028, 8), ellPts(0.02, 0.182, 0.028, 0.027, 8)];
  const footBones = [];
  const mtBase = [[-0.11, 0.21], [-0.045, 0.21], [0.02, 0.208], [0.085, 0.19], [0.13, 0.18]];
  [FT.hallux, ...FT.mtp].forEach((m, i) => {
    const r = i === 0 ? 0.03 : 0.015;
    footBones.push(limb([K(...mtBase[i], r * 0.95), K((mtBase[i][0] + m[0]) / 2, (mtBase[i][1] + m[1]) / 2, r * 0.75), K(...m, r * 1.05)], { per: 3, capA: 0.6, capB: 0.9 }));
    const [tx, ty, , ry] = FT.toes[i];
    if (i === 0) {
      footBones.push(caps([m[0] - 0.002, m[1] + 0.035], [tx, ty - 0.005], 0.024));
      footBones.push(caps([tx - 0.002, ty + 0.025], [tx - 0.004, ty + ry * 0.75], 0.022));
    } else {
      footBones.push(caps([m[0] + (tx - m[0]) * 0.25, m[1] + 0.024], [tx, ty - 0.004], 0.012));
      footBones.push(caps([tx + 0.001, ty + 0.014], [tx + 0.002, ty + ry * 0.7], 0.011));
    }
  });
  const footD = (list, m) => list.map((p) => S(m(footT(p)))).join("");
  add({ d: [footD(tars, (q) => q), footD(tars, mx)], fill: bone, shade: "small", thin: true });
  add({ d: [footD(footBones, (q) => q), footD(footBones, mx)], fill: bone, shade: "small", thin: true });

  // ---- skull: cranium with zygomatic arches, orbits and nasal aperture, mandible, teeth
  const cran = mirrorLoop([[0, 0.02], [0.17, 0.04], [0.27, 0.12], [0.318, 0.25], [0.322, 0.38], [0.3, 0.48], [0.322, 0.545], [0.318, 0.6], [0.27, 0.635], [0.215, 0.67], [0.17, 0.73], [0.125, 0.785], [0, 0.79]]);
  add({ d: S(cran), fill: bone, shade: "body", gloss: false });
  const orbit = [[0.05, 0.415], [0.13, 0.385], [0.2, 0.4], [0.225, 0.46], [0.205, 0.525], [0.13, 0.545], [0.06, 0.525], [0.04, 0.47]];
  const nasal = mirrorLoop([[0, 0.565], [0.022, 0.575], [0.04, 0.62], [0.048, 0.665], [0.03, 0.69], [0, 0.685]]);
  add({ d: [...both(orbit), S(nasal)], fill: SKC.hole, shade: "dip", thin: true });
  const mand = mirrorLoop([[0, 0.795], [0.09, 0.795], [0.15, 0.785], [0.205, 0.735], [0.235, 0.655], [0.27, 0.625], [0.275, 0.7], [0.262, 0.8], [0.225, 0.875], [0.15, 0.94], [0.08, 0.975], [0, 0.985]]);
  // mandible: rim shading (dark on the right/bottom) + a light band inside the lit (viewer's left) outer edge only
  add({ d: S(mand), fill: bone, shade: "rim" });
  const mOut = [[0.268, 0.66], [0.27, 0.72], [0.256, 0.8], [0.22, 0.872], [0.15, 0.932], [0.08, 0.966], [0.03, 0.976]];
  const toC = (k) => ([x, y]) => [x * k, 0.8 + (y - 0.8) * k];
  add({ d: S(mx([...mOut.map(toC(0.95)), ...rev(mOut).map(toC(0.86))])), fill: hiC(bone), opacity: 0.85, line: false });
  // teeth: incisors, canines, first premolars, upper and lower, meeting at the occlusal line (y 0.79)
  const teeth = [];
  [[0.021, 0.018, 0.044, 0.038], [0.06, 0.017, 0.04, 0.036], [0.097, 0.016, 0.043, 0.035], [0.13, 0.014, 0.032, 0.027]].forEach(([x, w, up, lo]) => {
    for (const s of [1, -1]) {
      const c = s * x;
      teeth.push(S([[c - w, 0.788 - up], [c + w, 0.788 - up], [c + w * 0.92, 0.787], [c - w * 0.92, 0.787]]));
      teeth.push(S([[c - w * 0.88, 0.793], [c + w * 0.88, 0.793], [c + w * 0.82, 0.793 + lo], [c - w * 0.82, 0.793 + lo]]));
    }
  });
  add({ d: teeth.join(""), fill: SKC.teeth, shade: "small", thin: true });

  return fit(parts, { lineWidth: 1.4 });
}

/* ---------------- muscular system (anatomy) ---------------- */

/*
 * Plan — human-muscular-system-front.
 * Bare male body (BARE.male, arms abducted 12°, u = 58) as a grey base (head, hands and feet stay grey, like a
 * mannequin), a dark-red deep-muscle layer over neck, trunk and limbs that shows in the gaps, then the major
 * superficial muscles, simplified, in anatomical position (palms forward). Limb muscles are placed in limb
 * frames: t runs along the limb (0 shoulder/hip → 1 wrist/ankle; elbow ≈ 0.5, knee ≈ 0.62) and f across it
 * (−1 medial edge … +1 lateral edge), so they follow the abducted arm and the tapering leg.
 * Muscles: SCM, trapezius (upper), deltoid, pectoralis major, serratus anterior, latissimus (flank edge),
 * external oblique, rectus abdominis (3 tendinous intersections, linea alba), biceps, brachialis, triceps
 * (medial head), brachioradialis, forearm flexors, FCU; TFL + iliotibial tract, sartorius, adductors,
 * rectus femoris, vastus lateralis/medialis, patella + patellar ligament, tibialis anterior, fibularis longus,
 * gastrocnemius + soleus (medial edge), subcutaneous tibia.
 * Paint order: base · deep layer · aponeuroses/tendons (cream) · muscles back → front · fibre lines.
 * Colours: muscle #e07572, deep #b9525a, tendon/aponeurosis #f2e4cf, base BODY_GREY. Bulky muscles use the
 * organelle crescent; straps (SCM, sartorius) are flat with width-scaled bands (tubeBands).
 * Variation: fibre lines are seeded so the two sides are not stamped copies.
 */
const MUS = { muscle: "#e07572", deep: "#b9525a", tendon: "#f2e4cf" };

/** Point in a limb frame: t along the limb's spine (0..1), f across it (−1 medial/left-of-travel … +1 lateral). */
function frameOf(keys, per = 6) {
  const s = spine(keys, per), n = s.length;
  return (t, f) => {
    const i = Math.max(0, Math.min(n - 1, t * (n - 1))), i0 = Math.min(n - 2, Math.floor(i)), w = i - i0;
    const A = s[i0], Bq = s[i0 + 1];
    const p = [lerp(A.p[0], Bq.p[0], w), lerp(A.p[1], Bq.p[1], w)], a = lerp(A.a, Bq.a, w), b = lerp(A.b, Bq.b, w);
    let tx = Bq.p[0] - A.p[0], ty = Bq.p[1] - A.p[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    const nx = -ty, ny = tx;
    return f < 0 ? [p[0] + nx * -f * a, p[1] + ny * -f * a] : [p[0] - nx * f * b, p[1] - ny * f * b];
  };
}

function muscularFront(style) {
  const u = 58;
  const fig = bareBody({ body: "male", abduct: 12, u });
  const { X, S, SO } = fig;
  const R = rng(4242);
  const both = (pts) => [S(pts), S(mx(pts))];
  const parts = [silhouettePart(fig.outline, BODY_GREY, style, 1.3)];
  const add = (p) => parts.push(p);
  const armF = frameOf(fig.arm), legF = frameOf(fig.legKeys);
  const AF = (list) => list.map(([t, f]) => armF(t, f));
  const LF = (list) => list.map(([t, f]) => legF(t, f));
  const P = fig.P, Bd = fig.B;

  // containment check against the united silhouette pieces (a point counts as inside if it is inside any piece)
  const pieces = fig.outline.map((d) => flatten(d));
  const inside = (pts, label, margin = 0.6) => {
    const bad = X(pts).filter((p) => !pieces.some((pc) => insideShape(pc, p) && edgeDistance(pc, p) >= margin));
    if (bad.length) console.warn(`  ! containment: ${label} — ${bad.length} point(s) outside the body: ${bad.map(([x, y]) => (x / u).toFixed(2) + "," + (y / u).toFixed(2)).join(" ")}`);
    return pts;
  };
  const M = (pts, label) => both(inside(pts, label));

  // ---- deep layer: neck, trunk and limbs (not head, hands, feet)
  const deep = [];
  for (const m of [(q) => q, mx]) {
    deep.push(S(m(limb(fig.legO, { capA: 0, capB: 0 }))));
    deep.push(S(m(limb(fig.armO, { capA: 0.8, capB: 0 }))));
  }
  deep.push(S(mirrorLoop(P.torso)));
  const nw = Bd.neck, [ny0, ny1] = Bd.neckY;
  deep.push(S([[nw * 0.95, 0.86], [nw, ny1 - 0.3], [nw + 0.1, ny1 - 0.12], [0, ny1 - 0.05], [-nw - 0.1, ny1 - 0.12], [-nw, ny1 - 0.3], [-nw * 0.95, 0.86], [0, 0.98]]));
  add({ unite: deep, fill: MUS.deep, thin: true });

  // ---- aponeuroses and tendons (cream), under the muscles that attach to them
  const apo = mirrorLoop([[0, 2.14], [0.21, 2.18], [0.25, 2.5], [0.31, 2.95], [0.41, 3.2], [0.5, 3.29], [0.38, 3.43], [0.24, 3.57], [0.12, 3.68], [0, 3.71]]);
  add({ d: S(inside(apo, "abdominal aponeurosis")), fill: MUS.tendon, shade: "rim", thin: true });
  const kneeT = [[0.515, -0.32], [0.52, 0.3], [0.585, 0.42], [0.63, 0.3], [0.69, 0.22], [0.7, -0.15], [0.63, -0.3], [0.585, -0.42]];
  const tibiaSurf = [[0.67, -0.12], [0.76, -0.2], [0.88, -0.16], [0.97, -0.2], [0.985, -0.42], [0.88, -0.5], [0.76, -0.52], [0.67, -0.42]];
  const itTract = [[0.17, 0.66], [0.24, 0.92], [0.42, 0.93], [0.56, 0.9], [0.61, 0.78], [0.56, 0.7], [0.42, 0.74], [0.28, 0.68]];
  add({ d: [...M(LF(kneeT), "knee tendons"), ...M(LF(tibiaSurf), "tibia"), ...M(LF(itTract), "IT tract")], fill: MUS.tendon, shade: "rim", thin: true });
  // forearm flexor tendons into the wrist
  const tend = [[[0.84, 0.12], [0.99, 0.1]], [[0.86, -0.08], [0.99, -0.04]], [[0.9, -0.45], [0.99, -0.42]]].map((l) => AF(l));
  add({ d: tend.flatMap((l) => [SO(l), SO(mx(l))]), fill: "none", stroke: { color: MUS.tendon, width: 0.026 * u, cap: "round" }, lineStrokeWidth: 0.02 * u, lineColor: shade(MUS.tendon, 0.35) });

  // ---- trunk muscles, back to front
  const trap = [[0.18, 1.02], [0.19, 1.16], [0.32, 1.27], [0.5, 1.32], [0.64, 1.375], [0.6, 1.405], [0.44, 1.39], [0.3, 1.37], [0.2, 1.33], [0.16, 1.2]];
  const lat = [[0.72, 1.9], [0.75, 1.98], [0.705, 2.3], [0.65, 2.58], [0.62, 2.58], [0.66, 2.3], [0.69, 2.0]];
  add({ d: [...M(trap, "trapezius"), ...M(lat, "latissimus")], fill: MUS.muscle, shade: "rim", thin: true });
  const scmK = [K(0.165, 0.93, 0.028), K(0.135, 1.08, 0.034), K(0.095, 1.25, 0.038), K(0.05, 1.38, 0.032)];
  add({ d: M(limb(scmK, { capA: 0.6, capB: 0.6 }), "SCM"), fill: MUS.muscle, thin: true });
  add({ d: [...tubeBands(scmK).map(S), ...tubeBands(mxK(scmK)).map(S)], fill: shade(MUS.muscle, 0.11), line: false });
  const serr = [[0.64, 1.98], [0.635, 2.12], [0.615, 2.26], [0.59, 2.4]].map(([x, y], i) => limb([K(x + 0.06, y - 0.035, 0.028), K(x - 0.02, y + 0.012, 0.03), K(x - 0.075 + i * 0.01, y + 0.045, 0.018)], { per: 3, capA: 0.8, capB: 0.9 }));
  add({ d: serr.flatMap((p) => M(p, "serratus")), fill: MUS.muscle, shade: "small", thin: true });
  const obl = [[0.25, 2.2], [0.38, 2.17], [0.5, 2.2], [0.6, 2.32], [0.64, 2.5], [0.625, 2.75], [0.605, 2.95], [0.605, 3.12], [0.6, 3.2], [0.53, 3.22], [0.44, 3.12], [0.34, 2.95], [0.27, 2.72], [0.235, 2.45]];
  add({ d: M(obl, "external oblique"), fill: MUS.muscle, shade: "organelle", gloss: false });
  // rectus abdominis: four bellies between the tendinous intersections, narrowing to the pubis
  const rx = (y) => lerp(0.205, 0.135, Math.max(0, Math.min(1, (y - 2.2) / 1.45)));
  // three upper bellies between the tendinous intersections, then one continuous lower segment per side
  // (≈0.13 hu wide at the umbilicus, tapering to ≈0.07 at the pubic crest); only the thin linea alba between sides
  const RA = [[2.21, 2.38, 0.015], [2.42, 2.63, -0.012], [2.67, 2.9, 0.01]].map(([y0, y1, tilt]) =>
    [[0.018, y0 + 0.012], [rx(y0) * 0.6, y0], [rx(y0), y0 + tilt + 0.01], [rx(y0) + 0.008, (y0 + y1) / 2], [rx(y1), y1 - 0.012], [rx(y1) * 0.6, y1 + tilt * 0.5], [0.018, y1]]);
  RA.push([[0.018, 2.955], [0.085, 2.94], [0.15, 2.952], [0.153, 3.1], [0.146, 3.3], [0.124, 3.47], [0.098, 3.58], [0.088, 3.645], [0.05, 3.665], [0.018, 3.66], [0.016, 3.3]]);
  add({ d: RA.flatMap((p) => M(p, "rectus")), fill: MUS.muscle, shade: "organelle", gloss: false });
  const pec = [[0.045, 1.43], [0.2, 1.44], [0.4, 1.415], [0.56, 1.44], [0.66, 1.55], ...AF([[0.17, -0.35], [0.23, -0.55]]), [0.74, 1.86], [0.6, 1.99], [0.42, 2.12], [0.22, 2.2], [0.065, 2.17], [0.045, 1.8]];
  add({ d: M(pec, "pectoralis major"), fill: MUS.muscle, shade: "organelle", gloss: false });

  // ---- upper limb
  const tri = AF([[0.22, -0.68], [0.32, -0.66], [0.43, -0.7], [0.48, -0.86], [0.38, -0.9], [0.27, -0.88]]);
  const brach = AF([[0.3, 0.52], [0.38, 0.86], [0.47, 0.84], [0.53, 0.45], [0.47, 0.36], [0.38, 0.46]]);
  add({ d: [...M(tri, "triceps"), ...M(brach, "brachialis")], fill: MUS.muscle, shade: "rim", thin: true });
  const bic = AF([[0.19, -0.35], [0.25, 0.22], [0.34, 0.42], [0.43, 0.32], [0.49, 0.08], [0.53, -0.02], [0.47, -0.32], [0.38, -0.62], [0.29, -0.64], [0.23, -0.55]]);
  add({ d: M(bic, "biceps"), fill: MUS.muscle, shade: "organelle", gloss: false });
  const brad = AF([[0.44, 0.6], [0.5, 0.88], [0.6, 0.87], [0.75, 0.75], [0.9, 0.55], [0.95, 0.42], [0.89, 0.3], [0.75, 0.33], [0.6, 0.38], [0.5, 0.42]]);
  const flex = AF([[0.53, -0.08], [0.56, 0.3], [0.66, 0.31], [0.79, 0.22], [0.87, 0.1], [0.85, -0.1], [0.75, -0.24], [0.62, -0.32]]);
  const fcu = AF([[0.53, -0.32], [0.63, -0.42], [0.77, -0.33], [0.9, -0.28], [0.93, -0.46], [0.85, -0.8], [0.7, -0.9], [0.56, -0.86]]);
  add({ d: [...M(brad, "brachioradialis"), ...M(flex, "flexors"), ...M(fcu, "FCU")], fill: MUS.muscle, shade: "organelle", gloss: false });
  const delt = [[0.6, 1.425], [0.74, 1.418], [0.86, 1.478], ...AF([[0.03, 0.9], [0.13, 0.9], [0.25, 0.55], [0.2, -0.05], [0.11, -0.5]]), [0.7, 1.6], [0.63, 1.5]];
  add({ d: M(delt, "deltoid"), fill: MUS.muscle, shade: "organelle", gloss: false });

  // ---- lower limb
  const add1 = LF([[0.04, -0.12], [0.1, 0.1], [0.22, -0.2], [0.35, -0.5], [0.43, -0.76], [0.4, -0.9], [0.25, -0.93], [0.12, -0.88], [0.05, -0.68]]);
  add({ d: M(add1, "adductors"), fill: MUS.muscle, shade: "organelle", gloss: false });
  const vl = LF([[0.15, 0.48], [0.25, 0.82], [0.38, 0.86], [0.5, 0.76], [0.56, 0.58], [0.5, 0.44], [0.38, 0.44], [0.25, 0.4]]);
  const vm = LF([[0.36, -0.2], [0.45, -0.1], [0.53, -0.04], [0.575, -0.25], [0.565, -0.58], [0.5, -0.76], [0.42, -0.68]]);
  add({ d: [...M(vl, "vastus lateralis"), ...M(vm, "vastus medialis")], fill: MUS.muscle, shade: "organelle", gloss: false });
  const tfl = LF([[0.06, 0.52], [0.06, 0.88], [0.16, 0.9], [0.23, 0.82], [0.19, 0.6], [0.12, 0.5]]);
  const rf = LF([[0.1, 0.22], [0.18, 0.48], [0.3, 0.48], [0.42, 0.34], [0.5, 0.15], [0.53, 0.04], [0.5, -0.1], [0.4, -0.14], [0.28, -0.1], [0.16, 0.04]]);
  add({ d: [...M(tfl, "TFL"), ...M(rf, "rectus femoris")], fill: MUS.muscle, shade: "organelle", gloss: false });
  const sarK = [[0.04, 0.72], [0.14, 0.36], [0.27, -0.14], [0.4, -0.56], [0.52, -0.7], [0.61, -0.64]].map(([t, f]) => K(...legF(t, f), 0.034));
  add({ d: M(limb(sarK, { capA: 0.5, capB: 0.6 }), "sartorius"), fill: MUS.muscle, thin: true });
  add({ d: [...tubeBands(sarK).map(S), ...tubeBands(mxK(sarK)).map(S)], fill: shade(MUS.muscle, 0.11), line: false });
  const gas = LF([[0.635, -0.48], [0.7, -0.47], [0.78, -0.52], [0.84, -0.66], [0.82, -0.9], [0.7, -0.94], [0.64, -0.8]]);
  const sol = LF([[0.8, -0.5], [0.88, -0.5], [0.93, -0.62], [0.9, -0.86], [0.84, -0.9], [0.82, -0.72]]);
  const per = LF([[0.665, 0.6], [0.7, 0.9], [0.8, 0.88], [0.88, 0.74], [0.86, 0.52], [0.76, 0.56]]);
  add({ d: [...M(sol, "soleus"), ...M(gas, "gastrocnemius"), ...M(per, "fibularis")], fill: MUS.muscle, shade: "organelle", gloss: false });
  const ta = LF([[0.665, 0.0], [0.665, 0.52], [0.75, 0.58], [0.85, 0.44], [0.92, 0.24], [0.95, 0.08], [0.9, -0.04], [0.8, -0.04], [0.72, -0.1]]);
  add({ d: M(ta, "tibialis anterior"), fill: MUS.muscle, shade: "organelle", gloss: false });

  // ---- fibre direction lines (seeded, so left and right differ a little)
  const fib = [];
  for (const m of [(q) => q, mx]) {
    const j = () => (R() - 0.5) * 0.03;
    const conv = (o, ins, k = 0.7) => SO(m([o, [lerp(o[0], ins[0], k) + j(), lerp(o[1], ins[1], k) + j()]]));
    const ins = armF(0.2, -0.45);
    for (const o of [[0.12, 1.5], [0.1, 1.72], [0.13, 1.95], [0.3, 2.1]]) fib.push(conv([o[0] + j(), o[1] + j()], ins, 0.68));
    const dIns = armF(0.24, 0.45);
    for (const o of [[0.72, 1.45], [0.84, 1.48], [0.93, 1.57]]) fib.push(conv(o, dIns, 0.62));
    fib.push(SO(m(AF([[0.27, -0.05], [0.37, 0.0], [0.45, -0.02]]))));
    fib.push(SO(m(LF([[0.2, 0.18], [0.33, 0.16], [0.45, 0.1]]))), SO(m(LF([[0.25, 0.66], [0.38, 0.68], [0.48, 0.62]]))), SO(m(LF([[0.43, -0.3], [0.5, -0.35], [0.54, -0.4]]))));
    fib.push(SO(m([[0.36, 2.35], [0.45, 2.55], [0.5, 2.75]])), SO(m([[0.5, 2.5], [0.55, 2.7], [0.56, 2.95]])));
    fib.push(SO(m(LF([[0.7, 0.2], [0.8, 0.2], [0.88, 0.15]]))));
  }
  add({ d: fib, fill: "none", stroke: { color: shade(MUS.muscle, 0.12), width: 0.011 * u, cap: "round" }, lineStrokeWidth: 0.009 * u });

  return fit(parts, { lineWidth: 1.4 });
}

/* ---------------- side-view (profile) figures ---------------- */

/*
 * Profile figures are built in hu in a local frame: hip joint at (0, 0), facing +x, y down. A seated adult's
 * crown is 3.62 hu above the hip (chin 2.62, shoulder joint 2.17); the thigh runs forward to the knee
 * (≈1.8, 0.1), the shin down to the ankle (1.79, 1.7) and the sole sits at y 2.05 (a 40 cm seat).
 * Parts carry point lists — pts (separate shapes), upts (one united shape) or opts (open strokes) — and are
 * mapped through a transform before smoothing, so one figure can be mirrored (a clinician facing left) or
 * tilted (a patient on a raised backrest). Stroke widths sw/lsw are in hu.
 */
const PROF = {
  // crown (0,0), chin y≈1, facing +x: forehead, brow, nose, lips, chin, jaw, nape, occiput
  head: [[-0.02, 0], [0.14, 0.02], [0.27, 0.1], [0.35, 0.22], [0.385, 0.34], [0.372, 0.405], [0.398, 0.47], [0.445, 0.575], [0.468, 0.625], [0.44, 0.655], [0.405, 0.668],
    [0.415, 0.715], [0.398, 0.752], [0.41, 0.79], [0.378, 0.838], [0.388, 0.895], [0.352, 0.955], [0.27, 0.985], [0.14, 0.965], [0.02, 0.9], [-0.15, 0.85], [-0.27, 0.79],
    [-0.37, 0.69], [-0.43, 0.54], [-0.44, 0.36], [-0.37, 0.18], [-0.22, 0.05]],
  hair: {
    short: [[0.34, 0.2], [0.3, 0.09], [0.17, -0.03], [0.0, -0.07], [-0.2, -0.045], [-0.37, 0.08], [-0.46, 0.28], [-0.47, 0.5], [-0.43, 0.66], [-0.36, 0.74], [-0.31, 0.62],
      [-0.22, 0.46], [-0.1, 0.4], [0.0, 0.42], [0.03, 0.55], [0.08, 0.55], [0.09, 0.36], [0.2, 0.25]],
    cap: [[0.355, 0.22], [0.3, 0.1], [0.17, -0.02], [0.0, -0.06], [-0.2, -0.035], [-0.36, 0.08], [-0.45, 0.28], [-0.46, 0.48], [-0.41, 0.66], [-0.33, 0.62], [-0.24, 0.47],
      [-0.12, 0.4], [0.0, 0.41], [0.04, 0.5], [0.07, 0.48], [0.1, 0.33], [0.22, 0.25]],
    bun: ellPts(-0.5, 0.27, 0.15, 0.14, 12),
    tail: [[-0.38, 0.2], [-0.52, 0.28], [-0.6, 0.52], [-0.61, 0.8], [-0.56, 1.0], [-0.5, 0.86], [-0.47, 0.6], [-0.4, 0.42]],
  },
  neck: [[-0.27, -2.85], [0.08, -2.78], [0.12, -2.62], [0.19, -2.3], [0.0, -2.2], [-0.3, -2.25], [-0.27, -2.55]],
  torso: {
    male: [[0.0, -2.36], [0.2, -2.31], [0.33, -2.21], [0.46, -2.0], [0.52, -1.74], [0.5, -1.42], [0.44, -1.1], [0.44, -0.78], [0.43, -0.45], [0.38, -0.22], [0.0, -0.18],
      [-0.46, -0.25], [-0.43, -0.75], [-0.4, -1.2], [-0.45, -1.62], [-0.47, -1.95], [-0.42, -2.22], [-0.3, -2.37]],
    female: [[0.0, -2.33], [0.18, -2.29], [0.3, -2.18], [0.42, -2.0], [0.52, -1.84], [0.6, -1.66], [0.58, -1.48], [0.47, -1.38], [0.4, -1.12], [0.39, -0.8], [0.42, -0.45],
      [0.38, -0.22], [0.0, -0.18], [-0.5, -0.25], [-0.42, -0.75], [-0.37, -1.15], [-0.42, -1.6], [-0.44, -1.95], [-0.38, -2.18], [-0.22, -2.3]],
  },
  seat: [[-0.47, -0.5], [0.42, -0.55], [0.44, -0.15], [0.25, 0.22], [-0.25, 0.32], [-0.5, 0.2], [-0.53, -0.15]],
  // near leg, seated: thigh forward, knee, shin down (a = underside/calf, b = top/shin)
  leg: [K(0, 0, 0.3, 0.3), K(0.8, 0.02, 0.29, 0.27), K(1.45, 0.04, 0.23, 0.22), K(1.74, 0.13, 0.2, 0.21), K(1.83, 0.42, 0.19, 0.18), K(1.84, 0.9, 0.21, 0.15), K(1.8, 1.45, 0.13, 0.11), K(1.79, 1.72, 0.11, 0.1)],
};

/** Convert profile parts (hu point lists) to scene parts at u px/hu. rp: [[corner pts, radius hu], …] → exact rounded polygons. */
function profParts(list, u) {
  const X = (pts) => pts.map(([x, y]) => [x * u, y * u]);
  return list.map(({ pts, upts, opts, rp, sw, lsw, ...p }) => {
    const q = { ...p };
    if (upts) q.unite = upts.map((l) => smoothClosed(X(l)));
    else if (opts) q.d = opts.map((l) => smoothOpen(X(l)));
    else if (rp) q.d = rp.map(([l, r]) => roundPoly(X(l), r * u));
    else if (pts) q.d = pts.map((l) => smoothClosed(X(l)));
    if (sw) q.stroke = { ...(p.stroke || {}), width: sw * u, cap: "round" };
    if (lsw) q.lineStrokeWidth = lsw * u;
    return q;
  });
}

/**
 * Polygon with rounded corners as exact path data: straight L edges and a cubic arc at each corner.
 * (Smoothing a sparse rounded-rectangle point list with Catmull-Rom overshoots past the ends of long
 * bars; this never does.) pts and r in the same units.
 */
function roundPoly(pts, r) {
  const n = pts.length, k = 0.5523;
  const c = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1, lb = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    const ra = Math.min(r, la * 0.5), rb = Math.min(r, lb * 0.5);
    return [[p[0] + ((a[0] - p[0]) / la) * ra, p[1] + ((a[1] - p[1]) / la) * ra], p, [p[0] + ((b[0] - p[0]) / lb) * rb, p[1] + ((b[1] - p[1]) / lb) * rb]];
  });
  let d = `M${f(c[0][2][0])} ${f(c[0][2][1])}`;
  for (let i = 1; i <= n; i++) {
    const [p1, p, p2] = c[i % n];
    d += `L${f(p1[0])} ${f(p1[1])}C${f(p1[0] + (p[0] - p1[0]) * k)} ${f(p1[1] + (p[1] - p1[1]) * k)} ${f(p2[0] + (p[0] - p2[0]) * k)} ${f(p2[1] + (p[1] - p2[1]) * k)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}
/** Rounded rectangle → [corners, r] for a part's `rp` list. */
const rrect = (x0, y0, x1, y1, r) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]], r];
/** Rounded polygon → [corners, r]. */
const quad = (pts, r = 0.025) => [pts, r];
/** Rotate / map a [corners, r] pair. */
const rpRot = ([pts, r], cx, cy, deg) => [rotatePts(pts, cx, cy, deg), r];
const rpMap = ([pts, r], T) => [pts.map(T), r];

/** Profile head parts (head-local: crown 0,0, chin y 1, facing +x) mapped through T. */
function profileHead(T, { skin, hair, style = "short", eyes = "open", brow }) {
  const M = (pts) => pts.map(T);
  const H = PROF.hair, out = [];
  if (style === "tail") out.push({ pts: [M(H.tail)], fill: hair, shade: "organelle", gloss: false });
  out.push({ pts: [M(PROF.head)], fill: skin, shade: "body", gloss: false });
  out.push({ pts: [M(ellPts(-0.06, 0.53, 0.068, 0.112, 10, 12))], fill: shade(skin, 0.05), shade: "small" });
  out.push({ opts: [M([[-0.075, 0.47], [-0.045, 0.52], [-0.065, 0.58]])], fill: "none", stroke: { color: shade(skin, 0.2) }, sw: 0.016, lsw: 0.014 });
  if (eyes === "closed") out.push({ opts: [M([[0.27, 0.485], [0.305, 0.498], [0.338, 0.486]])], fill: "none", stroke: { color: EYE }, sw: 0.02, lsw: 0.018 });
  else out.push({ pts: [M(ellPts(0.31, 0.478, 0.022, 0.031, 8))], fill: EYE });
  out.push({ opts: [M([[0.25, 0.42], [0.31, 0.402], [0.365, 0.418]])], fill: "none", stroke: { color: brow ?? shade(hair, 0.08) }, sw: 0.03, lsw: 0.024 });
  out.push({ opts: [M([[0.352, 0.757], [0.397, 0.753]])], fill: "none", stroke: { color: LIP }, sw: 0.024, lsw: 0.02 });
  if (style === "short") out.push({ pts: [M(H.short)], fill: hair, shade: "organelle", gloss: false });
  else out.push({ upts: style === "bun" ? [M(H.cap), M(H.bun)] : [M(H.cap)], fill: hair, shade: "organelle", gloss: false });
  return out;
}

/** Hand seen from the side, flat (resting), from the wrist along angle deg; thumb lobe on the upper edge. */
function handSide(w, deg = 0, s = 1) {
  const R = (pts) => pts.map(([x, y]) => rotate([w[0] + x * s, w[1] + y * s], w[0], w[1], deg));
  return [R([[-0.03, -0.085], [0.2, -0.095], [0.42, -0.08], [0.6, -0.062], [0.7, -0.034], [0.73, 0.0], [0.68, 0.04], [0.45, 0.058], [0.2, 0.072], [-0.03, 0.078]]),
    R([[0.08, -0.07], [0.22, -0.135], [0.36, -0.14], [0.41, -0.1], [0.33, -0.065]])];
}

/** Shoe in profile from the ankle point A (sole at A.y + 0.33). */
const shoeSide = (A) => [[-0.16, -0.06], [0.08, -0.08], [0.22, 0.0], [0.46, 0.1], [0.7, 0.16], [0.82, 0.22], [0.83, 0.31], [0.72, 0.335], [-0.15, 0.335], [-0.2, 0.24], [-0.2, 0.07]].map(([x, y]) => [A[0] + x, A[1] + y]);

/**
 * Seated profile person (local frame). o: {sex, skin, hair, hairStyle, top, topStyle: "tee"|"long", bottom, shoes,
 * arm: keys of the near arm (local), hand: [wrist, deg], farHand: [wrist, deg] | null, eyes}. Returns
 * {back, body, front} part lists (local coords) so a scene can put chairs and props between them.
 */
function seatedPerson(o) {
  const sex = o.sex ?? "male";
  const back = [], body = [], front = [];
  const dark = (c, a = 0.07) => shade(c, a);
  // far leg + far shoe (slightly forward), partly hidden behind the near leg
  const off = ([x, y]) => [x + 0.13, y - 0.02];
  const leg = limb(PROF.leg, { capA: 0, capB: 0 });
  back.push({ pts: [shoeSide(off(PROF.leg.at(-1).p))], fill: dark(o.shoes, 0.05), shade: "organelle", gloss: false });
  back.push({ pts: [leg.map(off)], fill: dark(o.bottom), shade: "body", gloss: false, highlight: false });
  // neck, torso, seat + near leg, near shoe
  body.push({ pts: [PROF.neck], fill: shade(o.skin, 0.04), shade: "rim" });
  body.push({ upts: [PROF.seat, leg], fill: o.bottom, shade: "body", gloss: false });
  body.push({ pts: [shoeSide(PROF.leg.at(-1).p)], fill: o.shoes, shade: "organelle", gloss: false });
  body.push({ pts: [PROF.torso[sex]], fill: o.top, shade: "body", gloss: false, layer: "top" });
  // far hand on the lap
  if (o.farHand) {
    const [w, deg] = o.farHand;
    body.push({ upts: [limb([K(w[0] - 0.55, w[1] - 0.2, 0.1), K(...w, 0.085)], { capA: 0, capB: 0.3 }), ...handSide(w, deg)], fill: shade(o.skin, 0.06), shade: "organelle", gloss: false, highlight: false });
  }
  // head
  const hx = o.headX ?? -0.02, hy = -3.62;
  front.push(...profileHead(([x, y]) => [hx + x, hy + y], { skin: o.skin, hair: o.hair, style: o.hairStyle ?? "short", eyes: o.eyes, brow: o.brow }));
  // near arm: skin (forearm + hand), then the sleeve over it
  if (o.arm) {
    const [w, deg] = o.hand;
    const sTo = o.topStyle === "long" ? 0.93 : 0.36;
    front.push({ upts: [limb(o.arm, { capA: 0.6, capB: 0 }), ...handSide(w, deg)], fill: o.skin, shade: "organelle", gloss: false, highlight: false, layer: "arm" });
    front.push({ pts: [limb(o.arm, { capA: 0.8, capB: 0, to: sTo, grow: 0.03 })], fill: o.sleeve ?? o.top, shade: "body", gloss: false, layer: "sleeve" });
  }
  return { back, body, front };
}

/** Map every point list of profile parts through T. */
function mapParts(list, T) {
  const M = (l) => l.map(T);
  return list.map((p) => ({ ...p, ...(p.pts ? { pts: p.pts.map(M) } : {}), ...(p.upts ? { upts: p.upts.map(M) } : {}), ...(p.opts ? { opts: p.opts.map(M) } : {}), ...(p.rp ? { rp: p.rp.map((q) => rpMap(q, T)) } : {}) }));
}

/* ---------- patient-seated: phlebotomy chair, arm extended on the armrest ---------- */

/*
 * Plan — patient-seated. Canvas ≈ 3.6 × 5.9 hu at u = 46. A woman seated in profile (facing right) in a
 * blood-collection chair: high padded backrest, seat cushion, raised padded armrest sloping with the forearm (phlebotomy position: arm extended, elbow ~160°), with
 * the bare forearm extended palm-up on it (short sleeves), far hand on the lap. Paint order: chair back and
 * rear frame · far leg/shoe · neck · trousers (seat + near leg) · near shoe · top · far hand · head + hair ·
 * armrest post + pad · near arm (skin, then sleeve). Colours: skin SKIN.tan, hair HAIR.dark (bun),
 * top #f0907f, trousers #4a5a78, upholstery #6fa8a3, frame METAL-grey #9aa6b3.
 */
function patientSeated(style) {
  const u = 46;
  const up = "#6fa8a3", frame = "#9aa6b3";
  // phlebotomy position: upper arm ~40° forward of vertical, elbow nearly straight (~160°), forearm supinated
  // and sloping down along the raised armrest pad, so the antecubital fossa faces up
  const sh = [0.02, -2.15], ua = (40 * Math.PI) / 180, fa = (60 * Math.PI) / 180;
  const el = [sh[0] + Math.sin(ua) * 1.3, sh[1] + Math.cos(ua) * 1.3], wr = [el[0] + Math.sin(fa) * 1.1, el[1] + Math.cos(fa) * 1.1];
  const arm = [K(...sh, 0.17), K(lerp(sh[0], el[0], 0.5), lerp(sh[1], el[1], 0.5), 0.15), K(...el, 0.13, 0.135), K(lerp(el[0], wr[0], 0.45), lerp(el[1], wr[1], 0.45), 0.125, 0.12), K(...wr, 0.095, 0.09)];
  const P = seatedPerson({ sex: "female", skin: SKIN.tan, hair: HAIR.dark, hairStyle: "bun", top: "#f0907f", bottom: "#4a5a78", shoes: "#5b4a52",
    arm, hand: [wr, 30], farHand: [[0.62, -0.42], 4] });
  const chairBack = [
    { rp: [quad([[-0.5, 0.55], [-0.4, 0.55], [-0.38, 2.02], [-0.47, 2.02]], 0.03)], fill: shade(frame, 0.08), shade: "small" },
    { rp: [rrect(-0.6, 0.48, 0.98, 0.62, 0.04)], fill: frame, shade: "small" },
    { rp: [rpRot(rrect(-0.76, -2.34, -0.5, 0.22, 0.12), -0.6, 0.2, -4)], fill: up, shade: "body", gloss: false },
    { rp: [rrect(-0.64, 0.27, 1.04, 0.52, 0.11)], fill: up, shade: "body", gloss: false },
    { rp: [quad([[0.82, 0.58], [0.92, 0.58], [0.96, 2.02], [0.86, 2.02]], 0.03)], fill: frame, shade: "small" },
    { rp: [rrect(-0.56, 1.98, -0.3, 2.06, 0.03), rrect(0.8, 1.98, 1.04, 2.06, 0.03)], fill: "#4d5866", shade: "small" },
  ];
  // armrest pad along the forearm's underside (sloped like the forearm), on a post rising from the seat frame
  const d = [Math.sin(fa), Math.cos(fa)], nrm = [-d[1], d[0]]; // along the forearm; nrm points below it
  const o = [el[0] + nrm[0] * 0.135, el[1] + nrm[1] * 0.135];
  const PA = (s, n) => [o[0] + d[0] * s + nrm[0] * n, o[1] + d[1] * s + nrm[1] * n];
  const pad = [PA(-0.28, 0.0), PA(1.6, 0.0), PA(1.6, 0.17), PA(-0.28, 0.17)];
  const pb = PA(0.25, 0.15);
  const armrest = [
    { rp: [quad([[pb[0] - 0.06, pb[1]], [pb[0] + 0.06, pb[1] + 0.04], [pb[0] + 0.06, 0.3], [pb[0] - 0.06, 0.3]], 0.03)], fill: frame, shade: "small" },
    { rp: [quad(pad, 0.08)], fill: up, shade: "organelle", gloss: false },
  ];
  // antecubital crease on the upturned inner elbow
  const ea = (50 * Math.PI) / 180, et = [Math.sin(ea), Math.cos(ea)], eu = [et[1], -et[0]]; // elbow tangent, upward normal
  const PE = (t, n) => [el[0] + et[0] * t + eu[0] * n, el[1] + et[1] * t + eu[1] * n];
  const crease = { opts: [[PE(-0.11, 0.085), PE(0, 0.1), PE(0.11, 0.085)]], fill: "none", stroke: { color: shade(SKIN.tan, 0.14) }, sw: 0.016, lsw: 0.014 };
  const parts = [...chairBack, ...P.back, ...P.body, ...armrest, ...P.front, crease];
  return fit(profParts(parts, u), { lineWidth: 1.4 });
}

/* ---------- patient-with-clinician: consultation, two seated people facing each other ---------- */

/*
 * Plan — patient-with-clinician. Canvas ≈ 7.6 × 5.9 hu at u = 30. Patient (man, sweater, left, facing right)
 * and clinician (woman, white coat over teal scrubs, stethoscope, clipboard; right, facing left = mirrored
 * local frame) on simple chairs ~1.3 m apart. Each figure: chair back · far leg · body · props · head · near arm.
 * The clinician's open coat shows a strip of scrubs at the chest and drapes over the thighs; the clipboard rests
 * on her thigh, tilted toward the viewer, held at its top edge.
 */
function simpleChair(T, c = { seat: "#7d97b3", frame: "#6f7b88" }) {
  return mapParts([
    { rp: [quad([[-0.66, 0.4], [-0.56, 0.4], [-0.6, 2.03], [-0.7, 2.03]], 0.03)], fill: shade(c.frame, 0.06), shade: "small" },
    { rp: [rrect(-0.72, -1.55, -0.52, 0.32, 0.08)], fill: c.seat, shade: "body", gloss: false },
    { rp: [rrect(-0.64, 0.27, 0.98, 0.43, 0.07)], fill: c.seat, shade: "body", gloss: false },
    { rp: [quad([[0.84, 0.4], [0.94, 0.4], [0.96, 2.03], [0.86, 2.03]], 0.03)], fill: c.frame, shade: "small" },
  ], T);
}

function patientWithClinician(style) {
  const u = 30;
  // patient (left, facing right)
  const pArm = [K(0.02, -2.15, 0.18, 0.18), K(0.12, -1.6, 0.16, 0.16), K(0.24, -1.05, 0.14, 0.14), K(0.5, -0.75, 0.13, 0.13), K(0.85, -0.52, 0.12, 0.115), K(1.15, -0.42, 0.1, 0.095)];
  const pat = seatedPerson({ sex: "male", skin: SKIN.light, hair: HAIR.brown, hairStyle: "short", top: "#8fbde0", topStyle: "long", bottom: "#cbb593", shoes: "#4d5866",
    arm: pArm, hand: [[1.15, -0.42], 4], farHand: null });
  const sweaterRib = { opts: [[[0.0, -2.33], [0.12, -2.31], [0.2, -2.29]]], fill: "none", stroke: { color: shade("#8fbde0", 0.12) }, sw: 0.05, lsw: 0.03 };
  const patient = [...simpleChair((p) => p), ...pat.back, ...pat.body, sweaterRib, ...pat.front];

  // clinician (right, facing left): built facing +x, then mirrored about x = 3.0
  const scrub = "#5fb3ad";
  // near arm: upper arm hanging, forearm forward to the clipboard's top-left corner (drawn here, not by
  // seatedPerson, so the hand can go behind the board and the thumb in front of it)
  const cArm = [K(0.02, -2.13, 0.16, 0.16), K(0.07, -1.62, 0.145, 0.145), K(0.15, -1.17, 0.13, 0.13), K(0.38, -1.04, 0.12, 0.12), K(0.64, -1.03, 0.092, 0.088)];
  const cli = seatedPerson({ sex: "female", skin: SKIN.brown, hair: HAIR.black, hairStyle: "bun", top: scrub, sleeve: COAT, topStyle: "long", bottom: scrub, shoes: "#4d5866",
    arm: null, farHand: null });
  const handBack = { upts: [limb(cArm, { capA: 0.6, capB: 0, from: 0.7 }), [[0.6, -1.11], [0.68, -1.17], [0.79, -1.215], [0.9, -1.22], [0.965, -1.185], [0.97, -1.13], [0.9, -1.09], [0.78, -1.06], [0.68, -0.97], [0.6, -0.95]]],
    fill: SKIN.brown, shade: "organelle", gloss: false, highlight: false };
  const cSleeve = { pts: [limb(cArm, { capA: 0.8, capB: 0, to: 0.9, grow: 0.03 })], fill: COAT, shade: "body", gloss: false };
  const thumb = { pts: [[[0.77, -1.1], [0.83, -1.085], [0.885, -1.035], [0.88, -0.995], [0.83, -0.995], [0.78, -1.04]]], fill: SKIN.brown, shade: "small" };
  const knuckles = { opts: [[[0.8, -1.205], [0.84, -1.175]], [[0.88, -1.21], [0.915, -1.18]]], fill: "none", stroke: { color: shade(SKIN.brown, 0.16) }, sw: 0.014, lsw: 0.012 };
  // white coat: torso panel behind the open front (scrubs show as a strip at the chest) + skirt over the thighs
  const coat = { upts: [
    [[0.06, -2.34], [0.18, -2.3], [0.3, -2.12], [0.38, -1.9], [0.43, -1.6], [0.42, -1.3], [0.38, -1.05], [0.37, -0.75], [0.42, -0.5], [0.62, -0.38], [1.12, -0.36], [1.2, -0.12], [1.13, 0.3],
      [0.3, 0.36], [-0.45, 0.42], [-0.64, 0.44], [-0.6, 0.1], [-0.52, -0.3], [-0.43, -0.75], [-0.38, -1.15], [-0.43, -1.6], [-0.46, -1.95], [-0.4, -2.2], [-0.24, -2.32]],
  ], fill: COAT, shade: "body", gloss: false };
  const coatSeams = { opts: [[[0.36, -1.05], [0.38, -0.7], [0.5, -0.45]], [[-0.1, -0.55], [0.35, -0.53]]], fill: "none", stroke: { color: shade(COAT, 0.2) }, sw: 0.03, lsw: 0.026 };
  const lapel = { pts: [[[0.12, -2.36], [0.24, -2.3], [0.33, -2.0], [0.3, -1.7], [0.22, -1.95]]], fill: COAT, shade: "organelle", gloss: false };
  const steth = [
    { opts: [[[-0.12, -2.33], [0.08, -2.3], [0.28, -2.12], [0.38, -1.85], [0.45, -1.62]]], fill: "none", stroke: { color: STETH }, sw: 0.06, lsw: 0.045 },
    { pts: [ellPts(0.46, -1.55, 0.085, 0.085, 12)], fill: METAL, shade: "organelle", gloss: false },
  ];
  // clipboard resting on the thigh, tilted toward the viewer; paper with lines; clip at the top
  const board = quad([[0.58, -0.36], [1.22, -0.38], [1.36, -1.12], [0.74, -1.12]], 0.05);
  const clip = [
    { rp: [board], fill: "#b88a5a", shade: "organelle", gloss: false },
    { rp: [quad([[0.66, -0.43], [1.15, -0.44], [1.26, -1.03], [0.82, -1.03]], 0.015)], fill: "#f4f6f8", shade: "rim" },
    { opts: [[[0.92, -0.86], [1.18, -0.86]], [[0.8, -0.74], [1.16, -0.74]], [[0.78, -0.62], [1.1, -0.62]]], fill: "none", stroke: { color: "#b9c3cc" }, sw: 0.02, lsw: 0.016 },
    { rp: [rrect(0.98, -1.17, 1.22, -1.05, 0.03)], fill: METAL, shade: "small" },
  ];
  const cliLocal = [...simpleChair((p) => p), ...cli.back, ...cli.body, coat, coatSeams, lapel, ...steth, handBack, cSleeve, knuckles, ...clip, thumb, ...cli.front];
  const clinician = mapParts(cliLocal, ([x, y]) => [5.6 - x, y]);
  return fit(profParts([...patient, ...clinician], u), { lineWidth: 1.4 });
}

/* ---------- patient-in-hospital-bed: lying on a raised backrest, IV drip ---------- */

/*
 * Plan — patient-in-hospital-bed. World hu with the patient's hip at (0, 0), floor at y 2.95, u = 22
 * (canvas ≈ 9.9 × 7.7 hu). Hospital bed in side view: castors, base frame, two lift columns, deck, mattress
 * with the backrest raised 30° (semi-Fowler), head- and footboard, split side rail on the foot section.
 * Patient (man) supine: the upper body is the seated profile torso rotated −60° about the hip (the back lies on
 * the backrest), head raised on a pillow; blanket from mid-chest to the feet following the body contour (feet
 * tent it) and hanging over the mattress side, a turned-down sheet lip along its top edge (chest to mattress surface, tucked under the arm); near arm (gown sleeve) lying
 * on the blanket with a peripheral IV cannula taped on the forearm. IV pole at the head end: five-leg castor
 * base, hooks, a fluid bag, drip chamber, roller clamp and the line running to the cannula.
 * Paint order: IV stand · bed frame · mattress · pillow · gown/neck · blanket + sheet band · head · rail ·
 * near arm + cannula · IV line · bag. Colours: gown #a9c9e6, blanket #9fd0c7, sheet/pillow #eef2f6,
 * mattress #c5d3e0, frame #7f8b98, panels #dfe5eb, castors #4d5866, bag #e9f2f7, fluid #bfe0f2.
 */
function patientInBed(style) {
  const u = 22;
  const C = { gown: "#a9c9e6", blanket: "#9fd0c7", sheet: "#eef2f6", mattress: "#c5d3e0", frame: "#7f8b98", panel: "#dfe5eb", castor: "#4d5866",
    pole: "#b9c3cc", base: "#5c6773", bag: "#e9f2f7", fluid: "#bfe0f2", tube: "#9fbdd0", clamp: "#4f86d0", tape: "#f3f5f7" };
  const skin = SKIN.deep, hair = HAIR.black;
  const parts = [];
  const add = (p) => parts.push(p);
  const rot = (p) => rotate(p, 0, 0, -60); // seated-local → lying on the 30° backrest
  // head raised on the pillow: full lift at the head, fading to none at the shoulders (the neck flexes)
  const lift = (p) => { const q = rot(p), k = Math.max(0, Math.min(1, (-2.3 - p[1]) / 0.5)); return [q[0] + 0.16 * k, q[1] - 0.28 * k]; };
  const castor = (x) => [{ rp: [quad([[x - 0.1, 2.55], [x + 0.1, 2.55], [x + 0.06, 2.72], [x - 0.06, 2.72]], 0.02)], fill: C.frame, shade: "small" }, { pts: [ellPts(x, 2.77, 0.17, 0.17, 14)], fill: C.castor, shade: "organelle", gloss: false }, { pts: [ellPts(x, 2.77, 0.06, 0.06, 8)], fill: C.pole, shade: "small" }];

  // ---- IV stand (head end): five-leg castor base, pole, hook bar
  const px = -4.95;
  add({ rp: [quad([[px - 0.05, 2.6], [px + 0.05, 2.6], [px + 0.6, 2.8], [px + 0.58, 2.86], [px, 2.74], [px - 0.58, 2.86], [px - 0.6, 2.8]], 0.03)], fill: C.base, shade: "organelle", gloss: false });
  add({ pts: [ellPts(px - 0.6, 2.9, 0.07, 0.07, 8), ellPts(px + 0.6, 2.9, 0.07, 0.07, 8), ellPts(px - 0.03, 2.88, 0.065, 0.065, 8)], fill: C.castor, shade: "small" });
  add({ rp: [rrect(px - 0.04, -4.5, px + 0.04, 2.7, 0.03)], fill: C.pole, shade: "small" });
  add({ opts: [[[px - 0.38, -4.32], [px - 0.4, -4.46], [px - 0.3, -4.52], [px, -4.52], [px + 0.3, -4.52], [px + 0.4, -4.46], [px + 0.38, -4.32]]], fill: "none", stroke: { color: shade(C.pole, 0.1) }, sw: 0.055, lsw: 0.045 });

  // ---- bed: base frame, lift columns, castors, deck, head- and footboard
  add({ rp: [rrect(-3.75, 2.42, 4.25, 2.58, 0.05)], fill: C.frame, shade: "small" });
  add({ rp: [rrect(-3.0, 1.05, -2.7, 2.45, 0.04), rrect(3.15, 1.05, 3.45, 2.45, 0.04)], fill: shade(C.frame, 0.05), shade: "small" });
  for (const x of [-3.5, 4.05]) castor(x).forEach(add);
  add({ rp: [rrect(-3.95, 0.92, 4.45, 1.1, 0.05)], fill: C.frame, shade: "small" });
  add({ rp: [rrect(-4.35, -0.85, -4.02, 1.12, 0.12), rrect(4.42, -0.22, 4.75, 1.12, 0.12)], fill: C.panel, shade: "body", gloss: false });

  // ---- mattress: flat foot section + backrest section raised 30°
  const dir = [-Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)]; // up the backrest; (−0.5, 0.866) points below its surface
  const bend = [-0.3, 0.33], L = 3.78, th = 0.6;
  const along = (t, n) => [bend[0] + dir[0] * t + -0.5 * n, bend[1] + dir[1] * t + 0.866 * n];
  const mattress = [[4.35, 0.36], [4.3, 0.33], [1.5, 0.33], [0.2, 0.33], [-0.05, 0.36], along(0.25, 0), along(1.6, 0), along(L - 0.06, 0), along(L, 0.04), along(L, th - 0.04), along(L - 0.06, th), along(1.6, th), along(0.3, th), [0.05, 0.93], [1.5, 0.93], [4.3, 0.93], [4.36, 0.88]];
  add({ pts: [mattress], fill: C.mattress, shade: "body", gloss: false });
  // pillow on the backrest under the head
  const pil = [along(1.95, -0.02), along(2.25, -0.2), along(2.85, -0.34), along(3.4, -0.42), along(3.66, -0.38), along(3.76, -0.2), along(3.74, 0.01), along(3.0, 0.03), along(2.3, 0.02)];
  add({ pts: [pil], fill: C.sheet, shade: "body", gloss: false });

  // ---- patient: gown torso + neck (rotated seated profile), blanket, head
  add({ pts: [PROF.neck.map(lift)], fill: shade(skin, 0.04), shade: "rim" });
  add({ pts: [PROF.torso.male.map(rot)], fill: C.gown, shade: "body", gloss: false });
  const top = [rot([0.56, -1.48]), rot([-0.5, -1.48])];
  const blanket = [top[0], rot([0.52, -1.2]), rot([0.45, -0.8]), rot([0.46, -0.35]), [0.28, -0.36], [0.8, -0.38], [1.5, -0.37], [1.85, -0.42], [2.4, -0.33], [3.2, -0.28], [3.6, -0.36], [3.8, -0.78],
    [3.95, -0.84], [4.1, -0.62], [4.28, -0.12], [4.42, 0.3], [4.46, 0.74], [3.6, 0.77], [2.5, 0.72], [1.3, 0.77], [0.2, 0.73], along(-0.05, 0.42), along(0.7, 0.4), along(1.25, 0.44),
    [top[1][0] - 0.2, top[1][1] + 0.38], top[1]];
  add({ pts: [blanket], fill: C.blanket, shade: "body", gloss: false });
  add({ opts: [[[0.9, -0.3], [1.3, 0.2], [1.5, 0.66]], [[2.7, -0.22], [2.95, 0.25], [3.05, 0.68]], [[3.75, -0.6], [3.95, 0.0], [4.15, 0.5]]], fill: "none", stroke: { color: shade(C.blanket, 0.08) }, sw: 0.03, lsw: 0.022 });
  // turned-down sheet: a soft lip along the blanket's top edge, from the chest outline to the mattress surface
  // (no overhang above the chest or past the mattress); its lower end tucks under the near arm
  const t0 = top[0], t1 = top[1], sDir = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const cd = (() => { const q = rot([0.52, -1.2]), l = Math.hypot(q[0] - t0[0], q[1] - t0[1]); return [(q[0] - t0[0]) / l, (q[1] - t0[1]) / l]; })(); // down the chest
  const md = [-dir[0], -dir[1]]; // down the backrest surface toward the feet
  const T = (t, n) => [lerp(t0[0], t1[0], t) + sDir[0] * n, lerp(t0[1], t1[1], t) + sDir[1] * n];
  const lip = [[t0[0] + cd[0] * 0.02, t0[1] + cd[1] * 0.02], T(0.3, 0.012), T(0.65, 0.012), [t1[0] + md[0] * 0.03, t1[1] + md[1] * 0.03],
    [t1[0] + md[0] * 0.14, t1[1] + md[1] * 0.14], T(0.68, 0.14), T(0.32, 0.145), [t0[0] + cd[0] * 0.14, t0[1] + cd[1] * 0.14]];
  add({ pts: [lip], fill: C.sheet, shade: "rim" });
  profileHead(([x, y]) => lift([-0.02 + x, -3.62 + y]), { skin, hair, style: "short", eyes: "closed" }).forEach(add);

  // ---- side rail on the foot section
  add({ opts: [[[1.3, -0.05], [3.4, -0.05]], [[1.3, 0.22], [3.4, 0.22]]], fill: "none", stroke: { color: C.pole }, sw: 0.09, lsw: 0.07 });
  add({ rp: [rrect(1.32, -0.12, 1.44, 0.95, 0.05), rrect(3.26, -0.12, 3.38, 0.95, 0.05)], fill: shade(C.pole, 0.06), shade: "small" });

  // ---- near arm on the blanket: gown sleeve, forearm + hand, taped IV cannula
  const sh = rot([0.02, -2.15]);
  const armK = [K(...sh, 0.155), K(-1.35, -0.72, 0.145), K(-0.85, -0.36, 0.13), K(-0.35, -0.22, 0.12), K(0.15, -0.12, 0.095)];
  add({ upts: [limb(armK, { capA: 0.5, capB: 0 }), ...handSide([0.15, -0.12], 7)], fill: skin, shade: "organelle", gloss: false, highlight: false });
  add({ pts: [limb(armK, { capA: 0.55, capB: 0, to: 0.34, grow: 0.025 })], fill: C.gown, shade: "body", gloss: false });
  const can = [-0.2, -0.32];
  add({ rp: [rpRot(rrect(can[0] - 0.2, can[1] - 0.06, can[0] + 0.18, can[1] + 0.07, 0.03), can[0], can[1], 12)], fill: C.tape, shade: "rim" });
  add({ rp: [rpRot(rrect(can[0] - 0.3, can[1] - 0.075, can[0] - 0.12, can[1] + 0.03, 0.03), can[0], can[1], 12)], fill: "#f2c14e", shade: "small" });

  // ---- IV line from the drip chamber to the cannula, roller clamp; bag with fluid on the hook
  const bx = px + 0.36;
  add({ opts: [[[bx, -3.3], [bx + 0.02, -2.6], [bx + 0.25, -1.6], [-3.6, -0.75], [-3.0, -0.3], [-2.0, -0.12], [-1.0, -0.25], can.map((v, i) => v + (i ? -0.02 : -0.28))]], fill: "none", stroke: { color: C.tube }, sw: 0.04, lsw: 0.035 });
  add({ rp: [rrect(bx - 0.05, -2.45, bx + 0.09, -2.22, 0.03)], fill: C.clamp, shade: "small" });
  add({ rp: [rrect(bx - 0.22, -4.32, bx + 0.22, -3.6, 0.1)], fill: C.bag, shade: "body", gloss: false });
  add({ rp: [rrect(bx - 0.19, -4.08, bx + 0.19, -3.63, 0.08)], fill: C.fluid, shade: "rim" });
  add({ rp: [rrect(bx - 0.045, -3.62, bx + 0.045, -3.52, 0.015), rrect(bx - 0.055, -3.52, bx + 0.055, -3.28, 0.04)], fill: C.bag, shade: "small" });
  add({ rp: [rrect(bx - 0.045, -3.4, bx + 0.045, -3.3, 0.03)], fill: C.fluid });
  return fit(profParts(parts, u), { lineWidth: 1.3 });
}

/* ---------- patient-blood-sample: venipuncture with tourniquet and evacuated tube ---------- */

/*
 * Plan — patient-blood-sample. Top view of a bare right arm extended palm-up, laid diagonally (−25°) so the
 * thumbnail stays square-ish: short T-shirt sleeve at the shoulder end, upper arm, antecubital fossa, forearm,
 * palm-up hand. u = 70 px/hu, real proportions (upper arm 1.3 hu, forearm 1.05, hand 0.8).
 * Venipuncture as practised: tourniquet (flat elastic band, quick-release loop) ~9 cm above the fossa; engorged
 * cephalic (thumb side), basilic (little-finger side) and median cubital veins; the needle enters the median
 * cubital vein from the distal side pointing toward the shoulder at a shallow angle; a translucent tube holder
 * with flange; a 16 × 100 mm evacuated tube (lavender EDTA stopper inside the holder) filling with dark venous
 * blood (21 G multi-sample needle, green hub). Paint order: arm skin (united with the hand) · veins · palm creases · sleeve · tourniquet · tube ·
 * blood · stopper · holder · needle. Colours: skin SKIN.medium, veins #7f8fd0, tourniquet #4a7cc9, holder
 * #dfe9f1 (translucent), tube #eef4f8, blood #9e1b32, stopper #a57fd0, needle METAL.
 */
function patientBloodSample(style) {
  const u = 70;
  const skin = SKIN.medium;
  const C = { vein: "#7f8fd0", band: "#4a7cc9", holder: "#dfe9f1", tube: "#eef4f8", blood: "#9e1b32", cap: "#a57fd0", sleeve: "#8fbde0" };
  const ang = 25, O = [1.32, 0.04];
  const W = (pts) => rotatePts(pts, O[0], O[1], ang);
  const WR = ([pts, r]) => [W(pts), r];
  const parts = [];
  const add = (p) => parts.push(p);
  // arm along +x (a = lower edge, b = upper/thumb edge), wrist at 2.35
  const armK = [K(-0.05, 0.0, 0.215, 0.215), K(0.55, 0.0, 0.205, 0.215), K(1.15, 0.02, 0.19, 0.19), K(1.36, 0.035, 0.2, 0.205), K(1.62, 0.055, 0.2, 0.19), K(2.0, 0.08, 0.16, 0.15), K(2.35, 0.1, 0.125, 0.125)];
  const wr = [2.33, 0.1];
  const H = (pts) => pts.map(([x, y]) => [wr[0] + x, wr[1] + y]);
  // palm-up hand (hand-local: x from the wrist toward the fingertips, −y = thumb/radial side): a palm that starts
  // inside the forearm, four slightly curled fingers lying together (one shape, tips scalloped, middle finger
  // longest ≈ 0.83 × palm length), the thumb as one rounded lobe on the radial edge
  const palm = H([[-0.03, -0.12], [0.12, -0.145], [0.3, -0.155], [0.42, -0.15], [0.45, 0.0], [0.42, 0.14], [0.3, 0.16], [0.12, 0.15], [-0.03, 0.12]]);
  const F = [[-0.112, 0.037, 0.715], [-0.037, 0.038, 0.765], [0.038, 0.036, 0.735], [0.106, 0.031, 0.65]]; // [y, half-width, tip x]
  const fing = [[0.4, -0.149]];
  F.forEach(([y, r, tx], i) => {
    for (let k = 0; k <= 4; k++) { const a = (-90 + k * 45) * (Math.PI / 180); fing.push([tx - r + Math.cos(a) * r, y + Math.sin(a) * r * (k % 4 ? 1 : 0.8)]); }
    if (i < 3) fing.push([Math.min(tx, F[i + 1][2]) - r - 0.045, (y + r + F[i + 1][0] - F[i + 1][1]) / 2]); // notch between fingers
  });
  fing.push([0.38, 0.137]);
  const fingers = H(fing);
  const thumb = H([[0.05, -0.11], [0.14, -0.17], [0.26, -0.222], [0.38, -0.252], [0.455, -0.248], [0.472, -0.215], [0.43, -0.186], [0.33, -0.162], [0.22, -0.132]]);
  const armD = limb(armK, { capA: 0.6, capB: 0 });
  // soft: the hand (its own rim, scaled to the fingers) lies under the arm; the arm is flat with hand-made rim and
  // light bands along its edges, so nothing marks the wrist
  const armW = armK.map((k) => ({ ...k, p: rotate(k.p, O[0], O[1], ang) }));
  add({ upts: [palm, fingers, thumb].map(W), fill: skin, shade: "organelle", gloss: false, highlight: false, line: false });
  add({ upts: [W(armD)], fill: skin, line: false });
  add({ pts: tubeBands(armW, { frac: 0.17, from: 0.1, to: 1 }), fill: shade(skin, 0.09), line: false });
  add({ pts: tubeBands(armW, { kind: "hi", frac: 0.16, from: 0.12, to: 0.97 }), fill: tint(skin, 0.1), opacity: 0.7, line: false });
  // line: one united arm + hand silhouette
  add({ upts: [armD, palm, fingers, thumb].map(W), fill: skin, soft: false });
  // finger separations (from the tip notches back along the fingers) and the two palm creases
  const sep = F.slice(0, 3).map(([y, r, tx], i) => { const ny = (y + r + F[i + 1][0] - F[i + 1][1]) / 2, nx = Math.min(tx, F[i + 1][2]) - r - 0.045; return H([[nx, ny], [nx - 0.13, ny * 0.96]]); });
  add({ opts: sep.map(W), fill: "none", stroke: { color: shade(skin, 0.15) }, sw: 0.014, lsw: 0.012 });

  // superficial veins, engorged distal to the tourniquet: cephalic (thumb side), basilic, median cubital; the
  // cephalic and basilic taper to nothing at the wrist (no blind caps), proximal ends pass under the tourniquet
  const ceph = [[0.95, -0.13], [1.25, -0.12], [1.5, -0.1], [1.85, -0.07], [2.2, -0.04], [2.3, -0.03]], bas = [[0.95, 0.1], [1.2, 0.12], [1.5, 0.13], [1.9, 0.1], [2.2, 0.08], [2.3, 0.075]];
  const med = [[1.52, -0.1], [1.4, -0.05], [1.3, 0.04], [1.18, 0.11]];
  const tap = (t) => (t > 0.86 ? Math.max(0.02, (1 - t) / 0.14) : 1);
  add({ upts: [W(tubePts(ceph, 0.04, { capB: false, taper: tap })), W(tubePts(bas, 0.04, { capB: false, taper: tap })), W(tubePts(med, 0.036))], fill: C.vein, opacity: 0.7, thin: true });
  // skin creases: elbow (antecubital) and palm
  add({ opts: [W(H([[0.4, -0.1], [0.25, -0.06], [0.12, -0.07]])), W(H([[0.42, 0.02], [0.3, 0.03], [0.2, 0.09]]))],
    fill: "none", stroke: { color: shade(skin, 0.14) }, sw: 0.016, lsw: 0.014 });
  // T-shirt sleeve over the shoulder end
  const sleeve = [[-0.3, -0.2], [-0.12, -0.27], [0.12, -0.285], [0.24, -0.27], [0.27, -0.1], [0.28, 0.1], [0.25, 0.28], [0.1, 0.29], [-0.12, 0.27], [-0.3, 0.19], [-0.36, 0.0]];
  add({ pts: [W(sleeve)], fill: C.sleeve, shade: "body", gloss: false });
  add({ pts: [W([[0.13, -0.283], [0.24, -0.27], [0.27, -0.1], [0.28, 0.1], [0.25, 0.28], [0.14, 0.29], [0.155, 0.1], [0.152, -0.1]])], fill: shade(C.sleeve, 0.06), shade: "rim", thin: true });
  // tourniquet: band round the upper arm with a quick-release loop and two tails on the thumb side
  const tx = 0.92;
  add({ rp: [WR(quad([[tx - 0.06, -0.235], [tx + 0.06, -0.235], [tx + 0.07, 0.225], [tx - 0.05, 0.225]], 0.03))], fill: C.band, shade: "organelle", gloss: false });
  // tuck on the thumb side: a folded loop and the free end, both lying back along the arm toward the shoulder
  const loop = [[tx + 0.02, -0.175], [tx - 0.15, -0.2], [tx - 0.33, -0.18], [tx - 0.39, -0.12], [tx - 0.31, -0.075], [tx - 0.12, -0.09], [tx + 0.02, -0.1]];
  const hole = [[tx - 0.14, -0.16], [tx - 0.29, -0.15], [tx - 0.32, -0.125], [tx - 0.27, -0.105], [tx - 0.14, -0.12]];
  const tail = [[tx + 0.03, -0.12], [tx - 0.08, -0.06], [tx - 0.24, -0.005], [tx - 0.28, 0.04], [tx - 0.21, 0.06], [tx - 0.06, 0.005], [tx + 0.04, -0.05]];
  add({ pts: [W(tail)], fill: shade(C.band, 0.08), shade: "rim" });
  add({ d: smoothClosed(W(loop).map(([x, y]) => [x * u, y * u])) + smoothClosed(W(hole).reverse().map(([x, y]) => [x * u, y * u])), fill: shade(C.band, 0.03), shade: "rim" });

  // needle → holder → tube along an axis leaving the vein toward the hand, 16° off the forearm
  const E = [1.36, -0.01], hd = -16, A = (t, n = 0) => { const a = (hd * Math.PI) / 180; return [E[0] + Math.cos(a) * t - Math.sin(a) * n, E[1] + Math.sin(a) * t + Math.cos(a) * n]; };
  const box = (t0, t1, w) => quad([A(t0, -w), A(t1, -w), A(t1, w), A(t0, w)], 0.02);
  add({ rp: [WR(box(0.46, 0.95, 0.036))], fill: C.tube, shade: "rim" });
  add({ rp: [WR(box(0.6, 0.94, 0.03))], fill: C.blood, shade: "organelle", gloss: false });
  add({ rp: [WR(box(0.42, 0.53, 0.04))], fill: C.cap, shade: "small" });
  add({ rp: [WR(quad([A(0.17, -0.032), A(0.21, -0.05), A(0.56, -0.05), A(0.56, -0.08), A(0.6, -0.08), A(0.6, 0.08), A(0.56, 0.08), A(0.56, 0.05), A(0.21, 0.05), A(0.17, 0.032)], 0.012))],
    fill: C.holder, opacity: 0.78, shade: "rim" });
  add({ rp: [WR(box(0.14, 0.18, 0.016))], fill: "#5fae6e", shade: "small" });
  add({ opts: [W([A(0.005), A(0.15)])], fill: "none", stroke: { color: METAL }, sw: 0.014, lsw: 0.012 });
  return fit(profParts(parts, u), { lineWidth: 1.3 });
}

/* ---------------- icon list ---------------- */

const PEOPLE_TAGS = ["person", "human", "people", "figure", "standing", "front view", "participant", "subject", "donor", "cohort"];

export const icons = [
  {
    slug: "person-male", name: "Person — adult man, standing", category: "people",
    tags: [...PEOPLE_TAGS, "man", "male", "adult", "patient", "healthy volunteer", "control subject"],
    scene: personMale,
  },
  {
    slug: "person-female", name: "Person — adult woman, standing", category: "people",
    tags: [...PEOPLE_TAGS, "woman", "female", "adult", "patient", "healthy volunteer", "control subject"],
    scene: personFemale,
  },
  {
    slug: "person-gender-neutral", name: "Person — adult, gender-neutral, standing", category: "people",
    tags: [...PEOPLE_TAGS, "gender neutral", "androgynous", "non-binary", "unisex", "adult", "patient", "participant"],
    scene: personNeutral,
  },
  {
    slug: "person-child", name: "Person — child, standing", category: "people",
    tags: [...PEOPLE_TAGS, "child", "kid", "paediatric", "pediatric", "juvenile", "JIA", "young patient", "boy", "girl"],
    scene: personChild,
  },
  {
    slug: "person-older-adult", name: "Person — older adult, standing", category: "people",
    tags: [...PEOPLE_TAGS, "older adult", "elderly", "senior", "aged", "geriatric", "ageing", "aging", "old man", "frailty"],
    scene: personOlder,
  },
  {
    slug: "clinician-doctor", name: "Clinician — doctor in white coat with stethoscope", category: "people",
    tags: ["clinician", "doctor", "physician", "medic", "rheumatologist", "GP", "white coat", "stethoscope", "scrubs", "healthcare worker", "hospital", "clinic", "health professional"],
    scene: clinicianDoctor,
  },
  {
    slug: "scientist-researcher", name: "Scientist — researcher in lab coat with pipette", category: "people",
    tags: ["scientist", "researcher", "lab worker", "technician", "postdoc", "PhD student", "lab coat", "safety glasses", "goggles", "nitrile gloves", "PPE", "pipette", "pipetting", "wet lab", "laboratory"],
    scene: scientistResearcher,
  },
  {
    slug: "human-body-outline", name: "Human body outline — front view (neutral silhouette)", category: "anatomy",
    tags: ["body outline", "silhouette", "human body", "anatomical position", "body map", "body diagram", "front view", "anterior view", "injection site", "biopsy site", "sampling site", "lesion map", "unisex", "mannequin"],
    scene: bodyOutline,
  },
  {
    slug: "rheumatoid-arthritis-affected-joints", name: "Rheumatoid arthritis — symmetric small-joint involvement", category: "anatomy",
    tags: ["rheumatoid arthritis", "RA", "polyarthritis", "symmetric arthritis", "joint involvement", "synovitis", "inflamed joints", "MCP", "PIP", "metacarpophalangeal", "proximal interphalangeal", "wrist", "MTP", "metatarsophalangeal", "knee", "DIP spared", "DAS28", "ACR/EULAR", "joint count", "homunculus", "tender joints", "swollen joints"],
    description: "Inflamed joints in a symmetric RA pattern: MCP, PIP and thumb joints, wrists, knees and MTP 2–5 (DIP joints spared); shoulders and elbows, which complete the DAS28 joint set, are marked faintly.",
    scene: raJoints,
  },
  {
    slug: "human-body-internal-organs-male", name: "Human body — internal organs, male (front view)", category: "anatomy",
    tags: ["internal organs", "organ map", "body map", "viscera", "anatomy", "male", "man", "brain", "thyroid", "larynx", "trachea", "lungs", "heart", "aorta", "liver", "gallbladder", "stomach", "spleen", "pancreas", "kidneys", "adrenal glands", "ureters", "small intestine", "colon", "large intestine", "bladder", "prostate", "seminal vesicles", "vas deferens", "testes", "multi-organ", "systemic disease", "extra-articular manifestations", "organ involvement", "tissue atlas"],
    description: "Front-view body outline with the major organs in anatomical position and relative size; male reproductive organs.",
    scene: (style) => internalOrgans("male", style),
  },
  {
    slug: "human-body-internal-organs-female", name: "Human body — internal organs, female (front view)", category: "anatomy",
    tags: ["internal organs", "organ map", "body map", "viscera", "anatomy", "female", "woman", "brain", "thyroid", "larynx", "trachea", "lungs", "heart", "aorta", "liver", "gallbladder", "stomach", "spleen", "pancreas", "kidneys", "adrenal glands", "ureters", "small intestine", "colon", "large intestine", "bladder", "uterus", "ovaries", "fallopian tubes", "vagina", "multi-organ", "systemic disease", "extra-articular manifestations", "organ involvement", "tissue atlas"],
    description: "Front-view body outline with the major organs in anatomical position and relative size; female reproductive organs.",
    scene: (style) => internalOrgans("female", style),
  },
  {
    slug: "human-skeleton-front", name: "Human skeleton — front view (anatomical position)", category: "anatomy",
    tags: ["skeleton", "skeletal system", "bones", "human skeleton", "anatomy", "front view", "anterior view", "anatomical position", "skull", "cranium", "mandible", "spine", "vertebral column", "cervical", "thoracic", "lumbar", "sacrum", "ribs", "rib cage", "costal cartilage", "sternum", "clavicle", "scapula", "humerus", "radius", "ulna", "carpals", "metacarpals", "phalanges", "pelvis", "hip bone", "ilium", "pubis", "femur", "patella", "tibia", "fibula", "tarsals", "metatarsals", "joints", "osteoporosis", "bone metastasis", "rheumatology", "musculoskeletal", "MSK"],
    description: "Adult skeleton in anatomical position (palms forward), drawn on the same grid as the body outline: skull, spine, 12 rib pairs with costal cartilages, pelvis, limbs, hands and feet.",
    scene: skeletonFront,
  },
  {
    slug: "human-muscular-system-front", name: "Human muscular system — front view (superficial muscles)", category: "anatomy",
    tags: ["muscular system", "muscles", "skeletal muscle", "superficial muscles", "musculature", "anatomy", "front view", "anterior view", "myology", "deltoid", "pectoralis major", "biceps", "brachioradialis", "forearm flexors", "rectus abdominis", "external oblique", "serratus anterior", "sternocleidomastoid", "trapezius", "quadriceps", "rectus femoris", "vastus lateralis", "vastus medialis", "sartorius", "adductors", "tensor fasciae latae", "iliotibial band", "tibialis anterior", "gastrocnemius", "tendons", "myositis", "sarcopenia", "polymyalgia rheumatica", "musculoskeletal", "MSK"],
    description: "Front-view body with the major superficial muscles (simplified), tendons and aponeuroses in cream; head, hands and feet left as a neutral silhouette.",
    scene: muscularFront,
  },
  {
    slug: "patient-in-hospital-bed", name: "Patient in hospital bed with IV drip", category: "people",
    tags: ["patient", "hospital bed", "inpatient", "hospitalised", "hospitalized", "ward", "bedridden", "lying", "supine", "semi-Fowler", "IV drip", "intravenous infusion", "IV pole", "drip stand", "saline", "infusion bag", "cannula", "peripheral IV", "treatment", "admission", "ICU", "clinical trial", "infusion therapy", "biologic infusion", "rituximab", "infliximab", "tocilizumab"],
    description: "A patient lying in a hospital bed with the backrest raised, a blanket and pillow, an IV line from a drip stand to a taped forearm cannula.",
    scene: patientInBed,
  },
  {
    slug: "patient-seated", name: "Patient seated — blood-collection chair, arm on armrest", category: "people",
    tags: ["patient", "seated", "sitting", "chair", "side view", "profile", "phlebotomy chair", "blood collection chair", "blood draw", "venipuncture", "blood sample", "outpatient", "clinic", "participant", "donor", "biobank", "sample collection", "armrest", "woman", "female"],
    description: "A woman seated in profile in a blood-collection chair with her bare forearm extended palm-up on the armrest.",
    scene: patientSeated,
  },
  {
    slug: "patient-with-clinician", name: "Patient with clinician — consultation", category: "people",
    tags: ["patient", "clinician", "doctor", "physician", "rheumatologist", "consultation", "clinic visit", "appointment", "outpatient", "medical history", "informed consent", "patient-reported outcomes", "PROs", "questionnaire", "clinical assessment", "shared decision making", "white coat", "stethoscope", "clipboard", "seated", "profile", "healthcare"],
    description: "A seated patient facing a clinician in a white coat with a stethoscope and clipboard, in profile.",
    scene: patientWithClinician,
  },
  {
    slug: "patient-blood-sample", name: "Blood sample — arm with tourniquet, needle and blood tube", category: "people",
    tags: ["blood sample", "blood draw", "blood collection", "venipuncture", "phlebotomy", "venepuncture", "tourniquet", "vacutainer", "evacuated tube", "blood collection tube", "EDTA tube", "lavender top", "tube holder", "needle", "antecubital fossa", "median cubital vein", "arm", "peripheral blood", "PBMC", "serum", "plasma", "biomarker", "liquid biopsy", "biobank", "sample collection", "ACPA", "rheumatoid factor", "CRP", "ESR"],
    description: "Venipuncture: a palm-up arm with a tourniquet above the elbow, the needle in the median cubital vein and a lavender-top (EDTA) evacuated tube filling with blood in its holder.",
    scene: patientBloodSample,
  },
];
