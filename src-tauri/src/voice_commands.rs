use crate::{
    settings::{resolve_openai_api_key, AppSettings},
    tts::{speak_text, SpeakTextOptions},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_ASSISTANT_MODEL: &str = "gpt-4o-mini";
const MAIN_WINDOW_LABEL: &str = "main";
const OPEN_SETTINGS_EVENT: &str = "overlay://open-settings";
const DEFAULT_BROWSER_URL: &str = "https://www.google.com";
const YOUTUBE_URL: &str = "https://www.youtube.com";
const GOOGLE_URL: &str = "https://www.google.com";
const SEARCH_URL_PREFIX: &str = "https://www.google.com/search?q=";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCommandResult {
    pub handled: bool,
    pub action: String,
    pub target: Option<String>,
    pub source: String,
    pub message: String,
    pub spoke_feedback: bool,
    pub reply_text: Option<String>,
}

#[derive(Debug, Clone)]
enum AssistantIntent {
    Actions {
        actions: Vec<AssistantAction>,
        reply: Option<String>,
        source: &'static str,
    },
    Reply {
        reply: String,
        source: &'static str,
    },
    None,
}

#[derive(Debug, Clone)]
enum AssistantAction {
    ShowSettings,
    ShowWindow,
    HideWindow,
    OpenUrl(String),
    SearchWeb(String),
    OpenFolder(String),
    OpenApp(String),
    CloseApp(String),
}

#[derive(Debug, Deserialize)]
struct ParsedAssistantIntent {
    kind: String,
    reply: Option<String>,
    actions: Option<Vec<ParsedAssistantAction>>,
}

#[derive(Debug, Deserialize)]
struct ParsedAssistantAction {
    #[serde(rename = "type")]
    action_type: String,
    target: Option<String>,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    temperature: f32,
    messages: Vec<ChatMessage<'a>>,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[derive(Clone, Copy)]
struct AppAlias {
    key: &'static str,
    label: &'static str,
    keywords: &'static [&'static str],
    launcher: AppLauncher,
    process_names: &'static [&'static str],
}

#[derive(Clone, Copy)]
enum AppLauncher {
    Url(&'static str),
    Command {
        program: &'static str,
        args: &'static [&'static str],
    },
}

const APP_ALIASES: &[AppAlias] = &[
    AppAlias {
        key: "browser",
        label: "Browser",
        keywords: &["browser", "internet", "web"],
        launcher: AppLauncher::Url(DEFAULT_BROWSER_URL),
        process_names: &["msedge.exe", "chrome.exe", "firefox.exe", "opera.exe", "brave.exe"],
    },
    AppAlias {
        key: "chrome",
        label: "Chrome",
        keywords: &["chrome", "google chrome"],
        launcher: AppLauncher::Command {
            program: "chrome",
            args: &[],
        },
        process_names: &["chrome.exe"],
    },
    AppAlias {
        key: "edge",
        label: "Edge",
        keywords: &["edge", "microsoft edge"],
        launcher: AppLauncher::Command {
            program: "msedge",
            args: &[],
        },
        process_names: &["msedge.exe"],
    },
    AppAlias {
        key: "firefox",
        label: "Firefox",
        keywords: &["firefox"],
        launcher: AppLauncher::Command {
            program: "firefox",
            args: &[],
        },
        process_names: &["firefox.exe"],
    },
    AppAlias {
        key: "discord",
        label: "Discord",
        keywords: &["discord"],
        launcher: AppLauncher::Command {
            program: "discord",
            args: &[],
        },
        process_names: &["Discord.exe", "Update.exe"],
    },
    AppAlias {
        key: "spotify",
        label: "Spotify",
        keywords: &["spotify"],
        launcher: AppLauncher::Command {
            program: "spotify",
            args: &[],
        },
        process_names: &["Spotify.exe"],
    },
    AppAlias {
        key: "steam",
        label: "Steam",
        keywords: &["steam"],
        launcher: AppLauncher::Command {
            program: "steam",
            args: &[],
        },
        process_names: &["steam.exe"],
    },
    AppAlias {
        key: "vscode",
        label: "VS Code",
        keywords: &["vscode", "vs code", "visual studio code", "code"],
        launcher: AppLauncher::Command {
            program: "code",
            args: &[],
        },
        process_names: &["Code.exe"],
    },
    AppAlias {
        key: "explorer",
        label: "Explorer",
        keywords: &["explorer", "datei explorer", "file explorer"],
        launcher: AppLauncher::Command {
            program: "explorer",
            args: &[],
        },
        process_names: &["explorer.exe"],
    },
    AppAlias {
        key: "notepad",
        label: "Notepad",
        keywords: &["notepad", "editor"],
        launcher: AppLauncher::Command {
            program: "notepad",
            args: &[],
        },
        process_names: &["notepad.exe"],
    },
    AppAlias {
        key: "calculator",
        label: "Calculator",
        keywords: &["calculator", "calc", "rechner"],
        launcher: AppLauncher::Command {
            program: "calc",
            args: &[],
        },
        process_names: &["CalculatorApp.exe", "calc.exe"],
    },
];

