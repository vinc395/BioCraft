//! The icon library as the app sees it: the built index (read-only, `root`) merged with the
//! user's personal library — their own uploaded icons, favourites and recents — which lives in
//! a separate folder (`user_root`) so rebuilding or replacing the library never touches it.

use crate::model::{CategoryInfo, IconMeta, LibraryIndex, PackInfo};
use crate::render::{encode_png, Renderer};
use crate::search::{Query, SearchIndex};
use crate::{palette, svgclean, taxonomy};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const THUMB_PX: u32 = 160;
/// Largest file accepted into the personal library.
const MAX_UPLOAD: usize = 40 * 1024 * 1024;

#[derive(Serialize, Deserialize, Default)]
pub struct UserState {
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub recent: Vec<String>,
}

pub struct Library {
    pub root: PathBuf,
    pub user_root: PathBuf,
    pub index: LibraryIndex,
    search: SearchIndex,
    by_id: HashMap<String, usize>,
    pub state: UserState,
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<T> {
    let data = fs::read(p).with_context(|| format!("reading {}", p.display()))?;
    Ok(serde_json::from_slice(&data).with_context(|| format!("parsing {}", p.display()))?)
}

pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "icon".into() } else { out.chars().take(80).collect() }
}

/// "neutrophil-granulocyte_1" → "Neutrophil granulocyte 1"
pub fn display_name(s: &str) -> String {
    let words: Vec<String> = s
        .split(|c: char| c == '_' || c == '-' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect();
    let mut out = words.join(" ");
    if let Some(f) = out.get(0..1) {
        out = f.to_uppercase() + &out[1..];
    }
    out
}

/// Pixel size of a PNG, JPEG or GIF from its header.
fn raster_size(b: &[u8]) -> Option<(&'static str, u32, u32)> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") && b.len() > 24 {
        let w = u32::from_be_bytes(b[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(b[20..24].try_into().ok()?);
        return Some(("image/png", w, h));
    }
    if b.starts_with(b"GIF8") && b.len() > 10 {
        return Some(("image/gif", u16::from_le_bytes([b[6], b[7]]) as u32, u16::from_le_bytes([b[8], b[9]]) as u32));
    }
    if b.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xFF {
                i += 1;
                continue;
            }
            let m = b[i + 1];
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
                return Some(("image/jpeg", w, h));
            }
            i += 2 + len;
        }
    }
    None
}

/// SVG bytes for an upload: SVG/SVGZ as is, pictures wrapped as an embedded image.
fn upload_as_svg(data: &[u8]) -> Result<Vec<u8>> {
    if data.len() > MAX_UPLOAD {
        bail!("file is larger than {} MB", MAX_UPLOAD / 1024 / 1024);
    }
    if let Some((mime, w, h)) = raster_size(data) {
        if w == 0 || h == 0 {
            bail!("could not read the picture size");
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        return Ok(format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><image width="{w}" height="{h}" xlink:href="data:{mime};base64,{b64}"/></svg>"#
        )
        .into_bytes());
    }
    Ok(data.to_vec())
}

const USER_PACK: &str = "user";

/// An upload that has been parsed, cleaned and thumbnailed: the slow part of adding an icon,
/// done before the library is locked so searches and thumbnails keep working meanwhile.
pub struct PreparedIcon {
    pub name: String,
    svg: String,
    thumb: Vec<u8>,
    w: f32,
    h: f32,
    raster: bool,
    slots: Vec<crate::model::Slot>,
}

/// Turn uploaded bytes (SVG, SVGZ, PNG, JPEG, GIF) into a library-ready icon.
pub fn prepare_upload(name: &str, data: &[u8], renderer: &Renderer) -> Result<PreparedIcon> {
    let opt = renderer.options();
    let svg = upload_as_svg(data)?;
    let tree = svgclean::parse(&svg, &opt).context("not a readable SVG or picture")?;
    let cleaned = svgclean::clean(&tree, 0.02)?;
    let ctree = svgclean::parse(cleaned.svg.as_bytes(), &opt)?;
    let thumb = encode_png(&renderer.thumbnail(&ctree, THUMB_PX)?, None)?;
    let name = if name.trim().is_empty() { "My icon".to_string() } else { display_name(name.trim()) };
    Ok(PreparedIcon { name, slots: palette::slots(&cleaned.colors), svg: cleaned.svg, thumb, w: cleaned.w, h: cleaned.h, raster: cleaned.raster })
}

