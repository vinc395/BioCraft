//! BioCraft for AI agents: an MCP server over stdio (`biocraft mcp`) and the matching command
//! line (`biocraft search|icon|render|guide`). Both call the same tool functions below, so an
//! agent gets the same answers whichever way it drives BioCraft.

use crate::api::AppState;
use crate::{figure, licence};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

pub const GUIDE: &str = include_str!("guide.md");

const PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "BioCraft draws scientific illustrations from a local library of ~12,000 open biology icons (~17,000 with colour and style variants). \
Loop: search_icons → get_icon (proportions, colour slots, licence) → render_figure with a JSON figure spec in millimetres \
(look at the preview, read the warnings, refine) → give the author the saved .biocraft file and open_in_biocraft. \
Call biocraft_guide once for the full spec and figure-design tips. Put the returned credits text in the figure legend.";

/// A tool's answer: JSON for the text block, plus PNG images.
pub struct Reply {
    pub json: Value,
    pub images: Vec<Vec<u8>>,
}

fn reply(json: Value) -> Reply {
    Reply { json, images: vec![] }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn arg_str<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
}

/* ---------- tools ---------- */

fn slot_summary(slots: &[biocanvas_core::Slot]) -> Vec<String> {
    slots.iter().enumerate().map(|(i, s)| format!("{i}: {} {} {}%", s.base, s.kind, (s.weight * 100.0).round())).collect()
}

fn icon_row(m: &biocanvas_core::IconMeta) -> Value {
    json!({
        "id": m.id, "name": m.name, "category": m.category, "pack": m.pack, "license": m.license,
        "author": m.author, "style": m.style, "aspect": (m.w as f64 / (m.h as f64).max(1e-3) * 100.0).round() / 100.0,
        "slots": slot_summary(&m.slots), "variants": m.variants.len(),
    })
}

/// A contact sheet of icon thumbnails, numbered in result order.
fn contact_sheet(st: &AppState, ids: &[String]) -> Result<Vec<u8>> {
    let (cols, cw, chh) = (ids.len().clamp(1, 5), 150.0, 172.0);
    let rows = ids.len().div_ceil(cols).max(1);
    let (w, h) = (cols as f64 * cw, rows as f64 * chh);
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{w}\" height=\"{h}\"><rect width=\"{w}\" height=\"{h}\" fill=\"#ffffff\"/>");
    let lib = st.lib.read().unwrap();
    for (i, id) in ids.iter().enumerate() {
        let Some(m) = lib.get(id) else { continue };
        let (x, y) = ((i % cols) as f64 * cw, (i / cols) as f64 * chh);
        if let Ok(png) = std::fs::read(lib.resolve(&m.thumb)) {
            svg += &format!("<image x=\"{}\" y=\"{}\" width=\"130\" height=\"130\" xlink:href=\"data:image/png;base64,{}\"/>", x + 10.0, y + 6.0, b64(&png));
        }
        let name: String = if m.name.chars().count() > 21 { m.name.chars().take(20).collect::<String>() + "…" } else { m.name.clone() };
        svg += &format!(
            "<text x=\"{}\" y=\"{}\" font-family=\"Arial\" font-size=\"11\" text-anchor=\"middle\" fill=\"#1c2733\"><tspan font-weight=\"700\">{}</tspan> {}</text>",
            x + cw / 2.0, y + 152.0, i + 1, xml_escape(&name)
        );
        svg += &format!("<text x=\"{}\" y=\"{}\" font-family=\"Arial\" font-size=\"10\" text-anchor=\"middle\" fill=\"#6c7682\">{}</text>", x + cw / 2.0, y + 166.0, xml_escape(&m.pack));
    }
    svg += "</svg>";
    drop(lib);
    let r = st.renderer();
    let tree = biocanvas_core::svgclean::parse(svg.as_bytes(), &r.options())?;
    let pm = r.render_scaled(&tree, 1.0, None)?;
    biocanvas_core::render::encode_png(&pm, None)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A missing library opens as an empty one; say so instead of answering "no icons".
fn need_library(st: &AppState) -> Result<()> {
    let lib = st.lib.read().unwrap();
    if lib.root.join("index.json").is_file() && !lib.index.icons.is_empty() {
        return Ok(());
    }
    bail!(
        "BioCraft icon library not found (looked in {}); set BIOCRAFT_LIBRARY to the library folder (the one holding index.json) or choose the library folder in the BioCraft app",
        lib.root.display()
    )
}

/// Does a figure spec place library icons (directly or as an icon brush)?
fn uses_icons(v: &Value) -> bool {
    v.get("objects").and_then(|o| o.as_array()).into_iter().flatten().any(|o| {
        let t = o.get("type").and_then(|t| t.as_str());
        t == Some("icon") || (t == Some("brush") && o.get("pattern").and_then(|p| p.as_str()) == Some("icon")) || uses_icons(o)
    })
}