pub fn execute_voice_command(
    transcript: &str,
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<VoiceCommandResult, String> {
    let normalized = normalize_transcript(transcript);
    if normalized.is_empty() {
        return Ok(noop_result());
    }

    let intent = parse_heuristically(&normalized)
        .or_else(|| infer_with_openai(&normalized, settings).ok().flatten())
        .unwrap_or(AssistantIntent::None);

    match intent {
        AssistantIntent::Actions {
            actions,
            reply,
            source,
        } => execute_actions(actions, reply, source, app, settings),
        AssistantIntent::Reply { reply, source } => {
            let spoke_feedback = speak_feedback(&reply, settings).is_ok();
            Ok(VoiceCommandResult {
                handled: true,
                action: "reply".to_string(),
                target: None,
                source: source.to_string(),
                message: reply.clone(),
                spoke_feedback,
                reply_text: Some(reply),
            })
        }
        AssistantIntent::None => Ok(noop_result()),
    }
}

fn execute_actions(
    actions: Vec<AssistantAction>,
    reply: Option<String>,
    source: &'static str,
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<VoiceCommandResult, String> {
    if actions.is_empty() {
        return Ok(noop_result());
    }

    let mut summaries: Vec<String> = Vec::new();
    let mut primary_action = "actions".to_string();
    let mut primary_target: Option<String> = None;

    for action in &actions {
        let summary = execute_action(action, app)?;
        if primary_target.is_none() {
            primary_target = action_target_label(action);
        }
        if primary_action == "actions" {
            primary_action = action_name(action).to_string();
        }
        summaries.push(summary);
    }

    let spoken_reply = reply
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        })
        .unwrap_or_else(|| build_action_reply(&summaries));

    let spoke_feedback = speak_feedback(&spoken_reply, settings).is_ok();
    let message = summaries.join(" ");

    Ok(VoiceCommandResult {
        handled: true,
        action: primary_action,
        target: primary_target,
        source: source.to_string(),
        message,
        spoke_feedback,
        reply_text: Some(spoken_reply),
    })
}

fn execute_action(action: &AssistantAction, app: &AppHandle) -> Result<String, String> {
    match action {
        AssistantAction::ShowSettings => {
            show_main_window(app, true)?;
            Ok("Ich oeffne die Einstellungen.".to_string())
        }
        AssistantAction::ShowWindow => {
            show_main_window(app, false)?;
            Ok("Ich oeffne das Fenster.".to_string())
        }
        AssistantAction::HideWindow => {
            hide_main_window(app)?;
            Ok("Ich schliesse das Fenster.".to_string())
        }
        AssistantAction::OpenUrl(url) => {
            open_url(url)?;
            Ok(format!("Ich oeffne {url}."))
        }
        AssistantAction::SearchWeb(query) => {
            let search_url = build_search_url(query);
            open_url(&search_url)?;
            Ok(format!("Ich suche nach {query} im Browser."))
        }
        AssistantAction::OpenFolder(target) => {
            let (label, path) = resolve_folder_target(target)
                .ok_or_else(|| format!("Unsupported folder target '{target}'."))?;
            open_folder(&path)?;
            Ok(format!("Ich oeffne {label}."))
        }
        AssistantAction::OpenApp(target) => {
            let alias = find_app_alias(target)
                .ok_or_else(|| format!("Unsupported app target '{target}'."))?;
            open_app(alias)?;
            Ok(format!("Ich oeffne {}.", alias.label))
        }
        AssistantAction::CloseApp(target) => {
            let alias = find_app_alias(target)
                .ok_or_else(|| format!("Unsupported app target '{target}'."))?;
            close_app(alias)?;
            Ok(format!("Ich schliesse {}.", alias.label))
        }
    }
}

