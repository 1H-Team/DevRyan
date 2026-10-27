import { expect, test } from 'bun:test';
import { isUpstreamStallEnvelope, isUpstreamStallText } from './upstream-stall.js';

test('the text form is the exact OpenCode 2.x reformatting of the Meridian event', () => {
  expect(isUpstreamStallText('upstream_timeout: Upstream stalled: no data for 90005ms')).toBe(true);
  expect(isUpstreamStallText('upstream_timeout: Upstream stalled: no data for 1ms')).toBe(true);
  for (const value of [
    'upstream_timeout: request timeout',
    'upstream_timeout: Upstream stalled: no data for 0ms',
    'upstream_timeout: Upstream stalled: no data for 01ms',
    'upstream_timeout: Upstream stalled: no data for 12345678901234ms',
    ' upstream_timeout: Upstream stalled: no data for 90005ms',
    'upstream_timeout: Upstream stalled: no data for 90005ms.',
    'Upstream stalled: no data for 90005ms',
    '{"type":"upstream_timeout","message":"Upstream stalled: no data for 90005ms"}',
    undefined, null, 90005,
  ]) expect(isUpstreamStallText(value)).toBe(false);
});

test('the envelope form is a bounded JSON object with the exact type and message', () => {
  expect(isUpstreamStallEnvelope('{"type":"upstream_timeout","message":"Upstream stalled: no data for 208771ms"}')).toBe(true);
  expect(isUpstreamStallEnvelope(JSON.stringify({ type: 'upstream_timeout', message: 'Upstream stalled: no data for 1ms', extra: 1 }))).toBe(true);
  for (const value of [
    '{"type":"upstream_timeout","message":"request timeout"}',
    '{"type":"overloaded_error","message":"Upstream stalled: no data for 208771ms"}',
    '{"type":"upstream_timeout","message":"Upstream stalled: no data for 0ms"}',
    '[{"type":"upstream_timeout","message":"Upstream stalled: no data for 208771ms"}]',
    '"Upstream stalled: no data for 208771ms"',
    'null',
    '{not json',
    'upstream_timeout: Upstream stalled: no data for 90005ms',
    JSON.stringify({ type: 'upstream_timeout', message: 'Upstream stalled: no data for 1ms', pad: 'x'.repeat(4096) }),
    undefined, null, {},
  ]) expect(isUpstreamStallEnvelope(value)).toBe(false);
});
