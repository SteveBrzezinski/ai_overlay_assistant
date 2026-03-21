use crate::{
    run_controller::{is_cancelled_error, CancelResult, PauseResumeResult, RunController},
    settings::{DEFAULT_SPEAK_HOTKEY, DEFAULT_TRANSLATE_HOTKEY},
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub const DEFAULT_PAUSE_RESUME_HOTKEY: &str = "Ctrl+Shift+P";
pub const DEFAULT_CANCEL_HOTKEY: &str = "Ctrl+Shift+X";
pub const HOTKEY_STATUS_EVENT: &str = "hotkey-status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatusPayload {
    pub registered: bool,
    pub accelerator: &'static str,
    pub translate_accelerator: &'static str,
    pub pause_resume_accelerator: &'static str,
    pub cancel_accelerator: &'static str,
    pub platform: &'static str,
    pub state: &'static str,
    pub message: String,
    pub last_action: Option<String>,
    pub last_captured_text: Option<String>,
    pub last_audio_path: Option<String>,
    pub last_audio_output_directory: Option<String>,
    pub last_audio_chunk_count: Option<usize>,
    pub last_translation_text: Option<String>,
    pub last_translation_target_language: Option<String>,
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
    last_translation_text: Option<String>,
    last_translation_target_language: Option<String>,
}