fn parse_heuristically(transcript: &str) -> Option<AssistantIntent> {
    let wants_open = contains_any(
        transcript,
        &["offne", "oeffne", "mach auf", "zeige", "starte", "geh auf", "gehe auf"],
    );
    let wants_close = contains_any(
        transcript,
        &["schliesse", "schliess", "schlies", "mache zu", "mach zu", "verstecke", "blende aus", "beende"],
    );

    if transcript == "hey astra" || transcript == "hi astra" || transcript == "astra" {
        return Some(AssistantIntent::None);
    }

    if transcript.contains("einstellung") || transcript.contains("settings") {
        let action = if wants_close {
            AssistantAction::HideWindow
        } else if wants_open {
            AssistantAction::ShowSettings
        } else {
            AssistantAction::ShowSettings
        };

        return Some(AssistantIntent::Actions {
            actions: vec![action],
            reply: Some(if wants_close {
                "Ich schliesse die Einstellungen.".to_string()
            } else {
                "Ich oeffne die Einstellungen.".to_string()
            }),
            source: "heuristic",
        });
    }

    if contains_any(transcript, &["fenster", "tool", "app", "anwendung"]) {
        let action = if wants_close {
            AssistantAction::HideWindow
        } else if wants_open {
            AssistantAction::ShowWindow
        } else {
            AssistantAction::ShowWindow
        };

        return Some(AssistantIntent::Actions {
            actions: vec![action],
            reply: Some(if wants_close {
                "Ich schliesse das Fenster.".to_string()
            } else {
                "Ich oeffne das Fenster.".to_string()
            }),
            source: "heuristic",
        });
    }

    if transcript.contains("youtube") {
        return Some(AssistantIntent::Actions {
            actions: vec![AssistantAction::OpenUrl(YOUTUBE_URL.to_string())],
            reply: Some("Ich oeffne YouTube.".to_string()),
            source: "heuristic",
        });
    }

    if transcript.contains("google") && wants_open {
        return Some(AssistantIntent::Actions {
            actions: vec![AssistantAction::OpenUrl(GOOGLE_URL.to_string())],
            reply: Some("Ich oeffne Google.".to_string()),
            source: "heuristic",
        });
    }

    let app_actions = collect_app_actions(transcript, wants_open, wants_close);
    if !app_actions.is_empty() {
        return Some(AssistantIntent::Actions {
            actions: app_actions,
            reply: None,
            source: "heuristic",
        });
    }

    if wants_open {
        if let Some((folder_key, folder_label)) = resolve_special_folder_key(transcript) {
            return Some(AssistantIntent::Actions {
                actions: vec![AssistantAction::OpenFolder(folder_key.to_string())],
                reply: Some(format!("Ich oeffne {}.", folder_label)),
                source: "heuristic",
            });
        }

        if let Some(url) = extract_url_like_target(transcript) {
            return Some(AssistantIntent::Actions {
                actions: vec![AssistantAction::OpenUrl(url.clone())],
                reply: Some(format!("Ich oeffne {url}.")),
                source: "heuristic",
            });
        }

        if let Some(query) = extract_search_query(transcript) {
            return Some(AssistantIntent::Actions {
                actions: vec![AssistantAction::SearchWeb(query.clone())],
                reply: Some(format!("Ich suche nach {} im Browser.", query)),
                source: "heuristic",
            });
        }
    }

    None
}

fn collect_app_actions(
    transcript: &str,
    wants_open: bool,
    wants_close: bool,
) -> Vec<AssistantAction> {
    if !wants_open && !wants_close {
        return Vec::new();
    }

    let mut seen = HashSet::new();
    let mut actions = Vec::new();

    for alias in APP_ALIASES {
        if alias
            .keywords
            .iter()
            .any(|keyword| transcript.contains(keyword))
            && seen.insert(alias.key)
        {
            if wants_open {
                actions.push(AssistantAction::OpenApp(alias.key.to_string()));
            } else if wants_close {
                actions.push(AssistantAction::CloseApp(alias.key.to_string()));
            }
        }
    }

    actions
}

