import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { ThinkingSlider } from './ThinkingSlider';
import { getThinkingDetent } from './thinkingSliderBehavior';

const event = async (container: HostElement, target: HostElement, type: string, fields: Record<string, unknown>) => {
    await act(async () => {
        for (const listener of container.listeners.get(type) ?? []) listener({ type, target, bubbles: true, button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, ...fields });
    });
};

describe('thinking detents', () => {
    test('resists until 60%, snaps in both directions, and clamps endpoints', () => {
        expect(getThinkingDetent(1.59, 1, 4).index).toBe(1);
        expect(Math.abs(getThinkingDetent(1.59, 1, 4).position - 1.1062) < 0.00001).toBe(true);
        expect(getThinkingDetent(1.61, 1, 4).index).toBe(2);
        expect(getThinkingDetent(1.41, 2, 4).index).toBe(2);
        expect(getThinkingDetent(1.39, 2, 4).index).toBe(1);
        expect(getThinkingDetent(99, 1, 4)).toEqual({ index: 3, position: 3 });
        expect(getThinkingDetent(-99, 1, 4)).toEqual({ index: 0, position: 0 });
    });
    test('real mounted slider commits once on release and cancels preview without a write', async () => withDom(async container => {
        const changes: string[] = [];
        const root = createRoot(container as unknown as HTMLElement);
        const render = async (levels = ['low', 'medium', 'high', 'xhigh']) => act(async () => root.render(<ThinkingSlider levels={levels} value="medium" onChange={value => changes.push(value)} />));
        try {
            await render();
            const slider = container.find(node => node.getAttribute('role') === 'slider')!;
            Object.assign(slider, { setPointerCapture() {}, releasePointerCapture() {} });
            // Host geometry is 760px: centers at 10 + index * 740/3.
            const start = 10 + 740 / 3;
            await event(container, slider, 'pointerdown', { clientX: start });
            await event(container, slider, 'pointermove', { clientX: start + 740 / 3 * 0.59 });
            expect(slider.getAttribute('aria-valuetext')).toBe('Medium');
            await event(container, slider, 'pointermove', { clientX: start + 740 / 3 * 0.61 });
            expect(slider.getAttribute('aria-valuetext')).toBe('High');
            expect(changes).toEqual([]);
            await event(container, slider, 'pointerup', { clientX: start + 740 / 3 * 0.61 });
            expect(changes).toEqual(['high']);
            await event(container, slider, 'pointerdown', { clientX: 750 });
            await event(container, slider, 'pointercancel', {});
            expect(changes).toEqual(['high']);
            expect(slider.getAttribute('aria-valuetext')).toBe('Medium');
            await event(container, slider, 'pointerdown', { clientX: 10 });
            await event(container, slider, 'pointerup', { clientX: 10 });
            expect(changes.at(-1)).toBe('low');
            for (const [key, expected] of [['Home', 'low'], ['End', 'xhigh'], ['ArrowRight', 'high'], ['ArrowLeft', 'low']]) {
                await event(container, slider, 'keydown', { key });
                expect(changes.at(-1)).toBe(expected);
            }
            await event(container, slider, 'pointerdown', { clientX: 750 });
            await render(['low', 'high']);
            await event(container, slider, 'pointerup', { clientX: 750 });
            expect(changes.at(-1)).toBe('low');
        } finally { await act(async () => root.unmount()); }
    }));
    test('top-right Fast action is functional only when the provider supports it', async () => withDom(async container => {
        const root = createRoot(container as unknown as HTMLElement);
        const changes: boolean[] = [];
        try {
            await act(async () => root.render(<ThinkingSlider levels={['low', 'medium', 'high']} value="medium" onChange={() => {}} fastMode={{ enabled: false, onChange: enabled => changes.push(enabled) }} />));
            const button = container.find(node => node.getAttribute('aria-label') === 'Fast Mode')!;
            expect(button.getAttribute('aria-pressed')).toBe('false');
            await act(async () => button.click());
            expect(changes).toEqual([true]);
            await act(async () => root.render(<ThinkingSlider levels={[]} onChange={() => {}} fastMode={{ enabled: true, onChange: enabled => changes.push(enabled) }} />));
            expect(button.getAttribute('aria-pressed')).toBe('true');
            expect(container.find(node => node.getAttribute('role') === 'slider')).toBeNull();
            await act(async () => button.click());
            expect(changes).toEqual([true, false]);
            await act(async () => root.render(<ThinkingSlider levels={['low', 'medium', 'high']} onChange={() => {}} />));
            expect(button.hasAttribute('disabled')).toBe(true);
        } finally { await act(async () => root.unmount()); }
    }));
    test('single level is fixed and zero levels hide the control', async () => withDom(async container => {
        const root = createRoot(container as unknown as HTMLElement);
        const changes: string[] = [];
        try {
            await act(async () => root.render(<ThinkingSlider levels={['high']} onChange={value => changes.push(value)} />));
            const slider = container.find(node => node.getAttribute('role') === 'slider')!;
            expect(slider.getAttribute('aria-disabled')).toBe('true');
            await event(container, slider, 'keydown', { key: 'ArrowRight' });
            expect(changes).toEqual([]);
            await act(async () => root.render(<ThinkingSlider levels={[]} onChange={value => changes.push(value)} />));
            expect(container.find(node => node.getAttribute('role') === 'slider')).toBeNull();
        } finally { await act(async () => root.unmount()); }
    }));
});
