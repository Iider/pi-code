// pi-code desktop shell (Tauri v2).
//
// Startup flow:
//   1. show the bundled startup page and generate a per-launch bearer token
//   2. reserve the stable desktop port
//   3. spawn the pi-code-server sidecar (Bun-compiled single binary) with
//      --port/--no-open/--web-dist pointing at the bundled WebUI resources
//   4. navigate the visible window to the WebUI when the server is ready
//   5. kill the sidecar when the app exits

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

const DESKTOP_SERVER_PORT: u16 = 8766;

const DESKTOP_INIT_SCRIPT: &str = r#"
window.__PI_CODE_DESKTOP__ = true;
document.documentElement.classList.add('pi-code-desktop');
"#;

struct SidecarChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom_fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// Avoid pulling in the `rand` crate: read 32 bytes from the OS CSPRNG.
fn getrandom_fill(buf: &mut [u8]) {
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom").expect("open /dev/urandom");
    f.read_exact(buf).expect("read urandom");
}

fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(SidecarChild(Mutex::new(None)));

            let token = if cfg!(debug_assertions) && std::env::var("PI_CODE_DESKTOP_DEV").is_ok() {
                // Deterministic token for dev-mode browser cross-checks.
                "dev-token".to_string()
            } else {
                random_token()
            };

            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .initialization_script(DESKTOP_INIT_SCRIPT);

            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                // Align the native controls with Pi Code's 42 px Web UI
                // titlebar and leave a little more breathing room at the edge.
                .traffic_light_position(tauri::LogicalPosition::new(13.0, 23.0));

            let window = window
                // The Web UI owns the visible titlebar. Keeping a native title
                // here duplicates the Pi Code brand beside the traffic lights.
                .title("")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .build()?;

            let port = DESKTOP_SERVER_PORT;
            let port_reservation = match std::net::TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("[pi-code-desktop] port {port} is unavailable: {error}");
                    let _ = window.eval(
                        "window.showStartupError?.('本地端口 8766 已被占用，请关闭占用程序后重试')",
                    );
                    return Ok(());
                }
            };

            // Release: bundled resource dir. Dev (cargo run): the staged
            // resources under src-tauri/.
            let web_dist = {
                let bundled = app.path().resource_dir()?.join("webapp-dist");
                if bundled.is_dir() {
                    bundled
                } else {
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("resources/webapp-dist")
                }
            }
            .to_string_lossy()
            .to_string();

            let sidecar = app.shell().sidecar("pi-code-server")?;
            let port_str = port.to_string();
            drop(port_reservation);
            let (mut rx, child) = match sidecar
                .args(["--port", &port_str, "--no-open", "--web-dist", &web_dist])
                .env("PI_CODE_TOKEN", &token)
                .env("PI_CODE_DESKTOP", "1")
                .env("PI_CODE_HOME", {
                    // Keep desktop state separate from the CLI server's.
                    let home = dirs_home().unwrap_or_else(|| ".".to_string());
                    format!("{home}/.pi-code-desktop")
                })
                .spawn()
            {
                Ok(result) => result,
                Err(error) => {
                    eprintln!("[pi-code-desktop] failed to start server sidecar: {error}");
                    let _ = window.eval(
                        "window.showStartupError?.('本地服务启动失败，请重新安装或重新打开应用')",
                    );
                    return Ok(());
                }
            };

            *app.state::<SidecarChild>()
                .0
                .lock()
                .expect("sidecar state poisoned") = Some(child);

            // Drain sidecar stdout/stderr so its pipes never fill up.
            std::thread::spawn(move || {
                while let Some(event) = rx.blocking_recv() {
                    if let CommandEvent::Stderr(line) = &event {
                        eprintln!("[pi-code-server] {}", String::from_utf8_lossy(line));
                    }
                }
            });

            // The explicit marker lets the WebUI enable native window chrome
            // even when Tauri's internal bridge is not exposed to a remote
            // WebView origin. It lives outside the hash so the auth token is
            // never used as an environment signal.
            let url = format!("http://127.0.0.1:{port}/?desktop=1#token={token}");
            std::thread::spawn(move || {
                if wait_for_server(port, Duration::from_secs(20)) {
                    let _ = window.eval("window.updateStartupStatus?.('正在准备工作台…')");
                    if let Err(error) = window.navigate(url.parse().expect("valid url")) {
                        eprintln!("[pi-code-desktop] failed to open WebUI: {error}");
                        let _ = window
                            .eval("window.showStartupError?.('工作台加载失败，请退出应用后重试')");
                    }
                } else {
                    eprintln!("[pi-code-desktop] server sidecar did not start within 20 seconds");
                    let _ = window
                        .eval("window.showStartupError?.('本地服务启动超时，请退出应用后重试')");
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build failed")
        .run(|app_handle: &tauri::AppHandle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(child) = app_handle
                    .state::<SidecarChild>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|mut guard| guard.take())
                {
                    let _ = child.kill();
                }
            }
        });
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok()
}
