//! Figure composer for AI agents and the command line: an agent-friendly JSON "figure spec" in
//! millimetres → a native BioCraft document (exactly what the app saves) → SVG drawn the way the
//! app draws it (a port of ui/js/render.js) → PNG/TIFF/PDF through the core renderer.

use crate::api::AppState;
use crate::{brush, labels};
use anyhow::{bail, Result};
use biocanvas_core::color::{shift_like, Oklab, Rgb};
use biocanvas_core::render::{encode_png, encode_tiff, to_pdf};
use biocanvas_core::{svgclean, usvg, Renderer};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

/// CSS pixels per millimetre: documents store geometry in px (96 per inch), sizes in mm.
pub const MM: f64 = 96.0 / 25.4;

/* ---------- JavaScript-compatible numbers ---------- */

/// `Math.round`: halves round towards +∞.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `(Math.round(v * k) / k).toString()`, so markup matches the app's character for character.
pub fn js_num(v: f64, k: f64) -> String {
    let r = js_round(v * k) / k;
    if r == 0.0 {
        "0".into()
    } else if r.is_nan() {
        "NaN".into()
    } else if r.is_infinite() {
        if r > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        format!("{r}")
    }
}

fn n(v: f64) -> String {
    js_num(v, 1000.0)
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            c => o.push(c),
        }
    }
    o
}

/* ---------- colour maps (ui/js/color.js) ---------- */

/// `normHex`: "#abc", "abc", "#AABBCC" → "#aabbcc".
pub fn norm_hex(s: &str) -> Option<String> {
    let h = s.trim().trim_start_matches('#');
    let h: String = if h.len() == 3 { h.chars().flat_map(|c| [c, c]).collect() } else { h.to_string() };
    (h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("#{}", h.to_ascii_lowercase()))
}

fn rgb(s: &str) -> Rgb {
    Rgb::parse(s).unwrap_or(Rgb::new(0, 0, 0))
}

fn members(slot: &Value) -> impl Iterator<Item = &str> {
    slot["members"].as_array().into_iter().flatten().filter_map(|m| m.as_str())
}

/// Colour map for an icon from its slots and per-slot target colours (None = unchanged).
pub fn slot_color_map(slots: &[Value], targets: &[Option<String>]) -> Map<String, Value> {
    let mut map = Map::new();
    for (i, slot) in slots.iter().enumerate() {
        let Some(Some(t)) = targets.get(i) else { continue };
        let base = slot["base"].as_str().unwrap_or("#000000").to_lowercase();
        for m in members(slot) {
            let m = m.to_lowercase();
            let to = if m == base { norm_hex(t).unwrap_or_default() } else { shift_like(rgb(&m), rgb(&base), rgb(t)).hex() };
            map.insert(m, json!(to));
        }
    }
    map
}

/// Every colour onto one hue (BioRender's monochrome "tint").
pub fn tint_map(slots: &[Value], target: &str) -> Map<String, Value> {
    let t = rgb(target).oklab();
    let (tc, th) = (t.chroma(), t.hue());
    let mut map = Map::new();
    for slot in slots {
        let color = slot["kind"].as_str() == Some("color");
        for m in members(slot) {
            let c = rgb(m).oklab();
            let ch = if color { c.chroma().max(tc * 0.6) } else { c.chroma() * 0.5 + tc * 0.15 };
            map.insert(m.to_lowercase(), json!(Oklab::from_lch(c.l.clamp(0.0, 1.0), ch, th).to_rgb().hex()));
        }
    }
    map
}

pub fn gray_map(slots: &[Value]) -> Map<String, Value> {
    let mut map = Map::new();
    for slot in slots {
        for m in members(slot) {
            let l = rgb(m).oklab().l;
            map.insert(m.to_lowercase(), json!(Oklab::from_lch(l.clamp(0.0, 1.0), 0.0, 0.0).to_rgb().hex()));
        }
    }
    map
}

/* ---------- geometry (ui/js/model.js) ---------- */

