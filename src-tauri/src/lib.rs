pub mod app_icon;
pub mod audio_output;
pub mod background;
pub mod clipboard;
pub mod context_bucket;
pub mod dictation;
pub mod hosted_backend;
pub mod hotkey;
pub mod realtime_voice;
pub mod run_controller;
pub mod selection_capture;
pub mod settings;
pub mod stt;
pub mod text_actions;
pub mod timer_audio;
pub mod translation;
pub mod tts;
pub mod voice_agent;
pub mod voice_memory;
pub mod voice_profile;
pub mod voice_tasks;
pub mod voice_timers;
pub mod voice_tools;

mod commands {
    use super::audio_output::AudioOutputActivityGuard;
    use super::run_controller::{CancelResult, PauseResumeResult, RunController};
    use super::selection_capture::{capture_selected_text, CaptureOptions, CaptureResult};
    use super::settings::{
        AppSettings, LanguageOption, SettingsState, LANGUAGE_OPTIONS, SETTINGS_EVENT,
    };
    use super::stt::{
        append_stt_debug_log, transcribe_chat_audio, AppendSttDebugLogOptions,
        AppendSttDebugLogResult, TranscribeChatAudioRequest, TranscribeChatAudioResult,
    };
    use super::translation::{translate_text, TranslateTextOptions, TranslateTextResult};
    use super::tts::{
        speak_text, speak_text_with_progress_and_control, SpeakTextOptions, SpeakTextResult,
    };
    use serde::Serialize;
    use tauri::{AppHandle, Emitter, State};

    #[tauri::command]
    pub fn pause_resume_current_run(
        controller: State<'_, RunController>,
    ) -> Result<String, String> {
        Ok(match controller.pause_resume() {
            PauseResumeResult::NoActiveRun => {
                return Err("No active run can be paused or resumed.".to_string())
            }
            PauseResumeResult::CancelPending(snapshot) => format!(
                "Cancel already requested for current {} run during phase '{}'.",
                snapshot.action, snapshot.phase
            ),
            PauseResumeResult::Paused(snapshot) => {
                format!("Paused current {} run during phase '{}'.", snapshot.action, snapshot.phase)
            }
            PauseResumeResult::Resumed(snapshot) => format!(
                "Resumed current {} run during phase '{}'.",
                snapshot.action, snapshot.phase
            ),
        })
    }

    #[tauri::command]
    pub fn cancel_current_run(controller: State<'_, RunController>) -> Result<String, String> {
        Ok(match controller.cancel() {
            CancelResult::NoActiveRun => return Err("No active run to cancel.".to_string()),
            CancelResult::CancelRequested(snapshot) => format!(
                "Cancelling current {} run during phase '{}'.",
                snapshot.action, snapshot.phase
            ),
            CancelResult::AlreadyRequested(snapshot) => format!(
                "Cancel was already requested for current {} run during phase '{}'.",
                snapshot.action, snapshot.phase
            ),
        })
    }

    #[tauri::command]
    pub fn capture_selected_text_command(
        options: Option<CaptureOptions>,
    ) -> Result<CaptureResult, String> {
        capture_selected_text(options)
    }

    #[tauri::command]
    pub fn speak_text_command(
        options: SpeakTextOptions,
        settings: State<'_, SettingsState>,
        app: AppHandle,
    ) -> Result<SpeakTextResult, String> {
        let _audio_output_guard = if options.autoplay.unwrap_or(true) {
            Some(AudioOutputActivityGuard::activate(&app, "local-tts-command"))
        } else {
            None
        };
        speak_text(options, &settings.get())
    }

    #[tauri::command]
    pub fn translate_text_command(
        options: TranslateTextOptions,
        settings: State<'_, SettingsState>,
    ) -> Result<TranslateTextResult, String> {
        translate_text(options, &settings.get())
    }

    #[tauri::command]
    pub fn get_settings(settings: State<'_, SettingsState>) -> AppSettings {
        settings.get()
    }

    #[tauri::command]
    pub fn update_settings(
        next: AppSettings,
        settings: State<'_, SettingsState>,
        app: AppHandle,
    ) -> Result<AppSettings, String> {
        let saved = settings.update(next)?;
        let _ = app.emit(SETTINGS_EVENT, &saved);
        Ok(saved)
    }

    #[tauri::command]
    pub fn reset_settings(
        settings: State<'_, SettingsState>,
        app: AppHandle,
    ) -> Result<AppSettings, String> {
        let saved = settings.reset()?;
        let _ = app.emit(SETTINGS_EVENT, &saved);
        Ok(saved)
    }

    #[tauri::command]
    pub fn get_language_options() -> Vec<LanguageOption> {
        LANGUAGE_OPTIONS.to_vec()
    }

    #[tauri::command]
    pub fn append_stt_debug_log_command(
        options: AppendSttDebugLogOptions,
    ) -> Result<AppendSttDebugLogResult, String> {
        append_stt_debug_log(options)
    }

