# Localization

This project uses an English-first localization workflow.

## Rules

- English is the source language.
- English fallback copy lives in `src/locales/en/common.json`.
- Additional UI languages live in `src/locales/<language>/common.json`.
- User-facing copy should be loaded through `react-i18next`.
- Code comments, markdown files, and translation keys stay in English.

## Current Setup

- `i18next` provides translation resource management.
- `react-i18next` provides React bindings through `useTranslation` and `Trans`.
- The app normalizes the configured UI language to the supported set and falls back to English.
- Missing translation keys resolve to English instead of attempting runtime machine translation.

## Why Runtime Auto-Translation Is Not Used

Runtime machine translation sounds convenient, but it creates unstable product copy:

- wording changes without code review
- regressions are harder to test
- tone and terminology drift across releases
- offline and privacy-sensitive flows become harder to reason about

For a desktop product, versioned translation resources are the more predictable default.

## Adding A New UI String

1. Add the English key to `src/locales/en/common.json`.
2. Add the matching entry to every supported locale file.
3. Use `t(...)` or `Trans` in the component or hook.
4. Keep any non-obvious interpolation variables explicit and stable.

## Adding A New Language

1. Create `src/locales/<language>/common.json`.
2. Register the locale in `src/i18n.ts`.
3. Allow the locale in settings normalization on the frontend and backend.
4. Add the language to the UI selector.
5. Verify that missing keys still fall back to English.
