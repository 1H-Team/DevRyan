import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  resolveRevealBoundary,
  STREAMING_REVEAL_SNAP_CHARS,
  STREAMING_REVEAL_TERMINAL_DRAIN_MS,
  StreamingRevealFrameLoop,
  StreamingTextRevealController,
  type StreamingRevealClock,
} from './useStreamingTextReveal';

class FakeFrameClock implements StreamingRevealClock {
  private currentTime = 1000;
  private nextID = 1;
  private readonly frames = new Map<number, () => void>();
  snap = false;

  now(): number {
    return this.currentTime;
  }

  requestFrame(callback: () => void): number {
    const id = this.nextID;
    this.nextID += 1;
    this.frames.set(id, callback);
    return id;
  }

  cancelFrame(handle: number): void {
    this.frames.delete(handle);
  }

  shouldSnap(): boolean {
    return this.snap;
  }

  advanceBy(ms: number): void {
    this.currentTime += ms;
  }

  /** Runs one 16 ms animation frame. */
  frame(ms = 16): void {
    this.currentTime += ms;
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback();
  }

  runFrames(count: number, ms = 16): void {
    for (let index = 0; index < count; index += 1) this.frame(ms);
  }

  get pendingFrames(): number {
    return this.frames.size;
  }
}

const streaming = (text: string, identityKey = 'message:part') => ({ text, phase: 'streaming' as const, identityKey });
const terminal = (text: string, identityKey = 'message:part') => ({ text, phase: 'terminal' as const, identityKey });

const setup = (initial = '') => {
  const clock = new FakeFrameClock();
  const loop = new StreamingRevealFrameLoop(clock);
  const controller = new StreamingTextRevealController(streaming(initial), loop);
  const emitted: string[] = [];
  const update = (input: ReturnType<typeof streaming> | ReturnType<typeof terminal>) => {
    controller.update(input, (text) => emitted.push(text));
  };
  const shown = () => emitted.at(-1) ?? initial;
  return { clock, loop, controller, emitted, update, shown };
};

const PARAGRAPH = 'The handler reads the request body before checking authorization, so a large upload is buffered. ';

describe('resolveRevealBoundary', () => {
  test('ends visible text after whitespace so words appear whole', () => {
    expect(resolveRevealBoundary('alpha beta gamma', 0, 8)).toBe(6);
    expect(resolveRevealBoundary('alpha beta gamma', 6, 8)).toBe(6);
    expect(resolveRevealBoundary('alpha beta gamma', 0, 99)).toBe(16);
  });

  test('cuts a long unbroken run mid-word but never inside a surrogate pair', () => {
    const long = 'x'.repeat(40);
    expect(resolveRevealBoundary(long, 0, 30)).toBe(30);
    const emoji = `${'y'.repeat(29)}😀tail`;
    expect(resolveRevealBoundary(emoji, 0, 30)).toBe(29);
  });
});

