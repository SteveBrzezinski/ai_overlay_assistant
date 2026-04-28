use crate::selection_capture::{capture_selected_text, CaptureOptions};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

pub const CONTEXT_BUCKET_EVENT: &str = "context-bucket-updated";
const MAX_CONTEXT_ITEMS: usize = 20;
const MAX_CONTEXT_ITEM_CHARS: usize = 12_000;
const MAX_CONTEXT_TOTAL_CHARS: usize = 50_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBucketItem {
    pub id: String,
    pub text: String,
    pub captured_at_ms: u64,
    pub char_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBucketStatusPayload {
    pub count: usize,
    pub total_chars: usize,
    pub max_items: usize,
    pub last_action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBucketTakeResult {
    pub items: Vec<ContextBucketItem>,
    pub count: usize,
    pub total_chars: usize,
}

#[derive(Default)]
pub struct ContextBucketState {
    items: Mutex<Vec<ContextBucketItem>>,
}

#[tauri::command]
pub fn capture_context_bucket_item_command(
    app: AppHandle,
    state: State<'_, ContextBucketState>,
) -> Result<ContextBucketStatusPayload, String> {
    let capture = capture_selected_text(Some(CaptureOptions {
        copy_delay_ms: Some(120),
        restore_clipboard: Some(true),
    }))?;
    let selected_text = capture.text.trim();
    if selected_text.is_empty() {
        return Err(capture
            .note
            .unwrap_or_else(|| "No marked text could be captured.".to_string()));
    }

    let text = limit_chars(selected_text, MAX_CONTEXT_ITEM_CHARS);
    let char_count = text.chars().count();
    let captured_at_ms = now_ms();
    let mut items = lock_items(state.inner())?;
    let next_index = items.len() + 1;
    items.push(ContextBucketItem {
        id: format!("ctx-{captured_at_ms}-{next_index}"),
        text,
        captured_at_ms,
        char_count,
    });
    trim_bucket(&mut items);
    let status = status_from_items(&items, "added");
    drop(items);
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn get_context_bucket_status_command(
    state: State<'_, ContextBucketState>,
) -> Result<ContextBucketStatusPayload, String> {
    let items = lock_items(state.inner())?;
    Ok(status_from_items(&items, "status"))
}

#[tauri::command]
pub fn clear_context_bucket_command(
    app: AppHandle,
    state: State<'_, ContextBucketState>,
) -> Result<ContextBucketStatusPayload, String> {
    let mut items = lock_items(state.inner())?;
    items.clear();
    let status = status_from_items(&items, "cleared");
    drop(items);
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn take_context_bucket_items_command(
    app: AppHandle,
    state: State<'_, ContextBucketState>,
) -> Result<ContextBucketTakeResult, String> {
    let mut items = lock_items(state.inner())?;
    let taken: Vec<ContextBucketItem> = std::mem::take(&mut *items);
    let count = taken.len();
    let total_chars = total_chars(&taken);
    let status = status_from_items(&items, "taken");
    drop(items);
    if count > 0 {
        emit_status(&app, &status);
    }
    Ok(ContextBucketTakeResult {
        items: taken,
        count,
        total_chars,
    })
}

fn lock_items<'a>(
    state: &'a ContextBucketState,
) -> Result<std::sync::MutexGuard<'a, Vec<ContextBucketItem>>, String> {
    state
        .items
        .lock()
        .map_err(|_| "Context bucket state is locked by a failed operation.".to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn limit_chars(value: &str, max_chars: usize) -> String {
    let mut iter = value.chars();
    let mut output = String::new();
    for _ in 0..max_chars {
        match iter.next() {
            Some(ch) => output.push(ch),
            None => return output,
        }
    }

    if iter.next().is_some() {
        output.push_str("\n\n[... truncated by AIVA context bucket ...]");
    }
    output
}

fn trim_bucket(items: &mut Vec<ContextBucketItem>) {
    while items.len() > MAX_CONTEXT_ITEMS || total_chars(items) > MAX_CONTEXT_TOTAL_CHARS {
        items.remove(0);
    }
}

fn total_chars(items: &[ContextBucketItem]) -> usize {
    items.iter().map(|item| item.char_count).sum()
}

fn status_from_items(items: &[ContextBucketItem], last_action: &str) -> ContextBucketStatusPayload {
    ContextBucketStatusPayload {
        count: items.len(),
        total_chars: total_chars(items),
        max_items: MAX_CONTEXT_ITEMS,
        last_action: last_action.to_string(),
    }
}

fn emit_status(app: &AppHandle, status: &ContextBucketStatusPayload) {
    let _ = app.emit(CONTEXT_BUCKET_EVENT, status);
}
