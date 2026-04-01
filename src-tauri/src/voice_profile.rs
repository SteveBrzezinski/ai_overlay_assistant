use crate::settings::AppSettings;
use serde::Serialize;

const SUPPORTED_REALTIME_VOICES: &[&str] = &[
    "alloy",
    "ash",
    "ballad",
    "cedar",
    "coral",
    "echo",
    "marin",
    "sage",
    "shimmer",
    "verse",
];

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
    let normalized = value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

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
            "Souveraen, technisch praezise, freundlich und knapp.",
        ),
        behavior: sanitize_multiline(
            &settings.voice_agent_behavior,
            "Wenn eine PC-Aufgabe unklar ist, frage sofort nach. Wenn etwas laenger dauert, kuendige es kurz an und melde dich spaeter mit dem Ergebnis.",
        ),
        extra_instructions: sanitize_multiline(
            &settings.voice_agent_extra_instructions,
            "Sprich standardmaessig Deutsch. Verwende den gespeicherten Assistant-Namen unveraendert und nenne dich nicht anders.",
        ),
    }
}

pub fn build_voice_agent_state(settings: &AppSettings) -> VoiceAgentState {
    VoiceAgentState {
        profile: build_voice_agent_profile(settings),
        identity: VoiceAgentIdentity {
            preferred_language: sanitize_line(
                &settings.voice_agent_preferred_language,
                "Deutsch",
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
        format!("Zusaetzliche Vorgaben:\n{}\n", profile.extra_instructions)
    };

    let identity_block = [
        format!("Bevorzugte Sprache: {}", identity.preferred_language),
        if identity.tone_notes.trim().is_empty() {
            String::new()
        } else {
            format!("Weitere Tonalitaetsnotizen: {}", identity.tone_notes)
        },
    ]
    .into_iter()
    .filter(|line| !line.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");

    [
        format!(
            "Du bist {}, ein sprachbasierter Desktop-Assistent, der in Echtzeit mit dem Nutzer spricht.",
            profile.name
        ),
        String::new(),
        "Persoenlichkeit:".to_string(),
        profile.personality.clone(),
        String::new(),
        "Verhalten:".to_string(),
        profile.behavior.clone(),
        String::new(),
        "Feste Identitaetsregeln:".to_string(),
        format!(
            "- Dein Name ist fest auf {} gesetzt und kommt aus der Wake-Word-Konfiguration. Aendere ihn niemals selbst.",
            state.source_assistant_name
        ),
        format!(
            "- Verwende standardmaessig {}.",
            identity.preferred_language
        ),
        if identity_block.is_empty() {
            String::new()
        } else {
            format!("- Gespeicherte Identitaetsnotizen:\n{}", identity_block)
        },
        String::new(),
        extra_block,
        "Werkzeugregeln:".to_string(),
        "1. Fuer alles, was den lokalen PC betrifft, nutze zuerst den vorhandenen PC-Kontext und die verfuegbaren Werkzeuge statt zu raten.".to_string(),
        "2. Wenn eine Aktion auf dem PC unklar, riskant oder mehrdeutig ist, stelle sofort eine gezielte Rueckfrage.".to_string(),
        "3. Wenn eine Aufgabe laenger dauert, erklaere kurz, dass sie im Hintergrund laeuft, und melde das Ergebnis spaeter natuerlich nach.".to_string(),
        "4. Behandle Nachrichten mit dem Praefix SYSTEM_EVENT: als interne Statusmeldungen des lokalen Task- und Tool-Layers. Lies das Praefix nicht vor.".to_string(),
        "5. Oeffne keine ausfuehrbaren Dateien wie .exe, .bat, .cmd oder .ps1 ohne ausdrueckliche Bestaetigung.".to_string(),
        "6. Nutze submit_pc_task mit action launch_app fuer bekannte Anwendungen wie Word, Excel, PowerPoint, Notepad, Calculator, Paint oder Explorer.".to_string(),
        "7. Nutze delegate_to_specialist fuer komplexere Aufgaben. Der Spezialagent pc-ops ist fuer Desktop- und Datei-Aufgaben gedacht, coder fuer Coding-, Repo- und Implementierungsaufgaben.".to_string(),
        "8. Nutze delegate_to_openclaw nur fuer rohe OpenClaw-Delegation, wenn der Nutzer das ausdruecklich will oder die Spezialagentenstruktur nicht passt.".to_string(),
        "9. update_assistant_state darf Stimme, Persoenlichkeit, Verhalten und Zusatzvorgaben speichern, aber nicht deinen Namen veraendern.".to_string(),
        "10. Halte Antworten standardmaessig kurz, natuerlich und gespraechig.".to_string(),
    ]
    .into_iter()
    .filter(|line| !line.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}
