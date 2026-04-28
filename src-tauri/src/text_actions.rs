use crate::{
    clipboard::{paste_clipboard, set_clipboard_text},
    hotkey::{begin_managed_run, set_error, set_success, update_working},
    run_controller::is_cancelled_error,
    selection_capture::{capture_selected_text, CaptureOptions},
    settings::{resolve_openai_api_key, SettingsState},
    translation::{translate_text, TranslateTextOptions},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, time::Instant};
use tauri::{AppHandle, State};

const COMPACT_ACTION: &str = "compact-selection";
const TRANSLATE_REPLACE_ACTION: &str = "translate-replace";
const DEFAULT_COMPACT_MODEL: &str = "gpt-4o-mini";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateSelectionReplaceRequest {
    pub target_language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedTextActionResult {
    pub action: String,
    pub captured_text: String,
    pub output_text: String,
    pub pasted: bool,
    pub model: Option<String>,
    pub target_language: Option<String>,
    pub restored_clipboard: bool,
    pub elapsed_ms: u128,
}

#[tauri::command]
pub fn compact_selected_text_command(
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<SelectedTextActionResult, String> {
    compact_selected_text_and_replace(&app, &settings)
}

#[tauri::command]
pub fn translate_selected_text_replace_command(
    request: Option<TranslateSelectionReplaceRequest>,
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<SelectedTextActionResult, String> {
    translate_selected_text_and_replace(
        &app,
        &settings,
        request.and_then(|value| value.target_language),
    )
}

pub fn compact_selected_text_and_replace(
    app: &AppHandle,
    settings: &SettingsState,
) -> Result<SelectedTextActionResult, String> {
    run_selected_text_action(
        app,
        settings,
        COMPACT_ACTION,
        "Capturing selected text to compact it...".to_string(),
        |text, settings| {
            let model = configured_compact_model();
            let output = compact_text(text, settings, &model)?;
            Ok((output, Some(model), None))
        },
    )
}

pub fn translate_selected_text_and_replace(
    app: &AppHandle,
    settings: &SettingsState,
    target_language: Option<String>,
) -> Result<SelectedTextActionResult, String> {
    run_selected_text_action(
        app,
        settings,
        TRANSLATE_REPLACE_ACTION,
        "Capturing selected text to translate it...".to_string(),
        |text, settings| {
            let app_settings = settings.get();
            let target_language = target_language
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| app_settings.translation_target_language.clone());
            let translation = translate_text(
                TranslateTextOptions {
                    text: Some(text.to_string()),
                    target_language: Some(target_language),
                    source_language: None,
                    model: None,
                },
                &app_settings,
            )?;

            Ok((translation.text, Some(translation.model), Some(translation.target_language)))
        },
    )
}

fn run_selected_text_action<F>(
    app: &AppHandle,
    settings: &SettingsState,
    action: &str,
    initial_message: String,
    transform: F,
) -> Result<SelectedTextActionResult, String>
where
    F: FnOnce(&str, &SettingsState) -> Result<(String, Option<String>, Option<String>), String>,
{
    let started = Instant::now();
    let run_handle = begin_managed_run(app, action, initial_message)?;
    let run_access = run_handle.access();

    let result = (|| {
        run_access.update_phase("capturing_selection");
        let capture = capture_selected_text(Some(CaptureOptions {
            copy_delay_ms: Some(100),
            restore_clipboard: Some(true),
        }))?;

        if capture.text.trim().is_empty() {
            return Err(capture
                .note
                .unwrap_or_else(|| "No marked text could be captured.".to_string()));
        }

        run_access.check_cancelled()?;
        run_access.update_phase("transforming_text");
        update_working(app, action, "Transforming selected text...".to_string());
        let (output_text, model, target_language) = transform(&capture.text, settings)?;
        let output_text = output_text.trim().to_string();
        if output_text.is_empty() {
            return Err("The text action produced no output.".to_string());
        }

        run_access.check_cancelled()?;
        run_access.update_phase("pasting_replacement");
        update_working(app, action, "Replacing selected text...".to_string());
        set_clipboard_text(&output_text)?;
        paste_clipboard()?;

        Ok(SelectedTextActionResult {
            action: action.to_string(),
            captured_text: capture.text,
            output_text,
            pasted: true,
            model,
            target_language,
            restored_clipboard: capture.restored_clipboard,
            elapsed_ms: started.elapsed().as_millis(),
        })
    })();

    match result {
        Ok(result) => {
            set_success(
                app,
                action,
                format!("Selected text replaced in {} ms.", result.elapsed_ms),
                Some(result.output_text.clone()),
            );
            Ok(result)
        }
        Err(error) if is_cancelled_error(&error) => {
            set_success(
                app,
                action,
                format!(
                    "Selected text action cancelled after {} ms.",
                    started.elapsed().as_millis()
                ),
                None,
            );
            Err(error)
        }
        Err(error) => {
            set_error(app, action, error.clone(), None, None, None);
            Err(error)
        }
    }
}

fn configured_compact_model() -> String {
    env::var("OPENAI_COMPACT_MODEL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_COMPACT_MODEL.to_string())
}

fn compact_text(text: &str, settings: &SettingsState, model: &str) -> Result<String, String> {
    let api_key = resolve_openai_api_key(&settings.get())?;
    let client = reqwest::blocking::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "temperature": 0.2,
            "messages": [
                {
                    "role": "system",
                    "content": "Compact the user's text. Preserve meaning, important facts, names, numbers, tasks, and formatting where useful. Return only the compacted text in the original language."
                },
                {
                    "role": "user",
                    "content": text
                }
            ]
        }))
        .send()
        .map_err(|error| format!("OpenAI compact request failed: {error}"))?;

    let status = response.status();
    let payload: Value =
        response.json().map_err(|error| format!("Failed to decode compact response: {error}"))?;

    if !status.is_success() {
        return Err(format!("OpenAI compact request failed ({status}): {payload}"));
    }

    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "OpenAI compact response was empty.".to_string())
}
