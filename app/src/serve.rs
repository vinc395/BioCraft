//! `biocraft --serve [port]`: the same app in a web browser at http://127.0.0.1:<port>.
//! Used for development and as a fallback where no system webview is available.

use crate::api::{dispatch, AppState, Mode};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tiny_http::{Header, Method, Response, Server};

fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Join a URL path onto `base`, refusing anything that climbs out of it.
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let rel = percent_decode(rel);
    let mut out = base.to_path_buf();
    for c in Path::new(rel.trim_start_matches('/')).components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

pub fn run(state: Arc<AppState>, ui_dir: PathBuf, port: u16) {
    let server = match Server::http(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("could not listen on port {port}: {e}");
            return;
        }
    };
    println!("BioCraft is running at http://127.0.0.1:{port}  (library: {})", state.lib.read().unwrap().root.display());
    for mut req in server.incoming_requests() {
        let state = state.clone();
        let ui_dir = ui_dir.clone();
        std::thread::spawn(move || {
            let url = req.url().split('?').next().unwrap_or("/").to_string();
            // Only this app's own pages may talk to the server: reject other hosts (DNS rebinding)
            // and cross-site requests, which browsers mark with a foreign Origin header.
            let head = |k: &'static str| req.headers().iter().find(|h| h.field.equiv(k)).map(|h| h.value.as_str().to_string());
            let own = |v: &str| v == format!("127.0.0.1:{port}") || v == format!("localhost:{port}");
            let host_ok = head("Host").map(|h| own(&h)).unwrap_or(false);
            let origin_ok = head("Origin").map(|o| own(o.trim_start_matches("http://"))).unwrap_or(true);
            if !host_ok || !origin_ok {
                let _ = req.respond(Response::from_string("forbidden").with_status_code(403));
                return;
            }
            if req.method() == &Method::Post && url.starts_with("/api/") {
                // JSON only: a cross-site page can't send this content type without a CORS preflight
                if !head("Content-Type").map(|c| c.starts_with("application/json")).unwrap_or(false) {
                    let _ = req.respond(Response::from_string("expected application/json").with_status_code(415));
                    return;
                }
                let cmd = url.trim_start_matches("/api/").to_string();
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let args: Value = serde_json::from_str(&body).unwrap_or(json!({}));
                let (code, out) = match dispatch(&state, &cmd, &args, Mode::Web) {
                    Ok(v) => (200, json!({ "ok": true, "result": v })),
                    Err(e) => (200, json!({ "ok": false, "error": format!("{e:#}") })),
                };
                let resp = Response::from_string(out.to_string())
                    .with_status_code(code)
                    .with_header(header("Content-Type", "application/json"));
                let _ = req.respond(resp);
                return;
            }
            let file = if let Some(rest) = url.strip_prefix("/lib/") {
                // "user/…" files come from the personal library folder
                let rest = percent_decode(rest);
                let lib = state.lib.read().unwrap();
                match rest.strip_prefix("user/") {
                    Some(r) => safe_join(&lib.user_root, r),
                    None => safe_join(&lib.root, &rest),
                }
            } else {
                let rel = if url == "/" { "index.html" } else { url.as_str() };
                safe_join(&ui_dir, rel)
            };
            let resp = match file.and_then(|f| std::fs::read(&f).ok().map(|d| (f, d))) {
                Some((f, data)) => Response::from_data(data)
                    .with_header(header("Content-Type", content_type(&f)))
                    // your own icons can change under the same name; built library files don't
                    .with_header(header("Cache-Control", if url.starts_with("/lib/") && !url.starts_with("/lib/user/") { "max-age=3600" } else { "no-cache" })),
                None => Response::from_string("not found").with_status_code(404),
            };
            let _ = req.respond(resp);
        });
    }
}
