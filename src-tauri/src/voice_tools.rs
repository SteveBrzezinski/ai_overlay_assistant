use crate::{
    settings::SettingsState,
    voice_profile::{build_assistant_instructions, build_voice_agent_state},
    voice_tasks::VoiceTaskState,
};
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
};
use tauri::{AppHandle, Manager};

const BLOCKED_EXECUTABLE_EXTENSIONS: &[&str] = &[
    ".appinstaller",
    ".bat",
    ".cmd",
    ".com",
    ".cpl",
    ".exe",
    ".hta",
    ".js",
    ".jse",
    ".lnk",
    ".msi",
    ".msc",
    ".ps1",
    ".psm1",
    ".scr",
    ".vbe",
    ".vbs",
    ".wsf",
];

const IGNORED_DIRECTORIES: &[&str] = &[
    "$recycle.bin",
    ".git",
    ".hg",
    ".next",
    ".nuxt",
    ".venv",
    "appdata",
    "dist",
    "node_modules",
    "temp",
    "tmp",
    "target",
];

struct KnownApplicationDefinition {
    key: &'static str,
    display_name: &'static str,
    aliases: &'static [&'static str],
    commands: &'static [&'static str],
    executable_names: &'static [&'static str],
    candidate_relative_paths: &'static [&'static str],
    start_menu_terms: &'static [&'static str],
}

const KNOWN_APPLICATIONS: &[KnownApplicationDefinition] = &[
    KnownApplicationDefinition {
        key: "word",
        display_name: "Microsoft Word",
        aliases: &["word", "microsoft word", "winword"],
        commands: &["winword"],
        executable_names: &["WINWORD.EXE"],
        candidate_relative_paths: &[
            "Microsoft Office\\root\\Office16\\WINWORD.EXE",
            "Microsoft Office\\Office16\\WINWORD.EXE",
            "Microsoft Office\\root\\Office15\\WINWORD.EXE",
            "Microsoft Office\\Office15\\WINWORD.EXE",
        ],
        start_menu_terms: &["Word"],
    },
    KnownApplicationDefinition {
        key: "excel",
        display_name: "Microsoft Excel",
        aliases: &["excel", "microsoft excel"],
        commands: &["excel"],
        executable_names: &["EXCEL.EXE"],
        candidate_relative_paths: &[
            "Microsoft Office\\root\\Office16\\EXCEL.EXE",
            "Microsoft Office\\Office16\\EXCEL.EXE",
            "Microsoft Office\\root\\Office15\\EXCEL.EXE",
            "Microsoft Office\\Office15\\EXCEL.EXE",
        ],
        start_menu_terms: &["Excel"],
    },
    KnownApplicationDefinition {
        key: "powerpoint",
        display_name: "Microsoft PowerPoint",
        aliases: &["powerpoint", "power point", "microsoft powerpoint", "powerpnt"],
        commands: &["powerpnt"],
        executable_names: &["POWERPNT.EXE"],
        candidate_relative_paths: &[
            "Microsoft Office\\root\\Office16\\POWERPNT.EXE",
            "Microsoft Office\\Office16\\POWERPNT.EXE",
            "Microsoft Office\\root\\Office15\\POWERPNT.EXE",
            "Microsoft Office\\Office15\\POWERPNT.EXE",
        ],
        start_menu_terms: &["PowerPoint"],
    },
    KnownApplicationDefinition {
        key: "notepad",
        display_name: "Notepad",
        aliases: &["notepad", "editor", "text editor"],
        commands: &["notepad"],
        executable_names: &["notepad.exe"],
        candidate_relative_paths: &[],
        start_menu_terms: &["Notepad"],
    },
    KnownApplicationDefinition {
        key: "calculator",
        display_name: "Calculator",
        aliases: &["calculator", "calc", "taschenrechner"],
        commands: &["calc"],
        executable_names: &["CalculatorApp.exe", "calc.exe"],
        candidate_relative_paths: &[],
        start_menu_terms: &["Calculator"],
    },
    KnownApplicationDefinition {
        key: "paint",
        display_name: "Paint",
        aliases: &["paint", "mspaint"],
        commands: &["mspaint"],
        executable_names: &["mspaint.exe"],
        candidate_relative_paths: &[],
        start_menu_terms: &["Paint"],
    },
    KnownApplicationDefinition {
        key: "explorer",
        display_name: "File Explorer",
        aliases: &["explorer", "file explorer", "windows explorer"],
        commands: &["explorer"],
        executable_names: &["explorer.exe"],
        candidate_relative_paths: &[],
        start_menu_terms: &["File Explorer"],
    },
];

