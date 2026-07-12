// vean local Mac app — V1 thin consumer shell (Move 4, slice 1).
//
// The app owns NO domain logic. It is a native shell that consumes the SAME
// surfaces the CLI / MCP / LSP do:
//
//   • a SIDECAR SUPERVISOR spawns `vean preview` (the `preview.serve` action) bound
//     to a free 127.0.0.1 port, waits for it to listen, and kills it on exit /
//     project switch — the one real "background" primitive the app adds;
//   • the main webview NAVIGATES to that sidecar URL, so the existing `viewer/`
//     renders the real timeline + composited preview with ZERO app-side UI;
//   • native macOS menu gestures route through the action runtime: "Open Project
//     Folder…" restarts the sidecar against a real folder picked in Finder (the
//     file-path-native win — no route-alias ceremony), and every registered action
//     is reachable through the generic `run_action` bridge that shells to
//     `vean action run <id> --json`.
//
// Transport posture (V1): sidecar HTTP. Structured actions can migrate to `invoke`
// incrementally behind viewer/src/api.ts; media stays on loopback HTTP because
// WKWebView's custom-scheme handler is the weak link for <video> Range seeking.

use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

mod harness_static_probe;

const MACOS_RENDERER_TRIPLE: &str = "aarch64-apple-darwin";

/// The live preview sidecar: the child process, the port it bound, and the project
/// root it was started against.
struct Sidecar {
    child: Option<Child>,
    process_group: i32,
    port: u16,
    project: PathBuf,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // The preview process may own Vite/render descendants. Killing only
            // the direct Child leaks those descendants after project switch/quit.
            // Every sidecar starts a fresh process group; terminate the group,
            // then reap the direct child so no zombie remains.
            unsafe {
                libc::kill(-self.process_group, libc::SIGTERM);
            }
            std::thread::sleep(Duration::from_millis(100));
            unsafe {
                libc::kill(-self.process_group, libc::SIGKILL);
            }
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
}

/// The vean repo root. Dev-from-source resolves it from the crate manifest dir
/// (`<repo>/app/src-tauri` → `<repo>`); `VEAN_REPO` overrides for other layouts
/// (e.g. a bundled app pointing at an installed checkout).
fn vean_repo() -> PathBuf {
    if let Ok(repo) = std::env::var("VEAN_REPO") {
        return PathBuf::from(repo);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .join("..")
        .join("..")
        .canonicalize()
        .unwrap_or(manifest)
}

/// The runtime that runs the vean CLI (`bun` by default; `VEAN_BIN` overrides).
fn vean_bin() -> String {
    std::env::var("VEAN_BIN").unwrap_or_else(|_| "bun".to_string())
}

/// The project the app should boot at: the persisted active project from
/// `~/.vean/projects.json` (set by `vean open` / `vean project use`), or the repo
/// root when none is selected. Lets `vean open <project>` land the app straight at
/// that project instead of always the repo root.
fn boot_project() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        let cfg = PathBuf::from(home).join(".vean").join("projects.json");
        if let Ok(text) = std::fs::read_to_string(&cfg) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(root) = json.get("activeProjectRoot").and_then(|v| v.as_str()) {
                    let p = PathBuf::from(root);
                    if p.exists() {
                        return p;
                    }
                }
            }
        }
    }
    vean_repo()
}

