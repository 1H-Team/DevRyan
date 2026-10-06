import path from 'node:path';
import { createSessionRevertCoordinator } from '@openchamber/harness-runtime';
import { createCapabilityAbsentError, OPENCODE_CAPABILITY_ABSENT, resolveOpenCodeGeneration } from './opencode-generation.js';
import { createPrivilegedOpenCodeClient } from './opencode-client/privileged.js';

const REQUEST_TIMEOUT_MS = 15_000;

const rollbackFailure = (status, cause) => Object.assign(
  new Error('Conversation rollback request failed', cause === undefined ? undefined : { cause }),
  { code: 'conversation_rollback_failed', status },
);

const invalidTree = () => Object.assign(new Error('Invalid session tree'), { code: 'invalid_session_tree', status: 503 });

/** Gen 2: reads through the client; the companion's conversation revert is absent until the Phase 3 coordinator. */
const createV2Conversation = ({ openCodeClient }) => {
  const read = async (task) => {
    try {
      return await task({ timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (cause) {
      throw rollbackFailure(Number.isInteger(cause?.statusCode) ? cause.statusCode : 502, cause);
    }
  };
  return {
    // Typed absence: no `legacyConversationRevert`, so the coordinator refuses
    // with `mutation_runtime_unsupported` before any mutation.
    capabilities: async () => ({ [OPENCODE_CAPABILITY_ABSENT]: true, capability: 'conversation_revert', generation: 2 }),
    get: ({ directory, sessionID }) => read((options) => openCodeClient.sessions.get(sessionID, { ...options, directory })),
    children: async ({ directory, sessionID }) => {
      const children = await read((options) => openCodeClient.sessions.children(sessionID, { ...options, directory }));
      if (!Array.isArray(children)) throw invalidTree();
      return children;
    },
    message: ({ directory, sessionID, messageID }) => read((options) => openCodeClient.sessions.message(sessionID, messageID, { ...options, directory })),
    revert: async () => { throw createCapabilityAbsentError('conversation_revert'); },
    unrevert: async () => { throw createCapabilityAbsentError('conversation_revert'); },
  };
};

/** Qualified native markers contain no snapshots; the ledger alone changes files. */
export function createNativeRevertConversation({ openCodeClient, clientDeps, privilegedClient = createPrivilegedOpenCodeClient(clientDeps), admissionOwner, isReady, onConversationChange }) {
  const base = createV2Conversation({ openCodeClient });
  const marker = (session) => {
    if (!session?.revert) return session;
    if (session.revert.snapshot || (session.revert.files !== undefined && (!Array.isArray(session.revert.files) || session.revert.files.length))) {
      throw rollbackFailure(409, new Error('native_snapshot_history_unavailable'));
    }
    return { ...session, revert: { ...session.revert, fileRestore: false } };
  };
  const get = async input => marker(await base.get(input));
  const mutate = async (input, operation) => {
    if (!await isReady() || !input.transactionID || (operation === 'session.revert.stage' && (input.files !== false || input.partID))) {
      throw createCapabilityAbsentError('conversation_revert');
    }
    // Native clear/stage can restore a pre-existing snapshot even when the
    // new stage requests files:false. Reject such history before the mutation.
    await get(input);
    return admissionOwner.withRevertOperation({ ...input, operation }, async () => {
      const options = { directory: input.directory, timeoutMs: REQUEST_TIMEOUT_MS };
      if (operation === 'session.revert.stage') await privilegedClient.revert.stage(input.sessionID, { messageID: input.messageID, files: false }, options);
      else await privilegedClient.revert.clear(input.sessionID, options);
      const result = await get(input);
      if (operation === 'session.revert.stage' ? result.revert?.messageID !== input.messageID : result.revert !== undefined) {
        throw rollbackFailure(409, new Error('native_revert_result_mismatch'));
      }
      await onConversationChange?.(result);
      return result;
    });
  };
  return { ...base, get,
    capabilities: async () => await isReady() ? { conversationOnlyRevert: 1 } : base.capabilities(),
    revert: input => mutate(input, 'session.revert.stage'), unrevert: input => mutate(input, 'session.revert.clear'),
    releaseHolds: input => admissionOwner.releaseTransactionHolds(input),
    recoverHolds: input => admissionOwner.recoverTransactionHolds(input),
  };
}

/** Native conversation port; validate the current runtime on every call. */
export function createScopedRevertConversation({ openCodeClient, nativeConversation }) {
  const conversation = nativeConversation ?? createV2Conversation({ openCodeClient });
  return Object.fromEntries(['capabilities', 'get', 'children', 'message', 'revert', 'unrevert', 'releaseHolds', 'recoverHolds']
    .map((name) => [name, async (input) => {
      resolveOpenCodeGeneration(openCodeClient);
      return conversation[name]?.(input);
    }]));
}

/** Host adapter. Supply an execution owner only after every mutation path for
 * this directory is captured and confined. Runtime version alone is not proof.
 */
export function createScopedRevertCoordinator({ runtime, executions, openchamberDataDir,
  onDiagnostic, legacy, openCodeClient, nativeConversation, windowsOwner, windowsLauncher }) {
  return createSessionRevertCoordinator({ directory: path.join(openchamberDataDir, 'harness', 'revert-transactions'), runtime, executions,
    onDiagnostic, legacy, windowsOwner, windowsLauncher, conversation: createScopedRevertConversation({
      openCodeClient, nativeConversation,
    }) });
}