struct SearchPathItem {
    path: String,
    kind: &'static str,
    name: String,
}

enum ApplicationTarget {
    Command(String),
    Path(String),
    AppId(String),
}

pub fn realtime_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": "get_pc_context",
            "description": "Liefert den aktuellen lokalen PC-Kontext mit Betriebssystem, Benutzername und wichtigen Ordnern.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "type": "function",
            "name": "find_paths",
            "description": "Sucht nach Dateien oder Ordnern auf dem lokalen PC in typischen Arbeitsverzeichnissen oder in einem angegebenen Basisordner.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Ein Teil des Dateinamens oder Ordnernamens." },
                    "basePath": { "type": "string", "description": "Optionaler Basisordner, in dem die Suche eingegrenzt werden soll." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 15, "description": "Maximale Anzahl an Treffern." }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "submit_pc_task",
            "description": "Plant und fuehrt einfache lokale PC-Aufgaben aus. Unterstuetzt aktuell das direkte Oeffnen eines bekannten Pfads, das Suchen und Oeffnen einer Datei sowie das Starten bekannter Anwendungen wie Word oder Excel.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["open_path", "search_and_open", "launch_app"] },
                    "path": { "type": "string" },
                    "query": { "type": "string" },
                    "appName": { "type": "string" },
                    "basePath": { "type": "string" }
                },
                "required": ["action"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "update_assistant_state",
            "description": "Speichert Stimme, Persoenlichkeit und weitere Vorgaben des Assistenten. Der Name bleibt fest an die Wake-Word-Konfiguration gebunden.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Wird ignoriert, weil der Assistentenname von der Wake-Word-Konfiguration kommt." },
                    "voice": { "type": "string" },
                    "model": { "type": "string" },
                    "personality": { "type": "string" },
                    "behavior": { "type": "string" },
                    "extraInstructions": { "type": "string" },
                    "preferredLanguage": { "type": "string" },
                    "toneNotes": { "type": "string" },
                    "onboardingComplete": { "type": "boolean" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "get_openclaw_status",
            "description": "Prueft, ob OpenClaw auf diesem PC installiert ist und ob der Gateway-Modus verfuegbar ist oder nur der lokale Fallback.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "type": "function",
            "name": "get_specialist_agents",
            "description": "Liefert die bekannten Spezialagenten und ihren aktuellen OpenClaw-Status.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "type": "function",
            "name": "delegate_to_specialist",
            "description": "Delegiert eine komplexere Aufgabe an den passendsten Spezialagenten wie pc-ops oder coder.",
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
            "description": "Delegiert eine Aufgabe direkt an OpenClaw, falls die Spezialagentenstruktur nicht passt oder explizit rohe OpenClaw-Delegation gewuenscht ist.",
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
        "get_pc_context" => get_pc_context_tool(),
        "find_paths" => find_paths_tool(&args),
        "submit_pc_task" => submit_pc_task_tool(&args, app),
        "update_assistant_state" => update_assistant_state_tool(&args, settings),
        "get_openclaw_status" => get_openclaw_status_tool(),
        "get_specialist_agents" => get_specialist_agents_tool(),
        "delegate_to_specialist" => delegate_to_specialist_tool(&args, app),
        "delegate_to_openclaw" => delegate_to_openclaw_tool(&args, app),
        _ => Err(format!("Unknown voice agent tool: {tool_name}")),
    }
}

fn get_pc_context_tool() -> Result<Value, String> {
    let working_directory = env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    Ok(json!({
        "platform": env::consts::OS,
        "osType": env::consts::FAMILY,
        "hostname": env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string()),
        "username": env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string()),
        "workingDirectory": working_directory.to_string_lossy(),
        "homeDirectory": home_dir().to_string_lossy(),
        "commonLocations": common_locations(),
        "availableApplications": KNOWN_APPLICATIONS.iter().map(|item| json!({
            "key": item.key,
            "displayName": item.display_name,
            "aliases": item.aliases,
        })).collect::<Vec<_>>(),
    }))
}

