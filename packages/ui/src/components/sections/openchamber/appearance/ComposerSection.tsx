import React from 'react';

import { SettingsSwitchField } from '@/components/sections/shared/SettingsField';
import { useI18n } from '@/lib/i18n';
import { getModifierLabel } from '@/lib/utils';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { AppearanceSectionShell, type AppearanceSectionProps } from './controls';

export const ComposerSection = React.memo(function ComposerSection({ rows }: AppearanceSectionProps) {
    const { t } = useI18n();
    const queueModeEnabled = useMessageQueueStore((state) => state.queueModeEnabled);
    const setQueueMode = useMessageQueueStore((state) => state.setQueueMode);

    return (
        <AppearanceSectionShell
            title={t('settings.openchamber.visual.section.composer')}
            description={t('settings.openchamber.visual.section.composerDescription')}
        >
            {rows.includes('queueMode') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.queueMessagesByDefault')}
                    description={t('settings.openchamber.visual.field.queueMessagesByDefaultDescription', { modifier: getModifierLabel() })}
                    checked={queueModeEnabled}
                    onCheckedChange={setQueueMode}
                />
            )}
        </AppearanceSectionShell>
    );
});
