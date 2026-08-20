import type { AgentModelSelection } from '@/lib/agentModelSelection';

export type ManagedSettingsSnapshot = {
  defaultAgent?: string;
  defaultPlanMode?: boolean;
  agentModelSelections?: Record<string, AgentModelSelection>;
  multiUser?: {
    settingsOverrideKeys?: string[];
  };
};

const requestManagedSettings = async (path: string, init: RequestInit): Promise<ManagedSettingsSnapshot> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      'X-DevRyan-CSRF': '1',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Failed to update personal defaults');
  }
  return payload;
};

export const saveManagedAgentDefault = (agentName: string, selection: AgentModelSelection) => (
  requestManagedSettings(`/api/config/settings/agent-defaults/${encodeURIComponent(agentName)}`, {
    method: 'PUT',
    body: JSON.stringify(selection),
  })
);

export const resetManagedAgentDefault = (agentName: string) => (
  requestManagedSettings(`/api/config/settings/agent-defaults/${encodeURIComponent(agentName)}`, {
    method: 'DELETE',
  })
);

export const resetManagedSettingOverride = (field: 'defaultAgent' | 'defaultPlanMode') => (
  requestManagedSettings(`/api/config/settings/overrides/${field}`, { method: 'DELETE' })
);
