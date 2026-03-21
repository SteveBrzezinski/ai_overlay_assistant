use rodio::Sink;
use std::sync::{Arc, Condvar, Mutex};

pub const RUN_ALREADY_ACTIVE_MESSAGE: &str =
    "Another speak or translate run is still active. Ignoring the extra start request.";
pub const RUN_NOT_ACTIVE_MESSAGE: &str = "No active speak or translate run.";
pub const RUN_CANCELLED_MESSAGE: &str = "Current run was cancelled.";

#[derive(Clone, Default)]
pub struct RunController {
    shared: Arc<RunControllerShared>,
}

#[derive(Default)]
struct RunControllerShared {
    state: Mutex<ControllerState>,
    pause_cv: Condvar,
}

#[derive(Default)]
struct ControllerState {
    next_run_id: u64,
    active: Option<ActiveRun>,
}

struct ActiveRun {
    id: u64,
    action: String,
    phase: String,
    chunk_index: Option<usize>,
    chunk_total: Option<usize>,
    paused: bool,
    cancel_requested: bool,
    sink: Option<Arc<Sink>>,
}

#[derive(Debug, Clone)]
pub struct ActiveRunSnapshot {
    pub action: String,
    pub phase: String,
    pub chunk_index: Option<usize>,
    pub chunk_total: Option<usize>,
    pub has_sink: bool,
    pub paused: bool,
    pub cancel_requested: bool,
}

#[derive(Clone)]
pub struct RunAccess {
    controller: RunController,
    token: RunToken,
}

pub struct RunHandle {
    access: RunAccess,
    finished: bool,
}

#[derive(Debug, Clone)]
pub enum PauseResumeResult {
    NoActiveRun,
    CancelPending(ActiveRunSnapshot),
    Paused(ActiveRunSnapshot),
    Resumed(ActiveRunSnapshot),
}

#[derive(Debug, Clone)]
pub enum CancelResult {
    NoActiveRun,
    CancelRequested(ActiveRunSnapshot),
    AlreadyRequested(ActiveRunSnapshot),
}

#[derive(Debug, Clone)]
struct RunToken {
    id: u64,
    action: String,
}

impl RunController {
    pub fn start_run(&self, action: impl Into<String>) -> Result<RunHandle, String> {
        let action = action.into();
        let mut state = self.shared.state.lock().expect("run controller poisoned");

        if state.active.is_some() {
            return Err(RUN_ALREADY_ACTIVE_MESSAGE.to_string());
        }

        state.next_run_id += 1;
        let token = RunToken {
            id: state.next_run_id,
            action: action.clone(),
        };
        state.active = Some(ActiveRun {
            id: token.id,
            action,
            phase: "starting".to_string(),
            chunk_index: None,
            chunk_total: None,
            paused: false,
            cancel_requested: false,
            sink: None,
        });

        Ok(RunHandle {
            access: RunAccess {
                controller: self.clone(),
                token,
            },
            finished: false,
        })
    }

    pub fn pause_resume(&self) -> PauseResumeResult {
        let mut state = self.shared.state.lock().expect("run controller poisoned");
        let Some(active) = state.active.as_mut() else {
            return PauseResumeResult::NoActiveRun;
        };

        if active.cancel_requested {
            return PauseResumeResult::CancelPending(snapshot_from_active(active));
        }

        active.paused = !active.paused;
        if let Some(sink) = active.sink.as_ref() {
            if active.paused {
                sink.pause();
            } else {
                sink.play();
            }
        }

        let snapshot = snapshot_from_active(active);
        self.shared.pause_cv.notify_all();

        if snapshot.paused {
            PauseResumeResult::Paused(snapshot)
        } else {
            PauseResumeResult::Resumed(snapshot)
        }
    }

    pub fn cancel(&self) -> CancelResult {
        let mut state = self.shared.state.lock().expect("run controller poisoned");
        let Some(active) = state.active.as_mut() else {
            return CancelResult::NoActiveRun;
        };

        if active.cancel_requested {
            return CancelResult::AlreadyRequested(snapshot_from_active(active));
        }

        active.cancel_requested = true;
        if let Some(sink) = active.sink.as_ref() {
            sink.stop();
        }

        let snapshot = snapshot_from_active(active);
        self.shared.pause_cv.notify_all();
        CancelResult::CancelRequested(snapshot)
    }

    pub fn active_snapshot(&self) -> Option<ActiveRunSnapshot> {
        let state = self.shared.state.lock().expect("run controller poisoned");
        state.active.as_ref().map(snapshot_from_active)
    }