fn infer_with_openai(
    transcript: &str,
    settings: &AppSettings,
) -> Result<Option<AssistantIntent>, String> {
    let api_key = match resolve_openai_api_key(settings) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };

    let system_prompt = "You are a German desktop voice assistant planner. Return exactly one compact JSON object with this schema: {\"kind\":\"none|actions|reply\",\"reply\":\"string or null\",\"actions\":[{\"type\":\"show_settings|show_window|hide_window|open_url|search_web|open_folder|open_app|close_app\",\"target\":\"string or null\"}]}. Rules: Use kind=actions for desktop control or web opening requests. You may return multiple actions. Use open_url only with a full http or https URL. Use search_web for arbitrary things the user wants opened in a browser when no exact URL is clear. open_folder target must be one of: desktop, downloads, documents, pictures, music, videos, project. open_app and close_app target must be one of: browser, chrome, edge, firefox, discord, spotify, steam, vscode, explorer, notepad, calculator. Use kind=reply for normal conversation, questions, or monologue-style talking, and provide a concise helpful German reply in reply. If nothing safe applies, return kind=none. Do not include markdown fences or explanations.";

    let user_prompt = format!("Transcript: {transcript}");
    let client = reqwest::blocking::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&ChatRequest {
            model: DEFAULT_ASSISTANT_MODEL,
            temperature: 0.2,
            messages: vec![
                ChatMessage {
                    role: "system",
                    content: system_prompt,
                },
                ChatMessage {
                    role: "user",
                    content: &user_prompt,
                },
            ],
        })
        .send()
        .map_err(|error| format!("Voice assistant request failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("Voice assistant failed ({status}): {body}"));
    }

    let payload: ChatResponse = response
        .json()
        .map_err(|error| format!("Failed to decode voice assistant response: {error}"))?;

    let content = payload
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
        .unwrap_or_default();

    let json_payload =
        extract_json_object(&content).ok_or_else(|| "Voice assistant did not return JSON.".to_string())?;
    let parsed: ParsedAssistantIntent = serde_json::from_str(&json_payload)
        .map_err(|error| format!("Failed to parse voice assistant JSON: {error}"))?;

    Ok(resolve_parsed_intent(parsed))
}

fn resolve_parsed_intent(parsed: ParsedAssistantIntent) -> Option<AssistantIntent> {
    match parsed.kind.trim().to_lowercase().as_str() {
        "reply" => parsed.reply.and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(AssistantIntent::Reply {
                    reply: trimmed,
                    source: "openai",
                })
            }
        }),
        "actions" => {
            let mut actions = Vec::new();

            for action in parsed.actions.unwrap_or_default() {
                match action.action_type.trim().to_lowercase().as_str() {
                    "show_settings" => actions.push(AssistantAction::ShowSettings),
                    "show_window" => actions.push(AssistantAction::ShowWindow),
                    "hide_window" => actions.push(AssistantAction::HideWindow),
                    "open_url" => {
                        if let Some(url) = sanitize_url(action.target.as_deref()) {
                            actions.push(AssistantAction::OpenUrl(url));
                        }
                    }
                    "search_web" => {
                        if let Some(query) = sanitize_query(action.target.as_deref()) {
                            actions.push(AssistantAction::SearchWeb(query));
                        }
                    }
                    "open_folder" => {
                        if let Some(target) = sanitize_folder_key(action.target.as_deref()) {
                            actions.push(AssistantAction::OpenFolder(target));
                        }
                    }
                    "open_app" => {
                        if let Some(target) = sanitize_app_key(action.target.as_deref()) {
                            actions.push(AssistantAction::OpenApp(target));
                        }
                    }
                    "close_app" => {
                        if let Some(target) = sanitize_app_key(action.target.as_deref()) {
                            actions.push(AssistantAction::CloseApp(target));
                        }
                    }
                    _ => {}
                }
            }

            if actions.is_empty() {
                None
            } else {
                Some(AssistantIntent::Actions {
                    actions,
                    reply: parsed.reply.and_then(|value| {
                        let trimmed = value.trim().to_string();
                        if trimmed.is_empty() { None } else { Some(trimmed) }
                    }),
                    source: "openai",
                })
            }
        }
        _ => None,
    }
}

