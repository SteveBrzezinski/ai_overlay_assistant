use crate::{
    settings::{resolve_openai_api_key, SettingsState},
    voice_memory::{recall_voice_memory, RecallVoiceMemoryRequest},
    voice_profile::{build_assistant_instructions, build_voice_agent_state},
    voice_tasks::VoiceTaskState,
    voice_timers::{
        format_duration_label, format_remaining_label, timer_candidates_to_json, timer_to_json,
        TimerResolveResult, VoiceTimer, VoiceTimerState,
    },
};
use chrono::{Local, Offset, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const DEFAULT_WEB_SEARCH_MODEL: &str = "gpt-5.5";

struct SearchPathItem {
    path: String,
    kind: &'static str,
    name: String,
}

enum CompletedTimerDismissResolution {
    Matched(VoiceTimer),
    Clarify(Value),
    None,
}

pub fn realtime_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": "discover_environment",
            "description": "Returns the current local runtime context such as operating system, working directory, home directory, temp directory, and important default paths.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "type": "function",
            "name": "get_current_time",
            "description": "Returns the current local date and time from this PC. Use this for questions about the current time, date, weekday, timezone offset, or 'right now'.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "type": "function",
            "name": "web_search",
            "description": "Searches the public web through OpenAI's hosted web search tool and returns a concise answer with source URLs. Use this for current events, recent facts, prices, release status, public websites, or anything that may have changed recently. Do not use this for local PC files or local app state.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The web search question or query." },
                    "context": { "type": "string", "description": "Optional user context that should shape the answer without replacing the query." },
                    "responseLanguage": { "type": "string", "description": "Optional desired answer language, for example de or en." }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "create_timer",
            "description": "Creates a local background timer. If no title is provided, a default title based on the duration is generated automatically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Optional timer title." },
                    "durationMinutes": { "type": "integer", "minimum": 0, "maximum": 1440 },
                    "durationSeconds": { "type": "integer", "minimum": 0, "maximum": 86400 },
                    "durationMs": { "type": "integer", "minimum": 1000, "maximum": 86400000 }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "list_timers",
            "description": "Lists the currently known local timers and their current status.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "type": "function",
            "name": "get_timer_status",
            "description": "Returns the remaining time and status for a timer.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timerId": { "type": "string" },
                    "query": { "type": "string", "description": "Timer title or a distinctive part of it." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "pause_timer",
            "description": "Stops a timer. Running timers are paused. Completed timers are dismissed and removed, which also stops any repeating alert.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timerId": { "type": "string" },
                    "query": { "type": "string", "description": "Timer title or a distinctive part of it." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "resume_timer",
            "description": "Resumes a paused timer.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timerId": { "type": "string" },
                    "query": { "type": "string", "description": "Timer title or a distinctive part of it." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "update_timer",
            "description": "Renames a timer and or restarts it from a new duration.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timerId": { "type": "string" },
                    "query": { "type": "string", "description": "Timer title or a distinctive part of it." },
                    "title": { "type": "string", "description": "New timer title." },
                    "durationMinutes": { "type": "integer", "minimum": 0, "maximum": 1440 },
                    "durationSeconds": { "type": "integer", "minimum": 0, "maximum": 86400 },
                    "durationMs": { "type": "integer", "minimum": 1000, "maximum": 86400000 }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "delete_timer",
            "description": "Deletes a timer. Use this to remove finished timers and stop their repeating alert.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timerId": { "type": "string" },
                    "query": { "type": "string", "description": "Timer title or a distinctive part of it." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "search_paths",
            "description": "Searches dynamically for files or folders on the local system. Use this when you do not know an exact path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Part of a file or folder name." },
                    "basePath": { "type": "string", "description": "Optional base folder to limit the search scope." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 15, "description": "Maximum number of matches." }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "stat_path",
            "description": "Reads metadata for an exact path, for example whether it exists, how large it is, and whether it is a file or directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Exact local path." }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "open_target",
            "description": "Opens an exact path, folder, or URL with the operating system's default handler. Not intended for complex Office automation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Exact path, folder, or URL." }
                },
                "required": ["target"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "read_path",
            "description": "Reads the contents of a file when the format is safely readable locally, for example text files or simple docx documents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Exact file path." },
                    "maxBytes": { "type": "integer", "minimum": 256, "maximum": 200000, "description": "Optional read limit for large files." }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "write_path",
            "description": "Writes content to a file. Intended for text files and simple docx creation. Delegate complex format handling or UI automation to a specialist.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Exact target path." },
                    "content": { "type": "string", "description": "File contents." },
                    "overwrite": { "type": "boolean", "description": "Whether an existing file may be overwritten." },
                    "createParents": { "type": "boolean", "description": "Whether missing parent directories should be created automatically." }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "move_path",
            "description": "Moves or renames a file or directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sourcePath": { "type": "string" },
                    "destinationPath": { "type": "string" },
                    "replaceExisting": { "type": "boolean" }
                },
                "required": ["sourcePath", "destinationPath"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "copy_path",
            "description": "Copies a file or directory to a new location.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sourcePath": { "type": "string" },
                    "destinationPath": { "type": "string" },
                    "replaceExisting": { "type": "boolean" },
                    "recursive": { "type": "boolean" }
                },
                "required": ["sourcePath", "destinationPath"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "delete_path",
            "description": "Deletes a file or directory. For directories, recursive=true is required.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "recursive": { "type": "boolean" }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "list_processes",
            "description": "Lists currently running processes. Optionally filters by name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "start_process",
            "description": "Starts a process or command explicitly via a target program plus optional arguments. Prefer open_target for documents or URLs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Command, program name, or exact path." },
                    "arguments": { "type": "array", "items": { "type": "string" } },
                    "workingDirectory": { "type": "string" }
                },
                "required": ["target"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "stop_process",
            "description": "Stops a running process by PID or process name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pid": { "type": "integer", "minimum": 1 },
                    "name": { "type": "string" },
                    "force": { "type": "boolean" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "deactivate_voice_assistant",
            "description": "Switches the voice agent back to online_muted. Use this proactively when the latest user turn indicates they are done, signing off, dismissing you, or ending the conversation, including very short first-turn sign-offs immediately after activation. First finish exactly one very short farewell, then call this as the final step of the same closing turn. Keep the farewell minimal, ideally one short sentence or one to four words, and avoid meta phrases such as explaining that you are now saying goodbye. If you say any goodbye or closing sign-off, this tool is mandatory in that same turn. Never use it right after asking the user a question or when their reply is still expected.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": { "type": "string" },
                    "farewell": { "type": "string" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "update_assistant_state",
            "description": "Stores the assistant's voice, personality, and other preferences. The name remains fixed to the wake-word configuration.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Ignored because the assistant name comes from the wake-word configuration." },
                    "voice": { "type": "string" },
                    "model": { "type": "string" },
                    "personality": { "type": "string" },
                    "behavior": { "type": "string" },
                    "extraInstructions": { "type": "string" },
                    "preferredLanguage": { "type": "string" },
                    "gender": { "type": "string", "enum": ["feminine", "masculine", "neutral"] },
                    "toneNotes": { "type": "string" },
                    "onboardingComplete": { "type": "boolean" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "recall_memory",
            "description": "Searches the local daily memory for earlier tasks, files, paths, outcomes, and follow-ups. Use this for recall questions such as 'What did we do five days ago?'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What to search for in the memory entries, for example a topic, file name, or path." },
                    "date": { "type": "string", "description": "Optional exact date as dd.MM.yyyy or yyyy-MM-dd." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 10, "description": "Maximum number of matches." },
                    "daysBackLimit": { "type": "integer", "minimum": 1, "maximum": 60, "description": "How many days back to search when no exact date is given." }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "get_openclaw_status",
            "description": "Checks whether OpenClaw is installed on this machine and whether gateway mode is available or only local fallback.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "type": "function",
            "name": "get_specialist_agents",
            "description": "Returns the known specialist agents and their current OpenClaw status.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "type": "function",
            "name": "delegate_to_specialist",
            "description": "Delegates a more complex task to the best fitting specialist such as pc-ops or coder.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": { "type": "string" },
                    "specialist": { "type": "string" },
                    "context": { "type": "string" },
                    "thinkingLevel": { "type": "string" },
                    "preferMode": { "type": "string" },
                    "timeoutSeconds": { "type": "integer" }
                },
                "required": ["task"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "delegate_to_openclaw",
            "description": "Delegates a task directly to OpenClaw when the specialist structure does not fit or raw OpenClaw delegation is explicitly requested.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": { "type": "string" },
                    "thinkingLevel": { "type": "string" },
                    "preferMode": { "type": "string" },
                    "timeoutSeconds": { "type": "integer" },
                    "agentId": { "type": "string" }
                },
                "required": ["task"],
                "additionalProperties": false
            }
        }),
    ]
}

pub fn run_voice_agent_tool(
    tool_name: &str,
    args: Value,
    app: &AppHandle,
    settings: &SettingsState,
) -> Result<Value, String> {
    match tool_name {
        "discover_environment" | "get_pc_context" => discover_environment_tool(),
        "get_current_time" | "get_local_time" | "get_time" => get_current_time_tool(),
        "web_search" => web_search_tool(&args, settings),
        "create_timer" => create_timer_tool(&args, app),
        "list_timers" => list_timers_tool(app),
        "get_timer_status" => get_timer_status_tool(&args, app),
        "pause_timer" => pause_timer_tool(&args, app),
        "resume_timer" => resume_timer_tool(&args, app),
        "update_timer" => update_timer_tool(&args, app),
        "delete_timer" => delete_timer_tool(&args, app),
        "search_paths" | "find_paths" => search_paths_tool(&args),
        "stat_path" => stat_path_tool(&args),
        "open_target" => open_target_tool(&args),
        "read_path" => read_path_tool(&args),
        "write_path" => write_path_tool(&args),
        "move_path" => move_path_tool(&args),
        "copy_path" => copy_path_tool(&args),
        "delete_path" => delete_path_tool(&args),
        "list_processes" => list_processes_tool(&args),
        "start_process" => start_process_tool(&args),
        "stop_process" => stop_process_tool(&args),
        "deactivate_voice_assistant" => deactivate_voice_assistant_tool(&args),
        "update_assistant_state" => update_assistant_state_tool(&args, settings),
        "recall_memory" => recall_memory_tool(&args),
        "get_openclaw_status" => get_openclaw_status_tool(),
        "get_specialist_agents" => get_specialist_agents_tool(),
        "delegate_to_specialist" => delegate_to_specialist_tool(&args, app),
        "delegate_to_openclaw" => delegate_to_openclaw_tool(&args, app),
        _ => Err(format!("Unknown voice agent tool: {tool_name}")),
    }
}

