import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createQaRecoveredInputModel, createQaRecoveredInputFetchScript, resolveQaRecoveredInputRequest, readQaRecoveredTextTail } from './fixture-recovered-inputs.mjs';

const origin = 'http://127.0.0.1:32100';
const model = phase => createQaRecoveredInputModel({ transport: 'fixture', sessionID: 'ses_empty', directory: '/fixture', phase });
const route = '/api/session/ses_empty/recovery';

function tailFixture({ outside = false, covered = false, clipped = false, textChanged = false } = {}) {
  const value = createQaRecoveredInputModel({ transport: 'fixture', sessionID: 'ses_empty', directory: '/fixture', fullTextProof: true });
  const expected = value.details.text, offsets = [];
  const node = { nodeType: 3, textContent: textChanged ? expected.slice(0, -1) : expected };
  const scroll = { parentElement: null, scrollHeight: 12000, clientHeight: 550,
    getBoundingClientRect: () => ({ left: 0, right: 390, top: 60, bottom: clipped ? 400 : 610 }), contains: e => e === pre || e === scroll };
  const pre = { firstChild: node, textContent: node.textContent, parentElement: scroll, scrollHeight: 12000, clientHeight: 12000,
    getBoundingClientRect: () => ({ left: 12, right: 378, top: 60, bottom: 12060 }), contains: e => e === pre };
  const context = vm.createContext({ innerWidth: 390, innerHeight: 844,
    getComputedStyle: e => ({ overflowX: 'visible', overflowY: e === scroll ? 'auto' : 'visible' }),
    document: { querySelector: () => pre, elementFromPoint: () => covered ? {} : pre,
      createRange: () => ({ setStart: (n, i) => offsets.push(['start', n === node, i]), setEnd: (n, i) => offsets.push(['end', n === node, i]),
        getBoundingClientRect: () => ({ left: 20, right: 25, top: outside ? 12000 : 500, bottom: outside ? 12020 : 520, width: 5, height: 20 }) }) } });
  const result = vm.runInContext(`(${readQaRecoveredTextTail.toString()})(${JSON.stringify(expected)},${JSON.stringify(value.terminalMarker)})`, context);
  return { result, offsets, value };
}

test('phone tail range binds complete retained bytes and exactly the final glyph, not an earlier visible text line', () => {
  const { result, offsets, value } = tailFixture();
  assert.equal(result.visible, true);assert.equal(result.fullTextMatches, true);
  assert.deepEqual(offsets, [['start', true, value.details.text.length - 1], ['end', true, value.details.text.length]]);
  assert.equal(result.textLength, value.details.text.length);
  assert.equal(tailFixture({ textChanged: true }).result, null, 'A truncated text must never produce a reachability receipt');
  assert.equal(tailFixture({ outside: true }).result.visible, false, 'Earlier visible lines cannot witness the offscreen final glyph');
});

test('phone tail respects scroll-ancestor clipping and actual final-glyph hit ownership', () => {
  const clipped = tailFixture({ clipped: true }).result;
  assert.equal(clipped.clip.bottom, 400);assert.equal(clipped.visible, false);assert.ok(clipped.wheel);
  const covered = tailFixture({ covered: true }).result;
  assert.equal(covered.hitOwned, false);assert.equal(covered.visible, false);assert.equal(covered.wheel, undefined);
});

