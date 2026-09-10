import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const source = () => readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'MessageList.tsx'),
    'utf8',
);

describe('assistant header promotion', () => {
    test('projects which assistant rows actually render before choosing a header owner', () => {
        const code = source();

        expect(code).toContain(
            "import { assistantRowRendersContent, selectAssistantHeaderTargetId } from './message/assistantRowContent';",
        );
        expect(code).toContain('const contentBearingAssistantIds = React.useMemo(');
        expect(code).toContain('const headerTargetAssistantMessageId = React.useMemo(');
    });

    test('promotes the header past empty leading rows instead of pinning it to the first assistant', () => {
        const code = source();

        // The promotion must be tried BEFORE the old first-assistant fallback,
        // otherwise an empty leading row keeps stranding the header above nothing.
        expect(code).toContain(
            'const assistantHeaderMessageId = headerTargetAssistantMessageId\n'
            + '                ?? visibleAssistantMessages[0]?.info.id\n'
            + '                ?? turn.headerMessageId;',
        );
    });

    test('suppresses the header on both the turn and ungrouped render paths', () => {
        const code = source();

        // Turn path: no row in the turn renders anything.
        expect(code).toContain(
            'suppressAssistantHeader={isAssistantMessage && headerTargetAssistantMessageId === null}',
        );
        // Ungrouped path: ChatMessage would otherwise fall through to its
        // unconditional "always show the header" branch.
        expect(code).toContain('suppressAssistantHeader={suppressAssistantHeader}');
        expect(code).toContain('const suppressAssistantHeader = React.useMemo(');
    });

    test('keeps the new prop in the memo comparator so header changes re-render', () => {
        const code = source();

        expect(code).toContain('prev.suppressAssistantHeader === next.suppressAssistantHeader');
        expect(code).toContain('suppressAssistantHeader?: boolean;');
    });

    test('the ownership overrides that keep a header are all supplied', () => {
        const code = source();

        for (const flag of [
            'isLiveStreamingRow:',
            'hasErrorSurface:',
            'ownsManagedTaskCard:',
            'ownsAssistantImages:',
            'ownsActivityOutput:',
        ]) {
            expect(code).toContain(flag);
        }
    });
});
