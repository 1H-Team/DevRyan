import React from 'react';
import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
export const VisualSectionContent: React.FC = () => {

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
export const ChatSectionContent: React.FC = () => {
    return <OpenChamberVisualSettings visibleSettings={['userMessageRendering', 'mermaidRendering', 'reasoning', 'showToolFileIcons', 'expandedTools', 'collapsibleUserMessages', 'stickyUserHeader', 'splitAssistantMessageActions', 'diffLayout', 'mobileStatusBar', 'dotfiles', 'queueMode']} />;
};
