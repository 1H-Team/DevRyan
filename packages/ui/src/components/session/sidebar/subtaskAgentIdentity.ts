const normalizeAgentName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

export function resolveSubtaskIconAgent({
  managedTaskAgent,
  sessionAgent,
}: {
  managedTaskAgent?: unknown;
  sessionAgent?: unknown;
}): string | undefined {
  return normalizeAgentName(managedTaskAgent) ?? normalizeAgentName(sessionAgent);
}
