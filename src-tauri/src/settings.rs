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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub tts_format: String,
    pub first_chunk_leading_silence_ms: u32,
    pub translation_target_language: String,
    pub playback_speed: f32,
    pub openai_api_key: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            tts_format: "wav".to_string(),
            first_chunk_leading_silence_ms: 180,
            translation_target_language: "en".to_string(),
            playback_speed: DEFAULT_PLAYBACK_SPEED,
            openai_api_key: String::new(),
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

        Ok(Self {
            settings: Mutex::new(loaded),
            config_path,
        })
    }
    pub fn get(&self) -> AppSettings {
        self.settings.lock().expect("settings poisoned").clone()
    }

    pub fn update(&self, next: AppSettings) -> Result<AppSettings, String> {
        let next = sanitize_settings(next);
        write_settings_file(&self.config_path, &next)?;

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

    settings.playback_speed = sanitize_playback_speed(settings.playback_speed);
    settings.openai_api_key = settings.openai_api_key.trim().to_string();

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
        "OPENAI_API_KEY is missing. Add it in Settings or in the project's .env file."
            .to_string()
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
            format!(
                "Failed to create config directory '{}': {error}",
                parent.display()
            )
        })?;
    }

    let payload = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, payload)
        .map_err(|error| format!("Failed to write config file '{}': {error}", path.display()))
}

fn sanitize_playback_speed(value: f32) -> f32 {
    if !value.is_finite() {
        return DEFAULT_PLAYBACK_SPEED;
    }

    ((value * 10.0).round() / 10.0).clamp(0.5, 2.0)
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
