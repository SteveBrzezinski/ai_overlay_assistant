use crate::settings::{resolve_openai_api_key, AppSettings, SettingsState};
use chrono::{Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};
use tauri::State;

const MEMORY_MODEL: &str = "gpt-4o-mini";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreVoiceSessionMemoryRequest {
    pub disconnect_reason: String,
    pub user_transcripts: Vec<String>,
    pub assistant_transcripts: Vec<String>,
    pub tool_events: Vec<String>,
    pub task_events: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreVoiceSessionMemoryResult {
    pub ok: bool,
    pub skipped: bool,
    pub file_path: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallVoiceMemoryRequest {
    pub query: String,
    pub date: Option<String>,
    pub limit: Option<usize>,
    pub days_back_limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallVoiceMemoryMatch {
    pub date: String,
    pub line: String,
    pub score: i64,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallVoiceMemoryResult {
    pub ok: bool,
    pub matches: Vec<RecallVoiceMemoryMatch>,
    pub searched_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVoiceMemoryResult {
    pub ok: bool,
    pub date: String,
    pub file_path: String,
    pub lines: Vec<String>,
}

#[tauri::command]
pub fn store_voice_session_memory_command(
    request: StoreVoiceSessionMemoryRequest,
    settings: State<'_, SettingsState>,
) -> Result<StoreVoiceSessionMemoryResult, String> {
    let app_settings = settings.get();
    store_voice_session_memory(&request, &app_settings)
}

#[tauri::command]
pub fn recall_voice_memory_command(
    request: RecallVoiceMemoryRequest,
) -> Result<RecallVoiceMemoryResult, String> {
    recall_voice_memory(&request)
}

#[tauri::command]
pub fn get_recent_voice_memory_command(
    limit: Option<usize>,
) -> Result<RecentVoiceMemoryResult, String> {
    get_recent_voice_memory(limit.unwrap_or(5))
}

pub fn store_voice_session_memory(
    request: &StoreVoiceSessionMemoryRequest,
    settings: &AppSettings,
) -> Result<StoreVoiceSessionMemoryResult, String> {
    let file_path = current_brain_file_path();
    let material = collect_session_material(request);
    if material.is_empty() {
        return Ok(StoreVoiceSessionMemoryResult {
            ok: true,
            skipped: true,
            file_path: file_path.to_string_lossy().to_string(),
            lines: Vec::new(),
        });
    }

    let lines = summarize_session_lines(request, settings)
        .unwrap_or_else(|_| build_fallback_lines(request));
    if lines.is_empty() {
        return Ok(StoreVoiceSessionMemoryResult {
            ok: true,
            skipped: true,
            file_path: file_path.to_string_lossy().to_string(),
            lines: Vec::new(),
        });
    }

    ensure_memory_directory()?;
    let mut file =
        OpenOptions::new().create(true).append(true).open(&file_path).map_err(|error| {
            format!("Failed to open memory file {}: {error}", file_path.to_string_lossy())
        })?;
    let time_label = Local::now().format("%H:%M:%S").to_string();
    for line in &lines {
        writeln!(
            file,
            "[{}][{}] {}",
            time_label,
            normalize_reason(&request.disconnect_reason),
            line
        )
        .map_err(|error| {
            format!("Failed to append memory line to {}: {error}", file_path.to_string_lossy())
        })?;
    }

    Ok(StoreVoiceSessionMemoryResult {
        ok: true,
        skipped: false,
        file_path: file_path.to_string_lossy().to_string(),
        lines,
    })
}

pub fn recall_voice_memory(
    request: &RecallVoiceMemoryRequest,
) -> Result<RecallVoiceMemoryResult, String> {
    let dates = resolve_search_dates(request)?;
    let query_terms = tokenize_query(&request.query);
    let limit = request.limit.unwrap_or(5).clamp(1, 20);
    let mut matches = Vec::new();
    let mut searched_files = Vec::new();

    for date in dates {
        let path = brain_file_path_for_date(date);
        searched_files.push(path.to_string_lossy().to_string());
        if !path.exists() {
            continue;
        }

        let contents = fs::read_to_string(&path).map_err(|error| {
            format!("Failed to read memory file {}: {error}", path.to_string_lossy())
        })?;

        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let score = score_line(trimmed, &query_terms, request.date.as_deref());
            if score <= 0 && !query_terms.is_empty() {
                continue;
            }
            matches.push(RecallVoiceMemoryMatch {
                date: date.format("%d.%m.%Y").to_string(),
                line: trimmed.to_string(),
                score,
                file_path: path.to_string_lossy().to_string(),
            });
        }
    }

    matches.sort_by(|left, right| {
        right.score.cmp(&left.score).then_with(|| right.date.cmp(&left.date))
    });
    matches.truncate(limit);

    Ok(RecallVoiceMemoryResult { ok: true, matches, searched_files })
}

pub fn get_recent_voice_memory(limit: usize) -> Result<RecentVoiceMemoryResult, String> {
    let date = Local::now().date_naive();
    let path = brain_file_path_for_date(date);
    if !path.exists() {
        return Ok(RecentVoiceMemoryResult {
            ok: true,
            date: date.format("%d.%m.%Y").to_string(),
            file_path: path.to_string_lossy().to_string(),
            lines: Vec::new(),
        });
    }

    let contents = fs::read_to_string(&path).map_err(|error| {
        format!("Failed to read memory file {}: {error}", path.to_string_lossy())
    })?;
    let mut lines = contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if lines.len() > limit {
        lines = lines[lines.len() - limit..].to_vec();
    }

    Ok(RecentVoiceMemoryResult {
        ok: true,
        date: date.format("%d.%m.%Y").to_string(),
        file_path: path.to_string_lossy().to_string(),
        lines,
    })
}

fn summarize_session_lines(
    request: &StoreVoiceSessionMemoryRequest,
    settings: &AppSettings,
) -> Result<Vec<String>, String> {
    let api_key = resolve_openai_api_key(settings)?;
    let payload = json!({
        "disconnectReason": request.disconnect_reason,
        "userTranscripts": request.user_transcripts,
        "assistantTranscripts": request.assistant_transcripts,
        "toolEvents": request.tool_events,
        "taskEvents": request.task_events,
    });
    let system_prompt = "You compress voice assistant sessions into short daily memory lines. Return JSON only in the format {\"lines\":[\"...\",\"...\"]}. Each line must be concise but should include concrete outcomes, file names, paths, creations, moves, deletions, delegations, and open questions when present. Maximum 4 lines.";
    let user_prompt = format!("Create compact memory lines for this session:\n\n{}", payload);

    let client = reqwest::blocking::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&json!({
            "model": MEMORY_MODEL,
            "temperature": 0.2,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ]
        }))
        .send()
        .map_err(|error| format!("OpenAI memory summarization request failed: {error}"))?;

    let status = response.status();
    let response_json: serde_json::Value = response
        .json()
        .map_err(|error| format!("Failed to decode memory summarization response: {error}"))?;

    if !status.is_success() {
        return Err(format!("OpenAI memory summarization failed ({status}): {response_json}"));
    }

    let content = response_json
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Memory summarization response was empty".to_string())?;

    let parsed: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| format!("Failed to parse memory JSON: {error}"))?;
    let lines = parsed
        .get("lines")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .take(4)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(lines)
}

fn build_fallback_lines(request: &StoreVoiceSessionMemoryRequest) -> Vec<String> {
    let mut lines = Vec::new();
    let mut seen = HashSet::new();
    for source in [
        &request.task_events,
        &request.tool_events,
        &request.user_transcripts,
        &request.assistant_transcripts,
    ] {
        for item in source.iter().rev() {
            let normalized = item.split_whitespace().collect::<Vec<_>>().join(" ");
            if normalized.is_empty() || seen.contains(&normalized) {
                continue;
            }
            seen.insert(normalized.clone());
            lines.push(normalized);
            if lines.len() >= 4 {
                return lines;
            }
        }
    }
    lines
}

fn collect_session_material(request: &StoreVoiceSessionMemoryRequest) -> Vec<String> {
    [
        request.user_transcripts.clone(),
        request.assistant_transcripts.clone(),
        request.tool_events.clone(),
        request.task_events.clone(),
    ]
    .into_iter()
    .flatten()
    .map(|item| item.trim().to_string())
    .filter(|item| !item.is_empty())
    .collect()
}

fn ensure_memory_directory() -> Result<(), String> {
    fs::create_dir_all(memory_directory()).map_err(|error| {
        format!(
            "Failed to create memory directory {}: {error}",
            memory_directory().to_string_lossy()
        )
    })
}

fn memory_directory() -> PathBuf {
    runtime_data_root().join("brain")
}

fn runtime_data_root() -> PathBuf {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("VoiceOverlayAssistant").join("runtime");
    }

    dirs_fallback_home().join(".voice-overlay-assistant").join("runtime")
}

