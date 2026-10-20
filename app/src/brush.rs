//! Brushes: patterns drawn along a smooth path (lipid bilayer, DNA, RNA, epithelial cells,
//! actin, microtubules, collagen, or a library icon repeated). A line-by-line port of
//! ui/js/brush.js — same constants, same random numbers, same markup — so figures composed
//! here look exactly like the ones drawn in the app.

use serde_json::Value;
use std::f64::consts::PI;

pub type P = [f64; 2];

/// `Math.round(v * 100) / 100` printed the way JavaScript prints numbers.
fn n(v: f64) -> String {
    crate::figure::js_num(v, 100.0)
}

/* ---------- reading the object (JavaScript truthiness) ---------- */

fn num(o: &Value, k: &str) -> Option<f64> {
    o.get(k).and_then(|v| v.as_f64())
}
/// `o.k || d`
fn num_or(o: &Value, k: &str, d: f64) -> f64 {
    num(o, k).filter(|v| *v != 0.0 && !v.is_nan()).unwrap_or(d)
}
fn truthy(o: &Value, k: &str) -> bool {
    match o.get(k) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(x)) => x.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn is_false(o: &Value, k: &str) -> bool {
    o.get(k) == Some(&Value::Bool(false))
}
fn str_or<'a>(o: &'a Value, k: &str, d: &'a str) -> &'a str {
    o.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(d)
}
fn side(o: &Value) -> f64 {
    if num(o, "side") == Some(1.0) { 1.0 } else { -1.0 }
}

pub fn points(o: &Value) -> Vec<P> {
    o.get("pts")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|p| Some([p.get(0)?.as_f64()?, p.get(1)?.as_f64()?])).collect())
        .unwrap_or_default()
}

/* ---------- colour helpers ---------- */

fn rgb(h: &str) -> [f64; 3] {
    let s = h.strip_prefix('#').unwrap_or(h);
    if s.len() == 6 && s.bytes().all(|c| c.is_ascii_hexdigit()) {
        let v = u32::from_str_radix(s, 16).unwrap();
        return [((v >> 16) & 255) as f64, ((v >> 8) & 255) as f64, (v & 255) as f64];
    }
    [128.0, 128.0, 128.0]
}
fn hex(c: [f64; 3]) -> String {
    let mut s = String::from("#");
    for v in c {
        s.push_str(&format!("{:02x}", crate::figure::js_round(v.clamp(0.0, 255.0)) as i64));
    }
    s
}
pub fn mix(a: &str, b: &str, t: f64) -> String {
    let (a, b) = (rgb(a), rgb(b));
    hex([0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t))
}
fn lighten(c: &str, t: f64) -> String {
    mix(c, "#ffffff", t)
}
/// Darker and slightly richer, like the shading in Servier drawings.
fn shade(c: &str, t: f64) -> String {
    let [r, g, b] = rgb(c);
    let mx = r.max(g).max(b);
    let mn = r.min(g).min(b);
    let sat = if mx != 0.0 { (mx - mn) / mx } else { 0.0 };
    let k = 1.0 - t;
    let boost = 1.0 + t * 0.35 * (1.0 - sat);
    let avg = (r + g + b) / 3.0;
    hex([r, g, b].map(|v| (avg + (v - avg) * boost) * k))
}

/// Deterministic pseudo-random numbers in [0,1) — bit-for-bit the JavaScript `rand`.
fn rand(seed: f64, i: i64) -> f64 {
    let s = (seed as i64) as u32; // `seed | 0`
    let mut x = ((i + 1) as u32).wrapping_mul(0x9e37_79b1) ^ s.wrapping_mul(0x85eb_ca6b);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x as f64 / 4_294_967_296.0
}

/* ---------- catalogue ---------- */

pub struct Def {
    pub key: &'static str,
    pub name: &'static str,
    pub t: f64,
    /// The app's thickness slider range (px).
    pub min: f64,
    pub max: f64,
    /// Has a spacing slider (0.4–2.5).
    pub spacing: bool,
    pub cells: bool,
    /// (key, label, default colour)
    pub palette: &'static [(&'static str, &'static str, &'static str)],
}

