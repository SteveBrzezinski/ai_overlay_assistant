import { getCurrentWindow, type Window } from '@tauri-apps/api/window';

export const DESIGN_THEME_IDS = ['obsidian-halo', 'shadow-satin', 'olympian-marble', 'retro-signal'] as const;
export type DesignThemeId = (typeof DESIGN_THEME_IDS)[number];

export type DesignThemeOption = {
  id: DesignThemeId;
  label: string;
  description: string;
  accent: string;
  contrast: string;
  colorScheme: 'dark' | 'light';
};

export const DEFAULT_DESIGN_THEME_ID: DesignThemeId = 'obsidian-halo';

export const DESIGN_THEME_OPTIONS: DesignThemeOption[] = [
  {
    id: 'obsidian-halo',
    label: 'Obsidian Halo',
    description: 'Deep black panels, bright white highlights, and a strong outer glow around frames and the orb.',
    accent: 'Black glass / white glow',
    contrast: 'High contrast',
    colorScheme: 'dark',
  },
  {
    id: 'shadow-satin',
    label: 'Shadow Satin',
    description: 'Graphite surfaces with softer silver edges for a calmer, more matte desktop look.',
    accent: 'Graphite / satin silver',
    contrast: 'Balanced contrast',
    colorScheme: 'dark',
  },
  {
    id: 'olympian-marble',
    label: 'Olympian Marble',
    description: 'White marble surfaces with fine dark veins, brushed gold framing, and cooler silver support accents.',
    accent: 'Marble / gold leaf',
    contrast: 'Light luxury',
    colorScheme: 'light',
  },
  {
    id: 'retro-signal',
    label: 'Retro Signal',
    description: 'A warm CRT-inspired retro look with amber glow, teal edge light, and subtle scanline texture.',
    accent: 'Amber / phosphor teal',
    contrast: 'Retro neon',
    colorScheme: 'dark',
  },
];

export function normalizeDesignThemeId(value: string | null | undefined): DesignThemeId {
  return DESIGN_THEME_IDS.find((themeId) => themeId === value) ?? DEFAULT_DESIGN_THEME_ID;
}

export function getDesignThemeLabel(value: string | null | undefined): string {
  const normalized = normalizeDesignThemeId(value);
  return DESIGN_THEME_OPTIONS.find((theme) => theme.id === normalized)?.label ?? 'Obsidian Halo';
}

export function getDesignThemeOption(value: string | null | undefined): DesignThemeOption {
  const normalized = normalizeDesignThemeId(value);
  return DESIGN_THEME_OPTIONS.find((theme) => theme.id === normalized) ?? DESIGN_THEME_OPTIONS[0];
}

export async function applyDesignTheme(
  value: string | null | undefined,
  targetWindow?: Window,
): Promise<DesignThemeId> {
  const theme = getDesignThemeOption(value);
  document.documentElement.dataset.theme = theme.id;
  document.body.dataset.theme = theme.id;
  document.documentElement.style.colorScheme = theme.colorScheme;
  document.body.style.colorScheme = theme.colorScheme;

  try {
    await (targetWindow ?? getCurrentWindow()).setTheme(theme.colorScheme);
  } catch {
    // Window theming is best-effort for native chrome only.
  }

  return theme.id;
}