impl Library {
    /// `root`: the built library (index.json, packs/); `user_root`: the personal library.
    pub fn open(root: &Path, user_root: &Path) -> Result<Self> {
        // one-time move of a personal library kept inside the built library by older versions
        let legacy = root.join("user");
        if legacy.join("index.json").exists() && !user_root.join("index.json").exists() {
            let _ = copy_dir(&legacy, user_root);
        }
        let main = root.join("index.json");
        let mut index: LibraryIndex = if main.exists() { read_json(&main)? } else { LibraryIndex { version: 1, ..Default::default() } };
        index.icons.retain(|i| i.pack != USER_PACK);
        if let Ok(mut user) = read_json::<Vec<IconMeta>>(&user_root.join("index.json")) {
            index.icons.append(&mut user);
        }
        let state = read_json(&user_root.join("state.json")).or_else(|_| read_json(&legacy.join("state.json"))).unwrap_or_default();
        let mut lib = Library { root: root.to_path_buf(), user_root: user_root.to_path_buf(), index, search: SearchIndex::build(&[]), by_id: HashMap::new(), state };
        lib.reindex();
        Ok(lib)
    }

    /// Absolute path of a library-relative file ("user/…" lives in the personal library).
    pub fn resolve(&self, rel: &str) -> PathBuf {
        match rel.strip_prefix("user/") {
            Some(r) => self.user_root.join(r),
            None => self.root.join(rel),
        }
    }

    fn reindex(&mut self) {
        self.by_id = self.index.icons.iter().enumerate().map(|(i, m)| (m.id.clone(), i)).collect();
        self.search = SearchIndex::build(&self.index.icons);
        let mut cat_counts: HashMap<&str, usize> = HashMap::new();
        let mut pack_counts: HashMap<&str, usize> = HashMap::new();
        for m in self.index.icons.iter().filter(|m| !m.hidden) {
            *cat_counts.entry(m.category.as_str()).or_default() += 1;
            *pack_counts.entry(m.pack.as_str()).or_default() += 1;
        }
        self.index.categories = taxonomy::CATEGORIES
            .iter()
            .map(|(id, name)| CategoryInfo { id: id.to_string(), name: name.to_string(), count: *cat_counts.get(id).unwrap_or(&0) })
            .collect();
        self.index.packs.retain(|p| p.id != USER_PACK);
        self.index.packs.push(PackInfo {
            id: USER_PACK.into(),
            name: "My library".into(),
            description: "Your own SVGs, pictures and saved figure parts".into(),
            url: String::new(),
            credit: String::new(),
            count: 0,
        });
        for p in &mut self.index.packs {
            p.count = *pack_counts.get(p.id.as_str()).unwrap_or(&0);
        }
    }

    pub fn get(&self, id: &str) -> Option<&IconMeta> {
        self.by_id.get(id).and_then(|&i| self.index.icons.get(i))
    }

    pub fn info(&self) -> Value {
        json!({
            "root": self.root.display().to_string(),
            "userRoot": self.user_root.display().to_string(),
            "built": self.index.built,
            "total": self.index.icons.iter().filter(|m| !m.hidden).count(),
            "userCount": self.index.icons.iter().filter(|m| m.pack == USER_PACK).count(),
            "packs": self.index.packs.iter().filter(|p| p.count > 0 && p.id != USER_PACK).collect::<Vec<_>>(),
            "categories": self.index.categories.iter().filter(|c| c.count > 0).collect::<Vec<_>>(),
            "allCategories": taxonomy::CATEGORIES.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
            "favorites": self.state.favorites,
        })
    }

    fn summary(&self, m: &IconMeta) -> Value {
        json!({
            "id": m.id, "name": m.name, "pack": m.pack, "category": m.category,
            "thumb": m.thumb, "license": m.license, "author": m.author,
            "w": m.w, "h": m.h, "raster": m.raster, "variants": m.variants.len(),
            "style": m.style, "tags": if m.pack == USER_PACK { json!(m.tags) } else { Value::Null },
        })
    }

    /// args: {q, category?, pack?, license?, favorites?: bool, recent?: bool, offset?, limit?}
    pub fn search(&self, args: &Value) -> Value {
        let s = |k: &str| args.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty());
        let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(120).min(1000) as usize;
        let text = s("q").unwrap_or("");

