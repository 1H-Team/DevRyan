import { expect, test, vi, beforeEach } from 'vitest';
const processFactory = vi.hoisted(() => vi.fn());
vi.mock('./native-provider-process.js', () => ({ createNativeProviderProcess: processFactory }));
import { createNativeProviderRuntimeOwner } from './native-provider-runtime-owner.js';

beforeEach(() => processFactory.mockReset());
const owner = () => createNativeProviderRuntimeOwner({ instanceID: 'controller', claudeSupported: true,
  snapshot: { locations: [{ directory: '/synthetic-project', configuration: {} }] },
  registrationOrigin: { kind: 'plugin', id: 'devryan.provider-compat', manifestDigest: 'a'.repeat(64) },
  controller: () => ({ instanceID: 'controller' }), isReady: () => true, withMutationQueue: action => action(),
  admissionOwner: { withProviderAttempt: (_input, action) => action(async () => {}) },
  meridian: { boot: { profiles: [], globals: { home: '/synthetic-home' }, requestAuthorization: 'b'.repeat(64) } } });
const input = { directory: '/synthetic-project', controllerInstanceID: 'controller', sessionID: 'session', kind: 'primary',
  permit: { token: 'c'.repeat(64), sessionID: 'session', revision: 0 } };
const worker = () => {
  let failed = false;
  const value = { bound: { url: 'http://127.0.0.1:1', health: 'healthy', instanceID: 'worker' },
    isFailed: () => failed, fail: () => { failed = true; },
    authorizeAttempt: vi.fn(async () => {}), releaseAttempt: vi.fn(async () => {}),
    killAndWaitForExit: vi.fn(async () => ({ receipt: { terminated: true, confined: true } })),
    close: vi.fn(async () => ({ receipt: { terminated: true, confined: true } })) };
  return value;
};
const finish = async (runtime, attempt) => runtime.endMeridian({ attemptID: attempt.attemptID,
  controllerInstanceID: 'controller', directory: input.directory, sessionID: input.sessionID });

test('a crashed worker is settled before one replacement serves concurrent fresh attempts', async () => {
  const first = worker(), second = worker(); processFactory.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const runtime = owner(); const initial = await runtime.beginMeridian(input); await finish(runtime, initial);
  first.fail(); let release; const receipt = new Promise(resolve => { release = resolve; });
  first.killAndWaitForExit.mockImplementation(() => receipt);
  const pending = [runtime.beginMeridian(input), runtime.beginMeridian(input)];
  await Promise.resolve(); await Promise.resolve(); expect(processFactory).toHaveBeenCalledTimes(1);
  release({ receipt: { terminated: true, confined: true } });
  const attempts = await Promise.all(pending); expect(processFactory).toHaveBeenCalledTimes(2);
  expect(first.killAndWaitForExit).toHaveBeenCalledOnce();
  for (const attempt of attempts) await finish(runtime, attempt);
  await runtime.close(); expect(second.close).toHaveBeenCalledOnce();
});

test('already failed launches and failed worker close require termination proof without caching a failed close', async () => {
  const dead = worker(); dead.fail(); processFactory.mockResolvedValueOnce(dead);
  const runtime = owner();
  await expect(runtime.beginMeridian(input)).rejects.toMatchObject({ code: 'native_provider_exited' });
  expect(dead.killAndWaitForExit).toHaveBeenCalledOnce(); await runtime.close(); await runtime.close();
  expect(dead.close).not.toHaveBeenCalled();
  const live = worker(); processFactory.mockResolvedValueOnce(live); const other = owner();
  const attempt = await other.beginMeridian(input); await finish(other, attempt);
  live.close.mockImplementation(async () => { live.fail(); throw Error('worker exited'); });
  await other.close(); await other.close(); expect(live.killAndWaitForExit).toHaveBeenCalledOnce();
});

test('an unconfirmed failed worker cannot be replaced or reported drained', async () => {
  const dead = worker(); processFactory.mockResolvedValueOnce(dead); const runtime = owner();
  const attempt = await runtime.beginMeridian(input); await finish(runtime, attempt); dead.fail();
  dead.killAndWaitForExit.mockRejectedValue(Object.assign(Error('unconfirmed'), { code: 'native_provider_termination_unconfirmed' }));
  await expect(runtime.beginMeridian(input)).rejects.toMatchObject({ code: 'native_provider_termination_unconfirmed' });
  expect(processFactory).toHaveBeenCalledOnce();
  await expect(runtime.close()).rejects.toMatchObject({ code: 'native_provider_termination_unconfirmed' });
});
