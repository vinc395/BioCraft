//! The home page's figure gallery. Figures live in the figures folder — the one chosen in the app,
//! else $BIOCRAFT_FIGURES, else Documents/BioCraft figures (where AI agents save their drafts too) —
//! and in project folders one level down. The gallery lists them with a preview of each canvas and
//! when each was last opened, and creates, opens, saves, renames, moves, duplicates and trashes them.
//! A figure is named by its path inside the figures folder ("Synovium paper/Figure 2.biocraft"),
//! never by a path on disk, so the browser front end can use the gallery without reaching other files.

use crate::api::{AppState, Mode};
use crate::{agent, figure};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const EXT: &str = "biocraft";
const TRASH: &str = ".trash";
/// Longest side of a generated preview, in pixels.
const THUMB_PX: f64 = 420.0;

/// The gallery's own records (data folder/gallery.json) are read and written under this lock.
static INDEX: Mutex<()> = Mutex::new(());

fn setting(data_dir: &Path, key: &str) -> Option<String> {
    let s: Value = serde_json::from_slice(&std::fs::read(data_dir.join("settings.json")).ok()?).ok()?;
    s.get(key).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).map(String::from)
}

/// The figures folder (created when first needed).
pub fn root(st: &AppState) -> PathBuf {
    if let Some(p) = setting(&st.data_dir, "figuresFolder") {
        return PathBuf::from(p);
    }
    if let Some(p) = std::env::var_os("BIOCRAFT_FIGURES") {
        return PathBuf::from(p);
    }
    agent::documents_dir().join("BioCraft figures")
}