fn f(o: &Value, k: &str) -> f64 {
    o.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0)
}
fn opt_f(o: &Value, k: &str) -> Option<f64> {
    o.get(k).and_then(|v| v.as_f64())
}
fn s<'a>(o: &'a Value, k: &str) -> &'a str {
    o.get(k).and_then(|v| v.as_str()).unwrap_or("")
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
fn ty(o: &Value) -> &str {
    s(o, "type")
}
fn is_box(o: &Value) -> bool {
    matches!(ty(o), "icon" | "text" | "rect" | "ellipse" | "image")
}
fn children(o: &Value) -> &[Value] {
    o.get("children").and_then(|c| c.as_array()).map(|v| v.as_slice()).unwrap_or(&[])
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn rot_pt(x: f64, y: f64, cx: f64, cy: f64, deg: f64) -> [f64; 2] {
    let r = (deg * std::f64::consts::PI) / 180.0;
    let (c, s) = (r.cos(), r.sin());
    let (dx, dy) = (x - cx, y - cy);
    [cx + dx * c - dy * s, cy + dx * s + dy * c]
}

fn union(boxes: &[BBox]) -> BBox {
    if boxes.is_empty() {
        return BBox { x: 0.0, y: 0.0, w: 0.0, h: 0.0 };
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for b in boxes {
        x0 = x0.min(b.x);
        y0 = y0.min(b.y);
        x1 = x1.max(b.x + b.w);
        y1 = y1.max(b.y + b.h);
    }
    BBox { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

fn pts_box(pts: &[[f64; 2]], pad: f64) -> BBox {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in pts {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    BBox { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2.0 * pad, h: y1 - y0 + 2.0 * pad }
}

fn corners(o: &Value) -> Vec<[f64; 2]> {
    let (x, y, w, h) = (f(o, "x"), f(o, "y"), f(o, "w"), f(o, "h"));
    let (cx, cy) = (x + w / 2.0, y + h / 2.0);
    let r = opt_f(o, "rot").filter(|v| *v != 0.0).unwrap_or(0.0);
    [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].iter().map(|p| rot_pt(p[0], p[1], cx, cy, r)).collect()
}

/// Quadratic control point of a line from its bulge.
fn ctrl_pt(o: &Value) -> [f64; 2] {
    let (x1, y1, x2, y2) = (f(o, "x1"), f(o, "y1"), f(o, "x2"), f(o, "y2"));
    let (mx, my) = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
    let (dx, dy) = (x2 - x1, y2 - y1);
    let len = { let l = dx.hypot(dy); if l != 0.0 { l } else { 1.0 } };
    let c = f(o, "curve");
    [mx + (-dy / len) * 2.0 * c, my + (dx / len) * 2.0 * c]
}

fn line_point(o: &Value, t: f64) -> [f64; 2] {
    let [cx, cy] = ctrl_pt(o);
    let u = 1.0 - t;
    [u * u * f(o, "x1") + 2.0 * u * t * cx + t * t * f(o, "x2"), u * u * f(o, "y1") + 2.0 * u * t * cy + t * t * f(o, "y2")]
}

/// Axis-aligned bounds in document coordinates.
pub fn bbox(o: &Value) -> BBox {
    match ty(o) {
        "group" => union(&children(o).iter().map(bbox).collect::<Vec<_>>()),
        "line" => {
            let pts: Vec<[f64; 2]> = (0..=16).map(|i| line_point(o, i as f64 / 16.0)).collect();
            let sw = opt_f(o, "strokeWidth").filter(|v| *v != 0.0).unwrap_or(2.0);
            pts_box(&pts, sw / 2.0)
        }
        "membrane" => {
            let pts = brush::points(o);
            let poly = if pts.len() > 1 { brush::smooth_polyline(&pts, truthy(o, "closed"), 6) } else { pts };
            pts_box(&poly, brush::pad(o))
        }
        _ => pts_box(&corners(o), 0.0),
    }
}

fn move_obj(o: &mut Value, dx: f64, dy: f64) {
    let add = |o: &mut Value, k: &str, d: f64| {
        let v = f(o, k) + d;
        o[k] = json!(v);
    };
    match ty(o) {
        "group" => {
            if let Some(c) = o.get_mut("children").and_then(|c| c.as_array_mut()) {
                c.iter_mut().for_each(|c| move_obj(c, dx, dy));
            }
        }
        "line" => {
            add(o, "x1", dx);
            add(o, "y1", dy);
            add(o, "x2", dx);
            add(o, "y2", dy);
        }
        "membrane" => {
            let pts: Vec<Value> = brush::points(o).iter().map(|p| json!([p[0] + dx, p[1] + dy])).collect();
            o["pts"] = Value::Array(pts);
        }
        _ => {
            add(o, "x", dx);
            add(o, "y", dy);
        }
    }
}

/* ---------- drawing (ui/js/render.js) ---------- */

/// Lines, brushes and groups are drawn relative to an origin and positioned with a translate.
fn obj_origin(o: &Value) -> [f64; 2] {
    match ty(o) {
        "line" => [f(o, "x1"), f(o, "y1")],
        "membrane" => brush::points(o).first().copied().unwrap_or([0.0, 0.0]),
        "group" => {
            let b = bbox(o);
            [b.x, b.y]
        }
        _ => [0.0, 0.0],
    }
}

fn rel_copy(o: &Value) -> Value {
    let [ox, oy] = obj_origin(o);
    let mut c = o.clone();
    move_obj(&mut c, -ox, -oy);
    c
}

/// An icon's viewBox and inner markup (`assetParts`).
pub fn asset_parts(asset: &Value) -> ([f64; 4], &str) {
    let svg = s(asset, "svg");
    let open = svg.find("<svg").and_then(|i| svg[i..].find('>').map(|j| i + j));
    let close = svg.rfind("</svg>");
    let head = &svg[..open.unwrap_or(0)];
    let w = opt_f(asset, "w").filter(|v| *v != 0.0).unwrap_or(100.0);
    let h = opt_f(asset, "h").filter(|v| *v != 0.0).unwrap_or(100.0);
    let vb = head
        .find("viewBox=\"")
        .and_then(|i| {
            let rest = &head[i + 9..];
            let v: Vec<f64> = rest[..rest.find('"')?].trim().split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).map(|s| s.parse().unwrap_or(f64::NAN)).collect();
            (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
        })
        .unwrap_or([0.0, 0.0, w, h]);
    let inner = match (open, close) {
        (Some(o), Some(c)) if c > o => &svg[o + 1..c],
        _ => "",
    };
    (vb, inner)
}

const PAINT_ATTRS: [&str; 5] = ["fill", "stroke", "stop-color", "flood-color", "lighting-color"];

/// Icon markup with colours mapped and ids made unique per instance (`iconInner`).
pub fn icon_inner(inner: &str, colors: Option<&Map<String, Value>>, prefix: &str) -> String {
    let mut s = inner.to_string();
    if let Some(map) = colors.filter(|m| !m.is_empty()) {
        let mut out = String::with_capacity(s.len());
        let mut last = 0;
        let b = s.as_bytes();
        let mut i = 0;
        while let Some(off) = s[i..].find("=\"#") {
            let at = i + off;
            let v = at + 3;
            i = at + 1;
            let named = PAINT_ATTRS.iter().any(|a| s[..at].ends_with(a));
            if named && v + 7 <= b.len() && b[v..v + 6].iter().all(|c| c.is_ascii_hexdigit()) && b[v + 6] == b'"' {
                if let Some(to) = map.get(&s[v - 1..v + 6].to_lowercase()).and_then(|x| x.as_str()) {
                    out.push_str(&s[last..v - 1]);
                    out.push_str(to);
                    last = v + 6;
                }
                i = v + 6;
            }
        }
        out.push_str(&s[last..]);
        s = out;
    }
    if !prefix.is_empty() && s.contains("id=\"") {
        s = prefix_ids(&s, prefix);
    }
    s
}

/// `id="x"` → `id="<p>x"`, `url(#x)` → `url(#<p>x)`, `href="#x"` → `href="#<p>x"`.
fn prefix_ids(s: &str, p: &str) -> String {
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let pass = |s: &str, pat: &str, end: u8, check: &dyn Fn(&str, usize) -> bool| -> String {
        let mut out = String::with_capacity(s.len() + 64);
        let mut last = 0;
        let mut i = 0;
        while let Some(off) = s[i..].find(pat) {
            let at = i + off;
            let v = at + pat.len();
            i = at + 1;
            let len = s[v..].bytes().position(|c| c == end);
            if check(s, at) && matches!(len, Some(l) if l > 0) {
                out.push_str(&s[last..v]);
                out.push_str(p);
                last = v;
                i = v;
            }
        }
        out.push_str(&s[last..]);
        out
    };
    let s = pass(s, "id=\"", b'"', &|s, at| at == 0 || !word(s.as_bytes()[at - 1]));
    let s = pass(&s, "url(#", b')', &|_, _| true);
    pass(&s, "href=\"#", b'"', &|_, _| true)
}

pub const HEADS: [&str; 6] = ["none", "arrow", "open", "bar", "dot", "diamond"];

/// Arrowhead markup at `p`, pointing along unit vector `d` (`head`).
pub fn head(kind: &str, p: [f64; 2], d: [f64; 2], s: f64, color: &str, sw: f64) -> String {
    let [px, py] = p;
    let [dx, dy] = d;
    let (nx, ny) = (-dy, dx);
    let (bx, by) = (px - dx * s, py - dy * s);
    match kind {
        "arrow" => {
            let w = s * 0.46;
            format!(
                "<path d=\"M{} {}L{} {}L{} {}L{} {}Z\" fill=\"{color}\"/>",
                n(px), n(py), n(bx + nx * w), n(by + ny * w), n(px - dx * s * 0.78), n(py - dy * s * 0.78), n(bx - nx * w), n(by - ny * w)
            )
        }
        "open" => {
            let w = s * 0.5;
            format!(
                "<path d=\"M{} {}L{} {}L{} {}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"{}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
                n(bx + nx * w), n(by + ny * w), n(px), n(py), n(bx - nx * w), n(by - ny * w), n(sw)
            )
        }
        "bar" => {
            let w = s * 0.62;
            format!("<path d=\"M{} {}L{} {}\" stroke=\"{color}\" stroke-width=\"{}\" stroke-linecap=\"round\"/>", n(px + nx * w), n(py + ny * w), n(px - nx * w), n(py - ny * w), n(sw * 1.35))
        }
        "dot" => format!("<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"{color}\"/>", n(px - dx * s * 0.3), n(py - dy * s * 0.3), n(s * 0.32)),
        "diamond" => {
            let (w, mx, my) = (s * 0.32, px - dx * s * 0.5, py - dy * s * 0.5);
            format!(
                "<path d=\"M{} {}L{} {}L{} {}L{} {}Z\" fill=\"{color}\"/>",
                n(px), n(py), n(mx + nx * w), n(my + ny * w), n(px - dx * s), n(py - dy * s), n(mx - nx * w), n(my - ny * w)
            )
        }
        _ => String::new(),
    }
}

/// How far a head pulls the line's end back, as a fraction of the head size (`TRIM`).
pub fn trim(kind: &str) -> f64 {
    match kind {
        "arrow" => 0.7,
        "diamond" => 0.9,
        "dot" => 0.45,
        "open" => 0.05,
        _ => 0.0,
    }
}

/// Head size for a stroke width (`s` in lineMarkup).
pub fn head_size(sw: f64, scale: f64) -> f64 {
    (7f64).max(sw * 4.2) * scale
}

pub fn dash_array(kind: &str, sw: f64) -> String {
    match kind {
        "" => String::new(),
        "dot" => format!("{} {}", n(sw * 0.01 + 0.01), n(sw * 2.2)),
        "dash" => format!("{} {}", n(sw * 3.5), n(sw * 2.4)),
        "long" => format!("{} {}", n(sw * 7.0), n(sw * 3.0)),
        k => k.to_string(),
    }
}

fn line_markup(o: &Value) -> String {
    let sw = opt_f(o, "strokeWidth").unwrap_or(2.0);
    let color = Some(s(o, "stroke")).filter(|c| !c.is_empty()).unwrap_or("#2b3440");
    let hs = head_size(sw, opt_f(o, "headScale").filter(|v| *v != 0.0).unwrap_or(1.0));
    let [cx, cy] = ctrl_pt(o);
    let curved = f(o, "curve").abs() > 0.01;
    let dir = |ax: f64, ay: f64, bx: f64, by: f64| {
        let l = { let v = (bx - ax).hypot(by - ay); if v != 0.0 { v } else { 1.0 } };
        [(bx - ax) / l, (by - ay) / l]
    };
    let (x1, y1, x2, y2) = (f(o, "x1"), f(o, "y1"), f(o, "x2"), f(o, "y2"));
    // tangent directions pointing *into* each end
    let d_end = if curved { dir(cx, cy, x2, y2) } else { dir(x1, y1, x2, y2) };
    let d_start = if curved { dir(cx, cy, x1, y1) } else { dir(x2, y2, x1, y1) };
    let (sh, eh) = (s(o, "startHead"), s(o, "endHead"));
    let (ts, te) = (hs * trim(sh), hs * trim(eh));
    let (sx, sy) = (x1 - d_start[0] * ts, y1 - d_start[1] * ts);
    let (ex, ey) = (x2 - d_end[0] * te, y2 - d_end[1] * te);
    let d = if curved { format!("M{} {}Q{} {} {} {}", n(sx), n(sy), n(cx), n(cy), n(ex), n(ey)) } else { format!("M{} {}L{} {}", n(sx), n(sy), n(ex), n(ey)) };
    let dash = s(o, "dash");
    let mut out = format!(
        "<path d=\"{d}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"{}\" stroke-linecap=\"{}\"{}/>",
        n(sw),
        if dash.is_empty() { "round" } else { "butt" },
        if dash.is_empty() { String::new() } else { format!(" stroke-dasharray=\"{}\"", dash_array(dash, sw)) }
    );
    out += &head(eh, [x2, y2], d_end, hs, color, sw);
    out += &head(sh, [x1, y1], d_start, hs, color, sw);
    out
}

fn text_markup(o: &Value) -> String {
    let fs = f(o, "fontSize");
    let lh = fs * opt_f(o, "lineHeight").filter(|v| *v != 0.0).unwrap_or(1.25);
    let align = s(o, "align");
    let anchor = match align { "center" => "middle", "right" => "end", _ => "start" };
    let w = f(o, "w");
    let x = match align { "center" => w / 2.0, "right" => w - 1.0, _ => 1.0 };
    let text = match o.get("text") {
        Some(Value::String(t)) => t.clone(),
        None | Some(Value::Null) => String::new(),
        Some(v) => v.to_string(),
    };
    let fam = Some(s(o, "fontFamily")).filter(|v| !v.is_empty()).unwrap_or("Arial");
    let color = Some(s(o, "color")).filter(|v| !v.is_empty()).unwrap_or("#1c2733");
    let mut out = format!(
        "<text font-family=\"{}\" font-size=\"{}\" font-weight=\"{}\" font-style=\"{}\" fill=\"{color}\" text-anchor=\"{anchor}\" xml:space=\"preserve\" style=\"white-space:pre\">",
        esc(fam), n(fs), if truthy(o, "bold") { 700 } else { 400 }, if truthy(o, "italic") { "italic" } else { "normal" }
    );
    for (i, ln) in text.split('\n').enumerate() {
        let e = esc(ln);
        out += &format!("<tspan x=\"{}\" y=\"{}\">{}</tspan>", n(x), n(i as f64 * lh + (lh - fs) / 2.0 + fs * 0.88), if e.is_empty() { " ".into() } else { e });
    }
    out + "</text>"
}

/// Draws a document's objects exactly as the app's render.js does.
pub struct Painter<'a> {
    doc: &'a Value,
    opt: usvg::Options<'static>,
}

impl<'a> Painter<'a> {
    pub fn new(doc: &'a Value, r: &Renderer) -> Self {
        Painter { doc, opt: r.options() }
    }

    fn asset(&self, id: &str) -> Option<&'a Value> {
        self.doc.get("assets").and_then(|a| a.get(id)).filter(|a| a.is_object())
    }

    /// viewBox and inner markup an icon draws: labels hidden or detached (`iconParts`).
    fn icon_parts(&self, o: &Value, asset: &'a Value) -> ([f64; 4], String) {
        let (vb, inner) = asset_parts(asset);
        let mode = s(o, "labels");
        if mode.is_empty() || !labels::has_labels(s(asset, "svg")) {
            return (vb, inner.to_string());
        }
        let li = labels::info(s(o, "asset"), s(asset, "svg"), &self.opt);
        match (mode, &li.hidden_inner, &li.textless_inner) {
            ("hidden", Some(h), _) => (li.hidden_vb, h.clone()),
            ("detached", _, Some(t)) => (vb, t.clone()),
            _ => (vb, inner.to_string()),
        }
    }

    fn content(&self, o: &Value) -> String {
        let rel;
        let o = if is_box(o) {
            o
        } else {
            rel = rel_copy(o);
            &rel
        };
        match ty(o) {
            "icon" => {
                let Some(asset) = self.asset(s(o, "asset")) else {
                    return format!("<rect width=\"{}\" height=\"{}\" fill=\"#f3d6d6\" stroke=\"#c0392b\"/>", n(f(o, "w")), n(f(o, "h")));
                };
                let (vb, inner) = self.icon_parts(o, asset);
                let inner = icon_inner(&inner, o.get("colors").and_then(|c| c.as_object()), &format!("{}-", s(o, "id")));
                format!("<g transform=\"translate({} {})\">{}</g>", n(-vb[0]), n(-vb[1]), inner)
            }
            "text" => text_markup(o),
            "rect" | "ellipse" => {
                let stroke = s(o, "stroke");
                let sw = if !stroke.is_empty() && stroke != "none" { opt_f(o, "strokeWidth").unwrap_or(1.5) } else { 0.0 };
                let (w, h) = (f(o, "w"), f(o, "h"));
                let fill = Some(s(o, "fill")).filter(|v| !v.is_empty()).unwrap_or("none");
                let mut a = String::new();
                if sw != 0.0 && !sw.is_nan() {
                    a += &format!(" stroke=\"{stroke}\" stroke-width=\"{}\"", n(sw));
                    if truthy(o, "dash") {
                        a += &format!(" stroke-dasharray=\"{}\"", dash_array(s(o, "dash"), sw));
                    }
                }
                if ty(o) == "rect" {
                    let r = f(o, "radius").min(w / 2.0).min(h / 2.0);
                    format!("<rect width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{fill}\"{a}/>", n(w), n(h), n(r))
                } else {
                    format!("<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"{fill}\"{a}/>", n(w / 2.0), n(h / 2.0), n(w / 2.0), n(h / 2.0))
                }
            }
            "image" => format!("<image width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" xlink:href=\"{}\"/>", n(f(o, "w")), n(f(o, "h")), s(o, "src")),
            "line" => line_markup(o),
            "membrane" => {
                let tile = (brush::kind(o) == "icon")
                    .then(|| self.asset(s(o, "asset")).filter(|_| truthy(o, "asset")))
                    .flatten()
                    .map(|asset| {
                        let (vb, inner) = asset_parts(asset);
                        let prefix = format!("{}-", s(o, "id"));
                        brush::IconTile { vb, inner: icon_inner(inner, o.get("colors").and_then(|c| c.as_object()), &prefix), prefix }
                    });
                brush::markup(o, tile.as_ref())
            }
            "group" => children(o).iter().map(|c| self.object(c)).collect(),
            _ => String::new(),
        }
    }

    /// Transform attribute (box objects also map an icon's viewBox onto w × h).
    fn transform(&self, o: &Value) -> String {
        if !is_box(o) {
            let [ox, oy] = obj_origin(o);
            return if ox != 0.0 || oy != 0.0 { format!("translate({} {})", n(ox), n(oy)) } else { String::new() };
        }
        let (w, h) = (f(o, "w"), f(o, "h"));
        let (cx, cy) = (f(o, "x") + w / 2.0, f(o, "y") + h / 2.0);
        let mut t = format!("translate({} {})", n(cx), n(cy));
        if truthy(o, "rot") {
            t += &format!(" rotate({})", n(f(o, "rot")));
        }
        let (fx, fy) = (truthy(o, "flipX"), truthy(o, "flipY"));
        if fx || fy {
            t += &format!(" scale({} {})", if fx { -1 } else { 1 }, if fy { -1 } else { 1 });
        }
        t += &format!(" translate({} {})", n(-w / 2.0), n(-h / 2.0));
        if ty(o) == "icon" {
            if let Some(asset) = self.asset(s(o, "asset")) {
                let (vb, _) = self.icon_parts(o, asset);
                t += &format!(" scale({} {})", n(w / vb[2]), n(h / vb[3]));
            }
        }
        t
    }

    /// Bounds of what an object really draws. `bbox` pads brushes on both sides as the app's
    /// selection does, though cells grow on one side only, so brushes are measured.
    pub fn drawn_bbox(&self, o: &Value) -> BBox {
        match ty(o) {
            "group" => union(&children(o).iter().map(|c| self.drawn_bbox(c)).collect::<Vec<_>>()),
            "membrane" => {
                let svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"10\" height=\"10\">{}</svg>", self.object(o));
                usvg::Tree::from_str(&svg, &self.opt)
                    .ok()
                    .filter(|t| t.root().has_children())
                    .map(|t| {
                        let r = t.root().abs_stroke_bounding_box();
                        BBox { x: r.x() as f64, y: r.y() as f64, w: r.width() as f64, h: r.height() as f64 }
                    })
                    .unwrap_or_else(|| bbox(o))
            }
            _ => bbox(o),
        }
    }

    pub fn object(&self, o: &Value) -> String {
        if truthy(o, "hidden") {
            return String::new();
        }
        let t = self.transform(o);
        let op = match opt_f(o, "opacity") {
            Some(v) if v < 1.0 => format!(" opacity=\"{}\"", n(v)),
            _ => String::new(),
        };
        format!("<g{}{op}>{}</g>", if t.is_empty() { String::new() } else { format!(" transform=\"{t}\"") }, self.content(o))
    }

    /// The whole figure as a standalone, mm-sized SVG (`documentSvg`).
    pub fn document(&self, background: Option<&str>) -> String {
        let (w, h) = (f(self.doc, "width") * MM, f(self.doc, "height") * MM);
        let mut out = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{}mm\" height=\"{}mm\" viewBox=\"0 0 {} {}\">",
            n(w / MM), n(h / MM), n(w), n(h)
        );
        out += "<title>BioCraft figure</title>";
        if let Some(bg) = background.filter(|b| !b.is_empty()) {
            out += &format!("<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"{bg}\"/>", n(w), n(h));
        }
        for o in self.doc.get("objects").and_then(|v| v.as_array()).into_iter().flatten() {
            out += &self.object(o);
        }
        out + "</svg>"
    }
}

/// The document's own background (null = transparent).
pub fn background(doc: &Value) -> Option<&str> {
    doc.get("background").and_then(|b| b.as_str()).filter(|b| !b.is_empty())
}

/// Export bytes like the app's export dialog: raster formats over the background (white when
/// the figure has none) or, `transparent`, with none at all; PDF/SVG with the figure's own.
pub fn export(doc: &Value, r: &Renderer, format: &str, dpi: f32, transparent: bool) -> Result<Vec<u8>> {
    let p = Painter::new(doc, r);
    match format {
        "svg" => Ok(p.document(background(doc)).into_bytes()),
        "pdf" => {
            let tree = svgclean::parse(p.document(background(doc)).as_bytes(), &r.options())?;
            to_pdf(&tree)
        }
        "png" | "tiff" => {
            let bg = if transparent { None } else { Some(background(doc).unwrap_or("#ffffff")) };
            let tree = svgclean::parse(p.document(bg).as_bytes(), &r.options())?;
            let pm = r.render_scaled(&tree, dpi / 96.0, bg.and_then(Rgb::parse))?;
            if format == "png" { encode_png(&pm, Some(dpi)) } else { encode_tiff(&pm, dpi) }
        }
        f => bail!("unknown export format '{f}' (use png, tiff, pdf or svg)"),
    }
}

/// A PNG preview whose longer side is about `max_px` pixels.
pub fn preview(doc: &Value, r: &Renderer, max_px: f64) -> Result<Vec<u8>> {
    let longest = (f(doc, "width")).max(f(doc, "height")) * MM;
    let dpi = (96.0 * max_px / longest.max(1.0)).clamp(24.0, 600.0);
    export(doc, r, "png", dpi as f32, false)
}

/* ---------- credits (panels.js legendText) ---------- */

/// Every icon asset id an object tree uses, in drawing order (`assetsUsed`).
pub fn assets_used(objs: &[Value], out: &mut Vec<String>) {
    for o in objs {
        let a = s(o, "asset");
        if (ty(o) == "icon" || (ty(o) == "membrane" && s(o, "brush") == "icon" && !a.is_empty())) && !out.iter().any(|x| x == a) {
            out.push(a.to_string());
        }
        assets_used(children(o), out);
    }
}

/// The figure-legend credit line, word for word as the app's Credits tab writes it.
pub fn legend_text(doc: &Value) -> String {
    crate::licence::legend(doc)
}

/// Licences used, with what each asks of the author.
pub fn licences(doc: &Value) -> Vec<Value> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for i in crate::licence::facts(doc).icons {
        let l = s(i.meta, "license").to_string();
        let name = s(i.meta, "name").to_string();
        match out.iter_mut().find(|x| x.0 == l) {
            Some(x) => {
                if !x.1.contains(&name) {
                    x.1.push(name)
                }
            }
            None => out.push((l, vec![name])),
        }
    }
    out.into_iter()
        .map(|(l, icons)| {
            let (display, attribution, url) = biocanvas_core::license_info(&l);
            json!({ "license": l, "name": display, "attribution_required": attribution, "url": url, "icons": icons })
        })
        .collect()
}