pub fn search_icons(st: &AppState, a: &Value) -> Result<Reply> {
    need_library(st)?;
    let query = arg_str(a, "query").unwrap_or("");
    let limit = a.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).clamp(1, 100);
    let offset = a.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
    let lib = st.lib.read().unwrap();
    if let Some(c) = arg_str(a, "category") {
        if !lib.index.categories.iter().any(|x| x.id == c) {
            let ids: Vec<&str> = lib.index.categories.iter().map(|x| x.id.as_str()).collect();
            bail!("unknown category '{c}'; use one of: {}", ids.join(", "));
        }
    }
    if let Some(p) = arg_str(a, "pack") {
        if !lib.index.packs.iter().any(|x| x.id == p) {
            let ids: Vec<&str> = lib.index.packs.iter().map(|x| x.id.as_str()).collect();
            bail!("unknown pack '{p}'; use one of: {}", ids.join(", "));
        }
    }
    let license = arg_str(a, "license");
    if let Some(l) = license {
        if !["any", "free", "nosa"].contains(&l) {
            bail!("license must be 'any', 'free' (no attribution needed: CC0/public domain) or 'nosa' (no share-alike)");
        }
    }
    let base = json!({ "category": arg_str(a, "category"), "pack": arg_str(a, "pack"), "license": license });
    let run = |q: &str, off: u64, lim: u64| {
        let mut args = base.clone();
        args["q"] = json!(q);
        args["offset"] = json!(off);
        args["limit"] = json!(lim);
        lib.search(&args)
    };
    let res = run(query, offset, limit);
    let mut ids: Vec<String> = res["items"].as_array().into_iter().flatten().filter_map(|i| i["id"].as_str().map(String::from)).collect();
    let mut total = res["total"].as_u64().unwrap_or(0);
    // the library lists icons matching every word first, then ones matching the rarer words
    let full = res["full"].as_u64().unwrap_or(total);
    let mut note = match (full, total) {
        (0, t) if t > 0 => Some(format!("No icon matches every word of \"{query}\"; these match its rarer words (closest first). Try fewer or different words.")),
        (f, t) if f < t => Some(format!("The first {f} match every word of \"{query}\"; the other {} match only some of them.", t - f)),
        _ => None,
    };
    let words: Vec<&str> = query.split_whitespace().collect();
    if total == 0 && words.len() > 1 {
        // every word must match; fall back to icons matching most of the words
        let mut score: Vec<(String, usize, usize)> = Vec::new();
        for w in &words {
            let r = run(w, 0, 200);
            for (rank, it) in r["items"].as_array().into_iter().flatten().enumerate() {
                let id = it["id"].as_str().unwrap_or("").to_string();
                match score.iter_mut().find(|s| s.0 == id) {
                    Some(s) => {
                        s.1 += 1;
                        s.2 = s.2.min(rank);
                    }
                    None => score.push((id, 1, rank)),
                }
            }
        }
        score.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
        total = score.len() as u64;
        ids = score.into_iter().skip(offset as usize).take(limit as usize).map(|s| s.0).collect();
        if total > 0 {
            note = Some(format!("No icon matches every word of \"{query}\"; these match some of the words (most first). Try fewer or different words."));
        }
    }
    if total == 0 {
        let filters = ["category", "pack", "license"].iter().any(|k| arg_str(a, k).is_some_and(|v| v != "any"));
        note = Some(format!(
            "Nothing matched \"{query}\"{}. Try a broader or different word (e.g. the cell type alone){}.",
            if filters { " with these filters" } else { "" },
            if filters { ", or remove category/pack/license" } else { "" }
        ));
    }
    let items: Vec<Value> = ids.iter().filter_map(|id| lib.get(id)).map(icon_row).collect();
    drop(lib);
    let mut out = json!({ "query": query, "total": total, "full": full.min(total), "offset": offset, "items": items });
    if let Some(n) = note {
        out["note"] = json!(n);
    }
    if total > offset + limit {
        out["more"] = json!(format!("{} more — pass offset {}", total - offset - items_len(&out), offset + limit));
    }
    let mut r = reply(out);
    if a.get("preview").and_then(|v| v.as_bool()).unwrap_or(true) && !ids.is_empty() {
        r.images.push(contact_sheet(st, &ids)?);
    }
    Ok(r)
}

fn items_len(v: &Value) -> u64 {
    v["items"].as_array().map(|a| a.len() as u64).unwrap_or(0)
}

