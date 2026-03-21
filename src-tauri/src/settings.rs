use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub const DEFAULT_SPEAK_HOTKEY: &str = "Ctrl+Shift+Space";
pub const DEFAULT_TRANSLATE_HOTKEY: &str = "Ctrl+Shift+T";
pub const DEFAULT_PAUSE_RESUME_HOTKEY: &str = "Ctrl+Shift+P";
pub const DEFAULT_CANCEL_HOTKEY: &str = "Ctrl+Shift+X";
pub const SETTINGS_EVENT: &str = "settings-updated";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub tts_format: String,
    pub first_chunk_leading_silence_ms: u32,
    pub translation_target_language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            tts_format: "wav".to_string(),
            first_chunk_leading_silence_ms: 180,
            translation_target_language: "de".to_string(),
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
    LanguageOption { code: "de", label: "Deutsch" },
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
}

impl Default for SettingsState {
    fn default() -> Self {
        Self { settings: Mutex::new(AppSettings::default()) }
    }
}

impl SettingsState {
    pub fn get(&self) -> AppSettings {
        self.settings.lock().expect("settings poisoned").clone()
    }

    pub fn update(&self, next: AppSettings) -> AppSettings {
        let mut guard = self.settings.lock().expect("settings poisoned");
        *guard = sanitize_settings(next);
        guard.clone()
    }
}

pub fn sanitize_settings(mut settings: AppSettings) -> AppSettings {
    settings.tts_format = match settings.tts_format.trim().to_lowercase().as_str() {
        "mp3" => "mp3".to_string(),
        _ => "wav".to_string(),
    };

    settings.first_chunk_leading_silence_ms = settings.first_chunk_leading_silence_ms.clamp(0, 1000);

    let language = settings.translation_target_language.trim().to_lowercase();
    settings.translation_target_language = if LANGUAGE_OPTIONS.iter().any(|item| item.code == language) {
        language
    } else {
        AppSettings::default().translation_target_language
    };

    settings
}
