import { afterEach, expect, test, vi } from 'vitest';
import { createNativeDocumentParser } from './native-document-parser.js';
import { startReadOnlySessionExecution } from '../../../../../harness-runtime/lib/session-execution.js';

vi.mock('../../../../../harness-runtime/lib/session-execution.js', () => ({ startReadOnlySessionExecution: vi.fn() }));
afterEach(() => vi.resetAllMocks());

test('document parsing forwards its constructor-owned Windows authority and preserves pre-launch refusal', async () => {
  const windowsOwner = { ensureDirectory: vi.fn(), createDirectory: vi.fn() };
  const refusal = Object.assign(new Error('private storage refused'), { code: 'private_windows_file_unverified' });
  startReadOnlySessionExecution.mockRejectedValue(refusal);
  const onStarted = vi.fn(), onTermination = vi.fn();
  const parse = createNativeDocumentParser({ launcher: '/fixture/launcher', command: '/fixture/writer',
    storage: '/fixture/storage', windowsOwner, onStarted, onTermination });
  await expect(parse({ bytes: Buffer.from('disposable document'), name: 'fixture.txt', type: 'text' },
    new AbortController().signal)).rejects.toBe(refusal);
  expect(startReadOnlySessionExecution).toHaveBeenCalledWith(expect.objectContaining({ windowsOwner, socketDirectory: null }));
  expect(onStarted).not.toHaveBeenCalled(); expect(onTermination).not.toHaveBeenCalled();
});


test('Windows attachments retain the full 20 MiB limit through exclusive native publication', async () => {
  const bytes = Buffer.alloc(20 * 1024 * 1024, 1), write = vi.fn(async () => {});
  const windowsOwner = { write }, refusal = new Error('stop before launch');
  let inputPath;
  startReadOnlySessionExecution.mockImplementation(async options => {
    const request = JSON.parse(await options.inputForLease({ viewDirectory: '/fixture/view' }));
    inputPath = request.path; throw refusal;
  });
  const parse = createNativeDocumentParser({ launcher: '/fixture/launcher', command: '/fixture/writer',
    storage: '/fixture/storage', windowsOwner });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    await expect(parse({ bytes, name: 'fixture.pdf', type: 'pdf' }, new AbortController().signal)).rejects.toBe(refusal);
    expect(write).toHaveBeenCalledTimes(1);
    const [target, published, expected] = write.mock.calls[0];
    expect(target).toBe(inputPath); expect(published.equals(bytes)).toBe(true); expect(expected).toEqual({ expected: null });
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
