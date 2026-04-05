use crate::{
    run_controller::{is_cancelled_error, RunAccess},
    settings::{resolve_openai_api_key, AppSettings},
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rodio::{buffer::SamplesBuffer, Decoder, OutputStream, Sink, Source};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::{BufReader, Read},
    net::TcpStream,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{
    client::IntoClientRequest, http::HeaderValue, stream::MaybeTlsStream, Message as WsMessage,
    WebSocket,
};

const DEFAULT_MODEL: &str = "gpt-4o-mini-tts";
const DEFAULT_REALTIME_MODEL: &str = "gpt-realtime-1.5";
const DEFAULT_VOICE: &str = "alloy";
const DEFAULT_FORMAT: &str = "wav";
const DEFAULT_TTS_MODE: &str = "live";
const DEFAULT_MAX_CHUNK_CHARS: usize = 280;
const DEFAULT_MAX_PARALLEL_REQUESTS: usize = 3;
const MAX_PARALLEL_REQUESTS_LIMIT: usize = 4;
const MIN_CHUNK_CHARS: usize = 120;
const MAX_CHUNK_CHARS: usize = 1_200;
const LIVE_TRANSPORT_FORMAT: &str = "pcm";
const LIVE_SAMPLE_RATE: u32 = 24_000;
const LIVE_CHANNELS: u16 = 1;
const LIVE_BITS_PER_SAMPLE: u16 = 16;
const LIVE_INITIAL_BUFFER_MS: u32 = 140;
const LIVE_STREAM_BUFFER_MS: u32 = 180;
const LIVE_NATURALIZED_INITIAL_BUFFER_MS: u32 = 420;
const LIVE_NATURALIZED_STREAM_BUFFER_MS: u32 = 240;
const LIVE_NATURALIZED_SPEEDUP_BUFFER_MS: u32 = 220;
const LIVE_NATURALIZED_SLOWDOWN_BUFFER_MS: u32 = 80;
const LIVE_NATURALIZED_OUTPUT_CROSSFADE_SAMPLES: usize = 1_024;
const LIVE_CONNECT_TIMEOUT_MS: u64 = 4_000;
const LIVE_REQUEST_TIMEOUT_MS: u64 = 60_000;
const LIVE_READ_BUFFER_BYTES: usize = 8_192;
const REALTIME_TRANSPORT_FORMAT: &str = "pcm16";
const REALTIME_SAMPLE_RATE: u32 = 24_000;
const REALTIME_CHANNELS: u16 = 1;
const REALTIME_BITS_PER_SAMPLE: u16 = 16;
const REALTIME_EVENT_POLL_TIMEOUT_MS: u64 = 250;
const REALTIME_STARTUP_TIMEOUT_MS: u64 = 8_000;
const REALTIME_RESPONSE_TIMEOUT_MS: u64 = 60_000;
const TIME_STRETCH_FRAME_SIZE: usize = 2_048;
const TIME_STRETCH_OVERLAP: usize = 512;
const TIME_STRETCH_SEARCH: usize = 384;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakTextOptions {
    pub text: Option<String>,
    pub voice: Option<String>,
    pub model: Option<String>,
    pub format: Option<String>,
    pub mode: Option<String>,
    pub autoplay: Option<bool>,
    pub max_chunk_chars: Option<usize>,
    pub max_parallel_requests: Option<usize>,
    pub first_chunk_leading_silence_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakTextResult {
    pub file_path: String,
    pub output_directory: String,
    pub bytes_written: usize,
    pub chunk_count: usize,
    pub voice: String,
    pub model: String,
    pub mode: String,
    pub requested_mode: String,
    pub session_id: String,
    pub session_strategy: String,
    pub fallback_reason: Option<String>,
    pub supports_persistent_session: bool,
    pub format: String,
    pub transport_format: String,
    pub autoplay: bool,
    pub first_audio_received_at_ms: Option<u64>,
    pub first_audio_playback_started_at_ms: Option<u64>,
    pub start_latency_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum TtsProgress {
    PipelineStarted {
        mode: String,
        chunk_count: usize,
        format: String,
        transport_format: String,
        autoplay: bool,
        max_parallel_requests: usize,
        started_at_ms: u64,
    },
    RealtimeConnecting {
        mode: String,
        model: String,
        voice: String,
        session_id: String,
    },
    RealtimeConnected {
        mode: String,
        model: String,
        voice: String,
        session_id: String,
    },
    RealtimeSessionUpdateSucceeded {
        mode: String,
        session_id: String,
    },
    RealtimeResponseCreateSucceeded {
        mode: String,
        session_id: String,
    },
    RealtimeNoAudioReceived {
        mode: String,
        session_id: String,
        detail: String,
    },
    FallbackToLive {
        reason: String,
    },
    FirstAudioReceived {
        mode: String,
        at_ms: u64,
        latency_ms: u64,
        bytes_received: usize,
    },
    FirstAudioPlaybackStarted {
        mode: String,
        at_ms: u64,
        latency_ms: u64,
    },
    ChunkRequestStarted {
        index: usize,
        total: usize,
        text_chars: usize,
    },
    ChunkRequestFinished {
        index: usize,
        total: usize,
        bytes_received: usize,
        elapsed_ms: u128,
    },
    ChunkFileWritten {
        index: usize,
        total: usize,
        file_path: String,
        bytes_written: usize,
        elapsed_ms: u128,
    },
    ChunkPlaybackStarted {
        index: usize,
        total: usize,
        file_path: String,
    },
    ChunkPlaybackFinished {
        index: usize,
        total: usize,
        elapsed_ms: u128,
    },
}

pub type ProgressCallback = Arc<dyn Fn(TtsProgress) + Send + Sync>;

#[derive(Serialize)]
struct OpenAiSpeechRequest<'a> {
    model: &'a str,
    voice: &'a str,
    input: &'a str,
    response_format: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TtsMode {
    Classic,
    Live,
    RealtimeExperimental,
}

impl TtsMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::Live => "live",
            Self::RealtimeExperimental => "realtime",
        }
    }
}

#[derive(Debug, Clone)]
struct SpeechSessionPlan {
    session_id: String,
    requested_mode: TtsMode,
    resolved_mode: TtsMode,
    session_strategy: String,
    supports_persistent_session: bool,
    fallback_reason: Option<String>,
}

impl SpeechSessionPlan {
    fn mode_label(&self) -> &str {
        self.resolved_mode.as_str()
    }

    #[cfg(test)]
    fn fallback_to_live(&self, reason: impl Into<String>) -> Self {
        Self {
            session_id: self.session_id.clone(),
            requested_mode: self.requested_mode,
            resolved_mode: TtsMode::Live,
            session_strategy: "realtime_websocket_live_fallback_session".to_string(),
            supports_persistent_session: true,
            fallback_reason: Some(reason.into()),
        }
    }
}

#[derive(Debug)]
struct RealtimePipelineError {
    message: String,
    can_fallback_to_live: bool,
}

impl RealtimePipelineError {
    fn fallback(message: impl Into<String>) -> Self {
        Self { message: message.into(), can_fallback_to_live: true }
    }

    fn terminal(message: impl Into<String>) -> Self {
        Self { message: message.into(), can_fallback_to_live: false }
    }
}

enum RealtimeSocketRead {
    Event(Value),
    Timeout,
    Closed(Option<String>),
    Ignored,
}

type RealtimeSocket = WebSocket<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LivePlaybackPath {
    FastDirect,
    NaturalizedSpeed,
}

impl LivePlaybackPath {
    fn from_playback_speed(playback_speed: f32) -> Self {
        if (playback_speed - 1.0).abs() < 0.01 {
            Self::FastDirect
        } else {
            Self::NaturalizedSpeed
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::FastDirect => "fast_direct",
            Self::NaturalizedSpeed => "naturalized_speed",
        }
    }

    fn initial_buffer_ms(self, playback_speed: f32) -> u32 {
        match self {
            Self::FastDirect => LIVE_INITIAL_BUFFER_MS,
            Self::NaturalizedSpeed => {
                naturalized_live_buffer_ms(LIVE_NATURALIZED_INITIAL_BUFFER_MS, playback_speed)
            }
        }
    }

    fn stream_buffer_ms(self, playback_speed: f32) -> u32 {
        match self {
            Self::FastDirect => LIVE_STREAM_BUFFER_MS,
            Self::NaturalizedSpeed => {
                naturalized_live_buffer_ms(LIVE_NATURALIZED_STREAM_BUFFER_MS, playback_speed)
            }
        }
    }
}

#[derive(Clone)]
struct ResolvedSpeakOptions {
    voice: String,
    model: String,
    mode: TtsMode,
    format: String,
    transport_format: String,
    autoplay: bool,
    max_chunk_chars: usize,
    max_parallel_requests: usize,
    first_chunk_leading_silence_ms: u32,
    playback_speed: f32,
}

#[derive(Debug, Clone)]
struct ChunkJob {
    index: usize,
    text: String,
    file_path: PathBuf,
}

#[derive(Debug, Clone)]
struct GeneratedChunk {
    index: usize,
    file_path: String,
    bytes_written: usize,
    first_audio_received_at_ms: Option<u64>,
    first_audio_latency_ms: Option<u64>,
}

enum PipelineMessage {
    ChunkReady(GeneratedChunk),
    Failed(String),
}

struct OrderedPlaybackResult {
    chunks: Vec<GeneratedChunk>,
    first_audio_playback_started_at_ms: Option<u64>,
    start_latency_ms: Option<u64>,
}

trait SpeechProvider: Send + Sync + Clone + 'static {
    fn synthesize_chunk(
        &self,
        options: &ResolvedSpeakOptions,
        chunk: &ChunkJob,
        total_chunks: usize,
        pipeline_started: Instant,
        progress: Option<&ProgressCallback>,
        run_access: Option<&RunAccess>,
    ) -> Result<GeneratedChunk, String>;
}

#[derive(Clone)]
struct OpenAiSpeechProvider {
    api_key: String,
    client: reqwest::blocking::Client,
}

impl OpenAiSpeechProvider {
    fn new(api_key: String) -> Self {
        Self { api_key, client: reqwest::blocking::Client::new() }
    }
}

impl SpeechProvider for OpenAiSpeechProvider {
    fn synthesize_chunk(
        &self,
        options: &ResolvedSpeakOptions,
        chunk: &ChunkJob,
        total_chunks: usize,
        pipeline_started: Instant,
        progress: Option<&ProgressCallback>,
        run_access: Option<&RunAccess>,
    ) -> Result<GeneratedChunk, String> {
        if let Some(run_access) = run_access {
            run_access.check_cancelled()?;
            run_access.update_chunk_phase("tts_requesting_audio", chunk.index + 1, total_chunks);
        }

        if let Some(progress) = progress {
            progress(TtsProgress::ChunkRequestStarted {
                index: chunk.index,
                total: total_chunks,
                text_chars: chunk.text.chars().count(),
            });
        }

        let request_started = Instant::now();
        let response = self
            .client
            .post("https://api.openai.com/v1/audio/speech")
            .bearer_auth(&self.api_key)
            .header("Content-Type", "application/json")
            .json(&OpenAiSpeechRequest {
                model: &options.model,
                voice: &options.voice,
                input: &chunk.text,
                response_format: &options.format,
            })
            .send()
            .map_err(|err| format!("OpenAI request failed: {err}"))?;

        if let Some(run_access) = run_access {
            run_access.check_cancelled()?;
        }

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(format!("OpenAI TTS failed ({status}): {body}"));
        }

        let bytes =
            response.bytes().map_err(|err| format!("Failed to read audio response: {err}"))?;

        let response_elapsed_ms = request_started.elapsed().as_millis();
        if let Some(progress) = progress {
            progress(TtsProgress::ChunkRequestFinished {
                index: chunk.index,
                total: total_chunks,
                bytes_received: bytes.len(),
                elapsed_ms: response_elapsed_ms,
            });

            if chunk.index == 0 {
                progress(TtsProgress::FirstAudioReceived {
                    mode: options.mode.as_str().to_string(),
                    at_ms: system_time_ms(),
                    latency_ms: millis_u64(pipeline_started.elapsed()),
                    bytes_received: bytes.len(),
                });
            }
        }