fn discover_environment_tool() -> Result<Value, String> {
    let working_directory = env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    let home_directory = home_dir();
    Ok(json!({
        "platform": env::consts::OS,
        "osType": env::consts::FAMILY,
        "hostname": env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string()),
        "username": env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string()),
        "workingDirectory": working_directory.to_string_lossy(),
        "homeDirectory": home_directory.to_string_lossy(),
        "tempDirectory": env::temp_dir().to_string_lossy(),
        "commonLocations": common_locations(),
        "pathSeparator": "\\",
        "projectRoot": project_root().to_string_lossy(),
    }))
}

fn get_current_time_tool() -> Result<Value, String> {
    let local_now = Local::now();
    let utc_now = Utc::now();
    let offset_seconds = local_now.offset().fix().local_minus_utc();
    let offset_minutes = offset_seconds / 60;
    let human_local_time = local_now.format("%H:%M").to_string();
    let precise_local_time = local_now.format("%H:%M:%S").to_string();

    Ok(json!({
        "ok": true,
        "localDateTime": local_now.to_rfc3339(),
        "localDate": local_now.format("%Y-%m-%d").to_string(),
        "localTime": human_local_time,
        "localTimePrecise": precise_local_time,
        "weekday": local_now.format("%A").to_string(),
        "timezoneOffsetMinutes": offset_minutes,
        "timezoneOffsetLabel": format_offset_label(offset_seconds),
        "utcDateTime": utc_now.to_rfc3339(),
        "unixTimestamp": utc_now.timestamp(),
        "unixTimestampMs": utc_now.timestamp_millis(),
        "message": format!(
            "Local PC time is {} on {} (UTC{}).",
            local_now.format("%H:%M"),
            local_now.format("%Y-%m-%d"),
            format_offset_label(offset_seconds)
        ),
    }))
}

fn web_search_tool(args: &Value, settings: &SettingsState) -> Result<Value, String> {
    let query = value_to_string(args.get("query")).trim().to_string();
    if query.is_empty() {
        return Err("Missing web search query.".to_string());
    }

    let context = value_to_string(args.get("context")).trim().to_string();
    let response_language = value_to_string(args.get("responseLanguage")).trim().to_string();
    let app_settings = settings.get();
    let api_key = resolve_openai_api_key(&app_settings)?;
    let model = configured_web_search_model();
    let input = build_web_search_input(&query, &context, &response_language);

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Failed to create OpenAI web search client: {error}"))?;

    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&json!({
            "model": model,
            "reasoning": { "effort": "low" },
            "tools": [{ "type": "web_search" }],
            "tool_choice": "auto",
            "include": ["web_search_call.action.sources"],
            "input": input,
        }))
        .send()
        .map_err(|error| format!("OpenAI web search request failed: {error}"))?;

    let status = response.status();
    let payload: Value = response
        .json()
        .map_err(|error| format!("Failed to decode OpenAI web search response: {error}"))?;

    if !status.is_success() {
        return Err(format!("OpenAI web search failed ({status}): {payload}"));
    }

    let answer = extract_response_text(&payload)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OpenAI web search response did not contain an answer.".to_string())?;
    let sources = extract_web_search_sources(&payload);
    let source_count = sources.len();

    Ok(json!({
        "ok": true,
        "toolName": "web_search",
        "query": query,
        "answer": answer,
        "sources": sources,
        "model": model,
        "searchedAt": Utc::now().to_rfc3339(),
        "message": format!("Web search completed with {source_count} source(s)."),
    }))
}

fn configured_web_search_model() -> String {
    env::var("OPENAI_WEB_SEARCH_MODEL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_WEB_SEARCH_MODEL.to_string())
}

fn build_web_search_input(query: &str, context: &str, response_language: &str) -> String {
    let mut parts = vec![
        "Search the public web before answering. Return a concise, factual answer and preserve useful source references from the search result.".to_string(),
        format!("Question: {query}"),
    ];

    if !context.is_empty() {
        parts.push(format!("Additional context: {context}"));
    }

    if !response_language.is_empty() {
        parts.push(format!("Answer language: {response_language}"));
    }

    parts.join("\n")
}

fn extract_response_text(payload: &Value) -> Option<String> {
    if let Some(text) = payload
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_string());
    }

    let mut parts = Vec::new();
    if let Some(output) = payload.get("output").and_then(Value::as_array) {
        for item in output {
            if item.get("type").and_then(Value::as_str) == Some("message") {
                collect_content_texts(item.get("content"), &mut parts);
            }
        }
    }

    if parts.is_empty() {
        collect_content_texts(payload.get("content"), &mut parts);
    }

    if parts.is_empty() {
        if let Some(choices) = payload.get("choices").and_then(Value::as_array) {
            for choice in choices {
                if let Some(message) = choice.get("message") {
                    if let Some(text) = message.get("content").and_then(Value::as_str) {
                        push_trimmed_text(text, &mut parts);
                    }
                }
            }
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

fn collect_content_texts(content: Option<&Value>, parts: &mut Vec<String>) {
    match content {
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    push_trimmed_text(text, parts);
                }
            }
        }
        Some(Value::String(text)) => push_trimmed_text(text, parts),
        _ => {}
    }
}

fn push_trimmed_text(text: &str, parts: &mut Vec<String>) {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
}

fn extract_web_search_sources(payload: &Value) -> Vec<Value> {
    let mut sources = Vec::new();
    let mut seen_urls = HashSet::new();

    if let Some(output) = payload.get("output").and_then(Value::as_array) {
        for item in output {
            if item.get("type").and_then(Value::as_str) == Some("message") {
                collect_sources_from_content(item.get("content"), &mut sources, &mut seen_urls);
            }

            if item.get("type").and_then(Value::as_str) == Some("web_search_call") {
                if let Some(action_sources) = item
                    .get("action")
                    .and_then(|value| value.get("sources"))
                    .and_then(Value::as_array)
                {
                    for source in action_sources {
                        push_web_source(source, &mut sources, &mut seen_urls);
                    }
                }
            }
        }
    }

    if let Some(choices) = payload.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(annotations) = choice
                .get("message")
                .and_then(|message| message.get("annotations"))
                .and_then(Value::as_array)
            {
                for annotation in annotations {
                    push_web_source(annotation, &mut sources, &mut seen_urls);
                }
            }
        }
    }

    sources
}

fn collect_sources_from_content(
    content: Option<&Value>,
    sources: &mut Vec<Value>,
    seen_urls: &mut HashSet<String>,
) {
    if let Some(items) = content.and_then(Value::as_array) {
        for item in items {
            if let Some(annotations) = item.get("annotations").and_then(Value::as_array) {
                for annotation in annotations {
                    push_web_source(annotation, sources, seen_urls);
                }
            }
        }
    }
}

fn push_web_source(raw_source: &Value, sources: &mut Vec<Value>, seen_urls: &mut HashSet<String>) {
    let source = raw_source.get("url_citation").unwrap_or(raw_source);
    let url = source.get("url").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if url.is_empty() || !seen_urls.insert(url.to_string()) {
        return;
    }

    let mut item = json!({ "url": url });
    if let Some(object) = item.as_object_mut() {
        if let Some(title) = source
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            object.insert("title".to_string(), Value::String(title.to_string()));
        }

        if let Some(source_type) = source
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "url_citation")
        {
            object.insert("type".to_string(), Value::String(source_type.to_string()));
        }
    }

    sources.push(item);
}

fn create_timer_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let duration_ms = parse_timer_duration_ms(args)?;
    let state = app.state::<VoiceTimerState>();
    let timer = state.create_timer(args.get("title").and_then(Value::as_str), duration_ms)?;
    state.emit_timer(app, "created", &timer);

    Ok(json!({
        "ok": true,
        "timer": timer_to_json(&timer),
        "message": format!(
            "Started timer {} for {}.",
            timer.title,
            format_duration_label(duration_ms)
        ),
    }))
}

fn list_timers_tool(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<VoiceTimerState>();
    let timers = state.list_timers();
    let active_count = timers.iter().filter(|timer| timer.status == "running").count();
    let paused_count = timers.iter().filter(|timer| timer.status == "paused").count();

    Ok(json!({
        "ok": true,
        "timers": timers.iter().map(timer_to_json).collect::<Vec<_>>(),
        "activeCount": active_count,
        "pausedCount": paused_count,
        "message": if timers.is_empty() {
            "No timers are currently active.".to_string()
        } else {
            format!("There are {} timers in the local timer list.", timers.len())
        },
    }))
}

fn get_timer_status_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let timer = match resolve_timer_from_args(args, app)? {
        Some(timer) => timer,
        None => return Ok(timer_resolution_payload(args, app)),
    };

    Ok(json!({
        "ok": true,
        "timer": timer_to_json(&timer),
        "remainingLabel": format_remaining_label(&timer),
        "message": if timer.status == "completed" {
            format!(
                "Timer {} is already finished and will keep alerting until it is dismissed.",
                timer.title
            )
        } else if timer.status == "paused" {
            format!(
                "Timer {} is paused with {} remaining.",
                timer.title,
                format_remaining_label(&timer)
            )
        } else {
            format!(
                "Timer {} has {} remaining.",
                timer.title,
                format_remaining_label(&timer)
            )
        },
    }))
}

fn pause_timer_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<VoiceTimerState>();
    let timer = match resolve_completed_timer_for_dismissal(args, app) {
        CompletedTimerDismissResolution::Matched(timer) => timer,
        CompletedTimerDismissResolution::Clarify(payload) => return Ok(payload),
        CompletedTimerDismissResolution::None => match resolve_timer_from_args(args, app)? {
            Some(timer) => timer,
            None => return Ok(timer_resolution_payload(args, app)),
        },
    };
    if timer.status == "completed" {
        let deleted = state.delete_timer(&timer.id)?;
        state.emit_timer(app, "deleted", &deleted);

        return Ok(json!({
            "ok": true,
            "timer": timer_to_json(&deleted),
            "dismissedCompleted": true,
            "message": format!(
                "Dismissed finished timer {} and stopped its alert.",
                deleted.title
            ),
        }));
    }

    let updated = state.pause_timer(&timer.id)?;
    state.emit_timer(app, "paused", &updated);

    Ok(json!({
        "ok": true,
        "timer": timer_to_json(&updated),
        "message": format!(
            "Paused timer {} with {} remaining.",
            updated.title,
            format_remaining_label(&updated)
        ),
    }))
}

fn resume_timer_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let timer = match resolve_timer_from_args(args, app)? {
        Some(timer) => timer,
        None => return Ok(timer_resolution_payload(args, app)),
    };
    let state = app.state::<VoiceTimerState>();
    let updated = state.resume_timer(&timer.id)?;
    state.emit_timer(app, "resumed", &updated);

    Ok(json!({
        "ok": true,
        "timer": timer_to_json(&updated),
        "message": format!(
            "Resumed timer {} with {} remaining.",
            updated.title,
            format_remaining_label(&updated)
        ),
    }))
}

