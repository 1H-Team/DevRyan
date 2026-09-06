import React from 'react';
import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';
import { AboutSettings } from './AboutSettings';
import { PasskeySettings } from './PasskeySettings';
import { DefaultsSettings } from './DefaultsSettings';
import { AgentModelDefaultsSettings } from './AgentModelDefaultsSettings';
import { GitSettings } from './GitSettings';
import { NotificationSettings } from './NotificationSettings';
import { VoiceSettings } from './VoiceSettings';
import { TunnelSettings } from './TunnelSettings';
import { OpenCodeCliSettings } from './OpenCodeCliSettings';
import { AgentBrowserControlSettings } from './AgentBrowserControlSettings';
import { DesktopKeepAwakeSettings } from './DesktopKeepAwakeSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import type { OpenChamberSection } from './types';

interface OpenChamberPageProps {
    /** Which section to display. If undefined, shows all sections (mobile/legacy behavior) */
    section?: OpenChamberSection;
}

export const OpenChamberPage: React.FC<OpenChamberPageProps> = ({ section }) => {
    const { isMobile } = useDeviceInfo();
    const showAbout = isMobile && isWebRuntime();

    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();

    // If no section specified, show all (mobile/legacy behavior)
    if (!section) {
        return (
            <ScrollableOverlay
                outerClassName="h-full"
                className="w-full"
            >
                <div className="openchamber-page-body mx-auto max-w-3xl space-y-3 p-3 sm:space-y-6 sm:p-6 sm:pt-8">
                    <OpenChamberVisualSettings />
                    <div className="border-t border-border/40 pt-6">
                        <DefaultsSettings />
                    </div>
                    <AgentModelDefaultsSettings />
                    {(
                        <div className="border-t border-border/40 pt-6">
                            <OpenCodeCliSettings />
                        </div>
                    )}
                    {showDesktopNetworkSettings && (
                        <div className="border-t border-border/40 pt-6">
                            <DesktopKeepAwakeSettings />
                            <AgentBrowserControlSettings />
                            <DesktopNetworkSettings />
                        </div>
                    )}
                    <div className="border-t border-border/40 pt-6">
                        <PasskeySettings />
                    </div>
                    {showAbout && (
                        <div className="border-t border-border/40 pt-6">
                            <AboutSettings />
                        </div>
                    )}
                </div>
            </ScrollableOverlay>
        );
    }

    // Show specific section content
    const renderSectionContent = () => {
        switch (section) {
            case 'visual':
                return <VisualSectionContent />;
            case 'chat':
                return <ChatSectionContent />;
            case 'sessions':
                return <SessionsSectionContent />;
            case 'shortcuts':
                return <ShortcutsSectionContent />;
            case 'git':
                return <GitSectionContent />;
            case 'notifications':
                return <NotificationSectionContent />;
            case 'voice':
                return <VoiceSectionContent />;
            case 'tunnel':
                return <TunnelSectionContent />;
            default:
                return null;
        }
    };

    return (
        <ScrollableOverlay
            outerClassName="h-full"
            className="w-full"
        >
            <div className="openchamber-page-body mx-auto max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8">
                {renderSectionContent()}
            </div>
        </ScrollableOverlay>
    );
};

const ShortcutsSectionContent: React.FC = () => {
    return <KeyboardShortcutsSettings />;
};

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
const VisualSectionContent: React.FC = () => {

    return <OpenChamberVisualSettings visibleSettings={[
        'theme',
        'userMessageRendering',
        'mermaidRendering',
        'reasoning',
        'showToolFileIcons',
        'expandedTools',
        'collapsibleUserMessages',
        'stickyUserHeader',
        'splitAssistantMessageActions',
        'diffLayout',
        'mobileStatusBar',
        'dotfiles',
        'queueMode',
        'pwaInstallName',
        'pwaOrientation',
        'mobileKeyboardMode',
        'timeFormat',
        'weekStart',
        'fontSize',
        'chatWidth',
        'codeFont',
        'terminalFontSize',
        'spacing',
        'inputBarOffset',
        ...(['terminalQuickKeys' as const]),
    ]} />;
};

// Chat section: message presentation, diff layout, status, reasoning, and queue behavior.
const ChatSectionContent: React.FC = () => {
    return <OpenChamberVisualSettings visibleSettings={['userMessageRendering', 'mermaidRendering', 'reasoning', 'showToolFileIcons', 'expandedTools', 'collapsibleUserMessages', 'stickyUserHeader', 'splitAssistantMessageActions', 'diffLayout', 'mobileStatusBar', 'dotfiles', 'queueMode']} />;
};

// Sessions section: Default model & agent
const SessionsSectionContent: React.FC = () => {

    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();
    return (
        <div className="space-y-6">
            <DefaultsSettings />
            <AgentModelDefaultsSettings />
            {(
                <div className="border-t border-border/40 pt-6">
                    <OpenCodeCliSettings />
                </div>
            )}
            {showDesktopNetworkSettings && (
                <div className="border-t border-border/40 pt-6">
                    <DesktopKeepAwakeSettings />
                    <AgentBrowserControlSettings />
                    <DesktopNetworkSettings />
                </div>
            )}
        </div>
    );
};

// Git section: Commit message model, Worktree settings
const GitSectionContent: React.FC = () => {
    return (
        <div className="space-y-6">
            <GitSettings />
        </div>
    );
};

// Notifications section: Native browser notifications
const NotificationSectionContent: React.FC = () => {
    return <NotificationSettings />;
};

// Voice section: Language selection and voice settings
const VoiceSectionContent: React.FC = () => {

    return <VoiceSettings />;
};

const TunnelSectionContent: React.FC = () => {

    return <TunnelSettings />;
};