pub const BRUSHES: &[Def] = &[
    Def { key: "bilayer", name: "Lipid bilayer", t: 16.0, min: 6.0, max: 60.0, spacing: false, cells: false, palette: &[] },
    Def {
        key: "dna", name: "DNA double helix", t: 22.0, min: 8.0, max: 90.0, spacing: true, cells: false,
        palette: &[("s1", "Strand 1", "#2f6db5"), ("s2", "Strand 2", "#e0634f"), ("a", "A", "#f2b83d"), ("t", "T", "#7cc36e"), ("g", "G", "#5aa6e0"), ("c", "C", "#b07cd1")],
    },
    Def {
        key: "rna", name: "RNA / mRNA strand", t: 14.0, min: 6.0, max: 60.0, spacing: true, cells: false,
        palette: &[("s1", "Backbone", "#d9534f"), ("a", "A", "#f2b83d"), ("u", "U", "#7cc36e"), ("g", "G", "#5aa6e0"), ("c", "C", "#b07cd1")],
    },
    Def {
        key: "cuboidal", name: "Epithelium — cuboidal cells", t: 34.0, min: 10.0, max: 140.0, spacing: true, cells: true,
        palette: &[("cell", "Cytoplasm", "#f7cfc0"), ("edge", "Cell edge", "#de8f7c"), ("nuc", "Nucleus", "#8f62b0"), ("bm", "Basement membrane", "#c6658a")],
    },
    Def {
        key: "columnar", name: "Epithelium — columnar cells", t: 60.0, min: 16.0, max: 220.0, spacing: true, cells: true,
        palette: &[("cell", "Cytoplasm", "#f6d3c5"), ("edge", "Cell edge", "#dc8d7a"), ("nuc", "Nucleus", "#8f62b0"), ("bm", "Basement membrane", "#c6658a")],
    },
    Def {
        key: "squamous", name: "Squamous / endothelial cells", t: 10.0, min: 4.0, max: 60.0, spacing: true, cells: true,
        palette: &[("cell", "Cytoplasm", "#f4c3c0"), ("edge", "Cell edge", "#d8857f"), ("nuc", "Nucleus", "#8f62b0"), ("bm", "Basement membrane", "#c6658a")],
    },
    Def { key: "actin", name: "Actin filament", t: 12.0, min: 4.0, max: 60.0, spacing: true, cells: false, palette: &[("m1", "Strand 1", "#f0a33c"), ("m2", "Strand 2", "#e27d3a")] },
    Def { key: "microtubule", name: "Microtubule", t: 24.0, min: 8.0, max: 90.0, spacing: true, cells: false, palette: &[("a", "α-tubulin", "#9fd3ef"), ("b", "β-tubulin", "#3d8ccf")] },
    Def { key: "collagen", name: "Collagen fibre", t: 16.0, min: 5.0, max: 80.0, spacing: true, cells: false, palette: &[("f", "Fibril", "#f1c48f"), ("d", "Banding & edge", "#b9783f")] },
    Def { key: "icon", name: "Repeat an icon", t: 40.0, min: 6.0, max: 300.0, spacing: true, cells: false, palette: &[] },
];

pub fn def(key: &str) -> Option<&'static Def> {
    BRUSHES.iter().find(|d| d.key == key)
}

pub fn kind(o: &Value) -> &'static str {
    o.get("brush").and_then(|v| v.as_str()).and_then(def).map(|d| d.key).unwrap_or("bilayer")
}

fn thickness(o: &Value, k: &str) -> f64 {
    match o.get("thickness") {
        Some(v) if !v.is_null() => v.as_f64().unwrap_or(f64::NAN),
        _ => def(k).unwrap().t,
    }
}