fn update_timer_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let timer = match resolve_timer_from_args(args, app)? {
        Some(timer) => timer,
        None => return Ok(timer_resolution_payload(args, app)),
    };

    let new_title = args.get("title").and_then(Value::as_str);
    let new_duration_ms = parse_optional_timer_duration_ms(args)?;
    if new_title.map(str::trim).unwrap_or("").is_empty() && new_duration_ms.is_none() {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "The timer update is missing a new title or a new duration.",
            "question": "What should be changed for the timer?"
        }));
    }

    let state = app.state::<VoiceTimerState>();
    let updated = state.update_timer(&timer.id, new_title, new_duration_ms)?;
    state.emit_timer(app, "updated", &updated);

    Ok(json!({
        "ok": true,
        "timer": timer_to_json(&updated),
        "message": if new_duration_ms.is_some() {
            format!(
                "Updated timer {}. It is now set to {}.",
                updated.title,
                if updated.status == "completed" {
                    "done".to_string()
                } else {
                    format_remaining_label(&updated)
                }
            )
        } else {
            format!("Renamed the timer to {}.", updated.title)
        },
    }))
}

fn delete_timer_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let timer = match resolve_completed_timer_for_dismissal(args, app) {
        CompletedTimerDismissResolution::Matched(timer) => timer,
        CompletedTimerDismissResolution::Clarify(payload) => return Ok(payload),
        CompletedTimerDismissResolution::None => match resolve_timer_from_args(args, app)? {
            Some(timer) => timer,
            None => return Ok(timer_resolution_payload(args, app)),
        },
    };
    let state = app.state::<VoiceTimerState>();
    let deleted = state.delete_timer(&timer.id)?;
    state.emit_timer(app, "deleted", &deleted);

    Ok(json!({
        "ok": true,
        "timer": timer_to_json(&deleted),
        "message": if deleted.status == "completed" {
            format!("Dismissed finished timer {} and stopped its alert.", deleted.title)
        } else {
            format!("Deleted timer {}.", deleted.title)
        },
    }))
}

fn parse_timer_duration_ms(args: &Value) -> Result<u64, String> {
    parse_optional_timer_duration_ms(args)?
        .ok_or_else(|| "A timer duration is required.".to_string())
}

fn parse_optional_timer_duration_ms(args: &Value) -> Result<Option<u64>, String> {
    let duration_ms = args.get("durationMs").and_then(Value::as_u64);
    let duration_minutes = args.get("durationMinutes").and_then(Value::as_u64);
    let duration_seconds = args.get("durationSeconds").and_then(Value::as_u64);

    if duration_ms.is_none() && duration_minutes.is_none() && duration_seconds.is_none() {
        return Ok(None);
    }

    if let Some(duration_ms) = duration_ms {
        if duration_ms < 1_000 {
            return Err("The timer duration must be at least one second.".to_string());
        }
        return Ok(Some(duration_ms.min(24 * 60 * 60 * 1000)));
    }

    let total_seconds =
        duration_minutes.unwrap_or(0).saturating_mul(60) + duration_seconds.unwrap_or(0);
    if total_seconds == 0 {
        return Err("The timer duration must be at least one second.".to_string());
    }

    Ok(Some(total_seconds.saturating_mul(1000)))
}

fn resolve_timer_from_args(
    args: &Value,
    app: &AppHandle,
) -> Result<Option<crate::voice_timers::VoiceTimer>, String> {
    let state = app.state::<VoiceTimerState>();
    match state.resolve_timer(
        args.get("timerId").and_then(Value::as_str),
        args.get("query").and_then(Value::as_str),
    ) {
        TimerResolveResult::Matched(timer) => Ok(Some(timer)),
        TimerResolveResult::NoTimers
        | TimerResolveResult::NotFound(_)
        | TimerResolveResult::Ambiguous(_, _) => Ok(None),
    }
}

fn resolve_completed_timer_for_dismissal(
    args: &Value,
    app: &AppHandle,
) -> CompletedTimerDismissResolution {
    let has_explicit_reference = args
        .get("timerId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
        || args
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
    if has_explicit_reference {
        return CompletedTimerDismissResolution::None;
    }

    let state = app.state::<VoiceTimerState>();
    let completed = state
        .list_timers()
        .into_iter()
        .filter(|timer| timer.status == "completed")
        .collect::<Vec<_>>();
    match completed.len() {
        0 => CompletedTimerDismissResolution::None,
        1 => CompletedTimerDismissResolution::Matched(completed[0].clone()),
        _ => CompletedTimerDismissResolution::Clarify(json!({
            "ok": false,
            "status": "needs_clarification",
            "reason": "completed_timer_ambiguous",
            "message": "More than one finished timer is waiting to be dismissed.",
            "question": "Which finished timer should I dismiss?",
            "candidates": timer_candidates_to_json(&completed),
        })),
    }
}

fn timer_resolution_payload(args: &Value, app: &AppHandle) -> Value {
    let state = app.state::<VoiceTimerState>();
    match state.resolve_timer(
        args.get("timerId").and_then(Value::as_str),
        args.get("query").and_then(Value::as_str),
    ) {
        TimerResolveResult::Matched(timer) => json!({
            "ok": true,
            "timer": timer_to_json(&timer),
        }),
        TimerResolveResult::NoTimers => json!({
            "ok": false,
            "status": "needs_clarification",
            "reason": "no_timers",
            "message": "There are no timers yet.",
            "question": "Should I create a new timer first?"
        }),
        TimerResolveResult::NotFound(message) => json!({
            "ok": false,
            "status": "needs_clarification",
            "reason": "timer_not_found",
            "message": message,
            "question": "Which timer should I use?"
        }),
        TimerResolveResult::Ambiguous(message, candidates) => json!({
            "ok": false,
            "status": "needs_clarification",
            "reason": "timer_ambiguous",
            "message": message,
            "question": "Which timer should I use?",
            "candidates": timer_candidates_to_json(&candidates),
        }),
    }
}

fn search_paths_tool(args: &Value) -> Result<Value, String> {
    let query = value_to_string(args.get("query")).trim().to_string();
    if query.len() < 2 {
        return Ok(json!({
            "ok": false,
            "reason": "query_too_short",
            "message": "Please search for at least two characters."
        }));
    }

    let base_path = args.get("basePath").and_then(Value::as_str);
    let limit = normalize_search_limit(args.get("limit").and_then(Value::as_u64), 8, 15);
    let (results, searched_roots, truncated) = search_paths(&query, base_path, limit, 2500)?;

    Ok(json!({
        "ok": true,
        "query": query,
        "basePath": normalize_search_base(base_path).map(|path| path.to_string_lossy().to_string()),
        "results": results.iter().map(search_item_to_json).collect::<Vec<_>>(),
        "searchedRoots": searched_roots,
        "truncated": truncated,
    }))
}

fn stat_path_tool(args: &Value) -> Result<Value, String> {
    let path = resolve_existing_local_path(&value_to_string(args.get("path")))?;
    let metadata = fs::metadata(&path).map_err(|error| {
        format!("Failed to read metadata for {}: {error}", path.to_string_lossy())
    })?;
    let file_type = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_secs());

    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "exists": true,
        "fileType": file_type,
        "isFile": metadata.is_file(),
        "isDirectory": metadata.is_dir(),
        "sizeBytes": metadata.len(),
        "extension": path.extension().and_then(|value| value.to_str()).unwrap_or(""),
        "modifiedUnixSeconds": modified,
        "readOnly": metadata.permissions().readonly(),
    }))
}

fn open_target_tool(args: &Value) -> Result<Value, String> {
    let target = value_to_string(args.get("target"));
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "open_target is missing a target.",
            "question": "Which exact path, folder, or URL should I open?"
        }));
    }

    if is_probable_url(trimmed) {
        let script = format!("Start-Process '{}'", escape_powershell_literal(trimmed));
        let output = run_powershell_output(&script)?;
        return Ok(json!({
            "ok": output.success,
            "path": trimmed,
            "kind": "url",
            "message": if output.success {
                format!("Opened: {trimmed}")
            } else {
                combined_output(&output)
            },
        }));
    }

    open_path(trimmed)
}

fn read_path_tool(args: &Value) -> Result<Value, String> {
    let path = resolve_existing_local_path(&value_to_string(args.get("path")))?;
    let metadata = fs::metadata(&path).map_err(|error| {
        format!("Failed to read metadata for {}: {error}", path.to_string_lossy())
    })?;
    if metadata.is_dir() {
        return Ok(json!({
            "ok": false,
            "reason": "is_directory",
            "message": "The given path is a directory. Use stat_path or search_paths for directories."
        }));
    }

    let max_bytes = args
        .get("maxBytes")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(50_000)
        .clamp(256, 200_000);

    if is_docx_path(&path) {
        let text = read_docx_text(&path)?;
        let truncated = text.len() > max_bytes;
        let content = if truncated { truncate_string(&text, max_bytes) } else { text };
        return Ok(json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "fileType": "docx",
            "content": content,
            "truncated": truncated,
            "message": format!("Read file: {}", path.to_string_lossy()),
        }));
    }

    if !is_text_like_path(&path) {
        return Ok(json!({
            "ok": false,
            "reason": "unsupported_format",
            "message": "This file type is not supported for direct reading by the voice agent. Delegate complex formats to a specialist.",
            "path": path.to_string_lossy(),
        }));
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read file {}: {error}", path.to_string_lossy()))?;
    let truncated = content.len() > max_bytes;
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "fileType": "text",
        "content": if truncated { truncate_string(&content, max_bytes) } else { content },
        "truncated": truncated,
        "message": format!("Read file: {}", path.to_string_lossy()),
    }))
}

fn write_path_tool(args: &Value) -> Result<Value, String> {
    let path = resolve_local_path(&value_to_string(args.get("path")))?;
    let content = value_to_string(args.get("content"));
    let overwrite = args.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
    let create_parents = args.get("createParents").and_then(Value::as_bool).unwrap_or(true);

    if path.exists() && !overwrite {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": format!("The file {} already exists.", path.to_string_lossy()),
            "question": "Should I overwrite the existing file?"
        }));
    }

    if let Some(parent) = path.parent() {
        if create_parents {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Failed to create directory {}: {error}", parent.to_string_lossy())
            })?;
        } else if !parent.exists() {
            return Ok(json!({
                "ok": false,
                "status": "needs_clarification",
                "message": format!("The target directory {} does not exist.", parent.to_string_lossy()),
                "question": "Should I create the missing directories?"
            }));
        }
    }

    if is_docx_path(&path) {
        let result = create_word_document(&path, &content)?;
        return Ok(result);
    }

    if !is_text_like_path(&path) {
        return Ok(json!({
            "ok": false,
            "reason": "unsupported_format",
            "message": "This file type is not supported for direct writing by the voice agent. Delegate complex formats to a specialist.",
            "path": path.to_string_lossy(),
        }));
    }

    fs::write(&path, content.as_bytes())
        .map_err(|error| format!("Failed to write file {}: {error}", path.to_string_lossy()))?;

    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "bytesWritten": content.len(),
        "message": format!("Wrote file: {}", path.to_string_lossy()),
    }))
}

