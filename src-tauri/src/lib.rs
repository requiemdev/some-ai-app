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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .plugin(tauri_plugin_opener::init())
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
