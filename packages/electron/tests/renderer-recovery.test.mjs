import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installRendererRecovery } from '../renderer-recovery.mjs';
import { createDesktopMenu } from '../desktop-menu.mjs';

function fixture() {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  let quitting = false;
  let destroyed = false;
  let reloads = 0;
  const timers = new Map();
  const prompts = [];
  const logs = [];
  window.id = 7;
  window.__ocLabel = 'main';
  window.webContents = contents;
  window.isDestroyed = contents.isDestroyed = () => destroyed;
  contents.reload = () => {
    reloads += 1;
    contents.emit('did-start-navigation', {}, 'https://fixture.test/private?token=secret', false, true);
  };
  const dispose = installRendererRecovery({
    browserWindow: window,
    shouldQuit: () => quitting,
    showMessageBox: (parent, options) => new Promise((resolve) => prompts.push({ parent, options, resolve })),
    log: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    schedule: (callback, delay) => { const key = {}; timers.set(key, { callback, delay }); return key; },
    cancel: (key) => timers.delete(key),
  });
  const runTimer = (delay) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `missing ${delay}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  };
  return {
    window, contents, prompts, logs, timers, dispose, runTimer,
    get reloads() { return reloads; },
    quit: () => { quitting = true; },
    close: () => { destroyed = true; window.emit('closed'); },
    gone: (reason = 'clean-exit') => contents.emit('render-process-gone', {}, { reason, exitCode: 0 }),
    loaded: () => contents.emit('did-finish-load'),
  };
}

for (const reason of ['clean-exit', 'crashed', 'oom', 'killed', 'launch-failed']) {
  test(`unexpected ${reason} reloads the surviving window once`, () => {
    const f = fixture();
    f.gone(reason);
    assert.equal(f.reloads, 0);
    f.runTimer(0);
    assert.equal(f.reloads, 1);
    f.loaded();
    assert.equal(f.prompts.length, 0);
    assert.deepEqual([...f.timers.values()].map((timer) => timer.delay), [60_000]);
    assert.ok(!JSON.stringify(f.logs).includes('secret'));
    f.dispose();
  });
}

test('a second exit after load stops automatic looping and offers native recovery', async () => {
  const f = fixture();
  f.gone(); f.runTimer(0); f.loaded(); f.gone();
  assert.equal(f.reloads, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].parent, f.window);
  assert.deepEqual(f.prompts[0].options.buttons, ['Reload Window', 'Later']);
  f.gone();
  assert.equal(f.prompts.length, 1);
  f.prompts[0].resolve({ response: 0 });
  await Promise.resolve();
  f.runTimer(0);
  assert.equal(f.reloads, 2);
  f.dispose();
});

test('only a stable loaded window restores its automatic recovery budget', () => {
  const f = fixture();
  f.gone(); f.runTimer(0); f.loaded();
  f.contents.emit('did-start-navigation', {}, 'https://fixture.test/new', false, true);
  assert.equal(f.timers.size, 0);
  f.loaded(); f.runTimer(60_000); f.gone(); f.runTimer(0);
  assert.equal(f.reloads, 2);
  assert.equal(f.prompts.length, 0);
  f.dispose();
});

test('failed main-frame reload keeps the native prompt usable even if the error page loads', async () => {
  const f = fixture();
  f.gone(); f.runTimer(0);
  f.contents.emit('did-fail-load', {}, -2, 'failed', 'https://fixture.test/', false);
  f.contents.emit('did-fail-load', {}, -3, 'aborted', 'https://fixture.test/', true);
  assert.equal(f.prompts.length, 0);
  f.contents.emit('did-fail-load', {}, -102, 'refused', 'https://fixture.test/', true);
  f.loaded();
  assert.equal(f.prompts.length, 1);
  f.prompts[0].resolve({ response: 0 });
  await Promise.resolve();
  f.runTimer(0);
  assert.equal(f.reloads, 2);
  f.dispose();
});

test('a stalled reload offers native recovery and Later does not loop', async () => {
  const f = fixture();
  f.gone(); f.runTimer(0); f.runTimer(30_000);
  assert.equal(f.prompts.length, 1);
  f.prompts[0].resolve({ response: 1 });
  await Promise.resolve();
  assert.equal(f.timers.size, 0);
  assert.equal(f.reloads, 1);
  f.dispose();
});

test('a synchronous reload failure offers recovery without an unhandled rejection', () => {
  const f = fixture();
  f.contents.reload = () => { throw new Error('destroyed renderer'); };
  f.gone(); f.runTimer(0);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.timers.size, 0);
  f.dispose();
});

test('successful late loading invalidates a pending dialog action', async () => {
  const f = fixture();
  f.gone(); f.runTimer(0); f.runTimer(30_000); f.loaded();
  f.prompts[0].resolve({ response: 0 });
  await Promise.resolve();
  assert.equal(f.reloads, 1);
  assert.deepEqual([...f.timers.values()].map((timer) => timer.delay), [60_000]);
  f.dispose();
});

test('host navigation supersedes a queued reload and a pending dialog', async () => {
  const f = fixture();
  f.gone();
  f.contents.emit('did-start-navigation', {}, 'https://other.test/', false, true);
  assert.equal(f.timers.size, 0);
  f.gone();
  f.contents.emit('did-start-navigation', {}, 'https://another.test/', false, true);
  f.prompts[0].resolve({ response: 0 });
  await Promise.resolve();
  assert.equal(f.reloads, 0);
  assert.equal(f.timers.size, 0);
  f.dispose();
});

test('quit and destroyed windows never reload, including deferred work', async () => {
  for (const when of ['before', 'queued', 'dialog']) {
    const f = fixture();
    if (when === 'before') { f.quit(); f.gone(); }
    if (when === 'queued') { f.gone(); f.quit(); f.runTimer(0); }
    if (when === 'dialog') {
      f.gone(); f.runTimer(0); f.gone(); f.close();
      f.prompts[0].resolve({ response: 0 });
      await Promise.resolve();
    }
    assert.equal(f.timers.size, 0);
    assert.equal(f.reloads, when === 'dialog' ? 1 : 0);
    f.dispose();
    assert.equal(f.contents.listenerCount('render-process-gone'), 0);
  }
  const f = fixture();
  f.gone(); f.close();
  assert.equal(f.timers.size, 0);
});

test('each window has an independent recovery budget', () => {
  const first = fixture(); const second = fixture();
  first.gone(); first.runTimer(0); first.gone();
  second.gone(); second.runTimer(0);
  assert.equal(first.prompts.length, 1);
  assert.equal(second.prompts.length, 0);
  assert.equal(second.reloads, 1);
  first.dispose(); second.dispose();
});

test('the native View menu can reload without renderer IPC', () => {
  const menu = createDesktopMenu({
    Menu: { buildFromTemplate: (template) => template }, app: { name: 'DevRyan' },
  }).buildMacMenu();
  const reload = menu.find((item) => item.label === 'View').submenu.find((item) => item.label === 'Reload Window');
  assert.equal(reload.role, 'reload');
  assert.equal(reload.click, undefined);
});
