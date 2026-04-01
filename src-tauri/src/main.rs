#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use voice_overlay_assistant::{hotkey, run_controller, settings, voice_tasks};

#[tauri::command]
fn app_status() -> &'static str {
    "Voice Overlay Assistant is ready: WebView2 handles wake-word listening, read/translate uses live TTS, and the voice assistant uses OpenAI Realtime over WebRTC."
}

fn main() {
    let settings_state = settings::SettingsState::load_or_create(settings::default_config_path())
        .expect("failed to initialize persisted settings");

    tauri::Builder::default()
        .manage(hotkey::HotkeyState::default())
        .manage(run_controller::RunController::default())
        .manage(settings_state)
        .manage(voice_tasks::VoiceTaskState::default())
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
            voice_overlay_assistant::reset_settings,
            voice_overlay_assistant::get_language_options,
            voice_overlay_assistant::append_stt_debug_log_command,
            voice_overlay_assistant::pause_resume_current_run,
            voice_overlay_assistant::cancel_current_run,
            voice_overlay_assistant::create_voice_agent_session_command,
            voice_overlay_assistant::run_voice_agent_tool_command,
            voice_overlay_assistant::get_voice_agent_task_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
