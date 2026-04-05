use crate::settings::{resolve_openai_api_key, AppSettings, LANGUAGE_OPTIONS};
use serde::{Deserialize, Serialize};

const DEFAULT_TRANSLATION_MODEL: &str = "gpt-4o-mini";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextOptions {
    pub text: Option<String>,
    pub target_language: Option<String>,
    pub source_language: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextResult {
    pub text: String,
    pub target_language: String,
    pub source_language: Option<String>,
    pub model: String,
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

fn resolve_language(code: Option<String>) -> Result<String, String> {
    let value = code.unwrap_or_default().trim().to_lowercase();
    if LANGUAGE_OPTIONS.iter().any(|item| item.code == value) {
        Ok(value)
    } else {
        Err("Unsupported translation target language.".to_string())
    }
}

pub fn translate_text(
    options: TranslateTextOptions,
    settings: &AppSettings,
) -> Result<TranslateTextResult, String> {
    let text = options.text.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Err("No text provided for translation".into());
    }

    let api_key = resolve_openai_api_key(settings)?;

    let target_language = resolve_language(options.target_language)?;
    let model = options.model.unwrap_or_else(|| DEFAULT_TRANSLATION_MODEL.to_string());
    let source_language = options.source_language.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let language_label = LANGUAGE_OPTIONS
        .iter()
        .find(|item| item.code == target_language)
        .map(|item| item.label)
        .unwrap_or("the selected language");

    let system_prompt = "You are a translation engine. Return only the translated text. Preserve meaning, tone, formatting, list structure, and line breaks. Do not add explanations or quotes unless they are part of the source.";
    let user_prompt = if let Some(source_language) = &source_language {
        format!(
            "Translate the following text from {source_language} to {language_label}:

{text}"
        )
    } else {
        format!(
            "Translate the following text to {language_label}:

{text}"
        )
    };

    let client = reqwest::blocking::Client::new();
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&ChatRequest {
            model: &model,
            temperature: 0.2,
            messages: vec![
                ChatMessage { role: "system", content: system_prompt },
                ChatMessage { role: "user", content: &user_prompt },
            ],
        })
        .send()
        .map_err(|err| format!("OpenAI translation request failed: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("OpenAI translation failed ({status}): {body}"));
    }

    let payload: ChatResponse =
        response.json().map_err(|err| format!("Failed to decode translation response: {err}"))?;

    let translated = payload
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Translation response was empty".to_string())?;

    Ok(TranslateTextResult { text: translated, target_language, source_language, model })
}
