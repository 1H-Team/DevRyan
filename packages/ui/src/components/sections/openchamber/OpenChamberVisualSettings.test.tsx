import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { I18nProvider } from '@/lib/i18n';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, themes } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';

const darkTheme = themes.find((theme) => theme.metadata.id === DEFAULT_DARK_THEME_ID) as Theme;

const themeContext: ThemeContextValue = {
    currentTheme: darkTheme,
    availableThemes: themes,
    setTheme: () => {},
    customThemesLoading: false,
    reloadCustomThemes: async () => {},
    isSystemPreference: true,
    setSystemPreference: () => {},
    themeMode: 'system',
    setThemeMode: () => {},
    lightThemeId: DEFAULT_LIGHT_THEME_ID,
    darkThemeId: DEFAULT_DARK_THEME_ID,
    setLightThemePreference: () => {},
    setDarkThemePreference: () => {},
};

const render = (node: React.ReactNode): string => renderToStaticMarkup(
    <I18nProvider>
        <ThemeSystemContext.Provider value={themeContext}>{node}</ThemeSystemContext.Provider>
    </I18nProvider>,
);

const headings = (markup: string): string[] => [...markup.matchAll(/<h3[^>]*>([^<]+)</g)].map((match) => match[1] ?? '');

describe('OpenChamberVisualSettings', () => {
    test('renders titled sections in on-screen order with the live preview', () => {
        const markup = render(<OpenChamberVisualSettings preview />);

        expect(headings(markup)).toEqual([
            'Theme',
            'Typography',
            'Layout',
            'Conversation',
            'Code &amp; Files',
            'Composer',
            'Regional',
            'Mobile &amp; Install',
        ]);
        expect(markup).toContain('data-appearance-preview');
        expect(markup).toContain('aria-label="Appearance Preview"');
    });

    test('describes every setting and uses no nested button rows', () => {
        const markup = render(<OpenChamberVisualSettings preview />);
        const fields = markup.split('data-settings-field').slice(1);

        expect(fields.length).toBeGreaterThan(20);
        for (const field of fields) {
            expect(field.slice(0, 1600)).toContain('typography-meta text-muted-foreground');
        }
        expect(markup).not.toContain('role="button"');
    });

    test('shows theme cards with each theme painted in its own colors', () => {
        const markup = render(<OpenChamberVisualSettings preview />);

        expect(markup.match(/data-theme-swatch/g)?.length).toBe(themes.length);
        expect(markup).toContain('In Use');
    });

    test('keeps the Chat page to chat sections without the preview', () => {
        const markup = render(
            <OpenChamberVisualSettings visibleSettings={['userMessageRendering', 'diffLayout', 'dotfiles', 'queueMode']} />,
        );

        expect(headings(markup)).toEqual(['Conversation', 'Code &amp; Files', 'Composer']);
        expect(markup).not.toContain('data-appearance-preview');
    });
});
