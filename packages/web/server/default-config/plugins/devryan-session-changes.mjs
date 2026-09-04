// Every execution tool is captured, including MCP/context-mode and shell
// aliases. Only known read-only tools and orchestration wrappers are excluded.
const READ_ONLY = new Set(['read', 'oc_read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'todowrite', 'todoread', 'question', 'task', 'devryan_task', 'council_session']);

export default async function DevRyanSessionChangesPlugin({ directory, fetchImpl = fetch } = {}) {
  const rawUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
  const token = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  if (!rawUrl || !token) return {};
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc') throw new Error('Invalid session changes bridge');
  const rpc = async (params) => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ method: 'session_changes', params: { ...params, directory } }), signal: AbortSignal.timeout(45_000) });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error('Session change capture unavailable');
  };
  return {
    'chat.message': async (input, output) => {
      // Failure to observe must not prevent the user's prompt. Missing receipts
      // are reported as incomplete coverage by the host, never inferred later.
      await rpc({ action: 'message', sessionID: input.sessionID, userMessageID: output.message.id }).catch(() => {});
    },
    'tool.execute.before': async (input) => {
      if (!READ_ONLY.has(input.tool)) await rpc({ action: 'before', sessionID: input.sessionID, callID: input.callID }).catch(() => {});
    },
    'tool.execute.after': async (input) => {
      if (!READ_ONLY.has(input.tool)) await rpc({ action: 'after', sessionID: input.sessionID, callID: input.callID }).catch(() => {});
    },
  };
}