    fn finish_run(&self, token: &RunToken) {
        let mut state = self.shared.state.lock().expect("run controller poisoned");
        let should_clear = state
            .active
            .as_ref()
            .map(|active| active.id == token.id)
            .unwrap_or(false);

        if should_clear {
            if let Some(active) = state.active.as_mut() {
                if let Some(sink) = active.sink.take() {
                    sink.stop();
                }
            }
            state.active = None;
            self.shared.pause_cv.notify_all();
        }
    }

    fn update_phase(&self, token: &RunToken, phase: String, chunk: Option<(usize, usize)>) {
        let mut state = self.shared.state.lock().expect("run controller poisoned");
        let Some(active) = state.active.as_mut() else {
            return;
        };

        if active.id != token.id {
            return;
        }

        active.phase = phase;
        match chunk {
            Some((index, total)) => {
                active.chunk_index = Some(index);
                active.chunk_total = Some(total);
            }
            None => {
                active.chunk_index = None;
                active.chunk_total = None;
            }
        }
    }

    fn check_cancelled(&self, token: &RunToken) -> Result<(), String> {
        let state = self.shared.state.lock().expect("run controller poisoned");
        match state.active.as_ref() {
            Some(active) if active.id == token.id && !active.cancel_requested => Ok(()),
            _ => Err(RUN_CANCELLED_MESSAGE.to_string()),
        }
    }

    fn wait_if_paused(&self, token: &RunToken) -> Result<(), String> {
        let mut state = self.shared.state.lock().expect("run controller poisoned");

        loop {
            match state.active.as_ref() {
                Some(active) if active.id == token.id => {
                    if active.cancel_requested {
                        return Err(RUN_CANCELLED_MESSAGE.to_string());
                    }

                    if active.paused {
                        state = self
                            .shared
                            .pause_cv
                            .wait(state)
                            .expect("run controller poisoned");
                        continue;
                    }

                    return Ok(());
                }
                _ => return Err(RUN_CANCELLED_MESSAGE.to_string()),
            }
        }
    }

    fn register_sink(&self, token: &RunToken, sink: Arc<Sink>) -> Result<(), String> {
        let mut state = self.shared.state.lock().expect("run controller poisoned");
        let Some(active) = state.active.as_mut() else {
            sink.stop();
            return Err(RUN_CANCELLED_MESSAGE.to_string());
        };

        if active.id != token.id || active.cancel_requested {
            sink.stop();
            return Err(RUN_CANCELLED_MESSAGE.to_string());
        }

        if active.paused {
            sink.pause();
        } else {
            sink.play();
        }

        active.sink = Some(sink);
        Ok(())
    }

    fn clear_sink(&self, token: &RunToken) {
        let mut state = self.shared.state.lock().expect("run controller poisoned");
        let Some(active) = state.active.as_mut() else {
            return;
        };

        if active.id == token.id {
            active.sink = None;
        }
    }
}

impl RunAccess {
    pub fn action(&self) -> &str {
        &self.token.action
    }

    pub fn update_phase(&self, phase: impl Into<String>) {
        self.controller.update_phase(&self.token, phase.into(), None);
    }

    pub fn update_chunk_phase(&self, phase: impl Into<String>, index: usize, total: usize) {
        self.controller
            .update_phase(&self.token, phase.into(), Some((index, total)));
    }

    pub fn check_cancelled(&self) -> Result<(), String> {
        self.controller.check_cancelled(&self.token)
    }

    pub fn wait_if_paused(&self) -> Result<(), String> {
        self.controller.wait_if_paused(&self.token)
    }

    pub fn register_sink(&self, sink: Arc<Sink>) -> Result<(), String> {
        self.controller.register_sink(&self.token, sink)
    }

    pub fn clear_sink(&self) {
        self.controller.clear_sink(&self.token);
    }
}

impl RunHandle {
    pub fn access(&self) -> RunAccess {
        self.access.clone()
    }
}

impl Drop for RunHandle {
    fn drop(&mut self) {
        if !self.finished {
            self.access.controller.finish_run(&self.access.token);
            self.finished = true;
        }
    }
}

pub fn is_cancelled_error(error: &str) -> bool {
    error == RUN_CANCELLED_MESSAGE
}

fn snapshot_from_active(active: &ActiveRun) -> ActiveRunSnapshot {
    ActiveRunSnapshot {
        action: active.action.clone(),
        phase: active.phase.clone(),
        chunk_index: active.chunk_index,
        chunk_total: active.chunk_total,
        has_sink: active.sink.is_some(),
        paused: active.paused,
        cancel_requested: active.cancel_requested,
    }
}