        if let Some(run_access) = run_access {
            run_access.check_cancelled()?;
            run_access.update_chunk_phase("tts_writing_chunk", chunk.index + 1, total_chunks);
        }

        let bytes = normalize_audio_bytes(bytes.to_vec(), options)?;
        let bytes = maybe_prepend_leading_silence(bytes, options, chunk.index)?;
        fs::write(&chunk.file_path, &bytes)
            .map_err(|err| format!("Failed to write audio file: {err}"))?;

        if let Some(progress) = progress {
            progress(TtsProgress::ChunkFileWritten {
                index: chunk.index,
                total: total_chunks,
                file_path: chunk.file_path.to_string_lossy().to_string(),
                bytes_written: bytes.len(),
                elapsed_ms: request_started.elapsed().as_millis(),
            });
        }

        if let Some(run_access) = run_access {
            run_access.check_cancelled()?;
        }

        Ok(GeneratedChunk {
            index: chunk.index,
            file_path: chunk.file_path.to_string_lossy().to_string(),
            bytes_written: bytes.len(),
            first_audio_received_at_ms: (chunk.index == 0).then(system_time_ms),
            first_audio_latency_ms: (chunk.index == 0)
                .then(|| millis_u64(pipeline_started.elapsed())),
        })
    }
}

struct LiveSpeechPipeline {
    api_key: String,
}

struct RealtimeSpeechPipeline {
    api_key: String,
}

struct NaturalizedLivePlaybackState {
    output_overlap_samples: usize,
    pending_output_tail: Vec<f32>,
}

impl NaturalizedLivePlaybackState {
    fn new(output_overlap_samples: usize) -> Self {
        Self { output_overlap_samples, pending_output_tail: Vec::new() }
    }

    fn merge_transformed_batch(
        &mut self,
        transformed_samples: Vec<f32>,
        flush_all: bool,
    ) -> Vec<f32> {
        let mut merged = if self.pending_output_tail.is_empty() {
            transformed_samples
        } else {
            crossfade_live_output_chunks(&self.pending_output_tail, &transformed_samples)
        };

        self.pending_output_tail.clear();

        if flush_all {
            return merged;
        }

        if merged.len() <= self.output_overlap_samples {
            self.pending_output_tail = merged;
            return Vec::new();
        }

        let tail_start = merged.len() - self.output_overlap_samples;
        self.pending_output_tail = merged.split_off(tail_start);
        merged
    }

    fn take_pending_output_tail(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.pending_output_tail)
    }
}

fn build_live_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_millis(LIVE_CONNECT_TIMEOUT_MS))
        .timeout(Duration::from_millis(LIVE_REQUEST_TIMEOUT_MS))
        .build()
        .map_err(|err| format!("Failed to build streaming HTTP client: {err}"))
}

impl LiveSpeechPipeline {
    fn new(api_key: String) -> Result<Self, String> {
        Ok(Self { api_key })
    }
}

impl RealtimeSpeechPipeline {
    fn new(api_key: String) -> Self {
        Self { api_key }
    }
}

struct ChunkedSpeechPipeline<P> {
    provider: P,
    chunker: TextChunker,
}

impl<P> ChunkedSpeechPipeline<P>
where
    P: SpeechProvider,
{
    fn new(provider: P, chunker: TextChunker) -> Self {
        Self { provider, chunker }
    }

    fn run(
        &self,
        text: &str,
        options: ResolvedSpeakOptions,
        session_plan: &SpeechSessionPlan,
        progress: Option<ProgressCallback>,
        run_access: Option<RunAccess>,
    ) -> Result<SpeakTextResult, String> {
        let started = Instant::now();
        let started_at_ms = system_time_ms();
        if let Some(run_access) = &run_access {
            run_access.check_cancelled()?;
            run_access.update_phase("tts_chunking");
        }
        let chunks = self.chunker.split(text);
        if chunks.is_empty() {
            return Err("No text provided for speech synthesis".into());
        }

        if let Some(progress_cb) = &progress {
            progress_cb(TtsProgress::PipelineStarted {
                mode: options.mode.as_str().to_string(),
                chunk_count: chunks.len(),
                format: options.format.clone(),
                transport_format: options.transport_format.clone(),
                autoplay: options.autoplay,
                max_parallel_requests: options.max_parallel_requests,
                started_at_ms,
            });
        }

        println!(
            "[tts] pipeline_start mode={} format={} transport_format={} autoplay={} planned_chunks={} max_parallel_requests={} text_chars={}",
            options.mode.as_str(),
            options.format,
            options.transport_format,
            options.autoplay,
            chunks.len(),
            options.max_parallel_requests,
            text.chars().count()
        );

        let output_directory = build_output_directory()?;
        let jobs: Vec<ChunkJob> = chunks
            .into_iter()
            .enumerate()
            .map(|(index, chunk_text)| ChunkJob {
                index,
                text: chunk_text,
                file_path: build_chunk_path(&output_directory, index, &options.format),
            })
            .collect();

        let worker_count = options.max_parallel_requests.min(jobs.len()).max(1);
        let expected_chunks = jobs.len();
        let (sender, receiver) = mpsc::channel::<PipelineMessage>();
        let next_index = Arc::new(AtomicUsize::new(0));
        let shared_jobs = Arc::new(jobs);
        let mut worker_handles = Vec::with_capacity(worker_count);

        for _ in 0..worker_count {
            let provider = self.provider.clone();
            let options = options.clone();
            let sender = sender.clone();
            let next_index = Arc::clone(&next_index);
            let jobs = Arc::clone(&shared_jobs);
            let progress = progress.clone();
            let run_access = run_access.clone();

            worker_handles.push(thread::spawn(move || loop {
                if let Some(run_access) = &run_access {
                    if run_access.check_cancelled().is_err() {
                        break;
                    }
                }

                let job_index = next_index.fetch_add(1, Ordering::SeqCst);
                if job_index >= jobs.len() {
                    break;
                }

                let job = jobs[job_index].clone();
                let message = match provider.synthesize_chunk(
                    &options,
                    &job,
                    jobs.len(),
                    started,
                    progress.as_ref(),
                    run_access.as_ref(),
                ) {
                    Ok(chunk) => {
                        if let Some(run_access) = &run_access {
                            if run_access.check_cancelled().is_err() {
                                break;
                            }
                        }

                        PipelineMessage::ChunkReady(chunk)
                    }
                    Err(error) => {
                        if is_cancelled_error(&error) {
                            break;
                        }

                        PipelineMessage::Failed(format!(
                            "Chunk {} of {} failed: {error}",
                            job.index + 1,
                            jobs.len()
                        ))
                    }
                };

                if let PipelineMessage::Failed(error) = &message {
                    if is_cancelled_error(error) {
                        break;
                    }
                }

                if sender.send(message).is_err() {
                    break;
                }
            }));
        }
        drop(sender);

        if let Some(run_access) = &run_access {
            run_access.update_phase("tts_waiting_for_audio");
        }

        let playback_result = self.collect_and_play_ordered_chunks(
            receiver,
            expected_chunks,
            options.mode,
            options.autoplay,
            options.first_chunk_leading_silence_ms,
            options.playback_speed,
            started,
            progress.clone(),
            run_access.clone(),
        );
        let playback_result = match playback_result {
            Ok(playback_result) => playback_result,
            Err(error) if is_cancelled_error(&error) => {
                println!(
                    "[tts] pipeline_cancelled mode={} planned_chunks={} total_ms={}",
                    options.mode.as_str(),
                    expected_chunks,
                    started.elapsed().as_millis()
                );
                return Err(error);
            }
            Err(error) => {
                let _ = join_worker_handles(worker_handles);
                return Err(error);
            }
        };
        let join_result = join_worker_handles(worker_handles);
        join_result?;
        let first_chunk = playback_result
            .chunks
            .first()
            .ok_or_else(|| "No audio chunks were produced.".to_string())?;

        println!(
            "[tts] pipeline_done mode={} planned_chunks={} produced_chunks={} bytes_written={} total_ms={}",
            options.mode.as_str(),
            expected_chunks,
            playback_result.chunks.len(),
            playback_result
                .chunks
                .iter()
                .map(|chunk| chunk.bytes_written)
                .sum::<usize>(),
            started.elapsed().as_millis()
        );

        Ok(SpeakTextResult {
            file_path: first_chunk.file_path.clone(),
            output_directory: output_directory.to_string_lossy().to_string(),
            bytes_written: playback_result.chunks.iter().map(|chunk| chunk.bytes_written).sum(),
            chunk_count: playback_result.chunks.len(),
            voice: options.voice,
            model: options.model,
            mode: session_plan.mode_label().to_string(),
            requested_mode: session_plan.requested_mode.as_str().to_string(),
            session_id: session_plan.session_id.clone(),
            session_strategy: session_plan.session_strategy.clone(),
            fallback_reason: session_plan.fallback_reason.clone(),
            supports_persistent_session: session_plan.supports_persistent_session,
            format: options.format,
            transport_format: options.transport_format,
            autoplay: options.autoplay,
            first_audio_received_at_ms: first_chunk.first_audio_received_at_ms,
            first_audio_playback_started_at_ms: playback_result.first_audio_playback_started_at_ms,
            start_latency_ms: playback_result
                .start_latency_ms
                .or(first_chunk.first_audio_latency_ms),
        })
    }

    // This streaming path coordinates playback timing, cancellation, progress, and chunk ordering.
    #[allow(clippy::too_many_arguments)]
    fn collect_and_play_ordered_chunks(
        &self,
        receiver: mpsc::Receiver<PipelineMessage>,
        expected_chunks: usize,
        mode: TtsMode,
        autoplay: bool,
        first_chunk_leading_silence_ms: u32,
        playback_speed: f32,
        pipeline_started: Instant,
        progress: Option<ProgressCallback>,
        run_access: Option<RunAccess>,
    ) -> Result<OrderedPlaybackResult, String> {
        let mut buffered = HashMap::<usize, GeneratedChunk>::new();
        let mut ordered = Vec::with_capacity(expected_chunks);
        let mut next_index = 0usize;
        let mut first_audio_playback_started_at_ms = None;
        let mut start_latency_ms = None;

        while ordered.len() < expected_chunks {
            if let Some(run_access) = &run_access {
                run_access.check_cancelled()?;
            }

            if let Some(chunk) = buffered.remove(&next_index) {
                self.play_chunk_if_needed(
                    &chunk,
                    expected_chunks,
                    autoplay,
                    first_chunk_leading_silence_ms,
                    playback_speed,
                    mode,
                    pipeline_started,
                    progress.as_ref(),
                    run_access.as_ref(),
                    &mut first_audio_playback_started_at_ms,
                    &mut start_latency_ms,
                )?;
                ordered.push(chunk);
                next_index += 1;
                continue;
            }

            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(PipelineMessage::ChunkReady(chunk)) => {
                    if chunk.index == next_index {
                        self.play_chunk_if_needed(
                            &chunk,
                            expected_chunks,
                            autoplay,
                            first_chunk_leading_silence_ms,
                            playback_speed,
                            mode,
                            pipeline_started,
                            progress.as_ref(),
                            run_access.as_ref(),
                            &mut first_audio_playback_started_at_ms,
                            &mut start_latency_ms,
                        )?;
                        ordered.push(chunk);
                        next_index += 1;

                        while let Some(buffered_chunk) = buffered.remove(&next_index) {
                            self.play_chunk_if_needed(
                                &buffered_chunk,
                                expected_chunks,
                                autoplay,
                                first_chunk_leading_silence_ms,
                                playback_speed,
                                mode,
                                pipeline_started,
                                progress.as_ref(),
                                run_access.as_ref(),
                                &mut first_audio_playback_started_at_ms,
                                &mut start_latency_ms,
                            )?;
                            ordered.push(buffered_chunk);
                            next_index += 1;
                        }
                    } else {
                        buffered.insert(chunk.index, chunk);
                    }
                }
                Ok(PipelineMessage::Failed(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(
                        "The chunked TTS pipeline stopped before all audio chunks were ready."
                            .to_string(),
                    )
                }
            }
        }

        Ok(OrderedPlaybackResult {
            chunks: ordered,
            first_audio_playback_started_at_ms,
            start_latency_ms,
        })
    }

    // Playback decisions depend on several timing and control signals that are kept explicit at the call site.
    #[allow(clippy::too_many_arguments)]
    fn play_chunk_if_needed(
        &self,
        chunk: &GeneratedChunk,
        total_chunks: usize,
        autoplay: bool,
        first_chunk_leading_silence_ms: u32,
        playback_speed: f32,
        mode: TtsMode,
        pipeline_started: Instant,
        progress: Option<&ProgressCallback>,
        run_access: Option<&RunAccess>,
        first_audio_playback_started_at_ms: &mut Option<u64>,
        start_latency_ms: &mut Option<u64>,
    ) -> Result<(), String> {
        if autoplay {
            if let Some(run_access) = run_access {
                run_access.update_chunk_phase("tts_playback", chunk.index + 1, total_chunks);
            }

            if let Some(progress) = progress {
                progress(TtsProgress::ChunkPlaybackStarted {
                    index: chunk.index,
                    total: total_chunks,
                    file_path: chunk.file_path.clone(),
                });
            }

            let playback_started = Instant::now();
            let leading_silence_ms =
                if chunk.index == 0 { first_chunk_leading_silence_ms } else { 0 };
            let playback_marker = if chunk.index == 0 {
                Some(PlaybackStartMarker {
                    mode,
                    pipeline_started,
                    progress: progress.cloned(),
                    first_audio_playback_started_at_ms,
                    start_latency_ms,
                })
            } else {
                None
            };
            play_audio(
                &chunk.file_path,
                leading_silence_ms,
                playback_speed,
                run_access,
                playback_marker,
            )?;
            let playback_elapsed_ms = playback_started.elapsed().as_millis();
            println!(
                "[tts] chunk_playback_finished chunk={}/{} elapsed_ms={} path={}",
                chunk.index + 1,
                total_chunks,
                playback_elapsed_ms,
                chunk.file_path
            );

            if let Some(progress) = progress {
                progress(TtsProgress::ChunkPlaybackFinished {
                    index: chunk.index,
                    total: total_chunks,
                    elapsed_ms: playback_elapsed_ms,
                });
            }
        }

        Ok(())
    }
}

