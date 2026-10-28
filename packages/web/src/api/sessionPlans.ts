import type {
  SessionPlanRevisionIdentity,
  SessionPlanRevisionWrite,
  SessionPlanRevisionUpdate,
  SessionPlansAPI,
  SessionPlanSourceIdentity,
} from '@devryan/ui/lib/api/types';

const routeFor = ({ sessionId, sourceMessageId }: SessionPlanRevisionIdentity): string => (
  `/api/session/${encodeURIComponent(sessionId)}/plan-revisions/${encodeURIComponent(sourceMessageId)}`
);

const identityPayload = (input: SessionPlanRevisionIdentity) => ({
  directory: input.directory,
  sessionCreated: input.sessionCreated,
  sessionSlug: input.sessionSlug,
});

const requestJson = async (url: string, init?: RequestInit): Promise<Record<string, unknown> & { path: string; version: string }> => {
  const response = await fetch(url, init);
  const payload: unknown = await response.json().catch(() => null);
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  if (!response.ok) {
    const message = typeof value.error === 'string' ? value.error : response.statusText;
    throw Object.assign(new Error(message || `Plan request failed (${response.status})`), {
      status: response.status,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
      ...(typeof value.reason === 'string' && /^[a-z_]{1,64}$/.test(value.reason) ? { reason: value.reason } : {}),
    });
  }
  if (typeof value.path !== 'string' || typeof value.version !== 'string' || !value.version) {
    throw new Error('Invalid plan response');
  }
  return { ...value, path: value.path, version: value.version };
};

const isIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const isIdentifierList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0
  && value.length <= 2000 && value.every(isIdentifier) && new Set(value).size === value.length;
const sourceIdentity = (value: unknown, identity: SessionPlanRevisionIdentity): SessionPlanSourceIdentity | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plan response');
  const proof = value as Record<string, unknown>;
  const keys = new Set(['sessionID', 'sourceMessageID', 'rootUserMessageID', 'memberUserMessageIDs', 'memberAssistantMessageIDs', 'currentSourceMessageID', 'successful', 'settled', 'current']);
  if (Object.keys(proof).some(key => !keys.has(key)) || proof.sessionID !== identity.sessionId || proof.sourceMessageID !== identity.sourceMessageId
    || !isIdentifier(proof.sessionID) || !isIdentifier(proof.sourceMessageID) || !isIdentifier(proof.rootUserMessageID) || !isIdentifier(proof.currentSourceMessageID)
    || !isIdentifierList(proof.memberUserMessageIDs) || proof.memberUserMessageIDs.length > 3 || proof.memberUserMessageIDs[0] !== proof.rootUserMessageID
    || !isIdentifierList(proof.memberAssistantMessageIDs) || !proof.memberAssistantMessageIDs.includes(proof.sourceMessageID)
    || proof.memberAssistantMessageIDs.at(-1) !== proof.currentSourceMessageID || proof.successful !== true || proof.settled !== true || typeof proof.current !== 'boolean') throw new Error('Invalid plan response');
  return { sessionID: proof.sessionID, sourceMessageID: proof.sourceMessageID, rootUserMessageID: proof.rootUserMessageID,
    memberUserMessageIDs: proof.memberUserMessageIDs, memberAssistantMessageIDs: proof.memberAssistantMessageIDs,
    currentSourceMessageID: proof.currentSourceMessageID, successful: true, settled: true, current: proof.current };
};

const mutationHeaders = {
  'Content-Type': 'application/json',
  'X-DevRyan-CSRF': '1',
};

// V2 creation events retain a display slug while later canonical session reads
// may use the session ID. Refresh that alias only after the server identifies
// the mismatch; birth, source, directory and saved-version fences stay fixed.
const withCanonicalSlug = async (
  identity: SessionPlanRevisionIdentity,
  request: (current: SessionPlanRevisionIdentity) => ReturnType<typeof requestJson>,
): ReturnType<typeof requestJson> => {
  try { return await request(identity); } catch (error) {
    if (!(error instanceof Error) || !('status' in error) || error.status !== 409
      || !('code' in error) || error.code !== 'plan_identity_mismatch') throw error;
    const query = new URLSearchParams({ directory: identity.directory });
    const response = await fetch(`/api/session/${encodeURIComponent(identity.sessionId)}?${query}`, { cache: 'no-store' });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)
      || !('id' in value) || value.id !== identity.sessionId || !('directory' in value)
      || value.directory !== identity.directory || !('time' in value)
      || !value.time || typeof value.time !== 'object' || !('created' in value.time)
      || value.time.created !== identity.sessionCreated || !('slug' in value)
      || typeof value.slug !== 'string' || !value.slug.trim() || value.slug.length > 256
      || /\p{Cc}/u.test(value.slug) || value.slug === identity.sessionSlug) throw error;
    return request({ ...identity, sessionSlug: value.slug });
  }
};

export const createWebSessionPlansAPI = (): SessionPlansAPI => ({
  async ensureRevision(input: SessionPlanRevisionWrite) {
    const result = await withCanonicalSlug(input, current => requestJson(routeFor(current), {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ ...identityPayload(current), markdown: input.markdown }),
    }));
    if (typeof result.created !== 'boolean') throw new Error('Invalid plan response');
    const proof = sourceIdentity(result.sourceIdentity, input);
    if (proof) {
      if (!/^[a-f0-9]{64}$/.test(result.version) || typeof result.content !== 'string') throw new Error('Invalid plan response');
      return { path: result.path, created: result.created, version: result.version, sourceIdentity: proof, content: result.content };
    }
    return { path: result.path, created: result.created, version: result.version };
  },

  async readRevision(input: SessionPlanRevisionIdentity) {
    const result = await withCanonicalSlug(input, current => {
      const query = new URLSearchParams({ directory: current.directory,
        sessionCreated: String(current.sessionCreated), sessionSlug: current.sessionSlug });
      return requestJson(`${routeFor(current)}?${query.toString()}`, { cache: 'no-store' });
    });
    if (typeof result.content !== 'string') throw new Error('Invalid plan response');
    const proof = sourceIdentity(result.sourceIdentity, input);
    if (proof && !/^[a-f0-9]{64}$/.test(result.version)) throw new Error('Invalid plan response');
    return { path: result.path, content: result.content, version: result.version, ...(proof ? { sourceIdentity: proof } : {}) };
  },

  async updateRevision(input: SessionPlanRevisionUpdate) {
    const result = await withCanonicalSlug(input, current => requestJson(routeFor(current), {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({ ...identityPayload(current), markdown: input.markdown, expectedVersion: input.expectedVersion }),
    }));
    if (typeof result.saved !== 'boolean') throw new Error('Invalid plan response');
    const proof = sourceIdentity(result.sourceIdentity, input);
    if (proof && !/^[a-f0-9]{64}$/.test(result.version)) throw new Error('Invalid plan response');
    return { path: result.path, saved: result.saved, version: result.version,
      ...(proof ? { sourceIdentity: proof } : {}), ...(typeof result.content === 'string' ? { content: result.content } : {}) };
  },
});
