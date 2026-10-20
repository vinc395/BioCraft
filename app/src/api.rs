//! One command dispatcher for both front ends: the Tauri window (`api` command) and the
//! development web server (`POST /api/<cmd>`).

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use crate::licence;
use biocanvas_core::render::{encode_png, encode_tiff, to_pdf};
use biocanvas_core::{color::Rgb, palette, svgclean, Library, Renderer};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};

pub struct AppState {
    pub lib: RwLock<Library>,
    renderer: OnceLock<Renderer>,
    pub data_dir: PathBuf,
    /// A figure named on the command line (`biocraft fig.biocraft`), handed to the UI once.
    pub launch_file: Mutex<Option<PathBuf>>,
    autosave: OnceLock<(PathBuf, Option<std::fs::File>)>,
}

impl AppState {
    pub fn new(lib: Library, data_dir: PathBuf) -> Self {
        AppState { lib: RwLock::new(lib), renderer: OnceLock::new(), data_dir, launch_file: Mutex::new(None), autosave: OnceLock::new() }
    }
    /// Loading system fonts takes a moment, so do it on first use.
    pub fn renderer(&self) -> &Renderer {
        self.renderer.get_or_init(Renderer::new)
    }
    /// This window's autosave: autosave.biocraft, or autosave-2… while another BioCraft window
    /// holds that one, so two windows never overwrite each other's session.
    pub fn autosave_path(&self) -> &Path {
        &self.autosave.get_or_init(|| claim_autosave(&self.data_dir)).0
    }
}

/// The first autosave slot no running instance has locked; the lock lasts as long as the process.
fn claim_autosave(dir: &Path) -> (PathBuf, Option<std::fs::File>) {
    let _ = std::fs::create_dir_all(dir);
    for n in 1..=9 {
        let name = if n == 1 { "autosave".to_string() } else { format!("autosave-{n}") };
        let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(format!("{name}.lock")));
        if let Ok(f) = lock {
            if f.try_lock().is_ok() {
                return (dir.join(format!("{name}.biocraft")), Some(f));
            }
        }
    }
    (dir.join(format!("autosave-{}.biocraft", std::process::id())), None)
}

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Desktop,
    Web,
}

/// The library folder the user picked in the app, if any (data_dir/settings.json).
pub fn saved_library_path(data_dir: &Path) -> Option<PathBuf> {
    let s: Value = serde_json::from_slice(&std::fs::read(data_dir.join("settings.json")).ok()?).ok()?;
    s.get("libraryPath").and_then(|v| v.as_str()).map(PathBuf::from)
}

pub(crate) fn save_setting(data_dir: &Path, key: &str, value: Value) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join("settings.json");
    let mut s: Value = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    s[key] = value;
    std::fs::write(path, serde_json::to_vec_pretty(&s)?)?;
    Ok(())
}

fn arg_str<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

fn need_str<'a>(a: &'a Value, k: &str) -> Result<&'a str> {
    arg_str(a, k).ok_or_else(|| anyhow!("missing argument '{k}'"))
}

fn ext_filter(format: &str) -> (&'static str, &'static [&'static str]) {
    match format {
        "png" => ("PNG image", &["png"]),
        "tiff" => ("TIFF image", &["tif", "tiff"]),
        "pdf" => ("PDF document", &["pdf"]),
        "svg" => ("SVG vector", &["svg"]),
        "biocraft" => ("BioCraft figure", &["biocraft"]),
        _ => ("File", &["*"]),
    }
}

fn save_dialog(format: &str, name: &str) -> Option<PathBuf> {
    save_dialog_in(format, name, None)
}

/// The save dialog, starting in `dir` when given (figures start in the figures folder).
fn save_dialog_in(format: &str, name: &str, dir: Option<&Path>) -> Option<PathBuf> {
    let (label, exts) = ext_filter(format);
    let d = rfd::FileDialog::new();
    let d = match dir.filter(|d| d.is_dir()) {
        Some(dir) => d.set_directory(dir),
        None => d,
    };
    d.set_title("Save as")
        .add_filter(label, exts)
        .set_file_name(format!("{name}.{}", exts[0]))
        .save_file()
}

fn mime(format: &str) -> &'static str {
    match format {
        "png" => "image/png",
        "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "svg" => "image/svg+xml",
        _ => "application/json",
    }
}

