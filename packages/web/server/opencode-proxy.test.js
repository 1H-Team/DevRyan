// Generic HTTP/SSE proxy execution has been retired. Native proxy wiring is
// verified in proxy-v2.test.js; these retained utilities have no runtime transport.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { bindScopedRevertRequestAbort, parseUnifiedPatch, reverseApplyUnifiedPatch } from './lib/opencode/session-scoped-revert.js';

describe('retained pure scoped patch utilities', () => {
  it('reverses only the requested hunk and preserves unrelated edits', () => {
    const patch = '@@ -1,2 +1,2 @@\n-a=1\n+a=3\n b=2\n';
    expect(reverseApplyUnifiedPatch('a=3\nb=2\nc=4\n', patch, 'x')).toBe('a=1\nb=2\nc=4\n');
  });
  it('preserves the no-final-newline marker', () => {
    const patch = '@@ -0,0 +1 @@\n+added\n\\ No newline at end of file\n';
    expect(reverseApplyUnifiedPatch('added', patch, 'new.txt')).toBe('');
    expect(parseUnifiedPatch(patch)[0].lines).toContain('\\ No newline at end of file');
  });
  it('refuses a mismatched hunk rather than changing unrelated bytes', () => {
    expect(() => reverseApplyUnifiedPatch('foreign\n', '@@ -1 +1 @@\n-old\n+new\n', 'x')).toThrow();
  });
  it('uses the expected position to select one repeated matching hunk', () => {
    const patch = '@@ -1 +1,2 @@\n x\n+added\n';
    expect(reverseApplyUnifiedPatch('x\nadded\nx\nadded\n', patch, 'same.txt')).toBe('x\nx\nadded\n');
  });
});
describe('native coordinator request lifetime', () => {
  it('aborts on socket disconnect and removes each listener on disposal', () => {
    const req = new EventEmitter(); req.socket = new EventEmitter(); const res = new EventEmitter();
    const captured = bindScopedRevertRequestAbort(req, res);
    req.socket.emit('close'); expect(captured.signal.aborted).toBe(true);
    captured.dispose();
    expect(req.listenerCount('aborted')).toBe(0); expect(req.socket.listenerCount('close')).toBe(0); expect(res.listenerCount('close')).toBe(0);
  });
  it('does not abort a response which already completed', () => {
    const req = new EventEmitter(); req.socket = new EventEmitter(); const res = new EventEmitter(); res.writableEnded = true;
    const captured = bindScopedRevertRequestAbort(req, res); res.emit('close');
    expect(captured.signal.aborted).toBe(false); captured.dispose();
  });
});
