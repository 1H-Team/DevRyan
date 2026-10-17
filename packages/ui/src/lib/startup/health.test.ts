import { describe, expect, test } from 'bun:test';
import { parseStartupHealth, waitForStartupHealth, watchStartupRecovery, type StartupHealthSnapshot } from './health';

const health = (state: 'starting' | 'ready' | 'failed', attempt = 1): StartupHealthSnapshot => ({
  ready: state === 'ready', runtimeIdentity: 'host:1', error: state === 'failed' ? 'Native bootstrap failed' : null,
  startup: { state, attempt, code: state === 'failed' ? 'NATIVE_BOOT_FAILED' : null },
});
const options = () => ({ signal: new AbortController().signal, intervalMs: 1, requestTimeoutMs: 5, timeoutMs: 100 });

describe('startup health polling', () => {
  test('fails immediately on authoritative failure without loading catalogs', async () => {
    let calls = 0;
    await expect(waitForStartupHealth(async () => { calls++; return health('failed'); }, options()))
      .rejects.toThrow('NATIVE_BOOT_FAILED');
    expect(calls).toBe(1);
  });

  test('keeps transport failures transient and detects delayed readiness', async () => {
    const sequence = [null, health('starting'), health('ready')];
    let calls = 0;
    await waitForStartupHealth(async () => sequence[calls++] ?? null, options());
    expect(calls).toBe(3);
  });

  test('expires a hung request even when the adapter ignores abort', async () => {
    let calls = 0;
    let expiredSignal: AbortSignal | undefined;
    await waitForStartupHealth(async signal => {
      calls++;
      if (calls === 1) { expiredSignal = signal; return new Promise(() => {}); }
      return health('ready');
    }, options());
    expect(calls).toBe(2);
    expect(expiredSignal?.aborted).toBe(true);
  });

  test('bounds a continuously unavailable host', async () => {
    await expect(waitForStartupHealth(async () => null, { ...options(), timeoutMs: 10 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });

  test('keeps waiting past the progress window while the host reports starting', async () => {
    const sequence: (StartupHealthSnapshot | null)[] = Array.from({ length: 40 }, () => health('starting'));
    sequence.push(health('ready'));
    let calls = 0;
    // 40 polls at >=1 ms each outlive a 10 ms window only because each one reports progress.
    await waitForStartupHealth(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return sequence[calls++] ?? null;
    }, { ...options(), timeoutMs: 10, maxTimeoutMs: 5_000 });
    expect(calls).toBe(41);
  });

  test('still expires when the host stops reporting progress', async () => {
    let calls = 0;
    await expect(waitForStartupHealth(async () => (calls++ < 3 ? health('starting') : null),
      { ...options(), timeoutMs: 20, maxTimeoutMs: 5_000 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(calls).toBeGreaterThan(3);
  });

  test('caps a startup that reports progress forever', async () => {
    const startedAt = performance.now();
    await expect(waitForStartupHealth(async () => health('starting'), { ...options(), timeoutMs: 10, maxTimeoutMs: 60 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('aborts an old owner and ignores its late ready response after retry', async () => {
    const controller = new AbortController();
    let releaseOld!: (value: StartupHealthSnapshot) => void;
    const old = waitForStartupHealth(() => new Promise(resolve => { releaseOld = resolve; }),
      { ...options(), signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    expect((await old as Error).name).toBe('AbortError');
    await expect(waitForStartupHealth(async () => health('failed', 2), options()))
      .rejects.toThrow('NATIVE_BOOT_FAILED');
    releaseOld(health('ready', 1));
  });

  test('ignores an older attempt and accepts a newer successful attempt', async () => {
    const sequence = [health('starting', 2), health('failed', 1), health('ready', 2)];
    let calls = 0;
    await waitForStartupHealth(async () => sequence[calls++] ?? null, options());
    expect(calls).toBe(3);
  });

  test('supports older health servers and rejects malformed terminal snapshots', async () => {
    const ready = { openCode: { generation: 2 }, isOpenCodeReady: true };
    expect(parseStartupHealth(ready)?.ready).toBe(true);
    await waitForStartupHealth(async () => parseStartupHealth(ready), options());
    expect(parseStartupHealth({ ...ready, openCodeStartup: { state: 'failed', attempt: '1', code: null } })?.startup)
      .toBeUndefined();
    expect(parseStartupHealth({ openCode: { generation: 1 }, isOpenCodeReady: true })?.ready).toBe(false);
  });

  test('terminal failures never display raw host errors or unsafe codes', async () => {
    const snapshot = parseStartupHealth({ openCodeStartup: { state: 'failed', attempt: 1, code: '/private/token' },
      lastOpenCodeError: 'secret token from host failure' });
    expect(snapshot?.startup?.code).toBeNull();
    await expect(waitForStartupHealth(async () => snapshot, options())).rejects.toThrow('OpenCode could not start.');
  });
});

test('artifact diagnostics survive health parsing and a terminal failure without raw host data', async () => {
  const snapshot = parseStartupHealth({ openCodeStartup: { state: 'failed', attempt: 3, code: 'native_runtime_artifacts_unverified',
    diagnostic: { stage: 'signature', reason: 'signature_failure', artifact: 'DevRyan-native-controller', purpose: 'current', secret: 'private' } },
    lastOpenCodeError: '/private/account' });
  expect(snapshot?.startup?.diagnostic).toEqual({ stage: 'signature', reason: 'signature_failure', artifact: 'DevRyan-native-controller', purpose: 'current' });
  const failure = await waitForStartupHealth(async () => snapshot, options()).catch(error => error);
  expect(failure).toMatchObject({
    code: 'native_runtime_artifacts_unverified', attempt: 3,
    diagnostic: snapshot?.startup?.diagnostic,
  });
  expect(failure.message).toContain('code signature');
});

describe('startup recovery after the Retry screen', () => {
  test('resolves once a late host reports ready', async () => {
    const sequence = [null, health('starting'), health('ready')];
    let calls = 0;
    await watchStartupRecovery(async () => sequence[calls++] ?? null,
      { signal: new AbortController().signal, intervalMs: 1, requestTimeoutMs: 5 });
    expect(calls).toBe(3);
  });

  test('stops when its owner aborts', async () => {
    const controller = new AbortController();
    const watching = watchStartupRecovery(async () => health('starting'), { signal: controller.signal, intervalMs: 1 });
    setTimeout(() => controller.abort(), 10);
    await expect(watching).rejects.toMatchObject({ name: 'AbortError' });
  });
});
