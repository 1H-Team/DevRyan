import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostChatgptSiwcEnrollment } from './chatgpt-siwc-host.js';
import { credentialMutationFingerprint as fingerprint } from './runtime-host/native-credential-mutation-owner.js';
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const directory = '/fixture/project';
function fixture({ cleanupFails = false, remoteStatus = 200, onRevoke } = {}) {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-signout-'));
  const value = { type: 'oauth', methodID: 'chatgpt-siwc', access: 'fixture-access', refresh: 'fixture-refresh',
    metadata: { clientId: 'issued-client', subject: 'fixture-subject', scopes: ['chatgpt.tokens.use.direct'] } };
  let selected = { credentialID: 'fixture-id', value };
  const row = { id: 'fixture-id', integrationID: 'openai', value };
  row.expectedFingerprint = fingerprint(row);
  const events = [], release = vi.fn(async cleared => events.push(`release:${cleared}`));
  const native = { isReady: () => true,
    getConfigurationSnapshot: () => ({ locations: [{ directory, configuration: { providers: { openai: {} } } }] }),
    readOpenAiSelected: vi.fn(async () => selected), readOpenAiCredential: vi.fn(async () => row),
    stopOpenAiRequests: vi.fn(async () => { events.push('drained'); return release; }),
    credentialOperation: vi.fn(async (spec, input) => {
      expect(input).toEqual({ operation: 'remove', id: 'fixture-id' });
      expect(spec.expectedFingerprint).toBe(row.expectedFingerprint);
      if (spec.expectedActiveFingerprint !== fingerprint(selected)) throw new Error('selection changed');
      if (cleanupFails) throw new Error('fixture cleanup failed');
      events.push('removed'); selected = null;
    }),
  };
  const fetchImpl = vi.fn(async (_url, input) => {
    if (input?.method !== 'POST') return Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    expect(events).toEqual(['drained']); events.push('revoke');
    if (onRevoke) onRevoke(next => { selected = next; });
    return new Response(null, { status: remoteStatus });
  });
  const owner = createHostChatgptSiwcEnrollment({ dataDirectory, getNativeRuntimeOwner: () => native, getOpenCodeRuntime: () => null, fetchImpl });
  cleanups.push(async () => { await owner.close(); fs.rmSync(dataDirectory, { recursive: true, force: true }); });
  return { owner, native, events, release, fetchImpl, selected: () => selected };
}
describe('scoped native SIWC sign-out', () => {
  it('drains active native work before remote revocation and exact selected token removal', async () => {
    const f = fixture();
    expect(await f.owner.disconnect({ directory, expectedActiveCredentialID: 'fixture-id' }))
      .toEqual({ success: true, remoteRevocation: 'confirmed', localCleanup: 'complete' });
    expect(f.events).toEqual(['drained', 'revoke', 'removed', 'release:true']);
    expect(f.selected()).toBeNull();
  });
  it('clears locally when remote revocation cannot be confirmed', async () => {
    const f = fixture({ remoteStatus: 400 });
    expect(await f.owner.disconnect({ directory, expectedActiveCredentialID: 'fixture-id' }))
      .toMatchObject({ remoteRevocation: 'unconfirmed', localCleanup: 'complete' });
    expect(f.selected()).toBeNull();
  });
  it('reports local cleanup failure and keeps the selected credential blocked', async () => {
    const f = fixture({ cleanupFails: true });
    await expect(f.owner.disconnect({ directory, expectedActiveCredentialID: 'fixture-id' }))
      .rejects.toMatchObject({ code: 'native_chatgpt_siwc_cleanup_failed', remoteRevocation: 'confirmed', localCleanup: 'failed' });
    expect(f.release).toHaveBeenCalledWith(false);
    expect(f.selected().credentialID).toBe('fixture-id');
  });
  it('refuses stale browser selection before draining or revoking another account', async () => {
    const f = fixture();
    await expect(f.owner.disconnect({ directory, expectedActiveCredentialID: 'old-id' }))
      .rejects.toMatchObject({ code: 'native_chatgpt_siwc_selection_changed' });
    expect(f.native.stopOpenAiRequests).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('does not remove a replacement selected while revocation was in flight', async () => {
    const replacement = { credentialID: 'replacement', value: { type: 'key', key: 'fixture-replacement' } };
    const f = fixture({ onRevoke: set => set(replacement) });
    await expect(f.owner.disconnect({ directory, expectedActiveCredentialID: 'fixture-id' }))
      .rejects.toMatchObject({ code: 'native_chatgpt_siwc_cleanup_failed', localCleanup: 'failed' });
    expect(f.selected()).toEqual(replacement); expect(f.release).toHaveBeenCalledWith(false);
  });
});