fn find_paths_tool(args: &Value) -> Result<Value, String> {
    let query = value_to_string(args.get("query")).trim().to_string();
    if query.len() < 2 {
        return Ok(json!({
            "ok": false,
            "reason": "query_too_short",
            "message": "Bitte suche nach mindestens zwei Zeichen."
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

fn submit_pc_task_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let action = value_to_string(args.get("action")).trim().to_string();
    if action.is_empty() {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "Es wurde keine PC-Aktion angegeben.",
            "question": "Was genau soll ich auf dem PC tun?"
        }));
    }

    if action == "open_path" {
        let path = value_to_string(args.get("path"));
        if path.trim().is_empty() {
            return Ok(json!({
                "ok": false,
                "status": "needs_clarification",
                "message": "Fuer open_path fehlt der Zielpfad.",
                "question": "Welchen exakten Pfad soll ich oeffnen?"
            }));
        }

        let opened = open_path(&path)?;
        let status = if opened.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            "completed"
        } else {
            "failed"
        };
        let mut object = opened.as_object().cloned().unwrap_or_default();
        object.insert("status".to_string(), Value::String(status.to_string()));
        return Ok(Value::Object(object));
    }

    if action == "search_and_open" {
        let query = value_to_string(args.get("query")).trim().to_string();
        if query.len() < 2 {
            return Ok(json!({
                "ok": false,
                "status": "needs_clarification",
                "message": "Die Suchanfrage ist zu ungenau.",
                "question": "Welche Datei oder welcher Ordner soll geoeffnet werden? Bitte nenne mindestens zwei Zeichen oder den exakten Namen."
            }));
        }

        if match_known_application(&query).is_some() {
            let launched = launch_known_application(&query)?;
            let status = if launched.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                "completed"
            } else {
                "failed"
            };
            let mut object = launched.as_object().cloned().unwrap_or_default();
            object.insert("status".to_string(), Value::String(status.to_string()));
            object.insert("query".to_string(), Value::String(query));
            return Ok(Value::Object(object));
        }

        let base_path = args.get("basePath").and_then(Value::as_str);
        let (quick_results, _, _) = search_paths(&query, base_path, 3, 400)?;
        if quick_results.len() == 1 {
            let path = quick_results[0].path.clone();
            let opened = open_path(&path)?;
            let status = if opened.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                "completed"
            } else {
                "failed"
            };
            let mut object = opened.as_object().cloned().unwrap_or_default();
            object.insert("status".to_string(), Value::String(status.to_string()));
            object.insert("matchedBy".to_string(), Value::String("quick_search".to_string()));
            object.insert("query".to_string(), Value::String(query));
            return Ok(Value::Object(object));
        }

        if quick_results.len() > 1 {
            return Ok(json!({
                "ok": false,
                "status": "needs_clarification",
                "message": format!("Mehrere schnelle Treffer fuer \"{query}\" gefunden."),
                "question": "Ich habe mehrere passende Dateien gefunden. Welchen exakten Treffer soll ich oeffnen?",
                "matches": quick_results.iter().map(search_item_to_json).collect::<Vec<_>>(),
            }));
        }

        let payload = json!({
            "query": query,
            "basePath": normalize_search_base(base_path).map(|path| path.to_string_lossy().to_string()),
        });
        let task = app.state::<VoiceTaskState>().create_task("search_and_open", payload.clone());
        app.state::<VoiceTaskState>().emit_task(app, &task);

        let app_handle = app.clone();
        let task_id = task.id.clone();
        thread::spawn(move || {
            run_search_and_open_task(&app_handle, &task_id, payload);
        });

        return Ok(json!({
            "ok": true,
            "status": "queued",
            "taskId": task.id,
            "etaSeconds": 10,
            "message": format!("Suche nach \"{query}\" laeuft im Hintergrund. Ich melde mich, sobald ein Ergebnis vorliegt."),
        }));
    }

    if action == "launch_app" {
        let app_name = value_to_string(args.get("appName"));
        let fallback_query = value_to_string(args.get("query"));
        let resolved_name = if app_name.trim().is_empty() { fallback_query } else { app_name };
        if resolved_name.trim().is_empty() {
            return Ok(json!({
                "ok": false,
                "status": "needs_clarification",
                "message": "Fuer launch_app fehlt der Anwendungsname.",
                "question": "Welche Anwendung soll ich starten?"
            }));
        }

        let launched = launch_known_application(&resolved_name)?;
        let status = if launched.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            "completed"
        } else {
            "failed"
        };
        let mut object = launched.as_object().cloned().unwrap_or_default();
        object.insert("status".to_string(), Value::String(status.to_string()));
        object.insert("requestedApplication".to_string(), Value::String(resolved_name.trim().to_string()));
        return Ok(Value::Object(object));
    }

    Ok(json!({
        "ok": false,
        "status": "needs_clarification",
        "message": format!("Die Aktion \"{action}\" wird aktuell nicht unterstuetzt."),
        "question": "Soll ich stattdessen einen Pfad direkt oeffnen oder nach einer Datei suchen und sie oeffnen?"
    }))
}

