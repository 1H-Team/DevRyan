import { describe, expect, test } from 'bun:test';

import type { AuthPrincipal } from '@/lib/authSession';
import { isVisualSettingAllowedByPolicy } from '../visualSettingsPolicy';
import {
    APPEARANCE_SECTIONS,
    getAppearanceSections,
    type AppearanceEnvironment,
    type VisibleSetting,
} from './visibleSettings';

const ALL_SETTINGS = APPEARANCE_SECTIONS.flatMap((section) => section.rows);

const CHAT_SETTINGS: VisibleSetting[] = [
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

const desktopWeb: AppearanceEnvironment = {
    isMobile: false,
    isWebRuntime: true,
    isDesktopShell: false,
    isBrowserTab: true,
    supportsKeyboardResize: true,
};

const showAll = () => true;
const showOnly = (settings: VisibleSetting[]) => (setting: VisibleSetting) => settings.includes(setting);

const principal = (terminal: boolean): AuthPrincipal => ({
    id: 'appearance-sections-user',
    email: 'developer@example.test',
    displayName: 'Appearance Sections User',
    role: 'developer',
    scope: 'managed',
    policy: {
        settingsPages: ['appearance'],
        bots: true,
        files: false,
        terminal,
        browser: true,
        createWorktrees: false,
        createBranches: false,
        manageProjects: false,
        manageUsers: false,
        manageGlobalSettings: false,
        manageGit: true,
        push: false,
        github: false,
    },
    assignments: [],
});

describe('Appearance sections', () => {
    test('lists every setting exactly once', () => {
        expect(new Set(ALL_SETTINGS).size).toBe(ALL_SETTINGS.length);
    });

    test('renders all eight sections in order on desktop web', () => {
        const sections = getAppearanceSections(showAll, desktopWeb);

        expect(sections.map((section) => section.id)).toEqual([
            'theme',
            'typography',
            'layout',
            'conversation',
            'codeAndFiles',
            'composer',
            'regional',
            'mobileInstall',
        ]);
        expect(sections.find((section) => section.id === 'mobileInstall')?.rows)
            .toEqual(['inputBarOffset', 'mobileKeyboardMode', 'pwaInstallName', 'pwaOrientation']);
    });

    test('limits the Chat page to conversation, code, and composer sections', () => {
        expect(getAppearanceSections(showOnly(CHAT_SETTINGS), desktopWeb).map((section) => section.id))
            .toEqual(['conversation', 'codeAndFiles', 'composer']);

        const mobile = getAppearanceSections(showOnly(CHAT_SETTINGS), { ...desktopWeb, isMobile: true });
        expect(mobile.map((section) => section.id)).toEqual(['conversation', 'codeAndFiles', 'composer', 'mobileInstall']);
        expect(mobile.find((section) => section.id === 'mobileInstall')?.rows).toEqual(['mobileStatusBar']);
    });

    test('keeps desktop-only rows off phones and phone-only rows off desktop', () => {
        const mobileRows = getAppearanceSections(showAll, { ...desktopWeb, isMobile: true }).flatMap((section) => section.rows);
        expect(mobileRows).not.toContain('fontSize');
        expect(mobileRows).not.toContain('chatWidth');
        expect(mobileRows).not.toContain('terminalQuickKeys');
        expect(mobileRows).toContain('mobileStatusBar');

        const desktopRows = getAppearanceSections(showAll, desktopWeb).flatMap((section) => section.rows);
        expect(desktopRows).not.toContain('mobileStatusBar');
        expect(desktopRows).toContain('inputBarOffset');
    });

    test('drops install and keyboard rows in the desktop shell', () => {
        const rows = getAppearanceSections(showAll, { ...desktopWeb, isWebRuntime: false, isDesktopShell: true })
            .flatMap((section) => section.rows);

        expect(rows).not.toContain('pwaInstallName');
        expect(rows).not.toContain('pwaOrientation');
        expect(rows).not.toContain('mobileKeyboardMode');
    });

    test('hides the install name inside an installed web app', () => {
        const rows = getAppearanceSections(showAll, { ...desktopWeb, isBrowserTab: false }).flatMap((section) => section.rows);

        expect(rows).not.toContain('pwaInstallName');
        expect(rows).toContain('pwaOrientation');
    });

    test('removes terminal rows when the terminal capability is denied', () => {
        const denied = principal(false);
        const rows = getAppearanceSections((setting) => isVisualSettingAllowedByPolicy(setting, denied), desktopWeb)
            .flatMap((section) => section.rows);

        expect(rows).not.toContain('terminalFontSize');
        expect(rows).not.toContain('terminalQuickKeys');
        expect(rows).toContain('codeFont');
    });
});
