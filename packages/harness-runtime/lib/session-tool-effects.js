// These are workspace effects, not permission grants. An origin must already
// have passed the host's registration and invocation checks before use here.
const descriptors = Object.freeze({
  read: { kind: 'native', id: 'opencode.tool.read' },
  glob: { kind: 'native', id: 'opencode.tool.glob' },
  grep: { kind: 'native', id: 'opencode.tool.grep' },
  skill: { kind: 'native', id: 'opencode.tool.skill' },
  question: { kind: 'native', id: 'opencode.tool.question' },
  webfetch: { kind: 'plugin', id: 'devryan.slim' },
  devryan_document: { kind: 'plugin', id: 'devryan.document-reader' },
  devryan_plan_read: { kind: 'plugin', id: 'devryan.managed-task' },
  devryan_task: { kind: 'plugin', id: 'devryan.managed-task' },
  council_session: { kind: 'plugin', id: 'devryan.council' },
  todoread: { kind: 'plugin', id: 'devryan.harness-context' },
  todowrite: { kind: 'plugin', id: 'devryan.harness-context' },
});

export const REVIEWED_READ_ONLY_TOOLS = Object.freeze(Object.keys(descriptors));

export function reviewedToolEffect({ tool, origin, reviewedOrigin }) {
  const expected = descriptors[tool];
  if (!expected || !origin || !reviewedOrigin || origin.kind !== expected.kind || origin.id !== expected.id
    || reviewedOrigin.kind !== expected.kind || reviewedOrigin.id !== expected.id
    || typeof origin.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(origin.manifestDigest)
    || origin.manifestDigest !== reviewedOrigin.manifestDigest
    || !Array.isArray(origin.capabilities) || !Array.isArray(reviewedOrigin.capabilities)
    || JSON.stringify(origin.capabilities) !== JSON.stringify(reviewedOrigin.capabilities)) return null;
  return { version: 1, tool, kind: origin.kind, id: origin.id, manifestDigest: origin.manifestDigest, effect: 'read-only' };
}
