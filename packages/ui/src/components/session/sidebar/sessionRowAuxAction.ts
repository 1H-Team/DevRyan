export type SessionRowAuxAction = 'archive' | 'delete' | null;

export const resolveSessionRowAuxAction = (
  button: number,
  archivedBucket: boolean,
  isArchiveAncestorOnly: boolean,
): SessionRowAuxAction => {
  if (button !== 1) return null;
  if (!archivedBucket) return 'archive';
  return isArchiveAncestorOnly ? null : 'delete';
};
