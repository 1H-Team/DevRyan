export type ClaudePromptMode = 'client-only' | 'claude-only' | 'combined' | 'none' | 'custom' | 'external';

export type ClaudePromptModeState = {
  mode: ClaudePromptMode;
  compatibilityMode: boolean;
  editable: boolean;
  changed?: boolean;
};

const readError = async (response: Response, fallback: string): Promise<string> => {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === 'string' && payload.error.trim() ? payload.error : fallback;
};

export async function getClaudePromptMode(): Promise<ClaudePromptModeState> {
  const response = await fetch('/api/provider/anthropic/prompt-mode', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Unable to read Claude prompt mode.'));
  }
  return await response.json() as ClaudePromptModeState;
}

export async function setClaudeCompatibilityMode(
  compatibilityMode: boolean,
): Promise<ClaudePromptModeState> {
  const response = await fetch('/api/provider/anthropic/prompt-mode', {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-DevRyan-CSRF': '1',
    },
    body: JSON.stringify({ compatibilityMode }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Unable to update Claude prompt mode.'));
  }
  return await response.json() as ClaudePromptModeState;
}
