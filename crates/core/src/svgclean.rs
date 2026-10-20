//! SVG normalisation through usvg: whatever the source (Illustrator, Inkscape, Python
//! ElementTree with `ns0:` prefixes, CSS classes, `<use>`, text), the output is a flat SVG with
//! explicit `fill`/`stroke`/`stop-color` attributes, a tight viewBox and no scripts or links.

use crate::color::Rgb;
use anyhow::{bail, Result};
use resvg::usvg::{self, Node, Paint, Tree};
use std::collections::HashMap;

pub struct Cleaned {
    pub svg: String,
    pub w: f32,
    pub h: f32,
    pub raster: bool,
    /// Every paint colour with its approximate painted area.
    pub colors: Vec<(Rgb, f32)>,
}

/// Store an SVG gzip-compressed (a standard `.svgz`): about 2–5× smaller on disk.
pub fn write_svgz(path: &std::path::Path, svg: &str) -> Result<()> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(svg.as_bytes())?;
    std::fs::write(path, enc.finish()?)?;
    Ok(())
}

/// Read an SVG that may be gzip-compressed (detected by its magic bytes, not its name).
pub fn read_svg(path: &std::path::Path) -> Result<String> {
    use std::io::Read;
    let data = std::fs::read(path)?;
    if data.starts_with(&[0x1f, 0x8b]) {
        let mut s = String::new();
        flate2::read::GzDecoder::new(&data[..]).read_to_string(&mut s)?;
        Ok(s)
    } else {
        Ok(String::from_utf8(data)?)
    }
}

/// usvg options that never touch the file system or network: only `data:` images load.
pub fn safe_options(fontdb: std::sync::Arc<usvg::fontdb::Database>) -> usvg::Options<'static> {
    let mut opt = usvg::Options::default();
    opt.fontdb = fontdb;
    opt.font_family = "Arial".into();
    opt.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
        resolve_string: Box::new(|_, _| None),
    };
    opt
}

pub fn parse(data: &[u8], opt: &usvg::Options) -> Result<Tree> {
    Ok(Tree::from_data(data, opt)?)
}

/// The part of the original frame that actually shows paint, found by rendering it.
/// Hidden labels, empty groups and stray art outside the artboard don't count.
fn visible_bounds(tree: &Tree) -> Option<(f32, f32, f32, f32)> {
    let size = tree.size();
    let (w0, h0) = (size.width(), size.height());
    let s = (1024.0 / w0.max(h0)).min(8.0);
    let (pw, ph) = ((w0 * s).ceil().max(1.0) as u32, (h0 * s).ceil().max(1.0) as u32);
    let mut pm = resvg::tiny_skia::Pixmap::new(pw, ph)?;
    resvg::render(tree, resvg::tiny_skia::Transform::from_scale(s, s), &mut pm.as_mut());
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let data = pm.data();
    for y in 0..ph {
        let row = &data[(y * pw * 4) as usize..((y + 1) * pw * 4) as usize];
        for x in 0..pw {
            if row[(x * 4 + 3) as usize] > 6 {
                x0 = x0.min(x);
                x1 = x1.max(x);
                y0 = y0.min(y);
                y1 = y1.max(y);
            }
        }
    }
    if x0 == u32::MAX {
        return None;
    }
    // one pixel of slack on each side for anti-aliasing
    let fx = |v: f32| (v / s).clamp(0.0, w0);
    let fy = |v: f32| (v / s).clamp(0.0, h0);
    let (ax, ay) = (fx(x0 as f32 - 1.0), fy(y0 as f32 - 1.0));
    Some((ax, ay, fx(x1 as f32 + 2.0) - ax, fy(y1 as f32 + 2.0) - ay))
}

