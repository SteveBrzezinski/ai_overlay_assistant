use rodio::Sink;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
    Idle,
    Capturing,
    Translating,
    Synthesizing,
    Playing,
    Finished,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    pub active: bool,
    pub paused: bool,
    pub cancel_requested: bool,
    pub phase: RunPhase,
    pub current_chunk: Option<usize>,
    pub total_chunks: Option<usize>,
    pub run_id: u64,
}

struct RunSnapshot {
    active: bool,
    paused: bool,
    cancel_requested: bool,
    phase: RunPhase,
    current_chunk: Option<usize>,
    total_chunks: Option<usize>,
    run_id: u64,
    sink: Option<Arc<Sink>>,
}

pub struct RunController {
    next_run_id: AtomicU64,
    inner: Mutex<RunSnapshot>,
}

impl Default for RunController {
    fn default() -> Self {
        Self {
            next_run_id: AtomicU64::new(1),
            inner: Mutex::new(RunSnapshot {
                active: false,
                paused: false,
                cancel_requested: false,
                phase: RunPhase::Idle,
                current_chunk: None,
                total_chunks: None,
                run_id: 0,
                sink: None,
            }),
        }
    }
}

impl RunController {
    pub fn start_run(&self) -> Result<u64, String> {
        let mut inner = self.inner.lock().expect("run controller poisoned");
        if inner.active {
            return Err("Another playback run is still active.".to_string());
        }

        let run_id = self.next_run_id.fetch_add(1, Ordering::SeqCst);
        inner.active = true;
        inner.paused = false;
        inner.cancel_requested = false;
        inner.phase = RunPhase::Capturing;
        inner.current_chunk = None;
        inner.total_chunks = None;
        inner.run_id = run_id;
        inner.sink = None;
        Ok(run_id)
    }

    pub fn status(&self) -> RunStatus {
        let inner = self.inner.lock().expect("run controller poisoned");
        RunStatus {
            active: inner.active,
            paused: inner.paused,
            cancel_requested: inner.cancel_requested,
            phase: inner.phase,
            current_chunk: inner.current_chunk,
            total_chunks: inner.total_chunks,
            run_id: inner.run_id,
        }
    }

    pub fn set_phase(&self, run_id: u64, phase: RunPhase) {
        let mut inner = self.inner.lock().expect("run controller poisoned");
        if inner.run_id == run_id && inner.active {
            inner.phase = phase;
        }
    }

    pub fn set_chunk(&self, run_id: u64, current_chunk: Option<usize>, total_chunks: Option<usize>) {
        let mut inner = self.inner.lock().expect("run controller poisoned");
        if inner.run_id == run_id && inner.active {
            inner.current_chunk = current_chunk;
            inner.total_chunks = total_chunks;
        }
    }

    pub fn attach_sink(&self, run_id: u64, sink: Arc<Sink>) {
        let mut inner = self.inner.lock().expect("run controller poisoned");
        if inner.run_id != run_id || !inner.active {
            sink.stop();
            return;
        }

        if inner.cancel_requested {
            sink.stop();
            return;
        }

        if inner.paused {
            sink.pause();
        }
        inner.sink = Some(sink);
    }

    pub fn detach_sink(&self, run_id: u64) {
        let mut inner = self.inner.lock().expect("run controller poisoned");
        if inner.run_id == run_id {
            inner.sink = None;
        }
    }

    pub fn toggle_pause_resume(&self) -> Result<RunStatus, String> {
        let mut inner = self.inner.lock().expect("run controller poisoned");
        if !inner.active || inner.cancel_requested {
            return Err("No active run can be paused or resumed.".to_string());
        }

        inner.paused = !inner.paused;
        if let Some(sink) = inner.sink.as_ref() {
            if inner.paused {
                sink.pause();
            } else {
                sink.play();
            }
        }

        Ok(RunStatus {
            active: inner.active,
            paused: inner.paused,
            cancel_requested: inner.cancel_requested,
            phase: inner.phase,
            current_chunk: inner.current_chunk,
            total_chunks: inner.total_chunks,
            run_id: inner.run_id,
        })
    }

    pub fn cancel_current(&self) -> Result<RunStatus, String> {
        let mut inner = self.inner.lock().expect("run controller poisoned");
        if !inner.active {
            return Err("No active run to cancel.".to_string());
        }

        inner.cancel_requested = true;
        inner.paused = false;
        inner.phase = RunPhase::Cancelled;
        if let Some(sink) = inner.sink.take() {
            sink.stop();
        }

        Ok(RunStatus {
            active: inner.active,
            paused: inner.paused,
            cancel_requested: inner.cancel_requested,
            phase: inner.phase,
            current_chunk: inner.current_chunk,
            total_chunks: inner.total_chunks,
            run_id: inner.run_id,
        })
    }

    pub fn is_cancel_requested(&self, run_id: u64) -> bool {
        let inner = self.inner.lock().expect("run controller poisoned");
        inner.run_id == run_id && inner.active && inner.cancel_requested
    }

    pub fn finish_run(&self, run_id: u64, cancelled: bool) {
        let mut inner = self.inner.lock().expect("run controller poisoned");
        if inner.run_id != run_id {
            return;
        }

        inner.active = false;
        inner.paused = false;
        inner.cancel_requested = false;
        inner.phase = if cancelled { RunPhase::Cancelled } else { RunPhase::Finished };
        inner.current_chunk = None;
        inner.total_chunks = None;
        inner.sink = None;
    }
}

pub fn is_cancelled(controller: Option<&RunController>, run_id: Option<u64>) -> bool {
    match (controller, run_id) {
        (Some(controller), Some(run_id)) => controller.is_cancel_requested(run_id),
        _ => false,
    }
}
