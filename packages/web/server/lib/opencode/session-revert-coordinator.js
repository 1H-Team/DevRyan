import path from 'node:path';
import { createSessionRevertCoordinator } from '@openchamber/harness-runtime';

/** Host adapter. Supply an execution owner only after every mutation path for
 * this directory is captured and confined. Runtime version alone is not proof.
 */
export function createScopedRevertCoordinator({ runtime, executions, openchamberDataDir,
  buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl = fetch, onDiagnostic, onConversationChange }) {
  const request = async (pathname, directory, body) => {
    const url = new URL(buildOpenCodeUrl(pathname, ''));
    url.searchParams.set('directory', directory);
    const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...getOpenCodeAuthHeaders?.(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw Object.assign(new Error('Conversation rollback request failed'), { code: 'conversation_rollback_failed', status: response.status });
    }
    const result = await response.json();
    if (body !== undefined) await onConversationChange?.(result);
    return result;
  };
  const endpoint = (id, action = '') => `/session/${encodeURIComponent(id)}${action}`;
  return createSessionRevertCoordinator({ directory: path.join(openchamberDataDir, 'harness', 'revert-transactions'), runtime, executions,
    onDiagnostic, conversation: {
      capabilities: async ({ directory }) => {
        try { return await request('/session/revert-capabilities', directory); }
        catch { return {}; }
      },
      get: ({ directory, sessionID }) => request(endpoint(sessionID), directory),
      revert: ({ directory, sessionID, messageID, partID, files }) => request(endpoint(sessionID, '/revert'), directory, { messageID, partID, files }),
      unrevert: ({ directory, sessionID }) => request(endpoint(sessionID, '/unrevert'), directory, {}),
    } });
}