/// Ask the OS for a free loopback port by binding :0 and reading it back.
fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Resolve the bundled renderer sidecars and return the env that points the driver
/// (`src/driver/melt.ts` → `resolveBin`) at them: VEAN_MELT/FFMPEG/FFPROBE plus the
/// MLT_* module/profile/data dirs. Empty when no bundle is present — dev on a
/// Homebrew machine then falls back to system melt/ffmpeg. In a packaged `.app` the
/// binaries live in `Contents/MacOS` (Tauri strips the target-triple suffix) with
/// data under `Contents/Resources/sidecars`; in a source tree they're under
/// `app/src-tauri/sidecars/bin` carrying the `-<triple>` suffix.
fn renderer_env(app: &AppHandle) -> Vec<(String, String)> {
    let triple = MACOS_RENDERER_TRIPLE;
    // (bin_dir, sidecars_root) candidates, packaged first then the dev tree.
    let mut roots: Vec<(PathBuf, PathBuf)> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        roots.push((res.join("..").join("MacOS"), res.join("sidecars")));
        roots.push((res.join("sidecars").join("bin"), res.join("sidecars")));
    }
    let dev = vean_repo().join("app").join("src-tauri").join("sidecars");
    roots.push((dev.join("bin"), dev));

    for (bin_dir, sidecars) in roots {
        for (suffix, melt_name) in [
            (format!("-{triple}"), format!("melt-{triple}")),
            (String::new(), "melt".to_string()),
        ] {
            let melt = bin_dir.join(&melt_name);
            let lib_mlt = sidecars.join("lib").join("mlt");
            let data = sidecars.join("share").join("mlt");
            if melt.exists() && lib_mlt.is_dir() && data.is_dir() {
                let s = |p: PathBuf| p.to_string_lossy().into_owned();
                // The renderer dylib dir (`sidecars/lib`): the flat libav*/libmlt*
                // closure the bundled melt/ffmpeg/ffprobe link against. In a packaged
                // `.app` the bins live in `Contents/MacOS` but the dylibs are in
                // `Contents/Resources/sidecars/lib`, so the bins' baked
                // `@loader_path/../lib` rpath (which assumes bin/lib are siblings, the
                // dev-tree layout) points at the non-existent `Contents/lib`. melt
                // limps by on a Homebrew dev machine via a leftover
                // `/opt/homebrew/.../lib` rpath, but `ffprobe` has only the broken
                // rpath and CRASHES on launch (dyld: libavdevice not loaded) — which
                // made `sourceHasAlpha` silently fail and degrade every alpha overlay
                // to an opaque proxy. Pointing DYLD_FALLBACK_LIBRARY_PATH at the real
                // lib dir makes all three bins resolve their dylibs regardless of baked
                // rpath, on a clean Mac (no Homebrew). Fallback (not LIBRARY_PATH) so it
                // only fills gaps and never shadows a system dylib.
                let lib = sidecars.join("lib");
                let dyld = format!("{}:/usr/local/lib:/usr/lib", s(lib));
                return vec![
                    ("VEAN_MELT".into(), s(melt)),
                    (
                        "VEAN_FFMPEG".into(),
                        s(bin_dir.join(format!("ffmpeg{suffix}"))),
                    ),
                    (
                        "VEAN_FFPROBE".into(),
                        s(bin_dir.join(format!("ffprobe{suffix}"))),
                    ),
                    ("DYLD_FALLBACK_LIBRARY_PATH".into(), dyld),
                    ("MLT_REPOSITORY".into(), s(lib_mlt)),
                    ("MLT_DATA".into(), s(data.clone())),
                    ("MLT_PROFILES_PATH".into(), s(data.join("profiles"))),
                    ("MLT_PRESETS_PATH".into(), s(data.join("presets"))),
                ];
            }
        }
    }
    Vec::new()
}

/// Whether the preview sidecar should serve the live Vite/HMR viewer (dev) or the
/// pre-built `viewer/dist` snapshot (prod). Priority:
///   1. `VEAN_PREVIEW_MODE=dev|prod` — explicit override (`vean open --view app
///      --dev` sets `dev`; a developer can force either).
///   2. otherwise the build profile: `tauri dev` builds debug → HMR; `tauri build`
///      builds release → snapshot. This makes the dev app hot-reload the viewer
///      with zero config while the shipped app keeps the static snapshot.
///
/// Dev is then GUARDED on the `viewer/` source actually being present — a shipped
/// bundle has no source (or `bun`/Vite) to run a dev server, so it falls back to
/// the snapshot even if it somehow reaches here as a debug build.
fn preview_dev_mode() -> bool {
    let want_dev = match std::env::var("VEAN_PREVIEW_MODE").as_deref() {
        Ok("dev") => true,
        Ok("prod") => false,
        _ => cfg!(debug_assertions),
    };
    want_dev && vean_repo().join("viewer").join("vite.config.ts").exists()
}

/// Spawn `vean preview` against `project`, bound to `port`, with the renderer env
/// (bundled sidecars or, when empty, system deps). In dev-from-source (`tauri dev`)
/// it serves the live Vite/HMR viewer so edits under `viewer/` hot-reload straight
/// into this native window; the shipped release bundle serves the pre-built
/// `<repo>/viewer/dist` snapshot (see `preview_dev_mode`).
fn spawn_sidecar(project: &PathBuf, port: u16, env: &[(String, String)]) -> std::io::Result<Child> {
    let cli = vean_repo().join("src").join("cli.ts");
    let mut cmd = Command::new(vean_bin());
    cmd.arg(cli).arg("preview").arg("--no-open");
    cmd.process_group(0);
    cmd.env(
        "VEAN_PROCESS_MARKER",
        format!("vean-sidecar-{}-{port}", std::process::id()),
    );
    // `vean preview` defaults to the live Vite/HMR dev server; `--prod` pins it to
    // the static viewer/dist snapshot. Pass `--prod` only when NOT dev-from-source —
    // so the dev native window hot-reloads the viewer (the whole point) while the
    // shipped bundle, which has no source or Vite to run, keeps the snapshot.
    if !preview_dev_mode() {
        cmd.arg("--prod");
    }
    cmd.arg("--port")
        .arg(port.to_string())
        .arg("--repo")
        .arg(project)
        .current_dir(project);
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.spawn()
}