struct SpecialistDefinition {
    id: &'static str,
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
        name: "PC Ops",
        theme: "desktop-automation",
        description: "Spezialist fuer Desktop-, Datei-, Office- und allgemeine lokale PC-Aufgaben.",
        when_to_use: "App-Starts, Dateien, Ordner, Dokumente, Explorer, Word, Downloads und lokale Automationsaufgaben.",
        default_thinking_level: "medium",
        default_timeout_seconds: 180,
        default_prefer_mode: "local",
        keywords: &[
            "app", "application", "browser", "desktop", "directory", "document", "download", "drive", "explorer", "excel", "file", "folder", "notepad",
            "office", "ordner", "path", "pdf", "powerpoint", "speichere", "word", "oeffne", "oeffnen", "pc",
        ],
    },
    SpecialistDefinition {
        id: "coder",
        name: "Coder",
        theme: "software-engineering",
        description: "Spezialist fuer Coding, Fehlersuche, Skripte, Repo-Aenderungen, Tests und technische Implementierung.",
        when_to_use: "Code schreiben, Bugs beheben, Dateien aendern, Tests ausfuehren, Refactors, Skripte und technische Analyse.",
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
    if !requested_voice.trim().is_empty() && requested_voice.trim().to_lowercase() != saved.voice_agent_voice {
        message.push_str(&format!(" Fuer die Realtime-Stimme wurde {} verwendet.", saved.voice_agent_voice));
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
    let command_check = run_powershell_output("$cmd = Get-Command openclaw -ErrorAction Stop; $cmd.Source")?;
    if !command_check.success {
        return Ok(json!({
            "installed": false,
            "availableMode": "none",
            "gatewayAvailable": false,
        }));
    }

    let command_path = command_check.stdout.trim().to_string();
    let health = run_powershell_output("openclaw health --json")?;
    if health.success {
        let payload = extract_json_value(&format!("{}\n{}", health.stdout, health.stderr))?;
        Ok(json!({
            "installed": true,
            "commandPath": command_path,
            "availableMode": "gateway",
            "gatewayAvailable": true,
            "health": payload,
        }))
    } else {
        Ok(json!({
            "installed": true,
            "commandPath": command_path,
            "availableMode": "local",
            "gatewayAvailable": false,
            "healthError": combined_output(&health),
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
                    .map(|value| value == definition.id)
                    .unwrap_or(false)
            });
            json!({
                "id": definition.id,
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
            "message": "Fuer die OpenClaw-Bruecke fehlt die Aufgabenbeschreibung.",
            "question": "Welche konkrete Aufgabe soll an OpenClaw delegiert werden?"
        }));
    }

    let agent_id = {
        let value = value_to_string(args.get("agentId"));
        if value.trim().is_empty() { "main".to_string() } else { value }
    };
    let payload = json!({
        "task": task,
        "thinkingLevel": value_to_string(args.get("thinkingLevel")),
        "preferMode": value_to_string(args.get("preferMode")),
        "timeoutSeconds": args.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(180),
        "agentId": agent_id,
    });
    let task_record = app.state::<VoiceTaskState>().create_task("openclaw_delegate", payload.clone());
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
        "message": "Die Aufgabe wurde an OpenClaw delegiert. Ich melde mich, sobald der PC-Agent ein Ergebnis hat."
    }))
}

