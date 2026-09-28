import React from 'react';

import { SettingsField, SettingsSwitchField } from '@/components/sections/shared/SettingsField';
import { SettingsOptionCardGroup } from '@/components/sections/shared/SettingsOptionCardGroup';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import { toOptionCards, USER_MESSAGE_RENDERING_OPTIONS, type UserMessageRenderingMode } from './appearanceOptions';
import { AppearanceSectionShell, type AppearanceSectionProps } from './controls';
import { UserMessageIllustration } from './optionIllustrations';

export const ConversationSection = React.memo(function ConversationSection({ rows }: AppearanceSectionProps) {
    const { t } = useI18n();
    const userMessageRenderingMode = useUIStore((state) => state.userMessageRenderingMode);
    const setUserMessageRenderingMode = useUIStore((state) => state.setUserMessageRenderingMode);
    const collapsibleUserMessages = useUIStore((state) => state.collapsibleUserMessages);
    const setCollapsibleUserMessages = useUIStore((state) => state.setCollapsibleUserMessages);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const setStickyUserHeader = useUIStore((state) => state.setStickyUserHeader);
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const setShowReasoningTraces = useUIStore((state) => state.setShowReasoningTraces);
    const showSplitAssistantMessageActions = useUIStore((state) => state.showSplitAssistantMessageActions);
    const setShowSplitAssistantMessageActions = useUIStore((state) => state.setShowSplitAssistantMessageActions);
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const setShowToolFileIcons = useUIStore((state) => state.setShowToolFileIcons);
    const showExpandedBashTools = useUIStore((state) => state.showExpandedBashTools);
    const setShowExpandedBashTools = useUIStore((state) => state.setShowExpandedBashTools);
    const showExpandedEditTools = useUIStore((state) => state.showExpandedEditTools);
    const setShowExpandedEditTools = useUIStore((state) => state.setShowExpandedEditTools);

    const handleUserMessageRenderingModeChange = React.useCallback((mode: UserMessageRenderingMode) => {
        setUserMessageRenderingMode(mode);
        void updateDesktopSettings({ userMessageRenderingMode: mode });
    }, [setUserMessageRenderingMode]);

    const handleCollapsibleUserMessagesChange = React.useCallback((enabled: boolean) => {
        setCollapsibleUserMessages(enabled);
        void updateDesktopSettings({ collapsibleUserMessages: enabled });
    }, [setCollapsibleUserMessages]);

    const handleStickyUserHeaderChange = React.useCallback((enabled: boolean) => {
        setStickyUserHeader(enabled);
        void updateDesktopSettings({ stickyUserHeader: enabled });
    }, [setStickyUserHeader]);

    const handleShowSplitAssistantMessageActionsChange = React.useCallback((enabled: boolean) => {
        setShowSplitAssistantMessageActions(enabled);
        void updateDesktopSettings({ showSplitAssistantMessageActions: enabled });
    }, [setShowSplitAssistantMessageActions]);

    const handleShowToolFileIconsChange = React.useCallback((enabled: boolean) => {
        setShowToolFileIcons(enabled);
        void updateDesktopSettings({ showToolFileIcons: enabled });
    }, [setShowToolFileIcons]);

    const handleShowExpandedBashToolsChange = React.useCallback((enabled: boolean) => {
        setShowExpandedBashTools(enabled);
        void updateDesktopSettings({ showExpandedBashTools: enabled });
    }, [setShowExpandedBashTools]);

    const handleShowExpandedEditToolsChange = React.useCallback((enabled: boolean) => {
        setShowExpandedEditTools(enabled);
        void updateDesktopSettings({ showExpandedEditTools: enabled });
    }, [setShowExpandedEditTools]);

    const userMessageCards = React.useMemo(() => {
        const sample = t('settings.openchamber.visual.option.userMessageRendering.sample');
        return toOptionCards(USER_MESSAGE_RENDERING_OPTIONS, t, (mode) => ({
            illustration: <UserMessageIllustration mode={mode} sample={sample} />,
        }));
    }, [t]);

    return (
        <AppearanceSectionShell
            title={t('settings.openchamber.visual.section.conversation')}
            description={t('settings.openchamber.visual.section.conversationDescription')}
        >
            {rows.includes('userMessageRendering') && (
                <SettingsField
                    layout="stacked"
                    label={t('settings.openchamber.visual.section.userMessageRendering')}
                    description={t('settings.openchamber.visual.field.userMessageRenderingDescription')}
                >
                    {({ labelId, describedBy }) => (
                        <SettingsOptionCardGroup
                            columns={2}
                            value={userMessageRenderingMode}
                            options={userMessageCards}
                            onValueChange={handleUserMessageRenderingModeChange}
                            aria-labelledby={labelId}
                            aria-describedby={describedBy}
                        />
                    )}
                </SettingsField>
            )}

            {rows.includes('collapsibleUserMessages') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.collapsibleUserMessages')}
                    description={t('settings.openchamber.visual.field.collapsibleUserMessagesDescription')}
                    checked={collapsibleUserMessages}
                    onCheckedChange={handleCollapsibleUserMessagesChange}
                />
            )}

            {rows.includes('stickyUserHeader') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.stickyUserHeader')}
                    description={t('settings.openchamber.visual.field.stickyUserHeaderDescription')}
                    checked={stickyUserHeader}
                    onCheckedChange={handleStickyUserHeaderChange}
                />
            )}

            {rows.includes('reasoning') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.showReasoningTraces')}
                    description={t('settings.openchamber.visual.field.showReasoningTracesDescription')}
                    checked={showReasoningTraces}
                    onCheckedChange={setShowReasoningTraces}
                />
            )}

            {rows.includes('splitAssistantMessageActions') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.showSplitAssistantMessageActions')}
                    description={t('settings.openchamber.visual.field.showSplitAssistantMessageActionsDescription')}
                    checked={showSplitAssistantMessageActions}
                    onCheckedChange={handleShowSplitAssistantMessageActionsChange}
                />
            )}

            {rows.includes('showToolFileIcons') && (
                <SettingsSwitchField
                    label={t('settings.openchamber.visual.field.showToolFileIcons')}
                    description={t('settings.openchamber.visual.field.showToolFileIconsDescription')}
                    checked={showToolFileIcons}
                    onCheckedChange={handleShowToolFileIconsChange}
                />
            )}

            {rows.includes('expandedTools') && (
                <>
                    <SettingsSwitchField
                        label={t('settings.openchamber.visual.field.expandBashTools')}
                        description={t('settings.openchamber.visual.field.expandBashToolsDescription')}
                        checked={showExpandedBashTools}
                        onCheckedChange={handleShowExpandedBashToolsChange}
                    />
                    <SettingsSwitchField
                        label={t('settings.openchamber.visual.field.expandEditTools')}
                        description={t('settings.openchamber.visual.field.expandEditToolsDescription')}
                        checked={showExpandedEditTools}
                        onCheckedChange={handleShowExpandedEditToolsChange}
                    />
                </>
            )}
        </AppearanceSectionShell>
    );
});
