use crate::settings::{AppSettings, SettingsState};
use reqwest::{
    blocking::{Client, Response},
    StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{process::Command, time::Duration};
use tauri::State;

const API_CONNECT_TIMEOUT_SECS: u64 = 5;
const API_TIMEOUT_SECS: u64 = 20;
const DESKTOP_DEVICE_NAME: &str = "AIVA Desktop";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedUserSummary {
    pub id: u64,
    pub name: String,
    pub email: String,
    pub email_verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedWorkspaceSummary {
    pub id: u64,
    pub name: String,
    pub slug: String,
    pub is_personal: bool,
    pub role: Option<String>,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedSubscriptionSummary {
    pub provider: String,
    pub plan_key: String,
    pub status: String,
    pub seats: u32,
    pub current_period_ends_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedEntitlementSummary {
    pub feature: String,
    pub enabled: bool,
    pub usage_limit: Option<u64>,
    pub usage_count: u64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedBillingPlanFeature {
    pub feature: String,
    pub enabled: bool,
    pub usage_limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedBillingPlan {
    pub key: String,
    pub name: String,
    pub seat_limit: u32,
    pub features: Vec<HostedBillingPlanFeature>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedCheckoutSession {
    pub id: String,
    pub url: String,
    pub plan_key: String,
    pub team: HostedWorkspaceSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedAccountStatus {
    pub connected: bool,
    pub base_url: String,
    pub user: Option<HostedUserSummary>,
    pub current_team: Option<HostedWorkspaceSummary>,
    pub teams: Vec<HostedWorkspaceSummary>,
    pub subscription: Option<HostedSubscriptionSummary>,
    pub entitlements: Vec<HostedEntitlementSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedAccountSyncResult {
    pub settings: AppSettings,
    pub account: HostedAccountStatus,
}

#[derive(Debug, Clone)]
pub struct HostedRealtimeSessionBootstrap {
    pub hosted_session_id: String,
    pub provider: String,
    pub provider_session_id: Option<String>,
    pub client_secret: String,
    pub client_secret_expires_at: Option<String>,
    pub model: String,
    pub voice: String,
    pub team: HostedWorkspaceSummary,
}

#[derive(Debug, Clone)]
pub struct HostedTranslationResult {
    pub text: String,
    pub target_language: String,
    pub source_language: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone)]
pub struct HostedSpeechResult {
    pub audio_base64: String,
    pub bytes: usize,
    pub format: String,
    pub model: String,
    pub voice: String,
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
struct ApiTokenResponseData {
    token: String,
    #[allow(dead_code)]
    token_type: String,
    #[serde(flatten)]
    account: ApiAccountSnapshot,
}

#[derive(Debug, Deserialize)]
struct ApiAccountSnapshot {
    user: ApiUserSummary,
    current_team: Option<ApiWorkspaceSummary>,
    #[serde(default)]
    teams: Vec<ApiWorkspaceSummary>,
    subscription: Option<ApiSubscriptionSummary>,
    #[serde(default)]
    entitlements: Vec<ApiEntitlementSummary>,
}

#[derive(Debug, Deserialize)]
struct ApiUserSummary {
    id: u64,
    name: String,
    email: String,
    email_verified_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiWorkspaceSummary {
    id: u64,
    name: String,
    slug: String,
    is_personal: bool,
    role: Option<String>,
    #[serde(default)]
    is_current: bool,
}

#[derive(Debug, Deserialize)]
struct ApiSubscriptionSummary {
    provider: String,
    plan_key: String,
    status: String,
    seats: u32,
    current_period_ends_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiEntitlementSummary {
    feature: String,
    enabled: bool,
    usage_limit: Option<u64>,
    usage_count: u64,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiHostedRealtimeSessionData {
    hosted_session_id: String,
    provider: String,
    provider_session_id: Option<String>,
    client_secret: String,
    client_secret_expires_at: Option<String>,
    model: String,
    voice: String,
    team: ApiWorkspaceSummary,
}

#[derive(Debug, Deserialize)]
struct ApiBillingPlan {
    key: String,
    name: String,
    seat_limit: u32,
    #[serde(default)]
    features: Vec<ApiBillingPlanFeature>,
}

#[derive(Debug, Deserialize)]
struct ApiBillingPlanFeature {
    feature: String,
    enabled: bool,
    usage_limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ApiCheckoutSessionData {
    id: String,
    url: String,
    plan_key: String,
    team: ApiWorkspaceSummary,
}

#[derive(Debug, Deserialize)]
struct ApiHostedTranslationData {
    text: String,
    target_language: String,
    source_language: Option<String>,
    model: String,
}

#[derive(Debug, Deserialize)]
struct ApiHostedSpeechData {
    audio_base64: String,
    bytes: usize,
    format: String,
    model: String,
    voice: String,
}

#[tauri::command]
pub fn login_hosted_account_command(
    base_url: String,
    email: String,
    password: String,
    settings: State<'_, SettingsState>,
) -> Result<HostedAccountSyncResult, String> {
    let normalized_base_url = normalize_base_url(&base_url)?;
    let normalized_email = normalize_email(&email)?;
    let normalized_password = normalize_password(&password)?;
    let client = api_client()?;
    let response = client
        .post(api_url(&normalized_base_url, "/api/v1/auth/tokens"))
        .json(&json!({
            "email": normalized_email,
            "password": normalized_password,
            "device_name": DESKTOP_DEVICE_NAME,
        }))
        .send()
        .map_err(|error| format!("Hosted sign-in failed: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_api_error(
            response,
            "Hosted sign-in failed",
            "The hosted backend rejected the sign-in request.",
        ));
    }

    let payload: ApiEnvelope<ApiTokenResponseData> = response
        .json()
        .map_err(|error| format!("Failed to decode hosted sign-in response: {error}"))?;

    let mut next_settings = settings.get();
    next_settings.ai_provider_mode = "hosted".to_string();
    next_settings.hosted_api_base_url = normalized_base_url.clone();
    next_settings.hosted_account_email = normalized_email;
    next_settings.hosted_access_token = payload.data.token;
    let saved_settings = settings.update(next_settings)?;

    Ok(HostedAccountSyncResult {
        settings: saved_settings,
        account: map_account_snapshot(&normalized_base_url, payload.data.account),
    })
}

#[tauri::command]
pub fn get_hosted_account_status_command(
    settings: State<'_, SettingsState>,
) -> Result<HostedAccountStatus, String> {
    let app_settings = settings.get();

    if app_settings.hosted_api_base_url.trim().is_empty()
        || app_settings.hosted_access_token.trim().is_empty()
    {
        return Ok(disconnected_account_status(&app_settings.hosted_api_base_url));
    }

    fetch_hosted_account_status(&app_settings)
}

#[tauri::command]
pub fn logout_hosted_account_command(
    settings: State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let current_settings = settings.get();

    if !current_settings.hosted_api_base_url.trim().is_empty()
        && !current_settings.hosted_access_token.trim().is_empty()
    {
        let response = api_client()?
            .delete(api_url(&current_settings.hosted_api_base_url, "/api/v1/auth/tokens/current"))
            .bearer_auth(&current_settings.hosted_access_token)
            .send()
            .map_err(|error| format!("Hosted sign-out failed: {error}"))?;

        if !response.status().is_success()
            && response.status() != StatusCode::UNAUTHORIZED
            && response.status() != StatusCode::FORBIDDEN
        {
            return Err(parse_api_error(
                response,
                "Hosted sign-out failed",
                "The hosted backend rejected the sign-out request.",
            ));
        }
    }

    let mut next_settings = current_settings;
    next_settings.hosted_access_token.clear();
    settings.update(next_settings)
}

#[tauri::command]
pub fn get_hosted_billing_plans_command(
    settings: State<'_, SettingsState>,
) -> Result<Vec<HostedBillingPlan>, String> {
    let app_settings = settings.get();
    get_hosted_billing_plans(&app_settings)
}

#[tauri::command]
pub fn create_hosted_checkout_session_command(
    plan_key: String,
    settings: State<'_, SettingsState>,
) -> Result<HostedCheckoutSession, String> {
    let app_settings = settings.get();
    create_hosted_checkout_session(&app_settings, &plan_key)
}

#[tauri::command]
pub fn open_external_url_command(url: String) -> Result<(), String> {
    let normalized_url = url.trim();

    if !normalized_url.starts_with("http://") && !normalized_url.starts_with("https://") {
        return Err("Only http:// and https:// URLs can be opened externally.".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", normalized_url]);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(normalized_url);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(normalized_url);
        command
    };

    command.spawn().map_err(|error| format!("Failed to open external URL: {error}"))?;

    Ok(())
}

pub fn create_hosted_realtime_session(
    settings: &AppSettings,
    instructions: String,
    model: String,
    voice: String,
) -> Result<HostedRealtimeSessionBootstrap, String> {
    let base_url = resolve_hosted_base_url(settings)?;
    let access_token = resolve_hosted_access_token(settings)?;
    let client = api_client()?;
    let mut payload = json!({
        "model": model,
        "voice": voice,
        "instructions": instructions,
        "metadata": {
            "source": "aiva-desktop",
            "assistant_name": settings.assistant_name.trim(),
        }
    });

    if !settings.hosted_workspace_slug.trim().is_empty() {
        payload["team"] = Value::String(settings.hosted_workspace_slug.trim().to_string());
    }

    let response = client
        .post(api_url(&base_url, "/api/v1/hosted/realtime/sessions"))
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .map_err(|error| format!("Hosted realtime session creation failed: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_api_error(
            response,
            "Hosted realtime session creation failed",
            "The hosted backend rejected the realtime session request.",
        ));
    }

    let payload: ApiEnvelope<ApiHostedRealtimeSessionData> = response
        .json()
        .map_err(|error| format!("Failed to decode hosted realtime session response: {error}"))?;

    Ok(HostedRealtimeSessionBootstrap {
        hosted_session_id: payload.data.hosted_session_id,
        provider: payload.data.provider,
        provider_session_id: payload.data.provider_session_id,
        client_secret: payload.data.client_secret,
        client_secret_expires_at: payload.data.client_secret_expires_at,
        model: payload.data.model,
        voice: payload.data.voice,
        team: map_workspace(payload.data.team),
    })
}

pub fn translate_with_hosted_backend(
    settings: &AppSettings,
    text: String,
    target_language: String,
    source_language: Option<String>,
    model: Option<String>,
) -> Result<HostedTranslationResult, String> {
    let base_url = resolve_hosted_base_url(settings)?;
    let access_token = resolve_hosted_access_token(settings)?;
    let client = api_client()?;
    let mut payload = json!({
        "text": text,
        "target_language": target_language,
    });

    if let Some(source_language) = source_language.filter(|value| !value.trim().is_empty()) {
        payload["source_language"] = Value::String(source_language);
    }

    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        payload["model"] = Value::String(model);
    }

    if let Some(team) = selected_team_slug(settings) {
        payload["team"] = Value::String(team);
    }

    let response = client
        .post(api_url(&base_url, "/api/v1/hosted/translate"))
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .map_err(|error| format!("Hosted translation request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_api_error(
            response,
            "Hosted translation request failed",
            "The hosted backend rejected the translation request.",
        ));
    }

    let payload: ApiEnvelope<ApiHostedTranslationData> = response
        .json()
        .map_err(|error| format!("Failed to decode hosted translation response: {error}"))?;

    Ok(HostedTranslationResult {
        text: payload.data.text,
        target_language: payload.data.target_language,
        source_language: payload.data.source_language,
        model: payload.data.model,
    })
}

pub fn synthesize_speech_with_hosted_backend(
    settings: &AppSettings,
    text: String,
    model: Option<String>,
    voice: Option<String>,
    format: String,
) -> Result<HostedSpeechResult, String> {
    let base_url = resolve_hosted_base_url(settings)?;
    let access_token = resolve_hosted_access_token(settings)?;
    let client = api_client()?;
    let mut payload = json!({
        "text": text,
        "format": format,
    });

    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        payload["model"] = Value::String(model);
    }

    if let Some(voice) = voice.filter(|value| !value.trim().is_empty()) {
        payload["voice"] = Value::String(voice);
    }

    if let Some(team) = selected_team_slug(settings) {
        payload["team"] = Value::String(team);
    }

    let response = client
        .post(api_url(&base_url, "/api/v1/hosted/speech"))
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .map_err(|error| format!("Hosted speech request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_api_error(
            response,
            "Hosted speech request failed",
            "The hosted backend rejected the speech request.",
        ));
    }

    let payload: ApiEnvelope<ApiHostedSpeechData> = response
        .json()
        .map_err(|error| format!("Failed to decode hosted speech response: {error}"))?;

    Ok(HostedSpeechResult {
        audio_base64: payload.data.audio_base64,
        bytes: payload.data.bytes,
        format: payload.data.format,
        model: payload.data.model,
        voice: payload.data.voice,
    })
}

fn fetch_hosted_account_status(settings: &AppSettings) -> Result<HostedAccountStatus, String> {
    let base_url = resolve_hosted_base_url(settings)?;
    let access_token = resolve_hosted_access_token(settings)?;
    let response = api_client()?
        .get(api_url(&base_url, "/api/v1/me"))
        .bearer_auth(access_token)
        .send()
        .map_err(|error| format!("Hosted account status request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_api_error(
            response,
            "Hosted account status request failed",
            "The hosted backend rejected the profile request.",
        ));
    }

    let payload: ApiEnvelope<ApiAccountSnapshot> = response
        .json()
        .map_err(|error| format!("Failed to decode hosted account status response: {error}"))?;

    Ok(map_account_snapshot(&base_url, payload.data))
}

fn get_hosted_billing_plans(settings: &AppSettings) -> Result<Vec<HostedBillingPlan>, String> {
    let base_url = resolve_hosted_base_url(settings)?;
    let access_token = resolve_hosted_access_token(settings)?;
    let response = api_client()?
        .get(api_url(&base_url, "/api/v1/billing/plans"))
        .bearer_auth(access_token)
        .send()
        .map_err(|error| format!("Hosted billing plan request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_api_error(
            response,
            "Hosted billing plan request failed",
            "The hosted backend rejected the billing plan request.",
        ));
    }

    let payload: ApiEnvelope<Vec<ApiBillingPlan>> = response
        .json()
        .map_err(|error| format!("Failed to decode hosted billing plan response: {error}"))?;

    Ok(payload
        .data
        .into_iter()
        .map(|plan| HostedBillingPlan {
            key: plan.key,
            name: plan.name,
            seat_limit: plan.seat_limit,
            features: plan
                .features
                .into_iter()
                .map(|feature| HostedBillingPlanFeature {
                    feature: feature.feature,
                    enabled: feature.enabled,
                    usage_limit: feature.usage_limit,
                })
                .collect(),
        })
        .collect())
}

fn create_hosted_checkout_session(
    settings: &AppSettings,
    plan_key: &str,
) -> Result<HostedCheckoutSession, String> {
    if plan_key.trim().is_empty() {
        return Err("Select a billing plan before opening Stripe Checkout.".to_string());
    }

    let base_url = resolve_hosted_base_url(settings)?;
    let access_token = resolve_hosted_access_token(settings)?;
    let client = api_client()?;
    let mut payload = json!({
        "plan_key": plan_key.trim(),
    });

    if let Some(team) = selected_team_slug(settings) {
        payload["team"] = Value::String(team);
    }

    let response = client
        .post(api_url(&base_url, "/api/v1/billing/checkout-sessions"))
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .map_err(|error| format!("Hosted checkout session request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(parse_api_error(
            response,
            "Hosted checkout session request failed",
            "The hosted backend rejected the checkout session request.",
        ));
    }

    let payload: ApiEnvelope<ApiCheckoutSessionData> = response
        .json()
        .map_err(|error| format!("Failed to decode hosted checkout session response: {error}"))?;

    Ok(HostedCheckoutSession {
        id: payload.data.id,
        url: payload.data.url,
        plan_key: payload.data.plan_key,
        team: map_workspace(payload.data.team),
    })
}

fn api_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(API_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(API_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("Failed to initialize hosted API client: {error}"))
}

fn normalize_base_url(value: &str) -> Result<String, String> {
    let normalized = value.trim().trim_end_matches('/').to_string();

    if normalized.is_empty() {
        return Err("Enter the hosted backend base URL first.".to_string());
    }

    if !normalized.starts_with("http://") && !normalized.starts_with("https://") {
        return Err("The hosted backend URL must start with http:// or https://.".to_string());
    }

    Ok(normalized)
}

fn normalize_email(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();

    if normalized.is_empty() {
        return Err("Enter the email address for the hosted account.".to_string());
    }

    Ok(normalized)
}

fn normalize_password(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err("Enter the password for the hosted account.".to_string());
    }

    Ok(value.to_string())
}

fn resolve_hosted_base_url(settings: &AppSettings) -> Result<String, String> {
    normalize_base_url(&settings.hosted_api_base_url)
}

fn resolve_hosted_access_token(settings: &AppSettings) -> Result<String, String> {
    let access_token = settings.hosted_access_token.trim();

    if access_token.is_empty() {
        return Err(
            "Hosted mode requires a valid backend sign-in token. Sign in first.".to_string()
        );
    }

    Ok(access_token.to_string())
}

fn api_url(base_url: &str, path: &str) -> String {
    format!("{base_url}{path}")
}

fn selected_team_slug(settings: &AppSettings) -> Option<String> {
    let team = settings.hosted_workspace_slug.trim();

    if team.is_empty() {
        None
    } else {
        Some(team.to_string())
    }
}

fn disconnected_account_status(base_url: &str) -> HostedAccountStatus {
    HostedAccountStatus {
        connected: false,
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        user: None,
        current_team: None,
        teams: Vec::new(),
        subscription: None,
        entitlements: Vec::new(),
    }
}

fn map_account_snapshot(base_url: &str, snapshot: ApiAccountSnapshot) -> HostedAccountStatus {
    let current_team = snapshot.current_team.as_ref().map(|team| map_workspace(team.clone()));
    let mut teams = snapshot.teams.into_iter().map(map_workspace).collect::<Vec<_>>();

    if let Some(team) = current_team.clone() {
        if !teams.iter().any(|item| item.id == team.id) {
            teams.insert(0, team);
        }
    }

    HostedAccountStatus {
        connected: true,
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        user: Some(HostedUserSummary {
            id: snapshot.user.id,
            name: snapshot.user.name,
            email: snapshot.user.email,
            email_verified_at: snapshot.user.email_verified_at,
        }),
        current_team,
        teams,
        subscription: snapshot.subscription.map(|subscription| HostedSubscriptionSummary {
            provider: subscription.provider,
            plan_key: subscription.plan_key,
            status: subscription.status,
            seats: subscription.seats,
            current_period_ends_at: subscription.current_period_ends_at,
        }),
        entitlements: snapshot
            .entitlements
            .into_iter()
            .map(|entitlement| HostedEntitlementSummary {
                feature: entitlement.feature,
                enabled: entitlement.enabled,
                usage_limit: entitlement.usage_limit,
                usage_count: entitlement.usage_count,
                resets_at: entitlement.resets_at,
            })
            .collect(),
    }
}

fn map_workspace(team: ApiWorkspaceSummary) -> HostedWorkspaceSummary {
    HostedWorkspaceSummary {
        id: team.id,
        name: team.name,
        slug: team.slug,
        is_personal: team.is_personal,
        role: team.role,
        is_current: team.is_current,
    }
}

fn parse_api_error(response: Response, action: &str, fallback: &str) -> String {
    let status = response.status();
    let body = response.text().unwrap_or_default();

    if let Ok(payload) = serde_json::from_str::<Value>(&body) {
        if let Some(message) = payload.get("message").and_then(Value::as_str) {
            return format!("{action} ({status}): {message}");
        }

        if let Some(errors) = payload.get("errors").and_then(Value::as_object) {
            let first_error = errors
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(Value::as_str)
                .find(|value| !value.trim().is_empty());

            if let Some(message) = first_error {
                return format!("{action} ({status}): {message}");
            }
        }
    }

    if !body.trim().is_empty() {
        return format!("{action} ({status}): {body}");
    }

    format!("{action} ({status}): {fallback}")
}
