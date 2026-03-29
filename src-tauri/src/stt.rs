use crate::settings::{resolve_openai_api_key, AppSettings};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    io::Write,
    net::TcpStream,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{
    client::IntoClientRequest,
    http::HeaderValue,
    stream::MaybeTlsStream,
    Message as WsMessage,
    WebSocket,
};

type RealtimeSocket = WebSocket<MaybeTlsStream<TcpStream>>;

const DEFAULT_OPENAI_TRANSCRIBE_MODEL: &str = "gpt-4o-transcribe";
const DEFAULT_LOCAL_WHISPER_MODEL: &str = "base";
const DEFAULT_LANGUAGE: &str = "de";
const REALTIME_EVENT_TIMEOUT_MS: u64 = 80;
const REALTIME_CONNECT_TIMEOUT_MS: u64 = 4_000;

#[derive(Default)]
pub struct SttState {
    realtime: Mutex<Option<RealtimeTranscriptionSession>>,
}

struct RealtimeTranscriptionSession {
    socket: RealtimeSocket,
    session_id: String,
    started_at: Instant,
    partial_transcripts: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SttDebugEntry {
    pub provider: String,
    pub transcript: String,
    pub latency_ms: u64,
    pub ok: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRealtimeTranscriptionOptions {
    pub model: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeTranscriptionSessionInfo {
    pub provider: String,
    pub session_id: String,
    pub model: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeAudioChunkOptions {
    pub audio_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeTranscriptEvent {
    pub provider: String,
    pub kind: String,
    pub text: String,
    pub latency_ms: Option<u64>,
    pub detail: Option<String>,
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSttChunkOptions {
    pub audio_base64: String,
    pub language: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSttChunkResult {
    pub provider: String,
    pub transcript: String,
    pub latency_ms: u64,
    pub ok: bool,
    pub detail: Option<String>,
    pub audio_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendSttDebugLogOptions {
    pub session_id: String,
    pub selected_provider: String,
    pub active_transcript: String,
    pub entries: Vec<SttDebugEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendSttDebugLogResult {
    pub debug_log_path: String,
}

pub fn start_openai_realtime_transcription(
    options: Option<StartRealtimeTranscriptionOptions>,
    settings: &AppSettings,
    state: &SttState,
) -> Result<RealtimeTranscriptionSessionInfo, String> {
    stop_openai_realtime_transcription(state)?;

    let options = options.unwrap_or(StartRealtimeTranscriptionOptions {
        model: None,
        language: None,
    });
    let api_key = resolve_openai_api_key(settings)?;
    let model = options
        .model
        .unwrap_or_else(|| DEFAULT_OPENAI_TRANSCRIBE_MODEL.to_string());
    let language = normalize_language(options.language.as_deref());
    let session_id = format!("stt-realtime-{}", system_time_ms());
    let mut socket = connect_realtime_transcription(&api_key)?;

    send_realtime_json(
        &mut socket,
        json!({
            "type": "transcription_session.update",
            "session": {
                "input_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": model,
                    "language": language,
                    "prompt": "Return a clean readable transcript with punctuation."
                },
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 500
                },
                "input_audio_noise_reduction": {
                    "type": "near_field"
                }
            }
        }),
    )?;

    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_millis(REALTIME_CONNECT_TIMEOUT_MS) {
            break;
        }

        match read_realtime_socket(&mut socket)? {
            RealtimeSocketRead::Event(event) => {
                let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();
                if matches!(
                    event_type,
                    "session.created"
                        | "session.updated"
                        | "transcription_session.created"
                        | "transcription_session.updated"
                ) {
                    break;
                }
                if event_type == "error" {
                    return Err(extract_realtime_error_message(&event));
                }
            }
            RealtimeSocketRead::Timeout | RealtimeSocketRead::Ignored => {}
            RealtimeSocketRead::Closed(reason) => {
                return Err(reason.unwrap_or_else(|| {
                    "OpenAI realtime transcription websocket closed during startup.".to_string()
                }))
            }
        }
    }

    let mut guard = state.realtime.lock().expect("stt realtime session poisoned");
    *guard = Some(RealtimeTranscriptionSession {
        socket,
        session_id: session_id.clone(),
        started_at: Instant::now(),
        partial_transcripts: HashMap::new(),
    });

    Ok(RealtimeTranscriptionSessionInfo {
        provider: "openai_online".to_string(),
        session_id,
        model,
        language,
    })
}

pub fn append_openai_realtime_audio(
    options: RealtimeAudioChunkOptions,
    state: &SttState,
) -> Result<Vec<RealtimeTranscriptEvent>, String> {
    let mut guard = state.realtime.lock().expect("stt realtime session poisoned");
    let session = guard
        .as_mut()
        .ok_or_else(|| "No active OpenAI realtime transcription session.".to_string())?;

    send_realtime_json(
        &mut session.socket,
        json!({
            "type": "input_audio_buffer.append",
            "audio": strip_data_url_prefix(&options.audio_base64)
        }),
    )?;

    collect_realtime_events(session)
}

pub fn poll_openai_realtime_transcription(
    state: &SttState,
) -> Result<Vec<RealtimeTranscriptEvent>, String> {
    let mut guard = state.realtime.lock().expect("stt realtime session poisoned");
    let Some(session) = guard.as_mut() else {
        return Ok(Vec::new());
    };

    collect_realtime_events(session)
}

pub fn stop_openai_realtime_transcription(
    state: &SttState,
) -> Result<Vec<RealtimeTranscriptEvent>, String> {
    let mut guard = state.realtime.lock().expect("stt realtime session poisoned");
    let Some(mut session) = guard.take() else {
        return Ok(Vec::new());
    };

    let _ = send_realtime_json(&mut session.socket, json!({ "type": "input_audio_buffer.commit" }));
    let final_events = collect_realtime_events(&mut session).unwrap_or_default();
    let _ = session.socket.close(None);
    Ok(final_events)
}

pub fn transcribe_wav_chunk_local(options: LocalSttChunkOptions) -> Result<LocalSttChunkResult, String> {
    let started = Instant::now();
    let audio_bytes = decode_base64_audio(&options.audio_base64)?;
    let chunk_path = write_temp_audio_chunk(&audio_bytes)?;
    let language = normalize_language(options.language.as_deref()).unwrap_or_else(|| DEFAULT_LANGUAGE.to_string());
    let model = options
        .model
        .unwrap_or_else(|| DEFAULT_LOCAL_WHISPER_MODEL.to_string());

    let whisper_python = resolve_local_whisper_python();
    let output = std::process::Command::new(&whisper_python)
        .args([
            "-m",
            "whisper",
            &chunk_path.to_string_lossy(),
            "--model",
            &model,
            "--language",
            &language,
            "--task",
            "transcribe",
            "--fp16",
            "False",
            "--output_format",
            "txt",
            "--output_dir",
            &chunk_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_string_lossy(),
        ])
        .output()
        .map_err(|err| format!("Failed to start local Whisper CLI via '{}': {err}", whisper_python.display()))?;

    let latency_ms = millis_u64(started.elapsed());
    let transcript_path = chunk_path.with_extension("txt");
    let transcript = fs::read_to_string(&transcript_path)
        .unwrap_or_default()
        .trim()
        .to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    Ok(LocalSttChunkResult {
        provider: "openai_whisper_local".to_string(),
        transcript: transcript.clone(),
        latency_ms,
        ok: output.status.success() && !transcript.is_empty(),
        detail: if output.status.success() {
            if transcript.is_empty() {
                Some("Local Whisper finished but returned no text.".to_string())
            } else {
                None
            }
        } else if stderr.contains("No module named whisper") {
            Some(format!(
                "Local Whisper is not installed for '{}'. Create/install the project-local .venv-whisper or install openai-whisper there.",
                whisper_python.display()
            ))
        } else if stderr.is_empty() {
            Some(format!("Local Whisper failed with status {}", output.status))
        } else {
            Some(stderr)
        },
        audio_path: chunk_path.to_string_lossy().to_string(),
    })
}

pub fn append_stt_debug_log(options: AppendSttDebugLogOptions) -> Result<AppendSttDebugLogResult, String> {
    let path = debug_log_path_for_session(&options.session_id)?;
    let payload = json!({
        "timestampMs": system_time_ms(),
        "selectedProvider": options.selected_provider,
        "activeTranscript": options.active_transcript,
        "entries": options.entries,
    });

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("Failed to open STT debug log '{}': {err}", path.display()))?;
    writeln!(file, "{}", payload)
        .map_err(|err| format!("Failed to append STT debug log '{}': {err}", path.display()))?;

    Ok(AppendSttDebugLogResult {
        debug_log_path: path.to_string_lossy().to_string(),
    })
}

fn collect_realtime_events(
    session: &mut RealtimeTranscriptionSession,
) -> Result<Vec<RealtimeTranscriptEvent>, String> {
    let mut events = Vec::new();

    loop {
        match read_realtime_socket(&mut session.socket)? {
            RealtimeSocketRead::Event(event) => {
                let parsed = parse_realtime_event(
                    &event,
                    &mut session.partial_transcripts,
                    session.started_at,
                );
                events.extend(parsed);
            }
            RealtimeSocketRead::Timeout | RealtimeSocketRead::Ignored => break,
            RealtimeSocketRead::Closed(reason) => {
                events.push(RealtimeTranscriptEvent {
                    provider: "openai_online".to_string(),
                    kind: "status".to_string(),
                    text: String::new(),
                    latency_ms: Some(millis_u64(session.started_at.elapsed())),
                    detail: Some(reason.unwrap_or_else(|| {
                        "OpenAI realtime transcription websocket closed.".to_string()
                    })),
                    item_id: Some(session.session_id.clone()),
                });
                break;
            }
        }
    }

    Ok(events)
}

fn parse_realtime_event(
    event: &Value,
    partials: &mut HashMap<String, String>,
    started_at: Instant,
) -> Vec<RealtimeTranscriptEvent> {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();
    let latency_ms = Some(millis_u64(started_at.elapsed()));
    let item_id = event
        .get("item_id")
        .and_then(Value::as_str)
        .or_else(|| event.get("segment_id").and_then(Value::as_str))
        .or_else(|| event.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned);

    match event_type {
        "transcript.text.delta" | "conversation.item.input_audio_transcription.delta" => {
            let delta = extract_text_field(event, &["delta", "text", "transcript"]);
            let mut transcript = delta.clone();
            if let Some(id) = item_id.as_deref() {
                let entry = partials.entry(id.to_string()).or_default();
                entry.push_str(&delta);
                transcript = entry.clone();
            }
            vec![RealtimeTranscriptEvent {
                provider: "openai_online".to_string(),
                kind: "delta".to_string(),
                text: transcript,
                latency_ms,
                detail: None,
                item_id,
            }]
        }
        "transcript.text.done" | "conversation.item.input_audio_transcription.completed" => {
            let text = extract_text_field(event, &["text", "transcript", "delta"]);
            let transcript = if let Some(id) = item_id.as_deref() {
                let buffered = partials.remove(id).unwrap_or_default();
                if !text.trim().is_empty() { text } else { buffered }
            } else {
                text
            };
            vec![RealtimeTranscriptEvent {
                provider: "openai_online".to_string(),
                kind: "final".to_string(),
                text: transcript,
                latency_ms,
                detail: None,
                item_id,
            }]
        }
        "input_audio_buffer.speech_started"
        | "input_audio_buffer.speech_stopped"
        | "input_audio_buffer.committed"
        | "session.created"
        | "session.updated"
        | "transcription_session.created"
        | "transcription_session.updated" => vec![RealtimeTranscriptEvent {
            provider: "openai_online".to_string(),
            kind: "status".to_string(),
            text: String::new(),
            latency_ms,
            detail: Some(event_type.to_string()),
            item_id,
        }],
        "error" => vec![RealtimeTranscriptEvent {
            provider: "openai_online".to_string(),
            kind: "error".to_string(),
            text: String::new(),
            latency_ms,
            detail: Some(extract_realtime_error_message(event)),
            item_id,
        }],
        _ => Vec::new(),
    }
}

enum RealtimeSocketRead {
    Event(Value),
    Timeout,
    Ignored,
    Closed(Option<String>),
}

fn connect_realtime_transcription(api_key: &str) -> Result<RealtimeSocket, String> {
    let mut request = "wss://api.openai.com/v1/realtime?intent=transcription"
        .into_client_request()
        .map_err(|err| format!("Failed to build realtime transcription websocket request: {err}"))?;
    let bearer = format!("Bearer {api_key}");
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&bearer)
            .map_err(|err| format!("Failed to build realtime auth header: {err}"))?,
    );
    request
        .headers_mut()
        .insert("OpenAI-Beta", HeaderValue::from_static("realtime=v1"));

    let (mut socket, _) = tungstenite::connect(request)
        .map_err(|err| format!("OpenAI realtime transcription connection failed: {err}"))?;
    configure_realtime_socket(&mut socket)?;
    Ok(socket)
}

fn configure_realtime_socket(socket: &mut RealtimeSocket) -> Result<(), String> {
    let timeout = Some(Duration::from_millis(REALTIME_EVENT_TIMEOUT_MS));
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream.set_read_timeout(timeout),
        MaybeTlsStream::Rustls(stream) => stream.get_mut().set_read_timeout(timeout),
        _ => Ok(()),
    }
    .map_err(|err| format!("Failed to configure realtime transcription websocket timeout: {err}"))
}

fn read_realtime_socket(socket: &mut RealtimeSocket) -> Result<RealtimeSocketRead, String> {
    match socket.read() {
        Ok(WsMessage::Text(text)) => serde_json::from_str::<Value>(text.as_ref())
            .map(RealtimeSocketRead::Event)
            .map_err(|err| format!("Failed to parse realtime transcription event: {err}")),
        Ok(WsMessage::Ping(_)) | Ok(WsMessage::Pong(_)) => Ok(RealtimeSocketRead::Ignored),
        Ok(WsMessage::Close(frame)) => Ok(RealtimeSocketRead::Closed(
            frame
                .map(|frame| frame.reason.to_string())
                .filter(|reason| !reason.trim().is_empty()),
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
        Err(error) => Err(format!("Realtime transcription websocket read failed: {error}")),
    }
}

fn send_realtime_json(socket: &mut RealtimeSocket, event: Value) -> Result<(), String> {
    socket
        .send(WsMessage::Text(event.to_string().into()))
        .map_err(|err| format!("Realtime transcription websocket write failed: {err}"))
}

fn extract_realtime_error_message(event: &Value) -> String {
    event
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .or_else(|| event.get("message").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| event.to_string())
}

fn extract_text_field(event: &Value, fields: &[&str]) -> String {
    for field in fields {
        if let Some(value) = event.get(*field).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn decode_base64_audio(value: &str) -> Result<Vec<u8>, String> {
    let trimmed = strip_data_url_prefix(value);
    BASE64_STANDARD
        .decode(trimmed)
        .map_err(|err| format!("Failed to decode base64 audio chunk: {err}"))
}

fn strip_data_url_prefix(value: &str) -> &str {
    value.split_once(',').map(|(_, payload)| payload).unwrap_or(value)
}

fn write_temp_audio_chunk(bytes: &[u8]) -> Result<PathBuf, String> {
    let mut dir = env::temp_dir();
    dir.push("voice-overlay-assistant");
    dir.push("stt-chunks");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create STT chunk directory '{}': {err}", dir.display()))?;

    let path = dir.join(format!("chunk-{}.wav", system_time_ms()));
    fs::write(&path, bytes)
        .map_err(|err| format!("Failed to write STT WAV chunk '{}': {err}", path.display()))?;
    Ok(path)
}

fn resolve_local_whisper_python() -> PathBuf {
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Cargo manifest parent should exist")
        .to_path_buf();
    let project_local_python = project_root
        .join(".venv-whisper")
        .join("Scripts")
        .join("python.exe");

    if project_local_python.exists() {
        project_local_python
    } else {
        PathBuf::from("python")
    }
}

fn debug_log_path_for_session(session_id: &str) -> Result<PathBuf, String> {
    let mut dir = env::temp_dir();
    dir.push("voice-overlay-assistant");
    dir.push("stt-debug");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create STT debug directory '{}': {err}", dir.display()))?;
    Ok(dir.join(format!("{session_id}.jsonl")))
}

fn normalize_language(value: Option<&str>) -> Option<String> {
    let trimmed = value.unwrap_or(DEFAULT_LANGUAGE).trim().to_lowercase();
    if trimmed.is_empty() {
        None
    } else if let Some((language, _)) = trimmed.split_once('-') {
        Some(language.to_string())
    } else {
        Some(trimmed)
    }
}

fn millis_u64(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

fn system_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(millis_u64)
        .unwrap_or(0)
}