fn move_path_tool(args: &Value) -> Result<Value, String> {
    let source = resolve_existing_local_path(&value_to_string(args.get("sourcePath")))?;
    let destination = resolve_local_path(&value_to_string(args.get("destinationPath")))?;
    let replace_existing = args.get("replaceExisting").and_then(Value::as_bool).unwrap_or(false);

    if destination.exists() && !replace_existing {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": format!("The destination {} already exists.", destination.to_string_lossy()),
            "question": "Should I replace the destination?"
        }));
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create destination directory {}: {error}", parent.to_string_lossy())
        })?;
    }

    if destination.exists() {
        remove_path(&destination, true)?;
    }

    fs::rename(&source, &destination).map_err(|error| {
        format!(
            "Failed to move {} to {}: {error}",
            source.to_string_lossy(),
            destination.to_string_lossy()
        )
    })?;

    Ok(json!({
        "ok": true,
        "sourcePath": source.to_string_lossy(),
        "destinationPath": destination.to_string_lossy(),
        "message": format!("Moved: {} -> {}", source.to_string_lossy(), destination.to_string_lossy()),
    }))
}

fn copy_path_tool(args: &Value) -> Result<Value, String> {
    let source = resolve_existing_local_path(&value_to_string(args.get("sourcePath")))?;
    let destination = resolve_local_path(&value_to_string(args.get("destinationPath")))?;
    let replace_existing = args.get("replaceExisting").and_then(Value::as_bool).unwrap_or(false);
    let recursive = args.get("recursive").and_then(Value::as_bool).unwrap_or(false);
    let source_metadata = fs::metadata(&source).map_err(|error| {
        format!("Failed to read metadata for {}: {error}", source.to_string_lossy())
    })?;

    if destination.exists() && !replace_existing {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": format!("The destination {} already exists.", destination.to_string_lossy()),
            "question": "Should I replace the destination?"
        }));
    }

    if destination.exists() {
        remove_path(&destination, true)?;
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create destination directory {}: {error}", parent.to_string_lossy())
        })?;
    }

    if source_metadata.is_dir() {
        if !recursive {
            return Ok(json!({
                "ok": false,
                "status": "needs_clarification",
                "message": format!("{} is a directory.", source.to_string_lossy()),
                "question": "Should I copy the directory recursively? If yes, set recursive=true."
            }));
        }
        copy_directory_recursive(&source, &destination)?;
    } else {
        fs::copy(&source, &destination).map_err(|error| {
            format!(
                "Failed to copy {} to {}: {error}",
                source.to_string_lossy(),
                destination.to_string_lossy()
            )
        })?;
    }

    Ok(json!({
        "ok": true,
        "sourcePath": source.to_string_lossy(),
        "destinationPath": destination.to_string_lossy(),
        "message": format!("Copied: {} -> {}", source.to_string_lossy(), destination.to_string_lossy()),
    }))
}

fn delete_path_tool(args: &Value) -> Result<Value, String> {
    let path = resolve_existing_local_path(&value_to_string(args.get("path")))?;
    let recursive = args.get("recursive").and_then(Value::as_bool).unwrap_or(false);
    ensure_safe_delete_target(&path)?;
    remove_path(&path, recursive)?;
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "message": format!("Deleted: {}", path.to_string_lossy()),
    }))
}

fn list_processes_tool(args: &Value) -> Result<Value, String> {
    let query = value_to_string(args.get("query")).trim().to_string();
    let limit = normalize_search_limit(args.get("limit").and_then(Value::as_u64), 12, 50);
    let script = format!(
        "$items = Get-Process | Select-Object Id, ProcessName, MainWindowTitle, Path; \
if ('{query}' -ne '') {{ $items = $items | Where-Object {{ $_.ProcessName -like '*{query}*' -or $_.MainWindowTitle -like '*{query}*' -or $_.Path -like '*{query}*' }} }}; \
$items | Select-Object -First {limit} | ConvertTo-Json -Compress",
        query = escape_powershell_literal(&query),
        limit = limit
    );
    let output = run_powershell_output(&script)?;
    if !output.success {
        return Err(combined_output(&output));
    }
    let payload = extract_json_value(&format!("{}\n{}", output.stdout, output.stderr))?;
    let processes = if payload.is_array() { payload } else { Value::Array(vec![payload]) };
    Ok(json!({
        "ok": true,
        "query": query,
        "processes": processes,
    }))
}

fn start_process_tool(args: &Value) -> Result<Value, String> {
    let target = value_to_string(args.get("target"));
    let trimmed_target = target.trim();
    if trimmed_target.is_empty() {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "start_process is missing a target.",
            "question": "Which program or command should I start?"
        }));
    }

    let working_directory = value_to_string(args.get("workingDirectory"));
    let arguments = args
        .get("arguments")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| format!("'{}'", escape_powershell_literal(item)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let target_path = PathBuf::from(trimmed_target);
    let resolved_target = if target_path.is_absolute() || target_path.components().count() > 1 {
        resolve_local_path(trimmed_target)?.to_string_lossy().to_string()
    } else {
        trimmed_target.to_string()
    };
    let working_directory_script = if working_directory.trim().is_empty() {
        String::new()
    } else {
        let resolved = resolve_local_path(&working_directory)?.to_string_lossy().to_string();
        format!(" -WorkingDirectory '{}'", escape_powershell_literal(&resolved))
    };
    let arguments_script = if arguments.is_empty() {
        String::new()
    } else {
        format!(" -ArgumentList @({})", arguments.join(", "))
    };
    let script = format!(
        "Start-Process -FilePath '{}'{}{}",
        escape_powershell_literal(&resolved_target),
        arguments_script,
        working_directory_script
    );
    let output = run_powershell_output(&script)?;
    Ok(json!({
        "ok": output.success,
        "target": resolved_target,
        "arguments": args.get("arguments").cloned().unwrap_or(Value::Array(Vec::new())),
        "message": if output.success {
            format!("Started process: {}", trimmed_target)
        } else {
            combined_output(&output)
        },
    }))
}

fn stop_process_tool(args: &Value) -> Result<Value, String> {
    let pid = args.get("pid").and_then(Value::as_u64);
    let name = value_to_string(args.get("name"));
    if pid.is_none() && name.trim().is_empty() {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "stop_process requires either pid or name.",
            "question": "Which process should I stop?"
        }));
    }

    let force = args.get("force").and_then(Value::as_bool).unwrap_or(true);
    let script = if let Some(pid) = pid {
        format!("Stop-Process -Id {}{} -ErrorAction Stop", pid, if force { " -Force" } else { "" })
    } else {
        format!(
            "Stop-Process -Name '{}'{} -ErrorAction Stop",
            escape_powershell_literal(name.trim()),
            if force { " -Force" } else { "" }
        )
    };
    let output = run_powershell_output(&script)?;
    Ok(json!({
        "ok": output.success,
        "pid": pid,
        "name": if name.trim().is_empty() { Value::Null } else { Value::String(name.trim().to_string()) },
        "message": if output.success {
            "Process stopped.".to_string()
        } else {
            combined_output(&output)
        },
    }))
}

fn deactivate_voice_assistant_tool(args: &Value) -> Result<Value, String> {
    Ok(json!({
        "ok": true,
        "action": "deactivate_voice_assistant",
        "reason": value_to_string(args.get("reason")),
        "farewell": value_to_string(args.get("farewell")),
        "message": "Voice assistant will return to the online_muted state.",
    }))
}

struct SpecialistDefinition {
    id: &'static str,
    openclaw_agent_id: &'static str,
    name: &'static str,
    theme: &'static str,
    description: &'static str,
    when_to_use: &'static str,
    default_thinking_level: &'static str,
    default_timeout_seconds: u64,
    default_prefer_mode: &'static str,
    keywords: &'static [&'static str],
}

const SPECIALISTS: &[SpecialistDefinition] = &[
    SpecialistDefinition {
        id: "pc-ops",
        openclaw_agent_id: "voice-overlay-pc-ops",
        name: "PC Ops",
        theme: "desktop-automation",
        description: "Specialist for desktop, file, Office, and general local machine tasks.",
        when_to_use: "App launches, files, folders, documents, Explorer, Word, Downloads, and local automation tasks.",
        default_thinking_level: "medium",
        default_timeout_seconds: 180,
        default_prefer_mode: "local",
        keywords: &[
            "app", "application", "browser", "desktop", "directory", "document", "download", "drive", "explorer", "excel", "file", "folder", "notepad",
            "office", "folder", "path", "pdf", "powerpoint", "save", "saved", "word", "open", "opened", "pc",
        ],
    },
    SpecialistDefinition {
        id: "coder",
        openclaw_agent_id: "voice-overlay-coder",
        name: "Coder",
        theme: "software-engineering",
        description: "Specialist for coding, debugging, scripts, repository changes, tests, and implementation work.",
        when_to_use: "Writing code, fixing bugs, changing files, running tests, refactors, scripts, and technical analysis.",
        default_thinking_level: "high",
        default_timeout_seconds: 240,
        default_prefer_mode: "local",
        keywords: &[
            "api", "app.js", "bug", "build", "code", "coder", "coding", "commit", "debug", "deploy", "feature", "fix", "implement", "node", "npm", "package",
            "patch", "pr", "program", "refactor", "repo", "script", "server", "src", "test", "typescript",
        ],
    },
];

struct SpecialistRoute<'a> {
    specialist: &'a SpecialistDefinition,
    confidence: &'static str,
    reason: String,
    scores: Value,
}

fn update_assistant_state_tool(args: &Value, settings: &SettingsState) -> Result<Value, String> {
    let mut next = settings.get();
    let requested_name = value_to_string(args.get("name"));
    let requested_voice = value_to_string(args.get("voice"));

    if !value_to_string(args.get("model")).trim().is_empty() {
        next.voice_agent_model = value_to_string(args.get("model"));
    }
    if !requested_voice.trim().is_empty() {
        next.voice_agent_voice = requested_voice.clone();
    }
    if !value_to_string(args.get("personality")).trim().is_empty() {
        next.voice_agent_personality = value_to_string(args.get("personality"));
    }
    if !value_to_string(args.get("behavior")).trim().is_empty() {
        next.voice_agent_behavior = value_to_string(args.get("behavior"));
    }
    if !value_to_string(args.get("extraInstructions")).trim().is_empty() {
        next.voice_agent_extra_instructions = value_to_string(args.get("extraInstructions"));
    }
    if !value_to_string(args.get("preferredLanguage")).trim().is_empty() {
        next.voice_agent_preferred_language = value_to_string(args.get("preferredLanguage"));
    }
    if !value_to_string(args.get("gender")).trim().is_empty() {
        next.voice_agent_gender = value_to_string(args.get("gender"));
    }
    if !value_to_string(args.get("toneNotes")).trim().is_empty() {
        next.voice_agent_tone_notes = value_to_string(args.get("toneNotes"));
    }
    if let Some(onboarding_complete) = args.get("onboardingComplete").and_then(Value::as_bool) {
        next.voice_agent_onboarding_complete = onboarding_complete;
    }

    let saved = settings.update(next)?;
    let state = build_voice_agent_state(&saved);
    let mut message = if requested_name.trim().is_empty() {
        "Die persistente Voice-Agent-Konfiguration wurde gespeichert.".to_string()
    } else {
        format!(
            "Die persistente Voice-Agent-Konfiguration wurde gespeichert. Der Name bleibt auf {} fixiert, weil er von der Wake-Word-Konfiguration kommt.",
            saved.assistant_name
        )
    };
    if !requested_voice.trim().is_empty()
        && requested_voice.trim().to_lowercase() != saved.voice_agent_voice
    {
        message.push_str(&format!(
            " Fuer die Realtime-Stimme wurde {} verwendet.",
            saved.voice_agent_voice
        ));
    }

    Ok(json!({
        "ok": true,
        "message": message,
        "state": state,
        "sessionUpdate": {
            "voice": state.profile.voice,
            "instructions": build_assistant_instructions(&saved),
        }
    }))
}