test('phone text marker is opt-in and does not alter the original desktop retained input', () => {
  const ordinary = model('discard');assert.equal(ordinary.terminalMarker, '');
  assert.equal(ordinary.details.text, 'Retained full input fetched only after Review input.\n' + 'A long saved objective remains readable. '.repeat(500));
  const phone = tailFixture().value;
  assert.ok(phone.details.text.endsWith(phone.terminalMarker));assert.equal(phone.details.text.indexOf(phone.terminalMarker), phone.details.text.lastIndexOf(phone.terminalMarker));
});
test('bounded unsupported-watchdog summary omits retained full text and file URI', () => {
  const value = model('discard');
  assert.equal(value.snapshot.record, null);assert.equal(value.snapshot.enforced, false);assert.equal(value.snapshot.supported, false);
  assert.equal(value.snapshot.recoveredInput.inputs[0].preview.length <= 160, true);
  assert.equal(JSON.stringify(value.snapshot).includes(value.details.text), false);
  assert.equal(JSON.stringify(value.snapshot).includes(value.details.files[0].uri), false);
  assert.throws(() => createQaRecoveredInputModel({ transport: 'live' }));
  assert.throws(() => createQaRecoveredInputFetchScript({ transport: 'fixture', origin: 'https://foreign.invalid', model: value }));
});
test('lazy detail and action routes accept only exact pinned identity, direction and query', () => {
  for (const phase of ['discard', 'resume']) {
    const value = model(phase);
    const send = (suffix, method = 'GET', postData) => resolveQaRecoveredInputRequest({ model: value, origin,
      request: { url: origin + route + suffix, method, postData } });
    const query = new URLSearchParams({ directory: '/fixture', ...value.identity });
    assert.deepEqual(send('/input?' + query).body, value.details);
    const resolved = send(`/${phase}-input?directory=%2Ffixture`, 'POST', JSON.stringify(value.identity));
    assert.equal(resolved.resolved, true);assert.equal(resolved.body.recoveredInput, undefined);
    for (const [suffix, method, body] of [['/continue?directory=%2Ffixture', 'POST', value.identity],
      [`/${phase}-input?directory=%2Ffixture`, 'POST', { ...value.identity, messageID: 'new' }],
      [`/${phase}-input?directory=%2Ffixture`, 'POST', { ...value.identity, extra: true }],
      [`/${phase}-input?directory=%2Ffixture`, 'GET', value.identity],
      ['/input?' + query + '&revision=' + value.identity.revision, 'GET'], ['?directory=wrong', 'GET']]) {
      assert.equal(send(suffix, method, body && JSON.stringify(body)).status, 501);
    }
  }
});
test('page fetch wrapper scopes requests, records refusal and restores captured references', async () => {
  const value = model('discard'), forwarded = [];
  const context = vm.createContext({ URL, Request, Response, location: { origin, href: origin + '/' },
    fetch: async (...args) => { forwarded.push(args);return new Response('forwarded'); } });
  vm.runInContext(createQaRecoveredInputFetchScript({ transport: 'fixture', origin, model: value }), context);
  const wrapped = context.fetch;
  assert.equal((await (await wrapped(route + '?directory=%2Ffixture')).json()).record, null);
  assert.equal(context.__devryanQaRecoveredInputFixture.requests.length, 1, 'Summary request must not request details');
  const details = await wrapped(new Request(origin + route + '/input?' + new URLSearchParams({ directory: '/fixture', ...value.identity })));
  assert.equal((await details.json()).text, value.details.text);
  const action = await wrapped(route + '/discard-input?directory=%2Ffixture', { method: 'POST', body: JSON.stringify(value.identity) });
  assert.equal((await action.json()).recoveredInput, undefined);
  assert.equal((await wrapped(route + '/discard-input?directory=%2Ffixture', { method: 'POST', body: JSON.stringify(value.identity) })).status, 501, 'Resolved inventory cannot accept a duplicate action');
  assert.equal((await (await wrapped(route + '?directory=%2Ffixture')).json()).recoveredInput, undefined);
  assert.equal((await wrapped(value.details.files[0].uri)).status, 501, 'Attachment fetch must fail rather than contact its URI');
  assert.equal((await wrapped(route + '/continue?directory=%2Ffixture', { method: 'POST' })).status, 501);
  await wrapped('/api/session/status');await wrapped('/api/session/foreign/recovery?directory=%2Ffixture');
  assert.equal(forwarded.length, 2);
  assert.equal(context.__devryanQaRecoveredInputFixture.failures.length, 3);
  context.__devryanQaRecoveredInputFixture.restore();
  await wrapped(route + '?directory=%2Ffixture');assert.equal(forwarded.length, 3, 'Previously captured wrapper must return to native forwarding');
});
