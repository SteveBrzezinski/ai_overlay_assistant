use crate::{app_icon, settings::AppSettings};
use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::MenuBuilder,
    menu::MenuEvent,
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
pub const ACTION_BAR_WINDOW_LABEL: &str = "action-bar";
pub const VOICE_OVERLAY_WINDOW_LABEL: &str = "voice-overlay";
pub const OVERLAY_COMPOSER_WINDOW_LABEL: &str = "overlay-composer";
const CHAT_WINDOW_LABEL: &str = "chat-overlay";
const TRAY_ICON_ID: &str = "voice-overlay-assistant-tray";
const TRAY_OPEN_MENU_ID: &str = "tray-open-main-window";
const TRAY_QUIT_MENU_ID: &str = "tray-quit-app";
const STARTUP_SCRIPT_NAME: &str = "Voice Overlay Assistant.vbs";
const MAIN_WINDOW_VISIBILITY_EVENT: &str = "main-window-visibility-changed";
const CHAT_WINDOW_VISIBILITY_EVENT: &str = "chat-window-visibility-changed";
const ASSISTANT_STATE_EVENT: &str = "assistant-state-changed";
const ASSISTANT_CONTROL_EVENT: &str = "assistant-control-request";
const CHAT_WINDOW_WIDTH: f64 = 860.0;
const CHAT_WINDOW_HEIGHT: f64 = 620.0;
const CHAT_WINDOW_BOTTOM_MARGIN: f64 = 18.0;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainWindowVisibilityPayload {
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWindowVisibilityPayload {
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStatePayload {
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantControlPayload {
    pub action: String,
    pub source: String,
}

#[derive(Default)]
pub struct AppLifecycleState {
    allow_exit: AtomicBool,
}

#[derive(Default)]
pub struct AssistantState {
    active: AtomicBool,
}

impl AppLifecycleState {
    pub fn allow_exit(&self) {
        self.allow_exit.store(true, Ordering::SeqCst);
    }

    fn exits_allowed(&self) -> bool {
        self.allow_exit.load(Ordering::SeqCst)
    }
}

impl AssistantState {
    fn get(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    fn set(&self, active: bool) {
        self.active.store(active, Ordering::SeqCst);
    }
}

pub fn setup_background<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let icon = match app_icon::load_aiva_icon() {
        Ok(icon) => icon,
        Err(custom_icon_error) => app
            .default_window_icon()
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Failed to load the AIVA tray icon ({custom_icon_error}) and the default application icon is missing."
                )
            })?,
    };

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
            TRAY_OPEN_MENU_ID => {
                let _ = show_main_window(app);
            }
            TRAY_QUIT_MENU_ID => request_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray: &TrayIcon<R>, event: TrayIconEvent| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                let _ = show_main_window(tray.app_handle());
            }
            _ => {}
        })
        .build(app)
        .map_err(|error| format!("Failed to create tray icon: {error}"))?;

    ensure_chat_overlay_window(app)?;

    Ok(())
}

pub fn setup_overlay_windows<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    ensure_overlay_window(app, ACTION_BAR_WINDOW_LABEL, "Action Bar Overlay", 22.0, 84.0, true)?;
    ensure_overlay_window(
        app,
        VOICE_OVERLAY_WINDOW_LABEL,
        "Voice Overlay Orb",
        224.0,
        224.0,
        true,
    )?;
    ensure_overlay_window(
        app,
        OVERLAY_COMPOSER_WINDOW_LABEL,
        "Overlay Composer",
        320.0,
        208.0,
        false,
    )?;
    Ok(())
}

fn ensure_overlay_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    title: &str,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(width, height)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .visible(visible)
        .build()
        .map_err(|error| format!("Failed to create overlay window '{label}': {error}"))?;

    if visible {
        let _ = window.show();
    }

    Ok(())
}