fn normalize_audio_bytes(
    bytes: Vec<u8>,
    options: &ResolvedSpeakOptions,
) -> Result<Vec<u8>, String> {
    if options.format != "wav" {
        return Ok(bytes);
    }

    normalize_openai_wav_header(bytes)
}

fn normalize_openai_wav_header(mut bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(
            "Expected a WAV payload, but received an unsupported audio file header.".to_string()
        );
    }

    let riff_size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let data_size = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]);

    let expected_riff_size = (bytes.len().saturating_sub(8)) as u32;
    let expected_data_size = (bytes.len().saturating_sub(44)) as u32;

    if riff_size == u32::MAX || riff_size == 0 {
        bytes[4..8].copy_from_slice(&expected_riff_size.to_le_bytes());
    }

    if data_size == u32::MAX || data_size == 0 {
        bytes[40..44].copy_from_slice(&expected_data_size.to_le_bytes());
    }

    Ok(bytes)
}

fn maybe_prepend_leading_silence(
    bytes: Vec<u8>,
    options: &ResolvedSpeakOptions,
    chunk_index: usize,
) -> Result<Vec<u8>, String> {
    if chunk_index == 0 && options.first_chunk_leading_silence_ms > 0 && options.format == "wav" {
        println!(
            "[tts] first_chunk_silence_mode=playback_side silence_ms={}",
            options.first_chunk_leading_silence_ms
        );
    }

    Ok(bytes)
}

#[derive(Clone)]
struct TextChunker {
    max_chunk_chars: usize,
}

impl TextChunker {
    fn new(max_chunk_chars: usize) -> Self {
        Self { max_chunk_chars }
    }

    fn split(&self, text: &str) -> Vec<String> {
        let normalized = text.replace("\r\n", "\n");
        let trimmed = normalized.trim();

        if trimmed.is_empty() {
            return Vec::new();
        }

        let mut chunks = Vec::new();
        let mut current = String::new();

        for sentence in split_into_sentences(trimmed) {
            for part in split_segment_to_fit(&sentence, self.max_chunk_chars) {
                if current.is_empty() {
                    current = part;
                    continue;
                }

                if char_count(&current) + 1 + char_count(&part) <= self.max_chunk_chars {
                    current.push(' ');
                    current.push_str(&part);
                } else {
                    chunks.push(current);
                    current = part;
                }
            }
        }

        if !current.is_empty() {
            chunks.push(current);
        }

        chunks
    }
}

fn char_count(value: &str) -> usize {
    value.chars().count()
}

fn split_into_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut start = 0usize;
    let mut previous_was_newline = false;
    let mut iter = text.char_indices().peekable();

    while let Some((index, ch)) = iter.next() {
        let mut boundary = false;
        let mut boundary_end = index + ch.len_utf8();

        if matches!(ch, '.' | '!' | '?') {
            let mut lookahead = iter.clone();
            while let Some((quote_index, next)) = lookahead.peek().copied() {
                if matches!(next, '"' | '\'' | ')' | ']' | '}') {
                    boundary_end = quote_index + next.len_utf8();
                    lookahead.next();
                    continue;
                }

                boundary = next.is_whitespace();
                break;
            }

            if lookahead.peek().is_none() {
                boundary = true;
            }
        } else if ch == '\n' {
            if previous_was_newline {
                boundary = true;
            }
            previous_was_newline = true;
        } else if !ch.is_whitespace() {
            previous_was_newline = false;
        }

        if boundary {
            let segment = text[start..boundary_end].trim();
            if !segment.is_empty() {
                sentences.push(segment.to_string());
            }

            start = boundary_end;
            while let Some((next_index, next_ch)) = iter.peek().copied() {
                if next_ch.is_whitespace() {
                    iter.next();
                    start = next_index + next_ch.len_utf8();
                } else {
                    break;
                }
            }
            previous_was_newline = false;
        }
    }

    let tail = text[start..].trim();
    if !tail.is_empty() {
        sentences.push(tail.to_string());
    }

    if sentences.is_empty() {
        vec![text.trim().to_string()]
    } else {
        sentences
    }
}

fn split_segment_to_fit(segment: &str, max_chars: usize) -> Vec<String> {
    let trimmed = segment.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if char_count(trimmed) <= max_chars {
        return vec![trimmed.to_string()];
    }

    let mut parts = Vec::new();
    let mut current = String::new();

    for token in trimmed.split_whitespace() {
        let token_len = char_count(token);
        let current_len = char_count(&current);
        let separator_len = usize::from(!current.is_empty());

        if current_len + separator_len + token_len <= max_chars {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(token);
            continue;
        }

        if !current.is_empty() {
            parts.push(current);
            current = String::new();
        }

        if token_len <= max_chars {
            current.push_str(token);
            continue;
        }

        let split_tokens = split_long_token(token, max_chars);
        let last_index = split_tokens.len().saturating_sub(1);
        for (index, split_token) in split_tokens.into_iter().enumerate() {
            if index == last_index {
                current = split_token;
            } else {
                parts.push(split_token);
            }
        }
    }

    if !current.is_empty() {
        parts.push(current);
    }

    parts
}

fn split_long_token(token: &str, max_chars: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();

    for ch in token.chars() {
        current.push(ch);
        if char_count(&current) >= max_chars {
            parts.push(current);
            current = String::new();
        }
    }

    if !current.is_empty() {
        parts.push(current);
    }

    parts
}

fn build_output_directory() -> Result<PathBuf, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_micros())
        .unwrap_or(0);

    let mut dir = env::temp_dir();
    dir.push("voice-overlay-assistant");
    dir.push("tts-output");
    dir.push(format!("speech-{ts}"));

    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create output directory: {err}"))?;
    Ok(dir)
}

fn build_chunk_path(output_directory: &Path, index: usize, format: &str) -> PathBuf {
    output_directory.join(format!("chunk-{:03}.{format}", index + 1))
}

fn resolve_tts_mode(value: Option<String>) -> TtsMode {
    match value.unwrap_or_else(|| DEFAULT_TTS_MODE.to_string()).trim().to_lowercase().as_str() {
        "live" | "low_latency" | "low-latency" => TtsMode::Live,
        "realtime" | "realtime_experimental" | "realtime-experimental" => {
            TtsMode::RealtimeExperimental
        }
        _ => TtsMode::Classic,
    }
}

fn build_session_plan(requested_mode: TtsMode) -> SpeechSessionPlan {
    let session_id = format!("tts-session-{}", system_time_ms());
    match requested_mode {
        TtsMode::Classic => SpeechSessionPlan {
            session_id,
            requested_mode,
            resolved_mode: TtsMode::Classic,
            session_strategy: "chunked_file_session".to_string(),
            supports_persistent_session: false,
            fallback_reason: None,
        },
        TtsMode::Live => SpeechSessionPlan {
            session_id,
            requested_mode,
            resolved_mode: TtsMode::Live,
            session_strategy: "streaming_audio_session".to_string(),
            supports_persistent_session: true,
            fallback_reason: None,
        },
        TtsMode::RealtimeExperimental => SpeechSessionPlan {
            session_id,
            requested_mode,
            resolved_mode: TtsMode::RealtimeExperimental,
            session_strategy: "realtime_websocket_session".to_string(),
            supports_persistent_session: true,
            fallback_reason: None,
        },
    }
}

fn default_model_for_mode(mode: TtsMode) -> &'static str {
    match mode {
        TtsMode::Classic | TtsMode::Live => DEFAULT_MODEL,
        TtsMode::RealtimeExperimental => DEFAULT_REALTIME_MODEL,
    }
}

#[cfg(test)]
fn resolve_fallback_live_model(explicit_model: Option<&str>) -> String {
    match explicit_model.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.contains("realtime") => DEFAULT_MODEL.to_string(),
        Some(value) => value.to_string(),
        None => DEFAULT_MODEL.to_string(),
    }
}

fn resolve_format(format: Option<String>) -> Result<String, String> {
    let value = format.unwrap_or_else(|| DEFAULT_FORMAT.to_string()).trim().to_lowercase();

    match value.as_str() {
        "mp3" | "wav" => Ok(value),
        _ => Err(format!("Unsupported audio format '{value}'. Use 'mp3' or 'wav'.")),
    }
}

fn resolve_parallel_requests(value: Option<usize>) -> usize {
    value.unwrap_or(DEFAULT_MAX_PARALLEL_REQUESTS).clamp(1, MAX_PARALLEL_REQUESTS_LIMIT)
}

fn resolve_max_chunk_chars(value: Option<usize>) -> usize {
    value.unwrap_or(DEFAULT_MAX_CHUNK_CHARS).clamp(MIN_CHUNK_CHARS, MAX_CHUNK_CHARS)
}

fn join_worker_handles(handles: Vec<thread::JoinHandle<()>>) -> Result<(), String> {
    for handle in handles {
        if handle.join().is_err() {
            return Err("A TTS worker thread panicked while preparing audio chunks.".to_string());
        }
    }

    Ok(())
}

struct SinkRegistrationGuard<'a> {
    run_access: Option<&'a RunAccess>,
}

impl<'a> SinkRegistrationGuard<'a> {
    fn new(run_access: Option<&'a RunAccess>) -> Self {
        Self { run_access }
    }
}

impl Drop for SinkRegistrationGuard<'_> {
    fn drop(&mut self) {
        if let Some(run_access) = self.run_access {
            run_access.clear_sink();
        }
    }
}

struct PlaybackStartMarker<'a> {
    mode: TtsMode,
    pipeline_started: Instant,
    progress: Option<ProgressCallback>,
    first_audio_playback_started_at_ms: &'a mut Option<u64>,
    start_latency_ms: &'a mut Option<u64>,
}

