# Engineering Standards

This document defines the coding standards for `voice_overlay_assistant`.

It is intentionally practical: the rules below are the default unless a documented exception is required.

## Why These Rules Exist

The project combines:

- React and TypeScript in the renderer
- Tauri and Rust in the native shell
- OS automation and audio pipelines
- Realtime AI integrations

That mix becomes hard to maintain quickly if side effects, runtime contracts, and system access are not kept explicit.

## Frontend Standards

### React

- Use function components and hooks. Do not introduce class components.
- Keep render logic pure. Compute display data from props and state during render instead of mutating external state.
- Use effects only for real synchronization with external systems such as Tauri events, timers, browser APIs, audio, or network lifecycles.
- When logic is reusable or effect-heavy, move it into a custom hook or dedicated controller module instead of growing `App.tsx`.
- Avoid storing duplicated derived state when it can be computed from existing state.
- Prefer explicit event handlers over inline anonymous logic once the logic becomes non-trivial.

### TypeScript

- All cross-boundary contracts must be typed: Tauri invoke payloads, event payloads, controller snapshots, and persisted settings.
- Prefer `type` or `interface` definitions over anonymous object literals for reusable shapes.
- Avoid `any`. If a browser or third-party API forces a loose type, narrow it locally and document why.
- Use `type` imports for type-only symbols.
- Keep string unions and domain enums close to the feature they describe.

### Comments

- Add comments for protocol quirks, synchronization rules, lifecycle constraints, timing assumptions, and non-obvious workarounds.
- Do not add comments that repeat what the code already says.
- Write code comments in English only.

### Frontend Architecture

- App shell components orchestrate feature modules. They should not own every detail directly.
- Feature state should live close to the feature that uses it.
- Controller-style modules in `src/lib` are acceptable for browser APIs, Tauri bridges, and realtime pipelines.
- Large visual sections should be extracted into components before the parent file becomes a second architecture layer.

## Tauri / Rust Standards

### Tauri

- Keep commands small and predictable. Parse input, call a Rust service or helper, and return structured results.
- Validate external input at the command boundary.
- Do not hide system access behind unrelated commands.
- Prefer explicit, typed payloads and JSON objects with stable field names for renderer/native communication.
- Keep security defaults as restrictive as practical; if something is intentionally broad, document the reason.

### Rust

- Prefer small functions with explicit data flow over long, stateful procedural blocks.
- Use `struct` or `enum` models for domain boundaries instead of ad-hoc maps where possible.
- Keep platform-specific behavior isolated.
- Avoid `unwrap` or `expect` outside startup or truly unrecoverable initialization paths.
- Keep unsafe code out unless it is unavoidable and documented.
- Use `cargo fmt` and `clippy` as non-optional quality gates.

### Rust Architecture

- Commands live at the edge; service logic lives in dedicated modules.
- Shared state uses focused state holders instead of global mutable behavior.
- Streaming, process control, and filesystem helpers should be isolated from business rules.
- If a file becomes a dumping ground, split by responsibility before adding more features.

## File Size And Complexity

These are soft limits used to trigger refactors before the codebase hardens in the wrong shape:

- React component files: aim for under 350 lines
- Hook and controller files: aim for under 400 lines
- Rust modules: aim for under 500 lines
- Functions with branching complexity over roughly 15 should be reviewed for extraction

A file exceeding these limits is not automatically wrong, but new unrelated logic should not be added without extraction.

## Language Policy

- English is the source language for code comments, markdown documentation, translation keys, and fallback UI copy.
- Do not add German or other localized inline UI strings directly in TypeScript, TSX, or Rust source files unless the text is strictly internal and never shown to users.
- User-facing localized copy belongs in translation resources and must keep English as the default fallback.
- If a translation is missing, prefer the English source string over runtime machine translation.
- When adding new UI copy, update the English locale first and add matching entries for other supported locales in the same change whenever practical.

## Automation

The repo enforces these standards with:

- ESLint with typed TypeScript rules and React Hooks rules
- TypeScript strict compilation
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- GitHub Actions quality checks

## Source Material

These rules are aligned with the official guidance from:

- React docs on purity, hooks, and avoiding unnecessary effects
- Tauri docs on command boundaries, permissions, and security configuration
- Rust formatting and linting guidance via `rustfmt` and Clippy
- `typescript-eslint` guidance for typed linting
