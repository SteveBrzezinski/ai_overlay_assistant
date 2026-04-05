# Voice Overlay Assistant

Voice Overlay Assistant is a Windows-first Tauri desktop app for two related workflows:

- selection-based read-aloud and translate-then-speak actions triggered by global hotkeys
- an always-on voice assistant that listens for a wake phrase, streams speech through the app, and can forward turns to the configured assistant backend

The renderer is built with React and TypeScript. Native OS integration, audio playback, and system automation live in the Tauri / Rust layer.

## Current Capabilities

- Global hotkey to read selected text aloud
- Global hotkey to translate selected text and speak the translation
- Persistent live transcription startup when the app launches
- Wake-word assistant flow driven by WebView2 / Windows speech recognition
- Realtime voice session support for spoken assistant interaction
- Local settings persistence in `.voice-overlay-assistant.config.json`
- English-first UI with optional German translations
- Quality gates for TypeScript, React, Tauri, and Rust

## Requirements

- Windows 10 or Windows 11
- Node.js and npm
- Rust with Cargo
- Tauri Windows prerequisites
- Microsoft WebView2 runtime
- An OpenAI API key

If you want to use the full voice assistant flow that bridges to the local OpenClaw gateway, OpenClaw must also be installed and configured on the machine.

## Installation

Clone the repository and install dependencies:

```powershell
git clone https://github.com/SteveBrzezinski/ai_ovlay_assistant.git
cd ai_ovlay_assistant
npm install
```

Create a local `.env` file in the project root:

```env
OPENAI_API_KEY=your_key_here
```

You can also enter the API key in the app settings. A value stored in the UI overrides `.env`.

## Run In Development

```powershell
npm run tauri:dev
```

The app starts live transcription automatically. There is no manual "start live transcription" step anymore.

## Build

```powershell
npm run tauri:build
```

For renderer-only validation:

```powershell
npm run build
```

## Quality Checks

Run the full project quality gate before merging:

```powershell
npm run quality
```

This includes:

- ESLint
- TypeScript strict checks
- Rust formatting checks
- Clippy warnings as errors
- Cargo compilation checks

## Settings And Local Data

- Runtime settings are stored in `.voice-overlay-assistant.config.json` in the project root.
- The file is generated and updated locally by the app.
- The file is git-ignored because it contains user-specific settings and may contain secrets.

## Language Policy

- English is the source language for code comments, documentation, translation keys, and fallback UI copy.
- Localized UI strings belong in `src/locales/<language>/common.json`.
- The app currently ships with English and German UI resources.
- Missing translations fall back to English.
- Runtime machine translation is intentionally not used for the interface because stable product copy is easier to review, test, and maintain when translations are versioned with the codebase.

See [docs/engineering-standards.md](docs/engineering-standards.md) and [docs/localization.md](docs/localization.md) for the full development rules.

## License

This repository uses a personal-use-only license. See [LICENSE.md](LICENSE.md).