/// Normalise a parsed tree into a self-contained SVG cropped to its artwork (+ `pad` × size).
pub fn clean(tree: &Tree, pad: f32) -> Result<Cleaned> {
    if tree.root().children().is_empty() {
        bail!("drawing has no visible content");
    }
    let Some((bx, by, bw, bh)) = visible_bounds(tree) else { bail!("drawing has no visible content") };
    if !(bw > 0.0 && bh > 0.0) {
        bail!("drawing has no visible content");
    }
    let p = bw.max(bh) * pad;
    let (x, y, w, h) = (bx - p, by - p, bw + 2.0 * p, bh + 2.0 * p);

    // ~4 significant digits relative to the icon size (0.1 unit on a 1000-unit drawing).
    let precision = (4.0f32 - w.max(h).log10().floor()).clamp(1.0, 7.0) as u8;
    let wopt = usvg::WriteOptions {
        id_prefix: None,
        // Labels stay <text>: outlining them can multiply the file size twenty-fold.
        preserve_text: true,
        coordinates_precision: precision + 2,
        transforms_precision: 6,
        use_single_quote: false,
        indent: usvg::Indent::None,
        attributes_indent: usvg::Indent::None,
    };
    let raw = compact_paths(&tree.to_string(&wopt), precision);
    let svg = retag_root(&raw, x, y, w, h)?;

    let mut acc = HashMap::new();
    let mut raster = false;
    walk(tree.root(), &mut acc, &mut raster);
    let mut colors: Vec<(Rgb, f32)> = acc.into_iter().collect();
    colors.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(Cleaned { svg, w, h, raster, colors })
}

/// Format a number at `prec` decimals with no trailing zeros or leading "0." (".5", "-.25").
fn num(v: f64, prec: u8) -> String {
    let mut s = format!("{:.*}", prec as usize, v);
    if s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    if s == "-0" || s.is_empty() {
        return "0".into();
    }
    if let Some(r) = s.strip_prefix("0.") {
        return format!(".{r}");
    }
    if let Some(r) = s.strip_prefix("-0.") {
        return format!("-.{r}");
    }
    s
}

fn push_num(out: &mut String, n: &str, prev_has_dot: &mut bool, first: bool) {
    let needs_sep = !first && !n.starts_with('-') && !(n.starts_with('.') && *prev_has_dot);
    if needs_sep {
        out.push(' ');
    }
    out.push_str(n);
    *prev_has_dot = n.contains('.');
}

/// Rewrite usvg's absolute path data ("M 10.5 20 C …") as compact relative commands.
/// Relative values are taken between *rounded* absolute points, so rounding never drifts.
pub fn compact_path(d: &str, prec: u8) -> Option<String> {
    let mut toks: Vec<(char, Vec<f64>)> = Vec::new();
    let mut it = d.split_ascii_whitespace().peekable();
    while let Some(t) = it.next() {
        let c = t.chars().next()?;
        if !c.is_ascii_alphabetic() || t.len() != 1 {
            return None;
        }
        let n = match c {
            'M' | 'L' => 2,
            'C' => 6,
            'Q' => 4,
            'Z' => 0,
            _ => return None,
        };
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            v.push(it.next()?.parse::<f64>().ok()?);
        }
        toks.push((c, v));
    }
    let k = 10f64.powi(prec as i32);
    let r = |v: f64| (v * k).round() / k;
    let mut out = String::with_capacity(d.len() / 2);
    let (mut cx, mut cy, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut last_cmd = ' ';
    let mut prev_dot = false;
    for (c, v) in toks {
        let mut emit = |out: &mut String, cmd: char, nums: &[f64], last: &mut char| {
            let mut first = false;
            if cmd != *last || cmd == 'm' {
                out.push(cmd);
                first = true;
                prev_dot = false;
            }
            for (i, n) in nums.iter().enumerate() {
                push_num(out, &num(*n, prec), &mut prev_dot, first && i == 0);
            }
            // a coordinate pair after "m" means "l"
            *last = if cmd == 'm' { 'l' } else { cmd };
        };
        match c {
            'M' => {
                let (x, y) = (r(v[0]), r(v[1]));
                emit(&mut out, 'm', &[x - cx, y - cy], &mut last_cmd);
                last_cmd = 'm';
                cx = x;
                cy = y;
                sx = x;
                sy = y;
            }
            'L' => {
                let (x, y) = (r(v[0]), r(v[1]));
                let (dx, dy) = (r(x - cx), r(y - cy));
                if dy == 0.0 {
                    emit(&mut out, 'h', &[dx], &mut last_cmd);
                } else if dx == 0.0 {
                    emit(&mut out, 'v', &[dy], &mut last_cmd);
                } else {
                    emit(&mut out, 'l', &[dx, dy], &mut last_cmd);
                }
                cx = x;
                cy = y;
            }
            'C' => {
                let p: Vec<f64> = v.iter().map(|&a| r(a)).collect();
                let rel = [p[0] - cx, p[1] - cy, p[2] - cx, p[3] - cy, p[4] - cx, p[5] - cy].map(r);
                emit(&mut out, 'c', &rel, &mut last_cmd);
                cx = p[4];
                cy = p[5];
            }
            'Q' => {
                let p: Vec<f64> = v.iter().map(|&a| r(a)).collect();
                let rel = [p[0] - cx, p[1] - cy, p[2] - cx, p[3] - cy].map(r);
                emit(&mut out, 'q', &rel, &mut last_cmd);
                cx = p[2];
                cy = p[3];
            }
            'Z' => {
                out.push('z');
                last_cmd = 'z';
                prev_dot = false;
                cx = sx;
                cy = sy;
            }
            _ => return None,
        }
    }
    Some(out)
}