        if args.get("recent").and_then(|v| v.as_bool()) == Some(true) {
            let items: Vec<Value> = self.state.recent.iter().filter_map(|id| self.get(id)).map(|m| self.summary(m)).collect();
            return json!({ "total": items.len(), "items": items });
        }
        let favs: HashSet<String>;
        let only = if args.get("favorites").and_then(|v| v.as_bool()) == Some(true) {
            favs = self.state.favorites.iter().cloned().collect();
            Some(&favs)
        } else {
            None
        };
        let q = Query { text, category: s("category"), pack: s("pack"), license: s("license"), only, include_hidden: false };
        let ranked = self.search.search_ranked(&self.index.icons, &q);
        let mut hits = ranked.hits;
        if s("pack") == Some(USER_PACK) && text.is_empty() {
            // newest uploads first (user icons are appended in the order they were added)
            hits.sort_unstable_by_key(|&i| std::cmp::Reverse(i));
        }
        let items: Vec<Value> = hits.iter().skip(offset).take(limit).map(|&i| self.summary(&self.index.icons[i])).collect();
        // `full`: how many match every word; the rest only match part of a longer search
        json!({ "total": hits.len(), "full": ranked.full, "items": items })
    }

    /// Full metadata plus the cleaned SVG markup and the metadata of its variants.
    pub fn icon(&self, id: &str) -> Result<Value> {
        let m = self.get(id).ok_or_else(|| anyhow!("unknown icon {id}"))?;
        let mut svg = svgclean::read_svg(&self.resolve(&m.file)).with_context(|| format!("reading {}", m.file))?;
        if !m.colors.is_empty() {
            // colour variants share their primary's file
            svg = svgclean::apply_color_map(&svg, &m.colors);
        }
        // a primary lists its variants; a variant lists its primary and siblings
        let family: Vec<&IconMeta> = if m.hidden {
            match self.index.icons.iter().find(|p| p.variants.iter().any(|v| v == &m.id)) {
                Some(p) => std::iter::once(p).chain(p.variants.iter().filter_map(|v| self.get(v))).filter(|x| x.id != m.id).collect(),
                None => vec![],
            }
        } else {
            m.variants.iter().filter_map(|v| self.get(v)).collect()
        };
        let variants: Vec<Value> = family.into_iter().map(|v| self.summary(v)).collect();
        let pack = self.index.packs.iter().find(|p| p.id == m.pack);
        Ok(json!({ "meta": m, "svg": svg, "variants": variants, "pack": pack,
                   "favorite": self.state.favorites.contains(&m.id) }))
    }

    fn save_state(&self) -> Result<()> {
        fs::create_dir_all(&self.user_root)?;
        fs::write(self.user_root.join("state.json"), serde_json::to_vec_pretty(&self.state)?)?;
        Ok(())
    }

    fn save_user_index(&self) -> Result<()> {
        fs::create_dir_all(&self.user_root)?;
        let user: Vec<&IconMeta> = self.index.icons.iter().filter(|m| m.pack == USER_PACK).collect();
        let tmp = self.user_root.join("index.json.part");
        fs::write(&tmp, serde_json::to_vec_pretty(&user)?)?;
        fs::rename(tmp, self.user_root.join("index.json"))?;
        Ok(())
    }

    pub fn toggle_favorite(&mut self, id: &str) -> Result<bool> {
        let on = if let Some(p) = self.state.favorites.iter().position(|f| f == id) {
            self.state.favorites.remove(p);
            false
        } else {
            self.state.favorites.insert(0, id.to_string());
            true
        };
        self.save_state()?;
        Ok(on)
    }

    pub fn push_recent(&mut self, id: &str) -> Result<()> {
        self.state.recent.retain(|r| r != id);
        self.state.recent.insert(0, id.to_string());
        self.state.recent.truncate(60);
        self.save_state()
    }

    /// Store a prepared upload in the personal library and return its metadata.
    fn add_prepared(&mut self, p: PreparedIcon, category: Option<&str>, tags: &[String], note: &str) -> Result<IconMeta> {
        fs::create_dir_all(self.user_root.join("svg"))?;
        fs::create_dir_all(self.user_root.join("thumbs"))?;
        let base = slugify(&p.name);
        let mut slug = base.clone();
        let mut n = 2;
        while self.by_id.contains_key(&format!("{USER_PACK}/{slug}")) {
            slug = format!("{base}-{n}");
            n += 1;
        }
        let file = format!("user/svg/{slug}.svgz");
        let thumb = format!("user/thumbs/{slug}.png");
        svgclean::write_svgz(&self.resolve(&file), &p.svg)?;
        fs::write(self.resolve(&thumb), &p.thumb)?;
        let category = match category {
            Some(c) if taxonomy::CATEGORIES.iter().any(|(id, _)| *id == c) => c.to_string(),
            _ => taxonomy::categorize("", &p.name, tags).to_string(),
        };
        let m = IconMeta {
            id: format!("{USER_PACK}/{slug}"),
            name: p.name,
            pack: USER_PACK.into(),
            category,
            subcategory: "My library".into(),
            tags: tags.to_vec(),
            description: note.to_string(),
            author: "You".into(),
            license: "USER".into(),
            source_url: String::new(),
            file,
            thumb,
            w: p.w,
            h: p.h,
            slots: p.slots,
            raster: p.raster,
            variants: vec![],
            hidden: false,
            style: String::new(),
            colors: Default::default(),
        };
        // reserve the id so later uploads in the same batch get their own slug
        self.by_id.insert(m.id.clone(), usize::MAX);
        Ok(m)
    }

    /// Add prepared uploads ([(prepared or error, tags, note)]) and save the personal index.
    pub fn add_prepared_batch(&mut self, items: Vec<(String, Result<PreparedIcon>, Vec<String>, String)>, category: Option<&str>) -> Result<Value> {
        let (mut added, mut errors) = (Vec::new(), Vec::new());
        for (label, prepared, tags, note) in items {
            match prepared.and_then(|p| self.add_prepared(p, category, &tags, &note)) {
                Ok(m) => added.push(m),
                Err(e) => errors.push(json!({ "file": label, "error": format!("{e:#}") })),
            }
        }
        let summaries: Vec<Value> = added.iter().map(|m| self.summary(m)).collect();
        self.index.icons.extend(added);
        self.save_user_index()?;
        self.reindex();
        Ok(json!({ "added": summaries, "errors": errors }))
    }

    /// Import files from disk (SVG, SVGZ, PNG, JPEG, GIF) into the personal library.
    pub fn import_files(&mut self, files: &[PathBuf], renderer: &Renderer, category: Option<&str>) -> Result<Value> {
        let items = prepare_files(files, renderer);
        self.add_prepared_batch(items, category)
    }

    /// Import uploads sent by the UI: [(name, bytes, tags)] — file pickers, drops, saved selections.
    pub fn import_data(&mut self, items: &[(String, Vec<u8>, Vec<String>)], renderer: &Renderer, category: Option<&str>, note: &str) -> Result<Value> {
        let items = prepare_data(items, renderer, note);
        self.add_prepared_batch(items, category)
    }

    /// Rename, recategorise or retag one of your own icons.
    pub fn update_user_icon(&mut self, id: &str, name: Option<&str>, category: Option<&str>, tags: Option<Vec<String>>) -> Result<Value> {
        let i = *self.by_id.get(id).ok_or_else(|| anyhow!("unknown icon"))?;
        let m = self.index.icons.get_mut(i).ok_or_else(|| anyhow!("unknown icon"))?;
        if m.pack != USER_PACK {
            bail!("only icons in My library can be edited");
        }
        if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
            m.name = n.trim().to_string();
        }
        if let Some(c) = category.filter(|c| taxonomy::CATEGORIES.iter().any(|(id, _)| id == c)) {
            m.category = c.to_string();
        }
        if let Some(t) = tags {
            m.tags = t.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        }
        let out = self.summary(&self.index.icons[i]);
        self.save_user_index()?;
        self.reindex();
        Ok(out)
    }

    pub fn remove_user_icon(&mut self, id: &str) -> Result<()> {
        let m = self.get(id).ok_or_else(|| anyhow!("unknown icon"))?.clone();
        if m.pack != USER_PACK {
            bail!("only icons in My library can be removed");
        }
        let _ = fs::remove_file(self.resolve(&m.file));
        let _ = fs::remove_file(self.resolve(&m.thumb));
        self.index.icons.retain(|i| i.id != id);
        self.save_user_index()?;
        self.state.favorites.retain(|f| f != id);
        self.state.recent.retain(|f| f != id);
        let _ = self.save_state();
        self.reindex();
        Ok(())
    }
}

