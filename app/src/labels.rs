//! Text labels drawn inside library icons — the Rust side of ui/js/labels.js. Finds the text,
//! its leader lines and their end dots so an icon can be drawn without them and cropped to
//! what is left. Geometry comes from usvg instead of the browser's getBBox/getCTM; the app
//! repeats the analysis in the browser when a figure is opened.

use biocanvas_core::usvg::{self, roxmltree, tiny_skia_path::PathSegment, Node, Paint};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

pub struct LabelInfo {
    pub hidden_vb: [f64; 4],
    /// Inner markup without text, leader lines and dots (None: nothing to hide).
    pub hidden_inner: Option<String>,
    /// Inner markup without the text only.
    pub textless_inner: Option<String>,
    /// The readable label texts, one per label block.
    pub labels: Vec<String>,
}

/// Cheap check on the markup: does this icon contain text at all?
pub fn has_labels(svg: &str) -> bool {
    svg.contains("<text")
}

/// Analysis of one icon, cached by `key` (the asset id).
pub fn info(key: &str, svg: &str, opt: &usvg::Options) -> Arc<LabelInfo> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<LabelInfo>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let k = format!("{key}:{}", svg.len());
    if let Some(v) = cache.lock().unwrap().get(&k) {
        return v.clone();
    }
    let v = Arc::new(analyse(svg, opt));
    cache.lock().unwrap().insert(k, v.clone());
    v
}

type Pt = [f64; 2];

struct Label {
    lines: Vec<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    fs: f64,
    fill: String,
    align: &'static str,
}

struct El {
    key: String,
    range: std::ops::Range<usize>,
    tag: String,
    /// Path commands (letters other than e/E in `d`).
    cmds: usize,
}

struct Shape {
    ts: usvg::Transform,
    data: usvg::tiny_skia_path::Path,
    fill: Option<String>,
    stroke: Option<(String, f64)>,
    bbox: usvg::Rect,
}

struct TextGeo {
    bbox: usvg::Rect,
    ts: usvg::Transform,
    fs: f64,
    fill: String,
    align: &'static str,
    chunks: Vec<(Option<f32>, Option<f32>, String)>,
}

fn paint_key(p: &Paint) -> String {
    match p {
        Paint::Color(c) => format!("#{:02x}{:02x}{:02x}", c.red, c.green, c.blue),
        _ => "url".into(),
    }
}

fn collect(g: &usvg::Group, shapes: &mut HashMap<String, Shape>, texts: &mut HashMap<String, TextGeo>) {
    for node in g.children() {
        match node {
            Node::Group(g) => collect(g, shapes, texts),
            Node::Path(p) => {
                if p.id().is_empty() || shapes.contains_key(p.id()) {
                    continue;
                }
                shapes.insert(
                    p.id().to_string(),
                    Shape {
                        ts: p.abs_transform(),
                        data: p.data().clone(),
                        fill: p.fill().map(|f| paint_key(f.paint())),
                        stroke: p.stroke().map(|s| (paint_key(s.paint()), s.width().get() as f64)),
                        bbox: p.abs_bounding_box(),
                    },
                );
            }
            Node::Text(t) => {
                let span = t.chunks().iter().flat_map(|c| c.spans()).next();
                let chunks = t.chunks().iter().map(|c| (c.x(), c.y(), c.text().to_string())).collect();
                let align = match t.chunks().first().map(|c| c.anchor()) {
                    Some(usvg::TextAnchor::Middle) => "center",
                    Some(usvg::TextAnchor::End) => "right",
                    _ => "left",
                };
                texts.insert(
                    t.id().to_string(),
                    TextGeo {
                        bbox: t.abs_bounding_box(),
                        ts: t.abs_transform(),
                        fs: span.map(|s| s.font_size().get() as f64).unwrap_or(12.0),
                        fill: span.and_then(|s| s.fill()).map(|f| paint_key(f.paint())).unwrap_or_else(|| "#1c2733".into()),
                        align,
                        chunks,
                    },
                );
            }
            Node::Image(_) => {}
        }
    }
}

