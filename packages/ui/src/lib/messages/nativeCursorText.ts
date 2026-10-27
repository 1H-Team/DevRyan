type TextProvenancePart = { type?: unknown; id?: unknown; metadata?: unknown };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The existing native Cursor ingress owns these part identities; text content
 * cannot establish replay or formatting authority. */
export function hasNativeCursorTextProvenance(part: TextProvenancePart): boolean {
  if (part.type !== 'text' && part.type !== 'reasoning' || typeof part.id !== 'string' || !record(part.metadata)) return false;
  const state = part.type === 'text' ? part.metadata.providerState : part.metadata;
  if (!record(state) || !record(state.devryan) || !record(state.devryan.cursor)) return false;
  return state.devryan.cursor.partID === part.id;
}
