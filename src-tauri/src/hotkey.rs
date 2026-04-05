use crate::{
    run_controller::{is_cancelled_error, CancelResult, PauseResumeResult, RunController},
    settings::{DEFAULT_SPEAK_HOTKEY, DEFAULT_TRANSLATE_HOTKEY},
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

pub const DEFAULT_PAUSE_RESUME_HOTKEY: &str = "Ctrl+Shift+P";
pub const DEFAULT_CANCEL_HOTKEY: &str = "Ctrl+Shift+X";
pub const DEFAULT_ACTIVATE_ASSISTANT_HOTKEY: &str = "Ctrl+Shift+A";
pub const DEFAULT_DEACTIVATE_ASSISTANT_HOTKEY: &str = "Ctrl+Shift+D";
pub const HOTKEY_STATUS_EVENT: &str = "hotkey-status";
pub const LIVE_STT_CONTROL_EVENT: &str = "live-stt-control";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatusPayload {
    pub registered: bool,
    pub accelerator: &'static str,
    pub translate_accelerator: &'static str,
    pub pause_resume_accelerator: &'static str,
    pub cancel_accelerator: &'static str,
    pub activate_accelerator: &'static str,
    pub deactivate_accelerator: &'static str,
    pub platform: &'static str,
    pub state: &'static str,
    pub message: String,
    pub last_action: Option<String>,
    pub last_captured_text: Option<String>,
    pub last_audio_path: Option<String>,
    pub last_audio_output_directory: Option<String>,
    pub last_audio_chunk_count: Option<usize>,
    pub active_tts_mode: Option<String>,
    pub requested_tts_mode: Option<String>,
    pub session_strategy: Option<String>,
    pub session_id: Option<String>,
    pub session_fallback_reason: Option<String>,
    pub hotkey_started_at_ms: Option<u64>,
    pub capture_started_at_ms: Option<u64>,
    pub capture_finished_at_ms: Option<u64>,
    pub tts_started_at_ms: Option<u64>,
    pub first_audio_received_at_ms: Option<u64>,
    pub first_audio_playback_started_at_ms: Option<u64>,
    pub start_latency_ms: Option<u64>,
    pub hotkey_to_first_audio_ms: Option<u64>,
    pub hotkey_to_first_playback_ms: Option<u64>,
    pub capture_duration_ms: Option<u64>,
    pub capture_to_tts_start_ms: Option<u64>,
    pub tts_to_first_audio_ms: Option<u64>,
    pub first_audio_to_playback_ms: Option<u64>,
    pub last_translation_text: Option<String>,
    pub last_translation_target_language: Option<String>,
    pub last_stt_provider: Option<String>,
    pub last_stt_debug_log_path: Option<String>,
    pub last_stt_active_transcript: Option<String>,
}

#[derive(Default)]
pub(crate) struct HotkeySnapshot {
    registered: bool,
    state: &'static str,
    message: String,
    last_action: Option<String>,
    last_captured_text: Option<String>,
    last_audio_path: Option<String>,
    last_audio_output_directory: Option<String>,
    last_audio_chunk_count: Option<usize>,
    active_tts_mode: Option<String>,
    requested_tts_mode: Option<String>,
    session_strategy: Option<String>,
    session_id: Option<String>,
    session_fallback_reason: Option<String>,
    hotkey_started_at_ms: Option<u64>,
    capture_started_at_ms: Option<u64>,
    capture_finished_at_ms: Option<u64>,
    tts_started_at_ms: Option<u64>,
    first_audio_received_at_ms: Option<u64>,
    first_audio_playback_started_at_ms: Option<u64>,
    start_latency_ms: Option<u64>,
    hotkey_to_first_audio_ms: Option<u64>,
    hotkey_to_first_playback_ms: Option<u64>,
    capture_duration_ms: Option<u64>,
    capture_to_tts_start_ms: Option<u64>,
    tts_to_first_audio_ms: Option<u64>,
    first_audio_to_playback_ms: Option<u64>,
    last_translation_text: Option<String>,
    last_translation_target_language: Option<String>,
    last_stt_provider: Option<String>,
    last_stt_debug_log_path: Option<String>,
    last_stt_active_transcript: Option<String>,
}

pub struct HotkeyState {
    snapshot: Mutex<HotkeySnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSttControlPayload {
    pub action: &'static str,
    pub source: &'static str,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(HotkeySnapshot {
                registered: false,
                state: "idle",
                message: format!(
                    "Global hotkeys {DEFAULT_SPEAK_HOTKEY}, {DEFAULT_TRANSLATE_HOTKEY}, {DEFAULT_PAUSE_RESUME_HOTKEY}, {DEFAULT_CANCEL_HOTKEY}, {DEFAULT_ACTIVATE_ASSISTANT_HOTKEY}, and {DEFAULT_DEACTIVATE_ASSISTANT_HOTKEY} are not registered yet."
                ),
                ..Default::default()
            }),
        }
    }
}

