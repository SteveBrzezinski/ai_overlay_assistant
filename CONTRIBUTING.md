# Contributing

This project uses one shared quality bar for React, TypeScript, Tauri, and Rust.

## Required Checks

Run these commands before opening or merging a pull request:

```bash
npm run lint
npm run typecheck
npm run tts:check
npm run format:check
npm run lint:rust
npm run check:rust
```

Or run the combined check:

```bash
npm run quality
```

## Engineering Rules

The authoritative project rules live in [docs/engineering-standards.md](docs/engineering-standards.md).

The short version:

- Keep React components focused on rendering and user orchestration.
- Move reusable side effects into hooks or dedicated controller modules.
- Keep Tauri commands thin and delegate system logic to Rust modules.
- Prefer typed contracts over loose `any`, stringly typed maps, and hidden side effects.
- Add comments for protocol details, invariants, edge cases, and non-obvious decisions.
- Keep code comments, markdown documentation, and fallback UI copy in English.
- Put localized user-facing strings in the translation resources instead of inline source strings.
- Avoid expanding already-large files. Extract modules before adding more unrelated logic.
