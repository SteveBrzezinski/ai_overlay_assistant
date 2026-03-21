#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use voice_overlay_assistant::{hotkey, run_controller, settings};

#[tauri::command]
fn app_status() -> &'static str {
    "Voice Overlay Assistant MVP is ready: global hotkeys can capture selected text, then either speak it with chunked OpenAI TTS or translate it into the configured target language."
}

fn main() {
    tauri::Builder::default()
        .manage(hotkey::HotkeyState::default())
        .manage(run_controller::RunController::default())
        .manage(settings::SettingsState::default())
        .setup(|app| {
            hotkey::init_hotkey(&app.handle());
            Ok(())
        })
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
            voice_overlay_assistant::get_language_options,
            voice_overlay_assistant::pause_resume_current_run,
            voice_overlay_assistant::cancel_current_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
