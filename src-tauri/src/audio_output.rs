use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub const APP_AUDIO_OUTPUT_EVENT: &str = "app-audio-output-state";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAudioOutputStatePayload {
    pub active: bool,
    pub sources: Vec<String>,
}

#[derive(Default)]
pub struct AudioOutputActivityState {
    sources: Mutex<HashMap<String, usize>>,
}

impl AudioOutputActivityState {
    pub fn begin(&self, app: &AppHandle, source: &str) {
        let normalized = normalize_source(source);
        if normalized.is_empty() {
            return;
        }

        let mut guard = self.sources.lock().expect("audio output state poisoned");
        *guard.entry(normalized).or_insert(0) += 1;
        let payload = build_payload(&guard);
        drop(guard);
        let _ = app.emit(APP_AUDIO_OUTPUT_EVENT, payload);
    }

    pub fn end(&self, app: &AppHandle, source: &str) {
        let normalized = normalize_source(source);
        if normalized.is_empty() {
            return;
        }

        let mut guard = self.sources.lock().expect("audio output state poisoned");
        if let Some(count) = guard.get_mut(&normalized) {
            if *count > 1 {
                *count -= 1;
            } else {
                guard.remove(&normalized);
            }
        }
        let payload = build_payload(&guard);
        drop(guard);
        let _ = app.emit(APP_AUDIO_OUTPUT_EVENT, payload);
    }
}

pub struct AudioOutputActivityGuard {
    app: AppHandle,
    source: String,
    active: bool,
}

impl AudioOutputActivityGuard {
    pub fn activate(app: &AppHandle, source: impl Into<String>) -> Self {
        let source = normalize_source(&source.into());
        if !source.is_empty() {
            app.state::<AudioOutputActivityState>().begin(app, &source);
        }

        Self { app: app.clone(), source, active: true }
    }

    pub fn release(&mut self) {
        if !self.active {
            return;
        }

        self.active = false;
        if self.source.is_empty() {
            return;
        }

        self.app
            .state::<AudioOutputActivityState>()
            .end(&self.app, &self.source);
    }
}

impl Drop for AudioOutputActivityGuard {
    fn drop(&mut self) {
        self.release();
    }
}

fn normalize_source(source: &str) -> String {
    source.trim().to_string()
}

fn build_payload(sources: &HashMap<String, usize>) -> AppAudioOutputStatePayload {
    let mut source_list = sources.keys().cloned().collect::<Vec<_>>();
    source_list.sort();
    AppAudioOutputStatePayload { active: !source_list.is_empty(), sources: source_list }
}
