# Voice Overlay Assistant – MVP+

Windows-first Tauri app for selection-based AI flows with **global run control**.

## Settings And Local Config

- UI settings are persistent and stored in a local config file at `.voice-overlay-assistant.config.json` in the project root.
- The file is created on first start and is git-ignored.
- The settings UI now covers speech mode (`classic` / `live` / `realtime` experimental), the optional realtime fallback toggle, audio format, first-chunk lead-in, speech playback speed, translation target language, and the OpenAI API key.
- If an OpenAI API key is saved in the UI, it overrides `OPENAI_API_KEY` from `.env`. If the UI field is empty, `.env` remains the fallback.
- The Settings view includes a reset-to-default action with confirmation before anything is cleared.
- The default UI language is English, and the default translation target language is English.

## Kernidee

Die App arbeitet immer mit einem **zentralen aktiven Run**.
Ein Run kann z. B. sein:

- Speak
- Translate + Speak
- spätere Rewrite-/Explain-/Grammar-Flows

Wichtig dabei:
- **Pause/Resume und Cancel sind global**
- sie gelten **nicht nur für einen einzelnen Speak-Flow**, sondern für **jeden aktiven AI-Run**
- das soll auch für zukünftige Features so bleiben

## Hotkeys

- **Ctrl+Shift+Space** → capture marked text and speak it
- **Ctrl+Shift+T** → capture marked text, translate it, and speak the translation
- **Ctrl+Shift+P** → Pause / Resume des aktuell laufenden Runs
- **Ctrl+Shift+X** → Cancel / Abbruch des aktuell laufenden Runs

## Globale Run-Control-Regel

**Produktregel:**
Jeder aktive AI-Workflow muss an den zentralen Run-Controller angeschlossen sein.

Das gilt für aktuelle und zukünftige Features:
- Speak
- Translate
- Rewrite
- Explain
- Grammar fix
- Streaming-/Live-Modi
- weitere AI-Aktionen

Das Ziel ist:
- ein aktiver Run muss immer global pausierbar sein
- ein aktiver Run muss immer global abbrechbar sein
- Audio-Playback darf nie ein Sonderfall außerhalb dieser globalen Steuerung sein

## Was jetzt drin ist

- globaler Speak-Hotkey: `Ctrl+Shift+Space`
- globaler Translate-Hotkey: `Ctrl+Shift+T`
- globaler Pause/Resume-Hotkey: `Ctrl+Shift+P`
- globaler Cancel-Hotkey: `Ctrl+Shift+X`
- Selection Capture per Hintergrund-`Ctrl+C`
- Clipboard-Restore nach Möglichkeit
- OpenAI TTS mit satzweisem Chunking
- konfigurierbarer TTS-Modus: `classic` / `stable`, `live` / `session-ready streaming`, `realtime` / experimental
- eingebetteter Rust-Audioplayer über `rodio`
- Standard-Audioformat: **WAV**
- konfigurierbarer Startpuffer für den ersten Chunk
- konfigurierbare Speech-Playback-Geschwindigkeit von `0.5x` bis `2.0x`
- Translation mit konfigurierbarer Zielsprache
- Settings in der UI für:
  - Audioformat (`WAV` / `MP3`)
  - Speech-Modus (`Classic / stable`, `Live / session-ready streaming`, `Realtime / experimental`)
  - erster Chunk Startpuffer
  - Speech-Playback-Speed
  - Zielsprache für Übersetzung
  - OpenAI API Key
  - Reset auf Default-Werte mit Bestätigung
- Settings werden lokal persistent gespeichert
- Timing-/Chunk-Logging für Debugging inkl. aktivem Modus, erstem Audio-Empfang, erstem hörbaren Playback-Start und sichtbarer Startlatenz

## Bedienung

1. App starten und im Hintergrund offen lassen.
2. In einer anderen Windows-App Text markieren.
3. Einen Hotkey drücken:
   - `Ctrl+Shift+Space` → Vorlesen
   - `Ctrl+Shift+T` → Übersetzen + Vorlesen
4. Während ein Run aktiv ist:
   - `Ctrl+Shift+P` → Pause / Resume
   - `Ctrl+Shift+X` → Cancel

## Audio / Playback