fn mark_first_audio_playback_started(marker: &mut PlaybackStartMarker<'_>) {
    let at_ms = system_time_ms();
    let latency_ms = millis_u64(marker.pipeline_started.elapsed());

    *marker.first_audio_playback_started_at_ms = Some(at_ms);
    *marker.start_latency_ms = Some(latency_ms);

    if let Some(progress) = &marker.progress {
        progress(TtsProgress::FirstAudioPlaybackStarted {
            mode: marker.mode.as_str().to_string(),
            at_ms,
            latency_ms,
        });
    }
}

fn sleep_with_run_control(
    duration: Duration,
    run_access: Option<&RunAccess>,
) -> Result<(), String> {
    let started = Instant::now();

    loop {
        if let Some(run_access) = run_access {
            run_access.wait_if_paused()?;
            run_access.check_cancelled()?;
        }

        let elapsed = started.elapsed();
        if elapsed >= duration {
            return Ok(());
        }

        let remaining = duration.saturating_sub(elapsed);
        thread::sleep(remaining.min(Duration::from_millis(25)));
    }
}

fn decode_audio_samples(file_path: &str) -> Result<(u16, u32, Vec<f32>), String> {
    let file = fs::File::open(file_path)
        .map_err(|err| format!("Failed to open audio file for playback: {err}"))?;
    let reader = BufReader::new(file);
    let source = Decoder::new(reader)
        .map_err(|err| format!("Failed to decode audio file '{file_path}': {err}"))?;
    let channels = source.channels();
    let sample_rate = source.sample_rate();
    let samples = source.convert_samples::<f32>().collect();

    Ok((channels, sample_rate, samples))
}

fn crossfade_strength(position: usize, overlap: usize) -> f32 {
    if overlap <= 1 {
        return 1.0;
    }

    position as f32 / (overlap - 1) as f32
}

fn find_best_overlap_offset(
    previous_tail: &[f32],
    channel_samples: &[f32],
    next_search_start: usize,
    overlap: usize,
    search: usize,
) -> usize {
    let max_offset =
        (channel_samples.len().saturating_sub(overlap)).min(next_search_start + search);
    let mut best_offset = next_search_start.min(max_offset);
    let mut best_score = f32::MIN;

    for candidate in next_search_start.min(max_offset)..=max_offset {
        let candidate_slice = &channel_samples[candidate..candidate + overlap];
        let score = previous_tail
            .iter()
            .zip(candidate_slice.iter())
            .map(|(left, right)| left * right)
            .sum::<f32>();

        if score > best_score {
            best_score = score;
            best_offset = candidate;
        }
    }

    best_offset
}

fn time_stretch_channel_samples(channel_samples: &[f32], playback_speed: f32) -> Vec<f32> {
    if channel_samples.len() < TIME_STRETCH_FRAME_SIZE || (playback_speed - 1.0).abs() < 0.01 {
        return channel_samples.to_vec();
    }

    let frame_size = TIME_STRETCH_FRAME_SIZE.min(channel_samples.len());
    let overlap = TIME_STRETCH_OVERLAP.min(frame_size / 4).max(64);
    let analysis_hop = ((frame_size - overlap) as f32 * playback_speed).round().max(1.0) as usize;
    let synthesis_hop = frame_size - overlap;
    let search = TIME_STRETCH_SEARCH.min(synthesis_hop.max(1));

    if channel_samples.len() <= frame_size + overlap || synthesis_hop == 0 {
        return channel_samples.to_vec();
    }

    let estimated_frames =
        ((channel_samples.len() as f32 / analysis_hop as f32).ceil() as usize).max(1);
    let mut output = Vec::with_capacity(estimated_frames * synthesis_hop + frame_size);
    output.extend_from_slice(&channel_samples[..frame_size]);

    let mut input_pos = analysis_hop.min(channel_samples.len().saturating_sub(frame_size));

    while input_pos + frame_size <= channel_samples.len() {
        let output_len = output.len();
        let previous_tail_start = output_len.saturating_sub(overlap);
        let previous_tail = &output[previous_tail_start..output_len];
        let search_start = input_pos.saturating_sub(search / 2);
        let best_offset =
            find_best_overlap_offset(previous_tail, channel_samples, search_start, overlap, search);
        let frame = &channel_samples[best_offset..best_offset + frame_size];

        for (i, sample) in frame.iter().enumerate().take(overlap) {
            let fade_in = crossfade_strength(i, overlap);
            let fade_out = 1.0 - fade_in;
            let out_index = output_len - overlap + i;
            output[out_index] = (output[out_index] * fade_out) + (*sample * fade_in);
        }

        output.extend_from_slice(&frame[overlap..]);
        input_pos = best_offset.saturating_add(analysis_hop);
    }

    output
}

fn time_stretch_samples(samples: &[f32], channels: u16, playback_speed: f32) -> Vec<f32> {
    if channels <= 1 {
        return time_stretch_channel_samples(samples, playback_speed);
    }

    let channel_count = channels as usize;
    let frames = samples.len() / channel_count;
    if frames < TIME_STRETCH_FRAME_SIZE {
        return samples.to_vec();
    }

    let mut split_channels = vec![Vec::with_capacity(frames); channel_count];
    for frame in samples.chunks_exact(channel_count) {
        for (channel_index, sample) in frame.iter().enumerate() {
            split_channels[channel_index].push(*sample);
        }
    }

    let stretched_channels: Vec<Vec<f32>> = split_channels
        .iter()
        .map(|channel| time_stretch_channel_samples(channel, playback_speed))
        .collect();
    let output_frames = stretched_channels.iter().map(Vec::len).min().unwrap_or(0);
    let mut interleaved = Vec::with_capacity(output_frames * channel_count);

    for frame_index in 0..output_frames {
        for channel in &stretched_channels {
            interleaved.push(channel[frame_index]);
        }
    }

    interleaved
}

fn naturalized_live_buffer_ms(base_ms: u32, playback_speed: f32) -> u32 {
    let speedup = (playback_speed - 1.0).max(0.0);
    let slowdown = (1.0 - playback_speed).max(0.0);

    (base_ms as f32
        + (speedup * LIVE_NATURALIZED_SPEEDUP_BUFFER_MS as f32)
        + (slowdown * LIVE_NATURALIZED_SLOWDOWN_BUFFER_MS as f32))
        .round()
        .clamp(base_ms as f32, 900.0) as u32
}

fn crossfade_live_output_chunks(previous: &[f32], next: &[f32]) -> Vec<f32> {
    if previous.is_empty() {
        return next.to_vec();
    }

    if next.is_empty() {
        return previous.to_vec();
    }

    let crossfade_len = previous.len().min(next.len());
    let previous_prefix_len = previous.len().saturating_sub(crossfade_len);
    let mut merged = Vec::with_capacity(previous.len() + next.len() - crossfade_len);

    merged.extend_from_slice(&previous[..previous_prefix_len]);

    for index in 0..crossfade_len {
        let fade_in = crossfade_strength(index, crossfade_len);
        let fade_out = 1.0 - fade_in;
        merged.push((previous[previous_prefix_len + index] * fade_out) + (next[index] * fade_in));
    }

    merged.extend_from_slice(&next[crossfade_len..]);
    merged
}

fn play_audio(
    file_path: &str,
    leading_silence_ms: u32,
    playback_speed: f32,
    run_access: Option<&RunAccess>,
    mut playback_start_marker: Option<PlaybackStartMarker<'_>>,
) -> Result<(), String> {
    if let Some(run_access) = run_access {
        run_access.check_cancelled()?;
        run_access.update_phase("tts_loading_audio");
    }

    let (channels, sample_rate, samples) = decode_audio_samples(file_path)?;
    let stretched_samples = time_stretch_samples(&samples, channels, playback_speed);

    let (stream, stream_handle) = OutputStream::try_default()
        .map_err(|err| format!("Failed to open default audio output device: {err}"))?;
    let sink = Arc::new(
        Sink::try_new(&stream_handle)
            .map_err(|err| format!("Failed to create audio sink: {err}"))?,
    );
    let _sink_registration = SinkRegistrationGuard::new(run_access);

    if let Some(run_access) = run_access {
        run_access.register_sink(Arc::clone(&sink))?;
        run_access.update_phase("tts_playback_active");
    }

    if leading_silence_ms > 0 {
        println!(
            "[tts] chunk_playback_leading_silence_ms={} path={}",
            leading_silence_ms, file_path
        );
        sleep_with_run_control(Duration::from_millis(leading_silence_ms as u64), run_access)?;
    }

    if (playback_speed - 1.0).abs() >= 0.01 {
        println!(
            "[tts] playback_speed_mode=time_stretch speed={} path={} note=pitch-preserving-ish overlap-add",
            playback_speed, file_path
        );
    }

    if let Some(marker) = playback_start_marker.as_mut() {
        mark_first_audio_playback_started(marker);
    }
    sink.append(SamplesBuffer::new(channels, sample_rate, stretched_samples));

    loop {
        if let Some(run_access) = run_access {
            run_access.wait_if_paused()?;
            run_access.check_cancelled()?;
        }

        if sink.empty() {
            break;
        }

        thread::sleep(Duration::from_millis(30));
    }

    drop(stream);

    Ok(())
}

fn pcm_buffer_bytes(
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    buffer_ms: u32,
) -> usize {
    ((sample_rate as usize * channels as usize * (bits_per_sample as usize / 8))
        * buffer_ms as usize)
        / 1_000
}

fn live_buffer_bytes(buffer_ms: u32) -> usize {
    pcm_buffer_bytes(LIVE_SAMPLE_RATE, LIVE_CHANNELS, LIVE_BITS_PER_SAMPLE, buffer_ms)
}

fn pcm16le_to_f32_samples(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32)
        .collect()
}

// The sink bridge forwards audio data plus timing/progress state without hiding side effects in a context object.
#[allow(clippy::too_many_arguments)]
fn append_pcm_samples_to_sink(
    sink: &Sink,
    samples: Vec<f32>,
    channels: u16,
    sample_rate: u32,
    file_path: &str,
    mode: TtsMode,
    pipeline_started: Instant,
    progress: Option<&ProgressCallback>,
    first_audio_playback_started_at_ms: &mut Option<u64>,
    start_latency_ms: &mut Option<u64>,
) {
    if samples.is_empty() {
        return;
    }

    if first_audio_playback_started_at_ms.is_none() {
        let at_ms = system_time_ms();
        let latency_ms = millis_u64(pipeline_started.elapsed());
        *first_audio_playback_started_at_ms = Some(at_ms);
        *start_latency_ms = Some(latency_ms);

        if let Some(progress) = progress {
            progress(TtsProgress::FirstAudioPlaybackStarted {
                mode: mode.as_str().to_string(),
                at_ms,
                latency_ms,
            });
            progress(TtsProgress::ChunkPlaybackStarted {
                index: 0,
                total: 1,
                file_path: file_path.to_string(),
            });
        }
    }

    sink.append(SamplesBuffer::new(channels, sample_rate, samples));
}

fn wrap_pcm_as_wav(bytes: &[u8], sample_rate: u32, channels: u16, bits_per_sample: u16) -> Vec<u8> {
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * block_align as u32;
    let data_size = bytes.len() as u32;
    let riff_size = 36u32.saturating_add(data_size);
    let mut wav = Vec::with_capacity(44 + bytes.len());

    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.extend_from_slice(bytes);

    wav
}

fn wait_for_sink_to_finish(sink: &Sink, run_access: Option<&RunAccess>) -> Result<(), String> {
    loop {
        if let Some(run_access) = run_access {
            run_access.wait_if_paused()?;
            run_access.check_cancelled()?;
        }

        if sink.empty() {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(30));
    }
}

