use crate::settings::{resolve_openai_api_key, AppSettings};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::blocking::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SttDebugEntry {
    pub provider: String,
    pub transcript: String,
    pub latency_ms: u64,
    pub ok: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendSttDebugLogOptions {
    pub session_id: String,
    pub selected_provider: String,
    pub active_transcript: String,
    pub entries: Vec<SttDebugEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendSttDebugLogResult {
    pub debug_log_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeChatAudioRequest {
    pub audio_base64: String,
    pub mime_type: String,
    pub file_name: String,
    pub language: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeChatAudioResult {
    pub text: String,
    pub model: String,
    pub language: Option<String>,
}

pub fn append_stt_debug_log(
    options: AppendSttDebugLogOptions,
) -> Result<AppendSttDebugLogResult, String> {
    let path = debug_log_path_for_session(&options.session_id)?;
    let payload = json!({
        "timestampMs": system_time_ms(),
        "selectedProvider": options.selected_provider,
        "activeTranscript": options.active_transcript,
        "entries": options.entries,
    });

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("Failed to open STT debug log '{}': {err}", path.display()))?;
    writeln!(file, "{}", payload)
        .map_err(|err| format!("Failed to append STT debug log '{}': {err}", path.display()))?;

    Ok(AppendSttDebugLogResult { debug_log_path: path.to_string_lossy().to_string() })
}

pub fn transcribe_chat_audio(
    request: TranscribeChatAudioRequest,
    settings: &AppSettings,
) -> Result<TranscribeChatAudioResult, String> {
    let api_key = resolve_openai_api_key(settings)?;
    let audio_base64 = request.audio_base64.trim();
    if audio_base64.is_empty() {
        return Err("The chat recording was empty.".to_string());
    }

    let audio_bytes = BASE64_STANDARD
        .decode(audio_base64)
        .map_err(|error| format!("Failed to decode the recorded chat audio: {error}"))?;
    if audio_bytes.is_empty() {
        return Err("The chat recording did not contain any audio bytes.".to_string());
    }

    let mime_type = request.mime_type.trim();
    if mime_type.is_empty() {
        return Err("The chat recording did not contain a MIME type.".to_string());
    }

    let file_name = request.file_name.trim();
    if file_name.is_empty() {
        return Err("The chat recording did not contain a file name.".to_string());
    }

    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("gpt-4o-transcribe")
        .to_string();
    let language = request
        .language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let fallback = settings.stt_language.trim();
            if fallback.is_empty() {
                None
            } else {
                Some(fallback.to_string())
            }
        });

    let file_part =
        Part::bytes(audio_bytes).file_name(file_name.to_string()).mime_str(mime_type).map_err(
            |error| format!("The recorded chat audio type '{mime_type}' is unsupported: {error}"),
        )?;

    let mut form = Form::new().text("model", model.clone()).part("file", file_part);
    if let Some(language) = language.clone() {
        form = form.text("language", language);
    }

    let client = reqwest::blocking::Client::new();
    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .map_err(|error| format!("OpenAI transcription failed: {error}"))?;

    let status = response.status();
    let payload: Value = response
        .json()
        .map_err(|error| format!("Failed to decode OpenAI transcription response: {error}"))?;

    if !status.is_success() {
        return Err(format!("OpenAI transcription failed ({status}): {payload}"));
    }

    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "OpenAI transcription returned no text.".to_string())?
        .to_string();

    Ok(TranscribeChatAudioResult { text, model, language })
}

fn debug_log_path_for_session(session_id: &str) -> Result<PathBuf, String> {
    let mut dir = env::temp_dir();
    dir.push("voice-overlay-assistant");
    dir.push("stt-debug");
    fs::create_dir_all(&dir).map_err(|err| {
        format!("Failed to create STT debug directory '{}': {err}", dir.display())
    })?;
    Ok(dir.join(format!("{session_id}.jsonl")))
}

fn system_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
