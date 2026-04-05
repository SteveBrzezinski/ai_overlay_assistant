use crate::settings::{default_voice_agent_preferred_language, AppSettings};
use serde::Serialize;

const SUPPORTED_REALTIME_VOICES: &[&str] =
    &["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAgentProfile {
    pub name: String,
    pub voice: String,
    pub model: String,
    pub personality: String,
    pub behavior: String,
    pub extra_instructions: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAgentIdentity {
    pub preferred_language: String,
    pub tone_notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAgentState {
    pub profile: VoiceAgentProfile,
    pub identity: VoiceAgentIdentity,
    pub onboarding_complete: bool,
    pub source_assistant_name: String,
}

fn sanitize_line(value: &str, fallback: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn sanitize_multiline(value: &str, fallback: &str) -> String {
    let normalized =
        value.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n");

    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

pub fn sanitize_realtime_voice(value: &str, fallback: &str) -> String {
    let normalized = sanitize_line(value, fallback).to_lowercase();
    if SUPPORTED_REALTIME_VOICES.contains(&normalized.as_str()) {
        normalized
    } else {
        fallback.to_string()
    }
}

pub fn build_voice_agent_profile(settings: &AppSettings) -> VoiceAgentProfile {
    VoiceAgentProfile {
        name: sanitize_line(&settings.assistant_name, "AIVA"),
        voice: sanitize_realtime_voice(&settings.voice_agent_voice, "marin"),
        model: sanitize_line(&settings.voice_agent_model, "gpt-realtime"),
        personality: sanitize_multiline(
            &settings.voice_agent_personality,
            "Composed, technically precise, friendly, and concise.",
        ),
        behavior: sanitize_multiline(
            &settings.voice_agent_behavior,
            "If a PC task is unclear, ask immediately. If something takes longer, acknowledge it briefly and follow up with the result.",
        ),
        extra_instructions: sanitize_multiline(
            &settings.voice_agent_extra_instructions,
            "Keep using the stored assistant name unchanged and do not rename yourself.",
        ),
    }
}

pub fn build_voice_agent_state(settings: &AppSettings) -> VoiceAgentState {
    VoiceAgentState {
        profile: build_voice_agent_profile(settings),
        identity: VoiceAgentIdentity {
            preferred_language: sanitize_line(
                &settings.voice_agent_preferred_language,
                &default_voice_agent_preferred_language(&settings.stt_language),
            ),
            tone_notes: sanitize_multiline(&settings.voice_agent_tone_notes, ""),
        },
        onboarding_complete: settings.voice_agent_onboarding_complete,
        source_assistant_name: sanitize_line(&settings.assistant_name, "AIVA"),
    }
}

pub fn build_assistant_instructions(settings: &AppSettings) -> String {
    let state = build_voice_agent_state(settings);
    let profile = &state.profile;
    let identity = &state.identity;
    let extra_block = if profile.extra_instructions.trim().is_empty() {
        String::new()
    } else {
        format!("Additional instructions:\n{}\n", profile.extra_instructions)
    };

    let identity_block = [
        format!("Preferred language: {}", identity.preferred_language),
        if identity.tone_notes.trim().is_empty() {
            String::new()
        } else {
            format!("Additional tone notes: {}", identity.tone_notes)
        },
    ]
    .into_iter()
    .filter(|line| !line.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");

    [
        format!(
            "You are {}, a voice-based desktop assistant that speaks with the user in real time.",
            profile.name
        ),
        String::new(),
        "Personality:".to_string(),
        profile.personality.clone(),
        String::new(),
        "Behavior:".to_string(),
        profile.behavior.clone(),
        String::new(),
        "Identity rules:".to_string(),
        format!(
            "- Your name is fixed to {} and comes from the wake-word configuration. Never change it yourself.",
            state.source_assistant_name
        ),
        format!(
            "- Use {} by default.",
            identity.preferred_language
        ),
        if identity_block.is_empty() {
            String::new()
        } else {
            format!("- Stored identity notes:\n{}", identity_block)
        },
        String::new(),
        extra_block,
        "Tool rules:".to_string(),
        "1. For anything related to the local machine, use the generic local tools like discover_environment, search_paths, stat_path, open_target, read_path, write_path, move_path, copy_path, delete_path, list_processes, start_process, and stop_process before guessing.".to_string(),
        "2. If a machine action is unclear, risky, or ambiguous, ask a targeted follow-up question immediately.".to_string(),
        "3. If a task takes longer, briefly say that it is running in the background and report back naturally when it finishes.".to_string(),
        "4. Treat messages prefixed with SYSTEM_EVENT: as internal status messages from the local task and tool layer. Do not read the prefix aloud.".to_string(),
        "5. Delegate document automation, complex desktop workflows, UI click-paths, or unclear file formats to pc-ops. Delegate code, repository, test, and scripting tasks to coder.".to_string(),
        "6. Use delegate_to_openclaw only for raw OpenClaw delegation when the user explicitly wants it or the specialist structure does not fit.".to_string(),
        "7. update_assistant_state may store voice, personality, behavior, and extra instructions, but it must not change your name.".to_string(),
        "8. On deactivation, compact daily memory lines are stored locally. If the user asks about earlier sessions, files, paths, or tasks, use recall_memory instead of guessing.".to_string(),
        "9. When the conversation ends naturally, say goodbye briefly and then use deactivate_voice_assistant as the final step.".to_string(),
        "10. Keep responses concise, natural, and conversational by default.".to_string(),
    ]
    .into_iter()
    .filter(|line| !line.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}
