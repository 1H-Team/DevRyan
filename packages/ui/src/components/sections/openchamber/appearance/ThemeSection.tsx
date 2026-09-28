import React from 'react';
import { RiComputerLine, RiMoonLine, RiRefreshLine, RiSunLine } from '@remixicon/react';

import { SettingsBadge } from '@/components/sections/shared/SettingsBadge';
import { SettingsField } from '@/components/sections/shared/SettingsField';
import { SettingsOptionCardGroup, type SettingsOptionCard } from '@/components/sections/shared/SettingsOptionCardGroup';
import { Button } from '@/components/ui/button';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, themes as builtInThemes } from '@/lib/theme/themes';
import { cn } from '@/lib/utils';
import type { Theme, ThemeMode } from '@/types/theme';
import { formatThemeLabel, sortThemeOptions, THEME_MODE_OPTIONS, toOptionCards } from './appearanceOptions';
import { AppearanceSectionShell } from './controls';
import { ThemeSwatch } from './ThemeSwatch';

const THEME_MODE_ICONS: Record<ThemeMode, React.ReactNode> = {
    system: <RiComputerLine className="h-3.5 w-3.5" />,
    light: <RiSunLine className="h-3.5 w-3.5" />,
    dark: <RiMoonLine className="h-3.5 w-3.5" />,
};

const BUILT_IN_THEME_IDS = new Set(builtInThemes.map((theme) => theme.metadata.id));

const useThemeCards = (
    availableThemes: readonly Theme[],
    variant: 'light' | 'dark',
    customLabel: string,
): SettingsOptionCard<string>[] => React.useMemo(() => availableThemes
    .filter((theme) => theme.metadata.variant === variant)
    .sort(sortThemeOptions(variant === 'light' ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID))
    .map((theme) => ({
        value: theme.metadata.id,
        label: formatThemeLabel(theme.metadata.name, variant),
        illustration: <ThemeSwatch theme={theme} />,
        badge: BUILT_IN_THEME_IDS.has(theme.metadata.id) ? undefined : <SettingsBadge>{customLabel}</SettingsBadge>,
    })), [availableThemes, customLabel, variant]);

/** Falls back to the first card when the stored theme id is not available. */
const resolveSelectedTheme = (cards: readonly SettingsOptionCard<string>[], themeId: string): string => (
    cards.some((card) => card.value === themeId) ? themeId : cards[0]?.value ?? ''
);

export const ThemeSection = React.memo(function ThemeSection() {
    const { t } = useI18n();
    const {
        themeMode,
        setThemeMode,
        availableThemes,
        currentTheme,
        lightThemeId,
        darkThemeId,
        setLightThemePreference,
        setDarkThemePreference,
        customThemesLoading,
        reloadCustomThemes,
    } = useThemeSystem();

    const modeCards = React.useMemo(
        () => toOptionCards(THEME_MODE_OPTIONS, t, (mode) => ({ icon: THEME_MODE_ICONS[mode] })),
        [t],
    );
    const customLabel = t('settings.openchamber.visual.field.customThemeBadge');
    const lightCards = useThemeCards(availableThemes, 'light', customLabel);
    const darkCards = useThemeCards(availableThemes, 'dark', customLabel);
    const inUseBadge = <SettingsBadge tone="accent" dot>{t('settings.openchamber.visual.field.themeInUseBadge')}</SettingsBadge>;
    const activeVariant = currentTheme.metadata.variant;

    return (
        <AppearanceSectionShell
            title={t('settings.openchamber.visual.section.theme')}
            description={t('settings.openchamber.visual.section.themeDescription')}
            actions={(
                <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => void reloadCustomThemes()}
                    disabled={customThemesLoading}
                >
                    <RiRefreshLine className={cn('h-3.5 w-3.5', customThemesLoading && 'animate-spin')} aria-hidden="true" />
                    {customThemesLoading
                        ? t('settings.openchamber.visual.actions.reloadingThemes')
                        : t('settings.openchamber.visual.actions.reloadThemes')}
                </Button>
            )}
        >
            <SettingsField
                label={t('settings.openchamber.visual.field.colorMode')}
                description={t('settings.openchamber.visual.field.colorModeDescription')}
            >
                {({ labelId, describedBy }) => (
                    <SettingsOptionCardGroup
                        size="compact"
                        value={themeMode}
                        options={modeCards}
                        onValueChange={setThemeMode}
                        aria-labelledby={labelId}
                        aria-describedby={describedBy}
                    />
                )}
            </SettingsField>

            <SettingsField
                layout="stacked"
                label={t('settings.openchamber.visual.field.lightTheme')}
                description={t('settings.openchamber.visual.field.lightThemeDescription')}
                badge={activeVariant === 'light' ? inUseBadge : undefined}
            >
                {({ labelId, describedBy }) => (
                    <SettingsOptionCardGroup
                        columns={4}
                        value={resolveSelectedTheme(lightCards, lightThemeId)}
                        options={lightCards}
                        onValueChange={setLightThemePreference}
                        aria-labelledby={labelId}
                        aria-describedby={describedBy}
                    />
                )}
            </SettingsField>

            <SettingsField
                layout="stacked"
                label={t('settings.openchamber.visual.field.darkTheme')}
                description={t('settings.openchamber.visual.field.darkThemeDescription')}
                badge={activeVariant === 'dark' ? inUseBadge : undefined}
            >
                {({ labelId, describedBy }) => (
                    <SettingsOptionCardGroup
                        columns={4}
                        value={resolveSelectedTheme(darkCards, darkThemeId)}
                        options={darkCards}
                        onValueChange={setDarkThemePreference}
                        aria-labelledby={labelId}
                        aria-describedby={describedBy}
                    />
                )}
            </SettingsField>

            <p className="py-2.5 typography-micro text-muted-foreground">
                {t('settings.openchamber.visual.field.customThemesHint')}
            </p>
        </AppearanceSectionShell>
    );
});
