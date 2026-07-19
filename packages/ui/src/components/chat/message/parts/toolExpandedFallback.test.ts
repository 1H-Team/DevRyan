import { describe, expect, test } from 'bun:test';
import { resolveToolExpandedDetails } from './toolExpandedFallback';

describe('resolveToolExpandedDetails', () => {
    test('prefers structured details over input, output, and failure text', () => {
        const details = resolveToolExpandedDetails({
            hasStructuredDetails: true,
            inputText: 'input',
            output: 'output',
            error: 'failure',
            status: 'error',
            isFinalized: true,
        });

        expect(details.primaryKind).toBe('structured');
        expect(details.hasOutput).toBe(true);
        expect(details.failureReason).toBe('failure');
        expect(details.showEmpty).toBe(false);
        expect(details.showResult).toBe(true);
    });

    test('uses formatted input before output when no structured details exist', () => {
        const details = resolveToolExpandedDetails({
            hasStructuredDetails: false,
            inputText: 'command --flag',
            output: 'command output',
            status: 'completed',
        });

        expect(details.primaryKind).toBe('input');
        expect(details.hasInput).toBe(true);
        expect(details.hasOutput).toBe(true);
    });

    for (const tool of ['write', 'create', 'file_write']) {
        test(`keeps output-only ${tool} calls expandable`, () => {
            const details = resolveToolExpandedDetails({
                hasStructuredDetails: false,
                inputText: '',
                output: '{"path":"src/new.ts","linesCreated":3}',
                status: 'completed',
                isFinalized: true,
            });

            expect(details.primaryKind).toBe('output');
            expect(details.hasOutput).toBe(true);
            expect(details.showEmpty).toBe(false);
            expect(details.showResult).toBe(true);
        });
    }

    test('keeps partial output primary while retaining the provider failure reason', () => {
        const details = resolveToolExpandedDetails({
            hasStructuredDetails: false,
            inputText: '',
            output: 'three files processed before disconnect',
            error: { message: 'provider disconnected' },
            status: 'error',
            isFinalized: true,
        });

        expect(details.primaryKind).toBe('output');
        expect(details.hasOutput).toBe(true);
        expect(details.isFailure).toBe(true);
        expect(details.failureReason).toBe('provider disconnected');
        expect(details.showEmpty).toBe(false);
        expect(details.showResult).toBe(true);
    });

    test('surfaces an error-only terminal call', () => {
        const details = resolveToolExpandedDetails({
            hasStructuredDetails: false,
            inputText: '',
            output: '',
            error: 'permission denied',
            status: 'failed',
            isFinalized: true,
        });

        expect(details.primaryKind).toBe('failure');
        expect(details.isFailure).toBe(true);
        expect(details.failureReason).toBe('permission denied');
        expect(details.showEmpty).toBe(false);
        expect(details.showResult).toBe(false);
    });

    test('coerces structured and circular runtime errors without returning object children', () => {
        const structured = resolveToolExpandedDetails({
            hasStructuredDetails: false,
            error: { message: { code: 'E_PROVIDER' } },
            status: 'failed',
        });
        expect(structured.failureReason).toBe('{"code":"E_PROVIDER"}');

        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const circularDetails = resolveToolExpandedDetails({
            hasStructuredDetails: false,
            error: circular,
            status: 'failed',
        });
        expect(circularDetails.failureReason).toBe(undefined);
        expect(circularDetails.isFailure).toBe(true);
    });

    test('surfaces an interrupted status even when the provider supplied no reason', () => {
        const details = resolveToolExpandedDetails({
            hasStructuredDetails: false,
            inputText: '',
            output: '',
            status: 'cancelled',
            isFinalized: true,
        });

        expect(details.primaryKind).toBe('failure');
        expect(details.isFailure).toBe(true);
        expect(details.failureStatus).toBe('cancelled');
        expect(details.showEmpty).toBe(false);
        expect(details.showResult).toBe(false);
    });

    test('uses an explicit empty state only when the provider supplied no details', () => {
        const details = resolveToolExpandedDetails({
            hasStructuredDetails: false,
            inputText: '   ',
            output: '',
            status: 'completed',
            isFinalized: true,
        });

        expect(details.primaryKind).toBe('empty');
        expect(details.showEmpty).toBe(true);
        expect(details.showResult).toBe(true);
    });

    test('does not show an empty-state diagnostic while a call is still running', () => {
        const details = resolveToolExpandedDetails({
            hasStructuredDetails: false,
            inputText: '',
            output: '',
            status: 'running',
            isFinalized: false,
        });

        expect(details.primaryKind).toBe('empty');
        expect(details.showEmpty).toBe(false);
        expect(details.showResult).toBe(false);
    });
});