fn delegate_to_specialist_tool(args: &Value, app: &AppHandle) -> Result<Value, String> {
    let task = value_to_string(args.get("task")).trim().to_string();
    if task.is_empty() {
        return Ok(json!({
            "ok": false,
            "status": "needs_clarification",
            "message": "Fuer den Delegationsagenten fehlt die Aufgabenbeschreibung.",
            "question": "Welche konkrete Aufgabe soll delegiert werden?"
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
            "message": "Der gewuenschte Spezialagent ist unbekannt.",
            "question": "Soll ich die Aufgabe an pc-ops oder coder delegieren?"
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
        if value.trim().is_empty() { route.specialist.default_thinking_level.to_string() } else { value }
    };
    let prefer_mode = {
        let value = value_to_string(args.get("preferMode"));
        if value.trim().is_empty() { route.specialist.default_prefer_mode.to_string() } else { value }
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
    let task_record = app.state::<VoiceTaskState>().create_task("specialist_delegate", payload.clone());
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
        "message": format!("Die Aufgabe wurde an den Spezialagenten {} delegiert. Ich melde mich, sobald ein Ergebnis vorliegt.", route.specialist.id),
    }))
}

fn run_search_and_open_task(app: &AppHandle, task_id: &str, payload: Value) {
    let tasks = app.state::<VoiceTaskState>();
    let _ = tasks.update_task(app, task_id, "running", None);

    let query = payload.get("query").and_then(Value::as_str).unwrap_or("");
    let base_path = payload.get("basePath").and_then(Value::as_str);
    match search_paths(query, base_path, 5, 10_000) {
        Ok((results, _, _)) if results.is_empty() => {
            let _ = tasks.update_task(
                app,
                task_id,
                "failed",
                Some(json!({
                    "message": format!("Kein passender Pfad fuer \"{query}\" gefunden."),
                    "query": query,
                    "basePath": base_path,
                })),
            );
        }
        Ok((results, _, _)) if results.len() > 1 => {
            let _ = tasks.update_task(
                app,
                task_id,
                "needs_clarification",
                Some(json!({
                    "message": format!("Es wurden mehrere Treffer fuer \"{query}\" gefunden."),
                    "question": "Welchen Treffer soll ich oeffnen? Nenne bitte den exakten Dateinamen oder Pfad.",
                    "matches": results.iter().map(search_item_to_json).collect::<Vec<_>>(),
                })),
            );
        }
        Ok((results, _, _)) => {
            let path = results[0].path.clone();
            match open_path(&path) {
                Ok(opened) if opened.get("ok").and_then(Value::as_bool).unwrap_or(false) => {
                    let _ = tasks.update_task(
                        app,
                        task_id,
                        "completed",
                        Some(json!({
                            "message": format!("Die gesuchte Datei wurde gefunden und geoeffnet: {}", path),
                            "match": search_item_to_json(&results[0]),
                            "opened": opened,
                        })),
                    );
                }
                Ok(opened) => {
                    let _ = tasks.update_task(app, task_id, "failed", Some(opened));
                }
                Err(error) => {
                    let _ = tasks.update_task(app, task_id, "failed", Some(json!({ "message": error })));
                }
            }
        }
        Err(error) => {
            let _ = tasks.update_task(app, task_id, "failed", Some(json!({ "message": error })));
        }
    }
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
            let _ = tasks.update_task(app, task_id, "failed", Some(json!({ "ok": false, "message": error })));
        }
    }
}

fn run_specialist_delegation_task(app: &AppHandle, task_id: &str, payload: Value) {
    let tasks = app.state::<VoiceTaskState>();
    let _ = tasks.update_task(app, task_id, "running", None);

    let specialist_id = payload.get("specialistId").and_then(Value::as_str).unwrap_or("pc-ops");
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
        specialist_id,
    ) {
        Ok(result) if result.get("ok").and_then(Value::as_bool).unwrap_or(false) => {
            let _ = tasks.update_task(
                app,
                task_id,
                "completed",
                Some(json!({
                    "ok": true,
                    "specialistId": specialist_id,
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
    let searched_roots = roots.iter().map(|path| path.to_string_lossy().to_string()).collect::<Vec<_>>();
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

            if metadata.is_dir() && !is_ignored_directory(&file_name) {
                queue.push_back(full_path);
            }
        }
    }

    Ok((results, searched_roots, queue.len() > 0 || directories_visited >= max_directories))
}

fn open_path(raw_path: &str) -> Result<Value, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Ok(json!({
            "ok": false,
            "reason": "missing_path",
            "message": "Es wurde kein Pfad zum Oeffnen uebergeben."
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
                "message": format!("Pfad wurde nicht gefunden: {}", resolved.to_string_lossy()),
                "path": resolved.to_string_lossy(),
            }));
        }
    };

    if !metadata.is_dir() && is_blocked_executable(&resolved) {
        return Ok(json!({
            "ok": false,
            "reason": "blocked_executable",
            "message": format!("Aus Sicherheitsgruenden wird diese Datei nicht direkt geoeffnet: {}", resolved.to_string_lossy()),
            "path": resolved.to_string_lossy(),
        }));
    }

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
        "action": "open_path",
        "path": resolved.to_string_lossy(),
        "kind": if metadata.is_dir() { "directory" } else { "file" },
        "message": format!("Geoeffnet: {}", resolved.to_string_lossy()),
    }))
}

fn match_known_application(app_name: &str) -> Option<&'static KnownApplicationDefinition> {
    let normalized = normalize_app_name(app_name);
    KNOWN_APPLICATIONS.iter().find(|item| item.aliases.iter().any(|alias| *alias == normalized))
}