pub fn list_categories(st: &AppState) -> Result<Reply> {
    need_library(st)?;
    let lib = st.lib.read().unwrap();
    let cats: Vec<Value> = lib.index.categories.iter().filter(|c| c.count > 0).map(|c| json!({ "id": c.id, "name": c.name, "count": c.count })).collect();
    let packs: Vec<Value> = lib
        .index
        .packs
        .iter()
        .filter(|p| p.count > 0)
        .map(|p| {
            let mut lic: Vec<(String, usize)> = Vec::new();
            for m in lib.index.icons.iter().filter(|m| m.pack == p.id && !m.hidden) {
                match lic.iter_mut().find(|l| l.0 == m.license) {
                    Some(l) => l.1 += 1,
                    None => lic.push((m.license.clone(), 1)),
                }
            }
            lic.sort_by_key(|l| std::cmp::Reverse(l.1));
            json!({
                "id": p.id, "name": p.name, "count": p.count, "description": p.description, "url": p.url, "credit": p.credit,
                "licenses": lic.into_iter().map(|(l, n)| json!({ "license": l, "count": n, "attribution_required": biocanvas_core::license_info(&l).1 })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(reply(json!({
        "total": lib.index.icons.iter().filter(|m| !m.hidden).count(),
        "categories": cats, "packs": packs,
        "license_filters": { "free": "only CC0 / public domain (no attribution needed)", "nosa": "exclude share-alike (CC BY-SA)" },
    })))
}

pub fn get_icon(st: &AppState, a: &Value) -> Result<Reply> {
    let id = arg_str(a, "id").ok_or_else(|| anyhow!("missing 'id' (a library id from search_icons)"))?;
    need_library(st)?;
    let lib = st.lib.read().unwrap();
    let Some(m) = lib.get(id).cloned() else {
        let ids = figure::suggest_ids(&lib, id);
        bail!("unknown icon id '{id}'{}", if ids.is_empty() { String::new() } else { format!("; close matches: {}", ids.join(", ")) });
    };
    let data = lib.icon(id)?;
    let thumb = std::fs::read(lib.resolve(&m.thumb)).ok();
    drop(lib);
    let svg = data["svg"].as_str().unwrap_or("").to_string();
    let asset = figure::asset_from_library(&data);
    let (vb, _) = figure::asset_parts(&asset);
    let has_labels = crate::labels::has_labels(&svg);
    let li = has_labels.then(|| crate::labels::info(id, &svg, &st.renderer().options()));
    let label_texts = li.as_ref().map(|l| l.labels.clone()).unwrap_or_default();
    let (lic_name, attribution, lic_url) = biocanvas_core::license_info(&m.license);
    let doc = json!({ "objects": [{ "type": "icon", "asset": id }], "assets": { id: asset } });
    let aspect = vb[2] / vb[3];
    let mut out = json!({
        "id": m.id, "name": m.name, "pack": m.pack, "pack_name": data["pack"]["name"], "category": m.category,
        "subcategory": m.subcategory, "tags": m.tags, "description": m.description, "style": m.style,
        "author": m.author, "license": m.license, "license_name": lic_name, "attribution_required": attribution,
        "license_url": lic_url, "source_url": m.source_url, "credit": figure::legend_text(&doc),
        "aspect": (aspect * 1000.0).round() / 1000.0,
        "height_mm_at_30mm_wide": (30.0 / aspect * 10.0).round() / 10.0,
        "raster_parts": m.raster,
        "slots": m.slots.iter().enumerate().map(|(i, s)| json!({ "index": i, "base": s.base, "kind": s.kind, "weight": (s.weight as f64 * 1000.0).round() / 1000.0, "shades": s.members.len() })).collect::<Vec<_>>(),
        "has_labels": has_labels, "labels": label_texts,
        "variants": data["variants"].as_array().into_iter().flatten().map(|v| json!({ "id": v["id"], "name": v["name"] })).collect::<Vec<_>>(),
        "example": { "type": "icon", "id": m.id, "x": 10, "y": 10, "w": 30 },
    });
    if let Some(l) = li.filter(|l| l.hidden_inner.is_some()) {
        out["example"]["labels"] = json!("hide");
        out["aspect_labels_hidden"] = json!((l.hidden_vb[2] / l.hidden_vb[3] * 1000.0).round() / 1000.0);
    }
    if a.get("include_svg").and_then(|v| v.as_bool()).unwrap_or(false) {
        out["svg"] = json!(svg);
    }
    let mut r = reply(out);
    if a.get("preview").and_then(|v| v.as_bool()).unwrap_or(true) {
        if let Some(t) = thumb {
            r.images.push(t);
        }
    }
    Ok(r)
}

/// Resolve a path against the working directory (MCP servers run in the client's project).
fn absolute(p: &str) -> PathBuf {
    let p = PathBuf::from(p);
    std::path::absolute(&p).unwrap_or(p)
}

/// The user's Documents folder (follows OneDrive/redirected folders on Windows).
pub fn documents_dir() -> PathBuf {
    #[cfg(windows)]
    if let Some(p) = win::documents() {
        return p;
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
    if home.join("Documents").is_dir() { home.join("Documents") } else { home }
}

fn load_figure(a: &Value) -> Result<Value> {
    if let Some(f) = a.get("figure").filter(|v| !v.is_null()) {
        return match f {
            Value::String(s) if s.trim_start().starts_with('{') => serde_json::from_str(s).context("'figure' is not valid JSON"),
            Value::String(s) => read_json(&absolute(s)),
            v => Ok(v.clone()),
        };
    }
    match arg_str(a, "figure_path") {
        Some(p) => read_json(&absolute(p)),
        None => bail!("give 'figure' (the figure spec object) or 'figure_path' (a .json spec or .biocraft file)"),
    }
}

fn read_json(p: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))?;
    serde_json::from_str(&text).with_context(|| format!("{} is not valid JSON", p.display()))
}

fn write_file(p: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    std::fs::write(p, bytes).with_context(|| format!("writing {}", p.display()))
}

fn ext(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

/* Figures saved by default go to Documents/BioCraft figures. A default save may replace only a
   draft this tool wrote and nobody has changed since, so the tool remembers what it wrote
   (path → digest of the bytes) in the data folder, across MCP sessions and CLI runs. */

/// FNV-1a: stable across builds, unlike std's hasher, so later runs recognise earlier drafts.
fn digest(bytes: &[u8]) -> String {
    let h = bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x0100_0000_01b3));
    format!("{h:016x}")
}

fn saves_file(st: &AppState) -> PathBuf {
    st.data_dir.join("agent-saves.json")
}

fn read_saves(st: &AppState) -> serde_json::Map<String, Value> {
    std::fs::read(saves_file(st)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn remember_save(st: &AppState, p: &Path, bytes: &[u8]) {
    let mut saves = read_saves(st);
    saves.retain(|k, _| Path::new(k).is_file());
    saves.insert(p.display().to_string(), json!(digest(bytes)));
    let _ = std::fs::create_dir_all(&st.data_dir);
    let _ = std::fs::write(saves_file(st), serde_json::to_vec_pretty(&saves).unwrap_or_default());
}

/// `<dir>/<slug>.biocraft`, or `<slug>-2.biocraft`, … when that file is someone else's; plus a
/// note when the name had to change.
fn default_save_in(dir: &Path, slug: &str, saves: &serde_json::Map<String, Value>) -> (PathBuf, Option<String>) {
    let first = dir.join(format!("{slug}.biocraft"));
    for n in 1..1000 {
        let p = if n == 1 { first.clone() } else { dir.join(format!("{slug}-{n}.biocraft")) };
        let ours = || std::fs::read(&p).is_ok_and(|b| saves.get(&p.display().to_string()).and_then(|v| v.as_str()) == Some(digest(&b).as_str()));
        if !p.exists() || ours() {
            let note = (n > 1).then(|| format!("{} already exists and was not written by this tool or was edited since, so this figure was saved as {} (pass 'save' to choose the file)", first.display(), p.display()));
            return (p, note);
        }
    }
    (dir.join(format!("{slug}-{}.biocraft", std::process::id())), None)
}

pub fn render_figure(st: &AppState, a: &Value) -> Result<Reply> {
    let fig = load_figure(a)?;
    // check every argument before anything is written
    let out_path = arg_str(a, "out").map(absolute);
    let fmt = match &out_path {
        Some(p) => Some(match ext(p).as_str() {
            "png" => "png",
            "tif" | "tiff" => "tiff",
            "pdf" => "pdf",
            "svg" => "svg",
            e => bail!("'out' must end in .png, .tiff, .pdf or .svg (got '.{e}'); nothing was written"),
        }),
        None => None,
    };
    let dpi = match a.get("dpi").filter(|v| !v.is_null()) {
        None => 300.0,
        Some(v) => match v.as_f64() {
            Some(d) if (30.0..=2400.0).contains(&d) => d as f32,
            _ => bail!("'dpi' must be a number from 30 to 2400 (300 is usual for journals), got {v}; nothing was written"),
        },
    };
    let transparent = match a.get("transparent") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(v) => bail!("'transparent' must be true or false, got {v}"),
    };
    let save_arg = arg_str(a, "save").map(absolute);
    if let Some(p) = &save_arg {
        if !["biocraft", "biocanvas", "json"].contains(&ext(p).as_str()) {
            bail!("'save' should end in .biocraft (got {}); use 'out' for PNG/TIFF/PDF/SVG; nothing was written", p.display());
        }
    }
    // a licence & attribution report: beside 'out' (or the saved figure), or at its own path
    let report_path = arg_str(a, "licence_report_path").or_else(|| arg_str(a, "license_report_path")).map(absolute);
    if let Some(p) = &report_path {
        if !["pdf", "md", "csv", ""].contains(&ext(p).as_str()) {
            bail!("'licence_report_path' should end in .pdf (the .md and .csv are written beside it), got {}; nothing was written", p.display());
        }
    }
    let report = report_path.is_some()
        || match a.get("licence_report").or_else(|| a.get("license_report")) {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(v) => bail!("'licence_report' must be true or false, got {v}; nothing was written"),
        };
    let is_doc = figure::is_document(&fig);
    let r = st.renderer();
    let (doc, warnings) = if is_doc {
        figure::check_document(&fig)?;
        let w = figure::review(&fig, r);
        (fig, w)
    } else {
        if uses_icons(&fig) {
            need_library(st)?;
        }
        let c = figure::compose(st, &fig)?;
        (c.doc, c.warnings)
    };
    let exported = match (&out_path, fmt) {
        (Some(p), Some(fmt)) => Some((p, fmt, figure::export(&doc, r, fmt, dpi, transparent)?)),
        _ => None,
    };
    // the editable figure: where asked; a new figure also goes to Documents/BioCraft figures
    let mut out = json!({});
    let save = match save_arg {
        Some(p) => Some((p, None, false)),
        None if is_doc => None,
        None => {
            let title = doc.get("title").and_then(|t| t.as_str()).unwrap_or("figure");
            let slug = biocanvas_core::library::slugify(title);
            let (p, note) = default_save_in(&crate::gallery::root(st), if slug.is_empty() { "figure" } else { &slug }, &read_saves(st));
            Some((p, note, true))
        }
    };
    match save {
        Some((p, note, default)) => {
            let bytes = serde_json::to_string(&doc)?.into_bytes();
            write_file(&p, &bytes)?;
            // only default drafts are tracked: an explicit 'save' is the agent's own choice
            if default {
                remember_save(st, &p, &bytes);
            }
            out["saved"] = json!(p.display().to_string());
            if let Some(n) = note {
                out["save_note"] = json!(n);
            }
        }
        None => {
            out["saved"] = Value::Null;
            if let Some(p) = arg_str(a, "figure_path") {
                out["document"] = json!(absolute(p).display().to_string());
            }
            out["save_note"] = json!("Not saved: the input is already a BioCraft document. Pass 'save' to write a copy.");
        }
    }
    if let Some((path, fmt, bytes)) = exported {
        write_file(path, &bytes)?;
        out["out"] = json!(path.display().to_string());
        let raster = fmt == "png" || fmt == "tiff";
        out["out_format"] = json!(if raster { format!("{fmt} at {dpi} dpi{}", if transparent { ", transparent" } else { "" }) } else { fmt.to_string() });
    }
    if report {
        let beside = out_path.clone().or_else(|| out["saved"].as_str().map(PathBuf::from)).or_else(|| arg_str(a, "figure_path").map(absolute));
        let paths = match (&report_path, beside) {
            (Some(p), _) => licence::paths_for(p),
            (None, Some(b)) => licence::paths_beside(&b),
            (None, None) => bail!("say where the licence report goes: pass 'out', 'save' or 'licence_report_path'"),
        };
        let title = doc
            .get("title")
            .and_then(|t| t.as_str())
            .filter(|t| !t.trim().is_empty())
            .map(String::from)
            .or_else(|| out_path.as_ref().and_then(|p| p.file_stem()).map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_else(|| "figure".into());
        let publication = licence::Publication::from_json(a.get("publication").filter(|v| !v.is_null()).or_else(|| doc.get("publication")));
        let header = licence::Header {
            title,
            exported_at: licence::now(),
            export: licence::export_line(fmt.unwrap_or(""), dpi as f64, doc["width"].as_f64().unwrap_or(0.0), doc["height"].as_f64().unwrap_or(0.0)),
            prepared_by: arg_str(a, "prepared_by").unwrap_or("").to_string(),
            figure_svg: Some(figure::Painter::new(&doc, r).document(Some(figure::background(&doc).unwrap_or("#ffffff")))),
            publication,
        };
        let check = licence::publication_check(&licence::facts(&doc), &header.publication);
        let rep = licence::build(&doc, &header, r)?;
        out["licence_report"] = json!(rep.write(&paths)?);
        out["figure_id"] = json!(rep.figure_id);
        if let Some((warn, text)) = check {
            out["publication_check"] = json!({ "ok": !warn, "text": text });
        }
    }
    let mut used = Vec::new();
    figure::assets_used(doc["objects"].as_array().map(|v| v.as_slice()).unwrap_or(&[]), &mut used);
    out["size_mm"] = json!([doc["width"], doc["height"]]);
    out["objects"] = json!(doc["objects"].as_array().map(|v| v.len()).unwrap_or(0));
    out["icons"] = json!(used);
    out["warnings"] = json!(warnings);
    out["credits"] = json!(figure::legend_text(&doc));
    out["licenses"] = json!(figure::licences(&doc));
    out["next"] = json!("Look at the preview; fix any warnings; when it reads well, call open_in_biocraft with the .biocraft path so the author can refine it, and put 'credits' in the figure legend.");
    let mut rep = reply(out);
    if a.get("preview").and_then(|v| v.as_bool()).unwrap_or(true) {
        rep.images.push(figure::preview(&doc, r, 1200.0)?);
    }
    Ok(rep)
}

/// Start the desktop app on a figure, detached from this process and its pipes.
pub fn open_in_biocraft(a: &Value) -> Result<Reply> {
    let p = absolute(arg_str(a, "path").ok_or_else(|| anyhow!("missing 'path' to a .biocraft file"))?);
    if !p.is_file() {
        bail!("{} does not exist; render_figure returns the saved path", p.display());
    }
    if !["biocraft", "biocanvas", "json"].contains(&ext(&p).as_str()) {
        bail!("BioCraft opens .biocraft figures (got {})", p.display());
    }
    let doc = read_json(&p).map_err(|e| anyhow!("{e:#}: not a BioCraft figure"))?;
    if !figure::is_document(&doc) {
        bail!("{} is a figure spec, not a BioCraft document: render it with render_figure (figure_path) and open the .biocraft file it saves", p.display());
    }
    figure::check_document(&doc)?;
    launch_app(&p)?;
    Ok(reply(json!({ "opened": p.display().to_string(), "note": "BioCraft is starting with the figure; the author can edit and export it there." })))
}

pub fn launch_app(p: &Path) -> Result<()> {
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe()?;
    let make = || {
        let mut c = Command::new(&exe);
        c.arg(p).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // the app must not hold the agent's stdio pipes open (that would hang its client)
        win::keep_std_handles();
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // outlive the agent's job object where allowed
        let first = make().creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB).spawn();
        if first.is_err() {
            make().creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).spawn().context("starting BioCraft")?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        make().process_group(0).spawn().context("starting BioCraft")?;
    }
    Ok(())
}

/* ---------- MCP (JSON-RPC 2.0 over newline-delimited stdio) ---------- */

fn figure_schema() -> Value {
    let pt = json!({ "type": "array", "items": { "type": "number" }, "description": "[x, y] in mm" });
    json!({
        "type": "object",
        "description": "Figure spec in millimetres (origin top-left, y down): width_mm, height_mm and objects are required. Objects draw in order, first at the back. Full reference: biocraft_guide. To re-render a saved .biocraft, pass figure_path instead.",
        "properties": {
            "width_mm": { "type": "number", "description": "Page width: 85, 114 or 178 for journal columns" },
            "height_mm": { "type": "number" },
            "background": { "type": "string", "description": "Hex colour (default #ffffff), or \"none\" for no background (PNG/TIFF exports are still white unless render_figure's transparent is true)" },
            "title": { "type": "string", "description": "Names the saved file" },
            "objects": {
                "type": "array",
                "items": {
                    "type": "object",
                    "description": "icon {id, x, y | cx, cy, w | h, rotate, flip, colors | tint | grayscale, labels: show|hide}; \
text {text, x, y, size_pt, color, bold, italic, align, font, rotate}; arrow|inhibit|line {from, to, curve_mm, head, tail, color, width_pt, dash}; \
rect|ellipse {x, y | cx, cy, w, h, fill, stroke, stroke_pt, radius_mm, dash, rotate}; \
brush {pattern, points, closed, thickness_mm, icon, colors, side, apical}; group {objects}. All take name and opacity.",
                    "properties": {
                        "type": { "type": "string", "enum": ["icon", "text", "arrow", "inhibit", "line", "rect", "ellipse", "brush", "group"] },
                        "id": { "type": "string", "description": "icon: library id from search_icons" },
                        "x": { "type": "number" }, "y": { "type": "number" }, "cx": { "type": "number" }, "cy": { "type": "number" },
                        "w": { "type": "number" }, "h": { "type": "number" },
                        "text": { "type": "string" }, "size_pt": { "type": "number" },
                        "from": pt, "to": pt,
                        "points": { "type": "array", "items": pt },
                        "pattern": { "type": "string", "enum": ["bilayer", "dna", "rna", "cuboidal", "columnar", "squamous", "actin", "microtubule", "collagen", "icon"] },
                        "objects": { "type": "array", "items": { "type": "object" } }
                    },
                    "required": ["type"]
                }
            }
        }
    })
}

fn tools() -> Value {
    json!([
        {
            "name": "search_icons",
            "title": "Search BioCraft icons",
            "description": "Search the local library of ~12,000 open scientific icons (Servier Medical Art, NIH BioArt, Reactome, Bioicons, DBCLS TogoTV, PhyloPic, Health Icons, BioCraft Originals) by plain words, e.g. 'macrophage', 'synovial joint', 'T cell', 'antibody', 'mouse'. All words must match (synonyms count); if none do, icons matching some of the words are returned. Each hit has its id (use it in render_figure), name, category, pack, licence, author, style (soft = Servier-like shading, line = NIH-like outlines), aspect (width/height) and colour slots. Returns a numbered contact sheet image of the hits unless preview is false.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Plain words; empty browses a category or pack" },
                    "category": { "type": "string", "description": "Category id from list_categories, e.g. immune-cells, cells, anatomy, tissues, proteins, nucleic-acids, lab" },
                    "pack": { "type": "string", "description": "servier, nih, reactome, bioicons, dbcls, phylopic, healthicons, biocanvas (BioCraft Originals)" },
                    "license": { "type": "string", "enum": ["any", "free", "nosa"], "description": "free = no attribution needed (CC0/public domain); nosa = no share-alike" },
                    "limit": { "type": "integer", "description": "Default 20, max 100" },
                    "offset": { "type": "integer", "description": "For paging" },
                    "preview": { "type": "boolean", "description": "Contact sheet of the hits (default true)" }
                },
                "required": ["query"]
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "list_categories",
            "title": "List icon categories and sources",
            "description": "The library's categories (with icon counts) and its sources (packs) with their licences and the credit each requires.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "get_icon",
            "title": "Inspect an icon",
            "description": "Everything needed to place an icon well: name, licence and credit line, aspect ratio (width/height) and the height it has at 30 mm wide, its colour slots in order (index, base colour, kind: color/dark/light, weight = share of the drawing) for the 'colors' field of render_figure, whether it carries its own text labels (hide them with labels: 'hide'), colour/style variants, and its thumbnail image.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Library id, e.g. servier/macrophage" },
                    "preview": { "type": "boolean", "description": "Include the thumbnail image (default true)" },
                    "include_svg": { "type": "boolean", "description": "Include the cleaned SVG markup (default false; can be large)" }
                },
                "required": ["id"]
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "render_figure",
            "title": "Draw a figure",
            "description": "Draw a scientific figure from a JSON spec in millimetres (icons from the library, text, activation arrows, inhibition lines, shapes, membrane/DNA/cell brushes, groups) exactly as the BioCraft app draws it. Saves an editable .biocraft file (to 'save', else Documents/BioCraft figures/<title>.biocraft without replacing anyone else's file), optionally exports 'out' (.png/.tiff with DPI, vector .pdf, .svg), and returns warnings (unknown icon ids, objects off the page, overlapping or tiny text, built-in icon labels), the figure-legend credit text, the licences used, and a preview image to check and iterate on. With licence_report it also writes a licence & attribution report (PDF, Markdown, CSV) beside the export. Spec errors name the exact field to fix. Call biocraft_guide for the full spec and design tips. To re-render or export a saved .biocraft (e.g. after the author edited it), pass figure_path; it is not re-saved unless 'save' is given.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "figure": figure_schema(),
                    "figure_path": { "type": "string", "description": "Instead of 'figure': path to a .json spec or a .biocraft file" },
                    "save": { "type": "string", "description": "Path for the editable .biocraft file (replaced if it exists). Default for a new figure: Documents/BioCraft figures/<title>.biocraft, never replacing a file this tool did not write" },
                    "out": { "type": "string", "description": "Export path ending in .png, .tiff, .pdf or .svg" },
                    "dpi": { "type": "number", "description": "Raster export resolution, 30–2400 (default 300)" },
                    "transparent": { "type": "boolean", "description": "PNG/TIFF without any background (default false: flattened onto the figure's background, white if it has none)" },
                    "preview": { "type": "boolean", "description": "Return a preview PNG about 1200 px wide (default true)" },
                    "licence_report": { "type": "boolean", "description": "Also write a licence & attribution report: <out name>-licence.pdf (A4), .md and .csv beside 'out' (beside the saved .biocraft when there is no 'out'), listing every icon with its source, author and licence, what the licences ask (credit, share-alike, notices), the changes made to each icon, and the figure-legend credit. BioCraft grants no licence; the report documents the icons' own. Default false" },
                    "licence_report_path": { "type": "string", "description": "Write the licence report here instead: a .pdf path (the .md and .csv go beside it). Implies licence_report" },
                    "prepared_by": { "type": "string", "description": "Name printed on the licence report as 'Prepared by' (optional)" },
                    "publication": {
                        "type": "object",
                        "description": "Where the figure will be published, printed on the licence report and checked against the icons' licences (the result's publication_check says whether they fit, e.g. share-alike icons in a CC BY article). All fields optional",
                        "properties": {
                            "journal": { "type": "string" },
                            "manuscript": { "type": "string", "description": "Manuscript number" },
                            "figure_title": { "type": "string", "description": "The figure's title as in the manuscript, e.g. 'Figure 2 | Synovial immune landscape'" },
                            "open_access": { "type": "string", "enum": ["cc-by", "oa-other", "subscription", ""], "description": "cc-by = open access under CC BY; oa-other = open access under another licence; subscription = copyright transfer or exclusive licence" },
                            "date": { "type": "string", "description": "Expected publication date" }
                        }
                    }
                }
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "open_in_biocraft",
            "title": "Open in BioCraft",
            "description": "Open a saved .biocraft figure in the BioCraft desktop app so the author can refine, recolour and export it.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "The .biocraft file (render_figure returns it as 'saved')" } },
                "required": ["path"]
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "biocraft_guide",
            "title": "BioCraft figure guide",
            "description": "The figure spec reference (every object type and field) and figure-design advice: journal sizes, grid, font sizes, activation vs inhibition arrows, consistent icon scale, the colour-blind-safe Okabe-Ito palette, credits and licences, and the recommended search → inspect → render → refine → open loop. Read it before the first render_figure.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        }
    ])
}

