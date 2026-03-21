use crate::{run_controller::{is_cancelled_error, RunAccess}, settings::AppSettings};
use rodio::{Decoder, OutputStream, Sink};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    io::BufReader,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DEFAULT_MODEL: &str = "gpt-4o-mini-tts";
const DEFAULT_VOICE: &str = "alloy";
const DEFAULT_FORMAT: &str = "wav";
const DEFAULT_MAX_CHUNK_CHARS: usize = 280;
const DEFAULT_MAX_PARALLEL_REQUESTS: usize = 3;
const MAX_PARALLEL_REQUESTS_LIMIT: usize = 4;
const MIN_CHUNK_CHARS: usize = 120;
const MAX_CHUNK_CHARS: usize = 1_200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakTextOptions {
    pub text: Option<String>,
    pub voice: Option<String>,
    pub model: Option<String>,
    pub format: Option<String>,
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
    pub format: String,
    pub autoplay: bool,
}

#[derive(Debug, Clone)]
pub enum TtsProgress {
    PipelineStarted {
        chunk_count: usize,
        format: String,
        autoplay: bool,
        max_parallel_requests: usize,
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

#[derive(Clone)]
struct ResolvedSpeakOptions {
    voice: String,
    model: String,
    format: String,
    autoplay: bool,
    max_chunk_chars: usize,
    max_parallel_requests: usize,
    first_chunk_leading_silence_ms: u32,
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
}

enum PipelineMessage {
    ChunkReady(GeneratedChunk),
    Failed(String),
}

trait SpeechProvider: Send + Sync + Clone + 'static {
    fn synthesize_chunk(
        &self,
        options: &ResolvedSpeakOptions,
        chunk: &ChunkJob,
        total_chunks: usize,
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
        Self {
            api_key,
            client: reqwest::blocking::Client::new(),
        }
    }
}

impl SpeechProvider for OpenAiSpeechProvider {
    fn synthesize_chunk(
        &self,
        options: &ResolvedSpeakOptions,
        chunk: &ChunkJob,
        total_chunks: usize,
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

        let bytes = response
            .bytes()
            .map_err(|err| format!("Failed to read audio response: {err}"))?;

        let response_elapsed_ms = request_started.elapsed().as_millis();
        if let Some(progress) = progress {
            progress(TtsProgress::ChunkRequestFinished {
                index: chunk.index,
                total: total_chunks,
                bytes_received: bytes.len(),
                elapsed_ms: response_elapsed_ms,
            });
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
        })
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
        progress: Option<ProgressCallback>,
        run_access: Option<RunAccess>,
    ) -> Result<SpeakTextResult, String> {
        let started = Instant::now();
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
                chunk_count: chunks.len(),
                format: options.format.clone(),
                autoplay: options.autoplay,
                max_parallel_requests: options.max_parallel_requests,
            });
        }

        println!(
            "[tts] pipeline_start format={} autoplay={} planned_chunks={} max_parallel_requests={} text_chars={}",
            options.format,
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
            options.autoplay,
            options.first_chunk_leading_silence_ms,
            progress.clone(),
            run_access.clone(),
        );
        let ordered_chunks = match playback_result {
            Ok(ordered_chunks) => ordered_chunks,
            Err(error) if is_cancelled_error(&error) => {
                println!(
                    "[tts] pipeline_cancelled planned_chunks={} total_ms={}",
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
        if let Err(error) = join_result {
            return Err(error);
        }
        let first_chunk = ordered_chunks
            .first()
            .ok_or_else(|| "No audio chunks were produced.".to_string())?;

        println!(
            "[tts] pipeline_done planned_chunks={} produced_chunks={} bytes_written={} total_ms={}",
            expected_chunks,
            ordered_chunks.len(),
            ordered_chunks.iter().map(|chunk| chunk.bytes_written).sum::<usize>(),
            started.elapsed().as_millis()
        );

        Ok(SpeakTextResult {
            file_path: first_chunk.file_path.clone(),
            output_directory: output_directory.to_string_lossy().to_string(),
            bytes_written: ordered_chunks.iter().map(|chunk| chunk.bytes_written).sum(),
            chunk_count: ordered_chunks.len(),
            voice: options.voice,
            model: options.model,
            format: options.format,
            autoplay: options.autoplay,
        })
    }

    fn collect_and_play_ordered_chunks(
        &self,
        receiver: mpsc::Receiver<PipelineMessage>,
        expected_chunks: usize,
        autoplay: bool,
        first_chunk_leading_silence_ms: u32,
        progress: Option<ProgressCallback>,
        run_access: Option<RunAccess>,
    ) -> Result<Vec<GeneratedChunk>, String> {
        let mut buffered = HashMap::<usize, GeneratedChunk>::new();
        let mut ordered = Vec::with_capacity(expected_chunks);
        let mut next_index = 0usize;

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
                    progress.as_ref(),
                    run_access.as_ref(),
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
                            progress.as_ref(),
                            run_access.as_ref(),
                        )?;
                        ordered.push(chunk);
                        next_index += 1;

                        while let Some(buffered_chunk) = buffered.remove(&next_index) {
                            self.play_chunk_if_needed(
                                &buffered_chunk,
                                expected_chunks,
                                autoplay,
                                first_chunk_leading_silence_ms,
                                progress.as_ref(),
                                run_access.as_ref(),
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

        Ok(ordered)
    }

    fn play_chunk_if_needed(
        &self,
        chunk: &GeneratedChunk,
        total_chunks: usize,
        autoplay: bool,
        first_chunk_leading_silence_ms: u32,
        progress: Option<&ProgressCallback>,
        run_access: Option<&RunAccess>,
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
            let leading_silence_ms = if chunk.index == 0 {
                first_chunk_leading_silence_ms
            } else {
                0
            };
            play_audio(&chunk.file_path, leading_silence_ms, run_access)?;
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

fn normalize_audio_bytes(bytes: Vec<u8>, options: &ResolvedSpeakOptions) -> Result<Vec<u8>, String> {
    if options.format != "wav" {
        return Ok(bytes);
    }

    normalize_openai_wav_header(bytes)
}

fn normalize_openai_wav_header(mut bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Expected a WAV payload, but received an unsupported audio file header.".to_string());
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

fn load_env_file_if_present() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let env_path = manifest_dir.parent().map(|p| p.join(".env"));

    if let Some(path) = env_path {
        if let Ok(contents) = fs::read_to_string(path) {
            for line in contents.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = trimmed.split_once('=') {
                    if env::var_os(key.trim()).is_none() {
                        let clean = value.trim().trim_matches('"').trim_matches('\'');
                        env::set_var(key.trim(), clean);
                    }
                }
            }
        }
    }
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

fn resolve_format(format: Option<String>) -> Result<String, String> {
    let value = format
        .unwrap_or_else(|| DEFAULT_FORMAT.to_string())
        .trim()
        .to_lowercase();

    match value.as_str() {
        "mp3" | "wav" => Ok(value),
        _ => Err(format!(
            "Unsupported audio format '{value}'. Use 'mp3' or 'wav'."
        )),
    }
}

fn resolve_parallel_requests(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_MAX_PARALLEL_REQUESTS)
        .clamp(1, MAX_PARALLEL_REQUESTS_LIMIT)
}

fn resolve_max_chunk_chars(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_MAX_CHUNK_CHARS)
        .clamp(MIN_CHUNK_CHARS, MAX_CHUNK_CHARS)
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

fn sleep_with_run_control(duration: Duration, run_access: Option<&RunAccess>) -> Result<(), String> {
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

fn play_audio(file_path: &str, leading_silence_ms: u32, run_access: Option<&RunAccess>) -> Result<(), String> {
    if let Some(run_access) = run_access {
        run_access.check_cancelled()?;
        run_access.update_phase("tts_loading_audio");
    }

    let file = fs::File::open(file_path)
        .map_err(|err| format!("Failed to open audio file for playback: {err}"))?;
    let reader = BufReader::new(file);
    let source = Decoder::new(reader)
        .map_err(|err| format!("Failed to decode audio file '{file_path}': {err}"))?;

    let (stream, stream_handle) = OutputStream::try_default()
        .map_err(|err| format!("Failed to open default audio output device: {err}"))?;
    let sink = Arc::new(
        Sink::try_new(&stream_handle).map_err(|err| format!("Failed to create audio sink: {err}"))?,
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

    sink.append(source);

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

pub fn speak_text(options: SpeakTextOptions, settings: &AppSettings) -> Result<SpeakTextResult, String> {
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
    load_env_file_if_present();

    let text = options.text.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Err("No text provided for speech synthesis".into());
    }

    let api_key = env::var("OPENAI_API_KEY")
        .map_err(|_| "OPENAI_API_KEY is missing. Add it to the project's .env file.".to_string())?;

    let resolved = ResolvedSpeakOptions {
        voice: options.voice.unwrap_or_else(|| DEFAULT_VOICE.to_string()),
        model: options.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        format: resolve_format(options.format.or_else(|| Some(settings.tts_format.clone())))?,
        autoplay: options.autoplay.unwrap_or(true),
        max_chunk_chars: resolve_max_chunk_chars(options.max_chunk_chars),
        max_parallel_requests: resolve_parallel_requests(options.max_parallel_requests),
        first_chunk_leading_silence_ms: options
            .first_chunk_leading_silence_ms
            .unwrap_or(settings.first_chunk_leading_silence_ms),
    };

    let provider = OpenAiSpeechProvider::new(api_key);
    let pipeline = ChunkedSpeechPipeline::new(provider, TextChunker::new(resolved.max_chunk_chars));

    pipeline.run(&text, resolved, progress, run_access)
}

#[cfg(test)]
mod tests {
    use super::{split_into_sentences, TextChunker};

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
        let chunks =
            TextChunker::new(30).split("First sentence. Second sentence is a bit longer than the limit. Third one.");

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
}
