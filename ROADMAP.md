# ROADMAP.md – Voice Overlay Assistant

> **Zweck dieser Datei:** Langfristige Zielsetzung und Versionierung des Projekts.
> Wird bei Änderungen an der Zielsetzung aktualisiert. Dient AIs (insbesondere OpenClaw) als
> verbindliche Referenz dafür, was gebaut werden soll und wohin das Projekt langfristig geht.
>
> **Letzte Aktualisierung:** 2026-03-24

---

## Vision

Ein intelligenter, dezenter Desktop-Assistent, der im Hintergrund läuft und dem Nutzer alltägliche Aufgaben abnimmt – Texte vorlesen, übersetzen, Fragen beantworten, Mails formulieren, Nachrichten verwalten. Bedienbar per Hotkey, Maus, Sprache oder Text. Barrierefrei, zugänglich, und auch für nicht-technische Nutzer einfach nutzbar.

Langfristig: Ein universeller AI-Companion als Desktop-Overlay, der über OpenClaw als Backend auch normalen Nutzern den Zugang zu AI-gestützten Workflows ermöglicht – wie ein freundlicher Container über OpenClaw.

---

## V1 – MVP ✅ (aktueller Stand)

**Status:** Abgeschlossen

### Was V1 kann

- **Globale Hotkeys:**
  - `Ctrl+Shift+Space` → markierten Text vorlesen (Speak)
  - `Ctrl+Shift+T` → markierten Text übersetzen + vorlesen (Translate)
  - `Ctrl+Shift+P` → Pause / Resume des aktiven Runs
  - `Ctrl+Shift+X` → Cancel / Abbruch des aktiven Runs
- **Selection Capture** per Hintergrund-`Ctrl+C` mit Clipboard-Restore
- **OpenAI TTS** mit satzweisem Chunking
- **3 TTS-Modi:**
  - `classic` / stable – robuster Datei-basierter Flow
  - `live` / low-latency – echtes HTTP-Streaming mit `pcm`
  - `realtime` / experimental – OpenAI Realtime WebSocket
- **Eingebetteter Rust-Audioplayer** (rodio)
- **Konfigurierbare Settings** (persistent, lokal):
  - Audioformat (WAV / MP3)
  - Speech-Modus
  - Playback-Speed (0.5x – 2.0x)
  - Erster-Chunk-Startpuffer
  - Zielsprache für Übersetzung
  - OpenAI API Key (UI oder `.env`)
  - Reset auf Defaults
- **Globaler Run-Controller** – Pause/Resume/Cancel für alle Modi
- **Run-History** mit Latency-/Timing-Tracking
- **Translation** mit konfigurierbarer Zielsprache

### Architektur V1

- **Stack:** Tauri 2 + Rust + React 18 + Vite + TypeScript
- **Frontend:** `src/` – React UI, TTS-Service, Audio-Player, Selection-Capture
- **Backend:** `src-tauri/src/` – Hotkeys, Run-Controller, TTS, Translation, Settings

---

## V2 – AI Overlay Companion 🚧

**Status:** In Planung / GitHub Milestone vorhanden
**Ziel-Deadline (Milestone):** 29. März 2026

### Kerngedanke V2

Die App wird vom reinen Hotkey-Tool zum visuellen AI-Companion. Ein dezenter Orb lebt permanent auf dem Bildschirm, reagiert visuell auf Aktionen und bietet über intuitive UI-Elemente Zugang zu allen Features – auch ohne Hotkeys.

### V2 Features im Detail

#### 1. AI Orb (Overlay, immer sichtbar)

- Kleiner animierter Orb unten rechts auf dem Bildschirm
- Transparenter Hintergrund, schwebt über allen Fenstern
- Soll visuell wie die AI wirken (lebendig, subtil animiert)
- Reagiert später auf Aktionen: pulsiert beim Sprechen, leuchtet beim Zuhören etc.
- Beim Start der App läuft diese im Hintergrund – der Orb ist das einzig Sichtbare

#### 2. Navigationsleiste (Orb-Hover)

Beim Hovern über den Orb fährt nach links eine moderne, dezente Aktionsleiste aus:

| Icon | Aktion | Beschreibung |
|------|--------|--------------|
| 🔇 | **Mute/Unmute** | AI-Sprachausgabe stumm schalten. Wenn gemuted, antwortet die AI stattdessen in einem neuen Chat-Fenster |
| 💬 | **Chat** | Öffnet ein kleines Chat-Fenster für Text-Fragen an die AI. Enthält auch einen Mic-Button zum Transkribieren per Sprache |
| 🎙️ | **Voice** | Aktiviert den Orb zum direkten Zuhören. Man spricht, die AI antwortet per Lautsprecher (oder im Chat wenn gemuted). Nur sichtbar wenn AI nicht gemuted |
| ⚙️ | **Einstellungen** | Öffnet ein separates Settings-Fenster im gleichen Design mit allen bestehenden Einstellungen aus V1 |

#### 3. Chat-System

- Kleines Chat-Fenster, das über den Chat-Button oder aus der Action Bar geöffnet wird
- Text-Input für Fragen an die AI
- Mic-Button im Chat: Gesprochenes wird transkribiert → landet als Text im Input-Feld → kann bearbeitet und abgeschickt werden
- AI antwortet im Chat (Text)
- **Sessions:** Einzelne Chat-Gespräche werden als Sessions zwischengespeichert
- **Langfristig:** Sessions werden zu OpenClaw-Verbindungen (siehe V2-OpenClaw-Integration)

#### 4. Voice-Interaktion (direkt über Orb)

