mod slug;
mod storage;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Emitted to the frontend when the tray's Quit item is chosen. The frontend flushes any
/// pending autosave and then calls [`quit_app`]. See [`request_quit`] for the deadline
/// that keeps a wedged renderer from making the app unquittable.
const EVENT_QUIT_REQUESTED: &str = "stickytabs://quit-requested";

/// Emitted when the window is shown by the tray or the global hotkey, so the frontend can
/// put the caret back where the user left it.
const EVENT_SHOWN: &str = "stickytabs://shown";

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// The show/hide hotkey, Ctrl+Shift+N.
#[cfg(desktop)]
fn hotkey() -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN)
}

/// Write the current window geometry to disk.
///
/// The window-state plugin otherwise only saves on a clean exit. This app spends most of
/// its life hidden in the tray, where a reboot or a killed process never reaches that
/// path — so position and size would silently reset. Saving at each hide costs one small
/// file write and makes the geometry survive however the process ends.
fn save_geometry(app: &AppHandle) {
    let _ = app.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
}

/// Bring the window back and put the caret where the user left it.
fn show_and_focus(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    let _ = window.emit(EVENT_SHOWN, ());
}

/// Show + focus, or hide, depending on current visibility.
fn toggle_visibility(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);

    // Visible but unfocused (buried behind another window) counts as "not really here",
    // so the hotkey raises it instead of hiding it.
    if visible && focused {
        save_geometry(app);
        let _ = window.hide();
    } else {
        show_and_focus(app);
    }
}

/// Ask the frontend to flush and quit, with a hard deadline.
fn request_quit(app: &AppHandle) {
    let _ = app.emit(EVENT_QUIT_REQUESTED, ());

    // If the webview is wedged the flush event never lands, and the user would be left
    // with a tray icon they cannot get rid of. Exit anyway after a beat.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        handle.exit(0);
    });
}

/// Called by the frontend once every pending write has completed.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, value: bool) -> Result<(), String> {
    window.set_always_on_top(value).map_err(|e| e.to_string())
}

/// Called by the frontend on its close-to-tray path, just before hiding the window.
#[tauri::command]
fn save_window_geometry(app: AppHandle) {
    save_geometry(&app);
}

/// Shown after the frontend has restored state, so the user never sees an unstyled or
/// half-populated window. Paired with `"visible": false` in tauri.conf.json.
#[tauri::command]
fn show_main_window(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Open notes folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit StickyTabs", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &folder, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("default window icon missing".to_string())
        })?)
        .tooltip("StickyTabs")
        .menu(&menu)
        // The menu must not open on left click, or the left-click toggle never fires.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_visibility(app),
            "folder" => {
                let _ = storage::open_notes_folder();
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_visibility(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single instance MUST be the first plugin registered.
    //
    // This app normally lives hidden in the tray, so launching it again from the Start
    // menu is the most obvious way a user tries to get it back. Without this, that second
    // launch is a whole separate process that cannot register the global hotkey, dies on
    // startup, and leaves the user staring at nothing with no way back in short of Task
    // Manager. Here the second launch simply hands the window back and exits.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_and_focus(app);
        }));
    }

    builder = builder
        // Restores window position and size between runs. Registered before the window
        // exists so the saved geometry is applied as the window is created, avoiding a
        // visible jump.
        //
        // Only geometry. The plugin's defaults also restore VISIBLE and ALWAYS_ON_TOP,
        // both of which this app owns: the window is created hidden and revealed by the
        // frontend once it has painted, and always-on-top comes from settings.json. Left
        // at the defaults, a run that ended hidden in the tray would restore hidden and
        // the window would never come back.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        );

    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::ShortcutState;

        // Note the handler is attached here but the shortcut itself is registered in
        // `setup`, where a failure can be swallowed. Registering it through
        // `with_shortcut` aborts app startup if the key is already taken — by another
        // program, or by a copy of this app that is still running — which is precisely
        // how a hidden instance became unreachable.
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, received, event| {
                    // Fire on press only; the release would immediately toggle back.
                    if received == &hotkey() && event.state() == ShortcutState::Pressed {
                        toggle_visibility(app);
                    }
                })
                .build(),
        );
    }

    builder
        .invoke_handler(tauri::generate_handler![
            storage::load_workspace,
            storage::save_note,
            storage::save_tabs,
            storage::save_settings,
            storage::create_note,
            storage::rename_note,
            storage::trash_note,
            storage::open_notes_folder,
            set_always_on_top,
            show_main_window,
            save_window_geometry,
            quit_app,
        ])
        .setup(|app| {
            build_tray(app.handle())?;

            // Best effort. If another program already owns Ctrl+Shift+N the app still
            // starts perfectly well — the tray icon and relaunching both still bring the
            // window back. A missing convenience is not worth a failed launch.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(error) = app.global_shortcut().register(hotkey()) {
                    eprintln!("StickyTabs: could not register Ctrl+Shift+N: {error}");
                }
            }

            // Centre only when there is no saved geometry to restore. `"center": true` in
            // the config would run on every launch and silently beat the window-state
            // plugin, so the window would forget its position every time.
            let has_saved_geometry = app
                .path()
                .app_config_dir()
                // The plugin does not export its filename constant, so it is spelled out.
                .map(|dir| dir.join(".window-state.json").exists())
                .unwrap_or(false);

            // Apply the persisted always-on-top preference before the window is shown, so
            // it never appears at the wrong z-order and then jumps.
            if let Some(window) = main_window(app.handle()) {
                if !has_saved_geometry {
                    let _ = window.center();
                }
                let on_top = std::fs::read_to_string(
                    storage::root_dir()
                        .map(|r| r.join("settings.json"))
                        .unwrap_or_default(),
                )
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| v.get("alwaysOnTop").and_then(serde_json::Value::as_bool))
                // Matches Settings::default(): a sticky note is on top unless told otherwise.
                .unwrap_or(true);
                let _ = window.set_always_on_top(on_top);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running StickyTabs");
}