fn dirs_fallback_home() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn current_brain_file_path() -> PathBuf {
    brain_file_path_for_date(Local::now().date_naive())
}

fn brain_file_path_for_date(date: NaiveDate) -> PathBuf {
    memory_directory().join(format!("brain-{}.txt", date.format("%d.%m.%Y")))
}

fn resolve_search_dates(request: &RecallVoiceMemoryRequest) -> Result<Vec<NaiveDate>, String> {
    if let Some(date) = request.date.as_deref().and_then(parse_explicit_date) {
        return Ok(vec![date]);
    }

    if let Some(date) = parse_relative_date_from_query(&request.query) {
        return Ok(vec![date]);
    }

    let days_back = request.days_back_limit.unwrap_or(14).clamp(1, 60);
    Ok((0..=days_back).map(|offset| Local::now().date_naive() - Duration::days(offset)).collect())
}

fn parse_explicit_date(raw: &str) -> Option<NaiveDate> {
    let trimmed = raw.trim();
    NaiveDate::parse_from_str(trimmed, "%d.%m.%Y")
        .ok()
        .or_else(|| NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").ok())
}

fn parse_relative_date_from_query(query: &str) -> Option<NaiveDate> {
    let lower = query.to_lowercase();
    if lower.contains("heute") {
        return Some(Local::now().date_naive());
    }
    if lower.contains("gestern") {
        return Some(Local::now().date_naive() - Duration::days(1));
    }
    if let Some(number) = extract_days_ago_number(&lower) {
        return Some(Local::now().date_naive() - Duration::days(number));
    }
    None
}

fn extract_days_ago_number(query: &str) -> Option<i64> {
    let marker = "vor ";
    let index = query.find(marker)?;
    let tail = &query[index + marker.len()..];
    let digits = tail.chars().take_while(|char| char.is_ascii_digit()).collect::<String>();
    if digits.is_empty() {
        return None;
    }
    let has_day_word = tail.contains("tag");
    if !has_day_word {
        return None;
    }
    digits.parse::<i64>().ok()
}

fn tokenize_query(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split(|char: char| !char.is_alphanumeric() && char != ':' && char != '\\' && char != '.')
        .map(str::trim)
        .filter(|term| term.len() >= 2)
        .map(ToString::to_string)
        .collect()
}

fn score_line(line: &str, query_terms: &[String], explicit_date: Option<&str>) -> i64 {
    if query_terms.is_empty() {
        return if explicit_date.is_some() { 1 } else { 0 };
    }

    let lower = line.to_lowercase();
    query_terms.iter().fold(0, |score, term| {
        if lower.contains(term) {
            score
                + if term.contains(':')
                    || term.contains('\\')
                    || term.ends_with(".docx")
                    || term.ends_with(".txt")
                {
                    4
                } else {
                    2
                }
        } else {
            score
        }
    })
}

fn normalize_reason(reason: &str) -> String {
    let normalized = reason.split_whitespace().collect::<Vec<_>>().join("-");
    if normalized.is_empty() {
        "deactivate".to_string()
    } else {
        normalized
    }
}
