use std::io::Write;
use std::process::{Command, Stdio};
use tauri::{Manager, PhysicalPosition};
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
fn cli_ask(cli: String, model: String, prompt: String) -> Result<String, String> {
    // The model becomes a command-line argument: keep it to a plain name, never a flag.
    if !model.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._".contains(c))
    {
        return Err(format!("invalid model name: {model}"));
    }
    // Chat only: no tools, no user customizations, nothing written to the CLI's session history.
    let mut args = if cli == "claude" {
        vec![
            "-p",
            "--safe-mode",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--tools",
            "",
        ]
    } else {
        vec![
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--color",
            "never",
        ]
    };
    if model != "default" {
        args.extend(["--model", &model]);
    }
    run_cli(&cli, &args, &prompt)
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
                "hi".into()
            )
            .is_err()
        );
        assert!(cli_ask("claude".into(), "a b".into(), "hi".into()).is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![cli_status, cli_ask])
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
            // Literal Control key, not Command.
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyA);
            if let Err(e) = app.global_shortcut().register(shortcut) {
                eprintln!("could not register Ctrl+Shift+A (held by another app?): {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