pub struct HotkeyState {
    snapshot: Mutex<HotkeySnapshot>,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(HotkeySnapshot {
                registered: false,
                state: "idle",
                message: format!(
                    "Global hotkeys {DEFAULT_SPEAK_HOTKEY}, {DEFAULT_TRANSLATE_HOTKEY}, {DEFAULT_PAUSE_RESUME_HOTKEY}, and {DEFAULT_CANCEL_HOTKEY} are not registered yet."
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
            platform: if cfg!(target_os = "windows") { "windows" } else { "unsupported" },
            state: snapshot.state,
            message: snapshot.message.clone(),
            last_action: snapshot.last_action.clone(),
            last_captured_text: snapshot.last_captured_text.clone(),
            last_audio_path: snapshot.last_audio_path.clone(),
            last_audio_output_directory: snapshot.last_audio_output_directory.clone(),
            last_audio_chunk_count: snapshot.last_audio_chunk_count,
            last_translation_text: snapshot.last_translation_text.clone(),
            last_translation_target_language: snapshot.last_translation_target_language.clone(),
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
        snapshot.message = "Global hotkey MVP is currently implemented for the packaged Windows app only.".to_string();
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
    use std::{mem::MaybeUninit, thread, time::{Duration, Instant}};
    use windows::Win32::{
        Foundation::HWND,
        UI::{
            Input::KeyboardAndMouse::{
                RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_P,
                VK_SPACE, VK_T, VK_X,
            },
            WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY},
        },
    };

    const SPEAK_HOTKEY_ID: i32 = 0x564f41;
    const TRANSLATE_HOTKEY_ID: i32 = 0x564f54;
    const PAUSE_RESUME_HOTKEY_ID: i32 = 0x564f50;
    const CANCEL_HOTKEY_ID: i32 = 0x564f58;

    pub fn init_hotkeys(app: &AppHandle) {
        let app_handle = app.clone();
        let state = app_handle.state::<HotkeyState>();
        state.update(&app_handle, |snapshot| {
            snapshot.state = "registering";
            snapshot.message = format!(
                "Registering global hotkeys {DEFAULT_SPEAK_HOTKEY}, {DEFAULT_TRANSLATE_HOTKEY}, {DEFAULT_PAUSE_RESUME_HOTKEY}, and {DEFAULT_CANCEL_HOTKEY} …"
            );
        });

        thread::spawn(move || unsafe {
            let modifiers = MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT;
            for (id, key, label) in [
                (SPEAK_HOTKEY_ID, VK_SPACE.0 as u32, DEFAULT_SPEAK_HOTKEY),
                (TRANSLATE_HOTKEY_ID, VK_T.0 as u32, DEFAULT_TRANSLATE_HOTKEY),
                (PAUSE_RESUME_HOTKEY_ID, VK_P.0 as u32, DEFAULT_PAUSE_RESUME_HOTKEY),
                (CANCEL_HOTKEY_ID, VK_X.0 as u32, DEFAULT_CANCEL_HOTKEY),
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
                    "Global hotkeys ready: {DEFAULT_SPEAK_HOTKEY} speaks, {DEFAULT_TRANSLATE_HOTKEY} translates, {DEFAULT_PAUSE_RESUME_HOTKEY} pauses/resumes, {DEFAULT_CANCEL_HOTKEY} cancels the current run."
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
                        _ => {}
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }

            for id in [SPEAK_HOTKEY_ID, TRANSLATE_HOTKEY_ID, PAUSE_RESUME_HOTKEY_ID, CANCEL_HOTKEY_ID] {
                let _ = UnregisterHotKey(HWND(std::ptr::null_mut()), id);
            }
        });
    }

    fn begin_run(app: &AppHandle, action: &str, message: String) -> Option<crate::run_controller::RunHandle> {
        let controller = app.state::<RunController>();
        match controller.start_run(action) {
            Ok(handle) => {
                let state = app.state::<HotkeyState>();
                state.update(app, |snapshot| {
                    snapshot.state = "working";
                    snapshot.last_action = Some(action.to_string());
                    snapshot.message = message;
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

    fn trigger_capture_and_speak(app: &AppHandle) {
        let Some(run_handle) = begin_run(app, "speak", "Speak hotkey received. Capturing selection …".to_string()) else {
            return;
        };
        let app_handle = app.clone();
        thread::spawn(move || {
            let overall_started = Instant::now();
            let run_access = run_handle.access();
            run_access.update_phase("capturing_selection");

            let capture = capture_selected_text(Some(CaptureOptions {
                copy_delay_ms: Some(140),
                restore_clipboard: Some(true),
            }));

            let capture = match capture {
                Ok(capture) if !capture.text.trim().is_empty() => capture,
                Ok(capture) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.last_action = Some("speak".to_string());
                        snapshot.message = capture.note.unwrap_or_else(|| "No marked text could be captured.".to_string());
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
            let progress = Arc::new(move |progress: TtsProgress| update_progress(&progress_app, "speak", progress));
            let result = speak_text_with_progress_and_control(
                SpeakTextOptions {
                    text: Some(capture.text.clone()),
                    voice: Some("alloy".to_string()),
                    model: None,
                    format: Some(settings.tts_format.clone()),
                    autoplay: Some(true),
                    max_chunk_chars: None,
                    max_parallel_requests: Some(3),
                    first_chunk_leading_silence_ms: Some(settings.first_chunk_leading_silence_ms),
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
                        "Speak run finished in {} ms. Generated {} chunk(s) and played them in order as {}.",
                        overall_started.elapsed().as_millis(),
                        result.chunk_count,
                        result.format.to_uppercase()
                    );
                    snapshot.last_action = Some("speak".to_string());
                    snapshot.last_captured_text = Some(capture.text);
                    snapshot.last_audio_path = Some(result.file_path);
                    snapshot.last_audio_output_directory = Some(result.output_directory);
                    snapshot.last_audio_chunk_count = Some(result.chunk_count);
                }),
                Err(error) if is_cancelled_error(&error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "success";
                    snapshot.message = format!("Speak run cancelled after {} ms.", overall_started.elapsed().as_millis());
                    snapshot.last_action = Some("speak".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                }),
                Err(error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "error";
                    snapshot.message = format!("Speak run failed after {} ms: {error}", overall_started.elapsed().as_millis());
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
            let run_access = run_handle.access();
            run_access.update_phase("capturing_selection");

            let capture = capture_selected_text(Some(CaptureOptions {
                copy_delay_ms: Some(140),
                restore_clipboard: Some(true),
            }));

            let capture = match capture {
                Ok(capture) if !capture.text.trim().is_empty() => capture,
                Ok(capture) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.last_action = Some("translate".to_string());
                        snapshot.message = capture.note.unwrap_or_else(|| "No marked text could be captured.".to_string());
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

            run_access.check_cancelled().ok();
            run_access.update_phase("translating_text");
            let settings = app_handle.state::<SettingsState>().get();
            let translation = translate_text(TranslateTextOptions {
                text: Some(capture.text.clone()),
                target_language: Some(settings.translation_target_language.clone()),
                source_language: None,
                model: None,
            });

            let translation = match translation {
                Ok(translation) => translation,
                Err(error) if is_cancelled_error(&error) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "success";
                        snapshot.message = format!("Translate run cancelled after {} ms.", overall_started.elapsed().as_millis());
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
            let progress = Arc::new(move |progress: TtsProgress| update_progress(&progress_app, "translate", progress));
            let speech = speak_text_with_progress_and_control(
                SpeakTextOptions {
                    text: Some(translation.text.clone()),
                    voice: None,
                    model: None,
                    format: Some(settings.tts_format.clone()),
                    autoplay: Some(true),
                    max_chunk_chars: None,
                    max_parallel_requests: Some(3),
                    first_chunk_leading_silence_ms: Some(settings.first_chunk_leading_silence_ms),
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
                        "Translate run finished in {} ms. TTS produced {} chunk(s) and playback completed in order.",
                        overall_started.elapsed().as_millis(),
                        speech.chunk_count
                    );
                    snapshot.last_action = Some("translate".to_string());
                    snapshot.last_captured_text = Some(capture.text);
                    snapshot.last_translation_target_language = Some(translation.target_language.clone());
                    snapshot.last_translation_text = Some(translation.text);
                    snapshot.last_audio_path = Some(speech.file_path);
                    snapshot.last_audio_output_directory = Some(speech.output_directory);
                    snapshot.last_audio_chunk_count = Some(speech.chunk_count);
                }),
                Err(error) if is_cancelled_error(&error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "success";
                    snapshot.message = format!("Translate run cancelled after {} ms.", overall_started.elapsed().as_millis());
                    snapshot.last_action = Some("translate".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                    snapshot.last_translation_target_language = Some(translation.target_language.clone());
                    snapshot.last_translation_text = Some(translation.text.clone());
                }),
                Err(error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "error";
                    snapshot.message = format!("Translated TTS failed after {} ms: {error}", overall_started.elapsed().as_millis());
                    snapshot.last_action = Some("translate".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                    snapshot.last_translation_target_language = Some(translation.target_language.clone());
                    snapshot.last_translation_text = Some(translation.text.clone());
                }),
            }
        });
    }

    fn update_progress(app: &AppHandle, action: &str, progress: TtsProgress) {
        match progress {
            TtsProgress::PipelineStarted { chunk_count, format, .. } => {
                update_working(app, action, format!("TTS pipeline started. Planned {chunk_count} chunk(s) as {}.", format.to_uppercase()));
            }
            TtsProgress::ChunkRequestStarted { index, total, text_chars } => {
                update_working(app, action, format!("Preparing chunk {}/{} … ({} chars)", index + 1, total, text_chars));
            }
            TtsProgress::ChunkRequestFinished { index, total, elapsed_ms, .. } => {
                update_working(app, action, format!("Chunk {}/{} ready after {} ms.", index + 1, total, elapsed_ms));
            }
            TtsProgress::ChunkFileWritten { index, total, .. } => {
                update_working(app, action, format!("Chunk {}/{} written. Waiting for ordered playback …", index + 1, total));
            }
            TtsProgress::ChunkPlaybackStarted { index, total, .. } => {
                update_working(app, action, format!("Playing chunk {}/{} …", index + 1, total));
            }
            TtsProgress::ChunkPlaybackFinished { index, total, elapsed_ms } => {
                update_working(app, action, format!("Finished chunk {}/{} playback ({} ms).", index + 1, total, elapsed_ms));
            }
        }
    }

    fn format_chunk_suffix(index: Option<usize>, total: Option<usize>) -> String {
        match (index, total) {
            (Some(index), Some(total)) => format!(" on chunk {index}/{total}"),
            _ => String::new(),
        }
    }
}
