import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';

const KEY = '__devryanQaRecoveredInputFixture';
const SOURCE = 'retained-input-ui-wire-only';
export function createQaRecoveredInputModel({ transport, sessionID, directory, phase = 'discard', fullTextProof = false }) {
  assert.equal(transport, 'fixture', 'Retained input wire proof requires fixture transport');
  assert.ok(typeof sessionID === 'string' && /^ses_[\w-]+$/.test(sessionID));
  assert.ok(typeof directory === 'string' && directory.length > 0);
  assert.ok(['discard', 'resume'].includes(phase));
  const identity = { revision: (phase === 'discard' ? 'a' : 'c').repeat(64),
    messageID: `msg_qa_retained_${phase}`, payloadHash: (phase === 'discard' ? 'b' : 'd').repeat(64) };
  const descriptor = { messageID: identity.messageID, payloadHash: identity.payloadHash, type: 'user', delivery: 'queue',
    location: 'queued', preview: 'Saved request with an attachment; review the full input before choosing an action.',
    attachmentCount: 1, canResume: true, canDiscard: true, reason: null };
  const terminalMarker = fullTextProof ? 'QA retained input exact terminal marker.' : '';
  return { source: SOURCE, sessionID, directory, identity, phase, terminalMarker,
    snapshot: { schemaVersion: 1, mode: 'off', supported: false, enforced: false, progressTimeoutMs: false, record: null,
      recoveredInput: { revision: identity.revision, state: 'paused', inputs: [descriptor] } },
    details: { ...descriptor, text: 'Retained full input fetched only after Review input.\n' + 'A long saved objective remains readable. '.repeat(500) + (terminalMarker ? '\n' + terminalMarker : ''),
      files: [{ uri: 'https://recovered-input-attachment.invalid/saved.txt', name: 'Saved attachment.txt', mime: 'text/plain' }] } };
}

// A full text-node Range can report an earlier visible line. Bind this range
// to the final non-whitespace glyph of the exact complete retained input.
export function readQaRecoveredTextTail(expectedText, terminalMarker) {
  const pre = document.querySelector('ul[aria-label="Retained Inputs"] pre');
  if (!pre || pre.textContent !== expectedText || !terminalMarker || !expectedText.endsWith(terminalMarker)
    || expectedText.indexOf(terminalMarker) !== expectedText.lastIndexOf(terminalMarker)) return null;
  const node = pre.firstChild;
  if (!node || node.nodeType !== 3 || node.textContent !== expectedText) return null;
  const range = document.createRange();
  range.setStart(node, expectedText.length - 1);range.setEnd(node, expectedText.length);
  const r = range.getBoundingClientRect();
  const clip = { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
  let scroll;
  for (let e = pre; e; e = e.parentElement) {
    const style = getComputedStyle(e), bounds = e.getBoundingClientRect();
    if (/hidden|clip|auto|scroll/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left);clip.right = Math.min(clip.right, bounds.right); }
    if (/hidden|clip|auto|scroll/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top);clip.bottom = Math.min(clip.bottom, bounds.bottom); }
    if (!scroll && e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(style.overflowY)) scroll = e;
  }
  const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const hit = document.elementFromPoint(center.x, center.y);
  const hitOwned = Boolean(hit && pre.contains(hit));
  const visible = r.width > 0 && r.height > 0 && r.left >= clip.left && r.right <= clip.right
    && r.top >= clip.top && r.bottom <= clip.bottom && hitOwned;
  let wheel;
  if (!visible && scroll) {
    const bounds = scroll.getBoundingClientRect();
    const point = { x: (Math.max(0, bounds.left) + Math.min(innerWidth, bounds.right)) / 2,
      y: (Math.max(0, bounds.top) + Math.min(innerHeight, bounds.bottom)) / 2 };
    if (scroll.contains(document.elementFromPoint(point.x, point.y))) {
      wheel = { ...point, deltaX: 0, deltaY: Math.max(-500, Math.min(500, center.y - point.y)) };
    }
  }
  return { fullTextMatches: true, textLength: expectedText.length, finalGlyph: expectedText.at(-1),
    rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }, clip, hitOwned, visible, wheel };
}

