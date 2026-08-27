import { describe, expect, test } from 'bun:test';

import {
  createBotCapabilityConnectionController,
  createBotEventConnectionController,
  type BotEventSource,
} from './botEventConnection';

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeEventSource implements BotEventSource {
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closeCount = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  close(): void {
    this.closeCount += 1;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data } as MessageEvent<string>);
  }
}

describe('Bot event connection controller', () => {
  test('closes a malformed source, schedules one reconnect, and requires a fresh snapshot', () => {
    const sources: FakeEventSource[] = [];
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const states: Array<[string, string | null | undefined]> = [];
    let reconnectedSnapshotCount = 0;
    const controller = createBotEventConnectionController({
      eventKinds: ['snapshot', 'run.completed'],
      createSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      ingest: (value) => value === 'snapshot'
        ? { accepted: true, reason: 'snapshot' }
        : { accepted: false, reason: 'invalid' },
      setConnectionState: (state, code) => states.push([state, code]),
      onReconnectedSnapshot: () => { reconnectedSnapshotCount += 1; },
      setTimeoutImpl: ((callback: () => void, delay: number) => {
        timers.push(callback);
        delays.push(delay);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
    });

    controller.start();
    expect(sources).toHaveLength(1);
    sources[0].emit('snapshot', JSON.stringify('snapshot'));
    expect(states.at(-1)).toEqual(['connected', undefined]);

    sources[0].emit('run.completed', '{malformed');
    sources[0].onerror?.(new Event('error'));
    expect(sources[0].closeCount).toBe(1);
    expect(delays).toEqual([250]);
    expect(states.at(-1)).toEqual(['reconnecting', 'bot_event_json_invalid']);

    timers[0]();
    expect(sources).toHaveLength(2);
    sources[1].onopen?.(new Event('open'));
    expect(states.at(-1)?.[0]).toBe('reconnecting');
    expect(reconnectedSnapshotCount).toBe(0);
    sources[1].emit('snapshot', JSON.stringify('snapshot'));
    expect(states.at(-1)).toEqual(['connected', undefined]);
    expect(reconnectedSnapshotCount).toBe(1);
  });

  test('uses capped reconnect backoff and manual retry replaces the current generation', () => {
    const sources: FakeEventSource[] = [];
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const controller = createBotEventConnectionController({
      eventKinds: ['snapshot'],
      createSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      ingest: () => ({ accepted: false, reason: 'invalid' }),
      setConnectionState: () => {},
      setTimeoutImpl: ((callback: () => void, delay: number) => {
        timers.push(callback);
        delays.push(delay);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
    });

    controller.start();
    for (let index = 0; index < 5; index += 1) {
      sources.at(-1)?.onerror?.(new Event('error'));
      timers.at(-1)?.();
    }
    expect(delays).toEqual([250, 1_000, 2_000, 5_000, 5_000]);

    const current = sources.at(-1)!;
    controller.retry();
    expect(current.closeCount).toBe(1);
    expect(sources).toHaveLength(7);
    controller.dispose();
    expect(sources.at(-1)?.closeCount).toBe(1);
  });
});

describe('Bot capability connection controller', () => {
  test('recovers from migration_required and starts the event connection after a fresh capability probe', async () => {
    const capabilities = [
      { state: 'migration_required', code: 'bot_schema_migration_required' },
      { state: 'healthy', code: null },
    ];
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const states: Array<[string, string | null | undefined]> = [];
    let eventStarts = 0;
    let recoveryErrorCode: string | null = null;
    const controller = createBotCapabilityConnectionController({
      loadCapabilities: async () => capabilities.shift() ?? null,
      getCapabilitiesErrorCode: () => null,
      canStream: (state) => state !== 'migration_required' && state !== 'supabase_unavailable',
      isTransient: (state) => state === 'migration_required' || state === 'supabase_unavailable',
      createConnection: (initialRecoveryErrorCode) => {
        recoveryErrorCode = initialRecoveryErrorCode;
        return {
          start: () => { eventStarts += 1; },
          retry: () => {},
          dispose: () => {},
        };
      },
      setConnectionState: (state, code) => states.push([state, code]),
      setTimeoutImpl: ((callback: () => void, delay: number) => {
        timers.push(callback);
        delays.push(delay);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
    });

    controller.start();
    await flushAsync();
    expect(states.at(-1)).toEqual(['error', 'bot_schema_migration_required']);
    expect(delays).toEqual([250]);
    expect(eventStarts).toBe(0);

    timers[0]();
    await flushAsync();
    expect(eventStarts).toBe(1);
    expect(recoveryErrorCode).toBe('bot_schema_migration_required');
  });

  test('manual retry re-probes immediately before an EventSource exists and avoids overlapping requests', async () => {
    const firstRequest: {
      resolve: ((value: { state: string; code: string }) => void) | null;
    } = { resolve: null };
    let loads = 0;
    let eventStarts = 0;
    const timers: Array<() => void> = [];
    const controller = createBotCapabilityConnectionController({
      loadCapabilities: () => {
        loads += 1;
        if (loads === 1) return new Promise((resolve) => { firstRequest.resolve = resolve; });
        return Promise.resolve({ state: 'healthy', code: '' });
      },
      getCapabilitiesErrorCode: () => null,
      canStream: (state) => state === 'healthy',
      isTransient: (state) => state === 'migration_required',
      createConnection: () => ({
        start: () => { eventStarts += 1; },
        retry: () => {},
        dispose: () => {},
      }),
      setConnectionState: () => {},
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
    });

    controller.start();
    controller.retry();
    controller.retry();
    expect(loads).toBe(1);
    firstRequest.resolve?.({ state: 'migration_required', code: 'bot_schema_migration_required' });
    await flushAsync();
    expect(loads).toBe(2);
    await flushAsync();
    expect(eventStarts).toBe(1);
  });

  test('dispose cancels a scheduled capability retry and ignores its stale callback', async () => {
    const timers: Array<() => void> = [];
    const cleared: unknown[] = [];
    let loads = 0;
    const controller = createBotCapabilityConnectionController({
      loadCapabilities: async () => {
        loads += 1;
        return { state: 'migration_required', code: 'bot_schema_migration_required' };
      },
      getCapabilitiesErrorCode: () => null,
      canStream: () => false,
      isTransient: () => true,
      createConnection: () => ({ start: () => {}, retry: () => {}, dispose: () => {} }),
      setConnectionState: () => {},
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutImpl: ((timer: unknown) => { cleared.push(timer); }) as typeof clearTimeout,
    });

    controller.start();
    await flushAsync();
    expect(loads).toBe(1);
    expect(timers).toHaveLength(1);
    controller.dispose();
    expect(cleared).toHaveLength(1);
    timers[0]();
    await flushAsync();
    expect(loads).toBe(1);
  });
});
