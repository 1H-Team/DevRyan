import React from 'react';

import { SettingsField, SettingsSwitchField } from '@/components/sections/shared/SettingsField';
import { SettingsOptionCardGroup } from '@/components/sections/shared/SettingsOptionCardGroup';
import { setDirectoryShowHidden, useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import {
    DIFF_LAYOUT_OPTIONS,
    DIFF_VIEW_MODE_OPTIONS,
    MERMAID_RENDERING_OPTIONS,
    toOptionCards,
    type MermaidRenderingMode,
} from './appearanceOptions';
import { AppearanceSectionShell, type AppearanceSectionProps } from './controls';
import { DiffLayoutIllustration, DiffViewModeIllustration, MermaidIllustration } from './optionIllustrations';

const handleDirectoryShowHiddenChange = (enabled: boolean) => {
    setDirectoryShowHidden(enabled);
};

export const CodeAndFilesSection = React.memo(function CodeAndFilesSection({ rows }: AppearanceSectionProps) {
    const { t } = useI18n();
    const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
    const setDiffLayoutPreference = useUIStore((state) => state.setDiffLayoutPreference);
    const diffViewMode = useUIStore((state) => state.diffViewMode);
    const setDiffViewMode = useUIStore((state) => state.setDiffViewMode);
    const mermaidRenderingMode = useUIStore((state) => state.mermaidRenderingMode);
    const setMermaidRenderingMode = useUIStore((state) => state.setMermaidRenderingMode);
    const showTerminalQuickKeysOnDesktop = useUIStore((state) => state.showTerminalQuickKeysOnDesktop);
    const setShowTerminalQuickKeysOnDesktop = useUIStore((state) => state.setShowTerminalQuickKeysOnDesktop);
    const defaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
    const setDefaultFileViewerPreview = useConfigStore((state) => state.setSettingsDefaultFileViewerPreview);
    const directoryShowHidden = useDirectoryShowHidden();

    const handleMermaidRenderingModeChange = React.useCallback((mode: MermaidRenderingMode) => {
        setMermaidRenderingMode(mode);
        void updateDesktopSettings({ mermaidRenderingMode: mode });
    }, [setMermaidRenderingMode]);

    const handleDefaultFileViewerPreviewChange = React.useCallback((enabled: boolean) => {
        setDefaultFileViewerPreview(enabled);
        void updateDesktopSettings({ defaultFileViewerPreview: enabled });
    }, [setDefaultFileViewerPreview]);

    const diffLayoutCards = React.useMemo(
        () => toOptionCards(DIFF_LAYOUT_OPTIONS, t, (layout) => ({ illustration: <DiffLayoutIllustration layout={layout} /> })),
        [t],
    );
    const diffViewModeCards = React.useMemo(
        () => toOptionCards(DIFF_VIEW_MODE_OPTIONS, t, (mode) => ({ illustration: <DiffViewModeIllustration mode={mode} /> })),
        [t],
    );
    const mermaidCards = React.useMemo(
        () => toOptionCards(MERMAID_RENDERING_OPTIONS, t, (mode) => ({ illustration: <MermaidIllustration mode={mode} /> })),
        [t],
    );

    return (
        <AppearanceSectionShell
            title={t('settings.openchamber.visual.section.codeAndFiles')}
            description={t('settings.openchamber.visual.section.codeAndFilesDescription')}
        >
            {rows.includes('diffLayout') && (
                <>
                    <SettingsField
                        layout="stacked"
                        label={t('settings.openchamber.visual.section.diffLayout')}
                        description={t('settings.openchamber.visual.field.diffLayoutDescription')}
                    >
                        {({ labelId, describedBy }) => (
                            <SettingsOptionCardGroup
                                columns={3}
                                value={diffLayoutPreference}
                                options={diffLayoutCards}
                                onValueChange={setDiffLayoutPreference}
                                aria-labelledby={labelId}
                                aria-describedby={describedBy}
                            />
                        )}
                    </SettingsField>
                    <SettingsField
                        layout="stacked"
                        label={t('settings.openchamber.visual.section.diffViewMode')}
                        description={t('settings.openchamber.visual.field.diffViewModeDescription')}
                    >
                        {({ labelId, describedBy }) => (
                            <SettingsOptionCardGroup
                                columns={2}
                                value={diffViewMode}
                                options={diffViewModeCards}
                                onValueChange={setDiffViewMode}
                                aria-labelledby={labelId}
                                aria-describedby={describedBy}
                            />
                        )}
                    </SettingsField>
                </>
            )}

            {rows.includes('mermaidRendering') && (
                <SettingsField
                    layout="stacked"
                    label={t('settings.openchamber.visual.section.mermaidRendering')}
                    description={t('settings.openchamber.visual.field.mermaidRenderingDescription')}
                >
                    {({ labelId, describedBy }) => (
                        <SettingsOptionCardGroup
                            columns={2}
                            value={mermaidRenderingMode}
                            options={mermaidCards}
                            onValueChange={handleMermaidRenderingModeChange}
                            aria-labelledby={labelId}
                            aria-describedby={describedBy}
                        />
                    )}
                </SettingsField>
            )}

            {rows.includes('fileViewerPreview') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.defaults.field.openFilesPreview')}
                    description={t('settings.openchamber.visual.field.openFilesPreviewDescription')}
                    checked={defaultFileViewerPreview}
                    onCheckedChange={handleDefaultFileViewerPreviewChange}
                />
            )}

            {rows.includes('dotfiles') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.showDotfiles')}
                    description={t('settings.openchamber.visual.field.showDotfilesDescription')}
                    checked={directoryShowHidden}
                    onCheckedChange={handleDirectoryShowHiddenChange}
                />
            )}

            {rows.includes('terminalQuickKeys') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.terminalQuickKeys')}
                    description={t('settings.openchamber.visual.field.terminalQuickKeysDescription')}
                    checked={showTerminalQuickKeysOnDesktop}
                    onCheckedChange={setShowTerminalQuickKeysOnDesktop}
                />
            )}
        </AppearanceSectionShell>
    );
});