/// The icon's viewBox, and where its inner markup starts and ends.
pub fn frame(svg: &str) -> Option<([f64; 4], usize, usize)> {
    let start = svg.find("<svg")?;
    let open = start + svg[start..].find('>')?;
    let close = svg.rfind("</svg>").filter(|c| *c > open)?;
    let head = &svg[..open];
    let vb = head.find("viewBox=\"").and_then(|i| {
        let rest = &head[i + 9..];
        let v: Vec<f64> = rest[..rest.find('"')?].split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
        (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
    })?;
    Some((vb, open, close))
}

fn dist(a: Pt, b: Pt) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn dist_to_box(p: Pt, b: &Label) -> f64 {
    let dx = (b.x - p[0]).max(0.0).max(p[0] - (b.x + b.w));
    let dy = (b.y - p[1]).max(0.0).max(p[1] - (b.y + b.h));
    dx.hypot(dy)
}

fn analyse(svg: &str, opt: &usvg::Options) -> LabelInfo {
    let Some((vb, open, close)) = frame(svg) else {
        return LabelInfo { hidden_vb: [0.0, 0.0, 100.0, 100.0], hidden_inner: None, textless_inner: None, labels: vec![] };
    };
    let plain = || LabelInfo { hidden_vb: vb, hidden_inner: None, textless_inner: None, labels: vec![] };
    let Ok(doc) = roxmltree::Document::parse(svg) else { return plain() };
    if doc.root_element().tag_name().name() != "svg" {
        return plain();
    }

    // every drawable element outside defs etc. gets an id, so usvg's geometry maps back to it
    let skip_tags = ["defs", "clipPath", "mask", "pattern", "marker", "symbol"];
    let mut els: Vec<El> = Vec::new();
    let mut texts: Vec<usize> = Vec::new();
    let mut inserts: Vec<(usize, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (n, node) in doc.root_element().descendants().skip(1).filter(|n| n.is_element()).enumerate() {
        let tag = node.tag_name().name();
        let is_text = tag == "text";
        if !is_text && !matches!(tag, "path" | "line" | "polyline" | "circle" | "ellipse" | "rect") {
            continue;
        }
        let blocked = node.ancestors().skip(1).any(|a| skip_tags.contains(&a.tag_name().name()) || (!is_text && a.tag_name().name() == "text"));
        if blocked {
            continue;
        }
        let key = match node.attribute("id") {
            Some(id) if seen.insert(id.to_string()) => id.to_string(),
            Some(_) => continue,
            None => {
                let key = format!("__bc{n}");
                let at = node.range().start + 1 + svg[node.range().start + 1..].find(|c: char| c.is_whitespace() || c == '/' || c == '>').unwrap_or(0);
                inserts.push((at, format!(" id=\"{key}\"")));
                key
            }
        };
        let cmds = node.attribute("d").map(|d| d.chars().filter(|c| c.is_ascii_alphabetic() && *c != 'e' && *c != 'E').count()).unwrap_or(0);
        if is_text {
            texts.push(els.len());
        }
        els.push(El { key, range: node.range(), tag: tag.to_string(), cmds });
    }
    if texts.is_empty() {
        return plain();
    }
    let mut tagged = String::with_capacity(svg.len() + inserts.len() * 12);
    let mut last = 0;
    for (at, s) in &inserts {
        tagged.push_str(&svg[last..*at]);
        tagged.push_str(s);
        last = *at;
    }
    tagged.push_str(&svg[last..]);
    let Ok(tree) = usvg::Tree::from_str(&tagged, opt) else { return plain() };

    // canvas → icon coordinates (the root maps the viewBox onto width × height)
    let size = tree.size();
    let (sx, sy) = (size.width() as f64 / vb[2], size.height() as f64 / vb[3]);
    let to_icon = |x: f32, y: f32| -> Pt { [x as f64 / sx + vb[0], y as f64 / sy + vb[1]] };
    let unit = (sx * sy).sqrt();
    let scale_of = |ts: &usvg::Transform| ((ts.sx * ts.sy - ts.kx * ts.ky).abs() as f64).sqrt() / unit;

    let mut shapes = HashMap::new();
    let mut tgeo = HashMap::new();
    collect(tree.root(), &mut shapes, &mut tgeo);

    // labels: box, font size and lines of each text, merged into blocks
    let mut labels = Vec::new();
    for &i in &texts {
        let Some(t) = tgeo.get(&els[i].key) else { continue };
        let a = to_icon(t.bbox.left(), t.bbox.top());
        let b = to_icon(t.bbox.right(), t.bbox.bottom());
        let (w, h) = (b[0] - a[0], b[1] - a[1]);
        if !(w > 0.0 && h > 0.0) {
            continue;
        }
        let sc = scale_of(&t.ts).max(1e-9);
        let fs = t.fs * sc;
        // chunks that start a new y are new lines
        let mut lines: Vec<(f64, f64, String)> = Vec::new();
        for (cx, cy, txt) in &t.chunks {
            let target = match cy {
                Some(y) => lines.iter().position(|l| ((l.0 - *y as f64) * sc).abs() < fs * 0.45),
                None => lines.len().checked_sub(1),
            };
            match target {
                Some(k) => {
                    let l = &mut lines[k];
                    if cy.is_some() && !l.2.ends_with(char::is_whitespace) && !txt.starts_with(char::is_whitespace) {
                        l.2.push(' ');
                    }
                    l.2.push_str(txt);
                }
                None => lines.push((cy.unwrap_or(0.0) as f64, cx.unwrap_or(0.0) as f64, txt.clone())),
            }
        }
        lines.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let lines: Vec<String> = lines.into_iter().map(|l| l.2.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|s| !s.is_empty()).collect();
        if lines.is_empty() {
            continue;
        }
        labels.push(Label { lines, x: a[0], y: a[1], w, h, fs, fill: t.fill.clone(), align: t.align });
    }
    let labels = merge_stacked(labels);
    let diag = vb[2].hypot(vb[3]);

    // end points and length of an open stroke, in icon coordinates
    let ends2 = |s: &Shape| -> Option<(Pt, Pt, f64, f64)> {
        let (mut first, mut cur, mut start) = (None, (0f32, 0f32), (0f32, 0f32));
        let mut len = 0f64;
        let seg = |a: (f32, f32), b: (f32, f32)| ((b.0 - a.0) as f64).hypot((b.1 - a.1) as f64);
        for sg in s.data.segments() {
            match sg {
                PathSegment::MoveTo(p) => {
                    cur = (p.x, p.y);
                    start = cur;
                    first.get_or_insert(cur);
                }
                PathSegment::LineTo(p) => {
                    len += seg(cur, (p.x, p.y));
                    cur = (p.x, p.y);
                }
                PathSegment::QuadTo(c, p) => {
                    let mut prev = cur;
                    for k in 1..=16 {
                        let t = k as f32 / 16.0;
                        let u = 1.0 - t;
                        let q = (u * u * cur.0 + 2.0 * u * t * c.x + t * t * p.x, u * u * cur.1 + 2.0 * u * t * c.y + t * t * p.y);
                        len += seg(prev, q);
                        prev = q;
                    }
                    cur = (p.x, p.y);
                }
                PathSegment::CubicTo(c1, c2, p) => {
                    let mut prev = cur;
                    for k in 1..=16 {
                        let t = k as f32 / 16.0;
                        let u = 1.0 - t;
                        let f = |a: f32, b: f32, c: f32, d: f32| u * u * u * a + 3.0 * u * u * t * b + 3.0 * u * t * t * c + t * t * t * d;
                        let q = (f(cur.0, c1.x, c2.x, p.x), f(cur.1, c1.y, c2.y, p.y));
                        len += seg(prev, q);
                        prev = q;
                    }
                    cur = (p.x, p.y);
                }
                PathSegment::Close => {
                    len += seg(cur, start);
                    cur = start;
                }
            }
        }
        let first = first?;
        if len.is_nan() || len <= 0.0 {
            return None;
        }
        let map = |p: (f32, f32)| {
            let mut q = usvg::tiny_skia_path::Point::from_xy(p.0, p.1);
            s.ts.map_point(&mut q);
            to_icon(q.x, q.y)
        };
        let sc = scale_of(&s.ts);
        Some((map(first), map(cur), len * sc, sc))
    };

    // leader lines: thin open strokes with one end at a label
    let mut remove: HashSet<usize> = texts.iter().copied().collect();
    struct End {
        p: Pt,
        stroke: String,
        width: f64,
    }
    let mut ends: Vec<End> = Vec::new();
    let geom: Vec<usize> = (0..els.len()).filter(|&i| matches!(els[i].tag.as_str(), "path" | "line" | "polyline")).collect();
    let open_stroke = |i: usize| -> Option<(&Shape, String, f64)> {
        let s = shapes.get(&els[i].key)?;
        let (stroke, w) = s.stroke.clone()?;
        if s.fill.is_some() {
            return None;
        }
        Some((s, stroke, w))
    };
    for &i in &geom {
        let Some((s, stroke, w)) = open_stroke(i) else { continue };
        if els[i].tag == "path" && els[i].cmds > 8 {
            continue;
        }
        let Some((a, b, len, sc)) = ends2(s) else { continue };
        for lb in &labels {
            let tol = (lb.fs * 0.9).max(diag * 0.012);
            let (d0, d1) = (dist_to_box(a, lb), dist_to_box(b, lb));
            if d0.min(d1) <= tol && len >= lb.fs * 0.8 && len <= diag * 0.8 {
                remove.insert(i);
                ends.push(End { p: if d0 < d1 { b } else { a }, stroke: stroke.clone(), width: w * sc });
                break;
            }
        }
    }
    // a leader drawn as two pieces (an elbow): same colour and width, starting where the first ends
    for _ in 0..2 {
        for &i in &geom {
            if remove.contains(&i) {
                continue;
            }
            let Some((s, stroke, w)) = open_stroke(i) else { continue };
            if els[i].tag == "path" && els[i].cmds > 3 {
                continue;
            }
            let Some((a, b, _, sc)) = ends2(s) else { continue };
            let hit = ends.iter().find(|en| en.stroke == stroke && (en.width - w * sc).abs() < 0.25 * en.width + 0.01 && dist(en.p, a).min(dist(en.p, b)) <= en.width * 1.5);
            if let Some(hit) = hit {
                let e = End { p: if dist(hit.p, a) < dist(hit.p, b) { b } else { a }, stroke, width: hit.width };
                remove.insert(i);
                ends.push(e);
            }
        }
    }
    // the small dot many leader lines end in
    for i in 0..els.len() {
        if remove.contains(&i) || !matches!(els[i].tag.as_str(), "circle" | "ellipse" | "path" | "rect") {
            continue;
        }
        let Some(s) = shapes.get(&els[i].key) else { continue };
        let Some(fill) = &s.fill else { continue };
        let a = to_icon(s.bbox.left(), s.bbox.top());
        let b = to_icon(s.bbox.right(), s.bbox.bottom());
        let size = (b[0] - a[0]).hypot(b[1] - a[1]);
        let c = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        if ends.iter().any(|en| *fill == en.stroke && size <= (en.width * 8.0).max(diag * 0.02) && dist(c, en.p) <= size / 2.0 + en.width * 2.0) {
            remove.insert(i);
        }
    }

    let inner = |drop: &dyn Fn(usize) -> bool| -> String {
        let mut ranges: Vec<std::ops::Range<usize>> = (0..els.len()).filter(|&i| drop(i)).map(|i| els[i].range.clone()).collect();
        ranges.sort_by_key(|r| r.start);
        let mut out = String::new();
        let mut last = open + 1;
        for r in ranges {
            if r.start < last {
                continue;
            }
            out.push_str(&svg[last..r.start]);
            last = r.end;
        }
        out.push_str(&svg[last..close]);
        out
    };
    let text_set: HashSet<usize> = texts.iter().copied().collect();
    let textless = inner(&|i| text_set.contains(&i));
    let hidden = inner(&|i| remove.contains(&i));

    // crop to what is left (getBBox of the remaining drawing, plus a small margin)
    let mut hidden_vb = vb;
    let doc_hidden = format!("{}{}</svg>", &svg[..open + 1], hidden);
    if let Ok(t) = usvg::Tree::from_str(&doc_hidden, opt) {
        if let Some((l, tp, r, bt)) = leaf_bounds(t.root()) {
            let a = to_icon(l, tp);
            let b = to_icon(r, bt);
            let m = diag * 0.012;
            let x0 = vb[0].max(a[0] - m);
            let y0 = vb[1].max(a[1] - m);
            let x1 = (vb[0] + vb[2]).min(b[0] + m);
            let y1 = (vb[1] + vb[3]).min(b[1] + m);
            if x1 - x0 > 1.0 && y1 - y0 > 1.0 {
                hidden_vb = [x0, y0, x1 - x0, y1 - y0];
            }
        }
    }
    LabelInfo { hidden_vb, hidden_inner: Some(hidden), textless_inner: Some(textless), labels: labels.iter().map(|l| l.lines.join(" ")).collect() }
}

/// Union of what is actually drawn: paths, images and text, not the empty groups left behind
/// by removed labels (the browser's getBBox skips those too).
fn leaf_bounds(g: &usvg::Group) -> Option<(f32, f32, f32, f32)> {
    let mut acc: Option<(f32, f32, f32, f32)> = None;
    for node in g.children() {
        let b = match node {
            Node::Group(g) => leaf_bounds(g),
            _ => {
                let r = node.abs_bounding_box();
                (r.width() > 0.0 || r.height() > 0.0).then(|| (r.left(), r.top(), r.right(), r.bottom()))
            }
        };
        if let Some(b) = b {
            acc = Some(match acc {
                Some(a) => (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)),
                None => b,
            });
        }
    }
    acc
}

/// One label per block: lines stacked under each other (same font, aligned) were often drawn as separate texts.
fn merge_stacked(mut labels: Vec<Label>) -> Vec<Label> {
    labels.sort_by(|a, b| a.y.total_cmp(&b.y));
    let mut out: Vec<Label> = Vec::new();
    let key = |l: &Label| match l.align {
        "center" => l.x + l.w / 2.0,
        "right" => l.x + l.w,
        _ => l.x,
    };
    for lb in labels {
        let fs = lb.fs;
        let g = out.iter_mut().find(|o| {
            (o.fs - fs).abs() < fs * 0.08 && o.fill == lb.fill && o.align == lb.align && (key(o) - key(&lb)).abs() < fs * 0.7 && lb.y - (o.y + o.h) < fs * 0.6 && lb.y > o.y + o.h * 0.5
        });
        match g {
            None => out.push(lb),
            Some(g) => {
                g.lines.extend(lb.lines.iter().cloned());
                let x1 = (g.x + g.w).max(lb.x + lb.w);
                let y1 = (g.y + g.h).max(lb.y + lb.h);
                g.x = g.x.min(lb.x);
                g.w = x1 - g.x;
                g.h = y1 - g.y;
            }
        }
    }
    out
}