fn launch_known_application(app_name: &str) -> Result<Value, String> {
    let Some(definition) = match_known_application(app_name) else {
        return Ok(json!({
            "ok": false,
            "reason": "unknown_application",
            "message": format!("Die Anwendung \"{}\" ist in diesem Prototyp nicht bekannt.", app_name),
            "availableApplications": KNOWN_APPLICATIONS.iter().map(|item| json!({
                "key": item.key,
                "displayName": item.display_name,
                "aliases": item.aliases,
            })).collect::<Vec<_>>(),
        }));
    };

    let target = resolve_application_target(definition)?;
    let Some(target) = target else {
        return Ok(json!({
            "ok": false,
            "reason": "application_not_found",
            "message": format!("Die Anwendung \"{}\" wurde auf diesem PC nicht gefunden.", definition.display_name),
            "application": definition.display_name,
        }));
    };

    start_resolved_target(&target)?;

    let (resolved_by, target_value) = match target {
        ApplicationTarget::Command(value) => ("command", value),
        ApplicationTarget::Path(value) => ("path", value),
        ApplicationTarget::AppId(value) => ("appId", value),
    };

    Ok(json!({
        "ok": true,
        "action": "launch_app",
        "application": definition.display_name,
        "resolvedBy": resolved_by,
        "target": target_value,
        "message": format!("{} wurde gestartet.", definition.display_name),
    }))
}

fn resolve_application_target(
    definition: &'static KnownApplicationDefinition,
) -> Result<Option<ApplicationTarget>, String> {
    for command in definition.commands {
        let script = format!(
            "Get-Command '{}' -ErrorAction Stop | Out-Null",
            escape_powershell_literal(command)
        );
        let output = run_powershell_output(&script)?;
        if output.success {
            return Ok(Some(ApplicationTarget::Command((*command).to_string())));
        }
    }

    let install_roots = ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(|key| env::var(key).ok())
        .map(PathBuf::from)
        .collect::<Vec<_>>();

    for root in &install_roots {
        for relative in definition.candidate_relative_paths {
            let candidate = root.join(relative);
            if candidate.exists() {
                return Ok(Some(ApplicationTarget::Path(candidate.to_string_lossy().to_string())));
            }
        }
    }

    if let Some(app_id) = resolve_start_menu_app_id(definition.start_menu_terms)? {
        return Ok(Some(ApplicationTarget::AppId(app_id)));
    }

    for root in &install_roots {
        if let Some(path) = search_for_executable(root, definition.executable_names, 5000)? {
            return Ok(Some(ApplicationTarget::Path(path.to_string_lossy().to_string())));
        }
    }

    Ok(None)
}

fn resolve_start_menu_app_id(search_terms: &[&str]) -> Result<Option<String>, String> {
    for term in search_terms {
        let script = format!(
            "$match = Get-StartApps | Where-Object {{ $_.Name -like '*{}*' -or $_.AppID -like '*{}*' }} | Select-Object -First 1; if ($match) {{ $match.AppID }}",
            escape_powershell_literal(term),
            escape_powershell_literal(term)
        );
        let output = run_powershell_output(&script)?;
        let app_id = output.stdout.trim().to_string();
        if output.success && !app_id.is_empty() {
            return Ok(Some(app_id));
        }
    }
    Ok(None)
}

fn search_for_executable(root: &Path, executable_names: &[&str], max_directories: usize) -> Result<Option<PathBuf>, String> {
    let targets = executable_names.iter().map(|name| name.to_lowercase()).collect::<HashSet<_>>();
    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut visited = HashSet::new();
    let mut directories_visited = 0usize;

    while let Some(current) = queue.pop_front() {
        if directories_visited >= max_directories {
            break;
        }
        let key = current.to_string_lossy().to_string();
        if visited.contains(&key) {
            continue;
        }
        visited.insert(key);
        directories_visited += 1;

        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();

            if metadata.is_file() && targets.contains(&name.to_lowercase()) {
                return Ok(Some(path));
            }
            if metadata.is_dir() {
                queue.push_back(path);
            }
        }
    }

    Ok(None)
}

fn start_resolved_target(target: &ApplicationTarget) -> Result<(), String> {
    let script = match target {
        ApplicationTarget::Command(value) => format!("Start-Process -FilePath '{}'", escape_powershell_literal(value)),
        ApplicationTarget::Path(value) => format!("Start-Process -LiteralPath '{}'", escape_powershell_literal(value)),
        ApplicationTarget::AppId(value) => format!("Start-Process 'shell:AppsFolder\\{}'", escape_powershell_literal(value)),
    };
    let output = run_powershell_output(&script)?;
    if output.success {
        Ok(())
    } else {
        Err(combined_output(&output))
    }
}

