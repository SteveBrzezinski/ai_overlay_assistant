import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import {
  getAppStatus,
  getHotkeyStatus,
  getLanguageOptions,
  getSettings,
  onHotkeyStatus,
  type AppSettings,
  type HotkeyStatus,
  type LanguageOption,
} from '../lib/voiceOverlay';
import { fallbackHotkeyStatus, fallbackSettings } from '../lib/app/appModel';
import i18n from '../i18n';

type UseAppBootstrapOptions = {
  onHotkeyStatusUpdate: (status: HotkeyStatus, appendHistory: boolean) => void;
};

const LANGUAGE_LABELS: Record<string, string> = {
  de: 'German',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  pl: 'Polish',
  nl: 'Dutch',
  tr: 'Turkish',
  ja: 'Japanese',
};

function normalizeLanguageOptions(languages: LanguageOption[]): LanguageOption[] {
  return languages.map((language) => ({
    ...language,
    label: LANGUAGE_LABELS[language.code] ?? language.label,
  }));
}

export function useAppBootstrap(options: UseAppBootstrapOptions): {
  appStatus: string;
  hotkeyStatus: HotkeyStatus;
  settings: AppSettings;
  savedSettings: AppSettings;
  languageOptions: LanguageOption[];
  initialStateLoaded: boolean;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  setSavedSettings: Dispatch<SetStateAction<AppSettings>>;
} {
  const { onHotkeyStatusUpdate } = options;

  const [appStatus, setAppStatus] = useState(i18n.t('app.loadingStatus'));
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>(fallbackHotkeyStatus);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [savedSettings, setSavedSettings] = useState<AppSettings>(fallbackSettings);
  const [languageOptions, setLanguageOptions] = useState<LanguageOption[]>([]);
  const [initialStateLoaded, setInitialStateLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([
      getAppStatus(),
      getHotkeyStatus(),
      getSettings(),
      getLanguageOptions(),
    ])
      .then(([status, hotkey, appSettings, languages]) => {
        setAppStatus(status);
        setHotkeyStatus(hotkey);
        setSettings(appSettings);
        setSavedSettings(appSettings);
        setLanguageOptions(normalizeLanguageOptions(languages));
        onHotkeyStatusUpdate(hotkey, false);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        setAppStatus(i18n.t('app.failedToLoadStatus', { detail }));
      })
      .finally(() => {
        setInitialStateLoaded(true);
      });

    let unlistenHotkeyStatus: (() => void | Promise<void>) | undefined;
    void onHotkeyStatus((status) => {
      setHotkeyStatus(status);
      onHotkeyStatusUpdate(status, true);
    }).then((cleanup) => {
      unlistenHotkeyStatus = cleanup;
    });

    return () => {
      void unlistenHotkeyStatus?.();
    };
  }, [onHotkeyStatusUpdate]);

  return {
    appStatus,
    hotkeyStatus,
    settings,
    savedSettings,
    languageOptions,
    initialStateLoaded,
    setSettings,
    setSavedSettings,
  };
}
