#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use voice_overlay_assistant::{background, hotkey, run_controller, settings};

#[tauri::command]
fn app_status() -> &'static str {
    "Voice Overlay Assistant is ready: global hotkeys keep running in the background, the tray can reopen the UI, and the settings can manage Windows autostart for hidden startup."
}

fn main() {
    let settings_state = settings::SettingsState::load_or_create(settings::default_config_path())
        .expect("failed to initialize persisted settings");

    tauri::Builder::default()
        .manage(background::AppLifecycleState::default())
        .manage(hotkey::HotkeyState::default())
        .manage(run_controller::RunController::default())
        .manage(settings_state)
        .setup(|app| {
            background::setup_background(&app.handle())
                .expect("failed to initialize background tray support");
            hotkey::init_hotkey(&app.handle());
            let settings = app.state::<settings::SettingsState>().get();
            background::apply_launch_behavior(&app.handle(), &settings);
            Ok(())
        })
        .on_window_event(background::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            app_status,
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
            voice_overlay_assistant::append_stt_debug_log_command,
            voice_overlay_assistant::pause_resume_current_run,
            voice_overlay_assistant::cancel_current_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