fn noop_result() -> VoiceCommandResult {
    VoiceCommandResult {
        handled: false,
        action: "none".to_string(),
        target: None,
        source: "none".to_string(),
        message: "No supported voice command detected.".to_string(),
        spoke_feedback: false,
        reply_text: None,
    }
}

fn action_name(action: &AssistantAction) -> &'static str {
    match action {
        AssistantAction::ShowSettings => "show_settings",
        AssistantAction::ShowWindow => "show_window",
        AssistantAction::HideWindow => "hide_window",
        AssistantAction::OpenUrl(_) => "open_url",
        AssistantAction::SearchWeb(_) => "search_web",
        AssistantAction::OpenFolder(_) => "open_folder",
        AssistantAction::OpenApp(_) => "open_app",
        AssistantAction::CloseApp(_) => "close_app",
    }
}

fn action_target_label(action: &AssistantAction) -> Option<String> {
    match action {
        AssistantAction::OpenUrl(url) => Some(url.clone()),
        AssistantAction::SearchWeb(query) => Some(query.clone()),
        AssistantAction::OpenFolder(target)
        | AssistantAction::OpenApp(target)
        | AssistantAction::CloseApp(target) => Some(target.clone()),
        AssistantAction::ShowSettings | AssistantAction::ShowWindow | AssistantAction::HideWindow => None,
    }
}

fn build_action_reply(summaries: &[String]) -> String {
    if summaries.is_empty() {
        return "Alles klar.".to_string();
    }

    if summaries.len() == 1 {
        return summary_to_spoken_reply(&summaries[0]);
    }

    let joined = summaries
        .iter()
        .map(|summary| summary_to_spoken_reply(summary))
        .collect::<Vec<_>>()
        .join(" ");

    if joined.is_empty() {
        "Erledigt.".to_string()
    } else {
        joined
    }
}

fn summary_to_spoken_reply(summary: &str) -> String {
    let trimmed = summary.trim();
    if trimmed.is_empty() {
        "Erledigt.".to_string()
    } else {
        trimmed.to_string()
    }
}

fn speak_feedback(text: &str, settings: &AppSettings) -> Result<(), String> {
    let spoken = text.trim();
    if spoken.is_empty() {
        return Ok(());
    }

    let _ = speak_text(
        SpeakTextOptions {
            text: Some(spoken.to_string()),
            voice: None,
            model: None,
            format: Some(settings.tts_format.clone()),
            mode: Some(settings.tts_mode.clone()),
            autoplay: Some(true),
            max_chunk_chars: Some(320),
            max_parallel_requests: Some(2),
            first_chunk_leading_silence_ms: Some(settings.first_chunk_leading_silence_ms),
        },
        settings,
    )?;

    Ok(())
}

fn show_main_window(app: &AppHandle, focus_settings: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;

        if focus_settings {
            app.emit_to(MAIN_WINDOW_LABEL, OPEN_SETTINGS_EVENT, ())
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn hide_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn open_url(url: &str) -> Result<(), String> {
    let sanitized = sanitize_url(Some(url)).ok_or_else(|| "Unsupported or invalid URL.".to_string())?;
    Command::new("cmd")
        .arg("/C")
        .arg("start")
        .arg("")
        .arg(&sanitized)
        .spawn()
        .map_err(|error| format!("Failed to open URL '{sanitized}': {error}"))?;
    Ok(())
}

fn open_folder(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("Folder does not exist: '{}'.", path.display()));
    }

    Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Failed to open folder '{}': {error}", path.display()))?;
    Ok(())
}

fn open_app(alias: AppAlias) -> Result<(), String> {
    match alias.key {
        "discord" => return open_discord_app().or_else(|_| open_via_launcher(alias)),
        "spotify" => return open_spotify_app().or_else(|_| open_via_launcher(alias)),
        _ => {}
    }

    open_via_launcher(alias)
}

fn open_via_launcher(alias: AppAlias) -> Result<(), String> {
    match alias.launcher {
        AppLauncher::Url(url) => open_url(url),
        AppLauncher::Command { program, args } => {
            let mut command = Command::new("cmd");
            command.arg("/C").arg("start").arg("").arg(program);
            for argument in args {
                command.arg(argument);
            }
            command
                .spawn()
                .map_err(|error| format!("Failed to open {}: {error}", alias.label))?;
            Ok(())
        }
    }
}

