// Native archive state (OpenCode 2.1) through the admission owner: the scoped
// web archive write and the detached backfill alignment permit.
import { expect, test } from 'vitest';
import { createNativeAdmissionOwner } from './native-admission-owner.js';
import { nativeWebOperation } from './native-web-operation.js';

const directory = '/repo';
const sessionID = 'ses_archive';
const HEADER = 'x-devryan-native-permit';
const archiveOverride = (at) => ({ unrelated: 'kept', devryan: { custom: 'kept', archive: { sessionID, at } } });
const patch = (body, operation = 'sessions.archive') => ({ operation, method: 'PATCH', path: `/api/session/${sessionID}`, directory, body });

const setup = ({ metadata = { unrelated: 'kept', devryan: { custom: 'kept' } }, allowed = true } = {}) => {
  let current = structuredClone(metadata);
  const owner = createNativeAdmissionOwner({ directory, ownerID: 'fixture',
    getSession: async (id) => ({ id, directory }),
    authorizeOperation: async () => { throw Object.assign(new Error('Unscoped operation forbidden'), { code: 'unscoped' }); },
    readSessionMetadata: async (input) => ({ id: input.sessionID, directory, metadata: structuredClone(current) }),
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ held: false, revision: 0 }) },
    captureWebAuthorization: async () => async () => { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'revoked' }); } });
  const authorize = (operation, input = { sessionID }) => owner.handleRpc('native.admission.authorize',
    { operation, sessionID, existingPermit: JSON.parse(owner.requestHeaders()[HEADER]), input });
  return { owner, authorize, setMetadata: (value) => { current = structuredClone(value); } };
};

test('translates the native archived flag after metadata, only for the scoped archive write', () => {
  const metadata = archiveOverride(5);
  expect(nativeWebOperation(patch({ metadata, archived: true })).effects).toEqual([
    { operation: 'session.setMetadata', input: { sessionID, metadata } },
    { operation: 'session.archive', input: { sessionID } },
  ]);
  expect(nativeWebOperation(patch({ archived: false })).effects).toEqual([{ operation: 'session.unarchive', input: { sessionID } }]);
  expect(() => nativeWebOperation(patch({ archived: true }, 'sessions.update'))).toThrow('native_web_operation_unavailable');
  expect(() => nativeWebOperation(patch({ archived: 'yes' }))).toThrow('native_web_operation_unavailable');
});

test('the web archive write pins the override and a matching native flag', async () => {
  const { owner, authorize } = setup();
  try {
    await owner.withWebOperation(patch({ metadata: archiveOverride(5), archived: true }), async () => {
      await authorize('session.setMetadata', { sessionID, metadata: archiveOverride(5) });
      await authorize('session.archive');
      await expect(authorize('session.unarchive')).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
      await expect(authorize('session.archive', { sessionID: 'ses_other' })).rejects.toMatchObject({ code: 'native_web_payload_changed' });
    });
    // Native unarchive alone precedes the override write.
    await owner.withWebOperation(patch({ archived: false }), async () => {
      await authorize('session.unarchive');
      await expect(authorize('session.archive')).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
      await expect(authorize('session.setMetadata', { sessionID, metadata: archiveOverride(null) })).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
    });
    for (const body of [{ metadata: archiveOverride(5), archived: false }, { metadata: archiveOverride(null), archived: true },
      { archived: true }, { metadata: { devryan: { archive: { sessionID, at: 5 } } }, archived: true }]) {
      await expect(owner.withWebOperation(patch(body), async () => {})).rejects.toMatchObject({ code: 'native_archive_scope_invalid' });
    }
  } finally { owner.dispose(); }
});

test('the web archive write keeps fresh caller authorization', async () => {
  const { owner } = setup({ allowed: false });
  try {
    await expect(owner.withWebOperation(patch({ archived: false }), async () => {})).rejects.toMatchObject({ code: 'revoked' });
  } finally { owner.dispose(); }
});

test('alignment permits exactly the native flag the owned override records, without a web principal', async () => {
  const { owner, authorize, setMetadata } = setup({ metadata: archiveOverride(5), allowed: false });
  try {
    const result = await owner.withArchiveAlignment({ sessionID, directory, archived: true }, async () => owner.withWebOperation(patch({ archived: true }), async () => {
      await authorize('session.archive');
      await expect(authorize('session.unarchive')).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
      await expect(authorize('session.setMetadata', { sessionID, metadata: archiveOverride(null) })).rejects.toMatchObject({ code: 'native_permit_operation_mismatch' });
      return 'aligned';
    }));
    expect(result).toBe('aligned');

    for (const spec of [patch({ archived: false }), patch({ archived: true, metadata: archiveOverride(5) }), patch({ archived: true }, 'sessions.update'),
      { ...patch({ archived: true }), path: '/api/session/ses_other' }, { ...patch({ archived: true }), directory: '/elsewhere' }]) {
      await expect(owner.withArchiveAlignment({ sessionID, directory, archived: true }, () => owner.withWebOperation(spec, async () => {})))
        .rejects.toMatchObject({ code: 'native_archive_alignment_scope_invalid' });
    }

    // The override is reread at the native effect: a concurrent unarchive revokes the permit.
    await expect(owner.withArchiveAlignment({ sessionID, directory, archived: true }, () => owner.withWebOperation(patch({ archived: true }), async () => {
      setMetadata(archiveOverride(null));
      await authorize('session.archive');
    }))).rejects.toMatchObject({ code: 'native_archive_alignment_changed' });

    await expect(owner.withArchiveAlignment({ sessionID, directory, archived: true }, async () => {})).rejects.toMatchObject({ code: 'native_archive_alignment_changed' });
    await owner.withArchiveAlignment({ sessionID, directory, archived: false }, () => owner.withWebOperation(patch({ archived: false }),
      () => authorize('session.unarchive')));
    setMetadata({ unrelated: 'kept' });
    for (const archived of [true, false]) {
      await expect(owner.withArchiveAlignment({ sessionID, directory, archived }, async () => {})).rejects.toMatchObject({ code: 'native_archive_alignment_changed' });
    }
    setMetadata({ devryan: { archive: { sessionID: 'ses_parent', at: 5 } } });
    await expect(owner.withArchiveAlignment({ sessionID, directory, archived: true }, async () => {})).rejects.toMatchObject({ code: 'native_archive_alignment_changed' });
    await expect(owner.withArchiveAlignment({ sessionID, directory: '/elsewhere', archived: true }, async () => {})).rejects.toMatchObject({ code: 'native_archive_alignment_scope_invalid' });
    await expect(owner.withArchiveAlignment({ sessionID, directory, archived: 'yes' }, async () => {})).rejects.toMatchObject({ code: 'native_archive_alignment_scope_invalid' });
  } finally { owner.dispose(); }
});

test('a permit-less native archive is never authorized', async () => {
  const { owner } = setup({ metadata: archiveOverride(5) });
  try {
    await expect(owner.handleRpc('native.admission.authorize', { operation: 'session.archive', sessionID, input: { sessionID } }))
      .rejects.toMatchObject({ code: 'unscoped' });
  } finally { owner.dispose(); }
});