/// Apply `compact_path` to every ` d="…"` attribute of an SVG document.
pub fn compact_paths(svg: &str, prec: u8) -> String {
    let mut out = String::with_capacity(svg.len() / 2);
    let mut rest = svg;
    while let Some(i) = rest.find(" d=\"") {
        let start = i + 4;
        out.push_str(&rest[..start]);
        let Some(len) = rest[start..].find('"') else { break };
        let d = &rest[start..start + len];
        match compact_path(d, prec) {
            Some(c) => out.push_str(&c),
            None => out.push_str(d),
        }
        rest = &rest[start + len..];
    }
    out.push_str(rest);
    out
}

fn fmt(v: f32) -> String {
    let s = format!("{:.3}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.to_string() }
}

/// Replace usvg's root `<svg …>` with one carrying our cropped viewBox.
fn retag_root(raw: &str, x: f32, y: f32, w: f32, h: f32) -> Result<String> {
    let Some(start) = raw.find("<svg") else { bail!("writer produced no <svg>") };
    let Some(end) = raw[start..].find('>') else { bail!("unterminated <svg>") };
    let self_closing = raw[start..start + end].ends_with('/');
    let mut out = String::with_capacity(raw.len() + 64);
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\"{}>",
        fmt(w), fmt(h), fmt(x), fmt(y), fmt(w), fmt(h),
        if self_closing { "/" } else { "" }
    ));
    out.push_str(&raw[start + end + 1..]);
    Ok(out)
}

fn add_paint(paint: &Paint, weight: f32, acc: &mut HashMap<Rgb, f32>) {
    let w = weight.max(1e-6);
    match paint {
        Paint::Color(c) => *acc.entry(Rgb::new(c.red, c.green, c.blue)).or_default() += w,
        Paint::LinearGradient(g) => {
            let n = g.stops().len().max(1) as f32;
            for s in g.stops() {
                let c = s.color();
                *acc.entry(Rgb::new(c.red, c.green, c.blue)).or_default() += w / n;
            }
        }
        Paint::RadialGradient(g) => {
            let n = g.stops().len().max(1) as f32;
            for s in g.stops() {
                let c = s.color();
                *acc.entry(Rgb::new(c.red, c.green, c.blue)).or_default() += w / n;
            }
        }
        Paint::Pattern(_) => {}
    }
}

const PAINT_ATTRS: [&str; 5] = ["fill", "stroke", "stop-color", "flood-color", "lighting-color"];

/// Visit every `#rrggbb` paint value in a cleaned SVG: calls `f(start, end)` on each span.
fn for_each_paint(svg: &str, mut f: impl FnMut(usize, usize)) {
    let b = svg.as_bytes();
    let mut i = 0;
    while let Some(off) = svg[i..].find("=\"#") {
        let at = i + off;
        let val = at + 2; // index of '#'
        let named = PAINT_ATTRS.iter().any(|a| svg[..at].ends_with(a));
        let hex_ok = val + 7 <= b.len() && b[val + 1..val + 7].iter().all(|c| c.is_ascii_hexdigit()) && b.get(val + 7) == Some(&b'"');
        if named && hex_ok {
            f(val, val + 7);
        }
        i = val + 1;
    }
}

