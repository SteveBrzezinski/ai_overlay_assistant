use crate::audio_output::AudioOutputActivityGuard;
use rodio::{
    buffer::SamplesBuffer,
    OutputStream, Sink, Source,
};
use std::{
    f32::consts::PI,
    sync::{
        mpsc::{self, Receiver, Sender},
        Mutex,
    },
    thread,
};
use tauri::{AppHandle, State};

const SAMPLE_RATE: u32 = 44_100;
const CHANNELS: u16 = 2;

pub struct TimerSignalPlayerState {
    command_tx: Mutex<Option<Sender<PlayerCommand>>>,
}

impl Default for TimerSignalPlayerState {
    fn default() -> Self {
        Self {
            command_tx: Mutex::new(None),
        }
    }
}

enum PlayerCommand {
    StartLoop(String),
    Stop,
}

impl TimerSignalPlayerState {
    pub fn start_loop(&self, app: &AppHandle, tone: &str) -> Result<(), String> {
        self.sender(app)?.send(PlayerCommand::StartLoop(tone.to_string())).map_err(|error| {
            format!("Failed to send timer signal start command: {error}")
        })
    }

    pub fn stop(&self, app: &AppHandle) -> Result<(), String> {
        self.sender(app)?.send(PlayerCommand::Stop).map_err(|error| {
            format!("Failed to send timer signal stop command: {error}")
        })
    }

    fn sender(&self, app: &AppHandle) -> Result<Sender<PlayerCommand>, String> {
        let mut guard = self.command_tx.lock().expect("timer signal state poisoned");
        if let Some(sender) = guard.as_ref() {
            return Ok(sender.clone());
        }

        let (command_tx, command_rx) = mpsc::channel::<PlayerCommand>();
        let app_handle = app.clone();
        thread::spawn(move || run_player_thread(command_rx, app_handle));
        *guard = Some(command_tx.clone());
        Ok(command_tx)
    }
}

#[tauri::command]
pub fn start_timer_signal_alert_command(
    tone: String,
    state: State<'_, TimerSignalPlayerState>,
    app: AppHandle,
) -> Result<(), String> {
    state.inner().start_loop(&app, &tone)
}

#[tauri::command]
pub fn stop_timer_signal_alert_command(
    state: State<'_, TimerSignalPlayerState>,
    app: AppHandle,
) -> Result<(), String> {
    state.inner().stop(&app)
}

fn run_player_thread(command_rx: Receiver<PlayerCommand>, app: AppHandle) {
    let mut playback: Option<TimerSignalPlayback> = None;

    while let Ok(command) = command_rx.recv() {
        match command {
            PlayerCommand::StartLoop(tone) => {
                if let Some(existing) = playback.take() {
                    existing.sink.stop();
                }
                playback = start_loop_playback(&app, &tone).ok();
            }
            PlayerCommand::Stop => {
                if let Some(existing) = playback.take() {
                    existing.sink.stop();
                }
            }
        }
    }
}

struct TimerSignalPlayback {
    _stream: OutputStream,
    sink: Sink,
    _activity_guard: AudioOutputActivityGuard,
}

fn start_loop_playback(app: &AppHandle, tone: &str) -> Result<TimerSignalPlayback, String> {
    let (stream, handle) =
        OutputStream::try_default().map_err(|error| format!("Failed to open audio output: {error}"))?;
    let sink =
        Sink::try_new(&handle).map_err(|error| format!("Failed to create timer signal sink: {error}"))?;
    let activity_guard = AudioOutputActivityGuard::activate(app, "timer-signal");
    let samples = build_timer_signal_samples(tone);
    sink.set_volume(0.72);
    sink.append(
        SamplesBuffer::new(CHANNELS, SAMPLE_RATE, samples)
            .repeat_infinite()
            .amplify(1.0),
    );
    sink.play();

    Ok(TimerSignalPlayback {
        _stream: stream,
        sink,
        _activity_guard: activity_guard,
    })
}

