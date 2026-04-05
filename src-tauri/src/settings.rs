use crate::background;
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const DEFAULT_SPEAK_HOTKEY: &str = "Ctrl+Shift+Space";
pub const DEFAULT_TRANSLATE_HOTKEY: &str = "Ctrl+Shift+T";
pub const DEFAULT_PAUSE_RESUME_HOTKEY: &str = "Ctrl+Shift+P";
pub const DEFAULT_CANCEL_HOTKEY: &str = "Ctrl+Shift+X";
pub const SETTINGS_EVENT: &str = "settings-updated";
pub const CONFIG_FILE_NAME: &str = ".voice-overlay-assistant.config.json";
const DEFAULT_PLAYBACK_SPEED: f32 = 1.0;
const DEFAULT_ASSISTANT_WAKE_THRESHOLD: u8 = 68;
const DEFAULT_ASSISTANT_CUE_COOLDOWN_MS: u32 = 1200;
const DEFAULT_VOICE_AGENT_PERSONALITY: &str =
    "Composed, technically precise, friendly, and concise.";
const DEFAULT_VOICE_AGENT_BEHAVIOR: &str =
    "If a PC task is unclear, ask immediately. If something takes longer, acknowledge it briefly and follow up with the result.";
const DEFAULT_VOICE_AGENT_EXTRA_INSTRUCTIONS: &str =
    "Keep using the stored assistant name unchanged and do not rename yourself.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub ui_language: String,
    pub translation_target_language: String,
    pub playback_speed: f32,
    pub openai_api_key: String,
    pub stt_language: String,
    pub launch_at_login: bool,
    pub start_hidden_on_launch: bool,
    pub assistant_name: String,
    pub voice_agent_model: String,
    pub voice_agent_voice: String,
    pub voice_agent_personality: String,
    pub voice_agent_behavior: String,
    pub voice_agent_extra_instructions: String,
    pub voice_agent_preferred_language: String,
    pub voice_agent_tone_notes: String,
    pub voice_agent_onboarding_complete: bool,
    pub assistant_wake_samples: Vec<String>,
    pub assistant_name_samples: Vec<String>,
    pub assistant_sample_language: String,
    pub assistant_wake_threshold: u8,
    pub assistant_cue_cooldown_ms: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            ui_language: "en".to_string(),
            translation_target_language: "en".to_string(),
            playback_speed: DEFAULT_PLAYBACK_SPEED,
            openai_api_key: String::new(),
            stt_language: "de".to_string(),
            launch_at_login: false,
            start_hidden_on_launch: true,
            assistant_name: "AIVA".to_string(),
            voice_agent_model: "gpt-realtime".to_string(),
            voice_agent_voice: "marin".to_string(),
            voice_agent_personality: DEFAULT_VOICE_AGENT_PERSONALITY.to_string(),
            voice_agent_behavior: DEFAULT_VOICE_AGENT_BEHAVIOR.to_string(),
            voice_agent_extra_instructions: DEFAULT_VOICE_AGENT_EXTRA_INSTRUCTIONS.to_string(),
            voice_agent_preferred_language: default_voice_agent_preferred_language("de"),
            voice_agent_tone_notes: String::new(),
            voice_agent_onboarding_complete: true,
            assistant_wake_samples: Vec::new(),
            assistant_name_samples: Vec::new(),
            assistant_sample_language: "de".to_string(),
            assistant_wake_threshold: DEFAULT_ASSISTANT_WAKE_THRESHOLD,
            assistant_cue_cooldown_ms: DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageOption {
    pub code: &'static str,
    pub label: &'static str,
}

pub const LANGUAGE_OPTIONS: &[LanguageOption] = &[
    LanguageOption { code: "de", label: "German" },
    LanguageOption { code: "en", label: "English" },
    LanguageOption { code: "fr", label: "Français" },
    LanguageOption { code: "es", label: "Español" },
    LanguageOption { code: "it", label: "Italiano" },
    LanguageOption { code: "pt", label: "Português" },
    LanguageOption { code: "pl", label: "Polski" },
    LanguageOption { code: "nl", label: "Nederlands" },
    LanguageOption { code: "tr", label: "Türkçe" },
    LanguageOption { code: "ja", label: "日本語" },
];

pub struct SettingsState {
    settings: Mutex<AppSettings>,
    config_path: PathBuf,
}

