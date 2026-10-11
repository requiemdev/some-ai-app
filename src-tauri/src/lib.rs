use std::io::Write;
use std::process::{Command, Stdio};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// A non-activating panel takes keyboard input without making this app the active one,
// so the app underneath keeps its menu bar and active state.
#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(Overlay {
        config: {
            can_become_key_window: true,
            can_become_main_window: false
        }
    })
}

fn toggle(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    if window.is_visible()? {
        return window.hide();
    }
    show(app)
}

fn show(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let monitor = match window.current_monitor()? {
        Some(m) => Some(m),
        None => window.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        // Monitor position/size and outer_size are all physical pixels, so the
        // monitor's origin and scale factor are already accounted for.
        let (pos, size, win) = (monitor.position(), monitor.size(), window.outer_size()?);
        window.set_position(PhysicalPosition::new(
            pos.x + (size.width as i32 - win.width as i32) / 2,
            pos.y + (size.height as f64 * 0.22) as i32,
        ))?;
    }
    // set_focus would activate the app, defeating the non-activating panel.
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("main") {
            panel.show_and_make_key();
            return Ok(());
        }
    }
    window.show()?;
    window.set_focus()
}

// Apps launched from Finder don't inherit the shell's PATH, which is where claude/codex (and node) live.
#[cfg(unix)]
fn shell_path() -> Option<&'static str> {
    static PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let out = Command::new(shell)
            .args(["-ilc", "echo __PATH__$PATH"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        // rc files may print their own lines; the marker picks ours
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| l.strip_prefix("__PATH__"))
            .map(str::to_owned)
    })
    .as_deref()
}

// Runs the user's own claude/codex CLI, so their subscription login is used and never touched by this app.
fn run_cli(cli: &str, args: &[&str], input: &str) -> Result<String, String> {
    // The webview must not be able to start arbitrary programs.
    if cli != "claude" && cli != "codex" {
        return Err(format!("unknown CLI: {cli}"));
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        // npm installs .cmd shims, which only cmd resolves; CREATE_NO_WINDOW avoids a console flash.
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", cli]).creation_flags(0x0800_0000);
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(cli);
    #[cfg(unix)]
    if let Some(path) = shell_path() {
        cmd.env("PATH", path);
    }
    let mut child = cmd
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start `{cli}` ({e}). Install it and sign in first."))?;
    if let Some(mut stdin) = child.stdin.take() {
        // A CLI that exits early closes the pipe; its exit status below is the real error.
        let _ = stdin.write_all(input.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    );
    if out.status.success() {
        Ok(stdout)
    } else if stderr.is_empty() && stdout.is_empty() {
        Err(format!("`{cli}` failed ({})", out.status))
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

#[tauri::command(async)]
fn cli_status(cli: String) -> Result<(), String> {
    let signed_in = if cli == "claude" {
        let out = run_cli(&cli, &["auth", "status"], "").unwrap_or_default();
        serde_json::from_str::<serde_json::Value>(&out).is_ok_and(|v| v["loggedIn"] == true)
    } else {
        // exits non-zero when signed out
        run_cli(&cli, &["login", "status"], "").is_ok()
    };
    if signed_in {
        return Ok(());
    }
    // Tell a missing CLI apart from a signed-out one.
    run_cli(&cli, &["--version"], "")?;
    let login = if cli == "claude" {
        "claude auth login"
    } else {
        "codex login"
    };
    Err(format!(
        "Not signed in. Run `{login}` in a terminal, then try again."
    ))
}

#[tauri::command(async)]
fn codex_models() -> Result<String, String> {
    run_cli("codex", &["debug", "models"], "")
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Image {
    mime_type: String,
    data: String, // base64
}

// The formats both CLIs take. The extension lands in a temp file name, so it is never the webview's text.
fn image_ext(mime: &str) -> Result<&'static str, String> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        _ => Err(format!(
            "Subscriptions take PNG, JPEG, GIF or WebP images only, not {mime}"
        )),
    }
}

// `claude` only takes images as stream-json; the last "result" line of the stream holds the answer.
fn claude_answer(stream: &str) -> Option<Result<String, String>> {
    let result = stream
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find(|v| v["type"] == "result")?;
    let text = result["result"].as_str().unwrap_or_default().to_string();
    Some(if result["is_error"] == true {
        Err(text)
    } else {
        Ok(text)
    })
}

#[tauri::command(async)]
fn cli_ask(
    cli: String,
    model: String,
    effort: String,
    prompt: String,
    images: Vec<Image>,
) -> Result<String, String> {
    // The effort becomes a command-line argument too: only the known levels pass, "" being the CLI's default.
    if !["", "low", "medium", "high", "xhigh", "max"].contains(&effort.as_str()) {
        return Err(format!("invalid effort: {effort}"));
    }
    // The model becomes a command-line argument: keep it to a plain name, never a flag.
    if !model.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._".contains(c))
    {
        return Err(format!("invalid model name: {model}"));
    }
    let exts = images
        .iter()
        .map(|i| image_ext(&i.mime_type))
        .collect::<Result<Vec<_>, _>>()?;
    let model_args: &[&str] = if model == "default" {
        &[]
    } else {
        &["--model", &model]
    };
    // Chat only: no tools, no user customizations, nothing written to the CLI's session history.
    if cli == "claude" {
        let mut args = vec![
            "-p",
            "--safe-mode",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--tools",
            "",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose", // stream-json output requires it
        ];
        args.extend(model_args);
        if !effort.is_empty() {
            args.extend(["--effort", &effort]);
        }
        let mut content: Vec<_> = images
            .iter()
            .map(|i| {
                serde_json::json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": i.mime_type, "data": i.data }
                })
            })
            .collect();
        content.push(serde_json::json!({ "type": "text", "text": prompt }));
        let input = serde_json::json!({ "type": "user", "message": { "role": "user", "content": content } });
        // A failed turn still reports through the stream, so look there before trusting the exit status.
        let (Ok(out) | Err(out)) = run_cli(&cli, &args, &format!("{input}\n"));
        return claude_answer(&out).unwrap_or(Err(out));
    }
    // `codex exec` takes images as files only.
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let mut files = Vec::new();
    let result = (|| {
        for (image, ext) in images.iter().zip(exts) {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&image.data)
                .map_err(|e| format!("unreadable image: {e}"))?;
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("some-ai-app-{}-{n}.{ext}", std::process::id()));
            files.push(path.to_string_lossy().into_owned());
            std::fs::write(&path, bytes).map_err(|e| format!("could not store image: {e}"))?;
        }
        let effort_config = format!("model_reasoning_effort=\"{effort}\"");
        let mut args = vec![
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--color",
            "never",
        ];
        args.extend(model_args);
        if !effort.is_empty() {
            args.extend(["-c", &effort_config]);
        }
        // --image takes several values, so each file gets its own flag and they go last
        args.extend(files.iter().flat_map(|f| ["--image", f.as_str()]));
        run_cli(&cli, &args, &prompt)
    })();
    for file in &files {
        let _ = std::fs::remove_file(file);
    }
    result
}

