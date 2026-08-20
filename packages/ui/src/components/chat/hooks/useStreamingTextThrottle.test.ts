import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  computeStreamingThrottleDelay,
  DEFAULT_STREAMING_TEXT_THROTTLE_MS,
  StreamingTextThrottleController,
  type StreamingTextThrottleScheduler,
} from './useStreamingTextThrottle';

type TimerHandle = ReturnType<typeof setTimeout>;

class FakeTimerScheduler implements StreamingTextThrottleScheduler {
  private currentTime = 0;
  private nextID = 1;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextID;
    this.nextID += 1;
    this.timers.set(id, { dueAt: this.currentTime + delayMs, callback });
    return id as unknown as TimerHandle;
  }

  clearTimeout(timer: TimerHandle): void {
    this.timers.delete(timer as unknown as number);
  }

  advanceBy(ms: number): void {
    const target = this.currentTime + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentTime = timer.dueAt;
      timer.callback();
    }
    this.currentTime = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

const streamingUpdate = (text: string, identityKey = 'message:part') => ({
  text,
  phase: 'streaming' as const,
  identityKey,
});

const terminalUpdate = (text: string, identityKey = 'message:part') => ({
  text,
  phase: 'terminal' as const,
  identityKey,
});

describe('computeStreamingThrottleDelay', () => {
  test('uses a 32 ms paint interval and never schedules beyond it', () => {
    expect(DEFAULT_STREAMING_TEXT_THROTTLE_MS).toBe(32);
    expect(computeStreamingThrottleDelay(100, 100, 32)).toBe(32);
    expect(computeStreamingThrottleDelay(100, 110, 32)).toBe(22);
    expect(computeStreamingThrottleDelay(100, 132, 32)).toBe(0);
    expect(computeStreamingThrottleDelay(100, 90, 32)).toBe(32);
  });
});

describe('StreamingTextThrottleController', () => {
  test('renders the first token immediately and trailing-coalesces a burst at 32 ms', () => {
    const scheduler = new FakeTimerScheduler();
    const controller = new StreamingTextThrottleController(streamingUpdate(''), scheduler);
    const emitted: string[] = [];

    expect(controller.getRenderText(streamingUpdate('A'))).toBe('A');
    controller.update(streamingUpdate('A'), (text) => emitted.push(text));
    expect(emitted).toEqual(['A']);

    scheduler.advanceBy(5);
    controller.update(streamingUpdate('AB'), (text) => emitted.push(text));
    scheduler.advanceBy(5);
    controller.update(streamingUpdate('ABC'), (text) => emitted.push(text));
    scheduler.advanceBy(21);
    expect(emitted).toEqual(['A']);
    scheduler.advanceBy(1);
    expect(emitted).toEqual(['A', 'ABC']);
  });

  test('terminal and identity updates cancel pending work and render immediately', () => {
    const scheduler = new FakeTimerScheduler();
    const controller = new StreamingTextThrottleController(streamingUpdate('A'), scheduler);
    const emitted: string[] = [];

    scheduler.advanceBy(1);
    controller.update(streamingUpdate('AB'), (text) => emitted.push(text));
    expect(scheduler.pendingCount).toBe(1);

    expect(controller.getRenderText(terminalUpdate('AB!'))).toBe('AB!');
    controller.update(terminalUpdate('AB!'), (text) => emitted.push(text));
    expect(emitted).toEqual(['AB!']);
    expect(scheduler.pendingCount).toBe(0);

    expect(controller.getRenderText(streamingUpdate('N', 'next:part'))).toBe('N');
    controller.update(streamingUpdate('N', 'next:part'), (text) => emitted.push(text));
    expect(emitted).toEqual(['AB!', 'N']);
  });

  test('does not display temporary shorter streaming snapshots but trusts terminal text', () => {
    const scheduler = new FakeTimerScheduler();
    const controller = new StreamingTextThrottleController(streamingUpdate('complete draft'), scheduler);
    const emitted: string[] = [];

    expect(controller.getRenderText(streamingUpdate('complete'))).toBe('complete draft');
    controller.update(streamingUpdate('complete'), (text) => emitted.push(text));
    scheduler.advanceBy(64);
    expect(emitted).toEqual([]);

    expect(controller.getRenderText(terminalUpdate('complete'))).toBe('complete');
    controller.update(terminalUpdate('complete'), (text) => emitted.push(text));
    expect(emitted).toEqual(['complete']);
  });

  test('dispose cancels an intermediate update', () => {
    const scheduler = new FakeTimerScheduler();
    const controller = new StreamingTextThrottleController(streamingUpdate('A'), scheduler);
    const emitted: string[] = [];

    scheduler.advanceBy(1);
    controller.update(streamingUpdate('AB'), (text) => emitted.push(text));
    controller.dispose();
    scheduler.advanceBy(64);

    expect(scheduler.pendingCount).toBe(0);
    expect(emitted).toEqual([]);
  });

  test('interleaved streams preserve exact terminal strings and checksums', () => {
    const scheduler = new FakeTimerScheduler();
    const fixtures = [
      'Parent: exact final text.\n',
      'Child one: αβγ and punctuation!?\n',
      'Child two: ordered chunks 1→2→3.\n',
      'Child three: final byte sequence.\n',
    ];
    const controllers = fixtures.map((_, index) => (
      new StreamingTextThrottleController(streamingUpdate('', `stream:${index}`), scheduler)
    ));
    const displayed = new Array<string>(fixtures.length).fill('');

    for (let offset = 1; offset <= Math.max(...fixtures.map((text) => text.length)); offset += 1) {
      fixtures.forEach((fixture, index) => {
        if (offset > fixture.length) return;
        const update = streamingUpdate(fixture.slice(0, offset), `stream:${index}`);
        controllers[index].update(update, (text) => {
          displayed[index] = text;
        });
      });
      scheduler.advanceBy(3);
    }

    fixtures.forEach((fixture, index) => {
      const update = terminalUpdate(fixture, `stream:${index}`);
      expect(controllers[index].getRenderText(update)).toBe(fixture);
      controllers[index].update(update, (text) => {
        displayed[index] = text;
      });
    });

    expect(displayed).toEqual(fixtures);
    expect(displayed.map((text) => createHash('sha256').update(text).digest('hex'))).toEqual(
      fixtures.map((text) => createHash('sha256').update(text).digest('hex')),
    );
  });
});