/// Prepare files from disk for `add_prepared_batch` (no library lock needed).
pub fn prepare_files(files: &[PathBuf], renderer: &Renderer) -> Vec<(String, Result<PreparedIcon>, Vec<String>, String)> {
    files
        .iter()
        .map(|f| {
            let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or("icon").to_string();
            let p = fs::read(f).map_err(anyhow::Error::from).and_then(|d| prepare_upload(&stem, &d, renderer));
            (f.display().to_string(), p, vec![], format!("Added from {}", f.display()))
        })
        .collect()
}

/// Prepare uploaded bytes [(name, bytes, tags)] for `add_prepared_batch` (no library lock needed).
pub fn prepare_data(items: &[(String, Vec<u8>, Vec<String>)], renderer: &Renderer, note: &str) -> Vec<(String, Result<PreparedIcon>, Vec<String>, String)> {
    items.iter().map(|(name, data, tags)| (name.clone(), prepare_upload(name, data, renderer), tags.clone(), note.to_string())).collect()
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_wrapping() {
        // 2×3 PNG header (contents beyond IHDR don't matter for sizing)
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&2u32.to_be_bytes());
        png.extend_from_slice(&3u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        assert_eq!(raster_size(&png), Some(("image/png", 2, 3)));
        let svg = String::from_utf8(upload_as_svg(&png).unwrap()).unwrap();
        assert!(svg.contains("viewBox=\"0 0 2 3\"") && svg.contains("data:image/png;base64,"));
        assert_eq!(upload_as_svg(b"<svg/>").unwrap(), b"<svg/>");
    }
}
