const GLOBAL_AGENTS_MD_ENDPOINT = '/api/behavior/agents-md';

export type GlobalAgentsMdDocument = {
  content: string;
  exists: boolean;
  editable: boolean;
  unavailableReason?: string;
};

export type GlobalAgentsMdSaveResult = GlobalAgentsMdDocument & {
  success: true;
  runtimeApplied: boolean;
  warning?: string;
};

type RequestOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

const parseDocument = (value: unknown): GlobalAgentsMdDocument => {
  if (
    !isRecord(value)
    || typeof value.content !== 'string'
    || typeof value.exists !== 'boolean'
    || typeof value.editable !== 'boolean'
    || (value.unavailableReason !== undefined && typeof value.unavailableReason !== 'string')
  ) {
    throw new Error('Invalid global AGENTS.md response');
  }

  return {
    content: value.content,
    exists: value.exists,
    editable: value.editable,
    ...(typeof value.unavailableReason === 'string' ? { unavailableReason: value.unavailableReason } : {}),
  };
};

const parseSaveResult = (value: unknown): GlobalAgentsMdSaveResult => {
  const document = parseDocument(value);
  if (
    !isRecord(value)
    || value.success !== true
    || typeof value.runtimeApplied !== 'boolean'
    || (value.warning !== undefined && typeof value.warning !== 'string')
  ) {
    throw new Error('Invalid global AGENTS.md response');
  }

  return {
    ...document,
    success: true,
    runtimeApplied: value.runtimeApplied,
    ...(typeof value.warning === 'string' ? { warning: value.warning } : {}),
  };
};

const readApiError = async (response: Response, fallback: string): Promise<string> => {
  const value = await response.json().catch(() => null) as unknown;
  return isRecord(value) && typeof value.error === 'string' && value.error.trim()
    ? value.error
    : fallback;
};

export const loadGlobalAgentsMd = async (
  options: RequestOptions = {},
): Promise<GlobalAgentsMdDocument> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(GLOBAL_AGENTS_MD_ENDPOINT, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to load global AGENTS.md'));
  }

  return parseDocument(await response.json());
};

export const saveGlobalAgentsMd = async (
  content: string,
  options: RequestOptions = {},
): Promise<GlobalAgentsMdSaveResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(GLOBAL_AGENTS_MD_ENDPOINT, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ content }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to save global AGENTS.md'));
  }

  return parseSaveResult(await response.json());
};

export const isGlobalAgentsMdSaveWarning = (result: GlobalAgentsMdSaveResult): boolean => (
  result.runtimeApplied === false && typeof result.warning === 'string' && result.warning.trim().length > 0
);