/// Write `bytes` to `path`, or (no path) ask where on desktop / hand them to the browser on web.
fn deliver(mode: Mode, format: &str, name: &str, path: Option<&str>, bytes: Vec<u8>) -> Result<Value> {
    let target = match path {
        Some(p) => Some(PathBuf::from(p)),
        None if mode == Mode::Desktop => match save_dialog(format, name) {
            Some(p) => Some(p),
            None => return Ok(json!({ "cancelled": true })),
        },
        None => None,
    };
    match target {
        Some(p) => {
            std::fs::write(&p, &bytes).with_context(|| format!("writing {}", p.display()))?;
            Ok(json!({ "path": p.display().to_string(), "bytes": bytes.len() }))
        }
        None => Ok(json!({
            "name": format!("{name}.{}", ext_filter(format).1[0]),
            "mime": mime(format),
            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "bytes": bytes.len(),
        })),
    }
}

/// The figure passed as `content`: its saved JSON text, or the object itself.
fn doc_arg(a: &Value) -> Result<Value> {
    match a.get("content") {
        Some(Value::String(t)) => serde_json::from_str(t).context("the figure is not valid JSON"),
        Some(v) if v.is_object() => Ok(v.clone()),
        _ => bail!("missing argument 'content'"),
    }
}

fn pick_files(title: &str, label: &str, exts: &[&str], multiple: bool) -> Vec<PathBuf> {
    let d = rfd::FileDialog::new().set_title(title).add_filter(label, exts);
    if multiple {
        d.pick_files().unwrap_or_default()
    } else {
        d.pick_file().into_iter().collect()
    }
}

