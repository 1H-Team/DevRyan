import fs from 'node:fs/promises';
import path from 'node:path';
import { createTaskContextRuntime } from '@openchamber/harness-runtime';
import { resolveSessionPlanRevision } from '../plans/routes.js';
import { fingerprintCheckContent } from '../orchestration/required-check-observer.js';

const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const fault = (code) => Object.assign(new Error(code), { code, statusCode: 503 });

export const createHarnessTaskContextHost = (options) => {
  const request = async (pathname, directory) => {
    const url = new URL(options.buildOpenCodeUrl(pathname));
    url.searchParams.set('directory', directory);
    const response = await (options.fetchImpl ?? fetch)(url, { headers: options.getOpenCodeAuthHeaders?.() ?? {}, signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) throw fault('context_canonical_source_unavailable');
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw fault('context_canonical_source_too_large');
        chunks.push(value);
      }
      return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), next: response.headers.get('x-next-cursor') };
    } finally { await reader.cancel().catch(() => {}); }
  };
  const readMessage = async ({ sessionID, directory, messageID }) => {
    if (!identifier(sessionID) || !identifier(messageID)) throw fault('context_invalid_identity');
    const { data } = await request(`/session/${sessionID}/message/${messageID}`, directory);
    if (data?.info?.id !== messageID || data.info.sessionID !== sessionID || !Array.isArray(data.parts)) throw fault('context_message_scope_mismatch');
    return data;
  };
  // Heading and list lines of an approved plan revision, bounded. Revision
  // files are written once, so the outline is stable across compactions.
  // The plan reference comes from message content. Another session's plan is
  // read only when both sessions share an owner (`sessionOwnerKey`; without it,
  // only the session's own plan) and a project.
  const readPlanOutline = async ({ plan, context }) => {
    if (!options.dataDirectory || !identifier(plan?.sourceSessionId) || !identifier(plan?.sourceMessageId)) return null;
    let source = context.session;
    if (plan.sourceSessionId !== context.session.id) {
      if (typeof options.sessionOwnerKey !== 'function') return null;
      const [owner, sourceOwner] = await Promise.all([context.session.id, plan.sourceSessionId]
        .map((sessionID) => Promise.resolve(options.sessionOwnerKey(sessionID)).catch(() => null)));
      if (typeof owner !== 'string' || !owner || owner !== sourceOwner) return null;
      source = (await request(`/session/${plan.sourceSessionId}`, context.session.directory)).data;
      if (!source?.projectID || source.projectID !== context.session.projectID) return null;
    }
    if (source?.id !== plan.sourceSessionId || typeof source.directory !== 'string' || !path.isAbsolute(source.directory)
      || !Number.isSafeInteger(source.time?.created) || typeof source.slug !== 'string') return null;
    const revision = await resolveSessionPlanRevision({ dataDirectory: options.dataDirectory, directory: source.directory,
      sessionCreated: source.time.created, sessionSlug: source.slug, sourceMessageID: plan.sourceMessageId, path });
    const projects = await fs.realpath(path.join(options.dataDirectory, 'projects')).catch(() => null);
    const file = await fs.realpath(revision.path).catch(() => null);
    if (!projects || !file || !file.startsWith(`${projects}${path.sep}`)) return null;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const outline = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)
        .filter((line) => /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(line)).join('\n');
      return { path: revision.path, outline: outline || null };
    } finally { await handle.close(); }
  };
  const readChildAssignment = async ({ sessionID, directory }) => {
    const result = await options.getManagedRuntime().handleRpc({ method: 'child_assignment', params: { childSessionId: sessionID, directory } });
    return typeof result?.text === 'string' && result.text ? result.text : null;
  };
  const runtime = createTaskContextRuntime({ ...options,
    fingerprintFiles: fingerprintCheckContent, readMessage, readPlanOutline, readChildAssignment,
    async readScope({ sessionID, directory }) {
      if (!identifier(sessionID) || typeof directory !== 'string' || !path.isAbsolute(directory)) throw fault('context_invalid_scope');
      const [{ data: session }, { data: project }] = await Promise.all([
        request(`/session/${sessionID}`, directory), request('/project/current', directory),
      ]);
      if (session?.directory !== directory || session.id !== sessionID || project?.id !== session.projectID) throw fault('context_project_scope_mismatch');
      const registered = project.id !== 'global' && typeof project.worktree === 'string' && path.isAbsolute(project.worktree) && project.worktree !== '/';
      return { session, projectDirectory: registered ? project.worktree : directory,
        projectIdentity: registered ? `${project.id}:${project.worktree}` : `directory:${directory}` };
    },
    async readTaskState(context) {
      const sessionID = context.session.id, directory = context.session.directory;
      const primary = await options.readPrimaryRecord(sessionID);
      // The continuation owner supplies the durable real-user identity. Missing
      // ownership is unknown; a synthetic latest message cannot invent it.
      if (!primary || primary.sessionID !== sessionID || primary.directory !== directory || !identifier(primary.anchorID)) throw fault('context_objective_owner_unavailable');
      // An explicit continuation keeps the objective it continued.
      const objectiveID = identifier(primary.objectiveID) ? primary.objectiveID : primary.anchorID;
      const [anchor, { data: todos }, managed] = await Promise.all([
        readMessage({ sessionID, directory, messageID: objectiveID }),
        request(`/session/${sessionID}/todo`, directory),
        options.getManagedRuntime().handleRpc({ method: 'context_state', params: { rootSessionId: sessionID, directory } }),
      ]);
      if (!Array.isArray(todos)) throw fault('context_todos_unavailable');
      return { anchor, primary, todos, tasks: managed.tasks, envelopes: managed.envelopes };
    },
  });
  return { ...runtime, async handleRpc(input) {
    // Compaction re-anchoring is always on (host kill switch only); it never
    // writes records or exposes model-visible checkpoint tools.
    if (input.action === 'compaction_anchor') {
      return options.compactionAnchorEnabled === false ? { available: false, reason: 'compaction_anchor_disabled' }
        : runtime.compactionAnchor(input);
    }
    const capabilities = await options.getManagedRuntime().handleRpc({ method: 'harness_capabilities' });
    if (capabilities.policies.contextProjection !== true) return { available: false, reason: 'harness_policy_disabled' };
    if (input.action === 'checkpoint') return runtime.checkpoint(input);
    if (input.action === 'remember_decision') return { decision: await runtime.rememberDecision(input) };
    if (input.action === 'decisions') return { decisions: await runtime.decisions(input) };
    throw fault('context_action_invalid');
  } };
};
