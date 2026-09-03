import type {
  ProcessesAPI,
  ProcessesSnapshot,
  ProcessStopResult,
  ProcessTrackingProjectSetting,
} from '@openchamber/ui/lib/api/types';

const readJson = async <T,>(response: Response, fallback: string): Promise<T> => {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || fallback);
  }
  return response.json();
};

export const createWebProcessesAPI = (): ProcessesAPI => ({
  async list(directory?: string | null) {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const response = await fetch(`/api/processes${query}`, { cache: 'no-store' });
    return readJson<ProcessesSnapshot>(response, 'Failed to list processes');
  },
  async stop(pid: number, startedAt: number | null) {
    const response = await fetch(`/api/processes/${encodeURIComponent(String(pid))}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startedAt }),
    });
    return readJson<ProcessStopResult>(response, 'Failed to stop process');
  },
  async getProjectSetting(directory: string) {
    const response = await fetch(`/api/processes/project?directory=${encodeURIComponent(directory)}`, {
      cache: 'no-store',
    });
    return readJson<ProcessTrackingProjectSetting>(response, 'Failed to read process tracking settings');
  },
  async setProjectSetting(directory: string, value: { trackAgentProcesses?: boolean; heavyCheckSlots?: number }) {
    const response = await fetch('/api/processes/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, ...value }),
    });
    return readJson<ProcessTrackingProjectSetting>(response, 'Failed to update process tracking settings');
  },
});
