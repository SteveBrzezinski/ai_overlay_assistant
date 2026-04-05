use crate::{
    hosted_backend::create_hosted_realtime_session,
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
    pub provider_mode: String,
    pub hosted_session_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub hosted_team_slug: Option<String>,
    pub client_secret_expires_at: Option<String>,
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
    let mut profile = build_voice_agent_profile(&app_settings);
    let mut assistant_state = build_voice_agent_state(&app_settings);
    let instructions = build_assistant_instructions(&app_settings);

    if app_settings.ai_provider_mode == "hosted" {
        let hosted_session = create_hosted_realtime_session(
            &app_settings,
            instructions,
            profile.model.clone(),
            profile.voice.clone(),
        )?;

        profile.model = hosted_session.model;
        profile.voice = hosted_session.voice;
        assistant_state.profile = profile.clone();

        return Ok(CreateVoiceAgentSessionResult {
            client_secret: hosted_session.client_secret,
            profile,
            assistant_state,
            bootstrap_action: "silent_resume".to_string(),
            provider_mode: "hosted".to_string(),
            hosted_session_id: Some(hosted_session.hosted_session_id),
            provider_session_id: hosted_session.provider_session_id,
            hosted_team_slug: Some(hosted_session.team.slug),
            client_secret_expires_at: hosted_session.client_secret_expires_at,
        });
    }

    let api_key = resolve_openai_api_key(&app_settings)?;

    let session_payload = json!({
        "session": {
            "type": "realtime",
            "model": profile.model,
            "instructions": instructions,
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
        provider_mode: "byo".to_string(),
        hosted_session_id: None,
        provider_session_id: None,
        hosted_team_slug: None,
        client_secret_expires_at: None,
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
