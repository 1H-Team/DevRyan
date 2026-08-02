import type {
  EvidenceAPI,
  EvidenceProjectSetting,
  TurnEvidenceCheckpoint,
  TurnEvidenceDiffSummary,
  TurnEvidenceFileDiff,
} from '@openchamber/ui/lib/api/types';

const readJson = async <T,>(response: Response, fallback: string): Promise<T> => {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || fallback);
  }
  return response.json();
};

export const createWebEvidenceAPI = (): EvidenceAPI => ({
  async getProjectSetting(directory: string) {
    const response = await fetch(`/api/evidence/project?directory=${encodeURIComponent(directory)}`, {
      cache: 'no-store',
    });
    return readJson<EvidenceProjectSetting>(response, 'Failed to read evidence settings');
  },
  async setProjectSetting(directory: string, enabled: boolean) {
    const response = await fetch('/api/evidence/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, enabled }),
    });
    return readJson<EvidenceProjectSetting>(response, 'Failed to update evidence settings');
  },
  async clearProject(directory: string) {
    const response = await fetch(`/api/evidence/project?directory=${encodeURIComponent(directory)}`, {
      method: 'DELETE',
    });
    return readJson<{ removed: number }>(response, 'Failed to clear evidence');
  },
  async listTurns(sessionID: string, directory?: string) {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const response = await fetch(
      `/api/evidence/turns/${encodeURIComponent(sessionID)}${query}`,
      { cache: 'no-store' },
    );
    return readJson<TurnEvidenceCheckpoint[]>(response, 'Failed to list turn evidence');
  },
  async getDiff(checkpointID: string, file?: string) {
    const query = file ? `?file=${encodeURIComponent(file)}` : '';
    const response = await fetch(
      `/api/evidence/checkpoints/${encodeURIComponent(checkpointID)}/diff${query}`,
      { cache: 'no-store' },
    );
    return readJson<TurnEvidenceDiffSummary | TurnEvidenceFileDiff>(
      response,
      'Failed to read turn evidence',
    );
  },
});
