export type VisibleSetting =
    | 'theme'
    | 'pwaInstallName'
    | 'pwaOrientation'
    | 'mobileKeyboardMode'
    | 'timeFormat'
    | 'weekStart'
    | 'fontSize'
    | 'chatWidth'
    | 'codeFont'
    | 'terminalFontSize'
    | 'spacing'
    | 'inputBarOffset'
    | 'mermaidRendering'
    | 'userMessageRendering'
    | 'collapsibleUserMessages'
    | 'stickyUserHeader'
    | 'splitAssistantMessageActions'
    | 'diffLayout'
    | 'mobileStatusBar'
    | 'dotfiles'
    | 'fileViewerPreview'
    | 'reasoning'
    | 'showToolFileIcons'
    | 'expandedTools'
    | 'queueMode'
    | 'terminalQuickKeys';

export type AppearanceSectionId =
    | 'theme'
    | 'typography'
    | 'layout'
    | 'conversation'
    | 'codeAndFiles'
    | 'composer'
    | 'regional'
    | 'mobileInstall';

export interface AppearanceEnvironment {
    isMobile: boolean;
    isWebRuntime: boolean;
    isDesktopShell: boolean;
    /** The web app runs in a browser tab rather than as an installed PWA. */
    isBrowserTab: boolean;
    supportsKeyboardResize: boolean;
}

export interface AppearanceSectionPlan {
    id: AppearanceSectionId;
    rows: readonly VisibleSetting[];
}

/** Section order and the settings each section renders, in on-screen order. */
export const APPEARANCE_SECTIONS: readonly AppearanceSectionPlan[] = [
    { id: 'theme', rows: ['theme'] },
    // `fontSize` covers both Interface Font and Interface Font Size.
    { id: 'typography', rows: ['fontSize', 'codeFont', 'terminalFontSize'] },
    { id: 'layout', rows: ['chatWidth', 'spacing'] },
    {
        id: 'conversation',
        rows: [
            'userMessageRendering',
            'collapsibleUserMessages',
            'stickyUserHeader',
            'reasoning',
            'splitAssistantMessageActions',
            'showToolFileIcons',
            'expandedTools',
        ],
    },
    // `diffLayout` covers both Diff Layout and Diff View Mode.
    { id: 'codeAndFiles', rows: ['diffLayout', 'mermaidRendering', 'fileViewerPreview', 'dotfiles', 'terminalQuickKeys'] },
    { id: 'composer', rows: ['queueMode'] },
    { id: 'regional', rows: ['timeFormat', 'weekStart'] },
    { id: 'mobileInstall', rows: ['mobileStatusBar', 'inputBarOffset', 'mobileKeyboardMode', 'pwaInstallName', 'pwaOrientation'] },
];

/** Whether a setting applies to the current device and host, independent of policy. */
export const isSettingAvailable = (setting: VisibleSetting, env: AppearanceEnvironment): boolean => {
    switch (setting) {
        case 'fontSize':
        case 'chatWidth':
        case 'terminalQuickKeys':
            return !env.isMobile;
        case 'mobileStatusBar':
            return env.isMobile;
        case 'pwaInstallName':
            return env.isWebRuntime && env.isBrowserTab && !env.isDesktopShell;
        case 'pwaOrientation':
            return env.isWebRuntime && !env.isDesktopShell;
        case 'mobileKeyboardMode':
            return env.isWebRuntime && !env.isDesktopShell && env.supportsKeyboardResize;
        default:
            return true;
    }
};

/** Non-empty sections, in order, for the settings a page shows and the host supports. */
export const getAppearanceSections = (
    isShown: (setting: VisibleSetting) => boolean,
    env: AppearanceEnvironment,
): AppearanceSectionPlan[] => APPEARANCE_SECTIONS
    .map((section) => ({
        id: section.id,
        rows: section.rows.filter((setting) => isShown(setting) && isSettingAvailable(setting, env)),
    }))
    .filter((section) => section.rows.length > 0);