fn get_openclaw_status_tool() -> Result<Value, String> {
    let command_check =
        run_powershell_output("$cmd = Get-Command openclaw -ErrorAction Stop; $cmd.Source")?;
    if !command_check.success {
        return Ok(json!({
            "installed": false,
            "availableMode": "none",
            "gatewayAvailable": false,
            "gatewayServiceAvailable": false,
            "gatewayRpcAvailable": false,
        }));
    }

    let command_path = command_check.stdout.trim().to_string();
    if let Some(payload) = inspect_openclaw_gateway_status()? {
        let gateway_rpc_available = payload
            .get("rpc")
            .and_then(Value::as_object)
            .and_then(|rpc| rpc.get("ok"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let gateway_service_available =
            payload.get("serviceReachable").and_then(Value::as_bool).unwrap_or(false);
        Ok(json!({
            "installed": true,
            "commandPath": command_path,
            "availableMode": if gateway_rpc_available { "gateway" } else { "local" },
            "gatewayAvailable": gateway_rpc_available,
            "gatewayServiceAvailable": gateway_service_available,
            "gatewayRpcAvailable": gateway_rpc_available,
            "gatewayStatus": payload,
        }))
    } else {
        Ok(json!({
            "installed": true,
            "commandPath": command_path,
            "availableMode": "local",
            "gatewayAvailable": false,
            "gatewayServiceAvailable": false,
            "gatewayRpcAvailable": false,
            "gatewayStatus": Value::Null,
        }))
    }
}

fn get_specialist_agents_tool() -> Result<Value, String> {
    let existing_agents = list_openclaw_agents().unwrap_or_default();

    Ok(json!({
        "ok": true,
        "specialists": SPECIALISTS.iter().map(|definition| {
            let existing = existing_agents.iter().find(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .map(|value| value == definition.openclaw_agent_id)
                    .unwrap_or(false)
            });
            json!({
                "id": definition.id,
                "openClawAgentId": definition.openclaw_agent_id,
                "name": definition.name,
                "description": definition.description,
                "whenToUse": definition.when_to_use,
                "installed": existing.is_some(),
                "workspacePath": specialist_workspace_path(definition.id).to_string_lossy(),
                "openClawAgent": existing.cloned().unwrap_or(Value::Null),
            })
        }).collect::<Vec<_>>()
    }))
}

fn delegate_to_openclaw_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let task = value_to_string(args.get("task")).trim().to_string();
    if task.is_empty() {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "The OpenClaw bridge is missing a task description.",
            "question": "Which exact task should be delegated to OpenClaw?"
        }));
    }

    let agent_id = {
        let value = value_to_string(args.get("agentId"));
        if value.trim().is_empty() {
            "main".to_string()
        } else {
            value
        }
    };
    let payload = json!({
        "task": task,
        "thinkingLevel": value_to_string(args.get("thinkingLevel")),
        "preferMode": value_to_string(args.get("preferMode")),
        "timeoutSeconds": args.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(180),
        "agentId": agent_id,
    });
    let task_record =
        app.state::<VoiceTaskState>().create_task("openclaw_delegate", payload.clone());
    app.state::<VoiceTaskState>().emit_task(app, &task_record);

    let app_handle = app.clone();
    let task_id = task_record.id.clone();
    thread::spawn(move || {
        run_openclaw_background_task(&app_handle, &task_id, payload);
    });

    Ok(json!({
        "ok": true,
        "status": "queued",
        "taskId": task_record.id,
        "etaSeconds": 45,
        "message": "The task was delegated to OpenClaw. I will report back as soon as the PC agent has a result."
    }))
}

fn delegate_to_specialist_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let task = value_to_string(args.get("task")).trim().to_string();
    if task.is_empty() {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "The delegation request is missing a task description.",
            "question": "Which exact task should be delegated?"
        }));
    }

    let route = resolve_specialist_route(
        &task,
        args.get("specialist").and_then(Value::as_str).unwrap_or("auto"),
    );

    let Some(route) = route else {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "The requested specialist agent is unknown.",
            "question": "Should I delegate the task to pc-ops or coder?"
        }));
    };

    let forwarded_task = build_specialist_task_payload(
        route.specialist.id,
        &task,
        &route.reason,
        args.get("context").and_then(Value::as_str).unwrap_or(""),
    );
    let thinking_level = {
        let value = value_to_string(args.get("thinkingLevel"));
        if value.trim().is_empty() {
            route.specialist.default_thinking_level.to_string()
        } else {
            value
        }
    };
    let prefer_mode = {
        let value = value_to_string(args.get("preferMode"));
        if value.trim().is_empty() {
            route.specialist.default_prefer_mode.to_string()
        } else {
            value
        }
    };
    let payload = json!({
        "originalTask": task,
        "specialistId": route.specialist.id,
        "routingConfidence": route.confidence,
        "routingReason": route.reason,
        "scores": route.scores,
        "forwardedTask": forwarded_task,
        "thinkingLevel": thinking_level,
        "preferMode": prefer_mode,
        "timeoutSeconds": args.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(route.specialist.default_timeout_seconds),
    });
    let task_record =
        app.state::<VoiceTaskState>().create_task("specialist_delegate", payload.clone());
    app.state::<VoiceTaskState>().emit_task(app, &task_record);

    let app_handle = app.clone();
    let task_id = task_record.id.clone();
    thread::spawn(move || {
        run_specialist_delegation_task(&app_handle, &task_id, payload);
    });

    Ok(json!({
        "ok": true,
        "status": "queued",
        "taskId": task_record.id,
        "etaSeconds": if route.specialist.id == "coder" { 60 } else { 30 },
        "specialistId": route.specialist.id,
        "routingConfidence": route.confidence,
        "routingReason": route.reason,
        "message": format!("The task was delegated to specialist {}. I will report back as soon as a result is available.", route.specialist.id),
    }))
}

fn recall_memory_tool(args: &Value) -> Result<Value, String> {
    let query = value_to_string(args.get("query")).trim().to_string();
    if query.is_empty() {
        return Ok(json!({
            "ok": false,
            "reason": "missing_query",
            "message": "No memory query was provided."
        }));
    }

    let date = args
        .get("date")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let limit = args.get("limit").and_then(Value::as_u64).map(|value| value as usize);
    let days_back_limit = args
        .get("daysBackLimit")
        .and_then(Value::as_i64)
        .or_else(|| args.get("daysBackLimit").and_then(Value::as_u64).map(|value| value as i64));

    let result = recall_voice_memory(&RecallVoiceMemoryRequest {
        query: query.clone(),
        date,
        limit,
        days_back_limit,
    })?;

    Ok(json!({
        "ok": true,
        "query": query,
        "message": if result.matches.is_empty() {
            "No matching memory entries were found.".to_string()
        } else {
            format!("Found {} matching memory entries.", result.matches.len())
        },
        "matches": result.matches,
        "searchedFiles": result.searched_files,
    }))
}

fn run_openclaw_background_task(app: &AppHandle, task_id: &str, payload: Value) {
    let tasks = app.state::<VoiceTaskState>();
    let _ = tasks.update_task(app, task_id, "running", None);
    match run_openclaw_task(
        payload.get("task").and_then(Value::as_str).unwrap_or(""),
        payload.get("thinkingLevel").and_then(Value::as_str).unwrap_or(""),
        payload.get("preferMode").and_then(Value::as_str).unwrap_or(""),
        payload.get("timeoutSeconds").and_then(Value::as_u64),
        payload.get("agentId").and_then(Value::as_str).unwrap_or("main"),
    ) {
        Ok(result) => {
            let status = if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                "completed"
            } else {
                "failed"
            };
            let _ = tasks.update_task(app, task_id, status, Some(result));
        }
        Err(error) => {
            let _ = tasks.update_task(
                app,
                task_id,
                "failed",
                Some(json!({ "ok": false, "message": error })),
            );
        }
    }
}

fn run_specialist_delegation_task(app: &AppHandle, task_id: &str, payload: Value) {
    let tasks = app.state::<VoiceTaskState>();
    let _ = tasks.update_task(app, task_id, "running", None);

    let specialist_id = payload.get("specialistId").and_then(Value::as_str).unwrap_or("pc-ops");
    let openclaw_agent_id = SPECIALISTS
        .iter()
        .find(|item| item.id == specialist_id)
        .map(|item| item.openclaw_agent_id)
        .unwrap_or(specialist_id);
    let specialist_setup = match ensure_specialist_agent(specialist_id) {
        Ok(setup) => setup,
        Err(error) => {
            let _ = tasks.update_task(
                app,
                task_id,
                "failed",
                Some(json!({
                    "ok": false,
                    "specialistId": specialist_id,
                    "reason": "specialist_setup_failed",
                    "message": error,
                })),
            );
            return;
        }
    };

    match run_openclaw_task(
        payload.get("forwardedTask").and_then(Value::as_str).unwrap_or(""),
        payload.get("thinkingLevel").and_then(Value::as_str).unwrap_or(""),
        payload.get("preferMode").and_then(Value::as_str).unwrap_or(""),
        payload.get("timeoutSeconds").and_then(Value::as_u64),
        openclaw_agent_id,
    ) {
        Ok(result) if result.get("ok").and_then(Value::as_bool).unwrap_or(false) => {
            let _ = tasks.update_task(
                app,
                task_id,
                "completed",
                Some(json!({
                    "ok": true,
                    "specialistId": specialist_id,
                    "openClawAgentId": openclaw_agent_id,
                    "routingReason": payload.get("routingReason").cloned().unwrap_or(Value::Null),
                    "specialistProvisioned": specialist_setup,
                    "result": result,
                })),
            );
        }
        Ok(result) => {
            let _ = tasks.update_task(
                app,
                task_id,
                "failed",
                Some(json!({
                    "specialistId": specialist_id,
                    "openClawAgentId": openclaw_agent_id,
                    "specialistProvisioned": specialist_setup,
                    "result": result,
                })),
            );
        }
        Err(error) => {
            let _ = tasks.update_task(
                app,
                task_id,
                "failed",
                Some(json!({
                    "ok": false,
                    "specialistId": specialist_id,
                    "openClawAgentId": openclaw_agent_id,
                    "reason": "specialist_delegate_failed",
                    "message": error,
                    "specialistProvisioned": specialist_setup,
                })),
            );
        }
    }
}