/* ---------- reviewing a document ---------- */

/// An object as the figure spec calls it: `text "IL-6"`, `icon "Macrophage"`, `arrow`.
fn describe(o: &Value) -> String {
    let name = s(o, "name");
    let t = match ty(o) {
        "text" => return format!("text \"{}\"", s(o, "text").replace('\n', " ").chars().take(30).collect::<String>()),
        "membrane" => "brush",
        "line" => match s(o, "endHead") {
            "arrow" | "open" => "arrow",
            "bar" => "inhibit",
            _ => "line",
        },
        t => t,
    };
    if name.is_empty() { t.to_string() } else { format!("{t} \"{name}\"") }
}

/// Layout problems an author would want to know about: things off the page, overlapping or
/// tiny text, icons too small to read, missing icon data.
pub fn review(doc: &Value, r: &Renderer) -> Vec<String> {
    let mut w = Vec::new();
    let (pw, ph) = (f(doc, "width") * MM, f(doc, "height") * MM);
    let objs = doc.get("objects").and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[]);
    let painter = Painter::new(doc, r);
    for (i, o) in objs.iter().enumerate() {
        if truthy(o, "hidden") {
            continue;
        }
        let b = painter.drawn_bbox(o);
        let path = format!("objects[{i}] ({})", describe(o));
        if !(b.w.is_finite() && b.h.is_finite()) {
            continue;
        }
        if b.x >= pw || b.y >= ph || b.x + b.w <= 0.0 || b.y + b.h <= 0.0 {
            w.push(format!("{path} is entirely outside the {:.0} × {:.0} mm page", pw / MM, ph / MM));
            continue;
        }
        let over = [(-b.x, "left"), (b.x + b.w - pw, "right"), (-b.y, "top"), (b.y + b.h - ph, "bottom")];
        let sides: Vec<String> = over.iter().filter(|(d, _)| *d > 0.5 * MM).map(|(d, side)| format!("{:.1} mm past the {side} edge", d / MM)).collect();
        if !sides.is_empty() {
            w.push(format!("{path} extends {}", sides.join(" and ")));
        }
    }
    // walk every object (groups too) for per-object checks
    let mut texts: Vec<(String, BBox)> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();
    fn walk(objs: &[Value], base: &str, doc: &Value, w: &mut Vec<String>, texts: &mut Vec<(String, BBox)>, unknown: &mut Vec<String>) {
        for (i, o) in objs.iter().enumerate() {
            let path = format!("{base}[{i}] ({})", describe(o));
            match ty(o) {
                "text" => {
                    let pt = f(o, "fontSize") * 0.75;
                    if pt < 5.0 {
                        w.push(format!("{path} is {pt:.1} pt; journals ask for at least 5–6 pt at final size"));
                    }
                    texts.push((path, bbox(o)));
                }
                "icon" => {
                    if doc.get("assets").and_then(|a| a.get(s(o, "asset"))).is_none() {
                        w.push(format!("{path}: icon '{}' is not in the figure (drawn as a red box)", s(o, "asset")));
                    } else if f(o, "w").min(f(o, "h")) < 2.0 * MM {
                        w.push(format!("{path} is only {:.1} × {:.1} mm and will be hard to read", f(o, "w") / MM, f(o, "h") / MM));
                    }
                }
                "line" => {
                    let len = (f(o, "x2") - f(o, "x1")).hypot(f(o, "y2") - f(o, "y1"));
                    if len < MM {
                        w.push(format!("{path} is shorter than 1 mm"));
                    }
                }
                "group" => walk(children(o), &format!("{base}[{i}].objects"), doc, w, texts, unknown),
                "rect" | "ellipse" | "membrane" | "image" => {}
                t => {
                    if !unknown.iter().any(|u| u == t) {
                        unknown.push(t.to_string());
                    }
                }
            }
        }
    }
    walk(objs, "objects", doc, &mut w, &mut texts, &mut unknown);
    for i in 0..texts.len() {
        for j in i + 1..texts.len() {
            let (a, b) = (texts[i].1, texts[j].1);
            let ix = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
            let iy = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
            if ix > 0.0 && iy > 0.0 && ix * iy > 0.1 * (a.w * a.h).min(b.w * b.h) {
                w.push(format!("{} and {} overlap", texts[i].0, texts[j].0));
            }
        }
    }
    for t in unknown {
        w.push(format!("objects of type '{t}' are not drawn by this renderer (open the figure in BioCraft to see them)"));
    }
    w
}

/* ---------- figure spec → document ---------- */

/// A composed figure: the document the app saves, plus advice for the author.
pub struct Composed {
    pub doc: Value,
    pub warnings: Vec<String>,
}

/// Is this JSON a saved BioCraft document (rather than a figure spec)? Only files the app or
/// render_figure saved count: a spec that says "width" instead of "width_mm" stays a spec, so
/// validation can say what to fix.
pub fn is_document(v: &Value) -> bool {
    let saved = matches!(v.get("app").and_then(|a| a.as_str()), Some("BioCraft" | "BioCanvas")) || v.get("assets").is_some_and(|a| a.is_object());
    saved && v.get("objects").is_some_and(|o| o.is_array()) && v.get("width").is_some_and(|w| w.is_number()) && v.get("width_mm").is_none()
}

