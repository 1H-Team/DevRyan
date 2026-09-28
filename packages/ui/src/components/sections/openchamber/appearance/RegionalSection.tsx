import React from 'react';

import { SettingsField } from '@/components/sections/shared/SettingsField';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import {
    TIME_FORMAT_OPTIONS,
    WEEK_START_OPTIONS,
    type TimeFormatPreference,
    type WeekStartPreference,
} from './appearanceOptions';
import { AppearanceSectionShell, OptionSelect, type AppearanceSectionProps } from './controls';

export const RegionalSection = React.memo(function RegionalSection({ rows }: AppearanceSectionProps) {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const setTimeFormatPreference = useUIStore((state) => state.setTimeFormatPreference);
    const weekStartPreference = useUIStore((state) => state.weekStartPreference);
    const setWeekStartPreference = useUIStore((state) => state.setWeekStartPreference);

    const handleTimeFormatPreferenceChange = React.useCallback((value: TimeFormatPreference) => {
        setTimeFormatPreference(value);
        void updateDesktopSettings({ timeFormatPreference: value });
    }, [setTimeFormatPreference]);

    const handleWeekStartPreferenceChange = React.useCallback((value: WeekStartPreference) => {
        setWeekStartPreference(value);
        void updateDesktopSettings({ weekStartPreference: value });
    }, [setWeekStartPreference]);

    return (
        <AppearanceSectionShell
            title={t('settings.openchamber.visual.section.regional')}
            description={t('settings.openchamber.visual.section.regionalDescription')}
        >
            {rows.includes('timeFormat') && (
                <SettingsField
                    label={t('settings.openchamber.visual.field.timeFormat')}
                    description={t('settings.openchamber.visual.field.timeFormatDescription')}
                >
                    {({ labelId, describedBy }) => (
                        <OptionSelect
                            value={timeFormatPreference}
                            options={TIME_FORMAT_OPTIONS}
                            onValueChange={handleTimeFormatPreferenceChange}
                            labelId={labelId}
                            describedBy={describedBy}
                        />
                    )}
                </SettingsField>
            )}

            {rows.includes('weekStart') && (
                <SettingsField
                    label={t('settings.openchamber.visual.field.weekStartsOn')}
                    description={t('settings.openchamber.visual.field.weekStartsOnDescription')}
                >
                    {({ labelId, describedBy }) => (
                        <OptionSelect
                            value={weekStartPreference}
                            options={WEEK_START_OPTIONS}
                            onValueChange={handleWeekStartPreferenceChange}
                            labelId={labelId}
                            describedBy={describedBy}
                        />
                    )}
                </SettingsField>
            )}
        </AppearanceSectionShell>
    );
});