// This helper mirrors the live PCM pipeline inputs directly so streaming callers stay explicit.
#[allow(clippy::too_many_arguments)]
fn append_pcm16_to_sink(
    sink: &Sink,
    pending_pcm_bytes: &mut Vec<u8>,
    channels: u16,
    sample_rate: u32,
    file_path: &str,
    mode: TtsMode,
    pipeline_started: Instant,
    progress: Option<&ProgressCallback>,
    first_audio_playback_started_at_ms: &mut Option<u64>,
    start_latency_ms: &mut Option<u64>,
) {
    let even_len = pending_pcm_bytes.len() - (pending_pcm_bytes.len() % 2);
    if even_len == 0 {
        return;
    }

    let chunk_bytes = pending_pcm_bytes.drain(..even_len).collect::<Vec<_>>();
    append_pcm_samples_to_sink(
        sink,
        pcm16le_to_f32_samples(&chunk_bytes),
        channels,
        sample_rate,
        file_path,
        mode,
        pipeline_started,
        progress,
        first_audio_playback_started_at_ms,
        start_latency_ms,
    );
}

// Naturalized live playback needs both transport state and playback timing at once.
#[allow(clippy::too_many_arguments)]
fn append_naturalized_pcm16_to_sink(
    sink: &Sink,
    pending_pcm_bytes: &mut Vec<u8>,
    channels: u16,
    sample_rate: u32,
    playback_speed: f32,
    playback_state: &mut NaturalizedLivePlaybackState,
    flush_all: bool,
    file_path: &str,
    mode: TtsMode,
    pipeline_started: Instant,
    progress: Option<&ProgressCallback>,
    first_audio_playback_started_at_ms: &mut Option<u64>,
    start_latency_ms: &mut Option<u64>,
) {
    let even_len = pending_pcm_bytes.len() - (pending_pcm_bytes.len() % 2);
    if even_len == 0 {
        return;
    }

    let chunk_bytes = pending_pcm_bytes.drain(..even_len).collect::<Vec<_>>();
    let transformed_samples =
        time_stretch_samples(&pcm16le_to_f32_samples(&chunk_bytes), channels, playback_speed);
    let output_samples = playback_state.merge_transformed_batch(transformed_samples, flush_all);

    append_pcm_samples_to_sink(
        sink,
        output_samples,
        channels,
        sample_rate,
        file_path,
        mode,
        pipeline_started,
        progress,
        first_audio_playback_started_at_ms,
        start_latency_ms,
    );
}

fn nested_value<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn nested_u64(value: &Value, path: &[&str]) -> Option<u64> {
    nested_value(value, path)?.as_u64()
}

fn realtime_output_sample_rate_from_event(event: &Value) -> Option<u32> {
    [
        ["session", "audio", "output", "format", "rate"],
        ["session", "audio", "input", "format", "rate"],
        ["response", "audio", "output", "format", "rate"],
    ]
    .iter()
    .find_map(|path| nested_u64(event, path).and_then(|value| u32::try_from(value).ok()))
}

fn extract_realtime_error_message(event: &Value) -> String {
    nested_value(event, &["error", "message"])
        .and_then(Value::as_str)
        .or_else(|| {
            nested_value(event, &["response", "status_details", "error", "message"])
                .and_then(Value::as_str)
        })
        .or_else(|| nested_value(event, &["message"]).and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| event.to_string())
}

fn configure_realtime_socket(socket: &mut RealtimeSocket) -> Result<(), String> {
    let timeout = Some(Duration::from_millis(REALTIME_EVENT_POLL_TIMEOUT_MS));
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream.set_read_timeout(timeout),
        MaybeTlsStream::Rustls(stream) => stream.get_mut().set_read_timeout(timeout),
        _ => Ok(()),
    }
    .map_err(|err| format!("Failed to configure realtime websocket timeouts: {err}"))
}

fn read_realtime_socket(socket: &mut RealtimeSocket) -> Result<RealtimeSocketRead, String> {
    match socket.read() {
        Ok(WsMessage::Text(text)) => serde_json::from_str::<Value>(text.as_ref())
            .map(RealtimeSocketRead::Event)
            .map_err(|err| format!("Failed to parse realtime websocket event: {err}")),
        Ok(WsMessage::Ping(_)) | Ok(WsMessage::Pong(_)) => Ok(RealtimeSocketRead::Ignored),
        Ok(WsMessage::Close(frame)) => Ok(RealtimeSocketRead::Closed(
            frame.map(|frame| frame.reason.to_string()).filter(|reason| !reason.trim().is_empty()),
        )),
        Ok(_) => Ok(RealtimeSocketRead::Ignored),
        Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => {
            Ok(RealtimeSocketRead::Closed(None))
        }
        Err(tungstenite::Error::Io(error))
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::WouldBlock
                    | std::io::ErrorKind::Interrupted
            ) =>
        {
            Ok(RealtimeSocketRead::Timeout)
        }
        Err(error) => Err(format!("Realtime websocket read failed: {error}")),
    }
}

fn send_realtime_json_event(socket: &mut RealtimeSocket, event: Value) -> Result<(), String> {
    socket
        .send(WsMessage::Text(event.to_string()))
        .map_err(|err| format!("Realtime websocket write failed: {err}"))
}

fn close_realtime_socket(socket: &mut RealtimeSocket) {
    let _ = socket.close(None);
}

fn cancel_realtime_socket(socket: &mut RealtimeSocket) {
    let _ = send_realtime_json_event(socket, json!({ "type": "response.cancel" }));
    let _ = socket.close(None);
}

fn check_realtime_run_control(
    run_access: Option<&RunAccess>,
    socket: &mut RealtimeSocket,
) -> Result<(), RealtimePipelineError> {
    let Some(run_access) = run_access else {
        return Ok(());
    };

    if let Err(error) = run_access.wait_if_paused() {
        if is_cancelled_error(&error) {
            cancel_realtime_socket(socket);
        }
        return Err(RealtimePipelineError::terminal(error));
    }

    if let Err(error) = run_access.check_cancelled() {
        if is_cancelled_error(&error) {
            cancel_realtime_socket(socket);
        }
        return Err(RealtimePipelineError::terminal(error));
    }

    Ok(())
}

impl LiveSpeechPipeline {
    fn run(
        &self,
        text: &str,
        options: ResolvedSpeakOptions,
        session_plan: &SpeechSessionPlan,
        progress: Option<ProgressCallback>,
        run_access: Option<RunAccess>,
    ) -> Result<SpeakTextResult, String> {
        let started = Instant::now();
        let started_at_ms = system_time_ms();
        let output_directory = build_output_directory()?;
        let output_file = build_chunk_path(&output_directory, 0, &options.format);
        let output_file_path = output_file.to_string_lossy().to_string();

        if let Some(run_access) = &run_access {
            run_access.check_cancelled()?;
            run_access.update_phase("tts_streaming_request");
        }

        if let Some(progress_cb) = &progress {
            progress_cb(TtsProgress::PipelineStarted {
                mode: options.mode.as_str().to_string(),
                chunk_count: 1,
                format: options.format.clone(),
                transport_format: options.transport_format.clone(),
                autoplay: options.autoplay,
                max_parallel_requests: 1,
                started_at_ms,
            });
        }

        println!(
            "[tts] pipeline_start mode={} format={} transport_format={} autoplay={} planned_chunks=1 text_chars={}",
            options.mode.as_str(),
            options.format,
            options.transport_format,
            options.autoplay,
            text.chars().count()
        );

        if options.first_chunk_leading_silence_ms > 0 {
            println!(
                "[tts] live_mode_ignores_first_chunk_lead_in requested_ms={}",
                options.first_chunk_leading_silence_ms
            );
        }

        let live_request_started = Instant::now();
        let request_body = OpenAiSpeechRequest {
            model: &options.model,
            voice: &options.voice,
            input: text,
            response_format: &options.transport_format,
        };
        let live_http_client = build_live_http_client()?;

        let mut response = live_http_client
            .post("https://api.openai.com/v1/audio/speech")
            .bearer_auth(&self.api_key)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .map_err(|err| format!("OpenAI live speech request failed: {err}"))?;

        println!(
            "[tts] live_request_headers_received latency_ms={} status={}",
            millis_u64(live_request_started.elapsed()),
            response.status()
        );

        if let Some(run_access) = &run_access {
            run_access.check_cancelled()?;
            run_access.update_phase("tts_streaming_audio");
        }

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(format!("OpenAI live TTS failed ({status}): {body}"));
        }

        let playback_path = LivePlaybackPath::from_playback_speed(options.playback_speed);
        let initial_buffer_ms = playback_path.initial_buffer_ms(options.playback_speed);
        let stream_buffer_ms = playback_path.stream_buffer_ms(options.playback_speed);

        println!(
            "[tts] live_playback_path={} speed={} initial_buffer_ms={} stream_buffer_ms={}",
            playback_path.as_str(),
            options.playback_speed,
            initial_buffer_ms,
            stream_buffer_ms
        );

        let mut _stream = None;
        let mut sink = None;
        let mut naturalized_playback_state =
            NaturalizedLivePlaybackState::new(LIVE_NATURALIZED_OUTPUT_CROSSFADE_SAMPLES);
        let _sink_registration = SinkRegistrationGuard::new(run_access.as_ref());
        if options.autoplay {
            let (stream, stream_handle) = OutputStream::try_default()
                .map_err(|err| format!("Failed to open default audio output device: {err}"))?;
            let live_sink = Arc::new(
                Sink::try_new(&stream_handle)
                    .map_err(|err| format!("Failed to create audio sink: {err}"))?,
            );

            if let Some(run_access) = &run_access {
                run_access.register_sink(Arc::clone(&live_sink))?;
                run_access.update_phase("tts_playback_active");
            }

            _stream = Some(stream);
            sink = Some(live_sink);
        }

        let mut read_buffer = [0u8; LIVE_READ_BUFFER_BYTES];
        let mut full_pcm_bytes = Vec::new();
        let mut pending_pcm_bytes = Vec::new();
        let mut first_audio_received_at_ms = None;
        let mut first_audio_playback_started_at_ms = None;
        let mut start_latency_ms = None;

