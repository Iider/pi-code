// pi-code desktop shell (Tauri v2).
//
// Startup flow:
//   1. pick a free local port and generate a per-launch bearer token
//   2. spawn the pi-code-server sidecar (Bun-compiled single binary) with
//      --port/--no-open/--web-dist pointing at the bundled webapp resources
//   3. wait for the server socket, then open the window at
//      http://127.0.0.1:<port>/#token=<token>
//   4. kill the sidecar when the app exits

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

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
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();
            drop(listener);

            let token = if cfg!(debug_assertions) && std::env::var("PI_CODE_DESKTOP_DEV").is_ok() {
                // Deterministic token for dev-mode browser cross-checks.
                "dev-token".to_string()
            } else {
                random_token()
            };

            // Release: bundled resource dir. Dev (cargo run): the staged
            // resources under src-tauri/.
            let web_dist = {
                let bundled = app
                    .path()
                    .resource_dir()?
                    .join("webapp-dist");
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
            let (mut rx, child) = sidecar
                .args([
                    "--port",
                    &port_str,
                    "--no-open",
                    "--web-dist",
                    &web_dist,
                ])
                .env("PI_CODE_TOKEN", &token)
                .env("PI_CODE_DESKTOP", "1")
                .env("PI_CODE_HOME", {
                    // Keep desktop state separate from the CLI server's.
                    let home = dirs_home().unwrap_or_else(|| ".".to_string());
                    format!("{home}/.pi-code-desktop")
                })
                .spawn()?;

            app.manage(SidecarChild(Mutex::new(Some(child))));

            // Drain sidecar stdout/stderr so its pipes never fill up.
            std::thread::spawn(move || {
                while let Some(event) = rx.blocking_recv() {
                    if let CommandEvent::Stderr(line) = &event {
                        eprintln!("[pi-code-server] {}", String::from_utf8_lossy(line));
                    }
                }
            });

            if !wait_for_server(port, Duration::from_secs(20)) {
                return Err("pi-code server sidecar did not start".into());
            }

            let url = format!("http://127.0.0.1:{port}/#token={token}");
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().expect("valid url")),
            )
            .title("pi-code")
            .inner_size(1440.0, 900.0)
            .min_inner_size(960.0, 600.0)
            .build()?;

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