fn normalize_search_limit(limit: Option<u64>, fallback: usize, max: usize) -> usize {
    limit
        .map(|value| value as usize)
        .filter(|value| *value > 0)
        .map(|value| value.min(max))
        .unwrap_or(fallback)
}

fn normalize_search_base(base_path: Option<&str>) -> Option<PathBuf> {
    let raw = base_path?.trim();
    if raw.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        Some(candidate)
    } else {
        env::current_dir().ok().map(|cwd| cwd.join(candidate))
    }
}

fn resolve_search_roots(base_path: Option<&str>) -> Vec<PathBuf> {
    if let Some(path) = normalize_search_base(base_path) {
        if path.exists() {
            return vec![path];
        }
        return Vec::new();
    }

    common_location_paths()
}

fn search_paths(
    query: &str,
    base_path: Option<&str>,
    limit: usize,
    max_directories: usize,
) -> Result<(Vec<SearchPathItem>, Vec<String>, bool), String> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Ok((Vec::new(), Vec::new(), false));
    }

    let roots = resolve_search_roots(base_path);
    let searched_roots =
        roots.iter().map(|path| path.to_string_lossy().to_string()).collect::<Vec<_>>();
    let mut queue = VecDeque::from(roots);
    let mut visited = HashSet::new();
    let mut results = Vec::new();
    let mut directories_visited = 0usize;

    while let Some(current) = queue.pop_front() {
        if directories_visited >= max_directories || results.len() >= limit {
            break;
        }
        let current_key = current.to_string_lossy().to_string();
        if visited.contains(&current_key) {
            continue;
        }
        visited.insert(current_key);
        directories_visited += 1;

        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let lower_name = file_name.to_lowercase();
            let full_path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };

            if lower_name.contains(&normalized_query) {
                results.push(SearchPathItem {
                    path: full_path.to_string_lossy().to_string(),
                    kind: if metadata.is_dir() { "directory" } else { "file" },
                    name: file_name.clone(),
                });
                if results.len() >= limit {
                    break;
                }
            }

            if metadata.is_dir() {
                queue.push_back(full_path);
            }
        }
    }

    Ok((results, searched_roots, !queue.is_empty() || directories_visited >= max_directories))
}

fn resolve_local_path(raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Missing path.".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        Ok(candidate)
    } else {
        let cwd = env::current_dir()
            .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
        Ok(cwd.join(candidate))
    }
}

fn resolve_existing_local_path(raw_path: &str) -> Result<PathBuf, String> {
    let path = resolve_local_path(raw_path)?;
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.to_string_lossy()));
    }
    Ok(path)
}

fn is_probable_url(value: &str) -> bool {
    let lower = value.trim().to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn is_docx_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("docx"))
        .unwrap_or(false)
}

fn is_text_like_path(path: &Path) -> bool {
    match path.extension().and_then(|value| value.to_str()).map(|value| value.to_lowercase()) {
        None => true,
        Some(extension) => matches!(
            extension.as_str(),
            "txt"
                | "md"
                | "json"
                | "yaml"
                | "yml"
                | "toml"
                | "ini"
                | "log"
                | "csv"
                | "html"
                | "css"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "rs"
                | "py"
                | "xml"
                | "sql"
                | "env"
        ),
    }
}

fn truncate_string(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    format!("{}...", &value[..end])
}

fn read_docx_text(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.to_string_lossy()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        format!("Failed to read docx archive {}: {error}", path.to_string_lossy())
    })?;
    let mut document_xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|error| {
            format!("word/document.xml missing in {}: {error}", path.to_string_lossy())
        })?
        .read_to_string(&mut document_xml)
        .map_err(|error| {
            format!("Failed to read document.xml in {}: {error}", path.to_string_lossy())
        })?;

    let text =
        document_xml.replace("</w:p>", "\n").replace("</w:tr>", "\n").replace("<w:tab/>", "\t");
    let stripped = strip_xml_tags(&text);
    Ok(html_entity_decode(&stripped).trim().to_string())
}

fn strip_xml_tags(value: &str) -> String {
    let mut output = String::new();
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(character),
            _ => {}
        }
    }
    output
}

fn html_entity_decode(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!("Failed to create directory {}: {error}", destination.to_string_lossy())
    })?;

    for entry in fs::read_dir(source).map_err(|error| {
        format!("Failed to read directory {}: {error}", source.to_string_lossy())
    })? {
        let entry = entry.map_err(|error| {
            format!("Failed to inspect entry in {}: {error}", source.to_string_lossy())
        })?;
        let path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = entry.metadata().map_err(|error| {
            format!("Failed to read metadata for {}: {error}", path.to_string_lossy())
        })?;
        if metadata.is_dir() {
            copy_directory_recursive(&path, &destination_path)?;
        } else {
            fs::copy(&path, &destination_path).map_err(|error| {
                format!(
                    "Failed to copy {} to {}: {error}",
                    path.to_string_lossy(),
                    destination_path.to_string_lossy()
                )
            })?;
        }
    }

    Ok(())
}

fn remove_path(path: &Path, recursive: bool) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!("Failed to read metadata for {}: {error}", path.to_string_lossy())
    })?;
    if metadata.is_dir() {
        if recursive {
            fs::remove_dir_all(path).map_err(|error| {
                format!("Failed to remove directory {}: {error}", path.to_string_lossy())
            })
        } else {
            fs::remove_dir(path).map_err(|error| {
                format!("Failed to remove directory {}: {error}", path.to_string_lossy())
            })
        }
    } else {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to remove file {}: {error}", path.to_string_lossy()))
    }
}

fn ensure_safe_delete_target(path: &Path) -> Result<(), String> {
    let normalized = normalize_path_for_compare(&path.to_string_lossy());
    let protected = [
        normalize_path_for_compare("C:\\"),
        normalize_path_for_compare(&home_dir().to_string_lossy()),
        normalize_path_for_compare(&home_dir().join("Desktop").to_string_lossy()),
        normalize_path_for_compare(&home_dir().join("Documents").to_string_lossy()),
        normalize_path_for_compare(&home_dir().join("Downloads").to_string_lossy()),
        normalize_path_for_compare(&project_root().to_string_lossy()),
    ];
    if protected.iter().any(|item| item == &normalized) {
        return Err(format!(
            "Refusing to delete protected root path {}. Delegate dangerous delete operations to a specialist.",
            path.to_string_lossy()
        ));
    }
    Ok(())
}

fn create_word_document(path: &Path, content: &str) -> Result<Value, String> {
    let parent = path.parent().ok_or_else(|| {
        format!("Target file has no parent directory: {}", path.to_string_lossy())
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!("Failed to create directory {}: {error}", parent.to_string_lossy())
    })?;

    let file = fs::File::create(path).map_err(|error| {
        format!("Failed to create Word file {}: {error}", path.to_string_lossy())
    })?;
    let mut archive = zip::ZipWriter::new(file);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);

    archive.start_file("[Content_Types].xml", options).map_err(|error| {
        format!("Failed to start [Content_Types].xml in {}: {error}", path.to_string_lossy())
    })?;
    archive.write_all(docx_content_types_xml().as_bytes()).map_err(|error| {
        format!("Failed to write [Content_Types].xml in {}: {error}", path.to_string_lossy())
    })?;

    archive.start_file("_rels/.rels", options).map_err(|error| {
        format!("Failed to start _rels/.rels in {}: {error}", path.to_string_lossy())
    })?;
    archive.write_all(docx_relationships_xml().as_bytes()).map_err(|error| {
        format!("Failed to write _rels/.rels in {}: {error}", path.to_string_lossy())
    })?;

    archive.start_file("word/document.xml", options).map_err(|error| {
        format!("Failed to start word/document.xml in {}: {error}", path.to_string_lossy())
    })?;
    archive.write_all(build_docx_document_xml(content).as_bytes()).map_err(|error| {
        format!("Failed to write word/document.xml in {}: {error}", path.to_string_lossy())
    })?;

    archive.finish().map_err(|error| {
        format!("Failed to finalize Word file {}: {error}", path.to_string_lossy())
    })?;

    Ok(json!({
        "ok": true,
        "action": "write_path",
        "path": path.to_string_lossy(),
        "fileType": "docx",
        "bytesWritten": content.len(),
        "message": format!("Created Word document: {}", path.to_string_lossy()),
    }))
}

fn docx_content_types_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#
}

fn docx_relationships_xml() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#
}

fn build_docx_document_xml(content: &str) -> String {
    let paragraphs = if content.is_empty() {
        vec!["<w:p/>".to_string()]
    } else {
        content
            .replace("\r\n", "\n")
            .split('\n')
            .map(|line| {
                format!(
                    "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    escape_xml_text(line)
                )
            })
            .collect::<Vec<_>>()
    };

    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:body>{}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr></w:body>\
</w:document>",
        paragraphs.join("")
    )
}

fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&apos;")
}

fn open_path(raw_path: &str) -> Result<Value, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Ok(json!({
            "ok": false,
            "reason": "missing_path",
            "message": "No path was provided for opening."
        }));
    }

    let target_path = PathBuf::from(trimmed);
    let resolved = if target_path.is_absolute() {
        target_path
    } else {
        env::current_dir()
            .map_err(|error| format!("Failed to resolve current directory: {error}"))?
            .join(target_path)
    };

    let metadata = match fs::metadata(&resolved) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Ok(json!({
                "ok": false,
                "reason": "not_found",
                "message": format!("Path not found: {}", resolved.to_string_lossy()),
                "path": resolved.to_string_lossy(),
            }));
        }
    };

    let script = format!(
        "Start-Process -LiteralPath '{}'",
        escape_powershell_literal(&resolved.to_string_lossy())
    );
    let output = run_powershell_output(&script)?;
    if !output.success {
        return Err(format!(
            "Failed to open path {}: {}",
            resolved.to_string_lossy(),
            combined_output(&output)
        ));
    }

    Ok(json!({
        "ok": true,
        "action": "open_target",
        "path": resolved.to_string_lossy(),
        "kind": if metadata.is_dir() { "directory" } else { "file" },
        "message": format!("Opened: {}", resolved.to_string_lossy()),
    }))
}