- Button in der Leiste aktiviert den Orb zum Zuhören
- Man spricht direkt eine Frage
- AI antwortet per Lautsprecher (TTS)
- Wenn gemuted: AI antwortet stattdessen in einem neuen Chat
- Der Orb zeigt visuell, dass er zuhört (Animation)

#### 5. Smart Action Bar (bei Textmarkierung)

Wenn der Nutzer in irgendeiner App Text markiert, erscheint automatisch eine schwebende Action Bar in der Nähe der Maus (ähnlich wie in Canva):

| # | Aktion | Beschreibung |
|---|--------|--------------|
| 1 | **Vorlesen** | Markierten Text per TTS vorlesen |
| 2 | **Übersetzen** | Markierten Text übersetzen + vorlesen |
| 3 | **Kontext +** | Markierten Text in einen Kontext-Topf legen. Kann mehrfach hintereinander gemacht werden. Der Topf wird nach dem Abschicken einer Anfrage geleert |
| 4 | **Kontext leeren** | Kontext-Topf manuell leeren. Nur sichtbar wenn etwas im Topf ist |
| 5 | **Frage stellen (Text/Mic)** | Öffnet ein Input-Feld / Mini-Chat. Man kann tippen oder per Mic-Button sprechen (Transkription → Input-Feld). Kontext-Topf wird als Kontext mitgeschickt |
| 6 | **Voice-Frage** | Nur sichtbar wenn AI nicht gemuted. Direktes Sprechen einer Frage – Orb wird visuell aktiv, AI antwortet per Lautsprecher |

#### 6. Einstellungen (separates Fenster)

- Eigenes Fenster im gleichen visuellen Design wie der Orb / die Leiste
- Beinhaltet alle bestehenden V1-Settings:
  - Speech-Modus, Audioformat, Playback-Speed
  - Erster-Chunk-Startpuffer
  - Zielsprache
  - OpenAI API Key
  - Reset auf Defaults
- Erweiterbar für neue V2-Settings

#### 7. OpenClaw-Integration (V2-Stretch-Goal)

- Chat-Sessions als OpenClaw-Sessions anbinden
- Die App wird zu einem benutzerfreundlichen Frontend / Container über OpenClaw
- Ermöglicht auch nicht-technischen Nutzern Zugang zu OpenClaw-Funktionalität
- Konfiguration und Nutzung von OpenClaw direkt aus der App heraus
- Spart erheblich Entwicklungsaufwand, da OpenClaw Backend-Logik (Memory, Sessions, AI-Routing) übernimmt

### V2 Design-Prinzipien

- **Dezent:** Der Orb und alle UI-Elemente sollen sich natürlich in den Desktop einfügen, nicht stören
- **Modern:** Cleanes, minimalistisches Design mit sanften Animationen
- **Konsistentes Design:** Orb, Leiste, Chat, Action Bar und Settings teilen dieselbe visuelle Sprache
- **Kein Fenster im klassischen Sinn:** Alles ist Overlay – transparent, rahmenlos, schwebend

### V2 Technische Notizen

- Action Bar braucht globale Erkennung von Textmarkierungen (über den bestehenden Selection-Capture-Mechanismus erweiterbar)
- Chat-System braucht Session-Management im Frontend + persistente Speicherung
- Voice-Input braucht Mic-Capture + Transkription (OpenAI Whisper API oder ähnlich)
- Orb-Animationen: wahrscheinlich Canvas/WebGL oder CSS-Animationen im Tauri-Webview
- Mehrere Tauri-Fenster: Orb-Overlay (always-on-top, transparent) + Settings-Fenster + Chat-Fenster

---

## V3+ – Universeller AI-Assistent (Zukunft)

**Status:** Langfristige Vision

### Richtung

Die App wird zum vollwertigen AI-Assistenten, der tief in den Desktop-Alltag integriert ist.

### Geplante Themenbereiche

- **WhatsApp-Integration:** Nachrichten vorlesen lassen, beantworten, formulieren
- **E-Mail-Integration:** Mails lesen, zusammenfassen, formulieren, beantworten
- **Barrierefreiheit:** Screenreader-Kompatibilität, Bedienung rein per Sprache, Hochkontrast-Modi
- **Erweiterte Voice-Interaktion:** Keyword-Aktivierung (AI-Name sagen startet Aufnahme), kontinuierliches bidirektionales Audio
- **Multi-App-Integration:** Weitere Apps anbinden (Kalender, Notizen, Browser etc.)
- **Langzeitgedächtnis:** Über OpenClaw-Sessions persistentes Gedächtnis über Gespräche hinweg
- **Benutzerzugänglichkeit:** Setup-Wizard, einfache Konfiguration, keine CLI nötig
- **Proaktive AI:** Benachrichtigungen, Erinnerungen, kontextbasierte Vorschläge

### Leitprinzipien für alle zukünftigen Versionen

1. **Einfache Bedienbarkeit** – Jedes Feature muss ohne technisches Wissen nutzbar sein
2. **Zugänglichkeit** – Mehrere Eingabewege (Hotkey, Maus, Sprache, Text)
3. **Barrierefreiheit** – Von Anfang an mitdenken, nicht nachträglich draufsetzen
4. **Dezenz** – Der Assistent hilft, ohne zu stören oder den Workflow zu unterbrechen
5. **Erweiterbarkeit** – Neue Integrationen sollen einfach andockbar sein

---

## Änderungshistorie

| Datum | Änderung |
|-------|----------|
| 2026-03-24 | Initiale Erstellung: V1 (abgeschlossen), V2 (detailliert), V3+ (Vision) |