impl HotkeyState {
    fn payload(&self) -> HotkeyStatusPayload {
        let snapshot = self.snapshot.lock().expect("hotkey snapshot poisoned");
        HotkeyStatusPayload {
            registered: snapshot.registered,
            accelerator: DEFAULT_SPEAK_HOTKEY,
            translate_accelerator: DEFAULT_TRANSLATE_HOTKEY,
            pause_resume_accelerator: DEFAULT_PAUSE_RESUME_HOTKEY,
            cancel_accelerator: DEFAULT_CANCEL_HOTKEY,
            activate_accelerator: DEFAULT_ACTIVATE_ASSISTANT_HOTKEY,
            deactivate_accelerator: DEFAULT_DEACTIVATE_ASSISTANT_HOTKEY,
            platform: if cfg!(target_os = "windows") { "windows" } else { "unsupported" },
            state: snapshot.state,
            message: snapshot.message.clone(),
            last_action: snapshot.last_action.clone(),
            last_captured_text: snapshot.last_captured_text.clone(),
            last_audio_path: snapshot.last_audio_path.clone(),
            last_audio_output_directory: snapshot.last_audio_output_directory.clone(),
            last_audio_chunk_count: snapshot.last_audio_chunk_count,
            active_tts_mode: snapshot.active_tts_mode.clone(),
            requested_tts_mode: snapshot.requested_tts_mode.clone(),
            session_strategy: snapshot.session_strategy.clone(),
            session_id: snapshot.session_id.clone(),
            session_fallback_reason: snapshot.session_fallback_reason.clone(),
            hotkey_started_at_ms: snapshot.hotkey_started_at_ms,
            capture_started_at_ms: snapshot.capture_started_at_ms,
            capture_finished_at_ms: snapshot.capture_finished_at_ms,
            tts_started_at_ms: snapshot.tts_started_at_ms,
            first_audio_received_at_ms: snapshot.first_audio_received_at_ms,
            first_audio_playback_started_at_ms: snapshot.first_audio_playback_started_at_ms,
            start_latency_ms: snapshot.start_latency_ms,
            hotkey_to_first_audio_ms: snapshot.hotkey_to_first_audio_ms,
            hotkey_to_first_playback_ms: snapshot.hotkey_to_first_playback_ms,
            capture_duration_ms: snapshot.capture_duration_ms,
            capture_to_tts_start_ms: snapshot.capture_to_tts_start_ms,
            tts_to_first_audio_ms: snapshot.tts_to_first_audio_ms,
            first_audio_to_playback_ms: snapshot.first_audio_to_playback_ms,
            last_translation_text: snapshot.last_translation_text.clone(),
            last_translation_target_language: snapshot.last_translation_target_language.clone(),
            last_stt_provider: snapshot.last_stt_provider.clone(),
            last_stt_debug_log_path: snapshot.last_stt_debug_log_path.clone(),
            last_stt_active_transcript: snapshot.last_stt_active_transcript.clone(),
        }
    }

    pub(crate) fn update<F>(&self, app: &AppHandle, updater: F)
    where
        F: FnOnce(&mut HotkeySnapshot),
    {
        {
            let mut snapshot = self.snapshot.lock().expect("hotkey snapshot poisoned");
            updater(&mut snapshot);
        }
        let _ = app.emit(HOTKEY_STATUS_EVENT, self.payload());
    }
}

fn recompute_timing_metrics(snapshot: &mut HotkeySnapshot) {
    snapshot.capture_duration_ms =
        match (snapshot.capture_started_at_ms, snapshot.capture_finished_at_ms) {
            (Some(started), Some(finished)) => finished.checked_sub(started),
            _ => None,
        };
    snapshot.capture_to_tts_start_ms =
        match (snapshot.capture_finished_at_ms, snapshot.tts_started_at_ms) {
            (Some(capture_finished), Some(tts_started)) => {
                tts_started.checked_sub(capture_finished)
            }
            _ => None,
        };
    snapshot.hotkey_to_first_audio_ms =
        match (snapshot.hotkey_started_at_ms, snapshot.first_audio_received_at_ms) {
            (Some(hotkey_started), Some(first_audio)) => first_audio.checked_sub(hotkey_started),
            _ => None,
        };
    snapshot.hotkey_to_first_playback_ms =
        match (snapshot.hotkey_started_at_ms, snapshot.first_audio_playback_started_at_ms) {
            (Some(hotkey_started), Some(first_playback)) => {
                first_playback.checked_sub(hotkey_started)
            }
            _ => None,
        };
    snapshot.tts_to_first_audio_ms =
        match (snapshot.tts_started_at_ms, snapshot.first_audio_received_at_ms) {
            (Some(tts_started), Some(first_audio)) => first_audio.checked_sub(tts_started),
            _ => None,
        };
    snapshot.first_audio_to_playback_ms =
        match (snapshot.first_audio_received_at_ms, snapshot.first_audio_playback_started_at_ms) {
            (Some(first_audio), Some(first_playback)) => first_playback.checked_sub(first_audio),
            _ => None,
        };
}