        loop {
            if let Some(run_access) = &run_access {
                run_access.wait_if_paused()?;
                run_access.check_cancelled()?;
            }

            match response.read(&mut read_buffer) {
                Ok(0) => break,
                Ok(bytes_read) => {
                    if first_audio_received_at_ms.is_none() {
                        let at_ms = system_time_ms();
                        let latency_ms = millis_u64(started.elapsed());
                        first_audio_received_at_ms = Some(at_ms);
                        println!(
                            "[tts] first_audio_received mode={} latency_ms={} bytes_received={}",
                            options.mode.as_str(),
                            latency_ms,
                            bytes_read
                        );

                        if let Some(progress) = &progress {
                            progress(TtsProgress::FirstAudioReceived {
                                mode: options.mode.as_str().to_string(),
                                at_ms,
                                latency_ms,
                                bytes_received: bytes_read,
                            });
                        }
                    }

                    full_pcm_bytes.extend_from_slice(&read_buffer[..bytes_read]);
                    pending_pcm_bytes.extend_from_slice(&read_buffer[..bytes_read]);

                    if let Some(sink) = sink.as_ref() {
                        let threshold_bytes = if first_audio_playback_started_at_ms.is_some() {
                            live_buffer_bytes(stream_buffer_ms)
                        } else {
                            live_buffer_bytes(initial_buffer_ms)
                        };

                        if pending_pcm_bytes.len() >= threshold_bytes {
                            match playback_path {
                                LivePlaybackPath::FastDirect => append_pcm16_to_sink(
                                    sink,
                                    &mut pending_pcm_bytes,
                                    LIVE_CHANNELS,
                                    LIVE_SAMPLE_RATE,
                                    &output_file_path,
                                    options.mode,
                                    started,
                                    progress.as_ref(),
                                    &mut first_audio_playback_started_at_ms,
                                    &mut start_latency_ms,
                                ),
                                LivePlaybackPath::NaturalizedSpeed => {
                                    append_naturalized_pcm16_to_sink(
                                        sink,
                                        &mut pending_pcm_bytes,
                                        LIVE_CHANNELS,
                                        LIVE_SAMPLE_RATE,
                                        options.playback_speed,
                                        &mut naturalized_playback_state,
                                        false,
                                        &output_file_path,
                                        options.mode,
                                        started,
                                        progress.as_ref(),
                                        &mut first_audio_playback_started_at_ms,
                                        &mut start_latency_ms,
                                    );
                                }
                            }
                        }
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                Err(error) => {
                    return Err(format!("Failed to read streamed audio response: {error}"));
                }
            }
        }

        if full_pcm_bytes.is_empty() {
            return Err("OpenAI returned an empty live audio stream.".to_string());
        }

        if let Some(sink) = sink.as_ref() {
            match playback_path {
                LivePlaybackPath::FastDirect => append_pcm16_to_sink(
                    sink,
                    &mut pending_pcm_bytes,
                    LIVE_CHANNELS,
                    LIVE_SAMPLE_RATE,
                    &output_file_path,
                    options.mode,
                    started,
                    progress.as_ref(),
                    &mut first_audio_playback_started_at_ms,
                    &mut start_latency_ms,
                ),
                LivePlaybackPath::NaturalizedSpeed => {
                    append_naturalized_pcm16_to_sink(
                        sink,
                        &mut pending_pcm_bytes,
                        LIVE_CHANNELS,
                        LIVE_SAMPLE_RATE,
                        options.playback_speed,
                        &mut naturalized_playback_state,
                        true,
                        &output_file_path,
                        options.mode,
                        started,
                        progress.as_ref(),
                        &mut first_audio_playback_started_at_ms,
                        &mut start_latency_ms,
                    );

                    append_pcm_samples_to_sink(
                        sink,
                        naturalized_playback_state.take_pending_output_tail(),
                        LIVE_CHANNELS,
                        LIVE_SAMPLE_RATE,
                        &output_file_path,
                        options.mode,
                        started,
                        progress.as_ref(),
                        &mut first_audio_playback_started_at_ms,
                        &mut start_latency_ms,
                    );
                }
            }
            wait_for_sink_to_finish(sink, run_access.as_ref())?;

            if let Some(progress) = &progress {
                progress(TtsProgress::ChunkPlaybackFinished {
                    index: 0,
                    total: 1,
                    elapsed_ms: started.elapsed().as_millis(),
                });
            }
        }

        let wav_bytes =
            wrap_pcm_as_wav(&full_pcm_bytes, LIVE_SAMPLE_RATE, LIVE_CHANNELS, LIVE_BITS_PER_SAMPLE);
        fs::write(&output_file, &wav_bytes)
            .map_err(|err| format!("Failed to write live audio file: {err}"))?;

        println!(
            "[tts] pipeline_done mode={} produced_chunks=1 bytes_written={} first_audio_received_at_ms={:?} first_audio_playback_started_at_ms={:?} start_latency_ms={:?} total_ms={}",
            options.mode.as_str(),
            wav_bytes.len(),
            first_audio_received_at_ms,
            first_audio_playback_started_at_ms,
            start_latency_ms,
            started.elapsed().as_millis()
        );

        Ok(SpeakTextResult {
            file_path: output_file_path,
            output_directory: output_directory.to_string_lossy().to_string(),
            bytes_written: wav_bytes.len(),
            chunk_count: 1,
            voice: options.voice,
            model: options.model,
            mode: session_plan.mode_label().to_string(),
            requested_mode: session_plan.requested_mode.as_str().to_string(),
            session_id: session_plan.session_id.clone(),
            session_strategy: session_plan.session_strategy.clone(),
            fallback_reason: session_plan.fallback_reason.clone(),
            supports_persistent_session: session_plan.supports_persistent_session,
            format: options.format,
            transport_format: options.transport_format,
            autoplay: options.autoplay,
            first_audio_received_at_ms,
            first_audio_playback_started_at_ms,
            start_latency_ms,
        })
    }
}

impl RealtimeSpeechPipeline {
    fn connect(&self, model: &str) -> Result<RealtimeSocket, String> {
        let mut request = format!("wss://api.openai.com/v1/realtime?model={model}")
            .into_client_request()
            .map_err(|err| format!("Failed to build realtime websocket request: {err}"))?;
        let bearer = format!("Bearer {}", self.api_key);
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&bearer)
                .map_err(|err| format!("Failed to build realtime auth header: {err}"))?,
        );
        request.headers_mut().insert("OpenAI-Beta", HeaderValue::from_static("realtime=v1"));

        let (mut socket, _) = tungstenite::connect(request)
            .map_err(|err| format!("OpenAI realtime websocket connection failed: {err}"))?;
        configure_realtime_socket(&mut socket)?;