fn resolve_specialist_route<'a>(task: &str, specialist: &str) -> Option<SpecialistRoute<'a>> {
    let normalized_choice = specialist.trim().to_lowercase();
    if !normalized_choice.is_empty() && normalized_choice != "auto" {
        let definition = SPECIALISTS.iter().find(|item| item.id == normalized_choice)?;
        return Some(SpecialistRoute {
            specialist: definition,
            confidence: "explicit",
            reason: format!("Explizit angeforderter Spezialagent: {}.", definition.id),
            scores: Value::Null,
        });
    }

    let haystack = task.to_lowercase();
    let mut scores = SPECIALISTS
        .iter()
        .map(|definition| {
            let score = definition.keywords.iter().filter(|keyword| haystack.contains(**keyword)).count() as u64;
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
            format!("Automatisch an {} geroutet, weil die Aufgabe eher zu {} passt.", chosen.id, chosen.when_to_use)
        } else {
            "Keine klaren Coding-Signale erkannt. Fallback auf pc-ops.".to_string()
        },
        scores: Value::Array(scores.into_iter().map(|(definition, score)| json!({
            "specialistId": definition.id,
            "score": score,
        })).collect::<Vec<_>>()),
    })
}

fn build_specialist_task_payload(specialist_id: &str, task: &str, routing_reason: &str, context: &str) -> String {
    let definition = SPECIALISTS.iter().find(|item| item.id == specialist_id).expect("known specialist");
    let context_block = if context.trim().is_empty() {
        String::new()
    } else {
        format!("Zusatzkontext vom Voice-Orchestrator:\n{}\n\n", context.trim())
    };

    [
        format!("Du bist der Spezialagent {}.", definition.id),
        definition.description.to_string(),
        String::new(),
        format!("Routing-Hinweis: {}", routing_reason),
        context_block,
        "Arbeitsauftrag:".to_string(),
        task.to_string(),
        String::new(),
        "Antwortvertrag:".to_string(),
        "- Wenn Informationen fehlen, stelle genau eine knappe Rueckfrage.".to_string(),
        "- Wenn du die Aufgabe erledigen kannst, fuehre sie aus statt lange zu planen.".to_string(),
        "- Fasse am Ende knapp zusammen, was du getan hast und welches Ergebnis vorliegt.".to_string(),
    ].into_iter().filter(|line| !line.trim().is_empty()).collect::<Vec<_>>().join("\n")
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
    let definition = SPECIALISTS.iter().find(|item| item.id == specialist_id).ok_or_else(|| format!("Unknown specialist: {specialist_id}"))?;
    let workspace_path = specialist_workspace_path(definition.id);
    fs::create_dir_all(&workspace_path).map_err(|error| format!("Failed to create workspace {}: {error}", workspace_path.to_string_lossy()))?;

    ensure_file(&workspace_path.join("IDENTITY.md"), &build_identity_content(definition))?;
    ensure_file(&workspace_path.join("SOUL.md"), &build_soul_content(definition))?;
    ensure_file(&workspace_path.join("TOOLS.md"), &build_tools_content(definition))?;

    let existing_agents = list_openclaw_agents()?;
    if let Some(existing) = existing_agents.iter().find(|agent| {
        agent.get("id").and_then(Value::as_str).map(|value| value == definition.id).unwrap_or(false)
    }) {
        return Ok(json!({
            "specialistId": specialist_id,
            "created": false,
            "workspacePath": workspace_path.to_string_lossy(),
            "agent": existing,
        }));
    }

    let add_script = format!(
        "openclaw agents add '{}' --non-interactive --workspace '{}' --model 'openai-codex/gpt-5.4' --json",
        escape_powershell_literal(definition.id),
        escape_powershell_literal(&workspace_path.to_string_lossy())
    );
    let add_output = run_powershell_output(&add_script)?;
    if !add_output.success {
        return Err(combined_output(&add_output));
    }

    let identity_script = format!(
        "openclaw agents set-identity --agent '{}' --name '{}' --theme '{}' --json",
        escape_powershell_literal(definition.id),
        escape_powershell_literal(definition.name),
        escape_powershell_literal(definition.theme)
    );
    let _ = run_powershell_output(&identity_script);

    let agent = list_openclaw_agents()?
        .into_iter()
        .find(|item| item.get("id").and_then(Value::as_str).map(|value| value == definition.id).unwrap_or(false))
        .unwrap_or_else(|| json!({
            "id": definition.id,
            "workspace": workspace_path.to_string_lossy(),
        }));

    Ok(json!({
        "specialistId": specialist_id,
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
            "message": "Es wurde keine OpenClaw-Aufgabe uebergeben."
        }));
    }

    let normalized_prefer_mode = normalize_prefer_mode(prefer_mode);
    let status = get_openclaw_status_tool()?;
    if !status.get("installed").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(json!({
            "ok": false,
            "reason": "openclaw_not_installed",
            "message": "OpenClaw ist auf diesem PC nicht installiert."
        }));
    }

    let gateway_available = status.get("gatewayAvailable").and_then(Value::as_bool).unwrap_or(false);
    let chosen_mode = if normalized_prefer_mode == "auto" {
        if gateway_available { "gateway" } else { "local" }
    } else {
        normalized_prefer_mode
    };

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
        let file_lock_detected = diagnostics.contains("session file locked") || diagnostics.contains(".jsonl.lock");
        return Ok(json!({
            "ok": false,
            "mode": chosen_mode,
            "task": trimmed_task,
            "reason": if timeout_detected { "openclaw_timeout" } else if file_lock_detected { "openclaw_session_locked" } else { "openclaw_task_failed" },
            "message": diagnostics,
            "status": status,
        }));
    }

    let payload = extract_json_value(&format!("{}\n{}", output.stdout, output.stderr))?;
    let message = payload
        .get("payloads")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "OpenClaw hat die Aufgabe verarbeitet.".to_string());

    Ok(json!({
        "ok": true,
        "mode": chosen_mode,
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
    project_root().join("data").join("openclaw-specialists").join(specialist_id)
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
    ].join("\n")
}

fn build_soul_content(definition: &SpecialistDefinition) -> String {
    let guardrail = if definition.id == "coder" {
        [
            "Coding rules:",
            &format!("- Default project root: {}", project_root().to_string_lossy()),
            "- Stay inside the requested project path unless the task explicitly says otherwise.",
            "- Inspect before editing.",
            "- Avoid unrelated files.",
            "- Run verification where practical and report what was verified.",
        ].join("\n")
    } else {
        [
            "Desktop rules:",
            &format!("- Primary user home: {}", home_dir().to_string_lossy()),
            &format!("- Common target folders: {}, {}, {}", home_dir().join("Desktop").to_string_lossy(), home_dir().join("Documents").to_string_lossy(), home_dir().join("Downloads").to_string_lossy()),
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
    ].join("\n")
}

fn build_tools_content(definition: &SpecialistDefinition) -> String {
    [
        "# TOOLS.md".to_string(),
        String::new(),
        "Local notes for this specialist:".to_string(),
        format!("- Role: {}", definition.description),
        format!("- Use when: {}", definition.when_to_use),
        if definition.id == "coder" {
            format!("- Current repository root: {}", project_root().to_string_lossy())
        } else {
            format!("- Current user home: {}", home_dir().to_string_lossy())
        },
        String::new(),
    ].join("\n")
}

fn ensure_file(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, content).map_err(|error| format!("Failed to write {}: {error}", path.to_string_lossy()))
}

fn is_ignored_directory(name: &str) -> bool {
    IGNORED_DIRECTORIES.iter().any(|item| item.eq_ignore_ascii_case(name.trim()))
}

fn is_blocked_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| format!(".{}", extension).to_lowercase())
        .map(|extension| BLOCKED_EXECUTABLE_EXTENSIONS.contains(&extension.as_str()))
        .unwrap_or(false)
}

fn normalize_app_name(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn common_location_paths() -> Vec<PathBuf> {
    let current_dir = env::current_dir().ok();
    let home = home_dir();
    [current_dir, Some(home.join("Desktop")), Some(home.join("Documents")), Some(home.join("Downloads"))]
        .into_iter()
        .flatten()
        .filter(|path| path.exists())
        .collect::<Vec<_>>()
}

fn common_locations() -> Vec<String> {
    common_location_paths()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn home_dir() -> PathBuf {
    env::var("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|_| env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("C:\\"))
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

fn combined_output(output: &ShellOutput) -> String {
    [output.stderr.trim(), output.stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_json_value(raw_text: &str) -> Result<Value, String> {
    let raw = raw_text.trim();
    let object_index = raw.find('{');
    let array_index = raw.find('[');
    let start_index = match (object_index, array_index) {
        (Some(left), Some(right)) => left.min(right),
        (Some(left), None) => left,
        (None, Some(right)) => right,
        (None, None) => return Err(format!("OpenClaw/PowerShell returned no JSON payload. Raw output: {}", raw)),
    };

    serde_json::from_str(&raw[start_index..]).map_err(|error| format!("Failed to decode JSON payload: {error}"))
}