fn reset_tts_metrics(snapshot: &mut HotkeySnapshot) {
    snapshot.active_tts_mode = None;
    snapshot.requested_tts_mode = None;
    snapshot.session_strategy = None;
    snapshot.session_id = None;
    snapshot.session_fallback_reason = None;
    snapshot.hotkey_started_at_ms = None;
    snapshot.capture_started_at_ms = None;
    snapshot.capture_finished_at_ms = None;
    snapshot.tts_started_at_ms = None;
    snapshot.first_audio_received_at_ms = None;
    snapshot.first_audio_playback_started_at_ms = None;
    snapshot.start_latency_ms = None;
    snapshot.hotkey_to_first_audio_ms = None;
    snapshot.hotkey_to_first_playback_ms = None;
    snapshot.capture_duration_ms = None;
    snapshot.capture_to_tts_start_ms = None;
    snapshot.tts_to_first_audio_ms = None;
    snapshot.first_audio_to_playback_ms = None;
}

#[tauri::command]
pub fn get_hotkey_status(state: State<'_, HotkeyState>) -> HotkeyStatusPayload {
    state.payload()
}

pub fn begin_managed_run(
    app: &AppHandle,
    action: &str,
    message: String,
) -> Result<crate::run_controller::RunHandle, String> {
    let controller = app.state::<RunController>();
    let state = app.state::<HotkeyState>();
    match controller.start_run(action) {
        Ok(handle) => {
            state.update(app, |snapshot| {
                snapshot.state = "working";
                snapshot.last_action = Some(action.to_string());
                snapshot.message = message.clone();
                reset_tts_metrics(snapshot);
            });
            Ok(handle)
        }
        Err(error) => {
            state.update(app, |snapshot| {
                snapshot.state = "working";
                snapshot.message = error.clone();
            });
            Err(error)
        }
    }
}

pub fn update_working(app: &AppHandle, action: &str, message: String) {
    let state = app.state::<HotkeyState>();
    state.update(app, |snapshot| {
        snapshot.state = "working";
        snapshot.last_action = Some(action.to_string());
        snapshot.message = message.clone();
    });
}

pub fn set_cancelled(
    app: &AppHandle,
    action: &str,
    message: String,
    captured_text: Option<String>,
    translation_text: Option<String>,
    translation_target_language: Option<String>,
) {
    let state = app.state::<HotkeyState>();
    state.update(app, |snapshot| {
        snapshot.state = "idle";
        snapshot.last_action = Some(action.to_string());
        snapshot.message = message.clone();
        if let Some(text) = captured_text.clone() {
            snapshot.last_captured_text = Some(text);
        }
        if let Some(text) = translation_text.clone() {
            snapshot.last_translation_text = Some(text);
        }
        if let Some(lang) = translation_target_language.clone() {
            snapshot.last_translation_target_language = Some(lang);
        }
    });
}