pub fn apply_launch_behavior<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) {
    if should_start_hidden(settings) {
        let _ = hide_main_window(app);
    } else {
        let _ = show_main_window_on_launch(app);
    }
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL && window.label() != CHAT_WINDOW_LABEL {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        let lifecycle = window.state::<AppLifecycleState>();
        if lifecycle.exits_allowed() {
            return;
        }

        api.prevent_close();
        if window.label() == MAIN_WINDOW_LABEL {
            let _ = window.hide();
            emit_main_window_visibility(window.app_handle(), false);
        } else {
            let _ = window.hide();
            emit_chat_window_visibility(window.app_handle(), false);
        }
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

fn emit_main_window_visibility<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let payload = MainWindowVisibilityPayload { visible };
    let _ = app.emit_to(ACTION_BAR_WINDOW_LABEL, MAIN_WINDOW_VISIBILITY_EVENT, payload);
    let _ = app.emit_to(CHAT_WINDOW_LABEL, MAIN_WINDOW_VISIBILITY_EVENT, payload);
}

fn emit_chat_window_visibility<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let payload = ChatWindowVisibilityPayload { visible };
    let _ = app.emit_to(ACTION_BAR_WINDOW_LABEL, CHAT_WINDOW_VISIBILITY_EVENT, payload);
    let _ = app.emit_to(CHAT_WINDOW_LABEL, CHAT_WINDOW_VISIBILITY_EVENT, payload);
}

fn emit_assistant_state<R: Runtime>(app: &AppHandle<R>, active: bool) {
    let _ = app.emit(ASSISTANT_STATE_EVENT, AssistantStatePayload { active });
}

fn ensure_chat_overlay_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app.get_webview_window(CHAT_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let (x, y) = resolve_chat_window_position(app)?;

    WebviewWindowBuilder::new(app, CHAT_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("Voice Overlay Assistant Chat")
        .inner_size(CHAT_WINDOW_WIDTH, CHAT_WINDOW_HEIGHT)
        .position(x, y)
        .resizable(false)
        .focused(false)
        .visible(false)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .build()
        .map_err(|error| format!("Failed to create chat overlay window: {error}"))?;

    Ok(())
}

fn resolve_chat_window_position<R: Runtime>(app: &AppHandle<R>) -> Result<(f64, f64), String> {
    let monitor = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "Failed to resolve a monitor for the chat overlay window.".to_string())?;

    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor().max(1.0);
    let x = work_area.position.x as f64 / scale_factor
        + (work_area.size.width as f64 / scale_factor - CHAT_WINDOW_WIDTH) / 2.0;
    let y = ((work_area.position.y as f64 + work_area.size.height as f64) / scale_factor)
        - CHAT_WINDOW_HEIGHT
        - CHAT_WINDOW_BOTTOM_MARGIN;

    Ok((x.max(0.0), y.max(0.0)))
}

fn get_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::WebviewWindow<R>, String> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window is unavailable.".to_string())
}

fn get_chat_window<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::WebviewWindow<R>, String> {
    app.get_webview_window(CHAT_WINDOW_LABEL)
        .ok_or_else(|| "Chat overlay window is unavailable.".to_string())
}

fn main_window_is_visible<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let window = get_main_window(app)?;
    let is_visible = window
        .is_visible()
        .map_err(|error| format!("Failed to check main window visibility: {error}"))?;
    let is_minimized = window
        .is_minimized()
        .map_err(|error| format!("Failed to check main window minimized state: {error}"))?;

    Ok(is_visible && !is_minimized)
}

fn chat_window_is_visible<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let window = get_chat_window(app)?;
    let is_visible = window
        .is_visible()
        .map_err(|error| format!("Failed to check chat window visibility: {error}"))?;
    let is_minimized = window
        .is_minimized()
        .map_err(|error| format!("Failed to check chat window minimized state: {error}"))?;

    Ok(is_visible && !is_minimized)
}

fn show_main_window<R: Runtime, M: Manager<R>>(manager: &M) -> Result<bool, String> {
    let window = manager
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window is unavailable.".to_string())?;

    if window
        .is_minimized()
        .map_err(|error| format!("Failed to check main window minimized state: {error}"))?
    {
        window
            .unminimize()
            .map_err(|error| format!("Failed to restore the main window: {error}"))?;
    }

    window.show().map_err(|error| format!("Failed to show the main window: {error}"))?;
    window.set_focus().map_err(|error| format!("Failed to focus the main window: {error}"))?;

    let app = manager.app_handle();
    emit_main_window_visibility(app, true);
    Ok(true)
}

fn show_main_window_on_launch<R: Runtime, M: Manager<R>>(manager: &M) -> Result<bool, String> {
    let window = manager
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window is unavailable.".to_string())?;

    if window
        .is_minimized()
        .map_err(|error| format!("Failed to check main window minimized state: {error}"))?
    {
        window
            .unminimize()
            .map_err(|error| format!("Failed to restore the main window: {error}"))?;
    }

    window
        .set_focusable(false)
        .map_err(|error| format!("Failed to disable main window focus during launch: {error}"))?;
    let show_result = window
        .show()
        .map_err(|error| format!("Failed to show the main window during launch: {error}"));
    let restore_focusable_result = window.set_focusable(true).map_err(|error| {
        format!("Failed to restore main window focusability after launch: {error}")
    });

    show_result?;
    restore_focusable_result?;

    let app = manager.app_handle();
    emit_main_window_visibility(app, true);
    Ok(true)
}