/// A saved document must not carry figure-spec objects: the app could not draw them. (Object
/// types this renderer does not know may be newer app objects, so they pass.)
pub fn check_document(doc: &Value) -> Result<()> {
    fn walk(objs: &[Value], base: &str, bad: &mut Vec<String>) {
        for (i, o) in objs.iter().enumerate() {
            let path = format!("{base}[{i}]");
            let point = |k: &str| o.get(k).and_then(|v| v.as_array()).is_some_and(|a| a.len() == 2 && a.iter().all(|x| x.is_number()));
            let spec_field = |keys: &[&str]| keys.iter().find(|k| o.get(**k).is_some()).map(|k| format!("the spec field \"{k}\""));
            let why = match ty(o) {
                "arrow" | "inhibit" | "line" if point("from") || point("to") => Some("\"from\"/\"to\" points".to_string()),
                "brush" if o.get("pattern").is_some() || o.get("points").is_some() => Some("\"pattern\"/\"points\"".to_string()),
                "text" => spec_field(&["size_pt", "font"]).or_else(|| o.get("fontSize").is_none().then(|| "no \"fontSize\"".into())),
                "icon" => o.get("asset").is_none().then(|| "no \"asset\"".into()),
                "rect" | "ellipse" => spec_field(&["cx", "cy", "stroke_pt", "radius_mm"]),
                "line" => spec_field(&["width_pt", "curve_mm"]),
                "membrane" => spec_field(&["points", "pattern", "thickness_mm"]),
                "group" => spec_field(&["objects"]),
                _ => None,
            };
            if let Some(w) = why {
                bad.push(format!("{path} ({}) has {w}", ty(o)));
            }
            walk(children(o), &format!("{path}.children"), bad);
        }
    }
    let mut bad = Vec::new();
    walk(doc.get("objects").and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[]), "objects", &mut bad);
    if !bad.is_empty() {
        bail!(
            "this looks like a saved BioCraft document (it has \"app\"/\"assets\") but mixes in figure-spec objects: {}. \
Give either a figure spec (\"width_mm\", \"height_mm\", objects with from/to, size_pt …; no \"app\" or \"assets\") or a .biocraft file saved by BioCraft.",
            bad.join("; ")
        );
    }
    Ok(())
}

const TYPES: [&str; 9] = ["icon", "text", "arrow", "inhibit", "line", "rect", "ellipse", "brush", "group"];
const COMMON: [&str; 3] = ["type", "name", "opacity"];
const SYNONYMS: &[(&str, &str)] = &[
    ("colour", "color"), ("colours", "colors"), ("fill_color", "fill"), ("stroke_color", "stroke"), ("size", "size_pt"),
    ("font_size", "size_pt"), ("fontsize", "size_pt"), ("rotation", "rotate"), ("angle", "rotate"), ("rot", "rotate"),
    ("label", "text"), ("icon_id", "id"), ("icon", "id"), ("width", "w"), ("height", "h"), ("start", "from"), ("end", "to"),
    ("arrowhead", "head"), ("end_head", "head"), ("start_head", "tail"), ("thickness", "thickness_mm"), ("radius", "radius_mm"),
    ("curve", "curve_mm"), ("stroke_width", "stroke_pt"), ("line_width", "width_pt"), ("stroke_width_pt", "stroke_pt"),
    ("pts", "points"), ("children", "objects"), ("kind", "type"), ("brush", "pattern"), ("font_family", "font"),
    ("anchor", "align"), ("text_align", "align"), ("slots", "colors"), ("greyscale", "grayscale"), ("gray", "grayscale"),
    ("mirror", "flip"), ("width_pt", "stroke_pt"), ("x_mm", "x"), ("y_mm", "y"), ("w_mm", "w"), ("h_mm", "h"),
    ("width", "width_mm"), ("height", "height_mm"), ("bg", "background"), ("items", "objects"), ("shapes", "objects"),
];

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = cur;
    }
    prev[b.len()]
}

fn did_you_mean(k: &str, allowed: &[&str]) -> String {
    let lk = k.to_lowercase();
    let hit = SYNONYMS.iter().filter(|(from, _)| *from == lk).map(|(_, to)| *to).find(|to| allowed.contains(to)).or_else(|| {
        allowed.iter().copied().map(|a| (edit_distance(&lk, a), a)).filter(|(d, a)| *d <= 2 && *d < a.len()).min_by_key(|x| x.0).map(|x| x.1)
    });
    match hit {
        Some(h) => format!(" — did you mean \"{h}\"?"),
        None => String::new(),
    }
}

fn quote(v: &Value) -> String {
    let t = v.to_string();
    if t.len() > 40 { format!("{}…", &t[..t.char_indices().take(40).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(0)]) } else { t }
}

struct Composer<'a> {
    st: &'a AppState,
    errors: Vec<String>,
    warnings: Vec<String>,
    assets: Map<String, Value>,
    missing: HashSet<String>,
    seq: usize,
}

impl<'a> Composer<'a> {
    fn err(&mut self, path: &str, msg: impl std::fmt::Display) {
        self.errors.push(format!("{path}: {msg}"));
    }

    fn id(&mut self) -> String {
        self.seq += 1;
        format!("a{}", self.seq)
    }

    fn keys(&mut self, o: &Value, path: &str, allowed: &[&str]) {
        let Some(m) = o.as_object() else { return };
        for k in m.keys() {
            if k.starts_with('_') || k.starts_with('$') || k == "comment" || allowed.contains(&k.as_str()) {
                continue;
            }
            let msg = format!("unknown field \"{k}\"{} (allowed: {})", did_you_mean(k, allowed), allowed.join(", "));
            self.err(path, msg);
        }
    }

    fn num(&mut self, o: &Value, path: &str, k: &str) -> Option<f64> {
        match o.get(k) {
            None | Some(Value::Null) => None,
            Some(v) => match v.as_f64().filter(|x| x.is_finite()) {
                Some(x) => Some(x),
                None => {
                    self.err(path, format!("\"{k}\" must be a number (millimetres unless the name says otherwise), got {}", quote(v)));
                    None
                }
            },
        }
    }

    fn req_num(&mut self, o: &Value, path: &str, k: &str) -> Option<f64> {
        if o.get(k).is_none_or(|v| v.is_null()) {
            self.err(path, format!("\"{k}\" is required"));
            return None;
        }
        self.num(o, path, k)
    }

    fn positive(&mut self, o: &Value, path: &str, k: &str) -> Option<f64> {
        let v = self.num(o, path, k)?;
        if v <= 0.0 {
            self.err(path, format!("\"{k}\" must be greater than 0, got {v}"));
            return None;
        }
        Some(v)
    }