pub fn set_error(
    app: &AppHandle,
    action: &str,
    message: String,
    captured_text: Option<String>,
    translation_text: Option<String>,
    translation_target_language: Option<String>,
) {
    let state = app.state::<HotkeyState>();
    state.update(app, |snapshot| {
        snapshot.state = "error";
        snapshot.last_action = Some(action.to_string());
        snapshot.message = message.clone();
        if let Some(text) = captured_text.clone() {
            snapshot.last_captured_text = Some(text);
        }
        if let Some(text) = translation_text.clone() {
            snapshot.last_translation_text = Some(text);
        }
        if let Some(lang) = translation_target_language.clone() {
            snapshot.last_translation_target_language = Some(lang);
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn init_hotkey(app: &AppHandle) {
    let state = app.state::<HotkeyState>();
    state.update(app, |snapshot| {
        snapshot.registered = false;
        snapshot.state = "unsupported";
        snapshot.message =
            "Global hotkey MVP is currently implemented for the packaged Windows app only."
                .to_string();
    });
}

#[cfg(target_os = "windows")]
pub fn init_hotkey(app: &AppHandle) {
    windows_impl::init_hotkeys(app);
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use crate::{
        selection_capture::{capture_selected_text, CaptureOptions},
        settings::SettingsState,
        translation::{translate_text, TranslateTextOptions},
        tts::{speak_text_with_progress_and_control, SpeakTextOptions, TtsProgress},
    };
    use std::{
        mem::MaybeUninit,
        thread,
        time::{Duration, Instant},
    };
    use windows::Win32::{
        Foundation::HWND,
        UI::{
            Input::KeyboardAndMouse::{
                RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_A, VK_D,
                VK_P, VK_SPACE, VK_T, VK_X,
            },
            WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY},
        },
    };

    const SPEAK_HOTKEY_ID: i32 = 0x564f41;
    const TRANSLATE_HOTKEY_ID: i32 = 0x564f54;
    const PAUSE_RESUME_HOTKEY_ID: i32 = 0x564f50;
    const CANCEL_HOTKEY_ID: i32 = 0x564f58;
    const ACTIVATE_ASSISTANT_HOTKEY_ID: i32 = 0x564f61;
    const DEACTIVATE_ASSISTANT_HOTKEY_ID: i32 = 0x564f62;

    pub fn init_hotkeys(app: &AppHandle) {
        let app_handle = app.clone();
        let state = app_handle.state::<HotkeyState>();
        state.update(&app_handle, |snapshot| {
            snapshot.state = "registering";
            snapshot.message = format!(
                "Registering global hotkeys {DEFAULT_SPEAK_HOTKEY}, {DEFAULT_TRANSLATE_HOTKEY}, {DEFAULT_PAUSE_RESUME_HOTKEY}, {DEFAULT_CANCEL_HOTKEY}, {DEFAULT_ACTIVATE_ASSISTANT_HOTKEY}, and {DEFAULT_DEACTIVATE_ASSISTANT_HOTKEY} …"
            );
        });

        thread::spawn(move || unsafe {
            let modifiers = MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT;
            for (id, key, label) in [
                (SPEAK_HOTKEY_ID, VK_SPACE.0 as u32, DEFAULT_SPEAK_HOTKEY),
                (TRANSLATE_HOTKEY_ID, VK_T.0 as u32, DEFAULT_TRANSLATE_HOTKEY),
                (PAUSE_RESUME_HOTKEY_ID, VK_P.0 as u32, DEFAULT_PAUSE_RESUME_HOTKEY),
                (CANCEL_HOTKEY_ID, VK_X.0 as u32, DEFAULT_CANCEL_HOTKEY),
                (ACTIVATE_ASSISTANT_HOTKEY_ID, VK_A.0 as u32, DEFAULT_ACTIVATE_ASSISTANT_HOTKEY),
                (
                    DEACTIVATE_ASSISTANT_HOTKEY_ID,
                    VK_D.0 as u32,
                    DEFAULT_DEACTIVATE_ASSISTANT_HOTKEY,
                ),
            ] {
                if let Err(error) = RegisterHotKey(HWND(std::ptr::null_mut()), id, modifiers, key) {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.registered = false;
                        snapshot.state = "error";
                        snapshot.message = format!("Could not register hotkey {label}: {error}.");
                    });
                    return;
                }
            }

            let state = app_handle.state::<HotkeyState>();
            state.update(&app_handle, |snapshot| {
                snapshot.registered = true;
                snapshot.state = "idle";
                snapshot.message = format!(
                    "Global hotkeys ready: {DEFAULT_SPEAK_HOTKEY} speaks, {DEFAULT_TRANSLATE_HOTKEY} translates, {DEFAULT_PAUSE_RESUME_HOTKEY} pauses/resumes, {DEFAULT_CANCEL_HOTKEY} cancels the current run, {DEFAULT_ACTIVATE_ASSISTANT_HOTKEY} activates the live assistant, and {DEFAULT_DEACTIVATE_ASSISTANT_HOTKEY} deactivates it."
                );
            });

            let mut message = MaybeUninit::<MSG>::zeroed();
            loop {
                let result = GetMessageW(message.as_mut_ptr(), HWND(std::ptr::null_mut()), 0, 0).0;
                if result == -1 || result == 0 {
                    break;
                }
                let msg = message.assume_init();
                if msg.message == WM_HOTKEY {
                    match msg.wParam.0 as i32 {
                        SPEAK_HOTKEY_ID => trigger_capture_and_speak(&app_handle),
                        TRANSLATE_HOTKEY_ID => trigger_capture_and_translate(&app_handle),
                        PAUSE_RESUME_HOTKEY_ID => trigger_pause_resume(&app_handle),
                        CANCEL_HOTKEY_ID => trigger_cancel(&app_handle),
                        ACTIVATE_ASSISTANT_HOTKEY_ID => {
                            trigger_live_stt_control(&app_handle, "activate")
                        }
                        DEACTIVATE_ASSISTANT_HOTKEY_ID => {
                            trigger_live_stt_control(&app_handle, "deactivate")
                        }
                        _ => {}
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }

            for id in [
                SPEAK_HOTKEY_ID,
                TRANSLATE_HOTKEY_ID,
                PAUSE_RESUME_HOTKEY_ID,
                CANCEL_HOTKEY_ID,
                ACTIVATE_ASSISTANT_HOTKEY_ID,
                DEACTIVATE_ASSISTANT_HOTKEY_ID,
            ] {
                let _ = UnregisterHotKey(HWND(std::ptr::null_mut()), id);
            }
        });
    }

    fn begin_run(
        app: &AppHandle,
        action: &str,
        message: String,
    ) -> Option<crate::run_controller::RunHandle> {
        let controller = app.state::<RunController>();
        match controller.start_run(action) {
            Ok(handle) => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = message;
                    reset_tts_metrics(snapshot);
                });
                Some(handle)
            }
            Err(error) => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.message = error;
                });
                None
            }
        }
    }

    fn update_working(app: &AppHandle, action: &str, message: String) {
        let state = app.state::<HotkeyState>();
        state.update(app, |snapshot| {
            snapshot.state = "working";
            snapshot.last_action = Some(action.to_string());
            snapshot.message = message;
        });
    }

    fn trigger_pause_resume(app: &AppHandle) {
        let controller = app.state::<RunController>();
        let result = controller.pause_resume();
        let state = app.state::<HotkeyState>();
        state.update(app, |snapshot| match result {
            PauseResumeResult::NoActiveRun => {
                snapshot.state = "idle";
                snapshot.message = "No active run to pause or resume.".to_string();
            }
            PauseResumeResult::CancelPending(active) => {
                snapshot.state = "working";
                snapshot.message = format!(
                    "Cancel is already pending for the current {} run (phase: {}).",
                    active.action, active.phase
                );
            }
            PauseResumeResult::Paused(active) => {
                snapshot.state = "working";
                snapshot.last_action = Some(active.action.clone());
                snapshot.message = format!(
                    "Paused current {} run at phase '{}'{}.",
                    active.action,
                    active.phase,
                    format_chunk_suffix(active.chunk_index, active.chunk_total)
                );
            }
            PauseResumeResult::Resumed(active) => {
                snapshot.state = "working";
                snapshot.last_action = Some(active.action.clone());
                snapshot.message = format!(
                    "Resumed current {} run at phase '{}'{}.",
                    active.action,
                    active.phase,
                    format_chunk_suffix(active.chunk_index, active.chunk_total)
                );
            }
        });
    }

    fn trigger_cancel(app: &AppHandle) {
        let controller = app.state::<RunController>();
        let result = controller.cancel();
        let state = app.state::<HotkeyState>();
        state.update(app, |snapshot| match result {
            CancelResult::NoActiveRun => {
                snapshot.state = "idle";
                snapshot.message = "No active run to cancel.".to_string();
            }
            CancelResult::CancelRequested(active) | CancelResult::AlreadyRequested(active) => {
                snapshot.state = "working";
                snapshot.last_action = Some(active.action.clone());
                snapshot.message = format!(
                    "Cancelling current {} run at phase '{}'{} …",
                    active.action,
                    active.phase,
                    format_chunk_suffix(active.chunk_index, active.chunk_total)
                );
            }
        });
    }

    fn trigger_live_stt_control(app: &AppHandle, action: &'static str) {
        let detail = if action == "activate" {
            "Requested live assistant activation via global hotkey."
        } else {
            "Requested live assistant deactivation via global hotkey."
        };

        let _ =
            app.emit(LIVE_STT_CONTROL_EVENT, LiveSttControlPayload { action, source: "hotkey" });

        let state = app.state::<HotkeyState>();
        state.update(app, |snapshot| {
            snapshot.state = "idle";
            snapshot.last_action = Some(format!("live-stt-{action}"));
            snapshot.message = detail.to_string();
        });
    }

    fn trigger_capture_and_speak(app: &AppHandle) {
        let Some(run_handle) =
            begin_run(app, "speak", "Speak hotkey received. Capturing selection …".to_string())
        else {
            return;
        };
        let app_handle = app.clone();
        thread::spawn(move || {
            let overall_started = Instant::now();
            let hotkey_started_at_ms = system_time_ms();
            let run_access = run_handle.access();
            run_access.update_phase("capturing_selection");

            let state = app_handle.state::<HotkeyState>();
            state.update(&app_handle, |snapshot| {
                snapshot.hotkey_started_at_ms = Some(hotkey_started_at_ms);
                snapshot.capture_started_at_ms = Some(system_time_ms());
                recompute_timing_metrics(snapshot);
            });

            let capture = capture_selected_text(Some(CaptureOptions {
                copy_delay_ms: Some(100),
                restore_clipboard: Some(true),
            }));

            let capture_finished_at_ms = system_time_ms();
            let state = app_handle.state::<HotkeyState>();
            state.update(&app_handle, |snapshot| {
                snapshot.capture_finished_at_ms = Some(capture_finished_at_ms);
                recompute_timing_metrics(snapshot);
            });

            let capture = match capture {
                Ok(capture) if !capture.text.trim().is_empty() => capture,
                Ok(capture) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.last_action = Some("speak".to_string());
                        snapshot.message = capture
                            .note
                            .unwrap_or_else(|| "No marked text could be captured.".to_string());
                    });
                    return;
                }
                Err(error) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.last_action = Some("speak".to_string());
                        snapshot.message = format!("Capture failed: {error}");
                    });
                    return;
                }
            };

            let settings = app_handle.state::<SettingsState>().get();
            let progress_app = app_handle.clone();
            let progress = Arc::new(move |progress: TtsProgress| {
                update_progress(&progress_app, "speak", progress)
            });
            let result = speak_text_with_progress_and_control(
                SpeakTextOptions {
                    text: Some(capture.text.clone()),
                    voice: Some("alloy".to_string()),
                    model: None,
                    format: Some("wav".to_string()),
                    mode: Some("live".to_string()),
                    autoplay: Some(true),
                    max_chunk_chars: None,
                    max_parallel_requests: Some(3),
                    first_chunk_leading_silence_ms: Some(0),
                },
                &settings,
                Some(progress),
                Some(run_access.clone()),
            );

            let state = app_handle.state::<HotkeyState>();
            match result {
                Ok(result) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "success";
                    snapshot.message = format!(
                        "Speak run finished in {} ms. Mode {} produced {} chunk(s) as {}{}{}.",
                        overall_started.elapsed().as_millis(),
                        result.mode,
                        result.chunk_count,
                        result.format.to_uppercase(),
                        format_start_latency_suffix(result.start_latency_ms),
                        format_hotkey_to_first_playback_suffix(
                            snapshot.hotkey_started_at_ms,
                            result.first_audio_playback_started_at_ms,
                        )
                    );
                    snapshot.last_action = Some("speak".to_string());
                    snapshot.last_captured_text = Some(capture.text);
                    snapshot.last_audio_path = Some(result.file_path);
                    snapshot.last_audio_output_directory = Some(result.output_directory);
                    snapshot.last_audio_chunk_count = Some(result.chunk_count);
                    snapshot.active_tts_mode = Some(result.mode.clone());
                    snapshot.requested_tts_mode = Some(result.requested_mode);
                    snapshot.session_strategy = Some(result.session_strategy);
                    snapshot.session_id = Some(result.session_id);
                    snapshot.session_fallback_reason = result.fallback_reason;
                    snapshot.first_audio_received_at_ms = result.first_audio_received_at_ms;
                    snapshot.first_audio_playback_started_at_ms =
                        result.first_audio_playback_started_at_ms;
                    snapshot.start_latency_ms = result.start_latency_ms;
                    recompute_timing_metrics(snapshot);
                }),
                Err(error) if is_cancelled_error(&error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "success";
                    snapshot.message = format!(
                        "Speak run cancelled after {} ms.",
                        overall_started.elapsed().as_millis()
                    );
                    snapshot.last_action = Some("speak".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                }),
                Err(error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "error";
                    snapshot.message = format!(
                        "Speak run failed after {} ms: {error}",
                        overall_started.elapsed().as_millis()
                    );
                    snapshot.last_action = Some("speak".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                }),
            }
        });
    }

    fn trigger_capture_and_translate(app: &AppHandle) {
        let target_language = app.state::<SettingsState>().get().translation_target_language;
        let Some(run_handle) = begin_run(
            app,
            "translate",
            format!("Translate hotkey received. Capturing selection for {target_language} …"),
        ) else {
            return;
        };

        let app_handle = app.clone();
        thread::spawn(move || {
            let overall_started = Instant::now();
            let hotkey_started_at_ms = system_time_ms();
            let run_access = run_handle.access();
            run_access.update_phase("capturing_selection");

            let state = app_handle.state::<HotkeyState>();
            state.update(&app_handle, |snapshot| {
                snapshot.hotkey_started_at_ms = Some(hotkey_started_at_ms);
                snapshot.capture_started_at_ms = Some(system_time_ms());
                recompute_timing_metrics(snapshot);
            });

            let capture = capture_selected_text(Some(CaptureOptions {
                copy_delay_ms: Some(100),
                restore_clipboard: Some(true),
            }));

            let capture_finished_at_ms = system_time_ms();
            let state = app_handle.state::<HotkeyState>();
            state.update(&app_handle, |snapshot| {
                snapshot.capture_finished_at_ms = Some(capture_finished_at_ms);
                recompute_timing_metrics(snapshot);
            });

            let capture = match capture {
                Ok(capture) if !capture.text.trim().is_empty() => capture,
                Ok(capture) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.last_action = Some("translate".to_string());
                        snapshot.message = capture
                            .note
                            .unwrap_or_else(|| "No marked text could be captured.".to_string());
                    });
                    return;
                }
                Err(error) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.last_action = Some("translate".to_string());
                        snapshot.message = format!("Capture failed: {error}");
                    });
                    return;
                }
            };

            let settings = app_handle.state::<SettingsState>().get();

            run_access.check_cancelled().ok();
            run_access.update_phase("translating_text");
            let translation = translate_text(
                TranslateTextOptions {
                    text: Some(capture.text.clone()),
                    target_language: Some(settings.translation_target_language.clone()),
                    source_language: None,
                    model: None,
                },
                &settings,
            );

            let translation = match translation {
                Ok(translation) => translation,
                Err(error) if is_cancelled_error(&error) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "success";
                        snapshot.message = format!(
                            "Translate run cancelled after {} ms.",
                            overall_started.elapsed().as_millis()
                        );
                        snapshot.last_action = Some("translate".to_string());
                        snapshot.last_captured_text = Some(capture.text.clone());
                    });
                    return;
                }
                Err(error) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.message = format!("Translation failed: {error}");
                        snapshot.last_action = Some("translate".to_string());
                        snapshot.last_captured_text = Some(capture.text.clone());
                    });
                    return;
                }
            };

            let progress_app = app_handle.clone();
            let progress = Arc::new(move |progress: TtsProgress| {
                update_progress(&progress_app, "translate", progress)
            });
            let speech = speak_text_with_progress_and_control(
                SpeakTextOptions {
                    text: Some(translation.text.clone()),
                    voice: None,
                    model: None,
                    format: Some("wav".to_string()),
                    mode: Some("live".to_string()),
                    autoplay: Some(true),
                    max_chunk_chars: None,
                    max_parallel_requests: Some(3),
                    first_chunk_leading_silence_ms: Some(0),
                },
                &settings,
                Some(progress),
                Some(run_access.clone()),
            );

            let state = app_handle.state::<HotkeyState>();
            match speech {
                Ok(speech) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "success";
                    snapshot.message = format!(
                        "Translate run finished in {} ms. Mode {} produced {} chunk(s){}{}.",
                        overall_started.elapsed().as_millis(),
                        speech.mode,
                        speech.chunk_count,
                        format_start_latency_suffix(speech.start_latency_ms),
                        format_hotkey_to_first_playback_suffix(
                            snapshot.hotkey_started_at_ms,
                            speech.first_audio_playback_started_at_ms,
                        )
                    );
                    snapshot.last_action = Some("translate".to_string());
                    snapshot.last_captured_text = Some(capture.text);
                    snapshot.last_translation_target_language =
                        Some(translation.target_language.clone());
                    snapshot.last_translation_text = Some(translation.text);
                    snapshot.last_audio_path = Some(speech.file_path);
                    snapshot.last_audio_output_directory = Some(speech.output_directory);
                    snapshot.last_audio_chunk_count = Some(speech.chunk_count);
                    snapshot.active_tts_mode = Some(speech.mode.clone());
                    snapshot.requested_tts_mode = Some(speech.requested_mode);
                    snapshot.session_strategy = Some(speech.session_strategy);
                    snapshot.session_id = Some(speech.session_id);
                    snapshot.session_fallback_reason = speech.fallback_reason;
                    snapshot.first_audio_received_at_ms = speech.first_audio_received_at_ms;
                    snapshot.first_audio_playback_started_at_ms =
                        speech.first_audio_playback_started_at_ms;
                    snapshot.start_latency_ms = speech.start_latency_ms;
                    recompute_timing_metrics(snapshot);
                }),
                Err(error) if is_cancelled_error(&error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "success";
                    snapshot.message = format!(
                        "Translate run cancelled after {} ms.",
                        overall_started.elapsed().as_millis()
                    );
                    snapshot.last_action = Some("translate".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                    snapshot.last_translation_target_language =
                        Some(translation.target_language.clone());
                    snapshot.last_translation_text = Some(translation.text.clone());
                }),
                Err(error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "error";
                    snapshot.message = format!(
                        "Translated TTS failed after {} ms: {error}",
                        overall_started.elapsed().as_millis()
                    );
                    snapshot.last_action = Some("translate".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                    snapshot.last_translation_target_language =
                        Some(translation.target_language.clone());
                    snapshot.last_translation_text = Some(translation.text.clone());
                }),
            }
        });
    }

    fn update_progress(app: &AppHandle, action: &str, progress: TtsProgress) {
        match progress {
            TtsProgress::PipelineStarted { mode, chunk_count, format, started_at_ms, .. } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = format!(
                        "TTS pipeline started in {mode} mode. Planned {chunk_count} chunk(s) as {}.",
                        format.to_uppercase()
                    );
                    snapshot.active_tts_mode = Some(mode);
                    snapshot.tts_started_at_ms = Some(started_at_ms);
                    snapshot.first_audio_received_at_ms = None;
                    snapshot.first_audio_playback_started_at_ms = None;
                    snapshot.start_latency_ms = None;
                    recompute_timing_metrics(snapshot);
                });
            }
            TtsProgress::RealtimeConnecting { mode, model, voice, session_id } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = format!(
                        "Connecting realtime websocket session {session_id} with model {model} and voice {voice}."
                    );
                    snapshot.active_tts_mode = Some(mode);
                    snapshot.session_id = Some(session_id);
                });
            }
            TtsProgress::RealtimeConnected { mode, model, voice, session_id } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = format!(
                        "Realtime connect ok for session {session_id}. Streaming with model {model} and voice {voice}."
                    );
                    snapshot.active_tts_mode = Some(mode);
                    snapshot.session_id = Some(session_id);
                });
            }
            TtsProgress::RealtimeSessionUpdateSucceeded { mode, session_id } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message =
                        format!("Realtime session.update ok for session {session_id}.");
                    snapshot.active_tts_mode = Some(mode);
                    snapshot.session_id = Some(session_id);
                });
            }
            TtsProgress::RealtimeResponseCreateSucceeded { mode, session_id } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = format!("Realtime response.create ok for session {session_id}. Waiting for first audio delta …");
                    snapshot.active_tts_mode = Some(mode);
                    snapshot.session_id = Some(session_id);
                });
            }
            TtsProgress::RealtimeNoAudioReceived { mode, session_id, detail } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = format!(
                        "Realtime first audio delta missing for session {session_id}: {detail}"
                    );
                    snapshot.active_tts_mode = Some(mode);
                    snapshot.session_id = Some(session_id);
                });
            }
            TtsProgress::FallbackToLive { reason } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = reason.clone();
                    snapshot.active_tts_mode = Some("live".to_string());
                    snapshot.session_fallback_reason = Some(reason);
                });
            }
            TtsProgress::FirstAudioReceived { mode, at_ms, latency_ms, bytes_received } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = format!(
                        "First audio arrived in {latency_ms} ms ({bytes_received} bytes, mode {mode})."
                    );
                    snapshot.active_tts_mode = Some(mode);
                    snapshot.first_audio_received_at_ms = Some(at_ms);
                    recompute_timing_metrics(snapshot);
                });
            }
            TtsProgress::FirstAudioPlaybackStarted { mode, at_ms, latency_ms } => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message =
                        format!("Audible playback started after {latency_ms} ms in {mode} mode.");
                    snapshot.active_tts_mode = Some(mode);
                    snapshot.first_audio_playback_started_at_ms = Some(at_ms);
                    snapshot.start_latency_ms = Some(latency_ms);
                    recompute_timing_metrics(snapshot);
                });
            }
            TtsProgress::ChunkRequestStarted { index, total, text_chars } => {
                update_working(
                    app,
                    action,
                    format!("Preparing chunk {}/{} … ({} chars)", index + 1, total, text_chars),
                );
            }
            TtsProgress::ChunkRequestFinished { index, total, elapsed_ms, .. } => {
                update_working(
                    app,
                    action,
                    format!("Chunk {}/{} ready after {} ms.", index + 1, total, elapsed_ms),
                );
            }
            TtsProgress::ChunkFileWritten { index, total, .. } => {
                update_working(
                    app,
                    action,
                    format!(
                        "Chunk {}/{} written. Waiting for ordered playback …",
                        index + 1,
                        total
                    ),
                );
            }
            TtsProgress::ChunkPlaybackStarted { index, total, .. } => {
                update_working(app, action, format!("Playing chunk {}/{} …", index + 1, total));
            }
            TtsProgress::ChunkPlaybackFinished { index, total, elapsed_ms } => {
                update_working(
                    app,
                    action,
                    format!("Finished chunk {}/{} playback ({} ms).", index + 1, total, elapsed_ms),
                );
            }
        }
    }

    fn format_chunk_suffix(index: Option<usize>, total: Option<usize>) -> String {
        match (index, total) {
            (Some(index), Some(total)) => format!(" on chunk {index}/{total}"),
            _ => String::new(),
        }
    }

    fn system_time_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0)
    }

    fn format_start_latency_suffix(start_latency_ms: Option<u64>) -> String {
        start_latency_ms
            .map(|value| format!(" First audible audio after {value} ms"))
            .unwrap_or_default()
    }

    fn format_hotkey_to_first_playback_suffix(
        hotkey_started_at_ms: Option<u64>,
        first_audio_playback_started_at_ms: Option<u64>,
    ) -> String {
        match (hotkey_started_at_ms, first_audio_playback_started_at_ms) {
            (Some(hotkey_started), Some(first_playback)) => first_playback
                .checked_sub(hotkey_started)
                .map(|value| format!(" End-to-end hotkey→audio {value} ms"))
                .unwrap_or_default(),
            _ => String::new(),
        }
    }
}