// The shortcut that toggles the window; the setting in the webview replaces the default one.
struct ToggleShortcut(std::sync::Mutex<Shortcut>);

#[tauri::command]
fn set_shortcut(
    app: tauri::AppHandle,
    current: tauri::State<ToggleShortcut>,
    shortcut: String,
) -> Result<(), String> {
    let next: Shortcut = shortcut
        .parse()
        .map_err(|e| format!("unusable shortcut {shortcut}: {e}"))?;
    let mut current = current.0.lock().unwrap();
    if next == *current {
        return Ok(());
    }
    // New one first, so a failure leaves the old shortcut working.
    app.global_shortcut()
        .register(next)
        .map_err(|e| format!("could not use {shortcut} (held by another app?): {e}"))?;
    let _ = app.global_shortcut().unregister(*current);
    *current = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_bridge_rejects_untrusted_input() {
        assert!(run_cli("sh", &["-c", "true"], "").is_err());
        assert!(
            cli_ask(
                "claude".into(),
                "--dangerously-skip-permissions".into(),
                "".into(),
                "hi".into(),
                vec![]
            )
            .is_err()
        );
        assert!(cli_ask("claude".into(), "a b".into(), "".into(), "hi".into(), vec![]).is_err());
        assert!(cli_ask("claude".into(), "default".into(), "--x".into(), "hi".into(), vec![]).is_err());
        // an image type is never passed through to a file name or the CLI
        let svg = Image {
            mime_type: "image/svg+xml".into(),
            data: String::new(),
        };
        assert!(cli_ask("codex".into(), "default".into(), "".into(), "hi".into(), vec![svg]).is_err());
    }

    // the strings the settings panel builds from a key press
    #[test]
    fn shortcut_setting_parses() {
        for s in ["Ctrl+Shift+KeyA", "Cmd+Option+Space", "Super+Alt+F5", "Ctrl+Digit1", "Alt+ArrowUp"] {
            assert!(s.parse::<Shortcut>().is_ok(), "{s}");
        }
        assert!("Ctrl+Nope".parse::<Shortcut>().is_err());
    }

    #[test]
    fn claude_answer_reads_the_result_line() {
        let stream =
            "{\"type\":\"assistant\"}\n{\"type\":\"result\",\"is_error\":false,\"result\":\"Red\"}";
        assert_eq!(claude_answer(stream), Some(Ok("Red".into())));
        let failed = "{\"type\":\"result\",\"is_error\":true,\"result\":\"limit\"}";
        assert_eq!(claude_answer(failed), Some(Err("limit".into())));
        assert_eq!(claude_answer("not json"), None);
    }

    // Needs both CLIs installed and signed in: cargo test -- --ignored
    #[test]
    #[ignore]
    fn subscriptions_see_images() {
        // 1x1 red PNG
        let red = || {
            Image {
            mime_type: "image/png".into(),
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==".into(),
        }
        };
        for cli in ["claude", "codex"] {
            let prompt = "What single color fills this image? Answer in one word.";
            let answer = cli_ask(cli.into(), "default".into(), "low".into(), prompt.into(), vec![red()]).unwrap();
            assert!(answer.to_lowercase().contains("red"), "{cli}: {answer}");
        }
        assert!(codex_models().unwrap().contains("\"slug\""));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![cli_status, cli_ask, codex_models, set_shortcut])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Err(e) = toggle(app) {
                            eprintln!("toggle window failed: {e}");
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri_nspanel::{StyleMask, WebviewWindowExt};
                let panel = app
                    .get_webview_window("main")
                    .ok_or("main window missing")?
                    .to_panel::<Overlay>()?;
                panel.add_style_mask(StyleMask::empty().nonactivating_panel().into())?;
            }
            // Accessory = no Dock icon, no app menu, not in Cmd+Tab.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // Menu bar item on macOS, notification area on Windows: the only UI besides the shortcut.
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "Quit Astral", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("app icon missing")?.clone())
                .tooltip("Astral")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Err(e) = show(app).and_then(|_| app.emit("open-settings", ())) {
                            eprintln!("open settings failed: {e}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            // Literal Control key, not Command.
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyA);
            if let Err(e) = app.global_shortcut().register(shortcut) {
                eprintln!("could not register Ctrl+Shift+A (held by another app?): {e}");
            }
            app.manage(ToggleShortcut(std::sync::Mutex::new(shortcut)));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