    fn string(&mut self, o: &Value, path: &str, k: &str) -> Option<String> {
        match o.get(k) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(v) => {
                self.err(path, format!("\"{k}\" must be a string, got {}", quote(v)));
                None
            }
        }
    }

    fn boolean(&mut self, o: &Value, path: &str, k: &str) -> Option<bool> {
        match o.get(k) {
            None | Some(Value::Null) => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(v) => {
                self.err(path, format!("\"{k}\" must be true or false, got {}", quote(v)));
                None
            }
        }
    }

    fn choice(&mut self, o: &Value, path: &str, k: &str, options: &[&str]) -> Option<String> {
        let v = self.string(o, path, k)?;
        if options.contains(&v.as_str()) {
            return Some(v);
        }
        let msg = format!("\"{k}\" must be one of {}, got \"{v}\"{}", options.iter().map(|x| format!("\"{x}\"")).collect::<Vec<_>>().join(", "), did_you_mean(&v, options));
        self.err(path, msg);
        None
    }

    /// A colour field: Some(None) for null/"none"/"transparent" where `none_ok`.
    fn color(&mut self, o: &Value, path: &str, k: &str, none_ok: bool) -> Option<Option<String>> {
        match o.get(k)? {
            Value::Null if none_ok => Some(None),
            Value::String(s) if none_ok && (s == "none" || s == "transparent") => Some(None),
            Value::String(s) if norm_hex(s).is_some() && (s.starts_with('#') || s.len() == 6) => Some(norm_hex(s)),
            v => {
                self.err(path, format!("\"{k}\" must be a hex colour like \"#0072b2\"{}, got {}", if none_ok { " (or \"none\")" } else { "" }, quote(v)));
                None
            }
        }
    }

    fn point(&mut self, v: Option<&Value>, path: &str, what: &str) -> Option<[f64; 2]> {
        let p = v.and_then(|v| v.as_array()).filter(|a| a.len() == 2).and_then(|a| Some([a[0].as_f64()?, a[1].as_f64()?]));
        if p.is_none() {
            self.err(path, format!("{what} must be a point [x, y] in millimetres, got {}", v.map(quote).unwrap_or_else(|| "nothing".into())));
        }
        p
    }

    /// Load an icon into the figure's assets (once), as the app's loadAsset() does.
    fn asset(&mut self, id: &str, path: &str) -> Option<Value> {
        if let Some(a) = self.assets.get(id) {
            return Some(a.clone());
        }
        if self.missing.contains(id) {
            return None;
        }
        let lib = self.st.lib.read().unwrap();
        match lib.icon(id) {
            Ok(data) => {
                let a = asset_from_library(&data);
                drop(lib);
                self.assets.insert(id.to_string(), a.clone());
                Some(a)
            }
            Err(_) => {
                let ids: Vec<String> = suggest_ids(&lib, id).into_iter().map(|s| format!("\"{s}\"")).collect();
                drop(lib);
                self.missing.insert(id.to_string());
                self.warnings.push(format!(
                    "{path}: unknown icon id \"{id}\" — drawn as a red placeholder box. {}Use search_icons to find real ids.",
                    if ids.is_empty() { String::new() } else { format!("Close matches: {}. ", ids.join(", ")) }
                ));
                None
            }
        }
    }

    /// Per-slot colours: ["#hex" | null, …] or {"<slot index>": "#hex"}.
    fn slot_targets(&mut self, v: &Value, path: &str, slots: usize) -> Option<Vec<Option<String>>> {
        let mut out: Vec<Option<String>> = Vec::new();
        let mut put = |c: &mut Self, i: usize, x: &Value| {
            if i >= slots {
                c.err(path, format!("colour slot {i} does not exist — this icon has {slots} slot{} (get_icon lists them, index 0 first)", if slots == 1 { "" } else { "s" }));
                return;
            }
            let hex = match x {
                Value::Null => None,
                Value::String(s) if norm_hex(s).is_some() => norm_hex(s),
                _ => {
                    c.err(path, format!("colour for slot {i} must be a hex colour like \"#d55e00\" or null, got {}", quote(x)));
                    return;
                }
            };
            if out.len() <= i {
                out.resize(i + 1, None);
            }
            out[i] = hex;
        };
        match v {
            Value::Array(a) => a.iter().enumerate().for_each(|(i, x)| put(self, i, x)),
            Value::Object(m) => {
                for (k, x) in m {
                    match k.parse::<usize>() {
                        Ok(i) => put(self, i, x),
                        Err(_) => self.err(path, format!("\"colors\" keys must be slot indexes like \"0\", got \"{k}\"")),
                    }
                }
            }
            _ => {
                self.err(path, format!("\"colors\" must be a list like [\"#0072b2\", null] or an object like {{\"0\": \"#0072b2\"}}, got {}", quote(v)));
                return None;
            }
        }
        Some(out)
    }

    /// Top-left of a box: x (left edge) or cx (centre), and y (top edge) or cy (centre).
    fn place(&mut self, o: &Value, path: &str, w: f64, h: f64) -> Option<(f64, f64)> {
        let x = self.axis(o, path, "x", "cx", w);
        let y = self.axis(o, path, "y", "cy", h);
        Some((x?, y?))
    }

    fn axis(&mut self, o: &Value, path: &str, edge: &str, centre: &str, size: f64) -> Option<f64> {
        let has = |k: &str| o.get(k).is_some_and(|v| !v.is_null());
        match (has(edge), has(centre)) {
            (true, true) => {
                self.err(path, format!("give \"{edge}\" (edge) or \"{centre}\" (centre), not both"));
                None
            }
            (false, true) => Some(self.num(o, path, centre)? * MM - size / 2.0),
            (true, false) => Some(self.num(o, path, edge)? * MM),
            (false, false) => {
                self.err(path, format!("\"{edge}\" or \"{centre}\" is required"));
                None
            }
        }
    }

    fn common(&mut self, o: &Value, path: &str, out: &mut Value) {
        if let Some(name) = self.string(o, path, "name") {
            out["name"] = json!(name);
        }
        if let Some(op) = self.num(o, path, "opacity") {
            if !(0.0..=1.0).contains(&op) {
                self.err(path, format!("\"opacity\" must be between 0 and 1, got {op}"));
            } else if op < 1.0 {
                out["opacity"] = json!(op);
            }
        }
    }

    fn object(&mut self, o: &Value, path: &str) -> Option<Value> {
        if !o.is_object() {
            self.err(path, format!("each object must be a JSON object like {{\"type\": \"icon\", …}}, got {}", quote(o)));
            return None;
        }
        let t = match o.get("type").and_then(|t| t.as_str()) {
            Some(t) if TYPES.contains(&t) => t.to_string(),
            Some(t) => {
                let msg = format!("unknown type \"{t}\"{} — use one of {}", did_you_mean(t, &TYPES), TYPES.join(", "));
                self.err(path, msg);
                return None;
            }
            None => {
                self.err(path, format!("\"type\" is required: one of {}", TYPES.join(", ")));
                return None;
            }
        };
        let path = format!("{path} ({t})");
        let mut out = match t.as_str() {
            "icon" => self.icon(o, &path),
            "text" => self.text(o, &path),
            "arrow" | "inhibit" | "line" => self.line(o, &path, &t),
            "rect" | "ellipse" => self.shape(o, &path, &t),
            "brush" => self.brush(o, &path),
            _ => self.group(o, &path),
        }?;
        self.common(o, &path, &mut out);
        Some(out)
    }

    fn icon(&mut self, o: &Value, path: &str) -> Option<Value> {
        let allowed = [&COMMON[..], &["id", "x", "y", "cx", "cy", "w", "h", "rotate", "flip", "colors", "tint", "grayscale", "labels"]].concat();
        self.keys(o, path, &allowed);
        let Some(id) = self.string(o, path, "id") else {
            self.err(path, "\"id\" is required: a library id from search_icons, e.g. \"servier/macrophage\"");
            return None;
        };
        let asset = self.asset(&id, path);
        let labels = self.choice(o, path, "labels", &["show", "hide"]);
        let hide = labels.as_deref() == Some("hide");
        // natural proportions: the drawing's viewBox, or what is left after hiding the labels
        let mut hidden = false;
        let (vw, vh) = match &asset {
            Some(a) => {
                let (vb, _) = asset_parts(a);
                let svg = s(a, "svg");
                if hide && labels::has_labels(svg) {
                    let li = labels::info(&id, svg, &self.st.renderer().options());
                    if li.hidden_inner.is_some() {
                        hidden = true;
                        (li.hidden_vb[2], li.hidden_vb[3])
                    } else {
                        (vb[2], vb[3])
                    }
                } else {
                    if hide {
                        self.warnings.push(format!("{path}: \"{id}\" has no text labels, so \"labels\": \"hide\" changes nothing"));
                    } else if labels.is_none() && labels::has_labels(svg) {
                        let li = labels::info(&id, svg, &self.st.renderer().options());
                        if !li.labels.is_empty() {
                            let shown: Vec<String> = li.labels.iter().take(4).map(|l| format!("\"{l}\"")).collect();
                            self.warnings.push(format!(
                                "{path}: \"{id}\" carries its own text labels ({}{}); add \"labels\": \"hide\" if you label it yourself",
                                shown.join(", "), if li.labels.len() > 4 { ", …" } else { "" }
                            ));
                        }
                    }
                    (vb[2], vb[3])
                }
            }
            None => (1.0, 1.0),
        };
        let ar = if vw > 0.0 && vh > 0.0 { vw / vh } else { 1.0 };
        let (w, h) = match (self.positive(o, path, "w"), self.positive(o, path, "h")) {
            (Some(_), Some(_)) => {
                self.err(path, "give \"w\" or \"h\", not both — the icon keeps its proportions");
                return None;
            }
            (Some(w), None) => (w * MM, w * MM / ar),
            (None, Some(h)) => (h * MM * ar, h * MM),
            (None, None) => (30.0 * MM, 30.0 * MM / ar),
        };
        let (x, y) = self.place(o, path, w, h)?;
        let rot = self.num(o, path, "rotate").unwrap_or(0.0);
        let flip = self.choice(o, path, "flip", &["h", "v", "hv", "none"]).unwrap_or_default();
        let name = asset.as_ref().map(|a| a["meta"]["name"].clone()).unwrap_or_else(|| json!(format!("Missing icon: {id}")));
        let mut out = json!({
            "id": self.id(), "type": "icon", "asset": id, "name": name,
            "x": x, "y": y, "w": w, "h": h, "rot": rot, "colors": {}, "slotColors": [],
        });
        if flip.contains('h') {
            out["flipX"] = json!(true);
        }
        if flip.contains('v') {
            out["flipY"] = json!(true);
        }
        if hidden {
            out["labels"] = json!("hidden");
        }
        // recolouring: per slot, one tint, or greyscale (one at a time, as in the app)
        let tint = self.color(o, path, "tint", false).flatten();
        let gray = self.boolean(o, path, "grayscale").unwrap_or(false);
        let colors = o.get("colors").filter(|v| !v.is_null());
        if [colors.is_some(), tint.is_some(), gray].iter().filter(|x| **x).count() > 1 {
            self.err(path, "use only one of \"colors\", \"tint\" and \"grayscale\"");
            return Some(out);
        }
        if let Some(a) = &asset {
            let slots: Vec<Value> = a["slots"].as_array().cloned().unwrap_or_default();
            if let Some(c) = colors {
                if let Some(t) = self.slot_targets(c, path, slots.len()) {
                    out["colors"] = Value::Object(slot_color_map(&slots, &t));
                    out["slotColors"] = json!(t);
                }
            } else if let Some(t) = tint {
                out["colors"] = Value::Object(tint_map(&slots, &t));
            } else if gray {
                out["colors"] = Value::Object(gray_map(&slots));
            }
        }
        Some(out)
    }

    fn text(&mut self, o: &Value, path: &str) -> Option<Value> {
        let allowed = [&COMMON[..], &["text", "x", "y", "size_pt", "color", "bold", "italic", "align", "font", "rotate", "line_height"]].concat();
        self.keys(o, path, &allowed);
        let text = self.string(o, path, "text");
        if text.as_deref().is_none_or(|t| t.trim().is_empty()) {
            self.err(path, "\"text\" is required (use \\n for line breaks)");
        }
        let (x, y) = (self.req_num(o, path, "x"), self.req_num(o, path, "y"));
        let size = self.positive(o, path, "size_pt").unwrap_or(8.0);
        let color = self.color(o, path, "color", false).flatten().unwrap_or_else(|| "#1c2733".into());
        let bold = self.boolean(o, path, "bold").unwrap_or(false);
        let italic = self.boolean(o, path, "italic").unwrap_or(false);
        let align = self.choice(o, path, "align", &["left", "center", "right"]).unwrap_or_else(|| "left".into());
        let font = self.string(o, path, "font").unwrap_or_else(|| "Arial".into());
        let rot = self.num(o, path, "rotate").unwrap_or(0.0);
        let lh = self.positive(o, path, "line_height");
        let (text, x, y) = (text?, x?, y?);
        let r = self.st.renderer();
        if !r.fontdb.faces().any(|f| f.families.iter().any(|(fam, _)| fam.eq_ignore_ascii_case(&font))) {
            self.warnings.push(format!("{path}: font \"{font}\" is not installed here; it will fall back to Arial"));
        }
        let fs = size / 0.75;
        let lines: Vec<&str> = text.split('\n').collect();
        let w = 4f64.max(measure(r, &lines, &font, fs, bold, italic) + 2.0);
        let h = 4f64.max(lines.len() as f64 * fs * lh.unwrap_or(1.25));
        // x/y anchor the top edge at its left, centre or right, where the glyphs start
        let left = match align.as_str() {
            "center" => x * MM - w / 2.0,
            "right" => x * MM - w + 1.0,
            _ => x * MM - 1.0,
        };
        let mut out = json!({
            "id": self.id(), "type": "text", "x": left, "y": y * MM, "w": w, "h": h, "rot": rot, "text": text,
            "fontSize": fs, "fontFamily": font, "color": color, "align": align, "bold": bold, "italic": italic,
        });
        if let Some(lh) = lh {
            out["lineHeight"] = json!(lh);
        }
        Some(out)
    }

    fn line(&mut self, o: &Value, path: &str, t: &str) -> Option<Value> {
        let allowed = [&COMMON[..], &["from", "to", "curve_mm", "head", "tail", "color", "width_pt", "dash", "head_scale"]].concat();
        self.keys(o, path, &allowed);
        let from = self.point(o.get("from"), path, "\"from\"");
        let to = self.point(o.get("to"), path, "\"to\"");
        let curve = self.num(o, path, "curve_mm").unwrap_or(0.0);
        let default_head = match t { "arrow" => "arrow", "inhibit" => "bar", _ => "none" };
        let end = self.choice(o, path, "head", &HEADS).unwrap_or_else(|| default_head.into());
        let start = self.choice(o, path, "tail", &HEADS).unwrap_or_else(|| "none".into());
        let color = self.color(o, path, "color", false).flatten().unwrap_or_else(|| "#2b3440".into());
        let width = self.positive(o, path, "width_pt").unwrap_or(1.5);
        let dash = self.dash(o, path);
        let hs = self.positive(o, path, "head_scale");
        let (from, to) = (from?, to?);
        let mut out = json!({
            "id": self.id(), "type": "line", "x1": from[0] * MM, "y1": from[1] * MM, "x2": to[0] * MM, "y2": to[1] * MM,
            "stroke": color, "strokeWidth": width / 0.75, "curve": curve * MM, "startHead": start, "endHead": end, "dash": dash,
        });
        if let Some(hs) = hs {
            out["headScale"] = json!(hs);
        }
        Some(out)
    }

    fn dash(&mut self, o: &Value, path: &str) -> String {
        match o.get("dash") {
            None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
            _ => self.choice(o, path, "dash", &["dash", "dot", "long"]).unwrap_or_default(),
        }
    }

    fn shape(&mut self, o: &Value, path: &str, t: &str) -> Option<Value> {
        let mut allowed = [&COMMON[..], &["x", "y", "cx", "cy", "w", "h", "fill", "stroke", "stroke_pt", "dash", "rotate"]].concat();
        if t == "rect" {
            allowed.push("radius_mm");
        }
        self.keys(o, path, &allowed);
        let (w, h) = (self.positive(o, path, "w"), self.positive(o, path, "h"));
        if o.get("w").is_none() || o.get("h").is_none() {
            self.err(path, "\"w\" and \"h\" (millimetres) are required");
        }
        let (dfill, dstroke) = if t == "rect" { ("#d9ecf7", "#1d6fa5") } else { ("#fde7c8", "#c76b1f") };
        let fill = self.color(o, path, "fill", true).map(|c| c.unwrap_or_else(|| "none".into())).unwrap_or_else(|| dfill.into());
        let stroke = self.color(o, path, "stroke", true).map(|c| c.unwrap_or_else(|| "none".into())).unwrap_or_else(|| dstroke.into());
        let sw = self.positive(o, path, "stroke_pt").map(|v| v / 0.75).unwrap_or(1.5);
        let radius = self.num(o, path, "radius_mm").unwrap_or(0.0);
        let dash = self.dash(o, path);
        let rot = self.num(o, path, "rotate").unwrap_or(0.0);
        let (w, h) = (w? * MM, h? * MM);
        let (x, y) = self.place(o, path, w, h)?;
        let mut out = json!({ "id": self.id(), "type": t, "x": x, "y": y, "w": w, "h": h, "rot": rot, "fill": fill, "stroke": stroke, "strokeWidth": sw });
        if t == "rect" {
            out["radius"] = json!(radius * MM);
        }
        if !dash.is_empty() {
            out["dash"] = json!(dash);
        }
        Some(out)
    }

    fn brush(&mut self, o: &Value, path: &str) -> Option<Value> {
        let allowed = [&COMMON[..], &["pattern", "points", "closed", "thickness_mm", "icon", "colors", "side", "apical", "spacing", "seed", "jitter", "follow", "fill", "basement"]].concat();
        self.keys(o, path, &allowed);
        let kinds: Vec<&str> = brush::BRUSHES.iter().map(|d| d.key).collect();
        let Some(kind) = self.choice(o, path, "pattern", &kinds) else {
            if o.get("pattern").is_none() {
                self.err(path, format!("\"pattern\" is required: one of {}", kinds.join(", ")));
            }
            return None;
        };
        let def = brush::def(&kind).unwrap();
        let closed = self.boolean(o, path, "closed").unwrap_or(false);
        let pts: Vec<[f64; 2]> = match o.get("points").and_then(|p| p.as_array()) {
            Some(a) => a.iter().enumerate().filter_map(|(i, p)| self.point(Some(p), path, &format!("points[{i}]"))).collect(),
            None => {
                self.err(path, "\"points\" is required: [[x, y], [x, y], …] in millimetres, at least 2 (3 for a closed loop)");
                return None;
            }
        };
        if pts.len() < if closed { 3 } else { 2 } {
            self.err(path, format!("\"points\" needs at least {} points{}", if closed { 3 } else { 2 }, if closed { " for a closed loop" } else { "" }));
            return None;
        }
        // the app's thickness slider range, in mm to one decimal
        let (lo, hi) = ((def.min / MM * 10.0).ceil() / 10.0, (def.max / MM * 10.0).floor() / 10.0);
        let thickness = match self.positive(o, path, "thickness_mm") {
            Some(t) if t < lo || t > hi => {
                self.err(path, format!("\"thickness_mm\" must be between {lo} and {hi} for the {kind} pattern, got {t}"));
                def.t
            }
            Some(t) => t * MM,
            None => def.t,
        };
        let mut out = json!({
            "id": self.id(), "type": "membrane", "brush": kind, "closed": closed, "thickness": thickness, "fill": "none",
            "pts": pts.iter().map(|p| json!([p[0] * MM, p[1] * MM])).collect::<Vec<_>>(),
            "name": def.name,
        });
        if let Some(fill) = self.color(o, path, "fill", true).flatten() {
            if !closed {
                self.warnings.push(format!("{path}: \"fill\" only shows on a closed brush (\"closed\": true)"));
            }
            out["fill"] = json!(fill);
        }
        let seed = self.num(o, path, "seed").map(|v| v.round()).unwrap_or((self.seq * 7919 % 999_983) as f64 + 1.0);
        out["seed"] = json!(seed);
        if let Some(side) = self.num(o, path, "side") {
            if side != 1.0 && side != -1.0 {
                self.err(path, "\"side\" must be 1 or -1");
            }
            out["side"] = json!(side);
        }
        if let Some(sp) = self.positive(o, path, "spacing") {
            if !def.spacing {
                self.warnings.push(format!("{path}: the {kind} pattern has no \"spacing\"; it is ignored"));
            } else if !(0.4..=2.5).contains(&sp) {
                self.err(path, format!("\"spacing\" must be between 0.4 and 2.5 (1 = normal), got {sp}"));
            }
            out["spacing"] = json!(sp);
        }
        if let Some(a) = self.choice(o, path, "apical", &["none", "microvilli", "cilia"]) {
            if (!def.cells || kind == "squamous") && a != "none" {
                self.warnings.push(format!("{path}: \"apical\" only applies to the cuboidal and columnar patterns; it is ignored here"));
            }
            out["apical"] = json!(a);
        }
        if let Some(b) = self.boolean(o, path, "basement") {
            out["basement"] = json!(b);
        }
        if let Some(j) = self.num(o, path, "jitter") {
            out["jitter"] = json!(j.clamp(0.0, 1.0));
        }
        if let Some(fl) = self.boolean(o, path, "follow") {
            out["follow"] = json!(fl);
        }
        let colors = o.get("colors").filter(|c| !c.is_null());
        match kind.as_str() {
            "icon" => {
                let Some(id) = self.string(o, path, "icon") else {
                    self.err(path, "\"icon\" is required for the icon pattern: the library id to repeat along the path");
                    return None;
                };
                let asset = self.asset(&id, path);
                let name = asset.as_ref().map(|a| format!("{} (brush)", s(&a["meta"], "name"))).unwrap_or_else(|| "Icon brush".into());
                out["asset"] = json!(id);
                out["name"] = json!(name);
                out["colors"] = json!({});
                out["slotColors"] = json!([]);
                if let (Some(a), Some(c)) = (asset, colors) {
                    let slots: Vec<Value> = a["slots"].as_array().cloned().unwrap_or_default();
                    if let Some(t) = self.slot_targets(c, path, slots.len()) {
                        out["colors"] = Value::Object(slot_color_map(&slots, &t));
                        out["slotColors"] = json!(t);
                    }
                }
            }
            "bilayer" => {
                out["headColor"] = json!("#f0a35c");
                out["tailColor"] = json!("#e9c88f");
                if let Some(c) = colors {
                    self.keys(c, &format!("{path} colors"), &["head", "tail"]);
                    if let Some(h) = self.color(c, path, "head", false).flatten() {
                        out["headColor"] = json!(h);
                    }
                    if let Some(t) = self.color(c, path, "tail", false).flatten() {
                        out["tailColor"] = json!(t);
                    }
                }
            }
            _ => {
                if let Some(c) = colors {
                    let keys: Vec<&str> = def.palette.iter().map(|p| p.0).collect();
                    self.keys(c, &format!("{path} colors"), &keys);
                    let mut pal = Map::new();
                    for k in keys {
                        if let Some(h) = self.color(c, path, k, false).flatten() {
                            pal.insert(k.to_string(), json!(h));
                        }
                    }
                    out["palette"] = Value::Object(pal);
                }
            }
        }
        if o.get("icon").is_some() && kind != "icon" {
            self.warnings.push(format!("{path}: \"icon\" is only used by the icon pattern"));
        }
        Some(out)
    }

    fn group(&mut self, o: &Value, path: &str) -> Option<Value> {
        self.keys(o, path, &[&COMMON[..], &["objects"]].concat());
        let Some(list) = o.get("objects").and_then(|v| v.as_array()) else {
            self.err(path, "\"objects\" is required: the list of objects in the group");
            return None;
        };
        let base = path.split(" (").next().unwrap_or(path).to_string();
        let kids: Vec<Value> = list.iter().enumerate().filter_map(|(i, c)| self.object(c, &format!("{base}.objects[{i}]"))).collect();
        Some(json!({ "id": self.id(), "type": "group", "name": "Group", "children": kids }))
    }
}