// Exact fixture routes only. Neither these actions nor the model authorize native work.
export function resolveQaRecoveredInputRequest({ model, origin, request }) {
  const deny = reason => ({ accepted: false, status: 501, body: { error: reason } });
  const url = new URL(request.url, origin);
  if (url.origin !== origin) return deny('foreign_origin');
  const base = `/api/session/${model.sessionID}/recovery`;
  const suffix = url.pathname.slice(base.length);
  if (!url.pathname.startsWith(base) || !['', '/input', '/resume-input', '/discard-input'].includes(suffix)) return deny('unexpected_recovery_route');
  const allowed = suffix === '/input' ? ['directory', 'revision', 'messageID', 'payloadHash'] : ['directory'];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
    || url.searchParams.get('directory') !== model.directory) return deny('unexpected_recovery_query');
  if (suffix === '' && request.method === 'GET' && !request.postData) return { accepted: true, status: 200, body: model.snapshot };
  if (!model.snapshot.recoveredInput) return deny('resolved_recovery_inventory');
  const exact = value => value && Object.keys(value).length === 3 && Object.entries(model.identity).every(([key, expected]) => value[key] === expected);
  if (suffix === '/input' && request.method === 'GET' && !request.postData
    && exact(Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'directory')))) return { accepted: true, status: 200, body: model.details };
  let body; try { body = JSON.parse(request.postData); } catch { return deny('invalid_recovery_body'); }
  if (suffix === `/${model.phase}-input` && request.method === 'POST' && exact(body)) {
    const { recoveredInput, ...snapshot } = model.snapshot; void recoveredInput;
    return { accepted: true, status: 200, body: snapshot, resolved: true };
  }
  return deny('unexpected_recovery_action');
}

export function createQaRecoveredInputFetchScript({ transport, origin, model }) {
  assert.equal(transport, 'fixture');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), 'Wire fixture requires an isolated loopback host');
  assert.equal(model.source, SOURCE);
  return `(() => {
    if(location.origin!==${JSON.stringify(origin)})return;
    const key=${JSON.stringify(KEY)};if(globalThis[key]&&!globalThis[key].closed)throw new Error('recovered_wire_duplicate');
    const original=globalThis.fetch.bind(globalThis),model=${JSON.stringify(model)},origin=${JSON.stringify(origin)};
    const resolve=${resolveQaRecoveredInputRequest.toString()};
    const state={source:model.source,requests:[],failures:[],closed:false};
    const wrapper=async(input,init)=>{
      if(state.closed)return original(input,init);
      const url=new URL(input instanceof Request?input.url:String(input),location.href);
      const targeted=url.pathname.startsWith('/api/session/'+model.sessionID+'/recovery')||url.href===model.details.files[0].uri;
      if(!targeted)return original(input,init);
      const method=String(init?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
      const postData=init?.body===undefined?(input instanceof Request&&method!=='GET'?await input.clone().text():undefined):String(init.body);
      const result=resolve({model,origin,request:{url:url.href,method,postData}});
      const evidence={url:url.href,method,postData,accepted:result.accepted,status:result.status};
      if(state.requests.length>=128){if(state.failures.length<128)state.failures.push({reason:'recovered_wire_request_limit'});return new Response('{}',{status:501});}state.requests.push(evidence);
      if(!result.accepted)state.failures.push(evidence);
      if(result.resolved)model.snapshot=result.body;
      return new Response(JSON.stringify(result.body),{status:result.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
    };
    state.restore=()=>{state.closed=true;if(globalThis.fetch===wrapper)globalThis.fetch=original;};
    globalThis[key]=state;globalThis.fetch=wrapper;
  })()`;
}

