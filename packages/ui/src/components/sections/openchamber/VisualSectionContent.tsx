import React from 'react';
import { OpenChamberVisualSettings, type VisibleSetting } from './OpenChamberVisualSettings';

// Section order comes from appearance/visibleSettings.ts; these lists only choose what a page shows.
const CHAT_SETTINGS: readonly VisibleSetting[] = [
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
    'fileViewerPreview',
    'queueMode',
];

const APPEARANCE_SETTINGS: readonly VisibleSetting[] = [
    'theme',
    ...CHAT_SETTINGS,
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
    'terminalQuickKeys',
];

// Appearance: every visual and chat preference, with the live preview.
export const VisualSectionContent: React.FC = () => (
    <OpenChamberVisualSettings visibleSettings={APPEARANCE_SETTINGS} preview />
);

// Chat section: message presentation, diff layout, status, reasoning, and queue behavior.
export const ChatSectionContent: React.FC = () => (
    <OpenChamberVisualSettings visibleSettings={CHAT_SETTINGS} />
);