/// Run one tool by name (the library opens only for the tools that need it).
fn call(st: &Lazy, name: &str, a: &Value) -> Result<Reply> {
    match name {
        "search_icons" => search_icons(st.get(), a),
        "list_categories" => list_categories(st.get()),
        "get_icon" => get_icon(st.get(), a),
        "render_figure" => render_figure(st.get(), a),
        "open_in_biocraft" => open_in_biocraft(a),
        "biocraft_guide" => Ok(Reply { json: Value::String(GUIDE.to_string()), images: vec![] }),
        _ => Err(anyhow!("unknown tool '{name}'")),
    }
}

fn rpc_error(id: Value, code: i64, msg: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } })
}

/// The library opens on first use, so `initialize` answers at once.
pub struct Lazy {
    state: OnceLock<Arc<AppState>>,
    open: Box<dyn Fn() -> AppState + Send + Sync>,
}

impl Lazy {
    pub fn new(open: impl Fn() -> AppState + Send + Sync + 'static) -> Self {
        Lazy { state: OnceLock::new(), open: Box::new(open) }
    }
    pub fn get(&self) -> &AppState {
        self.state.get_or_init(|| {
            let st = (self.open)();
            let lib = st.lib.read().unwrap();
            let found = if lib.root.join("index.json").is_file() { "" } else { ", NOT FOUND: set BIOCRAFT_LIBRARY" };
            eprintln!("biocraft mcp: icon library {} ({} icons{found})", lib.root.display(), lib.index.icons.len());
            drop(lib);
            Arc::new(st)
        })
    }
}

