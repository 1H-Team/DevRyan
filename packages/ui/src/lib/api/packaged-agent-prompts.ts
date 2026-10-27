import { useConfigApplyStore } from '@/stores/useConfigApplyStore';

export interface PackagedAgentPrompt {
  name: string;
  currentHash: string | null;
  packagedHash: string;
  state: 'missing' | 'current' | 'outdated' | 'modified';
}
const endpoint = '/api/config/packaged-agent-prompts';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const parsePackagedAgentPrompts = (value: unknown): PackagedAgentPrompt[] => {
  if (!record(value) || !Array.isArray(value.prompts)) throw new Error('Invalid packaged prompt status');
  return value.prompts.map((prompt: unknown) => {
    if (!record(prompt) || typeof prompt.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(prompt.name)
      || (!hash(prompt.currentHash) && prompt.currentHash !== null) || !hash(prompt.packagedHash)
      || (prompt.state !== 'missing' && prompt.state !== 'current' && prompt.state !== 'outdated' && prompt.state !== 'modified')) {
      throw new Error('Invalid packaged prompt status');
    }
    return { name: prompt.name, currentHash: prompt.currentHash, packagedHash: prompt.packagedHash, state: prompt.state };
  });
};
const request = async (init?: RequestInit): Promise<unknown> => {
  const response = await fetch(`${endpoint}${init?.method === 'POST' ? '/restore' : ''}`, {
    credentials: 'include', ...init,
    headers: { Accept: 'application/json', ...(init?.method === 'POST' ? { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' } : {}) },
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(record(payload) && typeof payload.error === 'string' ? payload.error : 'Packaged prompt request failed');
  return payload;
};
export const getPackagedAgentPrompts = async (signal?: AbortSignal) => parsePackagedAgentPrompts(await request({ signal }));
export const restorePackagedAgentPrompt = async (prompt: PackagedAgentPrompt, signal?: AbortSignal): Promise<string | null> => {
  if (!hash(prompt.currentHash)) throw new Error('Refresh before restoring this prompt');
  const payload = await request({ method: 'POST', signal, body: JSON.stringify({ name: prompt.name, expectedHash: prompt.currentHash }) });
  useConfigApplyStore.getState().mergeMutationResponse(payload);
  return record(payload) && typeof payload.warning === 'string' ? payload.warning : null;
};
