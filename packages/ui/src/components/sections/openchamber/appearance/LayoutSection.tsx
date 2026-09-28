import React from 'react';

import { SettingsField } from '@/components/sections/shared/SettingsField';
import { Slider } from '@/components/ui/slider';
import { CHAT_WIDTH_STEP, MAX_CHAT_WIDTH, MIN_CHAT_WIDTH } from '@/lib/chatLayout';
import { useI18n } from '@/lib/i18n';
import { useSettingsPagePermission } from '@/lib/settings/permission-state';
import { useUIStore } from '@/stores/useUIStore';
import { APPEARANCE_DEFAULTS, SPACING_RANGE } from './appearanceDefaults';
import { AppearanceSectionShell, UnitNumberInput, type AppearanceSectionProps } from './controls';

const formatPixels = (value: number): string => `${value}px`;

export const LayoutSection = React.memo(function LayoutSection({ rows }: AppearanceSectionProps) {
    const { t } = useI18n();
    const { canEdit } = useSettingsPagePermission();
    const chatWidth = useUIStore((state) => state.chatWidth);
    const setChatWidth = useUIStore((state) => state.setChatWidth);
    const padding = useUIStore((state) => state.padding);
    const setPadding = useUIStore((state) => state.setPadding);

    return (
        <AppearanceSectionShell
            title={t('settings.openchamber.visual.section.layout')}
            description={t('settings.openchamber.visual.section.layoutDescription')}
        >
            {rows.includes('chatWidth') && (
                <SettingsField
                    labelTargetsControl
                    label={t('settings.openchamber.visual.field.chatWidth')}
                    description={t('settings.openchamber.visual.field.chatWidthDescription')}
                    reset={{
                        onReset: () => setChatWidth(APPEARANCE_DEFAULTS.chatWidth),
                        disabled: chatWidth === APPEARANCE_DEFAULTS.chatWidth,
                        ariaLabel: t('settings.openchamber.visual.actions.resetChatWidthAria'),
                    }}
                >
                    {({ controlId, describedBy }) => (
                        <Slider
                            id={controlId}
                            value={chatWidth}
                            onChange={setChatWidth}
                            min={MIN_CHAT_WIDTH}
                            max={MAX_CHAT_WIDTH}
                            step={CHAT_WIDTH_STEP}
                            disabled={!canEdit}
                            className="w-56"
                            valueFormatter={formatPixels}
                            valueText={t('settings.openchamber.visual.field.chatWidthValueText', { value: chatWidth })}
                            aria-describedby={describedBy}
                        />
                    )}
                </SettingsField>
            )}

            {rows.includes('spacing') && (
                <SettingsField
                    label={t('settings.openchamber.visual.field.spacingDensity')}
                    description={t('settings.openchamber.visual.field.spacingDensityDescription')}
                    reset={{
                        onReset: () => setPadding(APPEARANCE_DEFAULTS.padding),
                        disabled: padding === APPEARANCE_DEFAULTS.padding,
                        ariaLabel: t('settings.openchamber.visual.actions.resetSpacingAria'),
                    }}
                >
                    {({ labelId, describedBy }) => (
                        <UnitNumberInput
                            value={padding}
                            onValueChange={setPadding}
                            {...SPACING_RANGE}
                            unit="%"
                            ariaLabel={t('settings.openchamber.visual.field.spacingDensityAria')}
                            labelId={labelId}
                            describedBy={describedBy}
                        />
                    )}
                </SettingsField>
            )}
        </AppearanceSectionShell>
    );
});