    #[tauri::command]
    pub fn transcribe_chat_audio_command(
        request: TranscribeChatAudioRequest,
        settings: State<'_, SettingsState>,
    ) -> Result<TranscribeChatAudioResult, String> {
        transcribe_chat_audio(request, &settings.get())
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CaptureAndSpeakResult {
        pub captured_text: String,
        pub restored_clipboard: bool,
        pub note: Option<String>,
        pub speech: SpeakTextResult,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CaptureAndTranslateResult {
        pub captured_text: String,
        pub restored_clipboard: bool,
        pub note: Option<String>,
        pub translation: TranslateTextResult,
        pub speech: SpeakTextResult,
    }

    #[tauri::command]
    pub fn capture_and_speak_command(
        capture_options: Option<CaptureOptions>,
        speak_options: Option<SpeakTextOptions>,
        settings: State<'_, SettingsState>,
        app: AppHandle,
    ) -> Result<CaptureAndSpeakResult, String> {
        let capture = capture_selected_text(capture_options)?;
        if capture.text.trim().is_empty() {
            return Err(capture
                .note
                .unwrap_or_else(|| "No marked text could be captured.".to_string()));
        }
        let app_settings = settings.get();
        let base_speak = speak_options.unwrap_or(SpeakTextOptions {
            text: None,
            voice: None,
            model: None,
            format: None,
            mode: None,
            autoplay: Some(true),
            max_chunk_chars: None,
            max_parallel_requests: None,
            first_chunk_leading_silence_ms: None,
        });
        let speech = speak_text_with_progress_and_control(
            SpeakTextOptions {
                text: Some(capture.text.clone()),
                voice: base_speak.voice,
                model: base_speak.model,
                format: Some("wav".to_string()),
                mode: Some("live".to_string()),
                autoplay: base_speak.autoplay,
                max_chunk_chars: base_speak.max_chunk_chars,
                max_parallel_requests: base_speak.max_parallel_requests,
                first_chunk_leading_silence_ms: Some(0),
            },
            &app_settings,
            None,
            None,
            Some(&app),
        )?;
        Ok(CaptureAndSpeakResult {
            captured_text: capture.text,
            restored_clipboard: capture.restored_clipboard,
            note: capture.note,
            speech,
        })
    }

    #[tauri::command]
    pub fn capture_and_translate_command(
        capture_options: Option<CaptureOptions>,
        translate_options: Option<TranslateTextOptions>,
        settings: State<'_, SettingsState>,
        app: AppHandle,
    ) -> Result<CaptureAndTranslateResult, String> {
        let capture = capture_selected_text(capture_options)?;
        if capture.text.trim().is_empty() {
            return Err(capture
                .note
                .unwrap_or_else(|| "No marked text could be captured.".to_string()));
        }
        let app_settings = settings.get();
        let base = translate_options.unwrap_or(TranslateTextOptions {
            text: None,
            target_language: Some(app_settings.translation_target_language.clone()),
            source_language: None,
            model: None,
        });
        let translation = translate_text(
            TranslateTextOptions {
                text: Some(capture.text.clone()),
                target_language: base
                    .target_language
                    .or(Some(app_settings.translation_target_language.clone())),
                source_language: base.source_language,
                model: base.model,
            },
            &app_settings,
        )?;
        let speech = speak_text_with_progress_and_control(
            SpeakTextOptions {
                text: Some(translation.text.clone()),
                voice: None,
                model: None,
                format: Some("wav".to_string()),
                mode: Some("live".to_string()),
                autoplay: Some(true),
                max_chunk_chars: None,
                max_parallel_requests: Some(3),
                first_chunk_leading_silence_ms: Some(0),
            },
            &app_settings,
            None,
            None,
            Some(&app),
        )?;
        Ok(CaptureAndTranslateResult {
            captured_text: capture.text,
            restored_clipboard: capture.restored_clipboard,
            note: capture.note,
            translation,
            speech,
        })
    }
}

pub use commands::{
    append_stt_debug_log_command, cancel_current_run, capture_and_speak_command,
    capture_and_translate_command, capture_selected_text_command, get_language_options,
    get_settings, pause_resume_current_run, reset_settings, speak_text_command,
    transcribe_chat_audio_command, translate_text_command, update_settings,
};
pub use context_bucket::{
    capture_context_bucket_item_command, clear_context_bucket_command,
    get_context_bucket_status_command, take_context_bucket_items_command,
};
pub use dictation::{
    insert_dictation_text_command, report_dictation_error_command,
    report_dictation_transcribing_command,
};
pub use hosted_backend::{
    create_hosted_checkout_session_command, get_hosted_account_status_command,
    get_hosted_billing_plans_command, login_hosted_account_command, logout_hosted_account_command,
    open_external_url_command,
};
pub use text_actions::{compact_selected_text_command, translate_selected_text_replace_command};
pub use timer_audio::{start_timer_signal_alert_command, stop_timer_signal_alert_command};
pub use voice_agent::{create_voice_agent_session_command, run_voice_agent_tool_command};
pub use voice_memory::{
    get_recent_voice_memory_command, recall_voice_memory_command,
    store_voice_session_memory_command,
};
pub use voice_tasks::get_voice_agent_task_command;
pub use voice_timers::{
    create_voice_timer_command, delete_voice_timer_command, list_voice_timers_command,
    pause_voice_timer_command, resume_voice_timer_command, update_voice_timer_command,
};
