/**
 * Saved approvals ("Always allow") for one project, through the DevRyan-owned
 * `/api/permission/saved` route. The server resolves the project from the
 * directory, confines rows to it and the caller's assignment, and forwards
 * updates and removals by ID. Every native row is an allow rule.
 */
export type SavedApproval = {
  id: string;
  projectID: string;
  /** Permission name: a tool such as `bash` or `edit`, or `server_tool` for MCP. */
  action: string;
  /** Input pattern the rule allows; `*` allows any input. */
  resource: string;
  anyInput: boolean;
  time: { created: number; updated: number };
};

/**
 * Editing can widen a rule for everyone on the project, so the server allows it
 * only for administrators and the local administrator; managed users may still revoke.
 */
export const canEditSavedApprovals = (principal: { scope?: string | null; role?: string | null }): boolean => (
  principal.scope !== 'managed' || principal.role === 'admin'
);

export type SavedApprovalList ={ projectID: string; approvals: SavedApproval[] };
export type SavedApprovalUpdate = { action?: string; resource?: string };

export class SavedApprovalsApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'SavedApprovalsApiError';
    this.status = status;
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseApproval = (value: unknown): SavedApproval | null => {
  if (!isRecord(value) || !isRecord(value.time)) return null;
  const { id, projectID, action, resource, anyInput } = value;
  const { created, updated } = value.time;
  if (typeof id !== 'string' || typeof projectID !== 'string' || typeof action !== 'string' || typeof resource !== 'string'
    || typeof anyInput !== 'boolean' || typeof created !== 'number' || typeof updated !== 'number') return null;
  return { id, projectID, action, resource, anyInput, time: { created, updated } };
};

const invalidResponse = () => new SavedApprovalsApiError('The server returned an invalid saved approval', 502, 'invalid_response');

const readError = async (response: Response, fallback: string): Promise<SavedApprovalsApiError> => {
  const payload: unknown = await response.json().catch(() => null);
  const message = isRecord(payload) && typeof payload.error === 'string' && payload.error.trim() ? payload.error : fallback;
  const code = isRecord(payload) && typeof payload.code === 'string' ? payload.code : null;
  return new SavedApprovalsApiError(message, response.status, code);
};

const endpoint = (directory: string, id?: string) =>
  `/api/permission/saved${id === undefined ? '' : `/${encodeURIComponent(id)}`}?directory=${encodeURIComponent(directory)}`;

const MUTATION_HEADERS = { 'content-type': 'application/json', accept: 'application/json', 'X-DevRyan-CSRF': '1' } as const;

export const fetchSavedApprovals = async (directory: string, signal?: AbortSignal): Promise<SavedApprovalList> => {
  const response = await fetch(endpoint(directory), { cache: 'no-store', headers: { accept: 'application/json' }, signal });
  if (!response.ok) throw await readError(response, 'Failed to load saved approvals');
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || typeof payload.projectID !== 'string' || !Array.isArray(payload.approvals)) throw invalidResponse();
  const approvals = payload.approvals.map(parseApproval);
  if (approvals.some((entry) => entry === null)) throw invalidResponse();
  return { projectID: payload.projectID, approvals: approvals.filter((entry): entry is SavedApproval => entry !== null) };
};

export const updateSavedApproval = async (directory: string, id: string, update: SavedApprovalUpdate): Promise<SavedApproval> => {
  const response = await fetch(endpoint(directory, id), { method: 'PATCH', headers: MUTATION_HEADERS, body: JSON.stringify(update) });
  if (!response.ok) throw await readError(response, 'Failed to update the saved approval');
  const approval = parseApproval(await response.json().catch(() => null));
  if (!approval) throw invalidResponse();
  return approval;
};

export const removeSavedApproval = async (directory: string, id: string): Promise<void> => {
  const response = await fetch(endpoint(directory, id), { method: 'DELETE', headers: MUTATION_HEADERS });
  if (!response.ok) throw await readError(response, 'Failed to revoke the saved approval');
};