fn resolve_specialist_route<'a>(task: &str, specialist: &str) -> Option<SpecialistRoute<'a>> {
    let normalized_choice = specialist.trim().to_lowercase();
    if !normalized_choice.is_empty() && normalized_choice != "auto" {
        let definition = SPECIALISTS.iter().find(|item| item.id == normalized_choice)?;
        return Some(SpecialistRoute {
            specialist: definition,
            confidence: "explicit",
            reason: format!("Explicitly requested specialist agent: {}.", definition.id),
            scores: Value::Null,
        });
    }

    let haystack = task.to_lowercase();
    let mut scores = SPECIALISTS
        .iter()
        .map(|definition| {
            let score =
                definition.keywords.iter().filter(|keyword| haystack.contains(**keyword)).count()
                    as u64;
            (definition, score)
        })
        .collect::<Vec<_>>();
    scores.sort_by(|left, right| right.1.cmp(&left.1));

    let chosen = if scores.first().map(|(_, score)| *score).unwrap_or(0) > 0 {
        scores[0].0
    } else {
        SPECIALISTS.iter().find(|item| item.id == "pc-ops")?
    };

    let confidence = if scores.first().map(|(_, score)| *score).unwrap_or(0) == 0 {
        "low"
    } else if scores.len() > 1 && scores[0].1 == scores[1].1 {
        "medium"
    } else {
        "high"
    };

    Some(SpecialistRoute {
        specialist: chosen,
        confidence,
        reason: if scores.first().map(|(_, score)| *score).unwrap_or(0) > 0 {
            format!(
                "Automatically routed to {} because the task fits {}.",
                chosen.id, chosen.when_to_use
            )
        } else {
            "No clear coding signals detected. Falling back to pc-ops.".to_string()
        },
        scores: Value::Array(
            scores
                .into_iter()
                .map(|(definition, score)| {
                    json!({
                        "specialistId": definition.id,
                        "score": score,
                    })
                })
                .collect::<Vec<_>>(),
        ),
    })
}

fn build_specialist_task_payload(
    specialist_id: &str,
    task: &str,
    routing_reason: &str,
    context: &str,
) -> String {
    let definition =
        SPECIALISTS.iter().find(|item| item.id == specialist_id).expect("known specialist");
    let context_block = if context.trim().is_empty() {
        String::new()
    } else {
        format!("Additional context from the voice orchestrator:\n{}\n\n", context.trim())
    };

    [
        format!("You are the specialist agent {}.", definition.id),
        definition.description.to_string(),
        String::new(),
        format!("Routing note: {}", routing_reason),
        context_block,
        "Task:".to_string(),
        task.to_string(),
        String::new(),
        "Response contract:".to_string(),
        "- If information is missing, ask exactly one concise follow-up question.".to_string(),
        "- If you can complete the task, execute it instead of over-planning.".to_string(),
        "- End with a short summary of what you did and the result.".to_string(),
    ]
    .into_iter()
    .filter(|line| !line.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn list_openclaw_agents() -> Result<Vec<Value>, String> {
    let output = run_powershell_output("openclaw agents list --json")?;
    if !output.success {
        return Ok(Vec::new());
    }
    let payload = extract_json_value(&format!("{}\n{}", output.stdout, output.stderr))?;
    Ok(payload.as_array().cloned().unwrap_or_default())
}

fn ensure_specialist_agent(specialist_id: &str) -> Result<Value, String> {
    let definition = SPECIALISTS
        .iter()
        .find(|item| item.id == specialist_id)
        .ok_or_else(|| format!("Unknown specialist: {specialist_id}"))?;
    let workspace_path = specialist_workspace_path(definition.id);
    fs::create_dir_all(&workspace_path).map_err(|error| {
        format!("Failed to create workspace {}: {error}", workspace_path.to_string_lossy())
    })?;

    ensure_file(&workspace_path.join("IDENTITY.md"), &build_identity_content(definition))?;
    ensure_file(&workspace_path.join("SOUL.md"), &build_soul_content(definition))?;
    ensure_file(&workspace_path.join("TOOLS.md"), &build_tools_content(definition))?;

    let existing_agents = list_openclaw_agents()?;
    if let Some(existing) = existing_agents.iter().find(|agent| {
        agent
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value == definition.openclaw_agent_id)
            .unwrap_or(false)
    }) {
        let existing_workspace =
            existing.get("workspace").and_then(Value::as_str).unwrap_or_default();
        let expected_workspace = workspace_path.to_string_lossy().to_string();
        if normalize_path_for_compare(existing_workspace)
            != normalize_path_for_compare(&expected_workspace)
        {
            let delete_script = format!(
                "openclaw agents delete '{}' --force --json",
                escape_powershell_literal(definition.openclaw_agent_id)
            );
            let delete_output = run_powershell_output(&delete_script)?;
            if !delete_output.success {
                return Err(format!(
                    "Existing specialist agent {} points to {} instead of {} and could not be recreated: {}",
                    definition.openclaw_agent_id,
                    existing_workspace,
                    expected_workspace,
                    combined_output(&delete_output)
                ));
            }
        } else {
            return Ok(json!({
                "specialistId": specialist_id,
                "openClawAgentId": definition.openclaw_agent_id,
                "created": false,
                "workspacePath": workspace_path.to_string_lossy(),
                "agent": existing,
            }));
        }
    }

    let add_script = format!(
        "openclaw agents add '{}' --non-interactive --workspace '{}' --model 'openai-codex/gpt-5.4' --json",
        escape_powershell_literal(definition.openclaw_agent_id),
        escape_powershell_literal(&workspace_path.to_string_lossy())
    );
    let add_output = run_powershell_output(&add_script)?;
    if !add_output.success {
        return Err(combined_output(&add_output));
    }

    let identity_script = format!(
        "openclaw agents set-identity --agent '{}' --name '{}' --theme '{}' --json",
        escape_powershell_literal(definition.openclaw_agent_id),
        escape_powershell_literal(definition.name),
        escape_powershell_literal(definition.theme)
    );
    let _ = run_powershell_output(&identity_script);

    let agent = list_openclaw_agents()?
        .into_iter()
        .find(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(|value| value == definition.openclaw_agent_id)
                .unwrap_or(false)
        })
        .unwrap_or_else(|| {
            json!({
                "id": definition.openclaw_agent_id,
                "workspace": workspace_path.to_string_lossy(),
            })
        });

    Ok(json!({
        "specialistId": specialist_id,
        "openClawAgentId": definition.openclaw_agent_id,
        "created": true,
        "workspacePath": workspace_path.to_string_lossy(),
        "agent": agent,
    }))
}

fn run_openclaw_task(
    task: &str,
    thinking_level: &str,
    prefer_mode: &str,
    timeout_seconds: Option<u64>,
    agent_id: &str,
) -> Result<Value, String> {
    let trimmed_task = task.trim();
    if trimmed_task.is_empty() {
        return Ok(json!({
            "ok": false,
            "reason": "missing_task",
            "message": "No OpenClaw task was provided."
        }));
    }

    let normalized_prefer_mode = normalize_prefer_mode(prefer_mode);
    if !is_openclaw_installed()? {
        return Ok(json!({
            "ok": false,
            "reason": "openclaw_not_installed",
            "message": "OpenClaw is not installed on this machine."
        }));
    }

    let gateway_status =
        if normalized_prefer_mode == "gateway" { probe_openclaw_gateway_status()? } else { None };
    let gateway_available = gateway_status
        .as_ref()
        .and_then(|payload| payload.get("rpc"))
        .and_then(Value::as_object)
        .and_then(|rpc| rpc.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let chosen_mode =
        if normalized_prefer_mode == "gateway" && gateway_available { "gateway" } else { "local" };
    let degraded_from_gateway = normalized_prefer_mode == "gateway" && chosen_mode == "local";

    let use_local_flag = if chosen_mode == "local" { "--local " } else { "" };
    let script = format!(
        "openclaw agent {}--agent '{}' --message '{}' --json --thinking '{}' --timeout {}",
        use_local_flag,
        escape_powershell_literal(if agent_id.trim().is_empty() { "main" } else { agent_id }),
        escape_powershell_literal(trimmed_task),
        escape_powershell_literal(normalize_thinking_level(thinking_level)),
        timeout_seconds.unwrap_or(90).clamp(15, 600)
    );
    let output = run_powershell_output(&script)?;
    if !output.success {
        let diagnostics = combined_output(&output);
        let timeout_detected = diagnostics.to_lowercase().contains("timed out");
        let file_lock_detected =
            diagnostics.contains("session file locked") || diagnostics.contains(".jsonl.lock");
        return Ok(json!({
            "ok": false,
            "mode": chosen_mode,
            "task": trimmed_task,
            "reason": if timeout_detected { "openclaw_timeout" } else if file_lock_detected { "openclaw_session_locked" } else { "openclaw_task_failed" },
            "message": diagnostics,
            "gatewayStatus": gateway_status,
            "degradedFromGateway": degraded_from_gateway,
        }));
    }

    let payload = extract_json_value(&format!("{}\n{}", output.stdout, output.stderr))?;
    let message = payload
        .get("payloads")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "OpenClaw processed the task.".to_string());

    Ok(json!({
        "ok": true,
        "requestedMode": normalized_prefer_mode,
        "mode": chosen_mode,
        "degradedFromGateway": degraded_from_gateway,
        "gatewayStatus": gateway_status,
        "task": trimmed_task,
        "message": message,
        "payload": payload,
    }))
}

fn normalize_thinking_level(value: &str) -> &'static str {
    match value.trim().to_lowercase().as_str() {
        "off" => "off",
        "minimal" => "minimal",
        "low" => "low",
        "detailed" => "high",
        "deep" => "high",
        "fast" => "low",
        "high" => "high",
        "xhigh" => "xhigh",
        _ => "medium",
    }
}

fn normalize_prefer_mode(value: &str) -> &'static str {
    match value.trim().to_lowercase().as_str() {
        "gateway" => "gateway",
        "local" => "local",
        _ => "auto",
    }
}

fn specialist_workspace_path(specialist_id: &str) -> PathBuf {
    runtime_data_root().join("openclaw-specialists").join(specialist_id)
}

