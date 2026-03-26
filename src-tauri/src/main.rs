#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::MenuEvent,
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    webview::Color,
};
use voice_overlay_assistant::{hotkey, run_controller, settings};

const OPEN_SETTINGS_EVENT: &str = "overlay://open-settings";
const WINDOWS_RUN_KEY_NAME: &str = "VoiceOverlayAssistant";
const TRAY_OPEN_ID: &str = "tray-open";
const TRAY_SETTINGS_ID: &str = "tray-settings";
const TRAY_QUIT_ID: &str = "tray-quit";
const OVERLAY_LABEL: &str = "overlay";
const OVERLAY_WIDTH: f64 = 312.0;
const OVERLAY_HEIGHT: f64 = 196.0;
const OVERLAY_MARGIN_X: i32 = 8;
const OVERLAY_MARGIN_Y: i32 = 8;

#[tauri::command]
fn app_status() -> &'static str {
    "Voice Overlay Assistant is ready: global hotkeys can capture selected text, then speak it with classic chunked OpenAI TTS, live low-latency streaming, or experimental realtime websocket audio with an optional live fallback, or translate it into the configured target language first."
}

#[tauri::command]
fn show_main_window_command<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    focus_settings: bool,
) -> Result<(), String> {
    show_main_window(&app, focus_settings).map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_main_window_command<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn toggle_main_window_command<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    focus_settings: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().map_err(|error| error.to_string())?;
        if is_visible {
            window.hide().map_err(|error| error.to_string())?;
            return Ok(());
        }
    }

    show_main_window(&app, focus_settings).map_err(|error| error.to_string())
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, focus_settings: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;

        if focus_settings {
            app.emit_to("main", OPEN_SETTINGS_EVENT, ())?;
        }
    }

    Ok(())
}

fn ensure_overlay_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window.set_always_on_top(true)?;
        window.show()?;
        return Ok(());
    }

    let (x, y) = if let Some(monitor) = app.primary_monitor()? {
        let work_area = monitor.work_area();
        let x = work_area.position.x + work_area.size.width as i32 - OVERLAY_WIDTH as i32 - OVERLAY_MARGIN_X;
        let y = work_area.position.y + work_area.size.height as i32 - OVERLAY_HEIGHT as i32 - OVERLAY_MARGIN_Y;
        (x as f64, y as f64)
    } else {
        (0.0, 0.0)
    };

    let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("Voice Overlay")
        .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
        .position(x, y)
        .resizable(false)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(true)
        .build()?;

    overlay.set_always_on_top(true)?;
    overlay.set_shadow(false)?;
    overlay.set_background_color(Some(Color(0, 0, 0, 0)))?;
    Ok(())
}

fn create_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_OPEN_ID, "Open")
        .text(TRAY_SETTINGS_ID, "Settings")
        .separator()
        .text(TRAY_QUIT_ID, "Quit")
        .build()?;

    let mut tray_builder = TrayIconBuilder::with_id("voice-overlay-tray")
        .menu(&menu)
        .tooltip("Voice Overlay Assistant")
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &tauri::AppHandle<R>, event: MenuEvent| match event.id().as_ref() {
            TRAY_OPEN_ID => {
                let _ = show_main_window(app, false);
            }
            TRAY_SETTINGS_ID => {
                let _ = show_main_window(app, true);
            }
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray: &tauri::tray::TrayIcon<R>, event: TrayIconEvent| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_window(tray.app_handle(), false);
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    tray_builder.build(app)?;
    Ok(())
}

fn attach_main_window_behavior<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event({
            let window = window.clone();
            move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
    }
}

fn ensure_windows_autostart() {
    #[cfg(target_os = "windows")]
    {
        if cfg!(debug_assertions) {
            return;
        }

        use winreg::RegKey;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};

        let executable_path = match std::env::current_exe() {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[startup] Failed to resolve current executable path: {error}");
                return;
            }
        };

        let launch_value = format!("\"{}\"", executable_path.display());

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run_key = match hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            KEY_SET_VALUE,
        ) {
            Ok(key) => key,
            Err(error) => {
                eprintln!("[startup] Failed to open Windows autostart registry key: {error}");
                return;
            }
        };

        if let Err(error) = run_key.set_value(WINDOWS_RUN_KEY_NAME, &launch_value) {
            eprintln!("[startup] Failed to register Windows autostart entry: {error}");
        }
    }
}

fn main() {
    let settings_state = settings::SettingsState::load_or_create(settings::default_config_path())
        .expect("failed to initialize persisted settings");

    tauri::Builder::default()
        .manage(hotkey::HotkeyState::default())
        .manage(run_controller::RunController::default())
        .manage(settings_state)
        .setup(|app| {
            hotkey::init_hotkey(&app.handle());
            ensure_windows_autostart();
            attach_main_window_behavior(&app.handle());
            create_tray(&app.handle())?;
            ensure_overlay_window(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            show_main_window_command,
            hide_main_window_command,
            toggle_main_window_command,
            voice_overlay_assistant::execute_voice_command_command,
            hotkey::get_hotkey_status,
            voice_overlay_assistant::capture_selected_text_command,
            voice_overlay_assistant::speak_text_command,
            voice_overlay_assistant::translate_text_command,
            voice_overlay_assistant::capture_and_speak_command,
            voice_overlay_assistant::capture_and_translate_command,
            voice_overlay_assistant::get_settings,
            voice_overlay_assistant::update_settings,
            voice_overlay_assistant::reset_settings,
            voice_overlay_assistant::get_language_options,
            voice_overlay_assistant::pause_resume_current_run,
            voice_overlay_assistant::cancel_current_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
