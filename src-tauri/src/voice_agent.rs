use crate::{
    settings::{resolve_openai_api_key, SettingsState},
    voice_profile::{
        build_assistant_instructions, build_voice_agent_profile, build_voice_agent_state,
        VoiceAgentProfile, VoiceAgentState,
    },
    voice_tools::{realtime_tools, run_voice_agent_tool},
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVoiceAgentSessionResult {
    pub client_secret: String,
    pub profile: VoiceAgentProfile,
    pub assistant_state: VoiceAgentState,
    pub bootstrap_action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunVoiceAgentToolResult {
    pub ok: bool,
    pub tool_name: String,
    pub result: Value,
}

#[tauri::command]
pub fn create_voice_agent_session_command(
    settings: State<'_, SettingsState>,
) -> Result<CreateVoiceAgentSessionResult, String> {
    let app_settings = settings.get();
    let api_key = resolve_openai_api_key(&app_settings)?;
    let profile = build_voice_agent_profile(&app_settings);
    let assistant_state = build_voice_agent_state(&app_settings);

    let session_payload = json!({
        "session": {
            "type": "realtime",
            "model": profile.model,
            "instructions": build_assistant_instructions(&app_settings),
            "audio": {
                "output": {
                    "voice": profile.voice,
                }
            },
            "tools": realtime_tools(),
            "tool_choice": "auto",
        }
    });

    let client = reqwest::blocking::Client::new();
    let response = client
        .post("https://api.openai.com/v1/realtime/client_secrets")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&session_payload)
        .send()
        .map_err(|error| format!("OpenAI session creation failed: {error}"))?;

    let status = response.status();
    let payload: Value = response
        .json()
        .map_err(|error| format!("Failed to decode OpenAI session response: {error}"))?;

    if !status.is_success() {
        return Err(format!("OpenAI session creation failed ({status}): {payload}"));
    }

    let client_secret = payload
        .get("value")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OpenAI session response did not contain a client secret.".to_string())?
        .to_string();

    Ok(CreateVoiceAgentSessionResult {
        client_secret,
        profile,
        assistant_state,
        bootstrap_action: "silent_resume".to_string(),
    })
}

#[tauri::command]
pub fn run_voice_agent_tool_command(
    tool_name: String,
    args: Value,
    app: AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<RunVoiceAgentToolResult, String> {
    let result = run_voice_agent_tool(&tool_name, args, &app, &settings)?;
    Ok(RunVoiceAgentToolResult { ok: true, tool_name, result })
}
