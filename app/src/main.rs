// Release builds on Windows have no console window.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod agent;
mod api;
mod brush;
mod figure;
mod gallery;
mod labels;
mod licence;
mod serve;

use api::{dispatch, AppState, Mode};
use biocanvas_core::Library;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// Per-user data folder: %APPDATA%\BioCraft, ~/Library/Application Support/BioCraft,
/// or $XDG_DATA_HOME/BioCraft. (Data from the app's earlier name, BioCanvas, is copied over once.)
fn data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming"));
    #[cfg(target_os = "macos")]
    let base = home.join("Library/Application Support");
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
    let dir = base.join("BioCraft");
    let old = base.join("BioCanvas");
    if !dir.exists() && old.is_dir() {
        let _ = copy_dir(&old, &dir);
        let _ = std::fs::rename(dir.join("autosave.biocanvas"), dir.join("autosave.biocraft"));
    }
    dir
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            std::fs::copy(e.path(), target)?;
        }
    }
    Ok(())
}

/// Search order: $BIOCRAFT_LIBRARY (or $BIOCANVAS_LIBRARY), the folder chosen in the app (settings.json), a `library/`
/// beside the executable or up to five folders above it (portable and development layouts),
/// the working directory, then the data folder.
fn library_root() -> PathBuf {
    if let Some(p) = std::env::var_os("BIOCRAFT_LIBRARY").or_else(|| std::env::var_os("BIOCANVAS_LIBRARY")) {
        return PathBuf::from(p);
    }
    if let Some(p) = api::saved_library_path(&data_dir()) {
        if p.join("index.json").exists() {
            return p;
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        candidates.extend(exe.ancestors().skip(1).take(6).map(|a| a.join("library")));
        // macOS bundles keep resources in Contents/Resources
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            candidates.push(contents.join("Resources/library"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("library"));
    }
    candidates
        .into_iter()
        .find(|c| c.join("index.json").exists())
        .unwrap_or_else(|| data_dir().join("library"))
}

/// The UI folder for --serve (desktop builds embed the UI instead).
fn ui_dir() -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        candidates.extend(exe.ancestors().skip(1).take(6).map(|a| a.join("ui")));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("ui"));
    }
    candidates.into_iter().find(|c| c.join("index.html").exists()).unwrap_or_else(|| PathBuf::from("ui"))
}

#[tauri::command]
async fn api(state: tauri::State<'_, Arc<AppState>>, cmd: String, args: Value) -> Result<Value, String> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || dispatch(&st, &cmd, &args, Mode::Desktop))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

fn open_state() -> AppState {
    let root = library_root();
    // the personal library lives in the user's data folder, never inside the built library
    let user_root = data_dir().join("my-library");
    let lib = Library::open(&root, &user_root).unwrap_or_else(|e| {
        eprintln!("library at {} could not be opened: {e:#}", root.display());
        Library::open(&data_dir().join("library"), &user_root).expect("empty library")
    });
    AppState::new(lib, data_dir())
}

fn is_figure_file(p: &std::path::Path) -> bool {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    matches!(ext.as_str(), "biocraft" | "biocanvas" | "json") && p.is_file()
}

/// `biocraft figure.biocraft` (or .biocanvas/.json): a figure to open at start-up.
fn launch_file(args: &[String]) -> Option<PathBuf> {
    args.iter().skip(1).filter(|a| !a.starts_with('-')).map(PathBuf::from).find(|p| is_figure_file(p))
    .map(|p| std::path::absolute(&p).unwrap_or(p))
}

/// macOS hands a figure double-clicked in the Finder to the app as an event (at start-up too), not
/// on the command line: it becomes the launch file, and the page is told to open it (main.js).
#[cfg(target_os = "macos")]
fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    use tauri::{Emitter, Manager};
    if let tauri::RunEvent::Opened { urls } = event {
        if let Some(p) = urls.iter().filter_map(|u| u.to_file_path().ok()).find(|p| is_figure_file(p)) {
            *app.state::<Arc<AppState>>().launch_file.lock().unwrap() = Some(p);
            let _ = app.emit("open-file", ());
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn on_run_event(_: &tauri::AppHandle, _: tauri::RunEvent) {}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // command line and MCP server for agents: no window
    if let Some(code) = agent::cli(&args, open_state) {
        std::process::exit(code);
    }
    let state = Arc::new(open_state());
    *state.launch_file.lock().unwrap() = launch_file(&args);

    if let Some(i) = args.iter().position(|a| a == "--serve") {
        let port = args.get(i + 1).and_then(|p| p.parse().ok()).unwrap_or(8780);
        serve::run(state, ui_dir(), port);
        return;
    }

    let lib_state = state.clone();
    tauri::Builder::default()
        .manage(state)
        .register_asynchronous_uri_scheme_protocol("lib", move |_ctx, request, responder| {
            let st = lib_state.clone();
            let path = serve::percent_decode(request.uri().path());
            tauri::async_runtime::spawn_blocking(move || {
                let rel = path.trim_start_matches('/');
                // plain relative paths only: no "..", no drive letters or roots that would escape the library
                let ok = !rel.is_empty() && std::path::Path::new(rel).components().all(|c| matches!(c, std::path::Component::Normal(_)));
                let file = st.lib.read().unwrap().resolve(rel);
                let resp = match (ok, std::fs::read(&file)) {
                    (true, Ok(data)) => {
                        let ct = if rel.ends_with(".svg") { "image/svg+xml" } else if rel.ends_with(".png") { "image/png" } else { "application/octet-stream" };
                        tauri::http::Response::builder()
                            .header("Content-Type", ct)
                            // your own icons can change under the same name; library files don't
                            .header("Cache-Control", if rel.starts_with("user/") { "no-cache" } else { "max-age=3600" })
                            .header("Access-Control-Allow-Origin", "*")
                            .body(data)
                    }
                    _ => tauri::http::Response::builder().status(404).body(Vec::new()),
                };
                responder.respond(resp.unwrap());
            });
        })
        .invoke_handler(tauri::generate_handler![api])
        .build(tauri::generate_context!())
        .expect("error while running BioCraft")
        .run(on_run_event);
}