Es gibt jetzt drei Modi:

- `classic` / `stable`:
  - bisheriger robuster Pfad
  - Text wird satzweise gechunkt
  - mehrere `audio/speech`-Requests laufen parallel
  - Antworten werden komplett empfangen, als Dateien geschrieben und danach geordnet abgespielt
  - `firstChunkLeadingSilenceMs` gilt hier weiter
  - Playback-Speed nutzt den bisherigen time-stretch-Pfad
- `live` / `low-latency`:
  - OpenAI `audio/speech` wird als Stream verwendet
  - intern wird `pcm` gestreamt und sofort in denselben `rodio`-Player geschoben
  - die finale Datei wird nach Abschluss zusätzlich als `WAV` gespeichert
  - bei `1.0x` bleibt der schnelle Direktpfad mit minimalem Zusatzbuffer aktiv
  - bei `speed != 1.0` nutzt `live` jetzt einen stärker gepufferten, blockweisen time-stretch-/crossfade-Kompromiss statt `Sink::set_speed`
  - der künstliche erste Chunk-Lead-in wird bewusst übersprungen; für den naturalized-speed-Pfad entsteht stattdessen absichtlich etwas zusätzliche Startlatenz
- `realtime` / experimental:
  - verbindet sich per WebSocket mit `wss://api.openai.com/v1/realtime?model=...`
  - initialisiert die Session per `session.update`
  - sendet den Text per `conversation.item.create`
  - triggert Audio per `response.create`
  - verarbeitet echte Base64-Audio-Deltas aus `response.output_audio.delta` / `response.audio.delta`
  - spielt die ersten PCM-Blöcke so früh wie möglich über denselben `rodio`-Player ab
  - speichert am Ende ebenfalls eine `WAV`
  - bleibt bewusst experimentell; Realtime-Fehler werden standardmäßig direkt sichtbar, und der Rückfall auf `live` ist nur optional per Setting aktivierbar

Praktische Einschätzung:
- `classic` bleibt der konservative Modus für den bisherigen stabilen Dateiflow.
- `live` ist ein echter Streaming-Pfad mit deutlich kleinerer Time-to-first-audible-audio, ohne auf die globale Run-Control zu verzichten.
- `realtime` ist jetzt ein echter OpenAI-Realtime-WebSocket-Pfad, aber noch nicht der neue Standardpfad.

## Pause / Resume / Cancel – aktueller Stand

Aktuell gilt:
- **Pause/Resume** wirkt direkt auf die laufende Wiedergabe
- **Cancel** stoppt aktuelles Audio sofort und verhindert weiteres Abspielen der restlichen Queue
- im `classic`-Modus werden laufende HTTP-Requests weiterhin nicht hart netzwerkseitig abgebrochen, aber ihre Ergebnisse werden nach Rückkehr ignoriert
- im `live`-Modus gilt Pause/Resume/Cancel ebenfalls; der Stream wird zwischen Read-Zyklen geprüft und das Playback sofort über denselben Sink gesteuert
- im `realtime`-Modus bleibt Pause/Resume playback-seitig; bei erkanntem Cancel versucht die App zusätzlich `response.cancel` zu senden und die WebSocket-Session sauber zu schließen

Das ist absichtlich als robuster MVP umgesetzt und bildet die Grundlage für alle späteren AI-Flows.

## Translation

Aktuell:
- markierten Text capturen
- an OpenAI zur Übersetzung schicken
- Übersetzung direkt sprechen
- Ergebnis zusätzlich in der App sichtbar halten

Die Architektur ist so angelegt, dass später leicht erweitert werden kann auf:
- Copy-to-clipboard
- paste-back / auto replace
- alternative Ausgaben wie Overlay / Rewrite / Explain

## Realtime / Session-Stand

Stand nach diesem Umbau:

- `live` bleibt der echte Streaming-TTS-Pfad über `POST /v1/audio/speech` mit gestreamtem `pcm`
- `realtime` nutzt jetzt einen echten OpenAI-Realtime-WebSocket-Pfad für Text-zu-Audio
- darüber liegt eine **Session-Plan-/Session-Strategie-Abstraktion**, damit verschiedene Transportpfade sauber andocken können
- neues UI-Setting: `realtime` / experimental
- **Wichtig:** `realtime` ist weiterhin experimentell
- wenn WebSocket-Verbindung, Session-Initialisierung oder die frühe Audio-Ausgabe fehlschlägt, wird der Realtime-Fehler jetzt standardmäßig direkt sichtbar; der Rückfall auf `live` ist nur noch optional per Setting aktivierbar

