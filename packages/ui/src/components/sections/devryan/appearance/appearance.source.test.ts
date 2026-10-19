import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string): string => readFileSync(resolve(directory, relativePath), 'utf8');

describe('Appearance source contracts', () => {
    test('keeps every direct settings write from the previous page', () => {
        const writes: Array<[string, string]> = [
            ['ConversationSection.tsx', 'updateDesktopSettings({ userMessageRenderingMode: mode })'],
            ['ConversationSection.tsx', 'updateDesktopSettings({ collapsibleUserMessages: enabled })'],
            ['ConversationSection.tsx', 'updateDesktopSettings({ stickyUserHeader: enabled })'],
            ['ConversationSection.tsx', 'updateDesktopSettings({ showSplitAssistantMessageActions: enabled })'],
            ['ConversationSection.tsx', 'updateDesktopSettings({ showToolFileIcons: enabled })'],
            ['ConversationSection.tsx', 'updateDesktopSettings({ showExpandedBashTools: enabled })'],
            ['ConversationSection.tsx', 'updateDesktopSettings({ showExpandedEditTools: enabled })'],
            ['CodeAndFilesSection.tsx', 'updateDesktopSettings({ mermaidRenderingMode: mode })'],
            ['CodeAndFilesSection.tsx', 'updateDesktopSettings({ defaultFileViewerPreview: enabled })'],
            ['RegionalSection.tsx', 'updateDesktopSettings({ timeFormatPreference: value })'],
            ['RegionalSection.tsx', 'updateDesktopSettings({ weekStartPreference: value })'],
            ['MobileInstallSection.tsx', 'updateDesktopSettings({ mobileKeyboardMode: mode })'],
            ['MobileInstallSection.tsx', 'updateDesktopSettings({ pwaAppName: persistedValue })'],
            ['MobileInstallSection.tsx', 'updateDesktopSettings({ pwaOrientation: normalized })'],
        ];

        for (const [file, write] of writes) {
            expect(read(file)).toContain(write);
        }
    });

    test('builds the preview from theme variables, not the real chat renderers', () => {
        const imports = ['AppearancePreview.tsx', 'optionIllustrations.tsx', 'ThemeSwatch.tsx']
            .flatMap((file) => [...read(file).matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? ''));

        expect(imports.length).toBeGreaterThan(0);
        for (const specifier of imports) {
            expect(/markdown|shiki|mermaid|diff|@\/components\/chat\//i.test(specifier)).toBe(false);
        }
    });

    test('keeps the appearance modules out of the eager settings page shell', () => {
        const page = read('../OpenChamberPage.tsx');

        expect(page).not.toContain('./appearance/');
        expect(page).not.toContain("from './OpenChamberVisualSettings'");
    });

    test('renders sections in DOM order without nested interactive rows', () => {
        const root = read('../OpenChamberVisualSettings.tsx');
        const sections = [
            'ThemeSection.tsx',
            'TypographySection.tsx',
            'LayoutSection.tsx',
            'ConversationSection.tsx',
            'CodeAndFilesSection.tsx',
            'ComposerSection.tsx',
            'RegionalSection.tsx',
            'MobileInstallSection.tsx',
        ].map(read).join('\n');

        expect(/\border-\d/.test(root)).toBe(false);
        expect(sections).not.toContain('role="button"');
        expect(sections).not.toContain('<Tooltip');
    });
});
