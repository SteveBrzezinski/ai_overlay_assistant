#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use voice_overlay_assistant::{
    app_icon, background, hotkey, run_controller, settings, voice_tasks,
};

#[tauri::command]
fn app_status() -> &'static str {
    "Voice Overlay Assistant is ready: the tray keeps the app alive in the background, WebView2 handles wake-word listening, read/translate uses live TTS, and the voice assistant uses OpenAI Realtime over WebRTC."
}

fn main() {
    let settings_state = settings::SettingsState::load_or_create(settings::default_config_path())
        .expect("failed to initialize persisted settings");

    tauri::Builder::default()
        .manage(background::AppLifecycleState::default())
        .manage(background::AssistantState::default())
        .manage(hotkey::HotkeyState::default())
        .manage(run_controller::RunController::default())
        .manage(settings_state)
        .manage(voice_tasks::VoiceTaskState::default())
        .setup(|app| {
            app_icon::apply_main_window_icon(app.handle())
                .expect("failed to apply the AIVA window icon");
            background::setup_background(app.handle())
                .expect("failed to initialize background tray support");
            hotkey::init_hotkey(app.handle());
            let settings = app.state::<settings::SettingsState>().get();
            background::apply_launch_behavior(app.handle(), &settings);
            Ok(())
        })
        .on_window_event(background::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            app_status,
            hotkey::get_hotkey_status,
            background::get_main_window_visibility_command,
            background::toggle_main_window_command,
            background::get_chat_window_visibility_command,
            background::toggle_chat_window_command,
            background::get_assistant_state_command,
            background::set_assistant_state_command,
            background::request_assistant_control_command,
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
            voice_overlay_assistant::transcribe_chat_audio_command,
            voice_overlay_assistant::pause_resume_current_run,
            voice_overlay_assistant::cancel_current_run,
            voice_overlay_assistant::create_voice_agent_session_command,
            voice_overlay_assistant::run_voice_agent_tool_command,
            voice_overlay_assistant::get_voice_agent_task_command,
            voice_overlay_assistant::store_voice_session_memory_command,
            voice_overlay_assistant::recall_voice_memory_command,
            voice_overlay_assistant::get_recent_voice_memory_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
