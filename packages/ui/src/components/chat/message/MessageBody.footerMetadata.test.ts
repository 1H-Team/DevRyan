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
});