struct Pal(Vec<(&'static str, String)>);
impl Pal {
    fn get(&self, k: &str) -> &str {
        self.0.iter().find(|x| x.0 == k).map(|x| x.1.as_str()).unwrap_or("#808080")
    }
}
fn palette(o: &Value) -> Pal {
    let d = def(kind(o)).unwrap();
    Pal(d.palette.iter().map(|(k, _, c)| (*k, o.get("palette").map(|p| str_or(p, k, c)).unwrap_or(c).to_string())).collect())
}

/// How far the drawing reaches from the path (for bounding boxes).
pub fn pad(o: &Value) -> f64 {
    let k = kind(o);
    let t = thickness(o, k);
    if def(k).unwrap().cells {
        return t * (if k == "squamous" { 1.9 } else { 1.25 }) + 2.0;
    }
    if k == "icon" {
        return t * (0.75 + 0.6 * num_or(o, "jitter", 0.0)) + 2.0;
    }
    if k == "rna" {
        return t * 0.9 + 2.0;
    }
    t / 2.0 + 2.0
}

/* ---------- path geometry ---------- */

/// Smooth curve through points (Catmull–Rom), sampled densely as a polyline.
pub fn smooth_polyline(pts: &[P], closed: bool, steps: usize) -> Vec<P> {
    if pts.len() < 2 {
        return pts.to_vec();
    }
    let l = pts.len();
    let mut ext: Vec<P> = Vec::with_capacity(l + 3);
    if closed {
        ext.push(pts[l - 1]);
        ext.extend_from_slice(pts);
        ext.push(pts[0]);
        ext.push(pts[1]);
    } else {
        ext.push(pts[0]);
        ext.extend_from_slice(pts);
        ext.push(pts[l - 1]);
    }
    let mut out = Vec::new();
    let segs = if closed { l } else { l - 1 };
    for i in 0..segs {
        let (p0, p1, p2, p3) = (ext[i], ext[i + 1], ext[i + 2], ext[i + 3]);
        for k in 0..steps {
            let t = k as f64 / steps as f64;
            let t2 = t * t;
            let t3 = t2 * t;
            let f = |a: f64, b: f64, c: f64, d: f64| 0.5 * (2.0 * b + (-a + c) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2 + (-a + 3.0 * b - 3.0 * c + d) * t3);
            out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
        }
    }
    out.push(if closed { out[0] } else { pts[l - 1] });
    out
}

/// A polyline parametrised by arc length.
pub struct Track {
    pub p: Vec<P>,
    closed: bool,
    cum: Vec<f64>,
    pub len: f64,
}

impl Track {
    pub fn new(poly: Vec<P>, closed: bool) -> Track {
        let mut cum = vec![0.0];
        for i in 1..poly.len() {
            cum.push(cum[i - 1] + (poly[i][0] - poly[i - 1][0]).hypot(poly[i][1] - poly[i - 1][1]));
        }
        let len = *cum.last().unwrap();
        Track { p: poly, closed, cum, len }
    }

    fn pos(&self, s: f64) -> P {
        let (p, c, l) = (&self.p, &self.cum, self.len);
        if p.len() < 2 || l == 0.0 {
            return p.first().copied().unwrap_or([0.0, 0.0]);
        }
        let s = if self.closed { ((s % l) + l) % l } else { s.clamp(0.0, l) };
        let (mut lo, mut hi) = (0usize, c.len() - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) >> 1;
            if c[mid] <= s {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let seg = c[lo + 1] - c[lo];
        let t = if seg > 1e-9 { (s - c[lo]) / seg } else { 0.0 };
        [p[lo][0] + (p[lo + 1][0] - p[lo][0]) * t, p[lo][1] + (p[lo + 1][1] - p[lo][1]) * t]
    }

    /// [x, y, tx, ty]: position and unit tangent (central difference).
    fn at(&self, s: f64) -> [f64; 4] {
        let h = { let v = self.len / 200.0; if v != 0.0 && !v.is_nan() { 1.5f64.min(v) } else { 1.5f64.min(0.5) } };
        let a = self.pos(if self.closed { s - h } else { 0f64.max(s - h) });
        let b = self.pos(if self.closed { s + h } else { self.len.min(s + h) });
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = { let v = dx.hypot(dy); if v != 0.0 { v } else { 1.0 } };
        let [x, y] = self.pos(s);
        [x, y, dx / l, dy / l]
    }

    /// Point offset `d` along the normal (−ty, tx) at arc length s.
    fn off(&self, s: f64, d: f64) -> P {
        let [x, y, tx, ty] = self.at(s);
        [x - ty * d, y + tx * d]
    }
}

fn track(o: &Value, pts: &[P]) -> Track {
    let closed = truthy(o, "closed");
    Track::new(smooth_polyline(pts, closed, 12), closed)
}

fn pt(p: P) -> String {
    format!("{} {}", n(p[0]), n(p[1]))
}
fn line(pts: &[P]) -> String {
    if pts.is_empty() {
        return String::new();
    }
    "M".to_string() + &pts.iter().map(|p| pt(*p)).collect::<Vec<_>>().join("L")
}

/// Icon brushes: the tile's viewBox, id prefix and (already recoloured) markup.
pub struct IconTile {
    pub vb: [f64; 4],
    pub prefix: String,
    pub inner: String,
}

/// Markup for a brush object, coordinates as stored in `o.pts`.
pub fn markup(o: &Value, icon: Option<&IconTile>) -> String {
    let k = kind(o);
    let t = thickness(o, k);
    let pts = points(o);
    let mut out = String::new();
    if pts.len() >= 2 {
        let tr = track(o, &pts);
        let fill = str_or(o, "fill", "");
        if truthy(o, "closed") && !fill.is_empty() && fill != "none" {
            out += &format!("<path d=\"{}Z\" fill=\"{}\" stroke=\"none\"/>", line(&tr.p), fill);
        }
        if tr.len > 0.5 {
            out += &match k {
                "dna" => dna(o, &tr, t),
                "rna" => rna(o, &tr, t),
                "cuboidal" | "columnar" | "squamous" => cells(o, &tr, t, k),
                "actin" => actin(o, &tr, t),
                "microtubule" => microtubule(o, &tr, t),
                "collagen" => collagen(o, &tr, t),
                "icon" => match icon {
                    Some(ic) => icon_repeat(o, &tr, t, ic),
                    None => format!("<path d=\"{}\" fill=\"none\" stroke=\"#c0392b\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/>", line(&tr.p)),
                },
                _ => bilayer(o, &pts, t),
            };
        }
    }
    out
}

/* lipid bilayer: two leaflets of round heads with paired tails */

fn resample_every(poly: &[P], step: f64) -> Vec<[f64; 4]> {
    let mut out = Vec::new();
    let mut carry = 0.0;
    for i in 1..poly.len() {
        let ([ax, ay], [bx, by]) = (poly[i - 1], poly[i]);
        let len = (bx - ax).hypot(by - ay);
        if len == 0.0 || len.is_nan() {
            continue;
        }
        let (tx, ty) = ((bx - ax) / len, (by - ay) / len);
        let mut d = if carry != 0.0 && !f64::is_nan(carry) { step - carry } else { 0.0 };
        while d <= len {
            out.push([ax + tx * d, ay + ty * d, tx, ty]);
            d += step;
        }
        carry = len - (d - step);
    }
    out
}

fn circle_d(x: f64, y: f64, r: f64) -> String {
    format!("M{} {}a{} {} 0 1 0 {} 0a{} {} 0 1 0 {} 0", n(x - r), n(y), n(r), n(r), n(2.0 * r), n(r), n(r), n(-2.0 * r))
}

fn bilayer(o: &Value, pts: &[P], t: f64) -> String {
    let r = match o.get("headR") {
        Some(v) if !v.is_null() => v.as_f64().unwrap_or(f64::NAN),
        _ => t * 0.17,
    };
    let head_c = str_or(o, "headColor", "#f0a35c");
    let tail_c = str_or(o, "tailColor", "#e9c88f");
    let poly = smooth_polyline(pts, truthy(o, "closed"), 12);
    let samples = resample_every(&poly, r * 2.15);
    let (mut heads, mut tails) = (String::new(), String::new());
    let off = t / 2.0 - r;
    for &[x, y, tx, ty] in &samples {
        let (nx, ny) = (-ty, tx);
        for side in [1.0, -1.0] {
            let (hx, hy) = (x + nx * off * side, y + ny * off * side);
            heads += &circle_d(hx, hy, r);
            // two fatty-acid tails per lipid, pointing to the bilayer middle
            let inner = side * 0.6f64.max(t * 0.04);
            for s in [-0.38, 0.38] {
                let ax = hx + tx * r * s - nx * r * 0.8 * side;
                let ay = hy + ty * r * s - ny * r * 0.8 * side;
                tails += &format!("M{} {}L{} {}", n(ax), n(ay), n(x + nx * inner + tx * r * s), n(y + ny * inner + ty * r * s));
            }
        }
    }
    let mut out = format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\"/>", tails, tail_c, n(0.4f64.max(r * 0.32)));
    let stroke = if truthy(o, "headStroke") {
        format!(" stroke=\"{}\" stroke-width=\"{}\"", str_or(o, "headStroke", ""), n(r * 0.18))
    } else {
        String::new()
    };
    out += &format!("<path d=\"{}\" fill=\"{}\"{}/>", heads, head_c, stroke);
    // a soft highlight on each head, as in the shaded library art
    if t >= 10.0 && !is_false(o, "gloss") {
        let mut hl = String::new();
        let hr = r * 0.38;
        for &[x, y, tx, ty] in &samples {
            let (nx, ny) = (-ty, tx);
            for side in [1.0, -1.0] {
                let hx = x + nx * off * side - r * 0.3;
                let hy = y + ny * off * side - r * 0.32;
                hl += &circle_d(hx, hy, hr);
            }
        }
        out += &format!("<path d=\"{}\" fill=\"{}\" opacity=\"0.55\"/>", hl, lighten(head_c, 0.55));
    }
    out
}

/// Paths grouped by colour, in first-use order (like a JavaScript object's keys).
#[derive(Default)]
struct ByColour(Vec<(String, String)>);
impl ByColour {
    fn add(&mut self, c: &str, d: &str) {
        match self.0.iter_mut().find(|x| x.0 == c) {
            Some(x) => x.1.push_str(d),
            None => self.0.push((c.to_string(), d.to_string())),
        }
    }
}

/* DNA: two backbones with major/minor grooves and coloured base pairs */

fn dna(o: &Value, tr: &Track, t: f64) -> String {
    let pal = palette(o);
    let l = tr.len;
    let r = (t / 2.0) * 0.84;
    let wb = t * 0.17;
    let wr = t * 0.1;
    let mut pitch = t * 1.7 * num_or(o, "spacing", 1.0);
    if truthy(o, "closed") {
        pitch = l / 1f64.max((l / pitch).round_js());
    }
    let dphi = PI * 0.78;
    let ds = 0.6f64.max(pitch / 30.0);
    // runs of one backbone, split where it passes behind the other
    let runs = |phase: f64| -> Vec<(bool, Vec<P>)> {
        let mut all: Vec<(bool, Vec<P>)> = Vec::new();
        let mut s = 0.0;
        while s <= l + ds * 0.5 {
            let ss = s.min(l);
            let th = (2.0 * PI * ss) / pitch + phase;
            let p = tr.off(ss, r * th.sin());
            let front = th.cos() >= 0.0;
            match all.last_mut() {
                Some(cur) if cur.0 == front => cur.1.push(p),
                Some(cur) => {
                    let prev = *cur.1.last().unwrap();
                    cur.1.push(p);
                    all.push((front, vec![prev, p]));
                }
                None => all.push((front, vec![p])),
            }
            s += ds;
        }
        all
    };
    let (a, b) = (runs(0.0), runs(dphi));
    let ribbon = |rs: &[(bool, Vec<P>)], front: bool, c: &str| -> String {
        let rs: Vec<&Vec<P>> = rs.iter().filter(|r| r.0 == front).map(|r| &r.1).collect();
        if rs.is_empty() {
            return String::new();
        }
        let path: String = rs.iter().map(|r| line(r)).collect();
        let col = if front { c.to_string() } else { shade(c, 0.32) };
        let mut s = format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", path, col, n(wb));
        if front && t >= 9.0 {
            s += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\" opacity=\"0.7\"/>", path, lighten(c, 0.5), n(wb * 0.3));
        }
        s
    };
    // base pairs, ~10 per turn
    const PAIRS: [(&str, &str); 4] = [("a", "t"), ("t", "a"), ("g", "c"), ("c", "g")];
    let step = pitch / 10.0;
    let mut by = ByColour::default();
    let seed = num_or(o, "seed", 7.0);
    let (mut k, mut s) = (0i64, step / 2.0);
    while s < l {
        let th = (2.0 * PI * s) / pitch;
        let p1 = tr.off(s, r * th.sin());
        let p2 = tr.off(s, r * (th + dphi).sin());
        if (p2[0] - p1[0]).hypot(p2[1] - p1[1]) >= wb * 0.7 {
            let m = [(p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0];
            let (x, y) = PAIRS[(rand(seed, k) * 4.0).floor() as usize];
            by.add(pal.get(x), &format!("M{}L{}", pt(p1), pt(m)));
            by.add(pal.get(y), &format!("M{}L{}", pt(m), pt(p2)));
        }
        k += 1;
        s += step;
    }
    let mut rungs = String::new();
    for (c, d) in &by.0 {
        rungs += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\"/>", d, c, n(wr));
    }
    ribbon(&a, false, pal.get("s1")) + &ribbon(&b, false, pal.get("s2")) + &rungs + &ribbon(&a, true, pal.get("s1")) + &ribbon(&b, true, pal.get("s2"))
}

trait RoundJs {
    fn round_js(self) -> f64;
}
impl RoundJs for f64 {
    fn round_js(self) -> f64 {
        crate::figure::js_round(self)
    }
}

/* RNA: one wavy backbone with bases on one side */

fn rna(o: &Value, tr: &Track, t: f64) -> String {
    let pal = palette(o);
    let l = tr.len;
    let side = side(o);
    let (wb, amp, per) = (t * 0.2, t * 0.07, t * 2.8);
    let wave = |s: f64| amp * ((2.0 * PI * s) / per).sin();
    let mut pts = Vec::new();
    let ds = 0.6f64.max(t / 10.0);
    let mut s = 0.0;
    while s <= l + ds * 0.5 {
        pts.push(tr.off(s.min(l), wave(s.min(l))));
        s += ds;
    }
    let step = t * 0.46 * num_or(o, "spacing", 1.0);
    let mut by = ByColour::default();
    let seed = num_or(o, "seed", 11.0);
    const KEYS: [&str; 4] = ["a", "u", "g", "c"];
    let (mut k, mut s) = (0i64, step / 2.0);
    while s < l {
        let w = wave(s);
        let c = pal.get(KEYS[(rand(seed, k) * 4.0).floor() as usize]).to_string();
        by.add(&c, &format!("M{}L{}", pt(tr.off(s, w + side * wb * 0.2)), pt(tr.off(s, w + side * t * 0.68))));
        k += 1;
        s += step;
    }
    let mut out = String::new();
    for (c, d) in &by.0 {
        out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\"/>", d, shade(c, 0.25), n(t * 0.24));
        out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\"/>", d, c, n(t * 0.16));
    }
    let d = line(&pts);
    let s1 = pal.get("s1");
    out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", d, shade(s1, 0.2), n(wb * 1.2));
    out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", d, s1, n(wb * 0.85));
    out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\" opacity=\"0.7\"/>", d, lighten(s1, 0.5), n(wb * 0.28));
    out
}

