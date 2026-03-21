# Voice Overlay Assistant – MVP+

Windows-first Tauri app for selection-based AI flows with **global run control**.

## Settings And Local Config

- UI settings are persistent and stored in a local config file at `.voice-overlay-assistant.config.json` in the project root.
- The file is created on first start and is git-ignored.
- The settings UI now covers audio format, first-chunk lead-in, speech playback speed, translation target language, and the OpenAI API key.
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
- eingebetteter Rust-Audioplayer über `rodio`
- Standard-Audioformat: **WAV**
- konfigurierbarer Startpuffer für den ersten Chunk
- konfigurierbare Speech-Playback-Geschwindigkeit von `0.5x` bis `2.0x`
- Translation mit konfigurierbarer Zielsprache
- Settings in der UI für:
  - Audioformat (`WAV` / `MP3`)
  - erster Chunk Startpuffer
  - Speech-Playback-Speed
  - Zielsprache für Übersetzung
  - OpenAI API Key
  - Reset auf Default-Werte mit Bestätigung
- Settings werden lokal persistent gespeichert
- Timing-/Chunk-Logging für Debugging

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

Der Default bleibt **WAV**. Das Playback läuft jetzt **direkt in Rust über einen eingebetteten App-Player** statt über PowerShell / Windows-Player:

- Playback der TTS-Chunks erfolgt app-intern über `rodio`
- WAV von OpenAI wird nicht mehr an `SoundPlayer`, MCI oder WMPlayer delegiert
- Chunks werden weiterhin parallel erzeugt, aber **geordnet und sequentiell** abgespielt
- der optionale Startpuffer für den ersten Chunk wird beim Playback eingefügt
- die Playback-Geschwindigkeit wird direkt beim `rodio`-Playback angewendet
- MP3 bleibt als Option in den Settings erhalten

Praktische Einschätzung:
- Das vermeidet Unterschiede je nach installiertem Windows-Playback-Pfad.
- Für den aktuellen Stand ist ein kleiner eingebetteter Player robuster als Datei-für-Datei-Playback über OS-Skripte.

## Pause / Resume / Cancel – aktueller Stand

Aktuell gilt:
- **Pause/Resume** wirkt direkt auf die laufende Wiedergabe
- **Cancel** stoppt aktuelles Audio sofort und verhindert weiteres Abspielen der restlichen Queue
- laufende HTTP-Requests werden aktuell nicht hart netzwerkseitig abgebrochen, aber ihre Ergebnisse werden nach Rückkehr ignoriert, wenn der Run bereits gecancelt wurde

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

## Realtime / Streaming-Einschätzung

**OpenAI streaming / realtime** kann später ein sinnvoller Beschleunigungspfad sein, vor allem wenn:
- kleinere Zwischenresultate früher in der UI erscheinen sollen
- TTS noch schneller starten soll
- Übersetzung + Vorlesen stärker dialogartig werden

Für dieses MVP war die robustere Änderung sinnvoller: bestehende request/response-Pipeline behalten, aber Startverhalten, Playback und globale Hotkeys stabilisieren.

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
