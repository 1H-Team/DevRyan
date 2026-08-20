import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(resolve(testDir, 'MessageBody.tsx'), 'utf8');

describe('MessageBody footer metadata', () => {
    test('renders the completion time before the turn duration', () => {
        const code = source();
        const timestampIndex = code.indexOf('{footerTimestamp ? (');
        const durationIndex = code.indexOf('{turnDurationText ? (');

        expect(timestampIndex).toBeGreaterThan(-1);
        expect(durationIndex).toBeGreaterThan(-1);
        expect(timestampIndex).toBeLessThan(durationIndex);
    });

    test('does not append workspace evidence beside the turn duration', () => {
        const code = source();

        expect(code).not.toContain('TurnEvidenceDropdown');
        expect(code).not.toContain('Workspace Changes Observed During This Turn');
    });

    test('keeps the timing group close to the message actions', () => {
        const code = source();
        const footerStart = code.indexOf('{shouldShowTurnFooter && (');
        const footerEnd = code.indexOf('{(managedTaskDispatch.taskIds.length', footerStart);
        const footer = code.slice(footerStart, footerEnd);

        expect(footer).toContain('className="flex items-center justify-start gap-3"');
        expect(footer).toContain('className="flex items-center gap-1.5" data-message-action-group="true"');
        expect(footer).toContain('<div className="flex items-center gap-1.5">');
    });
});