Warum das so ist:
- der aktuelle Produktfluss startet von **fertigem Text** und braucht heute vor allem stabiles TTS + globale Run-Control
- der WebSocket-Pfad liefert zwar jetzt echte Realtime-Audio-Deltas, ist aber in dieser Desktop-App noch bewusst konservativ abgesichert
- die Session-Struktur macht den nächsten Schritt zu Mic-in + Audio-out deutlich leichter, ohne den bestehenden Flow kaputt zu machen

Was die Session-Schicht jetzt bereits liefert:
- pro TTS-Run eine `session_id`
- Trennung zwischen **requested mode** und **resolved mode**
- explizite `session_strategy` (z. B. `chunked_file_session`, `streaming_audio_session`, `realtime_websocket_session`, `realtime_websocket_live_fallback_session`)
- ehrliche `fallback_reason`, wenn `realtime` auf `live` zurückfallen musste
- Status-/Timing-Signale für `connecting`, `connected`, erstes Audio und ersten hörbaren Playback-Start
- derselbe globale Pause/Resume/Cancel-Controller bleibt für alle Strategien aktiv

Verbleibende Grenzen:
- `live` priorisiert niedrige Startlatenz vor maximaler Format-Flexibilität; intern wird immer `pcm` gestreamt
- `live` speichert am Ende immer `WAV`, auch wenn im klassischen Modus `MP3` gewählt werden kann
- `realtime` ist im Moment ein **experimenteller** Text-zu-Audio-WebSocket-Pfad, nicht die voll ausgebaute bidirektionale Voice-Agent-Implementierung
- es gibt noch kein Mic-Capture und kein kontinuierliches bidirektionales Audio-Streaming
- wenn der Realtime-Pfad **nach** bereits gestarteter Audio-Ausgabe fehlschlägt, wird nicht auf `live` dupliziert; der Fehler wird dann direkt gemeldet
- die Audioausgabe über WebSocket basiert auf `audio/pcm`; die App speichert daraus lokal weiter `WAV`

## Lokale Installation auf Windows

### Voraussetzungen

Du brauchst auf deinem PC:
- **Windows**
- **Node.js** (inkl. `npm`)
- **Rust** mit `cargo`
- die **Tauri prerequisites für Windows**
- einen **OpenAI API Key**

### Projekt holen

Wenn du das Repo noch nicht lokal hast:

```powershell
git clone https://github.com/SteveBrzezinski/ai_ovlay_assistant.git
cd ai_ovlay_assistant
```

Wenn du schon im Projektordner bist, einfach dort weitermachen.

### Abhängigkeiten installieren

```powershell
npm install
```

### `.env` anlegen

Im Projektverzeichnis eine `.env` anlegen:

```env
OPENAI_API_KEY=your_key_here
```

Falls noch keine Datei existiert, kannst du z. B. in PowerShell eine neue erzeugen oder `.env.example` als Vorlage nutzen.

Alternativ kannst du den OpenAI API Key direkt in der Settings-UI hinterlegen. Wenn dort ein Key gespeichert ist, hat er Vorrang vor `.env`.

### Dev-Modus starten

```powershell
npm run tauri:dev
```

Dann:
1. App offen lassen
2. in einer anderen Windows-App Text markieren
3. einen der Hotkeys verwenden

### Production-Build

```powershell
npm run tauri:build
```

## Entwicklung

```bash
npm install
npm run tauri:dev
```

Beim ersten Start erzeugt die App die lokale Datei `.voice-overlay-assistant.config.json`. Darin werden die UI-Settings inklusive optional gespeichertem OpenAI API Key abgelegt.

## Checks

```bash
npm run build
npx tsc --noEmit
cargo check
```

> Rust/Tauri-Windows-Teile lassen sich am sinnvollsten auf einem echten Windows-Setup validieren.