export async function runQaRecoveredInputFixtureProof({ cell, fixture, projectFixture, cdp, ui, api, check, screenshot, selectSession, phoneTheme }) {
  assert.equal(cell.transport, 'fixture');assert.equal(fixture.generation, 2);
  assert.ok(phoneTheme === undefined || ['light', 'dark'].includes(phoneTheme));
  const directory = projectFixture.fixtureRoot;
  const session = await api(`/api/session?directory=${encodeURIComponent(directory)}`, { method: 'POST',
    body: JSON.stringify({ title: 'QA retained input after interruption' }) });
  assert.ok(session?.id, 'Create a genuine empty fixture session');
  assert.deepEqual(await api(`/api/session/${session.id}/message?directory=${encodeURIComponent(directory)}`), []);
  await selectSession(session.id);
  const origin = await evaluate(cdp, 'location.origin');
  const evidence = { source: SOURCE, sessionID: session.id, phases: [], nativeRecovery: 'not-tested' };
  for (const phase of ['discard', 'resume']) {
    const model = createQaRecoveredInputModel({ transport: cell.transport, sessionID: session.id, directory, phase, fullTextProof: phoneTheme !== undefined });
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: createQaRecoveredInputFetchScript({ transport: cell.transport, origin, model }) });
    let captured;
    const read = () => evaluate(cdp, `(() => {const s=globalThis[${JSON.stringify(KEY)}];return s?{source:s.source,requests:s.requests,failures:s.failures,closed:s.closed}:null;})()`);
    try {
      await ui.reload();
      await ui.waitExpression('empty history retained input panel', "Boolean(document.querySelector('ul[aria-label=\"Retained Inputs\"]'))");
      await check(`retained input ${phase} exact wire controls${phoneTheme ? ' phone ' + phoneTheme : ''}`, async () => {
        captured = await read();assert.equal(captured.source, SOURCE);
        assert.equal(captured.requests.some(request => new URL(request.url).pathname.endsWith('/input')), false, 'Full details must be lazy');
        assert.equal(await evaluate(cdp, "document.querySelectorAll('[data-message-id]').length"), 0, 'Retained panel must work with no history');
        assert.equal(await evaluate(cdp, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Continue')"), false);
        const prefix = phoneTheme ? `fixture-phone-${phoneTheme}-retained-${phase}` : 'fixture-retained-input';
        if (phase === 'discard') await screenshot(prefix + '-collapsed');
        await ui.click({ selector: 'summary', text: 'Review input', touch: Boolean(phoneTheme) });
        await ui.waitExpression('lazy retained text', "document.body.textContent.includes('Retained full input fetched only after Review input.')");
        const geometry = await evaluate(cdp, `(() => {const list=document.querySelector('ul[aria-label="Retained Inputs"]'),r=list.getBoundingClientRect();return {width:innerWidth,height:innerHeight,dark:document.documentElement.classList.contains('dark'),scrollWidth:document.documentElement.scrollWidth,x:r.x,right:r.right,buttons:[...list.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),disabled:b.disabled})),attachments:[...list.querySelectorAll('ul[aria-label="Attachments"] li')].map(e=>e.textContent),attachmentElements:list.querySelectorAll('img,a,iframe').length,resources:performance.getEntriesByType('resource').filter(e=>e.name.includes('recovered-input-attachment.invalid')).length};})()`);
        assert.ok(geometry.scrollWidth <= geometry.width + 1 && geometry.x >= 0 && geometry.right <= geometry.width + 1, 'Retained panel must not overflow');
        assert.deepEqual(geometry.buttons, [{ text: 'Resume Input', disabled: false }, { text: 'Discard Input', disabled: false }]);
        assert.deepEqual(geometry.attachments, ['Saved attachment.txt (text/plain)']);assert.equal(geometry.attachmentElements, 0);assert.equal(geometry.resources, 0);
        if (phoneTheme) {
          assert.equal(geometry.width, 390, 'Phone retained proof must use its actual viewport');
          assert.equal(geometry.height, 844);assert.equal(geometry.dark, phoneTheme === 'dark');
          geometry.tail = await ui.waitFor('exact retained input final glyph reachable', async () => {
            const tail = await evaluate(cdp, `(${readQaRecoveredTextTail.toString()})(${JSON.stringify(model.details.text)},${JSON.stringify(model.terminalMarker)})`);
            assert.ok(tail?.fullTextMatches, 'The expanded retained input must contain exactly the full original text');
            if (tail.visible) return tail;
            assert.ok(tail.wheel, 'The actual retained-input scroll container must own the wheel point');
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...tail.wheel });return false;
          });
          await screenshot(prefix + '-full-text-tail');
          await ui.reveal('ul[aria-label="Attachments"] li', undefined, { fullyVisible: true, direction: 'down' });
          // The owner renders filename and MIME in separate text nodes. The
          // exact combined identity is asserted above; both pieces must be visible.
          const attachment = 'ul[aria-label="Retained Inputs"] ul[aria-label="Attachments"] li';
          await ui.waitVisibleText('Saved attachment.txt', attachment);
          await ui.waitVisibleText('(text/plain)', attachment);
          const composer = await evaluate(cdp, `(() => {const r=document.querySelector('textarea')?.getBoundingClientRect();return r?{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}:null;})()`);
          assert.ok(composer && composer.width === 390 && composer.height === 844 && composer.left >= 0 && composer.right <= 391
            && composer.top >= 0 && composer.bottom <= 845, 'Phone retained text must preserve the visible composer');
          geometry.composer = composer;
          await screenshot(prefix + '-attachment-metadata');
        }
        geometry.controls = [];
        for (const label of ['Resume Input', 'Discard Input']) {
          const control = await evaluate(cdp, `(async () => {const e=[...document.querySelectorAll('ul[aria-label="Retained Inputs"] button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});e.scrollIntoView({block:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {label:${JSON.stringify(label)},x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,hit:e.contains(document.elementFromPoint(x,y))};})()`);
          assert.ok(control.x >= 0 && control.y >= 0 && control.right <= control.width + 1 && control.bottom <= control.height + 1 && control.hit,
            'Expanded tall input must keep its action visible and hit-testable after scrolling');
          geometry.controls.push(control);
        }
        if (phase === 'discard') await screenshot(prefix + '-reviewed');
        await ui.click({ text: phase === 'discard' ? 'Discard Input' : 'Resume Input', exact: true, touch: Boolean(phoneTheme) });
        await ui.waitExpression('resolved wire inventory clears panel', "!document.querySelector('ul[aria-label=\"Retained Inputs\"]')");
        captured = await read();assert.deepEqual(captured.failures, []);
        const actions = captured.requests.filter(request => request.method === 'POST');assert.equal(actions.length, 1);
        assert.equal(new URL(actions[0].url).pathname, `/api/session/${session.id}/recovery/${phase}-input`);
        assert.deepEqual(JSON.parse(actions[0].postData), model.identity, 'Action must retain exact ID/hash/revision without generating a new ID');
        assert.equal(captured.requests.filter(request => new URL(request.url).pathname.endsWith('/input')).length, 1);
        evidence.phases.push({ phase, geometry, ...captured });
      });
    } finally {
      captured = await read();
      await evaluate(cdp, `globalThis[${JSON.stringify(KEY)}]?.restore()`);
      const restored = await read();assert.equal(restored?.closed, true, 'Restore the scoped fetch transport');
      const completed = evidence.phases.find(value => value.phase === phase);if (completed) completed.closed = restored.closed;
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      assert.deepEqual(captured?.failures ?? [], [], 'Unexpected targeted requests fail this wire proof');
    }
  }
  assert.deepEqual(await api(`/api/session/${session.id}/message?directory=${encodeURIComponent(directory)}`), [], 'Wire actions must not create native messages');
  return evidence;
}
