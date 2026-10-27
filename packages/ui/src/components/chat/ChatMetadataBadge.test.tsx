import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import { ChatMetadataBadge } from './ChatMetadataBadge';

describe('ChatMetadataBadge', () => {
    test('does not push the thinking label below the model label baseline', () => {
        const markup = renderToStaticMarkup(
            <ChatMetadataBadge kind="model" label="GPT" thinkingLabel="High" />,
        );

        expect(markup).toContain('inline-flex min-w-0 items-baseline gap-1 leading-none');
        expect(markup).toContain('max-w-[96px]');
        expect(markup).toContain('text-[10px]');
        expect(markup).not.toContain('translate-y-px');
    });

    test('renders a trailing icon after the thinking label', () => {
        const markup = renderToStaticMarkup(
            <ChatMetadataBadge
                kind="model"
                label="GPT"
                thinkingLabel="High"
                trailingIcon={<i data-testid="trailing" />}
            />,
        );

        expect(markup).toContain('data-testid="trailing"');
        expect(markup.indexOf('High')).toBeGreaterThan(-1);
        expect(markup.indexOf('High')).toBeLessThan(markup.indexOf('data-testid="trailing"'));
    });

    test('omits the trailing slot when no trailing icon is given', () => {
        const markup = renderToStaticMarkup(<ChatMetadataBadge kind="model" label="GPT" thinkingLabel="High" />);
        expect(markup).not.toContain('h-3 w-3 flex-shrink-0 items-center');
    });
});