/* Epithelial cells: a row of cells standing on a basement membrane */

/// Cut `r0` off the start and `r1` off the end of a polyline.
fn trim(pts: &[P], r0: f64, r1: f64) -> Vec<P> {
    let mut cum = vec![0.0];
    for i in 1..pts.len() {
        cum.push(cum[i - 1] + (pts[i][0] - pts[i - 1][0]).hypot(pts[i][1] - pts[i - 1][1]));
    }
    let l = *cum.last().unwrap();
    if r0 + r1 >= l {
        let den = if r0 + r1 != 0.0 { r0 + r1 } else { 1.0 };
        let t = r0 / den * l;
        let p = point_at(pts, &cum, t);
        return vec![p, p];
    }
    let mut out = vec![point_at(pts, &cum, r0)];
    for i in 1..pts.len().saturating_sub(1) {
        if cum[i] > r0 && cum[i] < l - r1 {
            out.push(pts[i]);
        }
    }
    out.push(point_at(pts, &cum, l - r1));
    out
}

fn point_at(pts: &[P], cum: &[f64], s: f64) -> P {
    let mut i = 1;
    while i < pts.len() - 1 && cum[i] < s {
        i += 1;
    }
    let seg = { let v = cum[i] - cum[i - 1]; if v != 0.0 { v } else { 1.0 } };
    let t = ((s - cum[i - 1]) / seg).clamp(0.0, 1.0);
    [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]
}