fn show_chat_window<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let window = get_chat_window(app)?;

    if window
        .is_minimized()
        .map_err(|error| format!("Failed to check chat window minimized state: {error}"))?
    {
        window
            .unminimize()
            .map_err(|error| format!("Failed to restore the chat window: {error}"))?;
    }

    window.show().map_err(|error| format!("Failed to show the chat window: {error}"))?;
    window.set_focus().map_err(|error| format!("Failed to focus the chat window: {error}"))?;

    emit_chat_window_visibility(app, true);
    Ok(true)
}

fn hide_main_window<R: Runtime, M: Manager<R>>(manager: &M) -> Result<bool, String> {
    let window = manager
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window is unavailable.".to_string())?;

    window.hide().map_err(|error| format!("Failed to hide the main window: {error}"))?;

    let app = manager.app_handle();
    emit_main_window_visibility(app, false);
    Ok(false)
}

fn hide_chat_window<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let window = get_chat_window(app)?;

    window.hide().map_err(|error| format!("Failed to hide the chat window: {error}"))?;

    emit_chat_window_visibility(app, false);
    Ok(false)
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    if main_window_is_visible(app)? {
        hide_main_window(app)
    } else {
        show_main_window(app)
    }
}

fn toggle_chat_window<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    if chat_window_is_visible(app)? {
        hide_chat_window(app)
    } else {
        show_chat_window(app)
    }
}

#[tauri::command]
pub fn get_main_window_visibility_command(
    app: tauri::AppHandle,
) -> Result<MainWindowVisibilityPayload, String> {
    Ok(MainWindowVisibilityPayload { visible: main_window_is_visible(&app)? })
}

#[tauri::command]
pub fn toggle_main_window_command(
    app: tauri::AppHandle,
) -> Result<MainWindowVisibilityPayload, String> {
    Ok(MainWindowVisibilityPayload { visible: toggle_main_window(&app)? })
}

#[tauri::command]
pub fn get_chat_window_visibility_command(
    app: tauri::AppHandle,
) -> Result<ChatWindowVisibilityPayload, String> {
    Ok(ChatWindowVisibilityPayload { visible: chat_window_is_visible(&app)? })
}

#[tauri::command]
pub fn toggle_chat_window_command(
    app: tauri::AppHandle,
) -> Result<ChatWindowVisibilityPayload, String> {
    Ok(ChatWindowVisibilityPayload { visible: toggle_chat_window(&app)? })
}

#[tauri::command]
pub fn get_assistant_state_command(
    state: tauri::State<'_, AssistantState>,
) -> AssistantStatePayload {
    AssistantStatePayload { active: state.get() }
}

#[tauri::command]
pub fn set_assistant_state_command(
    active: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AssistantState>,
) -> AssistantStatePayload {
    state.set(active);
    emit_assistant_state(&app, active);
    AssistantStatePayload { active }
}

#[tauri::command]
pub fn request_assistant_control_command(
    action: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if action != "activate" && action != "deactivate" {
        return Err(format!("Unsupported assistant action '{action}'."));
    }

    app.emit_to(
        MAIN_WINDOW_LABEL,
        ASSISTANT_CONTROL_EVENT,
        AssistantControlPayload { action, source: "manual".to_string() },
    )
    .map_err(|error| format!("Failed to emit assistant control request: {error}"))
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
        let app_data = env::var_os("APPDATA").ok_or_else(|| {
            "APPDATA is missing, so the Windows Startup folder cannot be resolved.".to_string()
        })?;

        Ok(PathBuf::from(app_data).join(WINDOWS_STARTUP_FOLDER).join(STARTUP_SCRIPT_NAME))
    }

    fn current_executable_path() -> Result<PathBuf, String> {
        env::current_exe().map_err(|error| {
            format!("Failed to resolve the current executable for autostart: {error}")
        })
    }

    fn build_startup_script(executable_path: &Path) -> String {
        let executable = executable_path.display();
        format!(
            "' Generated by Voice Overlay Assistant.\r\nDim shell\r\nSet shell = CreateObject(\"WScript.Shell\")\r\nshell.Run \"\"\"{executable}\"\" --autostart\", 0, False\r\nSet shell = Nothing\r\n"
        )
    }
}
