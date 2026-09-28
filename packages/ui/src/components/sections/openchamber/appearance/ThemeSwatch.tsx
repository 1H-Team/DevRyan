import React from 'react';

import type { Theme } from '@/types/theme';

interface ThemeSwatchProps {
    theme: Theme;
}

/**
 * Miniature app window painted with a theme's own colors, so every palette can
 * be compared without applying it. Only color properties are set from theme
 * data; custom theme strings never reach a `background` shorthand.
 */
export const ThemeSwatch = React.memo(function ThemeSwatch({ theme }: ThemeSwatchProps) {
    const { surface, primary, interactive, syntax, status } = theme.colors;
    const accents = [syntax.base.keyword, syntax.base.string, syntax.base.function, status.success];

    return (
        <span
            className="flex h-14 w-full overflow-hidden rounded-md border"
            style={{ backgroundColor: surface.background, borderColor: interactive.border }}
            data-theme-swatch
        >
            <span className="flex w-1/4 flex-col gap-1 p-1.5" style={{ backgroundColor: surface.muted }}>
                <span className="h-1 w-full rounded-full" style={{ backgroundColor: primary.base }} />
                <span className="h-1 w-3/4 rounded-full" style={{ backgroundColor: surface.mutedForeground, opacity: 0.45 }} />
                <span className="h-1 w-full rounded-full" style={{ backgroundColor: surface.mutedForeground, opacity: 0.45 }} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col justify-between p-1.5">
                <span
                    className="ml-auto h-2.5 w-3/5 rounded-sm border"
                    style={{ backgroundColor: surface.elevated, borderColor: interactive.border }}
                />
                <span className="flex flex-col gap-1">
                    <span className="h-1 w-4/5 rounded-full" style={{ backgroundColor: surface.foreground, opacity: 0.75 }} />
                    <span className="flex gap-1">
                        {accents.map((color, index) => (
                            <span key={index} className="h-1 flex-1 rounded-full" style={{ backgroundColor: color }} />
                        ))}
                    </span>
                </span>
            </span>
        </span>
    );
});
