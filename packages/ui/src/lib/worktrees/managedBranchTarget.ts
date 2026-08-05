export type ManagedBranchTargetResult = {
  status: 'success' | 'pending';
  source: 'root' | 'worktree' | 'created';
  branchName: string;
  directory: string;
  operationId?: string | null;
  bootstrap?: { status?: string } | null;
};

export async function ensureManagedBranchTarget(input: {
  projectId: string;
  branchName: string;
  idempotencyKey: string;
}): Promise<ManagedBranchTargetResult> {
  const response = await fetch(`/api/projects/${encodeURIComponent(input.projectId)}/branch-target`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-DevRyan-CSRF': '1',
    },
    body: JSON.stringify({ branchName: input.branchName, idempotencyKey: input.idempotencyKey }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<ManagedBranchTargetResult> & { message?: string; error?: string };
  if (!response.ok || (payload.status !== 'success' && payload.status !== 'pending') || !payload.directory) {
    throw new Error(payload.message || payload.error || `Failed to prepare branch target (${response.status})`);
  }
  return payload as ManagedBranchTargetResult;
}