/// A cell outline between arc lengths s0..s1 and heights h0..top(s) with rounded corners.
#[allow(clippy::too_many_arguments)]
fn cell_path(tr: &Track, side: f64, h0: f64, top: &dyn Fn(f64) -> f64, r_base: f64, r_top: f64, s0: f64, s1: f64) -> String {
    let kk = 3f64.max(((s1 - s0) / 2.5).ceil()) as usize;
    let (mut bottom, mut upper) = (Vec::new(), Vec::new());
    for k in 0..=kk {
        let s = s0 + ((s1 - s0) * k as f64) / kk as f64;
        bottom.push(tr.off(s, side * h0));
        upper.push(tr.off(s, side * top(s)));
    }
    upper.reverse();
    let right = [bottom[kk], upper[0]];
    let left = [upper[kk], bottom[0]];
    let len = |a: P, b: P| (b[0] - a[0]).hypot(b[1] - a[1]);
    let rb = r_base.min(len(right[0], right[1]) * 0.45).min(len(left[0], left[1]) * 0.45);
    let rt = r_top.min(len(right[0], right[1]) * 0.45).min(len(left[0], left[1]) * 0.45);
    let b = trim(&bottom, rb, rb);
    let r = trim(&right, rb, rt);
    let u = trim(&upper, rt, rt);
    let lf = trim(&left, rt, rb);
    let join = |v: &[P]| v.iter().map(|p| pt(*p)).collect::<Vec<_>>().join("L");
    format!(
        "M{}L{}Q{} {}L{}Q{} {}L{}Q{} {}L{}Q{} {}Z",
        pt(b[0]), join(&b[1..]), pt(bottom[kk]), pt(r[0]), pt(r[1]), pt(upper[0]), pt(u[0]), join(&u[1..]),
        pt(upper[kk]), pt(lf[0]), pt(lf[1]), pt(bottom[0]), pt(b[0])
    )
}

fn ellipse_at(tr: &Track, s: f64, h: f64, rx: f64, ry: f64, side: f64) -> String {
    let [x, y, tx, ty] = tr.at(s);
    let cx = x - ty * h * side;
    let cy = y + tx * h * side;
    let a = (ty.atan2(tx) * 180.0) / PI;
    format!("<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" transform=\"rotate({} {} {})\"", n(cx), n(cy), n(rx), n(ry), n(a), n(cx), n(cy))
}