fn open_discord_app() -> Result<(), String> {
    if let Some(update_path) = existing_path(&[
        env_path("LOCALAPPDATA", &["Discord", "Update.exe"]),
    ]) {
        Command::new(update_path)
            .args(["--processStart", "Discord.exe"])
            .spawn()
            .map_err(|error| format!("Failed to open Discord via Update.exe: {error}"))?;
        return Ok(());
    }

    if let Some(discord_exe) = find_latest_matching_file(
        &env_dir_path("LOCALAPPDATA", &["Discord"])?,
        "app-",
        "Discord.exe",
    ) {
        Command::new(discord_exe)
            .spawn()
            .map_err(|error| format!("Failed to open Discord.exe: {error}"))?;
        return Ok(());
    }

    Err("Discord installation was not found.".to_string())
}

fn open_spotify_app() -> Result<(), String> {
    if let Some(spotify_exe) = existing_path(&[
        env_path("APPDATA", &["Spotify", "Spotify.exe"]),
        env_path("LOCALAPPDATA", &["Microsoft", "WindowsApps", "Spotify.exe"]),
    ]) {
        Command::new(spotify_exe)
            .spawn()
            .map_err(|error| format!("Failed to open Spotify.exe: {error}"))?;
        return Ok(());
    }

    Command::new("cmd")
        .arg("/C")
        .arg("start")
        .arg("")
        .arg("spotify:")
        .spawn()
        .map_err(|error| format!("Failed to open Spotify protocol: {error}"))?;
    Ok(())
}

fn close_app(alias: AppAlias) -> Result<(), String> {
    if alias.process_names.is_empty() {
        return Err(format!("No close mapping configured for {}.", alias.label));
    }

    for process_name in alias.process_names {
        let _ = Command::new("taskkill")
            .arg("/IM")
            .arg(process_name)
            .arg("/F")
            .spawn();
    }

    Ok(())
}

fn find_app_alias(target: &str) -> Option<AppAlias> {
    let lowered = target.trim().to_lowercase();
    APP_ALIASES.iter().copied().find(|alias| alias.key == lowered)
}

fn resolve_special_folder_key(transcript: &str) -> Option<(&'static str, &'static str)> {
    if contains_any(transcript, &["desktop", "schreibtisch"]) {
        return Some(("desktop", "den Desktop"));
    }
    if contains_any(transcript, &["downloads", "download"]) {
        return Some(("downloads", "die Downloads"));
    }
    if contains_any(transcript, &["dokumente", "dokument", "documents", "document"]) {
        return Some(("documents", "die Dokumente"));
    }
    if contains_any(transcript, &["bilder", "pictures", "photos", "fotos"]) {
        return Some(("pictures", "die Bilder"));
    }
    if contains_any(transcript, &["musik", "music"]) {
        return Some(("music", "die Musik"));
    }
    if contains_any(transcript, &["videos", "video"]) {
        return Some(("videos", "die Videos"));
    }
    if contains_any(
        transcript,
        &[
            "projektordner",
            "projekt ordner",
            "project folder",
            "project",
            "ai overlay assistant",
        ],
    ) {
        return Some(("project", "den Projektordner"));
    }

    None
}

fn resolve_folder_target(target: &str) -> Option<(String, PathBuf)> {
    let user_profile = env::var("USERPROFILE").ok().map(PathBuf::from)?;
    let lowered = target.trim().to_lowercase();

    let resolved = match lowered.as_str() {
        "desktop" => ("Desktop".to_string(), user_profile.join("Desktop")),
        "downloads" => ("Downloads".to_string(), user_profile.join("Downloads")),
        "documents" => ("Documents".to_string(), user_profile.join("Documents")),
        "pictures" => ("Pictures".to_string(), user_profile.join("Pictures")),
        "music" => ("Music".to_string(), user_profile.join("Music")),
        "videos" => ("Videos".to_string(), user_profile.join("Videos")),
        "project" => ("Project".to_string(), project_root()),
        _ => {
            let candidate = PathBuf::from(target);
            if candidate.is_dir() {
                (candidate.display().to_string(), candidate)
            } else {
                let project_candidate = project_root().join(target);
                if project_candidate.is_dir() {
                    (project_candidate.display().to_string(), project_candidate)
                } else {
                    return None;
                }
            }
        }
    };

    if resolved.1.is_dir() {
        Some(resolved)
    } else {
        None
    }
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Cargo manifest parent should exist")
        .to_path_buf()
}