/// The document with every paint colour blanked, and the colours in document order.
pub fn split_colors(svg: &str) -> (String, Vec<String>) {
    let mut skeleton = String::with_capacity(svg.len());
    let mut colors = Vec::new();
    let mut last = 0;
    for_each_paint(svg, |s, e| {
        skeleton.push_str(&svg[last..s]);
        skeleton.push_str("#");
        colors.push(svg[s..e].to_ascii_lowercase());
        last = e;
    });
    skeleton.push_str(&svg[last..]);
    (skeleton, colors)
}

/// Replace paint colours through `map` (keys and values are lowercase `#rrggbb`).
pub fn apply_color_map(svg: &str, map: &std::collections::BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(svg.len());
    let mut last = 0;
    for_each_paint(svg, |s, e| {
        out.push_str(&svg[last..s]);
        let c = svg[s..e].to_ascii_lowercase();
        out.push_str(map.get(&c).map(|v| v.as_str()).unwrap_or(&c));
        last = e;
    });
    out.push_str(&svg[last..]);
    out
}

/// If `variant` is `primary` with only its colours changed (consistently), the colour map.
pub fn recolor_map(primary: &str, variant: &str) -> Option<std::collections::BTreeMap<String, String>> {
    // the root tags may differ by a hair of crop; compare the drawings themselves
    let body = |s: &str| s.find("<svg").and_then(|i| s[i..].find('>').map(|j| i + j + 1)).map(|k| s[k..].to_string());
    let (ps, pc) = split_colors(&body(primary)?);
    let (vs, vc) = split_colors(&body(variant)?);
    if ps != vs || pc.len() != vc.len() {
        return None;
    }
    let mut map = std::collections::BTreeMap::new();
    for (a, b) in pc.into_iter().zip(vc) {
        match map.get(&a) {
            Some(prev) if prev != &b => return None,
            Some(_) => {}
            None => {
                map.insert(a, b);
            }
        }
    }
    map.retain(|k, v| k != v);
    Some(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recolor_detection() {
        let p = r##"<svg><path fill="#aabbcc" stroke="#000000" d="m0 0h1"/><stop stop-color="#AABBCC"/></svg>"##;
        let v = r##"<svg><path fill="#ff0000" stroke="#000000" d="m0 0h1"/><stop stop-color="#ff0000"/></svg>"##;
        let m = recolor_map(p, v).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["#aabbcc"], "#ff0000");
        assert_eq!(apply_color_map(p, &m), r##"<svg><path fill="#ff0000" stroke="#000000" d="m0 0h1"/><stop stop-color="#ff0000"/></svg>"##);
        let bad = r##"<svg><path fill="#ff0000" stroke="#000000" d="m0 0h2"/><stop stop-color="#ff0000"/></svg>"##;
        assert!(recolor_map(p, bad).is_none());
    }

    #[test]
    fn compacts_and_roundtrips() {
        let d = "M 10.5 20 L 30.25 20 L 30.25 40 C 31 41 32 42.5 33 44 Z M 0.5 0.5 L 1 1";
        let c = compact_path(d, 2).unwrap();
        assert_eq!(c, "m10.5 20h19.75v20c.75 1 1.75 2.5 2.75 4zm-10-19.5l.5.5");
        assert!(compact_path("M 1 2 A 3 4", 2).is_none());
    }
}

fn walk(g: &usvg::Group, acc: &mut HashMap<Rgb, f32>, raster: &mut bool) {
    for node in g.children() {
        match node {
            Node::Group(g) => walk(g, acc, raster),
            Node::Path(p) => {
                if !p.is_visible() {
                    continue;
                }
                let bb = p.abs_bounding_box();
                let area = (bb.width() * bb.height()).max(0.0);
                if let Some(f) = p.fill() {
                    add_paint(f.paint(), area * f.opacity().get(), acc);
                }
                if let Some(s) = p.stroke() {
                    let t = p.abs_transform();
                    let scale = (t.sx * t.sy - t.kx * t.ky).abs().sqrt();
                    let len = 2.0 * (bb.width() + bb.height());
                    add_paint(s.paint(), len * s.width().get() * scale * s.opacity().get(), acc);
                }
            }
            Node::Image(_) => *raster = true,
            Node::Text(t) => walk(t.flattened(), acc, raster),
        }
    }
}
