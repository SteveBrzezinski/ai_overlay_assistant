# AI Orb Integration - Dokumentation

## Überblick

Das Voice Overlay Assistant Projekt wurde um einen **AI Orb** erweitert - einen animierten Overlay-Assistent, der unten rechts im Bildschirm schwebt.

## ✅ Bereits implementiert

### 1. **AI Orb (Animierte Komponente)**
- `src/components/AIOrb.tsx` - Die Hauptkomponente mit:
  - Äußerer, innerer und Kern-Ring (rotierend)
  - Center Glow mit Puls-Animation
  - States: Idle, Listening, Speaking
  - Action Bar (Mute, Chat, Voice, Settings)
  - Listening-Visualisierung mit Wellen

### 2. **Chat-Fenster**
- `src/components/ChatWindow.tsx` - Interaktives Chat-Interface mit:
  - Message-Historie
  - Voice-Input (Browser Speech Recognition)
  - Text-Input
  - Typing-Indicator
  - Mute-Status-Hinweis

### 3. **Styles & Animationen**
- `src/styles/AIOrb.css` - Professionelle Animation der Ringe
- `src/styles/ChatWindow.css` - Modernes Chat-UI mit Glasmorphismus

### 4. **App Integration**
- `src/App.tsx` - AIOrb und ChatWindow eingebunden
- States für: `isChatOpen`, `isMuted`, `isVoiceActive`
- Event-Handler für alle Buttons

## 🔄 Der Astra Companion - Features vs. Implementierung

| Feature | Status | Notizen |
|---------|--------|---------|
| **Orb Animation** | ✅ | Ringe, Pulsieren, Farbübergänge |
| **Emission Detection** | 🟡 | Basis-Implementation, kann ausgebaut werden |
| **Mic Input** | 🟡 | Browser Speech Recognition (kein OpenAI Call yet) |
| **Chat Integration** | 🟡 | UI vorhanden, Backend-Anbindung fehlt |
| **Voice Output** | ✅ | Bestehendes TTS-System |
| **Mute Toggle** | ✅ | UI und State vorhanden |
| **Settings** | 🟡 | Placeholder, kann expandiert werden |

## 🔧 Noch zu implementieren

### Phase 1: Backend-Anbindung
```typescript
// In ChatWindow.tsx
onSendMessage={async (message: string) => {
  // TODO: Call OpenAI API / LLM Backend
  // TODO: Stream response
  // TODO: Trigger TTS if not muted
}}
```

### Phase 2: Erweiterte Orb-Features
- [ ] Mikrofon-Level Visualization (via rodio)
- [ ] Emotionale Zustände (nur "idle | listening | speaking" für MVP)
- [ ] Custom Orb Colors basierend auf Mood/Action

### Phase 3: Voice Context
- [ ] Contextual awareness (was wurde gesagt)
- [ ] Multi-turn conversations
- [ ] History persistence

## 📁 Dateistruktur

```
src/
├── components/
│   ├── AIOrb.tsx           # Hauptkomponente
│   └── ChatWindow.tsx      # Chat-Interface
├── styles/
│   ├── AIOrb.css           # Orb-Animationen
│   └── ChatWindow.css      # Chat-Styles
├── App.tsx                 # Integration
└── ...existing files
```

## 🚀 Startup

```bash
# Mit MSVC Environment:
.\build-complete.bat

# Oder manuell:
npm run tauri:dev
```

App läuft:
1. **Frontend Vite Dev Server** auf `http://localhost:1420`
2. **Tauri Backend** mit Hotkeys & TTS
3. **AIOrb** erscheint unten rechts mit Action Bar bei Hover

## 🎨 Astra Companion Inspiration

Das ursprüngliche Projekt (`C:\Users\david\Astra Companion`) ist ein Unity-Projekt mit:
- `AstraSigilEmotion.cs` - Orb-Animationen (→ AIOrb.tsx React-Version)
- `ZuhörenSprechen.cs` - Speaking/Listening Logic (→ React States)
- `MicLevelToColor.cs` - Farb-Feedback (→ CSS Animations)
- `OpenAIVoiceTranscriber.cs` - OpenAI Integration (→ zu implementieren)

Die React-Version ist **moderner** und **besser integrierbar** mit dem Web-Stack.

## 💡 Nächste Schritte

1. **OpenAI Integration** in `ChatWindow.tsx`
   - API Key aus Settings laden
   - Message an GPT/LLM senden
   - Response streamen

2. **TTS Trigger** wenn nicht gemuted
   - Response abspielen über bestehendes rodio-System
   - Orb während Wiedergabe auf "speaking" State setzen

3. **Voice Context**
   - Conversation History für Multi-turn
   - Session Management

---

**Erstellt:** 2026-03-24  
**Integration Status:** ✅ UI Complete, 🟡 Backend In Progress