        Ok(socket)
    }

    fn run(
        &self,
        text: &str,
        options: ResolvedSpeakOptions,
        session_plan: &SpeechSessionPlan,
        progress: Option<ProgressCallback>,
        run_access: Option<RunAccess>,
    ) -> Result<SpeakTextResult, RealtimePipelineError> {
        let started = Instant::now();
        let started_at_ms = system_time_ms();
        let output_directory = build_output_directory().map_err(RealtimePipelineError::terminal)?;
        let output_file = build_chunk_path(&output_directory, 0, &options.format);
        let output_file_path = output_file.to_string_lossy().to_string();

        if let Some(run_access) = &run_access {
            run_access.check_cancelled().map_err(RealtimePipelineError::terminal)?;
            run_access.update_phase("tts_realtime_connecting");
        }

        if let Some(progress_cb) = &progress {
            progress_cb(TtsProgress::PipelineStarted {
                mode: options.mode.as_str().to_string(),
                chunk_count: 1,
                format: options.format.clone(),
                transport_format: options.transport_format.clone(),
                autoplay: options.autoplay,
                max_parallel_requests: 1,
                started_at_ms,
            });
            progress_cb(TtsProgress::RealtimeConnecting {
                mode: options.mode.as_str().to_string(),
                model: options.model.clone(),
                voice: options.voice.clone(),
                session_id: session_plan.session_id.clone(),
            });
        }

        println!(
            "[tts] pipeline_start mode={} format={} transport_format={} autoplay={} planned_chunks=1 text_chars={} session_strategy={}",
            options.mode.as_str(),
            options.format,
            options.transport_format,
            options.autoplay,
            text.chars().count(),
            session_plan.session_strategy
        );

        if options.first_chunk_leading_silence_ms > 0 {
            println!(
                "[tts] realtime_mode_ignores_first_chunk_lead_in requested_ms={}",
                options.first_chunk_leading_silence_ms
            );
        }

        let mut socket = self.connect(&options.model).map_err(RealtimePipelineError::fallback)?;
        let mut realtime_sample_rate = REALTIME_SAMPLE_RATE;
        let startup_timeout = Duration::from_millis(REALTIME_STARTUP_TIMEOUT_MS);
        let response_timeout = Duration::from_millis(REALTIME_RESPONSE_TIMEOUT_MS);
        let emit_no_audio_progress = |detail: &str| {
            if let Some(progress_cb) = &progress {
                progress_cb(TtsProgress::RealtimeNoAudioReceived {
                    mode: options.mode.as_str().to_string(),
                    session_id: session_plan.session_id.clone(),
                    detail: detail.to_string(),
                });
            }
        };

        println!(
            "[tts] realtime_connect=start session_id={} model={} voice={}",
            session_plan.session_id, options.model, options.voice
        );

        loop {
            check_realtime_run_control(run_access.as_ref(), &mut socket)?;
            if started.elapsed() > startup_timeout {
                close_realtime_socket(&mut socket);
                eprintln!(
                    "[tts] realtime_connect=fail session_id={} detail=Timed out waiting for the initial realtime session handshake.",
                    session_plan.session_id
                );
                return Err(RealtimePipelineError::fallback(
                    "Timed out waiting for the initial realtime session handshake.",
                ));
            }

            match read_realtime_socket(&mut socket).map_err(RealtimePipelineError::fallback)? {
                RealtimeSocketRead::Event(event) => match event.get("type").and_then(Value::as_str)
                {
                    Some("session.created") => {
                        if let Some(rate) = realtime_output_sample_rate_from_event(&event) {
                            realtime_sample_rate = rate;
                        }
                        println!(
                            "[tts] realtime_connect=ok session_id={} sample_rate={}",
                            session_plan.session_id, realtime_sample_rate
                        );

                        if let Some(progress_cb) = &progress {
                            progress_cb(TtsProgress::RealtimeConnected {
                                mode: options.mode.as_str().to_string(),
                                model: options.model.clone(),
                                voice: options.voice.clone(),
                                session_id: session_plan.session_id.clone(),
                            });
                        }
                        break;
                    }
                    Some("error") => {
                        close_realtime_socket(&mut socket);
                        let message = extract_realtime_error_message(&event);
                        eprintln!(
                            "[tts] realtime_connect=fail session_id={} detail={}",
                            session_plan.session_id, message
                        );
                        return Err(RealtimePipelineError::fallback(format!(
                            "OpenAI Realtime session creation failed: {}",
                            message
                        )));
                    }
                    _ => {}
                },
                RealtimeSocketRead::Closed(reason) => {
                    let message = match reason {
                        Some(reason) => format!(
                            "OpenAI realtime websocket closed before session initialization: {reason}"
                        ),
                        None => "OpenAI realtime websocket closed before session initialization."
                            .to_string(),
                    };
                    eprintln!(
                        "[tts] realtime_connect=fail session_id={} detail={}",
                        session_plan.session_id, message
                    );
                    return Err(RealtimePipelineError::fallback(message));
                }
                RealtimeSocketRead::Timeout | RealtimeSocketRead::Ignored => {}
            }
        }

        if let Some(run_access) = &run_access {
            run_access.update_phase("tts_realtime_initializing");
        }

        println!(
            "[tts] realtime_session_update=start session_id={} sample_rate={}",
            session_plan.session_id, realtime_sample_rate
        );

        send_realtime_json_event(
            &mut socket,
            json!({
                "type": "session.update",
                "session": {
                    "model": options.model.as_str(),
                    "modalities": ["audio", "text"],
                    "output_audio_format": REALTIME_TRANSPORT_FORMAT,
                    "voice": options.voice.as_str(),
                    "instructions": "You are in strict verbatim read-aloud mode. Speak exactly the provided user text and nothing else. Do not answer the user. Do not summarize. Do not explain. Do not translate. Do not interpret. Do not paraphrase. Do not add introductions, conclusions, filler words, acknowledgements, comments, or extra sentences. Do not continue the conversation. Do not act like a helpful assistant. Read only the provided text as literally and as closely as possible.",
                }
            }),
        )
        .map_err(|error| {
            eprintln!(
                "[tts] realtime_session_update=fail session_id={} detail={}",
                session_plan.session_id, error
            );
            RealtimePipelineError::fallback(error)
        })?;

        let session_update_started = Instant::now();
        loop {
            check_realtime_run_control(run_access.as_ref(), &mut socket)?;
            if session_update_started.elapsed() > startup_timeout {
                close_realtime_socket(&mut socket);
                eprintln!(
                    "[tts] realtime_session_update=fail session_id={} detail=Timed out waiting for realtime session.update confirmation.",
                    session_plan.session_id
                );
                return Err(RealtimePipelineError::fallback(
                    "Timed out waiting for realtime session.update confirmation.",
                ));
            }

            match read_realtime_socket(&mut socket).map_err(RealtimePipelineError::fallback)? {
                RealtimeSocketRead::Event(event) => match event.get("type").and_then(Value::as_str)
                {
                    Some("session.updated") => {
                        if let Some(rate) = realtime_output_sample_rate_from_event(&event) {
                            realtime_sample_rate = rate;
                        }
                        println!(
                            "[tts] realtime_session_update=ok session_id={} sample_rate={}",
                            session_plan.session_id, realtime_sample_rate
                        );
                        if let Some(progress_cb) = &progress {
                            progress_cb(TtsProgress::RealtimeSessionUpdateSucceeded {
                                mode: options.mode.as_str().to_string(),
                                session_id: session_plan.session_id.clone(),
                            });
                        }
                        break;
                    }
                    Some("error") => {
                        close_realtime_socket(&mut socket);
                        let message = extract_realtime_error_message(&event);
                        eprintln!(
                            "[tts] realtime_session_update=fail session_id={} detail={}",
                            session_plan.session_id, message
                        );
                        return Err(RealtimePipelineError::fallback(format!(
                            "OpenAI Realtime session update failed: {}",
                            message
                        )));
                    }
                    _ => {}
                },
                RealtimeSocketRead::Closed(reason) => {
                    let message = match reason {
                        Some(reason) => format!(
                            "OpenAI realtime websocket closed during session initialization: {reason}"
                        ),
                        None => "OpenAI realtime websocket closed during session initialization."
                            .to_string(),
                    };
                    eprintln!(
                        "[tts] realtime_session_update=fail session_id={} detail={}",
                        session_plan.session_id, message
                    );
                    return Err(RealtimePipelineError::fallback(message));
                }
                RealtimeSocketRead::Timeout | RealtimeSocketRead::Ignored => {}
            }
        }

        send_realtime_json_event(
            &mut socket,
            json!({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": format!("Read the following text verbatim, exactly as written between the delimiters. Do not add any extra words before or after it.\nBEGIN_TEXT\n{}\nEND_TEXT", text),
                        }
                    ]
                }
            }),
        )
        .map_err(RealtimePipelineError::fallback)?;

        println!(
            "[tts] realtime_response_create=start session_id={} sample_rate={}",
            session_plan.session_id, realtime_sample_rate
        );

        send_realtime_json_event(
            &mut socket,
            json!({
                "type": "response.create",
                "response": {
                    "modalities": ["audio", "text"],
                    "output_audio_format": REALTIME_TRANSPORT_FORMAT,
                    "voice": options.voice.as_str(),
                }
            }),
        )
        .map_err(|error| {
            eprintln!(
                "[tts] realtime_response_create=fail session_id={} detail={}",
                session_plan.session_id, error
            );
            RealtimePipelineError::fallback(error)
        })?;

        println!(
            "[tts] realtime_response_create=ok session_id={} waiting_for_first_audio_delta=true",
            session_plan.session_id
        );

        if let Some(progress_cb) = &progress {
            progress_cb(TtsProgress::RealtimeResponseCreateSucceeded {
                mode: options.mode.as_str().to_string(),
                session_id: session_plan.session_id.clone(),
            });
        }

        if let Some(run_access) = &run_access {
            run_access.update_phase("tts_streaming_audio");
        }

        let playback_path = LivePlaybackPath::from_playback_speed(options.playback_speed);
        let initial_buffer_ms = playback_path.initial_buffer_ms(options.playback_speed);
        let stream_buffer_ms = playback_path.stream_buffer_ms(options.playback_speed);

        println!(
            "[tts] realtime_playback_path={} speed={} initial_buffer_ms={} stream_buffer_ms={}",
            playback_path.as_str(),
            options.playback_speed,
            initial_buffer_ms,
            stream_buffer_ms
        );

        let mut _stream = None;
        let mut sink = None;
        let mut naturalized_playback_state =
            NaturalizedLivePlaybackState::new(LIVE_NATURALIZED_OUTPUT_CROSSFADE_SAMPLES);
        let _sink_registration = SinkRegistrationGuard::new(run_access.as_ref());
        if options.autoplay {
            let (stream, stream_handle) = OutputStream::try_default().map_err(|err| {
                RealtimePipelineError::terminal(format!(
                    "Failed to open default audio output device: {err}"
                ))
            })?;
            let realtime_sink = Arc::new(Sink::try_new(&stream_handle).map_err(|err| {
                RealtimePipelineError::terminal(format!("Failed to create audio sink: {err}"))
            })?);

            if let Some(run_access) = &run_access {
                run_access
                    .register_sink(Arc::clone(&realtime_sink))
                    .map_err(RealtimePipelineError::terminal)?;
                run_access.update_phase("tts_playback_active");
            }

            _stream = Some(stream);
            sink = Some(realtime_sink);
        }

        let mut full_pcm_bytes = Vec::new();
        let mut pending_pcm_bytes = Vec::new();
        let mut first_audio_received_at_ms = None;
        let mut first_audio_playback_started_at_ms = None;
        let mut start_latency_ms = None;
        let mut response_done = false;
        let response_started = Instant::now();

        loop {
            check_realtime_run_control(run_access.as_ref(), &mut socket)?;

            if first_audio_received_at_ms.is_none() && response_started.elapsed() > response_timeout
            {
                close_realtime_socket(&mut socket);
                let detail = "Timed out waiting for realtime audio output after response.create.";
                eprintln!(
                    "[tts] realtime_first_audio_delta=fail session_id={} detail={}",
                    session_plan.session_id, detail
                );
                emit_no_audio_progress(detail);
                return Err(RealtimePipelineError::fallback(
                    "Timed out waiting for realtime audio output after response.create.",
                ));
            }

            match read_realtime_socket(&mut socket) {
                Ok(RealtimeSocketRead::Event(event)) => {
                    match event.get("type").and_then(Value::as_str) {
                        Some("response.output_audio.delta") | Some("response.audio.delta") => {
                            let delta =
                                event.get("delta").and_then(Value::as_str).ok_or_else(|| {
                                    let message =
                                    "Realtime audio delta event was missing its Base64 payload.";
                                    if first_audio_received_at_ms.is_none() {
                                        RealtimePipelineError::fallback(message)
                                    } else {
                                        RealtimePipelineError::terminal(message)
                                    }
                                })?;
                            let bytes = BASE64_STANDARD.decode(delta).map_err(|err| {
                                if first_audio_received_at_ms.is_none() {
                                    RealtimePipelineError::fallback(format!(
                                        "Failed to decode realtime audio delta: {err}"
                                    ))
                                } else {
                                    RealtimePipelineError::terminal(format!(
                                        "Failed to decode realtime audio delta: {err}"
                                    ))
                                }
                            })?;

                            if bytes.is_empty() {
                                continue;
                            }

                            if first_audio_received_at_ms.is_none() {
                                let at_ms = system_time_ms();
                                let latency_ms = millis_u64(started.elapsed());
                                first_audio_received_at_ms = Some(at_ms);
                                println!(
                                "[tts] realtime_first_audio_delta=ok session_id={} latency_ms={} bytes_received={}",
                                session_plan.session_id, latency_ms, bytes.len()
                            );

                                if let Some(progress_cb) = &progress {
                                    progress_cb(TtsProgress::FirstAudioReceived {
                                        mode: options.mode.as_str().to_string(),
                                        at_ms,
                                        latency_ms,
                                        bytes_received: bytes.len(),
                                    });
                                }
                            }

                            full_pcm_bytes.extend_from_slice(&bytes);
                            pending_pcm_bytes.extend_from_slice(&bytes);

                            if let Some(sink) = sink.as_ref() {
                                let threshold_bytes =
                                    if first_audio_playback_started_at_ms.is_some() {
                                        pcm_buffer_bytes(
                                            realtime_sample_rate,
                                            REALTIME_CHANNELS,
                                            REALTIME_BITS_PER_SAMPLE,
                                            stream_buffer_ms,
                                        )
                                    } else {
                                        pcm_buffer_bytes(
                                            realtime_sample_rate,
                                            REALTIME_CHANNELS,
                                            REALTIME_BITS_PER_SAMPLE,
                                            initial_buffer_ms,
                                        )
                                    };

                                if pending_pcm_bytes.len() >= threshold_bytes {
                                    match playback_path {
                                        LivePlaybackPath::FastDirect => append_pcm16_to_sink(
                                            sink,
                                            &mut pending_pcm_bytes,
                                            REALTIME_CHANNELS,
                                            realtime_sample_rate,
                                            &output_file_path,
                                            options.mode,
                                            started,
                                            progress.as_ref(),
                                            &mut first_audio_playback_started_at_ms,
                                            &mut start_latency_ms,
                                        ),
                                        LivePlaybackPath::NaturalizedSpeed => {
                                            append_naturalized_pcm16_to_sink(
                                                sink,
                                                &mut pending_pcm_bytes,
                                                REALTIME_CHANNELS,
                                                realtime_sample_rate,
                                                options.playback_speed,
                                                &mut naturalized_playback_state,
                                                false,
                                                &output_file_path,
                                                options.mode,
                                                started,
                                                progress.as_ref(),
                                                &mut first_audio_playback_started_at_ms,
                                                &mut start_latency_ms,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        Some("session.updated") => {
                            if let Some(rate) = realtime_output_sample_rate_from_event(&event) {
                                realtime_sample_rate = rate;
                            }
                        }
                        Some("response.done") => {
                            if let Some(status) = nested_value(&event, &["response", "status"])
                                .and_then(Value::as_str)
                            {
                                if !matches!(status, "completed" | "complete") {
                                    close_realtime_socket(&mut socket);
                                    let message = format!(
                                    "OpenAI Realtime response finished with status '{status}': {}",
                                    extract_realtime_error_message(&event)
                                );
                                    if first_audio_received_at_ms.is_none() {
                                        eprintln!(
                                        "[tts] realtime_first_audio_delta=fail session_id={} detail={}",
                                        session_plan.session_id, message
                                    );
                                        emit_no_audio_progress(&message);
                                    }
                                    return Err(if first_audio_received_at_ms.is_none() {
                                        RealtimePipelineError::fallback(message)
                                    } else {
                                        RealtimePipelineError::terminal(message)
                                    });
                                }
                            }
                            response_done = true;
                        }
                        Some("error") => {
                            close_realtime_socket(&mut socket);
                            let message = format!(
                                "OpenAI Realtime returned an error: {}",
                                extract_realtime_error_message(&event)
                            );
                            if first_audio_received_at_ms.is_none() {
                                eprintln!(
                                    "[tts] realtime_first_audio_delta=fail session_id={} detail={}",
                                    session_plan.session_id, message
                                );
                                emit_no_audio_progress(&message);
                            }
                            return Err(if first_audio_received_at_ms.is_none() {
                                RealtimePipelineError::fallback(message)
                            } else {
                                RealtimePipelineError::terminal(message)
                            });
                        }
                        _ => {}
                    }
                }
                Ok(RealtimeSocketRead::Closed(reason)) => {
                    if response_done || !full_pcm_bytes.is_empty() {
                        break;
                    }

                    let message = match reason {
                        Some(reason) => {
                            format!("OpenAI realtime websocket closed before any audio arrived: {reason}")
                        }
                        None => {
                            "OpenAI realtime websocket closed before any audio arrived.".to_string()
                        }
                    };
                    eprintln!(
                        "[tts] realtime_first_audio_delta=fail session_id={} detail={}",
                        session_plan.session_id, message
                    );
                    emit_no_audio_progress(&message);
                    return Err(RealtimePipelineError::fallback(message));
                }
                Ok(RealtimeSocketRead::Timeout) => {
                    if response_done {
                        break;
                    }
                }
                Ok(RealtimeSocketRead::Ignored) => {}
                Err(error) => {
                    close_realtime_socket(&mut socket);
                    if first_audio_received_at_ms.is_none() {
                        eprintln!(
                            "[tts] realtime_first_audio_delta=fail session_id={} detail={}",
                            session_plan.session_id, error
                        );
                        emit_no_audio_progress(&error);
                    }
                    return Err(if first_audio_received_at_ms.is_none() {
                        RealtimePipelineError::fallback(error)
                    } else {
                        RealtimePipelineError::terminal(error)
                    });
                }
            }
        }

        if full_pcm_bytes.is_empty() {
            close_realtime_socket(&mut socket);
            let detail = "OpenAI Realtime completed without returning any audio deltas.";
            eprintln!(
                "[tts] realtime_first_audio_delta=fail session_id={} detail={}",
                session_plan.session_id, detail
            );
            emit_no_audio_progress(detail);
            return Err(RealtimePipelineError::fallback(
                "OpenAI Realtime completed without returning any audio deltas.",
            ));
        }

        if let Some(sink) = sink.as_ref() {
            match playback_path {
                LivePlaybackPath::FastDirect => append_pcm16_to_sink(
                    sink,
                    &mut pending_pcm_bytes,
                    REALTIME_CHANNELS,
                    realtime_sample_rate,
                    &output_file_path,
                    options.mode,
                    started,
                    progress.as_ref(),
                    &mut first_audio_playback_started_at_ms,
                    &mut start_latency_ms,
                ),
                LivePlaybackPath::NaturalizedSpeed => {
                    append_naturalized_pcm16_to_sink(
                        sink,
                        &mut pending_pcm_bytes,
                        REALTIME_CHANNELS,
                        realtime_sample_rate,
                        options.playback_speed,
                        &mut naturalized_playback_state,
                        true,
                        &output_file_path,
                        options.mode,
                        started,
                        progress.as_ref(),
                        &mut first_audio_playback_started_at_ms,
                        &mut start_latency_ms,
                    );

                    append_pcm_samples_to_sink(
                        sink,
                        naturalized_playback_state.take_pending_output_tail(),
                        REALTIME_CHANNELS,
                        realtime_sample_rate,
                        &output_file_path,
                        options.mode,
                        started,
                        progress.as_ref(),
                        &mut first_audio_playback_started_at_ms,
                        &mut start_latency_ms,
                    );
                }
            }

            wait_for_sink_to_finish(sink, run_access.as_ref())
                .map_err(RealtimePipelineError::terminal)?;

            if let Some(progress_cb) = &progress {
                progress_cb(TtsProgress::ChunkPlaybackFinished {
                    index: 0,
                    total: 1,
                    elapsed_ms: started.elapsed().as_millis(),
                });
            }
        }

        let wav_bytes = wrap_pcm_as_wav(
            &full_pcm_bytes,
            realtime_sample_rate,
            REALTIME_CHANNELS,
            REALTIME_BITS_PER_SAMPLE,
        );
        fs::write(&output_file, &wav_bytes).map_err(|err| {
            RealtimePipelineError::terminal(format!("Failed to write realtime audio file: {err}"))
        })?;

        close_realtime_socket(&mut socket);

        println!(
            "[tts] pipeline_done mode={} produced_chunks=1 bytes_written={} first_audio_received_at_ms={:?} first_audio_playback_started_at_ms={:?} start_latency_ms={:?} total_ms={}",
            options.mode.as_str(),
            wav_bytes.len(),
            first_audio_received_at_ms,
            first_audio_playback_started_at_ms,
            start_latency_ms,
            started.elapsed().as_millis()
        );

        Ok(SpeakTextResult {
            file_path: output_file_path,
            output_directory: output_directory.to_string_lossy().to_string(),
            bytes_written: wav_bytes.len(),
            chunk_count: 1,
            voice: options.voice,
            model: options.model,
            mode: session_plan.mode_label().to_string(),
            requested_mode: session_plan.requested_mode.as_str().to_string(),
            session_id: session_plan.session_id.clone(),
            session_strategy: session_plan.session_strategy.clone(),
            fallback_reason: session_plan.fallback_reason.clone(),
            supports_persistent_session: session_plan.supports_persistent_session,
            format: options.format,
            transport_format: options.transport_format,
            autoplay: options.autoplay,
            first_audio_received_at_ms,
            first_audio_playback_started_at_ms,
            start_latency_ms,
        })
    }
}

fn millis_u64(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

fn system_time_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(millis_u64).unwrap_or(0)
}

pub fn speak_text(
    options: SpeakTextOptions,
    settings: &AppSettings,
) -> Result<SpeakTextResult, String> {
    speak_text_with_progress(options, settings, None)
}

pub fn speak_text_with_progress(
    options: SpeakTextOptions,
    settings: &AppSettings,
    progress: Option<ProgressCallback>,
) -> Result<SpeakTextResult, String> {
    speak_text_with_progress_and_control(options, settings, progress, None)
}

pub fn speak_text_with_progress_and_control(
    options: SpeakTextOptions,
    settings: &AppSettings,
    progress: Option<ProgressCallback>,
    run_access: Option<RunAccess>,
) -> Result<SpeakTextResult, String> {
    let text = options.text.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Err("No text provided for speech synthesis".into());
    }

    let api_key = resolve_openai_api_key(settings)?;
    let requested_mode =
        resolve_tts_mode(options.mode.or_else(|| Some(DEFAULT_TTS_MODE.to_string())));
    let session_plan = build_session_plan(requested_mode);
    let requested_format =
        resolve_format(options.format.or_else(|| Some(DEFAULT_FORMAT.to_string())))?;
    let explicit_model = options.model;
    let voice = options.voice.unwrap_or_else(|| DEFAULT_VOICE.to_string());
    let autoplay = options.autoplay.unwrap_or(true);
    let max_chunk_chars = resolve_max_chunk_chars(options.max_chunk_chars);
    let max_parallel_requests = resolve_parallel_requests(options.max_parallel_requests);
    let first_chunk_leading_silence_ms = options.first_chunk_leading_silence_ms.unwrap_or(0);
    let playback_speed = settings.playback_speed;

    let build_resolved =
        |mode: TtsMode, model: String, format: String, transport_format: String| {
            ResolvedSpeakOptions {
                voice: voice.clone(),
                model,
                mode,
                format,
                transport_format,
                autoplay,
                max_chunk_chars,
                max_parallel_requests,
                first_chunk_leading_silence_ms,
                playback_speed,
            }
        };

    match requested_mode {
        TtsMode::Classic => {
            let resolved = build_resolved(
                TtsMode::Classic,
                explicit_model
                    .clone()
                    .unwrap_or_else(|| default_model_for_mode(TtsMode::Classic).to_string()),
                requested_format.clone(),
                requested_format.clone(),
            );
            let provider = OpenAiSpeechProvider::new(api_key);
            let pipeline =
                ChunkedSpeechPipeline::new(provider, TextChunker::new(resolved.max_chunk_chars));
            pipeline.run(&text, resolved, &session_plan, progress, run_access)
        }
        TtsMode::Live => {
            let resolved = build_resolved(
                TtsMode::Live,
                explicit_model
                    .clone()
                    .unwrap_or_else(|| default_model_for_mode(TtsMode::Live).to_string()),
                "wav".to_string(),
                LIVE_TRANSPORT_FORMAT.to_string(),
            );
            let pipeline = LiveSpeechPipeline::new(api_key)?;
            pipeline.run(&text, resolved, &session_plan, progress, run_access)
        }
        TtsMode::RealtimeExperimental => {
            let realtime_resolved = build_resolved(
                TtsMode::RealtimeExperimental,
                explicit_model.clone().unwrap_or_else(|| {
                    default_model_for_mode(TtsMode::RealtimeExperimental).to_string()
                }),
                "wav".to_string(),
                REALTIME_TRANSPORT_FORMAT.to_string(),
            );
            let realtime_pipeline = RealtimeSpeechPipeline::new(api_key.clone());
            match realtime_pipeline.run(
                &text,
                realtime_resolved,
                &session_plan,
                progress.clone(),
                run_access.clone(),
            ) {
                Ok(result) => Ok(result),
                Err(error) if error.can_fallback_to_live => Err(error.message),
                Err(error) => Err(error.message),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_session_plan, crossfade_live_output_chunks, naturalized_live_buffer_ms,
        resolve_fallback_live_model, resolve_tts_mode, split_into_sentences, time_stretch_samples,
        wrap_pcm_as_wav, LivePlaybackPath, TextChunker, TtsMode, DEFAULT_MODEL,
        LIVE_INITIAL_BUFFER_MS, LIVE_NATURALIZED_INITIAL_BUFFER_MS, TIME_STRETCH_FRAME_SIZE,
    };

    #[test]
    fn keeps_short_text_in_one_chunk() {
        let chunks = TextChunker::new(280).split("Hello world. This still fits.");
        assert_eq!(chunks, vec!["Hello world. This still fits."]);
    }

    #[test]
    fn prefers_sentence_boundaries() {
        let chunks = TextChunker::new(24).split("First sentence. Second one. Third one.");
        assert_eq!(chunks, vec!["First sentence.", "Second one. Third one."]);
    }

    #[test]
    fn falls_back_to_word_wrapping_for_long_sentences() {
        let chunks = TextChunker::new(30)
            .split("First sentence. Second sentence is a bit longer than the limit. Third one.");

        assert_eq!(
            chunks,
            vec![
                "First sentence.",
                "Second sentence is a bit",
                "longer than the limit.",
                "Third one."
            ]
        );
    }

    #[test]
    fn splits_double_newlines_into_separate_segments() {
        let sentences = split_into_sentences("Title\n\nBody starts here.");
        assert_eq!(sentences, vec!["Title", "Body starts here."]);
    }

    #[test]
    fn resolves_live_mode_aliases() {
        assert_eq!(resolve_tts_mode(Some("live".to_string())), TtsMode::Live);
        assert_eq!(resolve_tts_mode(Some("low-latency".to_string())), TtsMode::Live);
        assert_eq!(resolve_tts_mode(Some("realtime".to_string())), TtsMode::RealtimeExperimental);
        assert_eq!(resolve_tts_mode(Some("classic".to_string())), TtsMode::Classic);
    }

    #[test]
    fn realtime_session_plan_only_falls_back_at_runtime() {
        let plan = build_session_plan(TtsMode::RealtimeExperimental);
        assert_eq!(plan.resolved_mode, TtsMode::RealtimeExperimental);

        let fallback = plan.fallback_to_live("realtime failed");
        assert_eq!(fallback.requested_mode, TtsMode::RealtimeExperimental);
        assert_eq!(fallback.resolved_mode, TtsMode::Live);
        assert!(fallback.fallback_reason.is_some());
    }

    #[test]
    fn realtime_model_names_use_live_default_for_fallback() {
        assert_eq!(resolve_fallback_live_model(Some("gpt-realtime-1.5")), DEFAULT_MODEL);
        assert_eq!(resolve_fallback_live_model(Some("gpt-4o-mini-tts")), "gpt-4o-mini-tts");
    }

    #[test]
    fn wraps_pcm_bytes_as_wav() {
        let wav = wrap_pcm_as_wav(&[0, 0, 1, 0], 24_000, 1, 16);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(wav.len(), 48);
    }

    #[test]
    fn live_playback_path_stays_fast_at_default_speed() {
        assert_eq!(LivePlaybackPath::from_playback_speed(1.0), LivePlaybackPath::FastDirect);
        assert_eq!(LivePlaybackPath::FastDirect.initial_buffer_ms(1.0), LIVE_INITIAL_BUFFER_MS);
    }

    #[test]
    fn live_playback_path_uses_naturalized_buffering_for_speed_changes() {
        assert_eq!(LivePlaybackPath::from_playback_speed(1.3), LivePlaybackPath::NaturalizedSpeed);
        assert!(
            naturalized_live_buffer_ms(LIVE_NATURALIZED_INITIAL_BUFFER_MS, 1.6)
                > LIVE_NATURALIZED_INITIAL_BUFFER_MS
        );
    }

    #[test]
    fn crossfades_live_output_batches() {
        let previous = vec![1.0; 8];
        let next = vec![0.0; 8];
        let merged = crossfade_live_output_chunks(&previous, &next);

        assert_eq!(merged.len(), 8);
        assert!((merged[0] - 1.0).abs() < 0.001);
        assert!(merged[3] < 1.0);
        assert!(merged[3] > 0.0);
        assert!(merged[7].abs() < 0.001);
    }

    #[test]
    fn time_stretch_shortens_audio_when_speeding_up() {
        let input: Vec<f32> =
            (0..TIME_STRETCH_FRAME_SIZE * 6).map(|index| ((index as f32) * 0.01).sin()).collect();

        let output = time_stretch_samples(&input, 1, 1.5);

        assert!(output.len() < input.len());
        assert!(output.len() > input.len() / 3);
    }

    #[test]
    fn time_stretch_lengthens_audio_when_slowing_down() {
        let input: Vec<f32> =
            (0..TIME_STRETCH_FRAME_SIZE * 6).map(|index| ((index as f32) * 0.01).sin()).collect();

        let output = time_stretch_samples(&input, 1, 0.75);

        assert!(output.len() > input.len());
    }
}