fn cells(o: &Value, tr: &Track, t: f64, kind: &str) -> String {
    let pal = palette(o);
    let side = side(o);
    let l = tr.len;
    let seed = num_or(o, "seed", 3.0);
    let want = (match kind { "cuboidal" => 1.0, "columnar" => 0.4, _ => 3.6 }) * t * num_or(o, "spacing", 1.0);
    let cnt = 1f64.max((l / want).round_js());
    let w_cell = l / cnt;
    let gap = (w_cell * 0.05).min(t * 0.06).min(1.4);
    let sw = 0.5f64.max(w_cell.min(t) * 0.035);
    let outer = mix(pal.get("cell"), pal.get("edge"), 0.4);
    let (mut bodies, mut inners, mut gloss, mut nuclei, mut apical) = (String::new(), String::new(), String::new(), String::new(), String::new());
    let apical_kind = str_or(o, "apical", "none");
    let nuc = pal.get("nuc");
    for i in 0..cnt as i64 {
        let fi = i as f64;
        let s0 = fi * w_cell + gap / 2.0;
        let s1 = (fi + 1.0) * w_cell - gap / 2.0;
        let sm = (s0 + s1) / 2.0;
        let w = s1 - s0;
        let j = (rand(seed, i) - 0.5) * 2.0;
        let top: Box<dyn Fn(f64) -> f64>;
        let (r_top, r_base, nh, nrx, nry, nc);
        if kind == "squamous" {
            // flat cell with the nucleus bulging into the lumen
            let bw = w * 0.24;
            let bh = t * 0.85;
            let bc = sm + j * w * 0.12;
            top = Box::new(move |s: f64| t + bh * (0f64.max(1.0 - ((s - bc) / bw).powi(2))).sqrt().powf(1.2));
            r_top = (t * 0.45).min(w * 0.1);
            r_base = (t * 0.2).min(w * 0.05);
            nh = t * 0.55 + bh * 0.42;
            nrx = bw * 0.82;
            nry = (t + bh) * 0.36;
            nc = bc;
        } else {
            let col = kind == "columnar";
            let ht = t * (1.0 + (if col { 0.05 } else { 0.035 }) * j);
            top = Box::new(move |_| ht);
            r_top = (w * 0.3).min(ht * 0.3);
            r_base = (w * 0.12).min(ht * 0.08);
            nh = if col { ht * (0.34 + 0.04 * j) } else { ht * 0.5 };
            nrx = if col { w * 0.3 } else { w * 0.27 };
            nry = if col { ht * 0.16 } else { ht * 0.24 };
            nc = sm + j * w * 0.05;
        }
        bodies += &cell_path(tr, side, gap * 0.4, &*top, r_base, r_top, s0, s1);
        // a lighter cushion inside the darker rim
        let ins = w.min(t) * 0.11;
        if w > ins * 3.0 {
            let t_in = |s: f64| (gap * 0.4 + ins * 2.0).max(top(s) - ins);
            inners += &cell_path(tr, side, gap * 0.4 + ins, &t_in, 0f64.max(r_base - ins * 0.5), 0f64.max(r_top - ins * 0.6), s0 + ins, s1 - ins);
            if kind != "squamous" && t > 14.0 {
                gloss += &(ellipse_at(tr, s0 + w * 0.3, top(s0 + w * 0.3) * 0.84, w * 0.13, (t * 0.06).min(w * 0.08), side) + "/>");
            }
        }
        // nucleus with a darker rim, a highlight and a nucleolus
        nuclei += &(ellipse_at(tr, nc, nh, nrx, nry, side) + &format!(" fill=\"{}\" stroke=\"{}\" stroke-width=\"{}\"/>", nuc, shade(nuc, 0.3), n(sw * 0.9)));
        if nrx.min(nry) > 2.5 {
            nuclei += &(ellipse_at(tr, nc - nrx * 0.22, nh + nry * 0.28, nrx * 0.48, nry * 0.42, side) + &format!(" fill=\"{}\" opacity=\"0.6\"/>", lighten(nuc, 0.38)));
            let nr = nrx.min(nry) * 0.22;
            nuclei += &(ellipse_at(tr, nc + nrx * 0.25, nh - nry * 0.12, nr, nr, side) + &format!(" fill=\"{}\"/>", shade(nuc, 0.35)));
        }
        // apical specialisations
        if apical_kind != "none" && kind != "squamous" {
            let r0 = r_top * (if apical_kind == "microvilli" { 0.45 } else { 0.8 });
            if apical_kind == "microvilli" {
                let sp = 1.2f64.max((w * 0.09).min(t * 0.03));
                let mut s = s0 + r0;
                while s <= s1 - r0 {
                    let h = top(s);
                    apical += &format!("M{}L{}", pt(tr.off(s, side * (h - sw))), pt(tr.off(s, side * (h + t * 0.09))));
                    s += sp;
                }
            } else if apical_kind == "cilia" {
                let sp = 2f64.max(t * 0.06);
                let (mut s, mut q) = (s0 + r0, 0.0);
                while s <= s1 - r0 {
                    let h = top(s);
                    let len = t * (0.3 + 0.04 * (q * 1.7 + fi).sin());
                    let [_, _, tx, ty] = tr.at(s);
                    let a = tr.off(s, side * (h - sw));
                    let b = tr.off(s, side * (h + len));
                    let bend = len * 0.28;
                    let c = [(a[0] + b[0]) / 2.0 + tx * bend, (a[1] + b[1]) / 2.0 + ty * bend];
                    let e = [b[0] + tx * bend * 0.9, b[1] + ty * bend * 0.9];
                    apical += &format!("M{}Q{} {}", pt(a), pt(c), pt(e));
                    s += sp;
                    q += 1.0;
                }
            }
        }
    }
    let mut out = String::new();
    if !is_false(o, "basement") {
        let mut bm = Vec::new();
        let step = 1.5f64.max(l / 600.0);
        let bw = 0.9f64.max(t * (if kind == "squamous" { 0.12 } else { 0.05 }));
        let mut s = 0.0;
        while s <= l + 1e-6 {
            bm.push(tr.off(s.min(l), -side * bw * 0.45));
            s += step;
        }
        out += &format!(
            "<path d=\"{}{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
            line(&bm), if truthy(o, "closed") { "Z" } else { "" }, pal.get("bm"), n(bw)
        );
    }
    if !apical.is_empty() {
        let aw = if apical_kind == "cilia" { 0.35f64.max(t * 0.016) } else { 0.5f64.max(t * 0.022) };
        out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\"/>", apical, shade(pal.get("edge"), 0.12), n(aw));
    }
    out += &format!("<path d=\"{}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"{}\" stroke-linejoin=\"round\"/>", bodies, outer, pal.get("edge"), n(sw));
    if !inners.is_empty() {
        out += &format!("<path d=\"{}\" fill=\"{}\"/>", inners, pal.get("cell"));
    }
    if !gloss.is_empty() {
        out += &format!("<g fill=\"{}\" opacity=\"0.6\">{}</g>", lighten(pal.get("cell"), 0.6), gloss);
    }
    out + &nuclei
}

