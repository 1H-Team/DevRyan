import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatgptSiwcEnrollmentOwner } from './chatgpt-siwc-enrollment.js';
import { readSiwcRegistrations, revokeSiwcSession, writeSiwcRegistrations } from './chatgpt-siwc.js';
import { credentialMutationFingerprint as fingerprint } from './runtime-host/native-credential-mutation-owner.js';
const directory = '/fixture/project';
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
async function fixture({ scopes = 'openid chatgpt.tokens.use.direct', autoactivateFirst = false } = {}) {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-signed-'));
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const records = new Map();
  let selected = null, tokens, sequence = 0;
  const connected = () => selected ? { credentialID: selected.credentialID, fingerprint: fingerprint(selected), methodID: selected.value.methodID,
    subject: selected.value.metadata.subject, email: selected.value.metadata.email, planUsage: selected.value.metadata.planUsage } : null;
  const persistCredential = vi.fn(async ({ credentialID, value, assertCurrent, expectedActiveFingerprint }) => {
    assertCurrent();
    if (fingerprint(selected) !== expectedActiveFingerprint) throw Object.assign(new Error('switched'), { code: 'native_chatgpt_siwc_selection_changed' });
    const row = { id: credentialID, integrationID: 'openai', value };
    row.expectedFingerprint = fingerprint(row);
    records.set(row.id, row);
    if (autoactivateFirst && records.size === 1) selected = { credentialID: row.id, value };
    return { credentialID: row.id, expectedFingerprint: row.expectedFingerprint };
  });
  const selectCredential = vi.fn(async ({ credentialID, expectedActiveFingerprint, assertCurrent }) => {
    assertCurrent();
    if (fingerprint(selected) !== expectedActiveFingerprint) throw Object.assign(new Error('switched'), { code: 'native_chatgpt_siwc_selection_changed' });
    selected = { credentialID, value: records.get(credentialID).value };
    return connected();
  });
  const removeCredential = vi.fn(async ({ credentialID, expectedFingerprint, requireInactive, assertCurrent }) => {
    if (assertCurrent) assertCurrent();
    if (requireInactive && selected?.credentialID === credentialID) throw Object.assign(new Error('active'), { code: 'native_chatgpt_siwc_selection_changed' });
    if (records.get(credentialID)?.expectedFingerprint !== expectedFingerprint) throw new Error('changed');
    records.delete(credentialID);
  });
  const readConnected = vi.fn(async () => connected());
  const owner = createChatgptSiwcEnrollmentOwner({ dataDirectory, createCredentialID: () => `credential-${++sequence}`, jwksImpl: createLocalJWKSet({ keys: [jwk] }),
    fetchImpl: vi.fn(async () => Response.json(tokens)), persistCredential, selectCredential, removeCredential,
    readConnected, readRegistrationCredential: async ({ registration }) => records.get(registration.credentialID) ?? null,
    disconnectCredential: async ({ expectedActiveCredentialID }) => {
      if (expectedActiveCredentialID !== selected?.credentialID) throw Object.assign(new Error('switched'), { code: 'native_chatgpt_siwc_selection_changed' });
      records.delete(selected.credentialID); selected = null;
      return { success: true, remoteRevocation: 'confirmed', localCleanup: 'complete' };
    },
  });
  cleanups.push(async () => { await owner.close(); fs.rmSync(dataDirectory, { recursive: true, force: true }); });
  const begin = context => owner.begin({ directory, ...context });
  const callback = async (started, { subject = 'subject-a', issuer = 'https://auth.openai.com', audience, nonce, expiresAt,
    issuedClientId, grantedScopes = scopes, callbackScope, state, claims = {}, privateKey = keys.privateKey } = {}) => {
    const url = new URL(started.url);
    const clientId = issuedClientId ?? (url.searchParams.get('client_id') === 'dynamic_agent_client' ? 'issued-client-a' : url.searchParams.get('client_id'));
    const idToken = await new SignJWT({ nonce: nonce ?? url.searchParams.get('nonce'), email: 'same@example.test', ...claims })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(audience ?? clientId).setSubject(subject)
      .setIssuedAt().setExpirationTime(expiresAt ?? Math.floor(Date.now() / 1000) + 3600).sign(privateKey);
    tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, id_token: idToken,
      ...(grantedScopes === null ? {} : { scope: grantedScopes }) };
    const callbackUrl = new URL(url.searchParams.get('redirect_uri'));
    callbackUrl.searchParams.set('state', state ?? url.searchParams.get('state'));
    callbackUrl.searchParams.set('code', 'fixture-code'); callbackUrl.searchParams.set('client_id', clientId);
    if (callbackScope) callbackUrl.searchParams.set('scope', callbackScope);
    return fetch(callbackUrl);
  };
  return { owner, dataDirectory, records, persistCredential, selectCredential, removeCredential, readConnected, begin, callback,
    complete: start => owner.complete(start.enrollmentID, {}, { directory }), selected: () => selected, switchSelection: value => { selected = value; } };
}
describe('SIWC attempt deadlines', () => {
  const deadlineFixture = () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-deadline-'));
    const servers = [], persistCredential = vi.fn();
    const owner = createChatgptSiwcEnrollmentOwner({ dataDirectory, persistCredential, createServer: () => {
      const server = new EventEmitter();
      server.listen = (_port, _host, ready) => ready();
      server.address = () => ({ port: 12345 });
      server.close = vi.fn(); servers.push(server); return server;
    } });
    cleanups.push(async () => { await owner.close(); fs.rmSync(dataDirectory, { recursive: true, force: true }); });
    vi.useFakeTimers();
    return { owner, servers, persistCredential };
  };
  it('reclaims abandoned begin listeners and capacity without a complete request', async () => {
    const f = deadlineFixture();
    const attempts = [];
    for (let index = 0; index < 64; index++) attempts.push(await f.owner.begin({ directory }));
    await expect(f.owner.begin({ directory })).rejects.toMatchObject({ code: 'native_chatgpt_siwc_capacity' });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.servers.every(server => server.close.mock.calls.length === 1)).toBe(true);
    await expect(f.owner.complete(attempts[0].enrollmentID, {}, { directory })).rejects.toMatchObject({ code: 'native_chatgpt_siwc_attempt_missing' });
    await expect(f.owner.begin({ directory })).resolves.toMatchObject({ status: 'pending' });
    expect(f.persistCredential).not.toHaveBeenCalled();
  });
  it('settles an in-flight completion with timeout and clears the listener and timer', async () => {
    const f = deadlineFixture(), attempt = await f.owner.begin({ directory });
    const completed = f.owner.complete(attempt.enrollmentID, {}, { directory }).catch(error => error);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await completed).toMatchObject({ code: 'native_chatgpt_siwc_timeout', status: 408 });
    expect(f.servers[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0); expect(f.persistCredential).not.toHaveBeenCalled();
  });
  it('cancellation and owner shutdown remove their attempt deadlines', async () => {
    const f = deadlineFixture(), a = await f.owner.begin({ directory }), b = await f.owner.begin({ directory });
    await f.owner.cancel(a.enrollmentID, { directory });
    expect(vi.getTimerCount()).toBe(1);
    await f.owner.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.servers.every(server => server.close.mock.calls.length === 1)).toBe(true);
    expect(b.status).toBe('pending');
  });
});
describe('signed SIWC enrollment and selection', () => {
  it('verifies signed enrollment, stores tokens only in native credentials and restores opaque registration after restart', async () => {
    const f = await fixture(); const start = await f.begin();
    expect((await f.callback(start)).status).toBe(200);
    const result = await f.complete(start);
    expect(result).toMatchObject({ status: 'enrolled', planUsage: true, credentialID: 'credential-1' });
    const registration = readSiwcRegistrations(f.dataDirectory).accounts[0];
    expect(registration).toMatchObject({ registrationRef: result.registrationRef, subject: 'subject-a', clientId: 'issued-client-a', credentialID: 'credential-1' });
    expect(JSON.stringify(registration)).not.toMatch(/fixture-access|fixture-refresh|idToken|scopes/);
    expect(f.records.get('credential-1').value.metadata).toMatchObject({ accountID: 'subject-a', subject: 'subject-a', scopes: ['openid', 'chatgpt.tokens.use.direct'] });
    const status = await f.owner.status({ directory });
    expect(status.registrations[0]).toMatchObject({ registrationRef: result.registrationRef, active: true });
    expect(JSON.stringify(status)).not.toMatch(/subject-a|issued-client-a|fixture-access|fixture-refresh|idToken/);
  });
  it('retains sign-in without scope and ignores callback attempts to grant plan permission', async () => {
    const f = await fixture(); const start = await f.begin();
    await f.callback(start, { grantedScopes: null, callbackScope: 'chatgpt.tokens.use.direct' });
    expect(await f.complete(start)).toMatchObject({ status: 'enrolled', planUsage: false });
    expect(f.selected().value.metadata).toMatchObject({ scopes: [], planUsage: false });
  });
  it.each(['issuer', 'audience', 'nonce', 'expiry', 'signature'])('rejects invalid signed JWT %s before persistence', async claim => {
    const f = await fixture(); const start = await f.begin();
    const invalid = claim === 'issuer' ? { issuer: 'https://fixture.invalid' } : claim === 'audience' ? { audience: 'foreign-client' }
      : claim === 'nonce' ? { nonce: 'foreign-nonce' } : claim === 'expiry' ? { expiresAt: Math.floor(Date.now() / 1000) - 60 }
        : { privateKey: (await generateKeyPair('RS256')).privateKey };
    expect((await f.callback(start, invalid)).status).toBe(400);
    await expect(f.complete(start)).rejects.toBeInstanceOf(Error);
    expect(f.persistCredential).not.toHaveBeenCalled();
  });
  it('reuses issued registration and validates returning subject while preserving previous credentials', async () => {
    const f = await fixture(); const first = await f.begin(); await f.callback(first); const result = await f.complete(first);
    const returning = await f.begin({ registrationRef: result.registrationRef, expectedActiveCredentialID: 'credential-1' });
    const url = new URL(returning.url);
    expect(url.searchParams.get('client_id')).toBe('issued-client-a'); expect(url.searchParams.has('agent_name_hint')).toBe(false);
    expect(url.searchParams.get('id_token_hint')).toBe(f.selected().value.metadata.idToken);
    await f.callback(returning, { subject: 'foreign-subject' });
    await expect(f.complete(returning)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_identity_mismatch' });
    expect(f.selected().credentialID).toBe('credential-1');
    expect(readSiwcRegistrations(f.dataDirectory).accounts[0].credentialID).toBe('credential-1');
  });
  it('rejects changed returning issued client', async () => {
    const f = await fixture(); const first = await f.begin(); await f.callback(first); const result = await f.complete(first);
    const returning = await f.begin({ registrationRef: result.registrationRef, expectedActiveCredentialID: 'credential-1' });
    await f.callback(returning, { issuedClientId: 'foreign-client' });
    await expect(f.complete(returning)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_client_mismatch' });
  });
  it('keeps same-email/subject registrations distinct and rejects stale selection', async () => {
    const f = await fixture(); const first = await f.begin(); await f.callback(first); const one = await f.complete(first);
    const second = await f.begin(); await f.callback(second, { issuedClientId: 'issued-client-b' }); const two = await f.complete(second);
    const status = await f.owner.status({ directory }); expect(status.registrations).toHaveLength(2);
    expect(status.registrations[0].label).not.toBe(status.registrations[1].label);
    await expect(f.owner.select(one.registrationRef, { directory, expectedActiveCredentialID: 'credential-1' })).rejects.toMatchObject({ code: 'native_chatgpt_siwc_selection_changed' });
    expect(f.selected().credentialID).toBe(two.credentialID);
    await f.owner.select(one.registrationRef, { directory, expectedActiveCredentialID: two.credentialID });
    expect(f.selected().credentialID).toBe(one.credentialID);
  });
  it('preserves current account and previous registration mapping when completion is stale', async () => {
    const f = await fixture(); const first = await f.begin(); await f.callback(first); const one = await f.complete(first);
    const returning = await f.begin({ registrationRef: one.registrationRef }); await f.callback(returning);
    f.switchSelection({ credentialID: 'foreign', value: { type: 'key', key: 'fixture-key' } });
    await expect(f.complete(returning)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    expect(readSiwcRegistrations(f.dataDirectory).accounts[0].credentialID).toBe(one.credentialID);
    expect(readSiwcRegistrations(f.dataDirectory).accounts[0].stagedCredentialID).toBe('credential-2');
  });
  it('cancellation removes a staged inactive credential without activating or changing current account', async () => {
    const f = await fixture(); const start = await f.begin(); await f.callback(start);
    const original = f.persistCredential.getMockImplementation();
    f.persistCredential.mockImplementationOnce(async input => { const saved = await original(input); await f.owner.cancel(start.enrollmentID, { directory }); return saved; });
    await expect(f.complete(start)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_attempt_stale' });
    expect(f.selectCredential).not.toHaveBeenCalled(); expect(f.selected()).toBeNull(); expect(f.records.size).toBe(0);
    expect(readSiwcRegistrations(f.dataDirectory).accounts).toEqual([]);
  });
  it('serializes same-registration completions and never restores a stale pre-completion mapping', async () => {
    const f = await fixture(); const first = await f.begin(); await f.callback(first); const one = await f.complete(first);
    const a = await f.begin({ registrationRef: one.registrationRef }), b = await f.begin({ registrationRef: one.registrationRef });
    await f.callback(a); await f.callback(b);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const original = f.persistCredential.getMockImplementation();
    f.persistCredential.mockImplementationOnce(async input => { const saved = await original(input); entered(); await gate; return saved; });
    const completingA = f.complete(a); await started;
    await expect(f.complete(b)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_attempt_pending' });
    await expect(f.begin({ registrationRef: one.registrationRef })).rejects.toMatchObject({ code: 'native_chatgpt_siwc_attempt_pending' });
    release(); const result = await completingA;
    await expect(f.complete(b)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_changed' });
    expect(readSiwcRegistrations(f.dataDirectory).accounts[0].credentialID).toBe(result.credentialID);
    expect(f.records.size).toBe(1); expect(f.selected().credentialID).toBe(result.credentialID);
    await expect(f.owner.cancel(b.enrollmentID, { directory })).resolves.toEqual({ success: true });
  });
  it('clears only selected tokens, retaining registration and stable host ID for reconnect', async () => {
    const f = await fixture(); const first = await f.begin(); await f.callback(first); const one = await f.complete(first);
    const second = await f.begin(); await f.callback(second, { issuedClientId: 'issued-client-b' }); const two = await f.complete(second);
    const before = await f.owner.status({ directory });
    await f.owner.disconnect({ directory, expectedActiveCredentialID: two.credentialID });
    const after = await f.owner.status({ directory });
    expect(after.hostId).toBe(before.hostId); expect(f.records.has(one.credentialID)).toBe(true);
    expect(after.registrations.find(row => row.registrationRef === two.registrationRef).credentialID).toBeNull();
    const returning = await f.begin({ registrationRef: two.registrationRef, expectedActiveCredentialID: null });
    expect(new URL(returning.url).searchParams.get('client_id')).toBe('issued-client-b');
  });
  it('strips tokens from the previous host registration cache', async () => {
    const f = await fixture(); writeSiwcRegistrations(f.dataDirectory, { accounts: [{ subject: 'subject-a', clientId: 'issued-client-a', idToken: 'fixture-secret-id-token' }] });
    const first = readSiwcRegistrations(f.dataDirectory); const second = readSiwcRegistrations(f.dataDirectory);
    expect(first.accounts[0].registrationRef).toBe(second.accounts[0].registrationRef);
    expect(fs.readFileSync(path.join(f.dataDirectory, 'runtime/chatgpt-siwc-registrations.json'), 'utf8')).not.toContain('fixture-secret-id-token');
  });
});
describe('registration recovery', () => {
  it('publishes the exact recovery ID before native create and refuses initial cache failure without creating tokens', async () => {
    const f = await fixture({ autoactivateFirst: true }), start = await f.begin(); await f.callback(start);
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture-initial-publication-failed'); });
    try { await expect(f.complete(start)).rejects.toThrow('fixture-initial-publication-failed'); }
    finally { failure.mockRestore(); }
    expect(f.persistCredential).not.toHaveBeenCalled(); expect(f.records.size).toBe(0); expect(f.selected()).toBeNull();
    expect(readSiwcRegistrations(f.dataDirectory).accounts).toEqual([]);
  });
  it('retains exact staged recovery when native creation commits but its receipt is lost', async () => {
    const f = await fixture({ autoactivateFirst: true }), start = await f.begin(); await f.callback(start);
    const original = f.persistCredential.getMockImplementation();
    f.persistCredential.mockImplementationOnce(async input => { await original(input); throw new Error('fixture-lost-create-receipt'); });
    await expect(f.complete(start)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    expect(f.removeCredential).not.toHaveBeenCalled();
    const [row] = readSiwcRegistrations(f.dataDirectory).accounts;
    expect(row).toMatchObject({ credentialID: null, stagedCredentialID: f.selected().credentialID });
    await f.owner.select(row.registrationRef, { directory, expectedActiveCredentialID: f.selected().credentialID });
    expect((await f.owner.status({ directory })).registrations[0]).toMatchObject({ active: true, cleanupRequired: false });
  });
  it('keeps a precommit refusal intent accurate and allows returning enrollment to clear the missing native target', async () => {
    const f = await fixture(), start = await f.begin(); await f.callback(start);
    f.persistCredential.mockRejectedValueOnce(new Error('fixture-before-commit-refusal'));
    await expect(f.complete(start)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    const [row] = (await f.owner.status({ directory })).registrations;
    expect(row).toMatchObject({ credentialID: 'credential-1', active: false, cleanupRequired: true });
    expect(f.records.size).toBe(0); expect(f.selected()).toBeNull();
    const returning = await f.begin({ registrationRef: row.registrationRef, expectedActiveCredentialID: null });
    await f.callback(returning); await f.complete(returning);
    expect((await f.owner.status({ directory })).registrations[0]).toMatchObject({ active: true, cleanupRequired: false });
  });
  it('accepts only the exact first credential selected automatically with the captured empty selection', async () => {
    const f = await fixture({ autoactivateFirst: true }), start = await f.begin(); await f.callback(start);
    const result = await f.complete(start);
    expect(result).toMatchObject({ status: 'enrolled', credentialID: 'credential-1' });
    expect(f.selectCredential.mock.calls[0][0].expectedActiveFingerprint).toBe(fingerprint(f.selected()));
    expect((await f.owner.status({ directory })).registrations[0]).toMatchObject({ active: true, cleanupRequired: false });
  });
  it('preserves an automatically selected first credential after cancellation and finalizes it through selection without OAuth', async () => {
    const f = await fixture({ autoactivateFirst: true }), start = await f.begin(); await f.callback(start);
    const original = f.persistCredential.getMockImplementation();
    f.persistCredential.mockImplementationOnce(async input => { const saved = await original(input); await f.owner.cancel(start.enrollmentID, { directory }); return saved; });
    await expect(f.complete(start)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    expect(f.removeCredential).not.toHaveBeenCalled(); expect(f.records.size).toBe(1);
    const [row] = (await f.owner.status({ directory })).registrations;
    expect(row).toMatchObject({ active: true, cleanupRequired: true, credentialID: 'credential-1' });
    expect(await f.owner.select(row.registrationRef, { directory, expectedActiveCredentialID: 'credential-1' })).toEqual({ success: true, registrationRef: row.registrationRef });
    expect((await f.owner.status({ directory })).registrations[0]).toMatchObject({ active: true, cleanupRequired: false });
  });
  it('refuses a changed automatically selected record and retains recoverable active state', async () => {
    const f = await fixture({ autoactivateFirst: true }), start = await f.begin(); await f.callback(start);
    const original = f.persistCredential.getMockImplementation();
    f.persistCredential.mockImplementationOnce(async input => {
      const saved = await original(input); f.records.get(saved.credentialID).expectedFingerprint = fingerprint('changed'); return saved;
    });
    await expect(f.complete(start)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    expect(f.selectCredential).not.toHaveBeenCalled(); expect(f.removeCredential).not.toHaveBeenCalled();
    expect((await f.owner.status({ directory })).registrations[0]).toMatchObject({ cleanupRequired: true });
  });
  it.each([undefined, '', 'invalid'])('never drops the selection CAS for an automatically selected record with fingerprint %s', async fingerprint => {
    const f = await fixture({ autoactivateFirst: true }), start = await f.begin(); await f.callback(start);
    const original = f.readConnected.getMockImplementation();
    f.readConnected.mockImplementation(async () => ({ ...await original(), fingerprint }));
    await expect(f.complete(start)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    expect(f.selectCredential).not.toHaveBeenCalled(); expect(f.removeCredential).not.toHaveBeenCalled();
  });
  it('refuses automatic selection when an established account was captured', async () => {
    const f = await fixture({ autoactivateFirst: true }), first = await f.begin(); await f.callback(first); const one = await f.complete(first);
    const second = await f.begin(); await f.callback(second, { issuedClientId: 'issued-client-b' });
    const original = f.persistCredential.getMockImplementation();
    f.persistCredential.mockImplementationOnce(async input => { const saved = await original(input); f.switchSelection({ credentialID: saved.credentialID, value: f.records.get(saved.credentialID).value }); return saved; });
    await expect(f.complete(second)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    expect(f.selectCredential).toHaveBeenCalledTimes(1); expect(f.records.has(one.credentialID)).toBe(true);
  });
  it('does not recover inactive or missing staged credentials and rejects stale recovery selection', async () => {
    const f = await fixture({ autoactivateFirst: true }), start = await f.begin(); await f.callback(start);
    f.selectCredential.mockRejectedValueOnce(new Error('fixture-later-failure'));
    await expect(f.complete(start)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    const [row] = (await f.owner.status({ directory })).registrations;
    await expect(f.owner.select(row.registrationRef, { directory, expectedActiveCredentialID: null })).rejects.toMatchObject({ code: 'native_chatgpt_siwc_selection_changed' });
    f.switchSelection(null);
    await expect(f.owner.select(row.registrationRef, { directory, expectedActiveCredentialID: null })).rejects.toMatchObject({ code: 'native_chatgpt_siwc_reauthorization_required' });
    f.switchSelection({ credentialID: 'credential-1', value: f.records.get('credential-1').value }); f.records.delete('credential-1');
    await expect(f.owner.select(row.registrationRef, { directory, expectedActiveCredentialID: 'credential-1' })).rejects.toMatchObject({ code: 'native_chatgpt_siwc_reauthorization_required' });
  });
  it('retains the original registration guard during staged-active recovery', async () => {
    const f = await fixture({ autoactivateFirst: true }), start = await f.begin(); await f.callback(start);
    f.selectCredential.mockRejectedValueOnce(new Error('fixture-later-failure'));
    await expect(f.complete(start)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' });
    const [row] = readSiwcRegistrations(f.dataDirectory).accounts;
    const original = f.selectCredential.getMockImplementation();
    f.selectCredential.mockImplementationOnce(async input => {
      writeSiwcRegistrations(f.dataDirectory, { accounts: [{ ...row, clientId: 'changed-client' }] });
      return original(input);
    });
    await expect(f.owner.select(row.registrationRef, { directory, expectedActiveCredentialID: 'credential-1' })).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_changed' });
    expect(readSiwcRegistrations(f.dataDirectory).accounts[0]).toMatchObject({ clientId: 'changed-client', stagedCredentialID: 'credential-1' });
    expect(f.removeCredential).not.toHaveBeenCalled();
  });
  it('retains previous returning reference when final cache publication fails and reconciles the staged active record', async () => {
    const f = await fixture(); const first = await f.begin(); await f.callback(first); const one = await f.complete(first);
    const returning = await f.begin({ registrationRef: one.registrationRef }); await f.callback(returning);
    const rename = fs.renameSync; let writes = 0;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(target).endsWith('chatgpt-siwc-registrations.json') && ++writes === 2) throw new Error('fixture-publication-failed');
      return rename(source, target);
    });
    try { await expect(f.complete(returning)).rejects.toMatchObject({ code: 'native_chatgpt_siwc_registration_cleanup_required' }); }
    finally { failure.mockRestore(); }
    const row = readSiwcRegistrations(f.dataDirectory).accounts[0];
    expect(row).toMatchObject({ credentialID: one.credentialID, stagedCredentialID: f.selected().credentialID });
    expect(f.selected().credentialID).not.toBe(one.credentialID);
    expect((await f.owner.status({ directory })).registrations[0]).toMatchObject({ active: true, cleanupRequired: true });
    expect((await f.owner.status({ directory })).registrations[0].credentialID).toBe(f.selected().credentialID);
    await f.owner.select(one.registrationRef, { directory, expectedActiveCredentialID: f.selected().credentialID });
    expect(readSiwcRegistrations(f.dataDirectory).accounts[0]).toMatchObject({ credentialID: f.selected().credentialID });
    expect(readSiwcRegistrations(f.dataDirectory).accounts[0].stagedCredentialID).toBeUndefined();
    expect((await f.owner.status({ directory })).registrations[0]).toMatchObject({ active: true, cleanupRequired: false });
  });
});
describe('SIWC revocation', () => {
  const value = { type: 'oauth', refresh: 'fixture-refresh', metadata: { clientId: 'issued-client-a' } };
  it('uses discovered revocation endpoint, issued client and privately held renewable token', async () => {
    const fetchImpl = vi.fn(async (_url, init) => init?.method === 'POST' ? new Response(null, { status: 200 }) : Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' }));
    expect(await revokeSiwcSession(value, { fetchImpl })).toBe('confirmed');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://auth.openai.com/oauth/revoke');
    expect(new URLSearchParams(fetchImpl.mock.calls[1][1].body).get('token_type_hint')).toBe('refresh_token');
    expect(new URLSearchParams(fetchImpl.mock.calls[1][1].body).get('client_id')).toBe('issued-client-a');
  });
  it('refuses foreign endpoint before disclosing token and reports unconfirmed remote revocation', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ revocation_endpoint: 'https://fixture.invalid/revoke' }));
    expect(await revokeSiwcSession(value, { fetchImpl })).toBe('unconfirmed'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('retries bounded 5xx and reports remote uncertainty', async () => {
    const fetchImpl = vi.fn(async (_url, init) => init?.method === 'POST' ? new Response(null, { status: 503 }) : Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' }));
    expect(await revokeSiwcSession(value, { fetchImpl })).toBe('unconfirmed'); expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('retries one transient network failure before confirming revocation', async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init?.method !== 'POST') return Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
      if (++posts === 1) throw new Error('fixture-network');
      return new Response(null, { status: 200 });
    });
    expect(await revokeSiwcSession(value, { fetchImpl })).toBe('confirmed'); expect(posts).toBe(2);
  });

});
