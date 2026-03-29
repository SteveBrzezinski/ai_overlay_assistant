use serde::{Deserialize, Serialize};
use serde_json::json;
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

pub fn append_stt_debug_log(options: AppendSttDebugLogOptions) -> Result<AppendSttDebugLogResult, String> {
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

    Ok(AppendSttDebugLogResult {
        debug_log_path: path.to_string_lossy().to_string(),
    })
}

fn debug_log_path_for_session(session_id: &str) -> Result<PathBuf, String> {
    let mut dir = env::temp_dir();
    dir.push("voice-overlay-assistant");
    dir.push("stt-debug");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create STT debug directory '{}': {err}", dir.display()))?;
    Ok(dir.join(format!("{session_id}.jsonl")))
}

fn system_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