fn handle(st: &Lazy, msg: &Value) -> Option<Value> {
    if let Value::Array(batch) = msg {
        let out: Vec<Value> = batch.iter().filter_map(|m| handle(st, m)).collect();
        return (!out.is_empty()).then_some(Value::Array(out));
    }
    let id = msg.get("id").cloned();
    let Some(method) = msg.get("method").and_then(|m| m.as_str()) else {
        // a response to a request we never send, or garbage
        return id.filter(|_| msg.get("result").is_none() && msg.get("error").is_none()).map(|id| rpc_error(id, -32600, "invalid request"));
    };
    let id = id?; // notifications (initialized, cancelled, …) need no answer
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
            let version = if PROTOCOLS.contains(&asked) { asked } else { PROTOCOLS[0] };
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "biocraft", "title": "BioCraft", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(|n| n.as_str()) else {
                return Some(rpc_error(id, -32602, "tools/call needs a tool 'name'"));
            };
            if !tools().as_array().unwrap().iter().any(|t| t["name"] == name) {
                return Some(rpc_error(id, -32602, &format!("unknown tool: {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            eprintln!("biocraft mcp: {name}");
            // a bug in one drawing must not take the server down
            let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(st, name, &args)));
            match run.unwrap_or_else(|_| Err(anyhow!("BioCraft hit an internal error drawing this; try simpler input and report it"))) {
                Ok(r) => {
                    let text = match &r.json {
                        Value::String(s) => s.clone(),
                        v => serde_json::to_string_pretty(v).unwrap_or_default(),
                    };
                    let mut content = vec![json!({ "type": "text", "text": text })];
                    content.extend(r.images.iter().map(|png| json!({ "type": "image", "data": b64(png), "mimeType": "image/png" })));
                    json!({ "content": content, "isError": false })
                }
                Err(e) => {
                    eprintln!("biocraft mcp: {name} failed: {e:#}");
                    json!({ "content": [{ "type": "text", "text": format!("Error: {e:#}") }], "isError": true })
                }
            }
        }
        m => return Some(rpc_error(id, -32601, &format!("method not found: {m}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// `biocraft mcp`: serve until stdin closes. Only protocol messages go to stdout.
pub fn serve_mcp(st: Lazy) -> i32 {
    eprintln!("biocraft mcp: ready (BioCraft {})", env!("CARGO_PKG_VERSION"));
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(&st, &msg),
            Err(e) => Some(rpc_error(Value::Null, -32700, &format!("parse error: {e}"))),
        };
        if let Some(r) = resp {
            if writeln!(out, "{r}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
    0
}

/* ---------- command line ---------- */

pub const USAGE: &str = "BioCraft — local scientific illustration

Usage:
  biocraft                         start the desktop app
  biocraft <figure.biocraft>       open a figure in the desktop app
  biocraft --serve [port]          the app in a web browser (default port 8780)
  biocraft search <words> [--category c] [--pack p] [--license any|free|nosa] [--limit n] [--offset n] [--sheet sheet.png]
  biocraft icon <id> [--svg out.svg] [--png out.png]
  biocraft render <spec.json|figure.biocraft|-> [--out fig.png|tiff|pdf|svg] [--save fig.biocraft] [--dpi 300] [--transparent] [--preview preview.png]
                  [--licence[=report.pdf]] [--prepared-by name]   licence & attribution report (PDF, Markdown, CSV) beside the export
                  [--journal name] [--manuscript id] [--figure-title t] [--open-access cc-by|oa-other|subscription] [--publication-date d]
  biocraft guide                   the figure spec and design guide for AI agents
  biocraft mcp                     MCP server on stdio for AI agents (Claude Code, Codex, Cursor, Gemini CLI…)
  biocraft --help | --version

search, icon and render print JSON. Library: $BIOCRAFT_LIBRARY, the folder chosen in the app, or library/ beside the program.";

/// Split `args` into positionals, `--flag value` options and `--switch`es.
fn parse(args: &[String]) -> (Vec<String>, std::collections::HashMap<String, String>) {
    const SWITCHES: [&str; 3] = ["transparent", "licence", "license"];
    let (mut pos, mut opts) = (Vec::new(), std::collections::HashMap::new());
    let mut i = 0;
    while i < args.len() {
        if let Some(k) = args[i].strip_prefix("--") {
            if let Some((k, v)) = k.split_once('=') {
                opts.insert(k.to_string(), v.to_string());
            } else if SWITCHES.contains(&k) {
                opts.insert(k.to_string(), "true".into());
            } else {
                opts.insert(k.to_string(), args.get(i + 1).cloned().unwrap_or_default());
                i += 1;
            }
        } else {
            pos.push(args[i].clone());
        }
        i += 1;
    }
    (pos, opts)
}

fn print_json(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

/// `biocraft <subcommand> …`; None when the arguments are for the app itself.
pub fn cli(args: &[String], open: impl Fn() -> AppState + Send + Sync + 'static) -> Option<i32> {
    let cmd = args.get(1)?.as_str();
    if !matches!(cmd, "search" | "icon" | "render" | "guide" | "mcp" | "help" | "--help" | "-h" | "--version" | "-V") {
        return None;
    }
    if cmd == "mcp" {
        return Some(serve_mcp(Lazy::new(open)));
    }
    #[cfg(windows)]
    win::attach_console();
    let (pos, opts) = parse(&args[2..]);
    let res: Result<Option<Reply>> = (|| match cmd {
        "--help" | "-h" | "help" => {
            println!("{USAGE}");
            Ok(None)
        }
        "--version" | "-V" => {
            println!("biocraft {}", env!("CARGO_PKG_VERSION"));
            Ok(None)
        }
        "guide" => {
            println!("{GUIDE}");
            Ok(None)
        }
        "search" => {
            let st = open();
            let mut a = json!({ "query": pos.join(" "), "preview": opts.contains_key("sheet") });
            for k in ["category", "pack", "license"] {
                if let Some(v) = opts.get(k) {
                    a[k] = json!(v);
                }
            }
            for k in ["limit", "offset"] {
                if let Some(v) = opts.get(k) {
                    a[k] = json!(v.parse::<u64>().map_err(|_| anyhow!("--{k} needs a number"))?);
                }
            }
            let mut r = search_icons(&st, &a)?;
            if let (Some(p), Some(png)) = (opts.get("sheet"), r.images.first()) {
                write_file(&absolute(p), png)?;
                r.json["sheet"] = json!(absolute(p).display().to_string());
            }
            Ok(Some(r))
        }
        "icon" => {
            let st = open();
            let id = pos.first().ok_or_else(|| anyhow!("usage: biocraft icon <id> [--svg out.svg] [--png out.png]"))?;
            let mut r = get_icon(&st, &json!({ "id": id, "include_svg": opts.contains_key("svg"), "preview": false }))?;
            if let Some(p) = opts.get("svg") {
                let svg = r.json["svg"].as_str().unwrap_or("").to_string();
                write_file(&absolute(p), svg.as_bytes())?;
                r.json["svg"] = json!(absolute(p).display().to_string());
            }
            if let Some(p) = opts.get("png") {
                let lib = st.lib.read().unwrap();
                let data = lib.icon(id)?;
                drop(lib);
                let rend = st.renderer();
                let tree = biocanvas_core::svgclean::parse(data["svg"].as_str().unwrap_or("").as_bytes(), &rend.options())?;
                let size = tree.size();
                let px: f32 = opts.get("size").and_then(|s| s.parse().ok()).unwrap_or(512.0);
                let pm = rend.render_scaled(&tree, px / size.width().max(size.height()), None)?;
                write_file(&absolute(p), &biocanvas_core::render::encode_png(&pm, None)?)?;
                r.json["png"] = json!(absolute(p).display().to_string());
            }
            Ok(Some(r))
        }
        "render" => {
            let st = open();
            let src = pos.first().ok_or_else(|| anyhow!("usage: biocraft render <spec.json|figure.biocraft|-> [--out fig.png] [--save fig.biocraft] [--dpi 300]"))?;
            let mut a = json!({ "preview": opts.contains_key("preview"), "transparent": opts.get("transparent").is_some_and(|v| v != "false") });
            if src == "-" {
                let mut s = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)?;
                a["figure"] = serde_json::from_str(&s).context("stdin is not valid JSON")?;
            } else {
                a["figure_path"] = json!(src);
            }
            for k in ["out", "save"] {
                if let Some(v) = opts.get(k) {
                    a[k] = json!(v);
                }
            }
            if let Some(d) = opts.get("dpi") {
                a["dpi"] = json!(d.parse::<f64>().map_err(|_| anyhow!("--dpi needs a number"))?);
            }
            match opts.get("licence").or_else(|| opts.get("license")).map(|s| s.as_str()) {
                None | Some("false") => {}
                Some("true") | Some("") => a["licence_report"] = json!(true),
                Some(p) => a["licence_report_path"] = json!(p),
            }
            if let Some(v) = opts.get("prepared-by") {
                a["prepared_by"] = json!(v);
            }
            let mut publication = serde_json::Map::new();
            for (flag, key) in [("journal", "journal"), ("manuscript", "manuscript"), ("figure-title", "figure_title"), ("open-access", "open_access"), ("publication-date", "date")] {
                if let Some(v) = opts.get(flag) {
                    publication.insert(key.into(), json!(v));
                }
            }
            if !publication.is_empty() {
                a["publication"] = Value::Object(publication);
            }
            let mut r = render_figure(&st, &a)?;
            if let (Some(p), Some(png)) = (opts.get("preview"), r.images.first()) {
                write_file(&absolute(p), png)?;
                r.json["preview"] = json!(absolute(p).display().to_string());
            }
            Ok(Some(r))
        }
        _ => unreachable!(),
    })();
    Some(match res {
        Ok(Some(r)) => {
            print_json(&r.json);
            0
        }
        Ok(None) => 0,
        Err(e) => {
            print_json(&json!({ "error": format!("{e:#}") }));
            eprintln!("error: {e:#}");
            1
        }
    })
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::path::PathBuf;

    #[repr(C)]
    struct Guid(u32, u16, u16, [u8; 8]);
    const FOLDERID_DOCUMENTS: Guid = Guid(0xFDD3_9AD0, 0x238F, 0x46AF, [0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7]);

    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> *mut c_void;
        fn AttachConsole(pid: u32) -> i32;
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
    }

    /// Rust starts every child with handle inheritance on, so a launched app would also inherit
    /// our stdin/stdout/stderr (the MCP client's pipes) and keep them open after we exit.
    pub fn keep_std_handles() {
        const HANDLE_FLAG_INHERIT: u32 = 1;
        for which in [-10i32, -11, -12] {
            unsafe {
                let h = GetStdHandle(which as u32);
                if !h.is_null() && h as isize != -1 {
                    SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: *mut c_void, path: *mut *mut u16) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoTaskMemFree(p: *mut c_void);
    }

    /// Release builds are GUI programs with no console: borrow the parent's (a terminal) so
    /// output shows — unless stdout is already redirected to a pipe or file.
    pub fn attach_console() {
        const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        unsafe {
            let h = GetStdHandle(STD_OUTPUT_HANDLE);
            if h.is_null() || h as isize == -1 {
                AttachConsole(ATTACH_PARENT_PROCESS);
            }
        }
    }

    pub fn documents() -> Option<PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        unsafe {
            let mut p: *mut u16 = std::ptr::null_mut();
            if SHGetKnownFolderPath(&FOLDERID_DOCUMENTS, 0, std::ptr::null_mut(), &mut p) != 0 || p.is_null() {
                return None;
            }
            let mut len = 0;
            while *p.add(len) != 0 {
                len += 1;
            }
            let s = std::ffi::OsString::from_wide(std::slice::from_raw_parts(p, len));
            CoTaskMemFree(p as *mut c_void);
            Some(PathBuf::from(s))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lazy() -> Lazy {
        Lazy::new(|| panic!("protocol messages must not open the library"))
    }

    #[test]
    fn handshake_and_errors() {
        let st = lazy();
        let init = |v: &str| handle(&st, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": v } })).unwrap();
        assert_eq!(init("2025-03-26")["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init("1999-01-01")["result"]["protocolVersion"], "2025-06-18");
        let r = init("2025-06-18");
        assert_eq!(r["result"]["capabilities"], json!({ "tools": {} }));
        assert_eq!(r["result"]["serverInfo"]["name"], "biocraft");
        assert!(handle(&st, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        assert_eq!(handle(&st, &json!({ "jsonrpc": "2.0", "id": "p", "method": "ping" })).unwrap(), json!({ "jsonrpc": "2.0", "id": "p", "result": {} }));
        assert_eq!(handle(&st, &json!({ "jsonrpc": "2.0", "id": 2, "method": "prompts/list" })).unwrap()["error"]["code"], -32601);
        assert_eq!(handle(&st, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "nope" } })).unwrap()["error"]["code"], -32602);
        // the guide needs no library
        let g = handle(&st, &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "biocraft_guide", "arguments": {} } })).unwrap();
        assert_eq!(g["result"]["isError"], false);
        assert!(g["result"]["content"][0]["text"].as_str().unwrap().contains("## Figure spec"));
    }

    #[test]
    fn tool_schemas() {
        let t = tools();
        let names: Vec<&str> = t.as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["search_icons", "list_categories", "get_icon", "render_figure", "open_in_biocraft", "biocraft_guide"]);
        for x in t.as_array().unwrap() {
            assert_eq!(x["inputSchema"]["type"], "object", "{}", x["name"]);
            assert!(x["description"].as_str().unwrap().len() > 60);
        }
    }

    #[test]
    fn cli_arguments() {
        let a: Vec<String> = ["synovial", "fibroblast", "--limit", "5", "--pack=servier"].iter().map(|s| s.to_string()).collect();
        let (pos, opts) = parse(&a);
        assert_eq!(pos, ["synovial", "fibroblast"]);
        assert_eq!((opts["limit"].as_str(), opts["pack"].as_str()), ("5", "servier"));
        assert!(cli(&["biocraft".into(), "--serve".into()], || panic!()).is_none());
        assert!(cli(&["biocraft".into(), "figure.biocraft".into()], || panic!()).is_none());
    }

    #[test]
    fn documents_folder_exists() {
        assert!(documents_dir().is_dir(), "{}", documents_dir().display());
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("biocraft-agent-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn default_saves_never_replace_other_files() {
        let dir = scratch("saves");
        let st = AppState::new(biocanvas_core::Library::open(&dir.join("nolib"), &dir.join("user")).unwrap(), dir.clone());
        let pick = || default_save_in(&dir, "fig", &read_saves(&st));
        assert_eq!(pick(), (dir.join("fig.biocraft"), None));
        assert_eq!(digest(b"a"), "af63dc4c8601ec8c"); // FNV-1a, the same in every build
        // a file someone else wrote is kept
        std::fs::write(dir.join("fig.biocraft"), "{\"mine\": 1}").unwrap();
        let (p, note) = pick();
        assert_eq!(p, dir.join("fig-2.biocraft"));
        assert!(note.unwrap().contains("was not written by this tool"));
        // our own unchanged draft is replaced; once edited (e.g. saved from the app) it is kept
        remember_save(&st, &p, b"draft");
        std::fs::write(&p, b"draft").unwrap();
        assert_eq!(pick().0, dir.join("fig-2.biocraft"));
        std::fs::write(&p, b"edited in BioCraft").unwrap();
        assert_eq!(pick().0, dir.join("fig-3.biocraft"));
    }

    #[test]
    fn a_missing_library_is_an_error() {
        let dir = scratch("nolib");
        let st = AppState::new(biocanvas_core::Library::open(&dir.join("library"), &dir.join("user")).unwrap(), dir.clone());
        for e in [search_icons(&st, &json!({ "query": "macrophage" })).err(), list_categories(&st).err(), get_icon(&st, &json!({ "id": "servier/macrophage" })).err()] {
            let e = e.expect("must fail").to_string();
            assert!(e.contains("BioCraft icon library not found") && e.contains("BIOCRAFT_LIBRARY"), "{e}");
        }
        let fig = json!({ "width_mm": 50, "height_mm": 30, "objects": [{ "type": "group", "objects": [{ "type": "icon", "id": "servier/macrophage", "x": 1, "y": 1 }] }] });
        let e = render_figure(&st, &json!({ "figure": fig, "save": dir.join("x.biocraft").display().to_string() })).err().unwrap().to_string();
        assert!(e.contains("library not found") && !dir.join("x.biocraft").exists(), "{e}");
    }

    #[test]
    fn nothing_is_written_for_bad_arguments() {
        let dir = scratch("args");
        let st = AppState::new(biocanvas_core::Library::open(&dir.join("library"), &dir.join("user")).unwrap(), dir.clone());
        let fig = json!({ "width_mm": 50, "height_mm": 30, "objects": [{ "type": "rect", "x": 1, "y": 1, "w": 5, "h": 5 }] });
        let save = dir.join("a.biocraft").display().to_string();
        for (k, v) in [("out", json!(dir.join("x.gif").display().to_string())), ("dpi", json!("high")), ("transparent", json!("yes"))] {
            let mut a = json!({ "figure": fig, "save": save, "preview": false });
            a[k] = v;
            assert!(render_figure(&st, &a).is_err(), "{k}");
            assert!(!dir.join("a.biocraft").exists(), "{k}");
        }
        let r = render_figure(&st, &json!({ "figure": fig, "save": save, "out": dir.join("t.png").display().to_string(), "transparent": true, "preview": false })).unwrap();
        assert_eq!(r.json["out_format"], "png at 300 dpi, transparent");
        // re-rendering a saved document does not save a copy unless asked
        let r = render_figure(&st, &json!({ "figure_path": save, "out": dir.join("t.pdf").display().to_string(), "preview": false })).unwrap();
        assert!(r.json["saved"].is_null() && r.json["document"].as_str().unwrap().ends_with("a.biocraft"), "{}", r.json);
        // open_in_biocraft refuses specs before starting anything
        std::fs::write(dir.join("spec.json"), fig.to_string()).unwrap();
        let e = open_in_biocraft(&json!({ "path": dir.join("spec.json").display().to_string() })).err().unwrap().to_string();
        assert!(e.contains("is a figure spec, not a BioCraft document"), "{e}");
    }
}