fn build_identity_content(definition: &SpecialistDefinition) -> String {
    [
        "# IDENTITY.md".to_string(),
        String::new(),
        format!("- Name: {}", definition.name),
        "- Creature: Specialist OpenClaw agent".to_string(),
        format!("- Vibe: {}", definition.description),
        "- Emoji: []".to_string(),
        String::new(),
        "This agent exists to serve the voice orchestrator with a narrow role.".to_string(),
        "Keep responses practical, direct and short.".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn build_soul_content(definition: &SpecialistDefinition) -> String {
    let guardrail = if definition.id == "coder" {
        [
            "Coding rules:",
            "- Work only inside the project path explicitly requested by the orchestrator or user.",
            "- Inspect before editing.",
            "- Avoid unrelated files.",
            "- Run verification where practical and report what was verified.",
        ]
        .join("\n")
    } else {
        [
            "Desktop rules:",
            "- Discover concrete paths dynamically from the task context or environment before acting.",
            "- Prefer deterministic actions over broad exploration.",
            "- Ask before risky or destructive operations.",
            "- Report clearly what changed on the PC.",
        ].join("\n")
    };

    [
        "# SOUL.md".to_string(),
        String::new(),
        format!("You are {}.", definition.name),
        definition.description.to_string(),
        String::new(),
        "Operating contract:".to_string(),
        "- You receive tasks from a voice orchestrator.".to_string(),
        "- First decide whether the task is clear enough to execute.".to_string(),
        "- If critical details are missing, ask one concise follow-up question.".to_string(),
        "- If the task is long-running, say what you are doing and then continue.".to_string(),
        "- Keep outputs concise and execution-focused.".to_string(),
        String::new(),
        guardrail,
        String::new(),
    ]
    .join("\n")
}

fn build_tools_content(definition: &SpecialistDefinition) -> String {
    [
        "# TOOLS.md".to_string(),
        String::new(),
        "Local notes for this specialist:".to_string(),
        format!("- Role: {}", definition.description),
        format!("- Use when: {}", definition.when_to_use),
        "- Discover machine-specific paths and applications dynamically at runtime.".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn ensure_file(path: &Path, content: &str) -> Result<(), String> {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    fs::write(path, content)
        .map_err(|error| format!("Failed to write {}: {error}", path.to_string_lossy()))
}

fn common_location_paths() -> Vec<PathBuf> {
    let current_dir = env::current_dir().ok();
    let home = home_dir();
    [
        current_dir,
        Some(home.join("Desktop")),
        Some(home.join("Documents")),
        Some(home.join("Downloads")),
    ]
    .into_iter()
    .flatten()
    .filter(|path| path.exists())
    .collect::<Vec<_>>()
}

fn common_locations() -> Vec<String> {
    common_location_paths().into_iter().map(|path| path.to_string_lossy().to_string()).collect()
}

fn home_dir() -> PathBuf {
    env::var("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|_| env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("C:\\"))
}

fn runtime_data_root() -> PathBuf {
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("VoiceOverlayAssistant").join("runtime");
    }

    home_dir().join(".voice-overlay-assistant").join("runtime")
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Cargo manifest parent should exist")
        .to_path_buf()
}

fn value_to_string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(ToString::to_string).unwrap_or_default()
}

fn normalize_path_for_compare(value: &str) -> String {
    value.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn search_item_to_json(item: &SearchPathItem) -> Value {
    json!({
        "path": item.path,
        "kind": item.kind,
        "name": item.name,
    })
}

fn escape_powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn format_offset_label(offset_seconds: i32) -> String {
    let sign = if offset_seconds >= 0 { '+' } else { '-' };
    let absolute = offset_seconds.abs();
    let hours = absolute / 3600;
    let minutes = (absolute % 3600) / 60;
    format!("{sign}{hours:02}:{minutes:02}")
}

struct ShellOutput {
    stdout: String,
    stderr: String,
    success: bool,
}

fn run_powershell_output(script: &str) -> Result<ShellOutput, String> {
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", script])
        .output()
        .map_err(|error| format!("Failed to run PowerShell command: {error}"))?;

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

fn is_openclaw_installed() -> Result<bool, String> {
    let command_check =
        run_powershell_output("$cmd = Get-Command openclaw -ErrorAction Stop; $cmd.Source")?;
    Ok(command_check.success)
}

fn inspect_openclaw_gateway_status() -> Result<Option<Value>, String> {
    let output = run_powershell_output("openclaw gateway status --json --no-probe")?;
    if !output.success {
        return Ok(None);
    }

    let mut payload = extract_json_value(&format!("{}\n{}", output.stdout, output.stderr))?;
    enrich_openclaw_gateway_status(&mut payload)?;
    Ok(Some(payload))
}

fn probe_openclaw_gateway_status() -> Result<Option<Value>, String> {
    let output = run_powershell_output("openclaw gateway status --json --timeout 3000")?;
    if !output.success {
        return inspect_openclaw_gateway_status();
    }

    let mut payload = extract_json_value(&format!("{}\n{}", output.stdout, output.stderr))?;
    enrich_openclaw_gateway_status(&mut payload)?;
    Ok(Some(payload))
}

fn enrich_openclaw_gateway_status(payload: &mut Value) -> Result<(), String> {
    let process_count = get_openclaw_gateway_process_count()?;
    let dashboard = get_openclaw_gateway_dashboard_status()?;
    let has_rpc_payload = payload.get("rpc").is_some();
    let service_loaded = payload
        .get("service")
        .and_then(Value::as_object)
        .and_then(|service| service.get("loaded"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let rpc_available = payload
        .get("rpc")
        .and_then(Value::as_object)
        .and_then(|rpc| rpc.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let dashboard_ok = dashboard.get("ok").and_then(Value::as_bool).unwrap_or(false);

    if let Some(object) = payload.as_object_mut() {
        object.insert("processCount".to_string(), json!(process_count));
        object.insert("dashboard".to_string(), dashboard);
        object.insert("serviceLoaded".to_string(), Value::Bool(service_loaded));
        object
            .insert("serviceReachable".to_string(), Value::Bool(process_count > 0 && dashboard_ok));
        object.insert("rpcAvailable".to_string(), Value::Bool(rpc_available));
        object.insert(
            "statusMode".to_string(),
            Value::String(if has_rpc_payload {
                "service_and_rpc".to_string()
            } else {
                "service_only".to_string()
            }),
        );
    }

    Ok(())
}

fn get_openclaw_gateway_process_count() -> Result<u64, String> {
    let script = "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'node_modules\\\\openclaw\\\\dist\\\\(entry|index)\\.js gateway' -or $_.CommandLine -match '\\\\.openclaw\\\\gateway\\.cmd' }).Count";
    let output = run_powershell_output(script)?;
    if !output.success {
        return Err(format!(
            "Failed to inspect OpenClaw gateway processes: {}",
            combined_output(&output)
        ));
    }

    Ok(output.stdout.trim().parse::<u64>().unwrap_or(0))
}

fn get_openclaw_gateway_dashboard_status() -> Result<Value, String> {
    let script = r#"
try {
  $response = Invoke-WebRequest -Uri 'http://127.0.0.1:18790/' -UseBasicParsing -TimeoutSec 3
  @{
    ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    statusCode = [int]$response.StatusCode
    statusDescription = [string]$response.StatusDescription
  } | ConvertTo-Json -Compress
} catch {
  @{
    ok = $false
    statusCode = $null
    statusDescription = $_.Exception.Message
  } | ConvertTo-Json -Compress
}
"#;
    let output = run_powershell_output(script)?;
    if !output.success {
        return Err(format!(
            "Failed to inspect the OpenClaw gateway dashboard: {}",
            combined_output(&output)
        ));
    }

    extract_json_value(&format!("{}\n{}", output.stdout, output.stderr))
}

fn combined_output(output: &ShellOutput) -> String {
    [output.stderr.trim(), output.stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_json_value(raw_text: &str) -> Result<Value, String> {
    let raw = raw_text.trim();
    if raw.is_empty() {
        return Err("OpenClaw/PowerShell returned no output.".to_string());
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
        return Ok(parsed);
    }

    for (index, character) in raw.char_indices() {
        if character != '{' && character != '[' {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw[index..]) {
            return Ok(parsed);
        }
    }

    let preview = if raw.len() > 1200 { format!("{}...", &raw[..1200]) } else { raw.to_string() };
    Err(format!("Failed to decode JSON payload. Raw output preview: {preview}"))
}

#[cfg(test)]
mod tests {
    use super::{
        create_word_document, extract_json_value, extract_response_text,
        extract_web_search_sources, format_offset_label, get_current_time_tool,
    };
    use serde_json::json;
    use std::{
        env, fs,
        io::Read,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn extract_json_value_skips_openclaw_log_lines() {
        let raw = "[agents/model-providers] bootstrap fallback\n[agent/embedded] WebSocket connect failed\n{\n  \"payloads\": [{\"text\": \"OK\"}],\n  \"meta\": {\"durationMs\": 1234}\n}";
        let parsed = extract_json_value(raw).expect("json payload should be extracted");

        assert_eq!(parsed.get("payloads"), Some(&json!([{ "text": "OK" }])));
        assert_eq!(
            parsed
                .get("meta")
                .and_then(|value| value.get("durationMs"))
                .and_then(serde_json::Value::as_i64),
            Some(1234)
        );
    }

    #[test]
    fn create_word_document_writes_openxml_package() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_millis();
        let target = env::temp_dir().join(format!("voice-overlay-assistant-{unique}.docx"));
        let result = create_word_document(&target, "Hallo\nWie man einen Kuchen backt.")
            .expect("docx creation should succeed");

        assert!(result.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false));
        assert!(target.exists());

        let file = fs::File::open(&target).expect("docx file should exist");
        let mut archive = zip::ZipArchive::new(file).expect("docx should be a zip archive");
        let mut document_xml = String::new();
        archive
            .by_name("word/document.xml")
            .expect("document.xml should exist")
            .read_to_string(&mut document_xml)
            .expect("document.xml should be readable");

        assert!(document_xml.contains("Hallo"));
        assert!(document_xml.contains("Wie man einen Kuchen backt."));

        let _ = fs::remove_file(target);
    }

    #[test]
    fn extract_response_text_reads_responses_output_messages() {
        let payload = json!({
            "output": [
                {
                    "type": "web_search_call",
                    "status": "completed"
                },
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "A concise answer with citations."
                        }
                    ]
                }
            ]
        });

        assert_eq!(
            extract_response_text(&payload).as_deref(),
            Some("A concise answer with citations.")
        );
    }

    #[test]
    fn extract_web_search_sources_reads_annotations_and_action_sources() {
        let payload = json!({
            "output": [
                {
                    "type": "web_search_call",
                    "action": {
                        "sources": [
                            { "url": "https://example.com/extra", "title": "Extra source" }
                        ]
                    }
                },
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Answer",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://example.com/main",
                                    "title": "Main source"
                                },
                                {
                                    "type": "url_citation",
                                    "url": "https://example.com/main",
                                    "title": "Duplicate source"
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        let sources = extract_web_search_sources(&payload);
        assert_eq!(sources.len(), 2);
        assert_eq!(
            sources[0].get("url").and_then(serde_json::Value::as_str),
            Some("https://example.com/extra")
        );
        assert_eq!(
            sources[1].get("url").and_then(serde_json::Value::as_str),
            Some("https://example.com/main")
        );
    }

    #[test]
    fn format_offset_label_formats_positive_and_negative_offsets() {
        assert_eq!(format_offset_label(7200), "+02:00");
        assert_eq!(format_offset_label(-19800), "-05:30");
    }

    #[test]
    fn get_current_time_tool_returns_local_clock_payload() {
        let payload = get_current_time_tool().expect("current time tool should succeed");

        assert_eq!(payload.get("ok").and_then(serde_json::Value::as_bool), Some(true));
        assert!(payload.get("localDateTime").and_then(serde_json::Value::as_str).is_some());
        assert_eq!(
            payload.get("localTime").and_then(serde_json::Value::as_str).map(str::len),
            Some(5)
        );
        assert!(payload.get("localTimePrecise").and_then(serde_json::Value::as_str).is_some());
        assert!(payload.get("weekday").and_then(serde_json::Value::as_str).is_some());
        assert!(payload.get("timezoneOffsetMinutes").and_then(serde_json::Value::as_i64).is_some());
        assert!(payload.get("message").and_then(serde_json::Value::as_str).is_some());
    }
}