/// Library ids close to a mistyped or invented one: all its words, else its longest words alone.
pub fn suggest_ids(lib: &biocanvas_core::Library, id: &str) -> Vec<String> {
    let words = id.rsplit('/').next().unwrap_or(id).replace(['-', '_'], " ");
    let ids = |q: &str| -> Vec<String> {
        let hits = lib.search(&json!({ "q": q, "limit": 4 }));
        hits["items"].as_array().into_iter().flatten().filter_map(|i| i["id"].as_str().map(String::from)).collect()
    };
    let found = ids(&words);
    if !found.is_empty() {
        return found;
    }
    // a misspelt name ("macrofage"): the ids closest in spelling, same pack first
    let (pack, slug) = id.rsplit_once('/').unwrap_or(("", id));
    let most = (slug.chars().count() / 4).max(2);
    let mut close: Vec<(usize, bool, &str)> = lib
        .index
        .icons
        .iter()
        .filter(|m| !m.hidden)
        .filter_map(|m| {
            let (p, s) = m.id.rsplit_once('/').unwrap_or(("", &m.id));
            (s.len().abs_diff(slug.len()) <= most).then(|| (edit_distance(slug, s), p != pack, m.id.as_str())).filter(|c| c.0 <= most)
        })
        .collect();
    if !close.is_empty() {
        close.sort();
        return close.into_iter().take(4).map(|c| c.2.to_string()).collect();
    }
    let mut parts: Vec<&str> = words.split_whitespace().filter(|w| w.len() > 2).collect();
    parts.sort_by_key(|w| std::cmp::Reverse(w.len()));
    parts.into_iter().map(ids).find(|v| !v.is_empty()).unwrap_or_default()
}

/// The asset a document embeds for a library icon, exactly as the app's loadAsset() builds it.
pub fn asset_from_library(data: &Value) -> Value {
    let m = &data["meta"];
    let pack = &data["pack"];
    let or = |v: &Value, d: &Value| if v.as_str().is_some_and(|s| !s.is_empty()) { v.clone() } else { d.clone() };
    json!({
        "svg": data["svg"], "w": m["w"], "h": m["h"],
        "slots": if m["slots"].is_array() { m["slots"].clone() } else { json!([]) },
        "raster": m["raster"],
        "meta": {
            "id": m["id"], "name": m["name"], "pack": m["pack"], "author": m["author"], "license": m["license"],
            "source_url": m["source_url"], "thumb": m["thumb"], "category": m["category"],
            "packName": or(&pack["name"], &m["pack"]), "packCredit": or(&pack["credit"], &json!("")), "packUrl": or(&pack["url"], &json!("")),
            "variants": data["variants"].as_array().into_iter().flatten().map(|v| json!({ "id": v["id"], "name": v["name"], "thumb": v["thumb"] })).collect::<Vec<_>>(),
        },
    })
}

/// Width of the longest line, as the app's canvas measureText() reports it.
fn measure(r: &Renderer, lines: &[&str], family: &str, fs: f64, bold: bool, italic: bool) -> f64 {
    let mut svg = String::from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\">");
    for (i, l) in lines.iter().enumerate() {
        svg += &format!(
            "<text id=\"m{i}\" x=\"0\" y=\"{}\" font-family=\"{}\" font-size=\"{fs}\" font-weight=\"{}\" font-style=\"{}\" xml:space=\"preserve\">{}</text>",
            (i + 1) as f64 * fs * 2.0, esc(family), if bold { 700 } else { 400 }, if italic { "italic" } else { "normal" }, esc(if l.is_empty() { " " } else { l })
        );
    }
    svg += "</svg>";
    let guess = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0) as f64 * fs * 0.55;
    let Ok(tree) = usvg::Tree::from_str(&svg, &r.options()) else { return guess };
    let mut best: f64 = 0.0;
    for node in tree.root().children() {
        if let usvg::Node::Text(t) = node {
            best = best.max(t.bounding_box().width() as f64);
        }
    }
    if best > 0.0 { best } else { guess }
}

