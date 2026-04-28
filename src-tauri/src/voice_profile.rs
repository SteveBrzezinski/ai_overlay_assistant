use crate::realtime_voice::sanitize_realtime_voice_for_model;
use crate::settings::{
    default_voice_agent_preferred_language, sanitize_voice_agent_gender,
    sanitize_voice_agent_model, AppSettings,
};
use serde::Serialize;

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
    pub gender: String,
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

pub fn build_voice_agent_profile(settings: &AppSettings) -> VoiceAgentProfile {
    VoiceAgentProfile {
        name: sanitize_line(&settings.assistant_name, "AIVA"),
        voice: sanitize_realtime_voice_for_model(
            &settings.voice_agent_voice,
            &settings.voice_agent_model,
        ),
        model: sanitize_voice_agent_model(settings.voice_agent_model.clone()),
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
            gender: sanitize_voice_agent_gender(settings.voice_agent_gender.clone()),
            tone_notes: sanitize_multiline(&settings.voice_agent_tone_notes, ""),
        },
        onboarding_complete: settings.voice_agent_onboarding_complete,
        source_assistant_name: sanitize_line(&settings.assistant_name, "AIVA"),
    }
}

fn voice_agent_gender_label(gender: &str) -> &'static str {
    match gender {
        "masculine" => "masculine",
        "neutral" => "neutral",
        _ => "feminine",
    }
}

fn voice_agent_gender_guidance(gender: &str) -> &'static str {
    match gender {
        "masculine" => {
            "Use masculine self-references when gendered wording is natural. If pronouns matter, prefer he/him in English and masculine role words such as 'Assistent' in German."
        }
        "neutral" => {
            "Prefer neutral self-references whenever natural. Avoid unnecessary gendered wording. If pronouns matter in English, prefer they/them."
        }
        _ => {
            "Use feminine self-references when gendered wording is natural. If pronouns matter, prefer she/her in English and feminine role words such as 'Assistentin' in German."
        }
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
        format!("Configured gender: {}", voice_agent_gender_label(&identity.gender)),
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
        format!("- Use {} by default.", identity.preferred_language),
        format!(
            "- Your configured gender presentation is {}. {}",
            voice_agent_gender_label(&identity.gender),
            voice_agent_gender_guidance(&identity.gender)
        ),
        if identity_block.is_empty() {
            String::new()
        } else {
            format!("- Stored identity notes:\n{}", identity_block)
        },
        String::new(),
        extra_block,
        "Tool rules:".to_string(),
        "1. For anything related to the local machine, use the generic local tools like discover_environment, get_current_time, search_paths, stat_path, open_target, read_path, write_path, move_path, copy_path, delete_path, list_processes, start_process, and stop_process before guessing.".to_string(),
        "2. For public web facts, current events, recent releases, prices, live public information, or anything that may have changed recently, use web_search before answering.".to_string(),
        "3. If a machine action is unclear, risky, or ambiguous, ask a targeted follow-up question immediately.".to_string(),
        "4. If a task takes longer, briefly say that it is running in the background and report back naturally when it finishes.".to_string(),
        "5. Treat messages prefixed with SYSTEM_EVENT: as internal status messages from the local task and tool layer. Do not read the prefix aloud.".to_string(),
        "6. Delegate document automation, complex desktop workflows, UI click-paths, or unclear file formats to pc-ops. Delegate code, repository, test, and scripting tasks to coder.".to_string(),
        "7. Use delegate_to_openclaw only for raw OpenClaw delegation when the user explicitly wants it or the specialist structure does not fit.".to_string(),
        "8. update_assistant_state may store voice, personality, behavior, and extra instructions, but it must not change your name.".to_string(),
        "9. On deactivation, compact daily memory lines are stored locally. If the user asks about earlier sessions, files, paths, or tasks, use recall_memory instead of guessing.".to_string(),
        "10. For questions about the current time, date, weekday, timezone, or 'right now', use get_current_time instead of guessing.".to_string(),
        "11. Use the timer tools for countdowns, reminders, pauses, resumptions, deletions, renames, duration changes, or questions about remaining time. If no timer title is given, the local tool layer will generate one. When a timer has already finished and the user asks to stop, silence, dismiss, remove, or clear it, dismiss the finished timer so the repeating alert stops.".to_string(),
        "12. Treat timer-completion SYSTEM_EVENT messages as background reminders. Announce them naturally without the prefix.".to_string(),
        "13. Before every answer to a new user turn, silently run a conversation-end check: decide whether the latest user turn means the conversation should end now or remain open.".to_string(),
        "14. Treat direct sign-offs, dismissals, and final confirmations as conversation endings even when they are extremely short or appear immediately after activation. If the user wakes you and then says a brief goodbye, dismissal, or 'that is all' style turn as their first request, end the conversation instead of continuing it.".to_string(),
        "15. If you ask the user a follow-up question, ask for confirmation, or otherwise leave the turn open for the user to answer, the conversation is not over. In that case do not use deactivate_voice_assistant.".to_string(),
        "16. If the conversation-end check is positive or even moderately likely, reply with exactly one very short farewell in the user's language and then use deactivate_voice_assistant as the final step. The farewell and the tool call belong to the same closing turn: first finish the farewell, then call the tool last.".to_string(),
        "17. Closing farewells must stay minimal. Prefer one short sentence or one to four words such as 'Tschuess.', 'Bis dann.', 'Mach's gut.', or 'Goodbye.' Do not say meta phrases like 'Dann verabschiede ich mich jetzt', do not explain that you are shutting down, and do not add new help or suggestions.".to_string(),
        "18. If you decide to say any closing or farewell at all, calling deactivate_voice_assistant in that same turn is mandatory. A spoken sign-off without the tool is a mistake.".to_string(),
        "19. If you are unsure whether the user is done, keep the conversation open. Do not say goodbye unless you truly intend to end the conversation now.".to_string(),
        "20. Keep responses concise, natural, and conversational by default.".to_string(),
        "21. If a SYSTEM_EVENT says a selected context bucket exists, do not answer that notice. When a later SYSTEM_EVENT attaches selected context bucket contents, use that content only for the immediately following user request.".to_string(),
    ]
    .into_iter()
    .filter(|line| !line.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::build_assistant_instructions;
    use crate::settings::AppSettings;

    #[test]
    fn assistant_instructions_include_explicit_conversation_end_policy() {
        let instructions = build_assistant_instructions(&AppSettings::default());

        assert!(instructions.contains("silently run a conversation-end check"));
        assert!(instructions.contains("appear immediately after activation"));
        assert!(instructions.contains("very short farewell"));
        assert!(instructions.contains("one to four words"));
        assert!(instructions.contains("the conversation is not over"));
        assert!(instructions.contains("deactivate_voice_assistant as the final step"));
        assert!(instructions.contains("first finish the farewell, then call the tool last"));
        assert!(instructions.contains("spoken sign-off without the tool is a mistake"));
    }
}