pub fn dispatch(st: &AppState, cmd: &str, a: &Value, mode: Mode) -> Result<Value> {
    // The browser front end never names files on disk: reads and writes go through downloads
    // and file inputs, so a page can't make the server touch arbitrary paths.
    if mode == Mode::Web && (a.get("path").is_some_and(|p| !p.is_null()) || a.get("paths").is_some_and(|p| !p.is_null())) {
        bail!("file paths are only accepted in the desktop app");
    }
    match cmd {
        "app.info" => Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "mode": if mode == Mode::Desktop { "desktop" } else { "web" },
            "library": st.lib.read().unwrap().root.display().to_string(),
            "platform": std::env::consts::OS,
        })),

        "library.info" => Ok(st.lib.read().unwrap().info()),
        "library.search" => Ok(st.lib.read().unwrap().search(a)),
        "library.icon" => st.lib.read().unwrap().icon(need_str(a, "id")?),
        "library.favorite" => {
            let on = st.lib.write().unwrap().toggle_favorite(need_str(a, "id")?)?;
            Ok(json!({ "favorite": on }))
        }
        "library.recent" => {
            st.lib.write().unwrap().push_recent(need_str(a, "id")?)?;
            Ok(json!({}))
        }
        "library.import" => {
            let mut paths: Vec<PathBuf> = a
                .get("paths")
                .and_then(|p| p.as_array())
                .map(|v| v.iter().filter_map(|x| x.as_str().map(PathBuf::from)).collect())
                .unwrap_or_default();
            if paths.is_empty() && mode == Mode::Desktop {
                paths = pick_files("Add to My library", "SVG files and pictures", &["svg", "svgz", "png", "jpg", "jpeg", "gif"], true);
            }
            if paths.is_empty() {
                return Ok(json!({ "added": [], "errors": [] }));
            }
            let prepared = biocanvas_core::library::prepare_files(&paths, st.renderer());
            st.lib.write().unwrap().add_prepared_batch(prepared, arg_str(a, "category"))
        }
        // Uploads from the UI: {items: [{name, svg? (text) | base64? (bytes), tags?}], category?, note?}
        "library.importData" => {
            let items = a.get("items").and_then(|v| v.as_array()).ok_or_else(|| anyhow!("missing items"))?;
            let mut data = Vec::new();
            for it in items {
                let name = arg_str(it, "name").unwrap_or("My icon").to_string();
                let bytes = if let Some(svg) = arg_str(it, "svg") {
                    svg.as_bytes().to_vec()
                } else if let Some(b) = arg_str(it, "base64") {
                    base64::engine::general_purpose::STANDARD.decode(b.trim()).context("bad base64 data")?
                } else {
                    bail!("item '{name}' has no data");
                };
                let tags = it.get("tags").and_then(|t| t.as_array()).map(|t| t.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                data.push((name, bytes, tags));
            }
            let prepared = biocanvas_core::library::prepare_data(&data, st.renderer(), arg_str(a, "note").unwrap_or(""));
            st.lib.write().unwrap().add_prepared_batch(prepared, arg_str(a, "category"))
        }
        // {id, name?, category?, tags?: [..]}
        "library.updateUser" => {
            let tags = a.get("tags").and_then(|t| t.as_array()).map(|t| t.iter().filter_map(|x| x.as_str().map(String::from)).collect());
            st.lib.write().unwrap().update_user_icon(need_str(a, "id")?, arg_str(a, "name"), arg_str(a, "category"), tags)
        }
        "library.remove" => {
            st.lib.write().unwrap().remove_user_icon(need_str(a, "id")?)?;
            Ok(json!({}))
        }
        "app.revealUserLibrary" => {
            let dir = st.lib.read().unwrap().user_root.clone();
            std::fs::create_dir_all(&dir)?;
            open_path(&dir)?;
            Ok(json!({}))
        }

        // Clean an SVG placed straight onto the canvas so it can be recoloured like library icons.
        "svg.clean" => {
            let svg = need_str(a, "svg")?;
            let r = st.renderer();
            let tree = svgclean::parse(svg.as_bytes(), &r.options())?;
            let c = svgclean::clean(&tree, 0.0)?;
            Ok(json!({ "svg": c.svg, "w": c.w, "h": c.h, "raster": c.raster, "slots": palette::slots(&c.colors) }))
        }

        "doc.save" => {
            let content = need_str(a, "content")?;
            let name = arg_str(a, "name").unwrap_or("Untitled");
            // a figure not saved yet: the save dialog starts in the figures folder (the home page's My files)
            if mode == Mode::Desktop && arg_str(a, "path").is_none() {
                let root = crate::gallery::root(st);
                let _ = std::fs::create_dir_all(&root);
                return match save_dialog_in("biocraft", name, Some(&root)) {
                    Some(p) => {
                        let mut r = deliver(mode, "biocraft", name, Some(&p.display().to_string()), content.as_bytes().to_vec())?;
                        r["galleryId"] = json!(crate::gallery::id_for(st, &p));
                        Ok(r)
                    }
                    None => Ok(json!({ "cancelled": true })),
                };
            }
            let res = deliver(mode, "biocraft", name, arg_str(a, "path"), content.as_bytes().to_vec())?;
            Ok(res)
        }
        "doc.open" => {
            let path = match arg_str(a, "path") {
                Some(p) => PathBuf::from(p),
                None if mode == Mode::Desktop => {
                    match pick_files("Open figure", "BioCraft figure", &["biocraft", "biocanvas", "json"], false).pop() {
                        Some(p) => p,
                        None => return Ok(json!({ "cancelled": true })),
                    }
                }
                None => bail!("no path given"),
            };
            let content = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
            // (a figure in the figures folder is one of Home's: it saves itself as you work)
            Ok(json!({ "path": path.display().to_string(), "content": content, "galleryId": crate::gallery::id_for(st, &path) }))
        }
        // The figure the app was started with, once: {path, content, galleryId}, then null.
        "app.launchFile" => match st.launch_file.lock().unwrap().take() {
            Some(p) => {
                let content = std::fs::read_to_string(&p).with_context(|| format!("reading {}", p.display()))?;
                Ok(json!({ "path": p.display().to_string(), "content": content, "galleryId": crate::gallery::id_for(st, &p) }))
            }
            None => Ok(Value::Null),
        },
        "doc.autosave" => {
            let content = need_str(a, "content")?;
            std::fs::create_dir_all(&st.data_dir)?;
            std::fs::write(st.autosave_path(), content)?;
            Ok(json!({}))
        }
        "doc.autoload" => {
            match std::fs::read_to_string(st.autosave_path()) {
                Ok(c) => Ok(json!({ "content": c })),
                Err(_) => Ok(json!({})),
            }
        }
        // Pick a picture/SVG to place on the canvas; returns its data.
        "file.pickPlace" => {
            if mode != Mode::Desktop {
                bail!("use the browser file picker");
            }
            let files = pick_files("Place image or SVG", "Images and SVG", &["svg", "png", "jpg", "jpeg", "webp", "gif"], true);
            let mut out = Vec::new();
            for f in files {
                let bytes = std::fs::read(&f)?;
                let ext = f.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                out.push(json!({
                    "name": f.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
                    "ext": ext,
                    "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                }));
            }
            Ok(json!({ "files": out }))
        }

        // {format: png|tiff|pdf|svg, svg, dpi?, background?, name?, path?}
        "export" => {
            let format = need_str(a, "format")?;
            let svg = need_str(a, "svg")?;
            let name = arg_str(a, "name").unwrap_or("figure");
            let path = arg_str(a, "path");
            if format == "svg" {
                return deliver(mode, "svg", name, path, svg.as_bytes().to_vec());
            }
            let r = st.renderer();
            let tree = svgclean::parse(svg.as_bytes(), &r.options())?;
            let bytes = match format {
                "pdf" => to_pdf(&tree)?,
                "png" | "tiff" => {
                    let dpi = a.get("dpi").and_then(|v| v.as_f64()).unwrap_or(300.0) as f32;
                    let bg = arg_str(a, "background").and_then(Rgb::parse);
                    let pm = r.render_scaled(&tree, dpi / 96.0, bg)?;
                    if format == "png" { encode_png(&pm, Some(dpi))? } else { encode_tiff(&pm, dpi)? }
                }
                f => bail!("unknown export format {f}"),
            };
            deliver(mode, format, name, path, bytes)
        }

        // What the Export dialog shows before anything is written: {content, publication?} →
        // what the icons' licences allow and ask, and whether they fit the journal.
        "licence.summary" => {
            let doc = doc_arg(a)?;
            let p = licence::Publication::from_json(a.get("publication").filter(|v| !v.is_null()).or_else(|| doc.get("publication")));
            Ok(licence::summary(&doc, &p))
        }
        // Licence & attribution report for a figure: {content (the figure as saved), name?,
        // export?: {format, dpi, widthMm, heightMm} (what was exported), svg? (the exported figure,
        // shown on the first page), publication? (else the figure's own), preparedBy?, path?}.
        // Desktop: written beside the exported figure at `path` (fig.png → fig-licence.pdf/.md/.csv),
        // else where a save dialog says. Web: the three files come back as downloads.
        "licence.report" => {
            let doc = doc_arg(a)?;
            let name = arg_str(a, "name").unwrap_or("figure");
            let e = a.get("export").cloned().unwrap_or(Value::Null);
            let mm = |k: &str, d: &str| e.get(k).and_then(|v| v.as_f64()).or_else(|| doc.get(d).and_then(|v| v.as_f64())).unwrap_or(0.0);
            let header = licence::Header {
                title: arg_str(a, "title").unwrap_or(name).to_string(),
                exported_at: licence::now(),
                export: licence::export_line(e.get("format").and_then(|v| v.as_str()).unwrap_or(""), e.get("dpi").and_then(|v| v.as_f64()).unwrap_or(300.0), mm("widthMm", "width"), mm("heightMm", "height")),
                prepared_by: arg_str(a, "preparedBy").unwrap_or("").to_string(),
                publication: licence::Publication::from_json(a.get("publication").filter(|v| !v.is_null()).or_else(|| doc.get("publication"))),
                figure_svg: arg_str(a, "svg").map(String::from),
            };
            let paths = match arg_str(a, "path") {
                Some(p) => Some(licence::paths_beside(Path::new(p))),
                None if mode == Mode::Desktop => match save_dialog("pdf", &format!("{name}-licence")) {
                    Some(p) => Some(licence::paths_for(&p)),
                    None => return Ok(json!({ "cancelled": true })),
                },
                None => None,
            };
            let rep = licence::build(&doc, &header, st.renderer())?;
            match paths {
                Some(p) => Ok(rep.summary(&rep.write(&p)?)),
                None => {
                    let mut out = rep.summary(&[]);
                    out["downloads"] = rep
                        .files()
                        .iter()
                        .map(|(ext, mime, bytes)| json!({ "name": format!("{name}-licence.{ext}"), "mime": mime, "base64": base64::engine::general_purpose::STANDARD.encode(bytes), "bytes": bytes.len() }))
                        .collect();
                    Ok(out)
                }
            }
        }

        c if c.starts_with("gallery.") => crate::gallery::dispatch(st, c, a, mode),

        "app.openExternal" => {
            let url = need_str(a, "url")?;
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                bail!("only web links can be opened");
            }
            open_external(url)?;
            Ok(json!({}))
        }
        // Point the app at another library folder (one that holds index.json).
        "app.setLibrary" => {
            let dir = match arg_str(a, "path") {
                Some(p) => PathBuf::from(p),
                None if mode == Mode::Desktop => match rfd::FileDialog::new().set_title("Choose the BioCraft icon library folder").pick_folder() {
                    Some(p) => p,
                    None => return Ok(json!({ "cancelled": true })),
                },
                None => bail!("no folder given"),
            };
            let dir = if dir.join("index.json").exists() { dir } else if dir.join("library").join("index.json").exists() { dir.join("library") } else {
                bail!("{} has no index.json — choose the folder made by biocanvas-libbuild (usually named “library”)", dir.display())
            };
            let user_root = st.lib.read().unwrap().user_root.clone();
            let lib = Library::open(&dir, &user_root)?;
            *st.lib.write().unwrap() = lib;
            save_setting(&st.data_dir, "libraryPath", json!(dir.display().to_string()))?;
            Ok(st.lib.read().unwrap().info())
        }
        "app.revealLibrary" => {
            let root = st.lib.read().unwrap().root.clone();
            open_path(&root)?;
            Ok(json!({}))
        }
        _ => bail!("unknown command '{cmd}'"),
    }
}

fn open_external(url: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    r.map(|_| ()).map_err(|e| anyhow!("could not open link: {e}"))
}

pub(crate) fn open_path(p: &Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(p).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(p).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(p).spawn();
    r.map(|_| ()).map_err(|e| anyhow!("could not open folder: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_window_autosaves_to_its_own_file() {
        let dir = std::env::temp_dir().join(format!("biocraft-autosave-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (a, la) = claim_autosave(&dir);
        let (b, _lb) = claim_autosave(&dir);
        assert_eq!((a.file_name().unwrap(), b.file_name().unwrap()), ("autosave.biocraft".as_ref(), "autosave-2.biocraft".as_ref()));
        // the first slot is free again once its window has gone
        drop(la);
        assert_eq!(claim_autosave(&dir).0, a);
    }
}