/// Block until the sidecar port accepts connections, polling every 100ms for up to
/// `max_attempts` tries (or give up). Once the Bun server is listening it can serve
/// the viewer + the read API immediately.
fn wait_for_port(port: u16, max_attempts: u32) -> bool {
    for _ in 0..max_attempts {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Point the main webview at the sidecar URL once it is reachable. Full-window
/// navigation (not an iframe) keeps the viewer page a plain http origin, sidesteps
/// secure-context mixed-content blocking, and lets native menu gestures stay
/// Rust-side (so they survive the navigation away from the app shell).
fn navigate_to_sidecar(app: &AppHandle, port: u16) {
    // Prod binds almost instantly (it's just a static host). Dev awaits Vite
    // readiness *before* it binds the port, and a first-ever run also pre-bundles
    // viewer deps — so give dev a much larger budget (~90s vs ~15s) or the initial
    // `tauri dev` launch would abandon a sidecar that's merely still warming up.
    let attempts = if preview_dev_mode() { 900 } else { 150 };
    if !wait_for_port(port, attempts) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(url) = format!("http://127.0.0.1:{port}/").parse() {
            let _ = window.navigate(url);
        }
    }
}

/// Start (or restart) the sidecar against `project`: replace any existing child
/// (dropping it kills the old process), pick a fresh port, spawn, and navigate the
/// webview once the new server is up. Returns the bound port.
fn restart_sidecar(app: &AppHandle, project: PathBuf) -> Result<u16, String> {
    let port = free_port().map_err(|e| e.to_string())?;
    let env = renderer_env(app);
    let child = spawn_sidecar(&project, port, &env).map_err(|e| e.to_string())?;
    let process_group = child.id() as i32;
    {
        let state = app.state::<AppState>();
        let mut guard = state.sidecar.lock().map_err(|e| e.to_string())?;
        // Replacing the Option drops the previous Sidecar → kills the old child.
        *guard = Some(Sidecar {
            child: Some(child),
            process_group,
            port,
            project,
        });
    }
    let app = app.clone();
    std::thread::spawn(move || navigate_to_sidecar(&app, port));
    Ok(port)
}

/// The active project root, or the repo root if no project is selected yet.
fn active_project(app: &AppHandle) -> PathBuf {
    app.state::<AppState>()
        .sidecar
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|s| s.project.clone()))
        .unwrap_or_else(vean_repo)
}

/// Run a vean action through the canonical CLI escape hatch and return its parsed
/// envelope (`{ ok, actionId, output, project }`). Shells to
/// `vean action run <id> --input-json <json> --json` with cwd = the active project
/// so project context resolves correctly. This is the GENERIC bridge: one path
/// projects every registered action, with no per-action Rust.
fn run_action_internal(
    project: &PathBuf,
    id: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let cli = vean_repo().join("src").join("cli.ts");
    let output = Command::new(vean_bin())
        .arg(cli)
        .arg("action")
        .arg("run")
        .arg(id)
        .arg("--input-json")
        .arg(input.to_string())
        .arg("--json")
        .current_dir(project)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .map_err(|e| format!("could not parse action envelope: {e}\nstdout: {stdout}"))
}

// ── invoke commands (app shell + future hybrid transport) ───────────────────

/// The port the preview sidecar bound, for the splash to display while Rust
/// navigates the window.
#[tauri::command]
fn preview_port(state: State<AppState>) -> Option<u16> {
    state
        .sidecar
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.port))
}

/// Generic action bridge exposed to the webview. The end-state hybrid transport
/// moves structured action calls here from HTTP; V1 wires it for completeness and
/// the native gestures below use the same `run_action_internal`.
#[tauri::command]
fn run_action(
    app: AppHandle,
    id: String,
    input: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let project = active_project(&app);
    run_action_internal(
        &project,
        &id,
        &input.unwrap_or_else(|| serde_json::json!({})),
    )
}