/// Validate a figure spec and build the document the app would save for it.
/// Errors list every problem found, each with the path of the field to fix.
pub fn compose(st: &AppState, spec: &Value) -> Result<Composed> {
    let mut c = Composer { st, errors: vec![], warnings: vec![], assets: Map::new(), missing: HashSet::new(), seq: 0 };
    if !spec.is_object() {
        bail!("the figure must be a JSON object like {{\"width_mm\": 178, \"height_mm\": 100, \"objects\": [...]}}");
    }
    c.keys(spec, "figure", &["width_mm", "height_mm", "background", "title", "objects"]);
    let w = c.positive(spec, "figure", "width_mm");
    let h = c.positive(spec, "figure", "height_mm");
    if spec.get("width_mm").is_none() || spec.get("height_mm").is_none() {
        c.err("figure", "\"width_mm\" and \"height_mm\" are required (journal columns: 85, 114 or 178 mm wide)");
    }
    for (k, v) in [("width_mm", w), ("height_mm", h)] {
        if v.is_some_and(|v| v > 1200.0) {
            c.err("figure", format!("\"{k}\" is {} mm — figures are sized in millimetres (178 mm is a full journal page width)", v.unwrap()));
        }
    }
    let background = match spec.get("background") {
        None => Some("#ffffff".to_string()),
        _ => c.color(spec, "figure", "background", true).flatten(),
    };
    let title = c.string(spec, "figure", "title");
    let mut objects = Vec::new();
    match spec.get("objects").and_then(|o| o.as_array()) {
        Some(list) => {
            for (i, o) in list.iter().enumerate() {
                if let Some(v) = c.object(o, &format!("objects[{i}]")) {
                    objects.push(v);
                }
            }
        }
        None => c.err("figure", "\"objects\" is required: a list of icons, text, arrows, shapes, brushes and groups (first = bottom)"),
    }
    if !c.errors.is_empty() {
        let n = c.errors.len();
        bail!(
            "the figure spec has {n} problem{}:\n- {}\nNothing was drawn. Fix these and call again (biocraft_guide has the full spec).",
            if n == 1 { "" } else { "s" },
            c.errors.join("\n- ")
        );
    }
    let mut doc = json!({
        "app": "BioCraft", "version": 1, "width": w.unwrap(), "height": h.unwrap(),
        "background": background, "objects": objects, "assets": c.assets,
    });
    if let Some(t) = title {
        doc["title"] = json!(t);
    }
    let mut warnings = c.warnings;
    // unknown ids were already reported, with suggestions
    warnings.extend(review(&doc, st.renderer()).into_iter().filter(|w| !c.missing.iter().any(|id| w.contains(&format!("icon '{id}' is not in the figure")))));
    Ok(Composed { doc, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(js_num(1.0005, 1000.0), "1.001");
        assert_eq!(js_num(-0.0004, 1000.0), "0");
        assert_eq!(js_num(-2.5, 1.0), "-2");
        assert_eq!(js_num(12.0, 1000.0), "12");
        assert_eq!(js_num(0.1 + 0.2, 1000.0), "0.3");
        assert_eq!(js_num(672.755905511811, 1000.0), "672.756");
    }

    fn slots() -> Vec<Value> {
        serde_json::from_str(r##"[
          {"base":"#ee9ca5","members":["#ee9ca5","#f29a9e","#d4787e","#c9757f","#f4cfcb"],"weight":0.3,"kind":"color"},
          {"base":"#9b74b4","members":["#9b74b4","#86589f","#d9b3e6"],"weight":0.2,"kind":"color"},
          {"base":"#fffbea","members":["#fffbea","#30363d"],"weight":0.01,"kind":"light"}]"##).unwrap()
    }

    // Expected maps printed by node with ui/js/color.js (slotColorMap / tintMap / grayMap).
    #[test]
    fn colour_maps_match_the_app() {
        let m = slot_color_map(&slots(), &[Some("#0072b2".into()), None, Some("#e69f00".into())]);
        let want: Map<String, Value> = serde_json::from_str(r##"{"#ee9ca5":"#0072b2","#f29a9e":"#0b70b9","#d4787e":"#005c9b","#c9757f":"#005a8f","#f4cfcb":"#879ec0","#fffbea":"#e69f00","#30363d":"#311e00"}"##).unwrap();
        assert_eq!(m, want);
        let m = tint_map(&slots(), "#009e73");
        let want: Map<String, Value> = serde_json::from_str(r##"{"#ee9ca5":"#75cba7","#f29a9e":"#6ecca6","#d4787e":"#42ad86","#c9757f":"#47a682","#f4cfcb":"#a8eacd","#9b74b4":"#3d9a78","#86589f":"#00835e","#d9b3e6":"#90d4b6","#fffbea":"#f0fff8","#30363d":"#283a32"}"##).unwrap();
        assert_eq!(m, want);
        let m = gray_map(&slots());
        let want: Map<String, Value> = serde_json::from_str(r##"{"#ee9ca5":"#b6b6b6","#f29a9e":"#b6b6b6","#d4787e":"#979797","#c9757f":"#919191","#f4cfcb":"#d9d9d9","#9b74b4":"#868686","#86589f":"#6e6e6e","#d9b3e6":"#c3c3c3","#fffbea":"#fbfbfb","#30363d":"#353535"}"##).unwrap();
        assert_eq!(m, want);
    }

    #[test]
    fn arrowheads() {
        // a 2 px arrow pointing right ends at the tip; its line stops 0.7 head-lengths short
        let s = head_size(2.0, 1.0);
        assert_eq!(s, 8.4);
        assert_eq!(head("arrow", [100.0, 50.0], [1.0, 0.0], s, "#000", 2.0), "<path d=\"M100 50L91.6 53.864L93.448 50L91.6 46.136Z\" fill=\"#000\"/>");
        assert_eq!(head("bar", [10.0, 10.0], [0.0, 1.0], s, "#000", 2.0), "<path d=\"M4.792 10L15.208 10\" stroke=\"#000\" stroke-width=\"2.7\" stroke-linecap=\"round\"/>");
        assert_eq!(trim("arrow") * s, 8.4 * 0.7);
        let o = json!({ "type": "line", "x1": 0, "y1": 0, "x2": 100, "y2": 0, "strokeWidth": 2, "endHead": "arrow", "startHead": "none", "dash": "" });
        assert!(line_markup(&o).starts_with("<path d=\"M0 0L94.12 0\""));
        // a curved line's head follows the tangent at its end
        let o = json!({ "type": "line", "x1": 0, "y1": 0, "x2": 100, "y2": 0, "curve": 20, "strokeWidth": 2, "endHead": "arrow", "startHead": "none", "dash": "" });
        assert!(line_markup(&o).contains("Q50 40 "));
        assert_eq!(dash_array("dash", 2.0), "7 4.8");
    }

    #[test]
    fn ids_and_colours_in_icon_markup() {
        let inner = r##"<defs><linearGradient id="g1"><stop stop-color="#AABBCC"/></linearGradient></defs><path fill="url(#g1)" stroke="#aabbcc" d="m0 0"/><use xlink:href="#g1"/><path data-id="x" fill="#aabbcc"/>"##;
        let mut map = Map::new();
        map.insert("#aabbcc".into(), json!("#112233"));
        let out = icon_inner(inner, Some(&map), "o1-");
        assert_eq!(out, r##"<defs><linearGradient id="o1-g1"><stop stop-color="#112233"/></linearGradient></defs><path fill="url(#o1-g1)" stroke="#112233" d="m0 0"/><use xlink:href="#o1-g1"/><path data-id="o1-x" fill="#112233"/>"##);
    }

    #[test]
    fn credits_like_the_app() {
        let doc = json!({ "objects": [
            { "type": "icon", "asset": "servier/a" }, { "type": "group", "children": [{ "type": "icon", "asset": "bioicons/b" }] },
            { "type": "icon", "asset": "nih/c" }, { "type": "icon", "asset": "servier/d" } ],
          "assets": {
            "servier/a": { "meta": { "pack": "servier", "packName": "Servier Medical Art", "name": "Macrophage", "license": "CC-BY-3.0" } },
            "servier/d": { "meta": { "pack": "servier", "packName": "Servier Medical Art", "name": "Neutrophil", "license": "CC-BY-4.0" } },
            "bioicons/b": { "meta": { "pack": "bioicons", "packName": "Bioicons", "name": "Pipette", "author": "Jane Doe", "license": "CC-BY-4.0" } },
            "nih/c": { "meta": { "pack": "nih", "packName": "NIH BioArt Source", "name": "Virus", "license": "PD", "source_url": "https://bioart.niaid.nih.gov/bioart/12" } } } });
        assert_eq!(legend_text(&doc), "Created with BioCraft using Servier Medical Art (smart.servier.com), licensed under CC BY 3.0/4.0 (Macrophage, Neutrophil); Bioicons: Pipette by Jane Doe (CC BY 4.0); illustrations from NIAID NIH BioArt Source (bioart.niaid.nih.gov/bioart/12).");
        assert_eq!(licences(&doc).len(), 3);
        assert_eq!(legend_text(&json!({ "objects": [], "assets": {} })), "Figure created with BioCraft.");
    }

    #[test]
    fn suggestions() {
        assert_eq!(did_you_mean("colour", &["color", "x"]), " — did you mean \"color\"?");
        assert_eq!(did_you_mean("rotaton", &["rotate", "x"]), " — did you mean \"rotate\"?");
        assert_eq!(did_you_mean("zzz", &["rotate"]), "");
        // a misspelt icon id still finds the icon
        let st = fixture();
        assert_eq!(suggest_ids(&st.lib.read().unwrap(), "t/lebelled"), ["t/labelled"]);
    }

    /// A two-icon library: a recolourable cell, and a drawing with a label, leader line and dot.
    fn fixture() -> AppState {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!("biocraft-figure-test-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        std::fs::create_dir_all(root.join("packs/t/svg")).unwrap();
        std::fs::write(
            root.join("packs/t/svg/cell.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><path fill="#ee9ca5" d="M0 0h100v50H0z"/><path fill="#d4787e" d="M10 10h20v20H10z"/><circle fill="#ffffff" cx="70" cy="25" r="10"/></svg>"##,
        )
        .unwrap();
        std::fs::write(
            root.join("packs/t/svg/labelled.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><path fill="#9fd3ef" d="M0 0h100v100H0z"/><path fill="none" stroke="#888888" stroke-width="1" d="M60 50L140 46"/><circle fill="#888888" cx="60" cy="50" r="1.5"/><text x="150" y="50" font-family="Arial" font-size="12" fill="#000000">Nucleus</text></svg>"##,
        )
        .unwrap();
        let icon = |id: &str, name: &str, w: f32, h: f32, slots: Value| {
            json!({ "id": id, "name": name, "pack": "t", "category": "cells", "author": "Tester", "license": "CC-BY-4.0",
                    "file": format!("packs/t/svg/{}.svg", &id[2..]), "thumb": "packs/t/thumbs/none.png", "w": w, "h": h, "slots": slots })
        };
        let index = json!({
            "version": 1, "built": "", "categories": [],
            "packs": [{ "id": "t", "name": "Test pack", "credit": "Test credit", "url": "https://example.org" }],
            "icons": [
                icon("t/cell", "Cell", 100.0, 50.0, json!([{ "base": "#ee9ca5", "members": ["#ee9ca5", "#d4787e"], "weight": 0.8, "kind": "color" }, { "base": "#ffffff", "members": ["#ffffff"], "weight": 0.2, "kind": "light" }])),
                icon("t/labelled", "Labelled", 200.0, 100.0, json!([])),
            ],
        });
        std::fs::write(root.join("index.json"), index.to_string()).unwrap();
        let lib = biocanvas_core::Library::open(&root, &root.join("user")).unwrap();
        AppState::new(lib, root)
    }

    #[test]
    fn composes_a_document_like_the_app() {
        let st = fixture();
        let spec = json!({ "width_mm": 100, "height_mm": 60, "title": "Test", "objects": [
            { "type": "icon", "id": "t/cell", "cx": 30, "y": 10, "w": 20, "colors": ["#0072b2"] },
            { "type": "text", "text": "Cell\nline 2", "x": 30, "y": 25, "align": "center", "size_pt": 7.5 },
            { "type": "arrow", "from": [45, 15], "to": [70, 15], "curve_mm": 2 },
            { "type": "inhibit", "from": [45, 25], "to": [70, 25], "dash": "dash" },
            { "type": "rect", "x": 2, "y": 2, "w": 96, "h": 56, "fill": "#eef6fb", "stroke": null, "radius_mm": 2 },
            { "type": "brush", "pattern": "bilayer", "points": [[10, 50], [90, 50]], "colors": { "head": "#56b4e9" } },
            { "type": "group", "objects": [{ "type": "ellipse", "cx": 80, "cy": 40, "w": 8, "h": 5 }] },
        ] });
        let c = compose(&st, &spec).unwrap();
        let d = &c.doc;
        assert_eq!((d["app"].as_str(), d["version"].as_i64(), d["width"].as_f64(), d["title"].as_str()), (Some("BioCraft"), Some(1), Some(100.0), Some("Test")));
        let icon = &d["objects"][0];
        // 20 mm wide at the drawing's 2:1 proportions, centred on x = 30 mm
        assert!((icon["w"].as_f64().unwrap() - 20.0 * MM).abs() < 1e-9 && (icon["h"].as_f64().unwrap() - 10.0 * MM).abs() < 1e-9);
        assert!((icon["x"].as_f64().unwrap() - 20.0 * MM).abs() < 1e-9);
        assert_eq!(icon["slotColors"], json!(["#0072b2"]));
        assert_eq!(icon["colors"]["#ee9ca5"], json!("#0072b2"));
        assert!(icon["colors"]["#d4787e"].is_string() && icon["colors"].get("#ffffff").is_none());
        let text = &d["objects"][1];
        assert_eq!(text["fontSize"].as_f64(), Some(10.0));
        assert!((text["x"].as_f64().unwrap() + text["w"].as_f64().unwrap() / 2.0 - 30.0 * MM).abs() < 1e-9);
        assert_eq!(d["objects"][2]["endHead"], "arrow");
        assert!((d["objects"][2]["curve"].as_f64().unwrap() - 2.0 * MM).abs() < 1e-9);
        assert_eq!((d["objects"][3]["endHead"].as_str(), d["objects"][3]["dash"].as_str()), (Some("bar"), Some("dash")));
        assert_eq!((d["objects"][4]["stroke"].as_str(), d["objects"][4]["fill"].as_str()), (Some("none"), Some("#eef6fb")));
        assert_eq!((d["objects"][5]["type"].as_str(), d["objects"][5]["headColor"].as_str()), (Some("membrane"), Some("#56b4e9")));
        assert_eq!(d["objects"][6]["children"][0]["type"], "ellipse");
        assert_eq!(d["assets"]["t/cell"]["meta"]["packName"], "Test pack");
        // recoloured under CC BY, so credited as adapted
        assert_eq!(legend_text(d), "Created with BioCraft using Test pack: adapted from Cell by Tester (CC BY 4.0).");
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
        // a saved document renders the same as the spec it came from
        assert!(is_document(d) && !is_document(&spec));
        let svg = String::from_utf8(export(d, st.renderer(), "svg", 300.0, false).unwrap()).unwrap();
        assert!(svg.starts_with("<svg") && svg.contains("fill=\"#0072b2\"") && svg.contains("<tspan"));
        assert!(export(d, st.renderer(), "png", 96.0, false).unwrap().starts_with(b"\x89PNG"));
        assert!(export(d, st.renderer(), "pdf", 96.0, false).unwrap().starts_with(b"%PDF"));
    }

    #[test]
    fn errors_name_the_field_to_fix() {
        let st = fixture();
        let spec = json!({ "width_mm": 100, "objects": [
            { "type": "icon", "id": "t/cell", "x": "10mm", "y": 5, "colour": "#ff0000" },
            { "type": "arow", "from": [0, 0], "to": [1, 1] },
            { "type": "icon", "id": "t/cell", "x": 1, "y": 1, "colors": ["#000000", null, "#ffffff"] },
            { "type": "text", "text": "x", "x": 1, "y": 1, "align": "middle" },
            { "type": "group", "objects": [{ "type": "line", "from": [0, 0] }] },
            { "type": "brush", "pattern": "bilayer", "points": [[0, 0], [1, 1]], "closed": true },
        ] });
        let e = compose(&st, &spec).err().unwrap().to_string();
        for want in [
            "figure: \"width_mm\" and \"height_mm\" are required",
            "objects[0] (icon): \"x\" must be a number",
            "objects[0] (icon): unknown field \"colour\"",
            "objects[1]: unknown type \"arow\" — did you mean \"arrow\"?",
            "objects[2] (icon): colour slot 2 does not exist — this icon has 2 slots",
            "objects[3] (text): \"align\" must be one of \"left\", \"center\", \"right\"",
            "objects[4].objects[0] (line): \"to\" must be a point [x, y]",
            "objects[5] (brush): \"points\" needs at least 3 points for a closed loop",
            "Nothing was drawn",
        ] {
            assert!(e.contains(want), "missing «{want}» in:\n{e}");
        }
    }

    #[test]
    fn warnings_for_unknown_ids_and_layout() {
        let st = fixture();
        let spec = json!({ "width_mm": 50, "height_mm": 30, "objects": [
            { "type": "icon", "id": "t/no-such-cell", "x": 5, "y": 5, "w": 10 },
            { "type": "icon", "id": "t/cell", "x": 45, "y": 5, "w": 20 },
            { "type": "text", "text": "Overlap A", "x": 5, "y": 20 },
            { "type": "text", "text": "Overlap B", "x": 6, "y": 20.5, "size_pt": 4 },
        ] });
        let c = compose(&st, &spec).unwrap();
        let w = c.warnings.join("\n");
        assert!(w.contains("unknown icon id \"t/no-such-cell\"") && w.contains("\"t/cell\""), "{w}");
        assert!(!w.contains("is not in the figure"), "reported twice: {w}");
        assert!(w.contains("objects[1] (icon \"Cell\") extends 15.0 mm past the right edge"), "{w}");
        assert!(w.contains("overlap") && w.contains("is 4.0 pt"), "{w}");
        // the unknown icon stays in the document as the app's red placeholder
        let svg = String::from_utf8(export(&c.doc, st.renderer(), "svg", 300.0, false).unwrap()).unwrap();
        assert!(svg.contains("fill=\"#f3d6d6\" stroke=\"#c0392b\""));
    }

    #[test]
    fn specs_are_not_mistaken_for_documents() {
        let st = fixture();
        // "width"/"height" instead of "width_mm"/"height_mm" is still a spec, so it gets fixed
        let spec = json!({ "width": 85, "height": 50, "objects": [{ "type": "arrow", "from": [30, 20], "to": [60, 20] }] });
        assert!(!is_document(&spec));
        let e = compose(&st, &spec).err().unwrap().to_string();
        assert!(e.contains("unknown field \"width\" — did you mean \"width_mm\"?") && e.contains("did you mean \"height_mm\"?"), "{e}");
        let doc = compose(&st, &json!({ "width_mm": 50, "height_mm": 30, "objects": [] })).unwrap().doc;
        assert!(is_document(&doc) && check_document(&doc).is_ok());
        // a saved document with spec objects mixed in is refused, not drawn half-blank
        let mut mixed = doc.clone();
        mixed["objects"] = json!([{ "type": "arrow", "from": [0, 0], "to": [10, 10] }, { "type": "text", "text": "x", "size_pt": 8 }]);
        let e = check_document(&mixed).err().unwrap().to_string();
        assert!(e.contains("objects[0] (arrow) has \"from\"/\"to\" points") && e.contains("objects[1] (text) has the spec field \"size_pt\""), "{e}");
    }

    #[test]
    fn brushes_are_checked_and_measured_as_drawn() {
        let st = fixture();
        // cells grow on one side of the path only: no false "past the edge" warnings
        let spec = json!({ "width_mm": 178, "height_mm": 110, "objects": [
            { "type": "brush", "pattern": "columnar", "points": [[5, 105], [45, 100], [85, 105]] },
            { "type": "brush", "pattern": "squamous", "points": [[5, 60], [60, 60]] },
            { "type": "brush", "pattern": "bilayer", "points": [[100, 30], [190, 30]] },
        ] });
        let c = compose(&st, &spec).unwrap();
        let w = c.warnings.join("\n");
        assert!(!w.contains("objects[0]") && !w.contains("objects[1]"), "{w}");
        assert!(w.contains("objects[2] (brush \"Lipid bilayer\") extends 1") && w.contains("mm past the right edge"), "{w}");
        let p = Painter::new(&c.doc, st.renderer());
        let (drawn, padded) = (p.drawn_bbox(&c.doc["objects"][0]), bbox(&c.doc["objects"][0]));
        assert!(drawn.x > padded.x + 10.0 * MM && drawn.x > 2.0 * MM && drawn.y + drawn.h < 110.0 * MM, "{drawn:?} vs {padded:?}");
        // the app's slider ranges, in mm
        let bad = json!({ "width_mm": 100, "height_mm": 50, "objects": [
            { "type": "brush", "pattern": "bilayer", "points": [[0, 0], [10, 0]], "thickness_mm": 20 },
            { "type": "brush", "pattern": "dna", "points": [[0, 0], [10, 0]], "spacing": 5 },
        ] });
        let e = compose(&st, &bad).err().unwrap().to_string();
        assert!(e.contains("\"thickness_mm\" must be between 1.6 and 15.8 for the bilayer pattern, got 20"), "{e}");
        assert!(e.contains("\"spacing\" must be between 0.4 and 2.5"), "{e}");
        let ok = compose(&st, &json!({ "width_mm": 100, "height_mm": 50, "objects": [
            { "type": "brush", "pattern": "squamous", "points": [[10, 20], [90, 20]], "apical": "cilia" },
            { "type": "brush", "pattern": "bilayer", "points": [[10, 40], [90, 40]], "spacing": 2 },
        ] })).unwrap();
        let w = ok.warnings.join("\n");
        assert!(w.contains("objects[0] (brush): \"apical\" only applies to the cuboidal and columnar") && w.contains("has no \"spacing\""), "{w}");
    }

    #[test]
    fn transparent_raster_export() {
        let st = fixture();
        let doc = compose(&st, &json!({ "width_mm": 10, "height_mm": 10, "objects": [{ "type": "rect", "x": 4, "y": 4, "w": 2, "h": 2 }] })).unwrap().doc;
        let pixel = |png: Vec<u8>| {
            let tree = svgclean::parse(format!("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"10\" height=\"10\"><image width=\"10\" height=\"10\" xlink:href=\"data:image/png;base64,{}\"/></svg>", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png)).as_bytes(), &st.renderer().options()).unwrap();
            let pm = st.renderer().render_scaled(&tree, 1.0, None).unwrap();
            pm.pixels()[0].alpha()
        };
        assert_eq!(pixel(export(&doc, st.renderer(), "png", 96.0, false).unwrap()), 255);
        assert_eq!(pixel(export(&doc, st.renderer(), "png", 96.0, true).unwrap()), 0);
    }

    #[test]
    fn hidden_labels_crop_the_icon() {
        let st = fixture();
        let shown = compose(&st, &json!({ "width_mm": 60, "height_mm": 40, "objects": [{ "type": "icon", "id": "t/labelled", "x": 0, "y": 0, "w": 40 }] })).unwrap();
        assert!(shown.warnings.iter().any(|w| w.contains("\"Nucleus\"") && w.contains("\"labels\": \"hide\"")), "{:?}", shown.warnings);
        let c = compose(&st, &json!({ "width_mm": 60, "height_mm": 40, "objects": [{ "type": "icon", "id": "t/labelled", "x": 0, "y": 0, "w": 40, "labels": "hide" }] })).unwrap();
        let o = &c.doc["objects"][0];
        assert_eq!(o["labels"], "hidden");
        // text, leader line and dot are gone; the box is the drawing plus the app's 1.2 % margin
        let m = 200f64.hypot(100.0) * 0.012;
        let aspect = o["w"].as_f64().unwrap() / o["h"].as_f64().unwrap();
        assert!((aspect - (100.0 + m) / 100.0).abs() < 0.01, "aspect {aspect}");
        let svg = String::from_utf8(export(&c.doc, st.renderer(), "svg", 300.0, false).unwrap()).unwrap();
        assert!(!svg.contains("<text") && !svg.contains("#888888") && svg.contains("#9fd3ef"), "{svg}");
    }
}
