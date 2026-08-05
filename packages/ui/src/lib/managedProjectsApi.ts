export type ManagedProjectMetadataPatch = {
  label?: string;
  icon?: string | null;
  color?: string | null;
  iconBackground?: string | null;
};

export const updateManagedProject = async (
  projectId: string,
  patch: ManagedProjectMetadataPatch,
): Promise<void> => {
  const response = await fetch(`/api/admin/projects/${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-DevRyan-CSRF': '1',
    },
    body: JSON.stringify(patch),
  });
  const payload: unknown = await response.json().catch(() => null);
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const project = record?.project;
  const error = typeof record?.error === 'string' ? record.error : null;
  if (!response.ok || !project || typeof project !== 'object') {
    throw new Error(error || 'Failed to update project');
  }
};
