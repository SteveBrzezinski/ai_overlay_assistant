use crate::settings::{DEFAULT_SPEAK_HOTKEY, DEFAULT_TRANSLATE_HOTKEY};
use serde::Serialize;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub const HOTKEY_STATUS_EVENT: &str = "hotkey-status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatusPayload {
    pub registered: bool,
    pub accelerator: &'static str,
    pub translate_accelerator: &'static str,
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
struct HotkeySnapshot {
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
    is_running: AtomicBool,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(HotkeySnapshot {
                registered: false,
                state: "idle",
                message: format!(
                    "Global hotkeys {DEFAULT_SPEAK_HOTKEY} and {DEFAULT_TRANSLATE_HOTKEY} are not registered yet."
                ),
                last_action: None,
                last_captured_text: None,
                last_audio_path: None,
                last_audio_output_directory: None,
                last_audio_chunk_count: None,
                last_translation_text: None,
                last_translation_target_language: None,
            }),
            is_running: AtomicBool::new(false),
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

    fn update<F>(&self, app: &AppHandle, updater: F)
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

#[cfg(target_os = "windows")]
pub fn init_hotkey(app: &AppHandle) {
    windows_impl::init_hotkeys(app);
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
mod windows_impl {
    use super::{HotkeyState, DEFAULT_SPEAK_HOTKEY, DEFAULT_TRANSLATE_HOTKEY};
    use crate::{
        selection_capture::{capture_selected_text, CaptureOptions},
        settings::SettingsState,
        translation::{translate_text, TranslateTextOptions},
        tts::{speak_text_with_progress, SpeakTextOptions, TtsProgress},
    };
    use std::{mem::MaybeUninit, sync::Arc, thread, time::{Duration, Instant}};
    use tauri::{AppHandle, Manager};
    use windows::Win32::{
        Foundation::HWND,
        UI::{
            Input::KeyboardAndMouse::{
                RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_SPACE,
                VK_T,
            },
            WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY},
        },
    };

    const SPEAK_HOTKEY_ID: i32 = 0x564f41;
    const TRANSLATE_HOTKEY_ID: i32 = 0x564f54;

    pub fn init_hotkeys(app: &AppHandle) {
        let app_handle = app.clone();
        let state = app_handle.state::<HotkeyState>();
        state.update(&app_handle, |snapshot| {
            snapshot.state = "registering";
            snapshot.message = format!(
                "Registering global hotkeys {DEFAULT_SPEAK_HOTKEY} and {DEFAULT_TRANSLATE_HOTKEY} …"
            );
        });

        thread::spawn(move || unsafe {
            let modifiers = MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT;
            let speak = RegisterHotKey(HWND(std::ptr::null_mut()), SPEAK_HOTKEY_ID, modifiers, VK_SPACE.0 as u32);
            let translate = RegisterHotKey(HWND(std::ptr::null_mut()), TRANSLATE_HOTKEY_ID, modifiers, VK_T.0 as u32);

            if let Err(error) = speak {
                let state = app_handle.state::<HotkeyState>();
                state.update(&app_handle, |snapshot| {
                    snapshot.registered = false;
                    snapshot.state = "error";
                    snapshot.message = format!("Could not register speak hotkey {DEFAULT_SPEAK_HOTKEY}: {error}.");
                });
                return;
            }

            if let Err(error) = translate {
                let _ = UnregisterHotKey(HWND(std::ptr::null_mut()), SPEAK_HOTKEY_ID);
                let state = app_handle.state::<HotkeyState>();
                state.update(&app_handle, |snapshot| {
                    snapshot.registered = false;
                    snapshot.state = "error";
                    snapshot.message = format!("Could not register translate hotkey {DEFAULT_TRANSLATE_HOTKEY}: {error}.");
                });
                return;
            }

            let state = app_handle.state::<HotkeyState>();
            state.update(&app_handle, |snapshot| {
                snapshot.registered = true;
                snapshot.state = "idle";
                snapshot.message = format!(
                    "Global hotkeys ready: {DEFAULT_SPEAK_HOTKEY} speaks, {DEFAULT_TRANSLATE_HOTKEY} translates the current selection."
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
                        _ => {}
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }

            let _ = UnregisterHotKey(HWND(std::ptr::null_mut()), SPEAK_HOTKEY_ID);
            let _ = UnregisterHotKey(HWND(std::ptr::null_mut()), TRANSLATE_HOTKEY_ID);
        });
    }

    fn begin_run(app: &AppHandle, action: &str, message: String) -> bool {
        let state = app.state::<HotkeyState>();
        if state.is_running.swap(true, std::sync::atomic::Ordering::SeqCst) {
            state.update(app, |snapshot| {
                snapshot.state = "working";
                snapshot.message = "Another hotkey run is still active. Ignoring the extra press."
                    .to_string();
            });
            false
        } else {
            state.update(app, |snapshot| {
                snapshot.state = "working";
                snapshot.last_action = Some(action.to_string());
                snapshot.message = message;
            });
            true
        }
    }

    fn finish_run(app: &AppHandle) {
        let state = app.state::<HotkeyState>();
        state.is_running.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    fn update_working(app: &AppHandle, action: &str, message: String) {
        let state = app.state::<HotkeyState>();
        state.update(app, |snapshot| {
            snapshot.state = "working";
            snapshot.last_action = Some(action.to_string());
            snapshot.message = message;
        });
    }

    fn log_phase(action: &str, phase: &str, started: Instant, extra: &str) {
        println!(
            "[hotkey] action={} phase={} elapsed_ms={} {}",
            action,
            phase,
            started.elapsed().as_millis(),
            extra
        );
    }

    fn trigger_capture_and_speak(app: &AppHandle) {
        if !begin_run(
            app,
            "speak",
            "Speak hotkey received. Capturing selection …".to_string(),
        ) {
            return;
        }

        let app_handle = app.clone();
        thread::spawn(move || {
            let overall_started = Instant::now();
            let capture_started = Instant::now();
            update_working(&app_handle, "speak", "Capturing selection …".to_string());

            let capture = capture_selected_text(Some(CaptureOptions {
                copy_delay_ms: Some(140),
                restore_clipboard: Some(true),
            }));

            let capture = match capture {
                Ok(capture) => {
                    log_phase(
                        "speak",
                        "capture_end",
                        capture_started,
                        &format!("chars={} restored_clipboard={}", capture.text.chars().count(), capture.restored_clipboard),
                    );
                    capture
                }
                Err(error) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.message = format!("Capture failed: {error}");
                        snapshot.last_action = Some("speak".to_string());
                    });
                    finish_run(&app_handle);
                    return;
                }
            };

            if capture.text.trim().is_empty() {
                let state = app_handle.state::<HotkeyState>();
                state.update(&app_handle, |snapshot| {
                    snapshot.state = "error";
                    snapshot.message = capture
                        .note
                        .clone()
                        .unwrap_or_else(|| "No marked text could be captured.".to_string());
                    snapshot.last_action = Some("speak".to_string());
                });
                finish_run(&app_handle);
                return;
            }

            let settings = app_handle.state::<SettingsState>().get();
            let progress_app = app_handle.clone();
            let progress = Arc::new(move |progress: TtsProgress| match progress {
                TtsProgress::PipelineStarted { chunk_count, format, autoplay, max_parallel_requests } => {
                    println!(
                        "[tts-progress] stage=pipeline_start planned_chunks={} format={} autoplay={} max_parallel_requests={}",
                        chunk_count, format, autoplay, max_parallel_requests
                    );
                    update_working(
                        &progress_app,
                        "speak",
                        format!("TTS pipeline started. Planned {chunk_count} chunk(s) as {}.", format.to_uppercase()),
                    );
                }
                TtsProgress::ChunkRequestStarted { index, total, text_chars } => {
                    println!("[tts-progress] stage=request_start chunk={}/{} text_chars={}", index + 1, total, text_chars);
                    update_working(&progress_app, "speak", format!("Preparing chunk {}/{} … ({} chars)", index + 1, total, text_chars));
                }
                TtsProgress::ChunkRequestFinished { index, total, bytes_received, elapsed_ms } => {
                    println!("[tts-progress] stage=request_finished chunk={}/{} bytes={} elapsed_ms={}", index + 1, total, bytes_received, elapsed_ms);
                    update_working(&progress_app, "speak", format!("Chunk {}/{} ready from OpenAI after {} ms.", index + 1, total, elapsed_ms));
                }
                TtsProgress::ChunkFileWritten { index, total, file_path, bytes_written, elapsed_ms } => {
                    println!("[tts-progress] stage=file_written chunk={}/{} bytes_written={} elapsed_ms={} path={}", index + 1, total, bytes_written, elapsed_ms, file_path);
                    update_working(&progress_app, "speak", format!("Chunk {}/{} written. Waiting for ordered playback …", index + 1, total));
                }
                TtsProgress::ChunkPlaybackStarted { index, total, file_path } => {
                    println!("[tts-progress] stage=playback_start chunk={}/{} path={}", index + 1, total, file_path);
                    update_working(&progress_app, "speak", format!("Playing chunk {}/{} …", index + 1, total));
                }
                TtsProgress::ChunkPlaybackFinished { index, total, elapsed_ms } => {
                    println!("[tts-progress] stage=playback_end chunk={}/{} elapsed_ms={}", index + 1, total, elapsed_ms);
                    update_working(&progress_app, "speak", format!("Finished chunk {}/{} playback ({} ms).", index + 1, total, elapsed_ms));
                }
            });

            let tts_started = Instant::now();
            println!("[hotkey] action=speak phase=tts_pipeline_start elapsed_ms={} format={}", overall_started.elapsed().as_millis(), settings.tts_format);
            let result = speak_text_with_progress(
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
            );

            let state = app_handle.state::<HotkeyState>();
            match result {
                Ok(result) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "success";
                    snapshot.message = format!(
                        "Speak run finished in {} ms. Captured {} chars, generated {} chunk(s), and played them in order as {}.",
                        overall_started.elapsed().as_millis(),
                        capture.text.chars().count(),
                        result.chunk_count,
                        result.format.to_uppercase()
                    );
                    snapshot.last_action = Some("speak".to_string());
                    snapshot.last_captured_text = Some(capture.text);
                    snapshot.last_audio_path = Some(result.file_path);
                    snapshot.last_audio_output_directory = Some(result.output_directory);
                    snapshot.last_audio_chunk_count = Some(result.chunk_count);
                }),
                Err(error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "error";
                    snapshot.message = format!("Speak run failed after {} ms: {error}", tts_started.elapsed().as_millis());
                    snapshot.last_action = Some("speak".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                }),
            }

            println!("[hotkey] action=speak phase=complete total_ms={}", overall_started.elapsed().as_millis());
            finish_run(&app_handle);
        });
    }

    fn trigger_capture_and_translate(app: &AppHandle) {
        let target_language = app.state::<SettingsState>().get().translation_target_language;
        if !begin_run(
            app,
            "translate",
            format!("Translate hotkey received. Capturing selection for {target_language} …"),
        ) {
            return;
        }

        let app_handle = app.clone();
        thread::spawn(move || {
            let overall_started = Instant::now();
            let capture_started = Instant::now();
            update_working(&app_handle, "translate", "Capturing selection …".to_string());

            let capture = capture_selected_text(Some(CaptureOptions {
                copy_delay_ms: Some(140),
                restore_clipboard: Some(true),
            }));

            let capture = match capture {
                Ok(capture) => {
                    log_phase(
                        "translate",
                        "capture_end",
                        capture_started,
                        &format!("chars={} restored_clipboard={}", capture.text.chars().count(), capture.restored_clipboard),
                    );
                    capture
                }
                Err(error) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.message = format!("Capture failed: {error}");
                        snapshot.last_action = Some("translate".to_string());
                    });
                    finish_run(&app_handle);
                    return;
                }
            };

            if capture.text.trim().is_empty() {
                let state = app_handle.state::<HotkeyState>();
                state.update(&app_handle, |snapshot| {
                    snapshot.state = "error";
                    snapshot.message = capture
                        .note
                        .clone()
                        .unwrap_or_else(|| "No marked text could be captured.".to_string());
                    snapshot.last_action = Some("translate".to_string());
                });
                finish_run(&app_handle);
                return;
            }

            let settings = app_handle.state::<SettingsState>().get();
            let translation_started = Instant::now();
            update_working(
                &app_handle,
                "translate",
                format!("Translating selection to {} …", settings.translation_target_language),
            );
            println!(
                "[hotkey] action=translate phase=translation_start elapsed_ms={} target_language={}",
                overall_started.elapsed().as_millis(),
                settings.translation_target_language
            );

            let translation = translate_text(TranslateTextOptions {
                text: Some(capture.text.clone()),
                target_language: Some(settings.translation_target_language.clone()),
                source_language: None,
                model: None,
            });

            let translation = match translation {
                Ok(translation) => {
                    println!(
                        "[hotkey] action=translate phase=translation_end elapsed_ms={} translated_chars={} target_language={}",
                        translation_started.elapsed().as_millis(),
                        translation.text.chars().count(),
                        translation.target_language
                    );
                    translation
                }
                Err(error) => {
                    let state = app_handle.state::<HotkeyState>();
                    state.update(&app_handle, |snapshot| {
                        snapshot.state = "error";
                        snapshot.message = format!("Translation failed after {} ms: {error}", translation_started.elapsed().as_millis());
                        snapshot.last_action = Some("translate".to_string());
                        snapshot.last_captured_text = Some(capture.text.clone());
                    });
                    finish_run(&app_handle);
                    return;
                }
            };

            let progress_app = app_handle.clone();
            let progress = Arc::new(move |progress: TtsProgress| match progress {
                TtsProgress::PipelineStarted { chunk_count, format, autoplay, max_parallel_requests } => {
                    println!(
                        "[tts-progress] stage=pipeline_start planned_chunks={} format={} autoplay={} max_parallel_requests={}",
                        chunk_count, format, autoplay, max_parallel_requests
                    );
                    update_working(
                        &progress_app,
                        "translate",
                        format!("TTS pipeline started for translation. Planned {chunk_count} chunk(s) as {}.", format.to_uppercase()),
                    );
                }
                TtsProgress::ChunkRequestStarted { index, total, text_chars } => {
                    println!("[tts-progress] stage=request_start chunk={}/{} text_chars={}", index + 1, total, text_chars);
                    update_working(&progress_app, "translate", format!("Preparing translated chunk {}/{} … ({} chars)", index + 1, total, text_chars));
                }
                TtsProgress::ChunkRequestFinished { index, total, bytes_received, elapsed_ms } => {
                    println!("[tts-progress] stage=request_finished chunk={}/{} bytes={} elapsed_ms={}", index + 1, total, bytes_received, elapsed_ms);
                    update_working(&progress_app, "translate", format!("Translated chunk {}/{} ready after {} ms.", index + 1, total, elapsed_ms));
                }
                TtsProgress::ChunkFileWritten { index, total, file_path, bytes_written, elapsed_ms } => {
                    println!("[tts-progress] stage=file_written chunk={}/{} bytes_written={} elapsed_ms={} path={}", index + 1, total, bytes_written, elapsed_ms, file_path);
                    update_working(&progress_app, "translate", format!("Translated chunk {}/{} written. Waiting for ordered playback …", index + 1, total));
                }
                TtsProgress::ChunkPlaybackStarted { index, total, file_path } => {
                    println!("[tts-progress] stage=playback_start chunk={}/{} path={}", index + 1, total, file_path);
                    update_working(&progress_app, "translate", format!("Playing translated chunk {}/{} …", index + 1, total));
                }
                TtsProgress::ChunkPlaybackFinished { index, total, elapsed_ms } => {
                    println!("[tts-progress] stage=playback_end chunk={}/{} elapsed_ms={}", index + 1, total, elapsed_ms);
                    update_working(&progress_app, "translate", format!("Finished translated chunk {}/{} playback ({} ms).", index + 1, total, elapsed_ms));
                }
            });

            let tts_started = Instant::now();
            println!("[hotkey] action=translate phase=tts_pipeline_start elapsed_ms={} format={}", overall_started.elapsed().as_millis(), settings.tts_format);
            let speech = speak_text_with_progress(
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
            );

            let state = app_handle.state::<HotkeyState>();
            match speech {
                Ok(speech) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "success";
                    snapshot.message = format!(
                        "Translate run finished in {} ms. Translation took {} ms, TTS produced {} chunk(s), and playback completed in order.",
                        overall_started.elapsed().as_millis(),
                        translation_started.elapsed().as_millis(),
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
                Err(error) => state.update(&app_handle, |snapshot| {
                    snapshot.state = "error";
                    snapshot.message = format!("Translated TTS failed after {} ms: {error}", tts_started.elapsed().as_millis());
                    snapshot.last_action = Some("translate".to_string());
                    snapshot.last_captured_text = Some(capture.text.clone());
                    snapshot.last_translation_target_language = Some(translation.target_language.clone());
                    snapshot.last_translation_text = Some(translation.text.clone());
                }),
            }

            println!("[hotkey] action=translate phase=complete total_ms={}", overall_started.elapsed().as_millis());
            finish_run(&app_handle);
        });
    }
}
