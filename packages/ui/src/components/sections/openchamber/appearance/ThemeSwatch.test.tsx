import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { themes } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import { formatThemeLabel } from './appearanceOptions';
import { ThemeSwatch } from './ThemeSwatch';

const baseTheme = themes[0] as Theme;

describe('ThemeSwatch', () => {
    test('paints the theme with color properties only', () => {
        const hostile: Theme = {
            ...baseTheme,
            colors: {
                ...baseTheme.colors,
                surface: { ...baseTheme.colors.surface, background: 'url(https://example.test/pixel.png)' },
            },
        };
        const markup = renderToStaticMarkup(<ThemeSwatch theme={hostile} />);

        expect(markup).toContain('data-theme-swatch');
        expect(markup).toContain(`background-color:${baseTheme.colors.primary.base}`);
        // A hostile value can only land in background-color, which browsers reject for url().
        expect(/(?:^|[;"])background:/.test(markup)).toBe(false);
        expect(markup).not.toContain('background-image');
    });

    test('drops the variant suffix from theme names', () => {
        expect(formatThemeLabel('Nord Dark', 'dark')).toBe('Nord');
        expect(formatThemeLabel('Nord Light', 'light')).toBe('Nord');
        expect(formatThemeLabel('Nord Dark', 'light')).toBe('Nord Dark');
    });
});
