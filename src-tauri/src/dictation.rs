use crate::{
    clipboard::{paste_clipboard, set_clipboard_text},
    hotkey::{set_error, set_success, update_working},
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationInsertRequest {
    pub text: String,
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatusRequest {
    pub mode: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationInsertResult {
    pub text: String,
    pub mode: String,
    pub pasted: bool,
}

#[tauri::command]
pub fn report_dictation_transcribing_command(
    request: DictationStatusRequest,
    app: AppHandle,
) -> Result<(), String> {
    let mode = sanitize_mode(&request.mode);
    let action = action_for_mode(mode);
    update_working(
        &app,
        action,
        request
            .detail
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Dictation recording finished. Transcribing...".to_string()),
    );
    Ok(())
}

#[tauri::command]
pub fn report_dictation_error_command(
    request: DictationStatusRequest,
    app: AppHandle,
) -> Result<(), String> {
    let mode = sanitize_mode(&request.mode);
    let action = action_for_mode(mode);
    set_error(
        &app,
        action,
        request
            .detail
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Dictation failed.".to_string()),
        None,
        None,
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn insert_dictation_text_command(
    request: DictationInsertRequest,
    app: AppHandle,
) -> Result<DictationInsertResult, String> {
    let text = request.text.trim().to_string();
    let mode = sanitize_mode(&request.mode);
    let action = action_for_mode(mode);

    if text.is_empty() {
        let message = "Dictation produced no text.".to_string();
        set_error(&app, action, message.clone(), None, None, None);
        return Err(message);
    }

    update_working(
        &app,
        action,
        if mode == "clipboard" {
            "Dictation transcribed. Copying text to clipboard...".to_string()
        } else {
            "Dictation transcribed. Pasting text into the active app...".to_string()
        },
    );

    set_clipboard_text(&text).map_err(|error| {
        set_error(&app, action, error.clone(), Some(text.clone()), None, None);
        error
    })?;

    let pasted = mode == "paste";
    if pasted {
        paste_clipboard().map_err(|error| {
            set_error(&app, action, error.clone(), Some(text.clone()), None, None);
            error
        })?;
    }

    set_success(
        &app,
        action,
        if pasted {
            format!("Dictation pasted {} character(s).", text.chars().count())
        } else {
            format!("Dictation copied {} character(s) to the clipboard.", text.chars().count())
        },
        Some(text.clone()),
    );

    Ok(DictationInsertResult { text, mode: mode.to_string(), pasted })
}

fn sanitize_mode(mode: &str) -> &'static str {
    if mode.trim().eq_ignore_ascii_case("clipboard") {
        "clipboard"
    } else {
        "paste"
    }
}

fn action_for_mode(mode: &str) -> &'static str {
    if mode == "clipboard" {
        "dictation-clipboard"
    } else {
        "dictation-paste"
    }
}
