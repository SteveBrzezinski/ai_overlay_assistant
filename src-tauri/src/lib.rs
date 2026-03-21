pub mod hotkey;
pub mod run_controller;
pub mod selection_capture;
pub mod settings;
pub mod translation;
pub mod tts;

mod commands {
    use super::run_controller::{CancelResult, PauseResumeResult, RunController};
    use super::selection_capture::{capture_selected_text, CaptureOptions, CaptureResult};
    use super::settings::{AppSettings, LanguageOption, SettingsState, LANGUAGE_OPTIONS};
    use super::translation::{translate_text, TranslateTextOptions, TranslateTextResult};
    use super::tts::{speak_text, SpeakTextOptions, SpeakTextResult};
    use serde::Serialize;
    use tauri::State;

    #[tauri::command]
    pub fn pause_resume_current_run(controller: State<'_, RunController>) -> Result<String, String> {
        Ok(match controller.pause_resume() {
            PauseResumeResult::NoActiveRun => return Err("No active run can be paused or resumed.".to_string()),
            PauseResumeResult::CancelPending(snapshot) => format!("Cancel already requested for current {} run during phase '{}'.", snapshot.action, snapshot.phase),
            PauseResumeResult::Paused(snapshot) => format!("Paused current {} run during phase '{}'.", snapshot.action, snapshot.phase),
            PauseResumeResult::Resumed(snapshot) => format!("Resumed current {} run during phase '{}'.", snapshot.action, snapshot.phase),
        })
    }

    #[tauri::command]
    pub fn cancel_current_run(controller: State<'_, RunController>) -> Result<String, String> {
        Ok(match controller.cancel() {
            CancelResult::NoActiveRun => return Err("No active run to cancel.".to_string()),
            CancelResult::CancelRequested(snapshot) => format!("Cancelling current {} run during phase '{}'.", snapshot.action, snapshot.phase),
            CancelResult::AlreadyRequested(snapshot) => format!("Cancel was already requested for current {} run during phase '{}'.", snapshot.action, snapshot.phase),
        })
    }

    #[tauri::command]
    pub fn capture_selected_text_command(options: Option<CaptureOptions>) -> Result<CaptureResult, String> {
        capture_selected_text(options)
    }

    #[tauri::command]
    pub fn speak_text_command(options: SpeakTextOptions, settings: State<'_, SettingsState>) -> Result<SpeakTextResult, String> {
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
    pub fn get_settings(settings: State<'_, SettingsState>) -> AppSettings { settings.get() }

    #[tauri::command]
    pub fn update_settings(next: AppSettings, settings: State<'_, SettingsState>) -> Result<AppSettings, String> {
        settings.update(next)
    }

    #[tauri::command]
    pub fn reset_settings(settings: State<'_, SettingsState>) -> Result<AppSettings, String> { settings.reset() }

    #[tauri::command]
    pub fn get_language_options() -> Vec<LanguageOption> { LANGUAGE_OPTIONS.to_vec() }

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
    ) -> Result<CaptureAndSpeakResult, String> {
        let capture = capture_selected_text(capture_options)?;
        if capture.text.trim().is_empty() {
            return Err(capture.note.unwrap_or_else(|| "No marked text could be captured.".to_string()));
        }
        let base_speak = speak_options.unwrap_or(SpeakTextOptions {
            text: None,
            voice: None,
            model: None,
            format: None,
            autoplay: Some(true),
            max_chunk_chars: None,
            max_parallel_requests: None,
            first_chunk_leading_silence_ms: None,
        });
        let speech = speak_text(
            SpeakTextOptions {
                text: Some(capture.text.clone()),
                voice: base_speak.voice,
                model: base_speak.model,
                format: base_speak.format,
                autoplay: base_speak.autoplay,
                max_chunk_chars: base_speak.max_chunk_chars,
                max_parallel_requests: base_speak.max_parallel_requests,
                first_chunk_leading_silence_ms: base_speak.first_chunk_leading_silence_ms,
            },
            &settings.get(),
        )?;
        Ok(CaptureAndSpeakResult { captured_text: capture.text, restored_clipboard: capture.restored_clipboard, note: capture.note, speech })
    }

    #[tauri::command]
    pub fn capture_and_translate_command(
        capture_options: Option<CaptureOptions>,
        translate_options: Option<TranslateTextOptions>,
        settings: State<'_, SettingsState>,
    ) -> Result<CaptureAndTranslateResult, String> {
        let capture = capture_selected_text(capture_options)?;
        if capture.text.trim().is_empty() {
            return Err(capture.note.unwrap_or_else(|| "No marked text could be captured.".to_string()));
        }
        let app_settings = settings.get();
        let base = translate_options.unwrap_or(TranslateTextOptions {
            text: None,
            target_language: Some(app_settings.translation_target_language.clone()),
            source_language: None,
            model: None,
        });
        let translation = translate_text(TranslateTextOptions {
            text: Some(capture.text.clone()),
            target_language: base.target_language.or(Some(app_settings.translation_target_language.clone())),
            source_language: base.source_language,
            model: base.model,
        }, &app_settings)?;
        let speech = speak_text(
            SpeakTextOptions {
                text: Some(translation.text.clone()),
                voice: None,
                model: None,
                format: Some(app_settings.tts_format.clone()),
                autoplay: Some(true),
                max_chunk_chars: None,
                max_parallel_requests: Some(3),
                first_chunk_leading_silence_ms: Some(app_settings.first_chunk_leading_silence_ms),
            },
            &app_settings,
        )?;
        Ok(CaptureAndTranslateResult { captured_text: capture.text, restored_clipboard: capture.restored_clipboard, note: capture.note, translation, speech })
    }
}

pub use commands::{cancel_current_run, capture_and_speak_command, capture_and_translate_command, capture_selected_text_command, get_language_options, get_settings, pause_resume_current_run, reset_settings, speak_text_command, translate_text_command, update_settings};