impl SettingsState {
    pub fn load_or_create(config_path: PathBuf) -> Result<Self, String> {
        let loaded = match fs::read_to_string(&config_path) {
            Ok(contents) => match serde_json::from_str::<AppSettings>(&contents) {
                Ok(settings) => sanitize_settings(settings),
                Err(error) => {
                    eprintln!(
                        "[settings] Failed to parse config file '{}': {error}. Falling back to defaults.",
                        config_path.display()
                    );
                    AppSettings::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppSettings::default(),
            Err(error) => {
                return Err(format!(
                    "Failed to read config file '{}': {error}",
                    config_path.display()
                ))
            }
        };

        write_settings_file(&config_path, &loaded)?;
        background::sync_startup_entry(&loaded)?;

        Ok(Self { settings: Mutex::new(loaded), config_path })
    }
    pub fn get(&self) -> AppSettings {
        self.settings.lock().expect("settings poisoned").clone()
    }

    pub fn update(&self, next: AppSettings) -> Result<AppSettings, String> {
        let previous = self.get();
        let next = sanitize_settings(next);
        background::sync_startup_entry(&next)?;
        if let Err(error) = write_settings_file(&self.config_path, &next) {
            let _ = background::sync_startup_entry(&previous);
            return Err(error);
        }

        let mut guard = self.settings.lock().expect("settings poisoned");
        *guard = next;
        Ok(guard.clone())
    }

    pub fn reset(&self) -> Result<AppSettings, String> {
        self.update(AppSettings::default())
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }
}

pub fn sanitize_settings(mut settings: AppSettings) -> AppSettings {
    let ui_language = settings.ui_language.trim().to_lowercase();
    settings.ui_language = if matches!(ui_language.as_str(), "en" | "de") {
        ui_language
    } else {
        AppSettings::default().ui_language
    };

    let language = settings.translation_target_language.trim().to_lowercase();
    settings.translation_target_language =
        if LANGUAGE_OPTIONS.iter().any(|item| item.code == language) {
            language
        } else {
            AppSettings::default().translation_target_language
        };

    settings.playback_speed = sanitize_playback_speed(settings.playback_speed);
    settings.openai_api_key = settings.openai_api_key.trim().to_string();
    settings.stt_language = if settings.stt_language.trim().is_empty() {
        "de".to_string()
    } else {
        settings.stt_language.trim().to_lowercase()
    };
    settings.assistant_name = if settings.assistant_name.trim().is_empty() {
        "AIVA".to_string()
    } else {
        settings.assistant_name.trim().to_string()
    };
    settings.voice_agent_model = sanitize_non_empty_line(
        settings.voice_agent_model,
        AppSettings::default().voice_agent_model,
    );
    settings.voice_agent_voice = sanitize_non_empty_line(
        settings.voice_agent_voice.to_lowercase(),
        AppSettings::default().voice_agent_voice,
    );
    settings.voice_agent_personality = sanitize_multiline(
        settings.voice_agent_personality,
        DEFAULT_VOICE_AGENT_PERSONALITY.to_string(),
    );
    settings.voice_agent_behavior =
        sanitize_multiline(settings.voice_agent_behavior, DEFAULT_VOICE_AGENT_BEHAVIOR.to_string());
    settings.voice_agent_extra_instructions = sanitize_multiline(
        settings.voice_agent_extra_instructions,
        DEFAULT_VOICE_AGENT_EXTRA_INSTRUCTIONS.to_string(),
    );
    settings.voice_agent_preferred_language =
        default_voice_agent_preferred_language(&settings.stt_language);
    settings.voice_agent_tone_notes =
        sanitize_multiline(settings.voice_agent_tone_notes, String::new());
    settings.assistant_sample_language = if settings.assistant_sample_language.trim().is_empty() {
        settings.stt_language.clone()
    } else {
        settings.assistant_sample_language.trim().to_lowercase()
    };
    settings.assistant_wake_samples = sanitize_phrase_samples(settings.assistant_wake_samples, 4);
    settings.assistant_name_samples = sanitize_phrase_samples(settings.assistant_name_samples, 2);
    settings.assistant_wake_threshold =
        sanitize_assistant_threshold(settings.assistant_wake_threshold);
    settings.assistant_cue_cooldown_ms =
        sanitize_assistant_cooldown_ms(settings.assistant_cue_cooldown_ms);

    settings
}

pub fn default_config_path() -> PathBuf {
    project_root().join(CONFIG_FILE_NAME)
}

pub fn resolve_openai_api_key(settings: &AppSettings) -> Result<String, String> {
    let configured_key = settings.openai_api_key.trim();
    if !configured_key.is_empty() {
        return Ok(configured_key.to_string());
    }

    load_env_file_if_present();

    env::var("OPENAI_API_KEY").map_err(|_| {
        "OPENAI_API_KEY is missing. Add it in Settings or in the project's .env file.".to_string()
    })
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Cargo manifest parent should exist")
        .to_path_buf()
}

fn write_settings_file(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create config directory '{}': {error}", parent.display())
        })?;
    }

    let payload = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, payload)
        .map_err(|error| format!("Failed to write config file '{}': {error}", path.display()))
}

fn sanitize_phrase_samples(samples: Vec<String>, max_len: usize) -> Vec<String> {
    samples
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .take(max_len)
        .collect()
}

fn sanitize_non_empty_line(value: String, fallback: String) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        fallback
    } else {
        normalized
    }
}

fn sanitize_multiline(value: String, fallback: String) -> String {
    let normalized = value
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if normalized.is_empty() {
        fallback
    } else {
        normalized
    }
}

fn sanitize_playback_speed(value: f32) -> f32 {
    if !value.is_finite() {
        return DEFAULT_PLAYBACK_SPEED;
    }

    ((value * 10.0).round() / 10.0).clamp(0.5, 2.0)
}

fn sanitize_assistant_threshold(value: u8) -> u8 {
    value.clamp(45, 95)
}

fn sanitize_assistant_cooldown_ms(value: u32) -> u32 {
    value.clamp(0, 5_000)
}

pub fn default_voice_agent_preferred_language(language_code: &str) -> String {
    language_label_for_code(language_code).to_string()
}

pub fn language_label_for_code(language_code: &str) -> &'static str {
    match language_code.trim().to_lowercase().as_str() {
        "de" => "German",
        "en" => "English",
        "fr" => "French",
        "es" => "Spanish",
        "it" => "Italian",
        "pt" => "Portuguese",
        "pl" => "Polish",
        "nl" => "Dutch",
        "tr" => "Turkish",
        "ja" => "Japanese",
        _ => "English",
    }
}

fn load_env_file_if_present() {
    let env_path = project_root().join(".env");

    if let Ok(contents) = fs::read_to_string(env_path) {
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = trimmed.split_once('=') {
                if env::var_os(key.trim()).is_none() {
                    env::set_var(key.trim(), value.trim().trim_matches('"').trim_matches('\''));
                }
            }
        }
    }
}