/* Actin: two twisted strands of globular monomers */

fn actin(o: &Value, tr: &Track, t: f64) -> String {
    let pal = palette(o);
    let l = tr.len;
    let rb = t * 0.27;
    let d = rb * 1.75 * num_or(o, "spacing", 1.0);
    let mut half = d * 6.5;
    let closed = truthy(o, "closed");
    if closed {
        half = l / 1f64.max((l / half).round_js());
    }
    struct Bead {
        x: f64,
        y: f64,
        z: f64,
        c: String,
    }
    let mut beads = Vec::new();
    let (mut k, mut s) = (0i64, rb);
    while s <= l - rb * 0.5 || (closed && s < l) {
        let strand = if k % 2 != 0 { 1.0 } else { -1.0 };
        let ph = (PI * s) / half;
        let lat = strand * t * 0.21 * ph.cos();
        let z = strand * ph.sin();
        let [x, y] = tr.off(s, lat);
        beads.push(Bead { x, y, z, c: if strand > 0.0 { pal.get("m1") } else { pal.get("m2") }.to_string() });
        k += 1;
        s += d / 2.0;
    }
    beads.sort_by(|a, b| (a.z - b.z).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let sw = rb * 0.12;
    let mut out = String::new();
    for b in &beads {
        let c = if b.z < 0.0 { shade(&b.c, 0.18) } else { b.c.clone() };
        out += &format!("<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"{}\"/>", n(b.x), n(b.y), n(rb), c, shade(&b.c, 0.38), n(sw));
        if rb > 2.2 {
            out += &format!(
                "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"{}\" opacity=\"{}\"/>",
                n(b.x - rb * 0.3), n(b.y - rb * 0.32), n(rb * 0.34), lighten(&b.c, 0.55), if b.z < 0.0 { "0.35" } else { "0.7" }
            );
        }
    }
    out
}

/* Microtubule: a hollow tube of α/β-tubulin protofilaments */

fn microtubule(o: &Value, tr: &Track, t: f64) -> String {
    let pal = palette(o);
    let l = tr.len;
    let a = t * 0.2 * num_or(o, "spacing", 1.0);
    let rows: [f64; 4] = [-0.375, -0.125, 0.125, 0.375];
    let mut edge = Vec::new();
    let step = 1.5f64.max(l / 500.0);
    let mut s = 0.0;
    while s <= l + 1e-6 {
        edge.push(tr.pos(s.min(l)));
        s += step;
    }
    let mut out = format!(
        "<path d=\"{}{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"butt\" stroke-linejoin=\"round\"/>",
        line(&edge), if truthy(o, "closed") { "Z" } else { "" }, shade(pal.get("b"), 0.45), n(t * 0.92)
    );
    let (mut by_a, mut by_b) = (Vec::new(), Vec::new());
    for (j, f) in rows.iter().enumerate() {
        let persp = (1.0 - (2.0 * f).powi(2) * 0.75).sqrt();
        let ry = t * 0.122 * persp;
        let rx = a * 0.47;
        let stagger = (j as f64 * a * 0.46) % (2.0 * a);
        let (mut k, mut s) = (0i64, stagger + a / 2.0);
        while s < l - a * 0.3 {
            let e = ellipse_at(tr, s, f * t, rx, ry, 1.0);
            if k % 2 != 0 { by_b.push(e) } else { by_a.push(e) }
            k += 1;
            s += a;
        }
    }
    for (key, list) in [("a", &by_a), ("b", &by_b)] {
        let c = pal.get(key);
        out += &format!(
            "<g fill=\"{}\" stroke=\"{}\" stroke-width=\"{}\">{}</g>",
            c, shade(c, 0.32), n(0.3f64.max(t * 0.018)), list.iter().map(|e| e.clone() + "/>").collect::<String>()
        );
    }
    // a soft sheen along the top of the tube
    let mut hl = Vec::new();
    let mut s = 0.0;
    while s <= l + 1e-6 {
        hl.push(tr.off(s.min(l), -t * 0.3));
        s += step;
    }
    out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"{}\" stroke-linecap=\"round\" opacity=\"0.35\"/>", line(&hl), n(t * 0.08));
    out
}

