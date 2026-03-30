use crate::settings::AppSettings;
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::MenuEvent,
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime, Window, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ICON_ID: &str = "voice-overlay-assistant-tray";
const TRAY_OPEN_MENU_ID: &str = "tray-open-main-window";
const TRAY_QUIT_MENU_ID: &str = "tray-quit-app";
const STARTUP_SCRIPT_NAME: &str = "Voice Overlay Assistant.vbs";

#[derive(Default)]
pub struct AppLifecycleState {
    allow_exit: AtomicBool,
}

impl AppLifecycleState {
    pub fn allow_exit(&self) {
        self.allow_exit.store(true, Ordering::SeqCst);
    }

    fn exits_allowed(&self) -> bool {
        self.allow_exit.load(Ordering::SeqCst)
    }
}

pub fn setup_background<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "Default application icon is missing, so the tray icon cannot be created.".to_string())?;

    let menu = MenuBuilder::new(app)
        .text(TRAY_OPEN_MENU_ID, "Open Voice Overlay Assistant")
        .separator()
        .text(TRAY_QUIT_MENU_ID, "Quit")
        .build()
        .map_err(|error| format!("Failed to build tray menu: {error}"))?;

    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .tooltip("Voice Overlay Assistant")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &AppHandle<R>, event: MenuEvent| match event.id().as_ref() {
            TRAY_OPEN_MENU_ID => show_main_window(app),
            TRAY_QUIT_MENU_ID => request_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray: &TrayIcon<R>, event: TrayIconEvent| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        })
        .build(app)
        .map_err(|error| format!("Failed to create tray icon: {error}"))?;

    Ok(())
}

pub fn apply_launch_behavior<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) {
    if should_start_hidden(settings) {
        hide_main_window(app);
    }
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        let lifecycle = window.state::<AppLifecycleState>();
        if lifecycle.exits_allowed() {
            return;
        }

        api.prevent_close();
        let _ = window.hide();
    }
}

pub fn sync_startup_entry(settings: &AppSettings) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::sync_startup_entry(settings)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = settings;
        Ok(())
    }
}

fn should_start_hidden(settings: &AppSettings) -> bool {
    settings.start_hidden_on_launch && launched_via_autostart()
}

fn launched_via_autostart() -> bool {
    env::args().any(|arg| matches!(arg.as_str(), "--autostart" | "--background" | "--hidden"))
}

fn request_exit<R: Runtime>(app: &AppHandle<R>) {
    app.state::<AppLifecycleState>().allow_exit();
    app.exit(0);
}

fn show_main_window<R: Runtime, M: Manager<R>>(manager: &M) {
    let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }

    let _ = window.show();
    let _ = window.set_focus();
}

fn hide_main_window<R: Runtime, M: Manager<R>>(manager: &M) {
    if let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;

    const WINDOWS_STARTUP_FOLDER: &str = "Microsoft\\Windows\\Start Menu\\Programs\\Startup";

    pub fn sync_startup_entry(settings: &AppSettings) -> Result<(), String> {
        let startup_script_path = startup_script_path()?;

        if settings.launch_at_login {
            let executable_path = current_executable_path()?;
            let payload = build_startup_script(&executable_path);

            if let Some(parent) = startup_script_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "Failed to create Windows Startup folder '{}': {error}",
                        parent.display()
                    )
                })?;
            }

            fs::write(&startup_script_path, payload).map_err(|error| {
                format!(
                    "Failed to write autostart file '{}': {error}",
                    startup_script_path.display()
                )
            })?;
        } else if startup_script_path.exists() {
            fs::remove_file(&startup_script_path).map_err(|error| {
                format!(
                    "Failed to remove autostart file '{}': {error}",
                    startup_script_path.display()
                )
            })?;
        }

        Ok(())
    }

    fn startup_script_path() -> Result<PathBuf, String> {
        let app_data = env::var_os("APPDATA")
            .ok_or_else(|| "APPDATA is missing, so the Windows Startup folder cannot be resolved.".to_string())?;

        Ok(PathBuf::from(app_data)
            .join(WINDOWS_STARTUP_FOLDER)
            .join(STARTUP_SCRIPT_NAME))
    }

    fn current_executable_path() -> Result<PathBuf, String> {
        env::current_exe()
            .map_err(|error| format!("Failed to resolve the current executable for autostart: {error}"))
    }

    fn build_startup_script(executable_path: &Path) -> String {
        let executable = executable_path.display();
        format!(
            "' Generated by Voice Overlay Assistant.\r\nDim shell\r\nSet shell = CreateObject(\"WScript.Shell\")\r\nshell.Run \"\"\"{executable}\"\" --autostart\", 0, False\r\nSet shell = Nothing\r\n"
        )
    }
}