fn env_dir_path(var_name: &str, parts: &[&str]) -> Result<PathBuf, String> {
    let mut path = PathBuf::from(
        env::var(var_name).map_err(|_| format!("Environment variable {var_name} is missing."))?,
    );
    for part in parts {
        path.push(part);
    }
    Ok(path)
}

fn env_path(var_name: &str, parts: &[&str]) -> PathBuf {
    let mut path = PathBuf::from(env::var(var_name).unwrap_or_default());
    for part in parts {
        path.push(part);
    }
    path
}

fn existing_path(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| path.is_file()).cloned()
}

fn find_latest_matching_file(base_dir: &Path, prefix: &str, file_name: &str) -> Option<PathBuf> {
    let mut candidates = fs::read_dir(base_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|name| name.starts_with(prefix))
                    .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    candidates.sort();
    candidates.reverse();

    candidates
        .into_iter()
        .map(|dir| dir.join(file_name))
        .find(|path| path.is_file())
}

fn extract_url_like_target(transcript: &str) -> Option<String> {
    transcript
        .split_whitespace()
        .find(|token| token.contains('.') && token.chars().any(|character| character.is_ascii_alphabetic()))
        .and_then(|token| sanitize_url(Some(token)))
}

fn extract_search_query(transcript: &str) -> Option<String> {
    let stripped = transcript
        .replace("hey astra", "")
        .replace("hi astra", "")
        .replace("astra", "")
        .replace("oeffne", "")
        .replace("offne", "")
        .replace("zeige", "")
        .replace("starte", "")
        .replace("geh auf", "")
        .replace("gehe auf", "")
        .replace("im browser", "")
        .replace("in browser", "")
        .replace("browser", "")
        .replace("bitte", "");

    sanitize_query(Some(stripped.trim()))
}

fn sanitize_query(target: Option<&str>) -> Option<String> {
    let trimmed = target?.trim();
    if trimmed.is_empty() {
        return None;
    }

    let cleaned = trimmed
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn build_search_url(query: &str) -> String {
    let encoded = query
        .split_whitespace()
        .map(|token| {
            token.chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .collect::<String>()
        })
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join("+");

    format!("{SEARCH_URL_PREFIX}{encoded}")
}

fn sanitize_url(target: Option<&str>) -> Option<String> {
    let trimmed = target?.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return None;
    }

    let url = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed.contains('.') {
        format!("https://{trimmed}")
    } else {
        return None;
    };

    if url.starts_with("https://") || url.starts_with("http://") {
        Some(url)
    } else {
        None
    }
}

fn sanitize_folder_key(target: Option<&str>) -> Option<String> {
    let lowered = target?.trim().to_lowercase();
    if matches!(
        lowered.as_str(),
        "desktop" | "downloads" | "documents" | "pictures" | "music" | "videos" | "project"
    ) {
        Some(lowered)
    } else {
        None
    }
}

fn sanitize_app_key(target: Option<&str>) -> Option<String> {
    let lowered = target?.trim().to_lowercase();
    if APP_ALIASES.iter().any(|alias| alias.key == lowered) {
        Some(lowered)
    } else {
        None
    }
}

fn extract_json_object(input: &str) -> Option<String> {
    let start = input.find('{')?;
    let end = input.rfind('}')?;
    Some(input[start..=end].to_string())
}

fn contains_any(input: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|pattern| input.contains(pattern))
}

fn normalize_transcript(text: &str) -> String {
    let lowered = text.to_lowercase();
    let mut normalized = String::with_capacity(lowered.len());

    for character in lowered.chars() {
        match character {
            'a'..='z' | '0'..='9' => normalized.push(character),
            'ä' => normalized.push_str("ae"),
            'ö' => normalized.push_str("oe"),
            'ü' => normalized.push_str("ue"),
            'ß' => normalized.push_str("ss"),
            ' ' => normalized.push(' '),
            _ => normalized.push(' '),
        }
    }

    normalized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