fn build_timer_signal_samples(tone: &str) -> Vec<f32> {
    let duration_seconds = 1.8f32;
    let total_frames = (SAMPLE_RATE as f32 * duration_seconds) as usize;
    let mut mono = vec![0.0f32; total_frames];

    match tone.trim().to_lowercase().as_str() {
        "digital-pulse" => {
            add_note(&mut mono, 0.00, 0.12, 660.0, 0.30, Waveform::Square);
            add_note(&mut mono, 0.18, 0.12, 880.0, 0.26, Waveform::Square);
            add_note(&mut mono, 0.40, 0.18, 990.0, 0.22, Waveform::Triangle);
            add_note(&mut mono, 1.05, 0.12, 660.0, 0.28, Waveform::Square);
            add_note(&mut mono, 1.22, 0.12, 880.0, 0.24, Waveform::Square);
        }
        "glass-rise" => {
            add_note(&mut mono, 0.00, 0.24, 523.25, 0.20, Waveform::Triangle);
            add_note(&mut mono, 0.20, 0.24, 659.25, 0.18, Waveform::Triangle);
            add_note(&mut mono, 0.42, 0.34, 783.99, 0.16, Waveform::Sine);
            add_note(&mut mono, 1.05, 0.22, 659.25, 0.16, Waveform::Triangle);
            add_note(&mut mono, 1.24, 0.32, 987.77, 0.14, Waveform::Sine);
        }
        _ => {
            add_note(&mut mono, 0.00, 0.30, 523.25, 0.18, Waveform::Sine);
            add_note(&mut mono, 0.26, 0.46, 783.99, 0.13, Waveform::Sine);
            add_note(&mut mono, 1.02, 0.22, 659.25, 0.16, Waveform::Sine);
            add_note(&mut mono, 1.22, 0.34, 783.99, 0.12, Waveform::Sine);
        }
    }

    mono_to_stereo(mono)
}

#[derive(Clone, Copy)]
enum Waveform {
    Sine,
    Square,
    Triangle,
}

fn add_note(
    samples: &mut [f32],
    start_seconds: f32,
    duration_seconds: f32,
    frequency_hz: f32,
    amplitude: f32,
    waveform: Waveform,
) {
    let start_index = (start_seconds * SAMPLE_RATE as f32).floor() as usize;
    let note_frames = (duration_seconds * SAMPLE_RATE as f32).ceil() as usize;
    if start_index >= samples.len() || note_frames == 0 {
        return;
    }

    let end_index = start_index.saturating_add(note_frames).min(samples.len());
    let total_frames = end_index.saturating_sub(start_index).max(1);
    let attack_frames = ((total_frames as f32) * 0.08).round().max(1.0) as usize;
    let release_frames = ((total_frames as f32) * 0.22).round().max(1.0) as usize;

    for frame_offset in 0..total_frames {
        let sample_index = start_index + frame_offset;
        let progress = frame_offset as f32 / SAMPLE_RATE as f32;
        let phase = 2.0 * PI * frequency_hz * progress;
        let waveform_value = match waveform {
            Waveform::Sine => phase.sin(),
            Waveform::Square => {
                if phase.sin() >= 0.0 { 1.0 } else { -1.0 }
            }
            Waveform::Triangle => (2.0 / PI) * phase.sin().asin(),
        };

        let envelope = if frame_offset < attack_frames {
            frame_offset as f32 / attack_frames as f32
        } else if frame_offset + release_frames >= total_frames {
            let remaining = total_frames.saturating_sub(frame_offset);
            remaining as f32 / release_frames as f32
        } else {
            1.0
        };

        samples[sample_index] =
            (samples[sample_index] + waveform_value * amplitude * envelope).clamp(-0.95, 0.95);
    }
}

fn mono_to_stereo(mono: Vec<f32>) -> Vec<f32> {
    let mut stereo = Vec::with_capacity(mono.len() * 2);
    for sample in mono {
        stereo.push(sample);
        stereo.push(sample);
    }
    stereo
}
