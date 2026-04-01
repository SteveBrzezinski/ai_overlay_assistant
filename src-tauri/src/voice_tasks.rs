use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

pub const VOICE_AGENT_TASK_EVENT: &str = "voice-agent-task";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTask {
    pub id: String,
    pub task_type: String,
    pub payload: Value,
    pub status: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub result: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTaskEventPayload {
    pub task: VoiceTask,
}

pub struct VoiceTaskState {
    next_id: AtomicU64,
    tasks: Mutex<HashMap<String, VoiceTask>>,
}

impl Default for VoiceTaskState {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            tasks: Mutex::new(HashMap::new()),
        }
    }
}

impl VoiceTaskState {
    pub fn create_task(&self, task_type: &str, payload: Value) -> VoiceTask {
        let created_at_ms = system_time_ms();
        let id = format!(
            "voice-task-{}-{}",
            created_at_ms,
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let task = VoiceTask {
            id: id.clone(),
            task_type: task_type.to_string(),
            payload,
            status: "queued".to_string(),
            created_at_ms,
            updated_at_ms: created_at_ms,
            result: None,
        };

        self.tasks
            .lock()
            .expect("voice task state poisoned")
            .insert(id, task.clone());

        task
    }

    pub fn emit_task(&self, app: &AppHandle, task: &VoiceTask) {
        let _ = app.emit(
            VOICE_AGENT_TASK_EVENT,
            VoiceTaskEventPayload {
                task: task.clone(),
            },
        );
    }

    pub fn update_task(
        &self,
        app: &AppHandle,
        task_id: &str,
        status: &str,
        result: Option<Value>,
    ) -> Option<VoiceTask> {
        let mut tasks = self.tasks.lock().expect("voice task state poisoned");
        let existing = tasks.get_mut(task_id)?;
        existing.status = status.to_string();
        existing.updated_at_ms = system_time_ms();
        if result.is_some() {
            existing.result = result;
        }
        let updated = existing.clone();
        drop(tasks);
        self.emit_task(app, &updated);
        Some(updated)
    }

    pub fn get_task(&self, task_id: &str) -> Option<VoiceTask> {
        self.tasks
            .lock()
            .expect("voice task state poisoned")
            .get(task_id)
            .cloned()
    }
}

#[tauri::command]
pub fn get_voice_agent_task_command(
    task_id: String,
    state: State<'_, VoiceTaskState>,
) -> Result<VoiceTask, String> {
    state
        .get_task(&task_id)
        .ok_or_else(|| format!("Voice task not found: {task_id}"))
}

fn system_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