/// The gallery id of a file saved somewhere in the figures folder (None elsewhere).
pub fn id_for(st: &AppState, path: &Path) -> Option<String> {
    let root = root(st);
    let rel = path.strip_prefix(&root).ok()?;
    let id = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/");
    resolve(&root, &id).ok().map(|_| id)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn ms(t: std::io::Result<SystemTime>) -> u64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A file or folder name a person typed, made safe: no path separators or reserved characters,
/// not hidden, at most 80 characters.
fn clean_name(s: &str, fallback: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    out = out.trim_start_matches('.').trim().chars().take(80).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    if out.is_empty() { fallback.to_string() } else { out }
}

/// A figure's id ("Folder/Name.biocraft" or "Name.biocraft") → its path, refusing anything that
/// would leave the figures folder or reach the trash.
fn resolve(root: &Path, id: &str) -> Result<PathBuf> {
    let rel = Path::new(id);
    let parts: Vec<_> = rel.components().collect();
    let ok = !parts.is_empty()
        && parts.len() <= 2
        && parts.iter().all(|c| matches!(c, Component::Normal(s) if !s.to_string_lossy().starts_with('.')))
        && matches!(rel.extension().and_then(|e| e.to_str()), Some("biocraft" | "biocanvas"));
    if !ok {
        bail!("not a figure in the figures folder: {id}");
    }
    Ok(root.join(rel))
}

fn folder_path(root: &Path, folder: &str) -> Result<PathBuf> {
    if folder.is_empty() {
        return Ok(root.to_path_buf());
    }
    if folder != clean_name(folder, "") {
        bail!("not a folder name: {folder}");
    }
    Ok(root.join(folder))
}

fn id_of(folder: &str, file: &str) -> String {
    if folder.is_empty() { file.to_string() } else { format!("{folder}/{file}") }
}

fn split_id(id: &str) -> (String, String) {
    match id.rsplit_once('/') {
        Some((f, n)) => (f.to_string(), n.to_string()),
        None => (String::new(), id.to_string()),
    }
}

/// `dir/stem.biocraft`, or `stem 2.biocraft`, … when that is taken.
fn unique(dir: &Path, stem: &str) -> PathBuf {
    for n in 1..10_000 {
        let p = dir.join(if n == 1 { format!("{stem}.{EXT}") } else { format!("{stem} {n}.{EXT}") });
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem} {}.{EXT}", now_ms()))
}

fn stem_of(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

/// Write a figure so that a crash or a full disk never leaves half a file: into a hidden file beside
/// it, then renamed over it (written in place when the rename is refused, e.g. while a sync client
/// holds the file). The app saves figures a moment after every change, so this runs often.
fn write_figure(path: &Path, content: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_file_name(format!(".{}.saving", path.file_name().unwrap_or_default().to_string_lossy()));
    if std::fs::write(&tmp, content).and_then(|_| std::fs::rename(&tmp, path)).is_err() {
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(path, content).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(())
}

/* ---------- the gallery's records: opened times, previews, trash origins ---------- */

fn index_path(st: &AppState) -> PathBuf {
    st.data_dir.join("gallery.json")
}
fn load(st: &AppState) -> Map<String, Value> {
    std::fs::read(index_path(st)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn store(st: &AppState, ix: &Map<String, Value>) {
    let _ = std::fs::create_dir_all(&st.data_dir);
    let _ = std::fs::write(index_path(st), serde_json::to_vec(ix).unwrap_or_default());
}
fn table<'a>(ix: &'a mut Map<String, Value>, k: &str) -> &'a mut Map<String, Value> {
    if !ix.get(k).is_some_and(|v| v.is_object()) {
        ix.insert(k.into(), json!({}));
    }
    ix[k].as_object_mut().unwrap()
}
/// The records kept per figure: when it was last opened, when it was first seen (saving replaces the
/// file, which can reset the date the file system gives) and what `meta` read from it.
const RECORDS: [&str; 3] = ["opened", "created", "meta"];

/// Records about `from` now belong to `to` (a rename or move); None forgets them.
fn rekey(ix: &mut Map<String, Value>, from: &str, to: Option<&str>) {
    for k in RECORDS {
        let t = table(ix, k);
        if let Some(v) = t.remove(from) {
            if let Some(to) = to {
                t.insert(to.into(), v);
            }
        }
    }
}
fn touch(ix: &mut Map<String, Value>, id: &str) {
    table(ix, "opened").insert(id.into(), json!(now_ms()));
}

fn thumbs_dir(st: &AppState) -> PathBuf {
    st.data_dir.join("thumbs")
}

fn fnv(s: &str) -> String {
    let h = s.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    format!("{h:016x}")
}

/// What the gallery shows of a figure file: size, objects and a preview (the one the app stored in
/// the file when it was saved, else one drawn here), cached by modification time.
fn meta(st: &AppState, ix: &mut Map<String, Value>, id: &str, path: &Path) -> Value {
    let md = std::fs::metadata(path).ok();
    let (mtime, bytes) = (md.as_ref().map(|m| ms(m.modified())).unwrap_or(0), md.as_ref().map(|m| m.len()).unwrap_or(0));
    if let Some(m) = table(ix, "meta").get(id) {
        if m["mtime"] == json!(mtime) && m["bytes"] == json!(bytes) {
            return m.clone();
        }
        // the figure changed: its old preview goes
        if let Some(old) = m["thumb"].as_str() {
            let _ = std::fs::remove_file(thumbs_dir(st).join(old));
        }
    }
    let doc: Value = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    let doc = if doc.get("doc").is_some_and(|d| d.get("objects").is_some()) { doc["doc"].clone() } else { doc };
    let thumb = doc
        .get("thumbnail")
        .and_then(|t| t.as_str())
        .filter(|t| t.starts_with("data:image/"))
        .map(String::from)
        .or_else(|| {
            doc.get("objects")?;
            let png = figure::preview(&doc, st.renderer(), THUMB_PX).ok()?;
            Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
        });
    let file = thumb.as_ref().and_then(|t| {
        let name = format!("{}.txt", fnv(&format!("{}|{mtime}", path.display())));
        let _ = std::fs::create_dir_all(thumbs_dir(st));
        std::fs::write(thumbs_dir(st).join(&name), t).ok().map(|_| name)
    });
    let m = json!({
        "mtime": mtime, "bytes": bytes,
        "width": doc.get("width"), "height": doc.get("height"),
        "objects": doc.get("objects").and_then(|o| o.as_array()).map(|o| o.len()),
        "thumb": file,
    });
    table(ix, "meta").insert(id.into(), m.clone());
    m
}

fn thumb_url(st: &AppState, m: &Value) -> Option<String> {
    m["thumb"].as_str().and_then(|f| std::fs::read_to_string(thumbs_dir(st).join(f)).ok())
}

fn is_figure(p: &Path) -> bool {
    p.is_file() && matches!(p.extension().and_then(|e| e.to_str()), Some("biocraft" | "biocanvas"))
}

fn entry(st: &AppState, ix: &mut Map<String, Value>, folder: &str, path: &Path) -> Value {
    let file = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let id = id_of(folder, &file);
    let m = meta(st, ix, &id, path);
    let created = match table(ix, "created").get(&id).and_then(|v| v.as_u64()) {
        Some(t) => t,
        None => {
            let t = std::fs::metadata(path).map(|m| ms(m.created())).unwrap_or(0);
            table(ix, "created").insert(id.clone(), json!(t));
            t
        }
    };
    json!({
        "id": id,
        "name": stem_of(path),
        "folder": folder,
        "modified": m["mtime"],
        "created": created,
        "opened": table(ix, "opened").get(&id).cloned().unwrap_or(Value::Null),
        "bytes": m["bytes"],
        "width": m["width"], "height": m["height"], "objects": m["objects"],
        "thumb": thumb_url(st, &m),
    })
}

fn list(st: &AppState, mode: Mode) -> Result<Value> {
    let root = root(st);
    std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
    let _g = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let mut ix = load(st);
    let mut files = Vec::new();
    let mut folders = Vec::new();
    let mut dirs: Vec<_> = std::fs::read_dir(&root)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    dirs.sort();
    for p in &dirs {
        if is_figure(p) {
            files.push(entry(st, &mut ix, "", p));
        } else if p.is_dir() {
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with('.') {
                continue;
            }
            let mut n = 0;
            let mut inner: Vec<_> = std::fs::read_dir(p)?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|q| is_figure(q)).collect();
            inner.sort();
            for q in inner {
                files.push(entry(st, &mut ix, &name, &q));
                n += 1;
            }
            folders.push(json!({ "name": name, "count": n }));
        }
    }
    // forget records of figures that are gone (deleted or moved outside the app), and every preview
    // no record uses any more
    let ids: std::collections::HashSet<String> = files.iter().filter_map(|f| f["id"].as_str().map(String::from)).collect();
    let trash_dir = root.join(TRASH);
    for k in RECORDS {
        table(&mut ix, k).retain(|id, _| ids.contains(id) || (k == "meta" && id.strip_prefix(".trash/").is_some_and(|t| trash_dir.join(t).is_file())));
    }
    let used: std::collections::HashSet<String> = table(&mut ix, "meta").values().filter_map(|m| m["thumb"].as_str().map(String::from)).collect();
    if let Ok(d) = std::fs::read_dir(thumbs_dir(st)) {
        for e in d.flatten() {
            if !used.contains(e.file_name().to_string_lossy().as_ref()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    store(st, &ix);
    let trash = std::fs::read_dir(root.join(TRASH)).map(|d| d.filter_map(|e| e.ok()).filter(|e| is_figure(&e.path())).count()).unwrap_or(0);
    Ok(json!({
        "root": root.display().to_string(),
        "canReveal": mode == Mode::Desktop,
        "folders": folders,
        "files": files,
        "trash": trash,
    }))
}

fn blank(width: f64, height: f64, title: &str) -> Value {
    json!({ "app": "BioCraft", "version": 1, "title": title, "width": width, "height": height, "background": "#ffffff", "objects": [], "assets": {} })
}

fn arg<'a>(a: &'a Value, k: &str) -> &'a str {
    a.get(k).and_then(|v| v.as_str()).unwrap_or("")
}

fn opened(id: &str, path: &Path, mode: Mode, content: String) -> Value {
    json!({ "id": id, "name": stem_of(path), "path": if mode == Mode::Desktop { Some(path.display().to_string()) } else { None }, "content": content })
}

pub fn dispatch(st: &AppState, cmd: &str, a: &Value, mode: Mode) -> Result<Value> {
    if cmd == "gallery.list" {
        return list(st, mode);
    }
    let root = root(st);
    std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
    let _g = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let mut ix = load(st);
    let res = match cmd {
        // {folder?, name?, width?, height?} (mm): a new blank figure, saved at once; or {folder?, name?,
        // content}: a figure the app made, given its file (its name made unique in the folder)
        "gallery.create" => {
            let folder = arg(a, "folder");
            let dir = folder_path(&root, folder)?;
            std::fs::create_dir_all(&dir)?;
            let name = clean_name(arg(a, "name"), "Untitled figure");
            let path = unique(&dir, &name);
            let id = id_of(folder, &path.file_name().unwrap().to_string_lossy());
            touch(&mut ix, &id);
            if let Some(content) = a.get("content").and_then(|v| v.as_str()) {
                let doc: Value = serde_json::from_str(content).context("not a BioCraft figure")?;
                if !doc.get("objects").is_some_and(|o| o.is_array()) {
                    bail!("not a BioCraft figure");
                }
                write_figure(&path, content)?;
                json!({ "id": id, "name": stem_of(&path), "path": if mode == Mode::Desktop { Some(path.display().to_string()) } else { None } })
            } else {
                let w = a.get("width").and_then(|v| v.as_f64()).filter(|v| (10.0..=2000.0).contains(v)).unwrap_or(178.0);
                let h = a.get("height").and_then(|v| v.as_f64()).filter(|v| (10.0..=2000.0).contains(v)).unwrap_or(120.0);
                let content = serde_json::to_string(&blank(w, h, &stem_of(&path)))?;
                write_figure(&path, &content)?;
                opened(&id, &path, mode, content)
            }
        }
        "gallery.open" => {
            let id = arg(a, "id");
            let path = resolve(&root, id)?;
            let content = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
            touch(&mut ix, id);
            opened(id, &path, mode, content)
        }
        // {id, content}: the figure as the app saves it (with its preview in `thumbnail`)
        "gallery.save" => {
            let id = arg(a, "id");
            let path = resolve(&root, id)?;
            let content = a.get("content").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("missing argument 'content'"))?;
            write_figure(&path, content)?;
            touch(&mut ix, id);
            json!({ "id": id, "path": if mode == Mode::Desktop { Some(path.display().to_string()) } else { None }, "bytes": content.len() })
        }
        "gallery.newFolder" => {
            let name = clean_name(arg(a, "name"), "New folder");
            let mut dir = root.join(&name);
            let mut n = 2;
            while dir.exists() {
                dir = root.join(format!("{name} {n}"));
                n += 1;
            }
            std::fs::create_dir_all(&dir)?;
            json!({ "name": dir.file_name().unwrap().to_string_lossy() })
        }
        "gallery.renameFolder" => {
            let from = arg(a, "folder");
            let src = folder_path(&root, from)?;
            if from.is_empty() || !src.is_dir() {
                bail!("no folder {from}");
            }
            let name = clean_name(arg(a, "name"), from);
            let dst = root.join(&name);
            if name != from {
                if dst.exists() {
                    bail!("there is already a folder called {name}");
                }
                std::fs::rename(&src, &dst)?;
                for k in RECORDS {
                    let t = table(&mut ix, k);
                    let moved: Vec<String> = t.keys().filter(|id| id.starts_with(&format!("{from}/"))).cloned().collect();
                    for id in moved {
                        let v = t.remove(&id).unwrap();
                        t.insert(format!("{name}/{}", &id[from.len() + 1..]), v);
                    }
                }
            }
            json!({ "name": name })
        }
        // only an empty folder: its figures are moved or trashed first
        "gallery.deleteFolder" => {
            let folder = arg(a, "folder");
            let dir = folder_path(&root, folder)?;
            if folder.is_empty() || !dir.is_dir() {
                bail!("no folder {folder}");
            }
            if std::fs::read_dir(&dir)?.filter_map(|e| e.ok()).any(|e| is_figure(&e.path())) {
                bail!("{folder} still has figures: move them or move them to the trash first");
            }
            std::fs::remove_dir(&dir).map_err(|_| anyhow!("{folder} has other files in it, so it was left alone"))?;
            json!({})
        }
        // {id, name, unique?}: a name already taken is refused, or with `unique` made "name 2", …
        "gallery.rename" => {
            let id = arg(a, "id");
            let path = resolve(&root, id)?;
            let (folder, _) = split_id(id);
            let name = clean_name(arg(a, "name"), &stem_of(&path));
            let mut dst = path.with_file_name(format!("{name}.{EXT}"));
            // (on a file system that ignores letter case, "figure 1" → "Figure 1" finds the figure itself)
            let same_file = |p: &Path, q: &Path| matches!((std::fs::canonicalize(p), std::fs::canonicalize(q)), (Ok(x), Ok(y)) if x == y);
            if dst != path && dst.exists() && !same_file(&dst, &path) {
                if !a.get("unique").and_then(|v| v.as_bool()).unwrap_or(false) {
                    bail!("there is already a figure called {name} here");
                }
                dst = unique(path.parent().unwrap(), &name);
            }
            if dst != path {
                std::fs::rename(&path, &dst)?;
            }
            let nid = id_of(&folder, &dst.file_name().unwrap().to_string_lossy());
            rekey(&mut ix, id, Some(&nid));
            json!({ "id": nid, "name": stem_of(&dst), "path": if mode == Mode::Desktop { Some(dst.display().to_string()) } else { None } })
        }
        "gallery.move" => {
            let id = arg(a, "id");
            let path = resolve(&root, id)?;
            let folder = arg(a, "folder");
            let dir = folder_path(&root, folder)?;
            std::fs::create_dir_all(&dir)?;
            let dst = if dir.join(path.file_name().unwrap()).exists() { unique(&dir, &stem_of(&path)) } else { dir.join(path.file_name().unwrap()) };
            if dst != path {
                std::fs::rename(&path, &dst)?;
            }
            let nid = id_of(folder, &dst.file_name().unwrap().to_string_lossy());
            rekey(&mut ix, id, Some(&nid));
            json!({ "id": nid, "path": if mode == Mode::Desktop { Some(dst.display().to_string()) } else { None } })
        }
        "gallery.duplicate" => {
            let id = arg(a, "id");
            let path = resolve(&root, id)?;
            let (folder, _) = split_id(id);
            let dst = unique(path.parent().unwrap(), &format!("{} copy", stem_of(&path)));
            std::fs::copy(&path, &dst)?;
            json!({ "id": id_of(&folder, &dst.file_name().unwrap().to_string_lossy()) })
        }
        // to the trash folder inside the figures folder, remembering where it came from
        "gallery.trash" => {
            let id = arg(a, "id");
            let path = resolve(&root, id)?;
            let dir = root.join(TRASH);
            std::fs::create_dir_all(&dir)?;
            let dst = unique(&dir, &stem_of(&path));
            std::fs::rename(&path, &dst)?;
            let tid = dst.file_name().unwrap().to_string_lossy().to_string();
            table(&mut ix, "trash").insert(tid.clone(), json!({ "from": id, "at": now_ms() }));
            rekey(&mut ix, id, None);
            json!({ "id": tid })
        }
        "gallery.trashList" => {
            let dir = root.join(TRASH);
            let mut out = Vec::new();
            if let Ok(d) = std::fs::read_dir(&dir) {
                let mut paths: Vec<_> = d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| is_figure(p)).collect();
                paths.sort();
                for p in paths {
                    let tid = p.file_name().unwrap().to_string_lossy().to_string();
                    let rec = table(&mut ix, "trash").get(&tid).cloned().unwrap_or(Value::Null);
                    let m = meta(st, &mut ix, &format!("{TRASH}/{tid}"), &p);
                    out.push(json!({ "id": tid, "name": stem_of(&p), "from": rec["from"], "trashed": rec["at"], "modified": m["mtime"], "width": m["width"], "height": m["height"], "thumb": thumb_url(st, &m) }));
                }
            }
            json!({ "files": out })
        }
        "gallery.restore" => {
            let tid = clean_name(arg(a, "id"), "");
            let src = root.join(TRASH).join(&tid);
            if tid.is_empty() || !is_figure(&src) {
                bail!("not in the trash: {tid}");
            }
            let from = table(&mut ix, "trash").remove(&tid).and_then(|r| r["from"].as_str().map(String::from)).unwrap_or_else(|| tid.clone());
            let (folder, file) = split_id(&from);
            let dir = folder_path(&root, &folder).unwrap_or_else(|_| root.clone());
            std::fs::create_dir_all(&dir)?;
            let want = dir.join(&file);
            let dst = if want.exists() || !is_name_ok(&file) { unique(&dir, &stem_of(&src)) } else { want };
            std::fs::rename(&src, &dst)?;
            json!({ "id": id_of(if dir == root { "" } else { &folder }, &dst.file_name().unwrap().to_string_lossy()) })
        }
        "gallery.deleteForever" => {
            let tid = clean_name(arg(a, "id"), "");
            let src = root.join(TRASH).join(&tid);
            if tid.is_empty() || !is_figure(&src) {
                bail!("not in the trash: {tid}");
            }
            std::fs::remove_file(&src)?;
            table(&mut ix, "trash").remove(&tid);
            json!({})
        }
        // desktop: show the figures folder (or a figure's folder) in the file manager
        "gallery.reveal" => {
            if mode != Mode::Desktop {
                bail!("only in the desktop app");
            }
            let id = arg(a, "id");
            let dir = if id.is_empty() { folder_path(&root, arg(a, "folder"))? } else { resolve(&root, id)?.parent().unwrap().to_path_buf() };
            crate::api::open_path(&dir)?;
            json!({})
        }
        // desktop: choose another figures folder (remembered in the settings)
        "gallery.setRoot" => {
            if mode != Mode::Desktop {
                bail!("only in the desktop app");
            }
            match rfd::FileDialog::new().set_title("Choose the folder for your BioCraft figures").set_directory(&root).pick_folder() {
                Some(p) => {
                    crate::api::save_setting(&st.data_dir, "figuresFolder", json!(p.display().to_string()))?;
                    json!({ "root": p.display().to_string() })
                }
                None => json!({ "cancelled": true }),
            }
        }
        // desktop: copy figure files from elsewhere into a folder of the gallery
        "gallery.import" => {
            if mode != Mode::Desktop {
                bail!("only in the desktop app");
            }
            let folder = arg(a, "folder");
            let dir = folder_path(&root, folder)?;
            std::fs::create_dir_all(&dir)?;
            let picked = rfd::FileDialog::new().set_title("Add figures to My files").add_filter("BioCraft figure", &["biocraft", "biocanvas"]).pick_files().unwrap_or_default();
            let mut ids = Vec::new();
            for p in picked {
                let dst = unique(&dir, &stem_of(&p));
                std::fs::copy(&p, &dst).with_context(|| format!("copying {}", p.display()))?;
                ids.push(id_of(folder, &dst.file_name().unwrap().to_string_lossy()));
            }
            json!({ "ids": ids })
        }
        c => bail!("unknown command '{c}'"),
    };
    store(st, &ix);
    Ok(res)
}

fn is_name_ok(file: &str) -> bool {
    !file.is_empty() && clean_name(file, "") == file
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(tag: &str) -> (AppState, PathBuf) {
        let base = std::env::temp_dir().join(format!("biocraft-gallery-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let figs = base.join("figures");
        std::fs::write(data.join("settings.json"), serde_json::to_vec(&json!({ "figuresFolder": figs.display().to_string() })).unwrap()).unwrap();
        let lib = biocanvas_core::Library::open(&base.join("nolib"), &base.join("user")).unwrap();
        (AppState::new(lib, data), figs)
    }

    #[test]
    fn names_and_ids_stay_inside_the_figures_folder() {
        assert_eq!(clean_name("  Fig 2: CD68/CD3 <final>  ", "x"), "Fig 2 CD68 CD3 final");
        assert_eq!(clean_name("..hidden", "x"), "hidden");
        assert_eq!(clean_name("   ", "Untitled figure"), "Untitled figure");
        let r = Path::new("/figs");
        assert!(resolve(r, "Paper/Figure 1.biocraft").is_ok() && resolve(r, "Figure 1.biocraft").is_ok());
        for bad in ["../x.biocraft", "a/b/c.biocraft", ".trash/x.biocraft", "x.png", "/etc/x.biocraft", "C:\\x.biocraft"] {
            assert!(resolve(r, bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn create_list_rename_move_trash_restore() {
        let (st, figs) = state("ops");
        let m = Mode::Web;
        let a = dispatch(&st, "gallery.create", &json!({ "name": "Synovium", "width": 89, "height": 70 }), m).unwrap();
        assert_eq!(a["id"], "Synovium.biocraft");
        assert!(a["path"].is_null(), "the browser front end gets no paths");
        let f = dispatch(&st, "gallery.newFolder", &json!({ "name": "RA paper" }), m).unwrap();
        assert_eq!(f["name"], "RA paper");
        let b = dispatch(&st, "gallery.create", &json!({ "folder": "RA paper" }), m).unwrap();
        assert_eq!(b["id"], "RA paper/Untitled figure.biocraft");
        // the saved preview is what the gallery shows
        let doc = json!({ "app": "BioCraft", "version": 1, "width": 89, "height": 70, "objects": [], "assets": {}, "thumbnail": "data:image/jpeg;base64,AAAA" });
        dispatch(&st, "gallery.save", &json!({ "id": "Synovium.biocraft", "content": doc.to_string() }), m).unwrap();
        let l = list(&st, m).unwrap();
        assert_eq!(l["folders"], json!([{ "name": "RA paper", "count": 1 }]));
        let syn = l["files"].as_array().unwrap().iter().find(|x| x["id"] == "Synovium.biocraft").unwrap().clone();
        assert_eq!((syn["thumb"].as_str(), syn["width"].as_f64(), syn["opened"].is_u64()), (Some("data:image/jpeg;base64,AAAA"), Some(89.0), true));
        // a figure without a saved preview gets one drawn
        let u = l["files"].as_array().unwrap().iter().find(|x| x["folder"] == "RA paper").unwrap().clone();
        assert!(u["thumb"].as_str().unwrap().starts_with("data:image/png;base64,"));
        let r = dispatch(&st, "gallery.rename", &json!({ "id": "Synovium.biocraft", "name": "Figure 1 | Synovium" }), m).unwrap();
        assert_eq!(r["id"], "Figure 1 Synovium.biocraft");
        let mv = dispatch(&st, "gallery.move", &json!({ "id": r["id"], "folder": "RA paper" }), m).unwrap();
        assert_eq!(mv["id"], "RA paper/Figure 1 Synovium.biocraft");
        assert!(figs.join("RA paper").join("Figure 1 Synovium.biocraft").is_file());
        let d = dispatch(&st, "gallery.duplicate", &json!({ "id": mv["id"] }), m).unwrap();
        assert_eq!(d["id"], "RA paper/Figure 1 Synovium copy.biocraft");
        assert!(dispatch(&st, "gallery.deleteFolder", &json!({ "folder": "RA paper" }), m).is_err(), "a folder with figures stays");
        let t = dispatch(&st, "gallery.trash", &json!({ "id": d["id"] }), m).unwrap();
        assert_eq!(list(&st, m).unwrap()["trash"], 1);
        let back = dispatch(&st, "gallery.restore", &json!({ "id": t["id"] }), m).unwrap();
        assert_eq!(back["id"], "RA paper/Figure 1 Synovium copy.biocraft");
        let renamed = dispatch(&st, "gallery.renameFolder", &json!({ "folder": "RA paper", "name": "RA synovium paper" }), m).unwrap();
        assert_eq!(renamed["name"], "RA synovium paper");
        let o = dispatch(&st, "gallery.open", &json!({ "id": "RA synovium paper/Figure 1 Synovium.biocraft" }), m).unwrap();
        assert!(o["content"].as_str().unwrap().contains("\"width\":89"));
        assert!(dispatch(&st, "gallery.open", &json!({ "id": "../../secret.biocraft" }), m).is_err());
        let _ = std::fs::remove_dir_all(figs.parent().unwrap());
    }

    /// What the app's saving-as-you-work relies on: a new figure given its file, saves that replace the
    /// file (and keep its date created), naming it at leave-time, and previews that don't pile up.
    #[test]
    fn figures_saved_as_you_work() {
        let (st, figs) = state("autosave");
        let m = Mode::Desktop;
        let doc = |n: usize, thumb: &str| json!({ "app": "BioCraft", "version": 1, "width": 89, "height": 70, "objects": vec![json!({ "type": "rect" }); n], "assets": {}, "thumbnail": thumb }).to_string();
        dispatch(&st, "gallery.newFolder", &json!({ "name": "Grant" }), m).unwrap();
        let a = dispatch(&st, "gallery.create", &json!({ "folder": "Grant", "content": doc(1, "data:image/jpeg;base64,AA") }), m).unwrap();
        assert_eq!(a["id"], "Grant/Untitled figure.biocraft");
        assert!(a["path"].as_str().unwrap().ends_with("Untitled figure.biocraft") && a.get("content").is_none());
        assert!(dispatch(&st, "gallery.create", &json!({ "content": "{\"not\": \"a figure\"}" }), m).is_err());
        let b = dispatch(&st, "gallery.create", &json!({ "folder": "Grant", "content": doc(2, "data:image/jpeg;base64,BB") }), m).unwrap();
        assert_eq!(b["id"], "Grant/Untitled figure 2.biocraft");
        let created = |id: &str| list(&st, m).unwrap()["files"].as_array().unwrap().iter().find(|f| f["id"] == id).map(|f| (f["created"].as_u64().unwrap(), f["objects"].as_u64().unwrap(), f["thumb"].as_str().unwrap().to_string())).unwrap();
        let (c0, n0, t0) = created("Grant/Untitled figure.biocraft");
        assert_eq!((n0, t0.as_str()), (1, "data:image/jpeg;base64,AA"));
        std::thread::sleep(std::time::Duration::from_millis(30));
        for n in 2..6 {
            dispatch(&st, "gallery.save", &json!({ "id": "Grant/Untitled figure.biocraft", "content": doc(n, &format!("data:image/jpeg;base64,{n}{n}")) }), m).unwrap();
            let (c, objects, thumb) = created("Grant/Untitled figure.biocraft");
            assert_eq!((c, objects, thumb), (c0, n as u64, format!("data:image/jpeg;base64,{n}{n}")), "each save is seen, the date created stays");
        }
        let left: Vec<_> = std::fs::read_dir(figs.join("Grant")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(left.len(), 2, "no temporary files left: {left:?}");
        assert_eq!(std::fs::read_dir(st.data_dir.join("thumbs")).unwrap().count(), 2, "one preview per figure");
        // naming it when leaving: a taken name becomes "name 2"; without `unique` it is refused
        assert!(dispatch(&st, "gallery.rename", &json!({ "id": "Grant/Untitled figure.biocraft", "name": "Untitled figure 2" }), m).is_err());
        let r = dispatch(&st, "gallery.rename", &json!({ "id": "Grant/Untitled figure.biocraft", "name": "Untitled figure 2", "unique": true }), m).unwrap();
        assert_eq!((r["id"].as_str(), r["name"].as_str()), (Some("Grant/Untitled figure 2 2.biocraft"), Some("Untitled figure 2 2")));
        assert!(r["path"].as_str().unwrap().ends_with("Untitled figure 2 2.biocraft"));
        assert_eq!(created("Grant/Untitled figure 2 2.biocraft").0, c0, "renaming keeps the date created");
        // a change of letter case only is a rename of the figure itself
        let r = dispatch(&st, "gallery.rename", &json!({ "id": "Grant/Untitled figure 2.biocraft", "name": "untitled FIGURE 2" }), m).unwrap();
        assert_eq!(r["id"], "Grant/untitled FIGURE 2.biocraft");
        let mv = dispatch(&st, "gallery.move", &json!({ "id": r["id"], "folder": "" }), m).unwrap();
        assert!(mv["path"].as_str().unwrap().ends_with("untitled FIGURE 2.biocraft") && mv["id"] == "untitled FIGURE 2.biocraft");
        let _ = std::fs::remove_dir_all(figs.parent().unwrap());
    }
}
