import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import de from './locales/de/common.json' with { type: 'json' };
import en from './locales/en/common.json' with { type: 'json' };

export const SUPPORTED_UI_LANGUAGES = ['en', 'de'] as const;
export type SupportedUiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export function normalizeUiLanguage(value: string | null | undefined): SupportedUiLanguage {
  return value === 'de' ? 'de' : 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
  },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_UI_LANGUAGES,
  defaultNS: 'translation',
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
  debug: false,
});

export default i18n;