describe('StreamingTextRevealController', () => {
  test('shows the first word at once and reveals a burst word by word over frames', () => {
    const { clock, controller, emitted, update, shown } = setup();
    const burst = PARAGRAPH.repeat(2);

    expect(controller.getRenderText(streaming(burst))).toBe('The handler reads the ');
    update(streaming(burst));
    expect(emitted).toEqual(['The handler reads the ']);

    clock.runFrames(4);
    const midway = shown();
    expect(midway.length).toBeGreaterThan('The handler reads the '.length);
    expect(midway.length).toBeLessThan(burst.length);
    expect(burst.startsWith(midway)).toBe(true);
    expect(midway.endsWith(' ')).toBe(true);

    clock.runFrames(40);
    expect(shown()).toBe(burst);
    expect(clock.pendingFrames).toBe(0);
    for (let index = 1; index < emitted.length; index += 1) {
      expect(emitted[index].length).toBeGreaterThan(emitted[index - 1].length);
    }
  });

  test('reveals at the arrival rate so evenly spaced chunks do not stall between arrivals', () => {
    const { clock, update, shown } = setup();
    const text = PARAGRAPH.repeat(12);
    const chunk = 40;
    let sent = 0;
    const visibleLengths: number[] = [];
    // A 40-char chunk every 100 ms (0.4 chars/ms), painted at 60 fps.
    for (let step = 0; step < 24; step += 1) {
      sent = Math.min(text.length, sent + chunk);
      update(streaming(text.slice(0, sent)));
      for (let frame = 0; frame < 6; frame += 1) {
        clock.frame(100 / 6);
        visibleLengths.push(shown().length);
      }
    }

    // After warm-up, visible text grows in at least 4 of each chunk's 6 frames
    // instead of jumping once per chunk.
    const steady = visibleLengths.slice(36);
    const growingFrames = steady.filter((length, index) => index > 0 && length > steady[index - 1]).length;
    expect(growingFrames).toBeGreaterThan(Math.floor(steady.length * 4 / 6) - 1);
    // ...and stays within about one catch-up window of the stream.
    expect(sent - shown().length).toBeLessThan(200);
  });

  test('drains the backlog after the stream ends and settles on the exact text', () => {
    const { clock, update, shown } = setup();
    const text = PARAGRAPH.repeat(4);
    update(streaming(text));
    clock.frame();
    update(terminal(text));
    expect(shown().length).toBeLessThan(text.length);

    clock.runFrames(Math.ceil(STREAMING_REVEAL_TERMINAL_DRAIN_MS / 16) + 1);
    expect(shown()).toBe(text);
    expect(clock.pendingFrames).toBe(0);
  });

  test('snaps for a new identity, a rewrite, a huge backlog, or when frames cannot run', () => {
    const { clock, controller, update, shown, loop } = setup();
    update(streaming('Start of a reply that keeps going '));
    update(streaming(`Start of a reply that keeps going ${PARAGRAPH}`));
    expect(loop.activeCount).toBe(1);

    expect(controller.getRenderText(streaming('Other', 'next:part'))).toBe('Other');
    update(streaming('Other', 'next:part'));
    expect(shown()).toBe('Other');
    expect(loop.activeCount).toBe(0);

    update(streaming('Rewritten text'));
    expect(shown()).toBe('Rewritten text');

    const huge = `Rewritten text ${'z '.repeat(STREAMING_REVEAL_SNAP_CHARS)}`;
    update(streaming(huge));
    expect(shown()).toBe(huge);

    clock.snap = true;
    update(streaming(`${huge}more words here`));
    expect(shown()).toBe(`${huge}more words here`);
    expect(clock.pendingFrames).toBe(0);
  });

  test('shows text present at mount immediately and terminal text without pacing', () => {
    const { controller } = setup('Already streamed text');
    expect(controller.getRenderText(streaming('Already streamed text'))).toBe('Already streamed text');

    const fresh = setup();
    expect(fresh.controller.getRenderText(terminal('Final answer from history'))).toBe('Final answer from history');
    fresh.update(terminal('Final answer from history'));
    expect(fresh.shown()).toBe('Final answer from history');
  });

  test('does not display temporary shorter streaming snapshots but trusts terminal text', () => {
    const { controller, update, shown } = setup('complete draft');
    expect(controller.getRenderText(streaming('complete'))).toBe('complete draft');
    update(streaming('complete'));
    expect(shown()).toBe('complete draft');

    expect(controller.getRenderText(terminal('complete'))).toBe('complete');
    update(terminal('complete'));
    expect(shown()).toBe('complete');
  });

  test('dispose stops the frame loop and drops pending reveals', () => {
    const { clock, controller, update, emitted, loop } = setup();
    update(streaming(PARAGRAPH.repeat(3)));
    expect(loop.activeCount).toBe(1);
    const before = emitted.length;
    controller.dispose();
    clock.runFrames(10);
    expect(loop.activeCount).toBe(0);
    expect(clock.pendingFrames).toBe(0);
    expect(emitted.length).toBe(before);
  });

  test('interleaved streams share one frame loop and end with exact strings and checksums', () => {
    const clock = new FakeFrameClock();
    const loop = new StreamingRevealFrameLoop(clock);
    const fixtures = [
      'Parent: exact final text.\n',
      'Child one: αβγ and punctuation!?\n',
      'Child two: ordered chunks 1→2→3 😀.\n',
      'Child three: final byte sequence.\n',
    ];
    const controllers = fixtures.map((_, index) => new StreamingTextRevealController(streaming('', `stream:${index}`), loop));
    const displayed = new Array<string>(fixtures.length).fill('');

    for (let offset = 1; offset <= Math.max(...fixtures.map((text) => text.length)); offset += 1) {
      fixtures.forEach((fixture, index) => {
        if (offset > fixture.length) return;
        controllers[index].update(streaming(fixture.slice(0, offset), `stream:${index}`), (text) => {
          displayed[index] = text;
        });
      });
      expect(clock.pendingFrames).toBeLessThan(2);
      clock.frame(3);
    }

    fixtures.forEach((fixture, index) => {
      controllers[index].update(terminal(fixture, `stream:${index}`), (text) => {
        displayed[index] = text;
      });
    });
    clock.runFrames(20);

    expect(displayed).toEqual(fixtures);
    expect(displayed.map((text) => createHash('sha256').update(text).digest('hex'))).toEqual(
      fixtures.map((text) => createHash('sha256').update(text).digest('hex')),
    );
    expect(loop.activeCount).toBe(0);
  });
});
