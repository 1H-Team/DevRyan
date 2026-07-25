import { describe, expect, test } from 'bun:test';

import {
    captureModelPickerScroll,
    restoreModelPickerScroll,
    type ModelPickerScrollContainer,
} from './modelPickerScroll';

const createContainer = ({
    scrollTop,
    scrollHeight = 1000,
    clientHeight = 400,
    isConnected = true,
}: {
    scrollTop: number;
    scrollHeight?: number;
    clientHeight?: number;
    isConnected?: boolean;
}): ModelPickerScrollContainer => ({
    scrollTop,
    scrollHeight,
    clientHeight,
    isConnected,
});

describe('model picker scroll restoration', () => {
    test('restores the captured scroll position after the list changes', () => {
        const container = createContainer({ scrollTop: 320 });
        const snapshot = captureModelPickerScroll(container);

        expect(snapshot).not.toBeNull();
        container.scrollTop = 540;

        expect(restoreModelPickerScroll(snapshot!)).toBe(true);
        expect(container.scrollTop).toBe(320);
    });

    test('clamps the restored position to the shorter list maximum', () => {
        const container = createContainer({ scrollTop: 520 });
        const snapshot = captureModelPickerScroll(container);

        expect(snapshot).not.toBeNull();
        Object.assign(container, { scrollTop: 300, scrollHeight: 650 });

        expect(restoreModelPickerScroll(snapshot!)).toBe(true);
        expect(container.scrollTop).toBe(250);
    });

    test('does not write to a detached picker container', () => {
        const container = createContainer({ scrollTop: 320, isConnected: false });
        const snapshot = captureModelPickerScroll(container);

        expect(snapshot).not.toBeNull();
        container.scrollTop = 180;

        expect(restoreModelPickerScroll(snapshot!)).toBe(false);
        expect(container.scrollTop).toBe(180);
    });
});