/* Collagen: a bundle of crimped, banded fibrils */

fn collagen(o: &Value, tr: &Track, t: f64) -> String {
    let pal = palette(o);
    let l = tr.len;
    let (per, amp) = (t * 2.6, t * 0.05);
    let offs = [-0.31, 0.0, 0.31];
    let wf = t * 0.34;
    let step = 0.8f64.max(t / 10.0);
    let (fc, dc) = (pal.get("f"), pal.get("d"));
    let mut out = String::new();
    for (i, f) in offs.iter().enumerate() {
        let fi = i as f64;
        let crimp = |s: f64| f * t + amp * ((2.0 * PI * s) / per + fi * 1.9).sin();
        let mut pts = Vec::new();
        let mut s = 0.0;
        while s <= l + step * 0.5 {
            pts.push(tr.off(s.min(l), crimp(s.min(l))));
            s += step;
        }
        let d = line(&pts);
        out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", d, dc, n(wf));
        out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", d, fc, n(wf * 0.78));
        // D-period banding
        let dd = t * 0.42 * num_or(o, "spacing", 1.0);
        let mut bands = String::new();
        let mut s = dd / 2.0 + fi * dd * 0.33;
        while s < l - dd * 0.3 {
            let c = crimp(s);
            bands += &format!("M{}L{}", pt(tr.off(s, c - wf * 0.36)), pt(tr.off(s, c + wf * 0.36)));
            s += dd;
        }
        out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" opacity=\"0.75\"/>", bands, dc, n(0.4f64.max(dd * 0.2)));
        let hl: Vec<P> = (0..pts.len())
            .map(|k| {
                let s = (k as f64 * step).min(l);
                tr.off(s, crimp(s) - wf * 0.18)
            })
            .collect();
        out += &format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"round\" opacity=\"0.7\"/>", line(&hl), lighten(fc, 0.6), n(wf * 0.18));
    }
    out
}

/* Any library icon, repeated along the path */

fn icon_repeat(o: &Value, tr: &Track, t: f64, icon: &IconTile) -> String {
    let [vx, vy, vw, vh] = icon.vb;
    let sc = t / (if vh != 0.0 { vh } else { 1.0 });
    let w = vw * sc;
    let mut step = (w + t * 0.12) * num_or(o, "spacing", 1.0);
    let l = tr.len;
    let closed = truthy(o, "closed");
    let count = if closed { 1f64.max((l / step).round_js()) } else { 1f64.max(((l + step * 0.25) / step).floor()) };
    if closed {
        step = l / count;
    }
    let start = if closed { 0.0 } else { 0f64.max((l - step * (count - 1.0)) / 2.0) };
    let id = format!("{}tile", icon.prefix);
    let jit = num_or(o, "jitter", 0.0);
    let seed = num_or(o, "seed", 5.0);
    let follow = !is_false(o, "follow");
    let side = side(o);
    let mut uses = String::new();
    for k in 0..count as i64 {
        let s = start + k as f64 * step;
        let [x, y, tx, ty] = tr.at(s);
        let lat = if jit != 0.0 { (rand(seed, k * 3) - 0.5) * t * 0.6 * jit } else { 0.0 };
        let (px, py) = (x - ty * lat, y + tx * lat);
        let mut ang = if follow { (ty.atan2(tx) * 180.0) / PI + (if side > 0.0 { 180.0 } else { 0.0 }) } else { 0.0 };
        if jit != 0.0 {
            ang += (rand(seed, k * 3 + 1) - 0.5) * 50.0 * jit;
        }
        let s2 = sc * (if jit != 0.0 { 1.0 + (rand(seed, k * 3 + 2) - 0.5) * 0.3 * jit } else { 1.0 });
        uses += &format!("<use xlink:href=\"#{}\" transform=\"translate({} {}) rotate({}) scale({})\"/>", id, n(px), n(py), n(ang), n(s2));
    }
    format!("<defs><g id=\"{}\" transform=\"translate({} {})\">{}</g></defs>{}", id, n(-vx - vw / 2.0), n(-vy - vh / 2.0), icon.inner, uses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rand_matches_js() {
        // values printed by node with brush.js's own rand()
        for (seed, i, want) in [(7.0, 0, 0.5724971585441381), (123456.0, 5, 0.18571142363362014), (5.7, 3, 0.445736296242103), (3e9, 2, 0.3216610031668097)] {
            assert_eq!(rand(seed, i), want, "rand({seed}, {i})");
        }
    }

    #[test]
    fn every_pattern_draws() {
        for d in BRUSHES.iter().filter(|d| d.key != "icon") {
            let o = json!({ "type": "membrane", "brush": d.key, "pts": [[0, 0], [60, 20], [140, 0]], "apical": "cilia" });
            let m = markup(&o, None);
            assert!(m.len() > 200 && !m.contains("NaN"), "{}: {}", d.key, &m[..m.len().min(200)]);
        }
    }
}