// ── native menu gestures (handled Rust-side; survive webview navigation) ────

/// "Open Project Folder…" — pick a real folder in Finder and restart the editor
/// against it. THE file-path-native win: no route-alias ceremony, the user points
/// at an actual directory and the sidecar resolves the project there.
fn open_project_flow(app: &AppHandle) {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return;
    };
    let Ok(path) = folder.into_path() else {
        return;
    };
    if let Err(err) = restart_sidecar(app, path) {
        let _ = app
            .dialog()
            .message(format!("Could not open project: {err}"))
            .title("vean")
            .blocking_show();
    }
}

/// "Add Media Root…" — pick a folder and register it as a project media root via
/// the action runtime, exercising the generic `run_action` bridge end-to-end with
/// a real native path.
fn add_media_root_flow(app: &AppHandle) {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return;
    };
    let Ok(path) = folder.into_path() else {
        return;
    };
    let project = active_project(app);
    let input = serde_json::json!({ "path": path.to_string_lossy() });
    let message = match run_action_internal(&project, "media.root.add", &input) {
        Ok(env) if env.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) => format!(
            "Added media root:\n{}",
            serde_json::to_string_pretty(env.get("output").unwrap_or(&env)).unwrap_or_default()
        ),
        Ok(env) => format!("media.root.add failed:\n{env}"),
        Err(err) => format!("media.root.add error:\n{err}"),
    };
    let _ = app.dialog().message(message).title("vean").blocking_show();
}

/// "Project Info" — read-only proof of the generic action bridge.
fn project_info_flow(app: &AppHandle) {
    let project = active_project(app);
    let message = match run_action_internal(&project, "project.current", &serde_json::json!({})) {
        Ok(env) => serde_json::to_string_pretty(&env).unwrap_or_else(|_| env.to_string()),
        Err(err) => format!("error: {err}"),
    };
    let _ = app
        .dialog()
        .message(message)
        .title("Current project")
        .blocking_show();
}

/// Build the macOS menu and route its events to the gesture handlers. Dialogs block,
/// so each handler runs on its own thread (off the menu-event/main thread).
fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let open_project = MenuItemBuilder::with_id("open_project", "Open Project Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let add_media = MenuItemBuilder::with_id("add_media_root", "Add Media Root…").build(app)?;
    let project_info = MenuItemBuilder::with_id("project_info", "Project Info").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "vean")
        .about(None)
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_project)
        .item(&add_media)
        .separator()
        .item(&project_info)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(move |app, event| {
        let app = app.clone();
        match event.id().as_ref() {
            "open_project" => {
                std::thread::spawn(move || open_project_flow(&app));
            }
            "add_media_root" => {
                std::thread::spawn(move || add_media_root_flow(&app));
            }
            "project_info" => {
                std::thread::spawn(move || project_info_flow(&app));
            }
            _ => {}
        }
    });
    Ok(())
}

/// Navigation is deliberately narrower than the CSP resource policy: the app
/// shell may load from Tauri's internal scheme, then only the exact loopback IP
/// used by the managed preview sidecar. `localhost` and arbitrary hostnames are
/// rejected so DNS/hosts-file rebinding cannot widen the authority origin.
fn navigation_allowed(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
}

fn navigation_policy_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-policy")
        .on_navigation(|_webview, url| navigation_allowed(url))
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(navigation_policy_plugin())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![preview_port, run_action])
        .setup(|app| {
            let handle = app.handle().clone();
            install_menu(&handle)?;
            // Boot the sidecar against the persisted active project (so `vean open
            // <project>` lands here), falling back to the repo root; the user switches
            // via File → Open Project Folder….
            if let Err(err) = restart_sidecar(&handle, boot_project()) {
                eprintln!("vean: failed to start preview sidecar: {err}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running vean app");
}

#[cfg(test)]
mod tests {
    use super::{free_port, MACOS_RENDERER_TRIPLE};

    #[test]
    fn free_port_returns_a_rebindable_loopback_port() {
        let port = free_port().expect("loopback port should be available");
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(rebound.is_ok(), "free_port must release its probe listener");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn packaged_renderer_triple_matches_the_macos_build_architecture() {
        assert_eq!(std::env::consts::ARCH, "aarch64");
        assert_eq!(MACOS_RENDERER_TRIPLE, "aarch64-apple-darwin");
    }
}
