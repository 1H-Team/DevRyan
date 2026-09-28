import type { SettingsOptionCard } from '@/components/sections/shared/SettingsOptionCardGroup';
import type { I18nKey } from '@/lib/i18n';
import type { MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import type { ThemeMode } from '@/types/theme';

export interface AppearanceOption<T extends string> {
    id: T;
    labelKey: I18nKey;
    descriptionKey?: I18nKey;
}

export type PwaOrientation = 'system' | 'portrait' | 'landscape';
export type UserMessageRenderingMode = 'markdown' | 'plain';
export type DiffLayoutPreference = 'dynamic' | 'inline' | 'side-by-side';
export type DiffViewMode = 'single' | 'stacked';
export type MermaidRenderingMode = 'svg' | 'ascii';
export type TimeFormatPreference = 'auto' | '12h' | '24h';
export type WeekStartPreference = 'auto' | 'monday' | 'sunday';

export const DEFAULT_PWA_INSTALL_NAME = 'DevRyan - AI Coding Assistant';

export const THEME_MODE_OPTIONS: readonly AppearanceOption<ThemeMode>[] = [
    { id: 'system', labelKey: 'settings.openchamber.visual.option.themeMode.system' },
    { id: 'light', labelKey: 'settings.openchamber.visual.option.themeMode.light' },
    { id: 'dark', labelKey: 'settings.openchamber.visual.option.themeMode.dark' },
];

export const DIFF_LAYOUT_OPTIONS: readonly AppearanceOption<DiffLayoutPreference>[] = [
    {
        id: 'dynamic',
        labelKey: 'settings.openchamber.visual.option.diffLayout.dynamic.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.dynamic.description',
    },
    {
        id: 'inline',
        labelKey: 'settings.openchamber.visual.option.diffLayout.inline.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.inline.description',
    },
    {
        id: 'side-by-side',
        labelKey: 'settings.openchamber.visual.option.diffLayout.sideBySide.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.sideBySide.description',
    },
];

export const DIFF_VIEW_MODE_OPTIONS: readonly AppearanceOption<DiffViewMode>[] = [
    {
        id: 'single',
        labelKey: 'settings.openchamber.visual.option.diffViewMode.single.label',
        descriptionKey: 'settings.openchamber.visual.option.diffViewMode.single.description',
    },
    {
        id: 'stacked',
        labelKey: 'settings.openchamber.visual.option.diffViewMode.stacked.label',
        descriptionKey: 'settings.openchamber.visual.option.diffViewMode.stacked.description',
    },
];

export const MERMAID_RENDERING_OPTIONS: readonly AppearanceOption<MermaidRenderingMode>[] = [
    {
        id: 'svg',
        labelKey: 'settings.openchamber.visual.option.mermaidRendering.svg.label',
        descriptionKey: 'settings.openchamber.visual.option.mermaidRendering.svg.description',
    },
    {
        id: 'ascii',
        labelKey: 'settings.openchamber.visual.option.mermaidRendering.ascii.label',
        descriptionKey: 'settings.openchamber.visual.option.mermaidRendering.ascii.description',
    },
];

export const USER_MESSAGE_RENDERING_OPTIONS: readonly AppearanceOption<UserMessageRenderingMode>[] = [
    {
        id: 'markdown',
        labelKey: 'settings.openchamber.visual.option.userMessageRendering.markdown.label',
        descriptionKey: 'settings.openchamber.visual.option.userMessageRendering.markdown.description',
    },
    {
        id: 'plain',
        labelKey: 'settings.openchamber.visual.option.userMessageRendering.plain.label',
        descriptionKey: 'settings.openchamber.visual.option.userMessageRendering.plain.description',
    },
];

export const PWA_ORIENTATION_OPTIONS: readonly AppearanceOption<PwaOrientation>[] = [
    {
        id: 'system',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.system.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.system.description',
    },
    {
        id: 'portrait',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.portrait.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.portrait.description',
    },
    {
        id: 'landscape',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.landscape.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.landscape.description',
    },
];

export const MOBILE_KEYBOARD_MODE_OPTIONS: readonly AppearanceOption<MobileKeyboardMode>[] = [
    {
        id: 'native',
        labelKey: 'settings.openchamber.visual.option.mobileKeyboardMode.native.label',
        descriptionKey: 'settings.openchamber.visual.option.mobileKeyboardMode.native.description',
    },
    {
        id: 'resize-content',
        labelKey: 'settings.openchamber.visual.option.mobileKeyboardMode.resizeContent.label',
        descriptionKey: 'settings.openchamber.visual.option.mobileKeyboardMode.resizeContent.description',
    },
];

export const TIME_FORMAT_OPTIONS: readonly AppearanceOption<TimeFormatPreference>[] = [
    {
        id: 'auto',
        labelKey: 'settings.openchamber.visual.option.timeFormat.auto.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.auto.description',
    },
    {
        id: '24h',
        labelKey: 'settings.openchamber.visual.option.timeFormat.24h.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.24h.description',
    },
    {
        id: '12h',
        labelKey: 'settings.openchamber.visual.option.timeFormat.12h.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.12h.description',
    },
];

export const WEEK_START_OPTIONS: readonly AppearanceOption<WeekStartPreference>[] = [
    {
        id: 'auto',
        labelKey: 'settings.openchamber.visual.option.weekStart.auto.label',
        descriptionKey: 'settings.openchamber.visual.option.weekStart.auto.description',
    },
    { id: 'monday', labelKey: 'settings.openchamber.visual.option.weekStart.monday.label' },
    { id: 'sunday', labelKey: 'settings.openchamber.visual.option.weekStart.sunday.label' },
];

export const normalizePwaOrientation = (value: unknown): PwaOrientation => (
    value === 'portrait' || value === 'landscape' ? value : 'system'
);

/** Trims, collapses whitespace and caps the PWA install name at 64 characters. */
export const normalizePwaInstallName = (value: string): string => value.trim().replace(/\s+/g, ' ').slice(0, 64);

interface SortableTheme {
    metadata: { id: string; name: string };
}

/** Default theme first, then alphabetical. */
export const sortThemeOptions = (defaultThemeId: string) => (a: SortableTheme, b: SortableTheme): number => {
    if (a.metadata.id === defaultThemeId) return -1;
    if (b.metadata.id === defaultThemeId) return 1;
    return a.metadata.name.localeCompare(b.metadata.name);
};

/** Drops a trailing " Light" / " Dark" that the variant already implies. */
export const formatThemeLabel = (themeName: string, variant: 'light' | 'dark'): string => {
    const suffix = variant === 'dark' ? ' Dark' : ' Light';
    return themeName.endsWith(suffix) ? themeName.slice(0, -suffix.length) : themeName;
};

/** Maps option definitions to option cards, adding per-option decorations. */
export const toOptionCards = <T extends string>(
    options: readonly AppearanceOption<T>[],
    t: (key: I18nKey) => string,
    decorate?: (id: T) => Pick<SettingsOptionCard<T>, 'icon' | 'illustration'>,
): SettingsOptionCard<T>[] => options.map((option) => ({
    value: option.id,
    label: t(option.labelKey),
    description: option.descriptionKey ? t(option.descriptionKey) : undefined,
    ...decorate?.(option.id),
}));
