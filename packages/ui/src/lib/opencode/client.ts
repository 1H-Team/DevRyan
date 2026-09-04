import { getSafeStorage } from '@/stores/utils/safeStorage';
import { createOpencodeClient, OpencodeClient } from "@opencode-ai/sdk/v2";
import type { FilesAPI, RuntimeAPIs } from "../api/types";
import { getDesktopHomeDirectory } from "../desktop";
import type {
  Session,
  Message,
  Part,
  Provider,
  Config,
  Model,
  Agent,
  TextPartInput,
  FilePartInput,
} from "@opencode-ai/sdk/v2";
import type { PermissionRequest } from "@/types/permission";
import type { QuestionRequest } from "@/types/question";
import { waitForWorktreeBootstrapForSend } from "@/lib/worktrees/worktreeBootstrap";
import { postTurnTimingMark, streamDebugMark } from "@/stores/utils/streamDebug";
import {
  assertProviderCircuitClosed,
  recordProviderSuccess,
  recordProviderError,
  shouldRetry,
  getRetryDelayMs,
} from "./provider-tracker";
import { resolveProviderPromptTools } from "./provider-prompt-tools";
import { getSdkErrorMessage } from './sdk-error';

// Use relative path by default (works with both dev and nginx proxy server)
// Can be overridden with VITE_OPENCODE_URL for absolute URLs in special deployments
const DEFAULT_BASE_URL = import.meta.env.VITE_OPENCODE_URL || "/api";
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
const NO_STORE_CACHE_METHODS = new Set(["GET", "HEAD"]);
const ID_RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_RANDOM_LENGTH = 14;
const SCOPED_REVERT_CLIENT_TIMEOUT_MS = 35_000;
const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  'application/atom+xml',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/rss+xml',
  'application/toml',
  'application/typescript',
  'application/x-bash',
  'application/xhtml+xml',
  'application/xml',
  'application/x-javascript',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-yaml',
  'application/yaml',
  'image/svg+xml',
]);
const UNKNOWN_ATTACHMENT_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.env',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.markdown',
  '.md',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

let lastIdTimestamp = 0;
let idCounter = 0;

const randomBase62 = (length: number): string => {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += ID_RANDOM_CHARS[bytes[index] % ID_RANDOM_CHARS.length];
  }
  return result;
};

const ascendingId = (prefix: "msg"): string => {
  const timestamp = Date.now();
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;

  const sortable = BigInt(timestamp) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = new Uint8Array(6);
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }
  const hex = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}${randomBase62(ID_RANDOM_LENGTH)}`;
};

const isRetryableFetchError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof TypeError) return true;
  return false;
};

const normalizeMimeType = (mime: string | undefined): string => {
  const raw = typeof mime === 'string' ? mime.trim() : '';
  if (!raw) return '';
  return raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
};

const getFilenameExtension = (filename: string | undefined): string => {
  if (!filename) return '';
  const normalized = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return normalized.slice(dotIndex).toLowerCase();
};

const isTextLikeMimeType = (mime: string): boolean => {
  const normalized = normalizeMimeType(mime);
  if (!normalized) return false;
  if (normalized.startsWith('text/')) return true;
  if (TEXT_ATTACHMENT_MIME_TYPES.has(normalized)) return true;
  return normalized.endsWith('+json') || normalized.endsWith('+xml');
};

const parseDataUrl = (url: string): { mime: string; payload: string; isBase64: boolean } | null => {
  if (!url.startsWith('data:')) return null;
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) return null;

  const metadata = url.slice(5, commaIndex);
  const payload = url.slice(commaIndex + 1);
  const metadataParts = metadata.split(';').map((part) => part.trim());
  const mime = normalizeMimeType(metadataParts[0] ?? '');
  const isBase64 = metadataParts.some((part) => part.toLowerCase() === 'base64');

  return { mime, payload, isBase64 };
};

type SdkResult<T> = {
  data?: T;
  error?: unknown;
  response?: { status?: number };
};

type SessionStatusMap = Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>;

const getSdkErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const directStatus = (error as { status?: unknown }).status;
  if (typeof directStatus === "number") return directStatus;
  const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
  return typeof responseStatus === "number" ? responseStatus : undefined;
};

const createFormattedSdkError = (operation: string, message: string, status?: number): Error => {
  const error = new Error(`${operation} failed${status !== undefined ? ` (${status})` : ""}: ${message}`);
  if (status !== undefined) {
    (error as Error & { status?: number }).status = status;
  }
  (error as Error & { __opencodeFormatted?: boolean }).__opencodeFormatted = true;
  return error;
};

const formatSdkError = (operation: string, error: unknown): Error => {
  if (error instanceof Error && (error as Error & { __opencodeFormatted?: boolean }).__opencodeFormatted) {
    return error;
  }
  return createFormattedSdkError(operation, getSdkErrorMessage(error), getSdkErrorStatus(error));
};

const unwrapSdkData = <T,>(result: SdkResult<T>, operation: string): T => {
  if (result.error) {
    throw createFormattedSdkError(operation, getSdkErrorMessage(result.error), result.response?.status);
  }
  if (result.data === undefined || result.data === null) {
    throw createFormattedSdkError(operation, "returned no data", result.response?.status);
  }
  return result.data;
};

const ensureAbsoluteBaseUrl = (candidate: string): string => {
  const normalized = typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "/api";

  if (ABSOLUTE_URL_PATTERN.test(normalized)) {
    return normalized;
  }

  if (typeof window === "undefined") {
    return normalized;
  }

  const baseReference = window.location?.href || window.location?.origin;
  if (!baseReference) {
    return normalized;
  }

  try {
    return new URL(normalized, baseReference).toString();
  } catch (error) {
    console.warn("Failed to normalize OpenCode base URL:", error);
    return normalized;
  }
};

const getFetchMethod = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): string => {
  if (typeof init?.method === "string" && init.method.trim().length > 0) {
    return init.method.trim().toUpperCase();
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
};

export const createNoStoreApiFetch = (): typeof fetch => {
  const noStoreFetch: typeof fetch = (input, init) => {
    const method = getFetchMethod(input, init);
    if (!NO_STORE_CACHE_METHODS.has(method)) {
      return globalThis.fetch(input, init);
    }

    if (typeof Request !== "undefined" && input instanceof Request) {
      return globalThis.fetch(new Request(input, { ...init, cache: "no-store" }));
    }

    return globalThis.fetch(input, { ...init, cache: "no-store" });
  };

  return noStoreFetch;
};

const resolveDesktopBaseUrl = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const desktopServer = (window as typeof window & {
    __OPENCHAMBER_DESKTOP_SERVER__?: { origin: string; apiPrefix?: string };
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }).__OPENCHAMBER_DESKTOP_SERVER__;

  const isDesktop = Boolean(
    (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__?.runtime?.isDesktop
  );

  if (!desktopServer || !isDesktop) {
    return null;
  }

  const origin = typeof desktopServer.origin === "string" && desktopServer.origin.length > 0 ? desktopServer.origin : null;
  if (!origin) {
    return null;
  }

  return `${origin}/api`;
};

interface App {
  version?: string;
  [key: string]: unknown;
}

export type FilesystemEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink?: boolean;
};

export type ProjectFileSearchHit = {
  name: string;
  path: string;
  relativePath: string;
  extension?: string;
};

type AgentPartInputLite = {
  type: 'agent';
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

type FileInputLite = {
  id?: string;
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
};

type ImmediateSubtaskPromptAgentMention = {
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

type ImmediateSubtaskAdditionalPart = {
  text: string;
  synthetic?: boolean;
  files?: Array<FileInputLite>;
};

export type DirectorySwitchResult = {
  success: boolean;
  restarted: boolean;
  path: string;
  agents?: Agent[];
  providers?: Provider[];
  models?: unknown[];
};

const normalizeFsPath = (path: string): string => path.replace(/\\/g, "/");
const FS_LIST_CACHE_TTL_MS = 400;

const getDesktopFilesApi = (): FilesAPI | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const apis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__;
  if (apis && apis.runtime?.isDesktop && apis.files) {
    return apis.files;
  }
  return null;
};

// Scoped (tree) revert contract. The server is written concurrently against
// these shapes, so every parser below tolerates missing or partial fields.
export type ScopedRevertScope = "tree" | "session";

export type ScopedRevertFile = { path: string; status: string };
export type ScopedRevertSessionTarget = { id: string; targetMessageID: string };

export type ScopedSessionRevertResult = {
  session: Session;
  reverted: { files: ScopedRevertFile[]; sessions: ScopedRevertSessionTarget[] };
  verification: { ok: boolean; files?: ScopedRevertFile[] } | null;
  redoAvailable: boolean;
};

export type ScopedSessionUnrevertResult = {
  session: Session;
  restored: ScopedRevertFile[];
};

export type SessionTreeChangedFileStatus = "added" | "modified" | "deleted" | "renamed";

export type SessionTreeChangedFile = {
  path: string;
  oldPath?: string | null;
  status: SessionTreeChangedFileStatus;
  additions: number | null;
  deletions: number | null;
  sessions: string[];
};

export type SessionTreeChanges = {
  revision?: string;
  directory?: string;
  worktreeID?: string;
  worktreeDirectory?: string;
  coverage?: 'complete' | 'partial';
  reasons?: string[];
  undone?: boolean;
  files: SessionTreeChangedFile[];
  sessionCount: number;
  hasUnattributedMutations: boolean;
  firstUserMessageID: string | null;
  rootSessionID: string | null;
};

/**
 * Error thrown by the scoped revert routes. `code` mirrors the server's error
 * code (`working_tree_changed`, `directory_busy`, `redo_unavailable`, …) and
 * `files` / `sessions` carry whatever detail the server attached.
 */
export class ScopedRevertError extends Error {
  code?: string;
  status?: number;
  files?: ScopedRevertFile[];
  sessions?: ScopedRevertSessionTarget[];

  constructor(message: string, init: {
    code?: string;
    status?: number;
    files?: ScopedRevertFile[];
    sessions?: ScopedRevertSessionTarget[];
  } = {}) {
    super(message);
    this.name = "ScopedRevertError";
    this.code = init.code;
    this.status = init.status;
    this.files = init.files;
    this.sessions = init.sessions;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const parseScopedRevertFiles = (value: unknown): ScopedRevertFile[] => {
  if (!Array.isArray(value)) return [];
  const files: ScopedRevertFile[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      files.push({ path: entry, status: "modified" });
      continue;
    }
    if (!isRecord(entry) || typeof entry.path !== "string") continue;
    files.push({ path: entry.path, status: typeof entry.status === "string" ? entry.status : "modified" });
  }
  return files;
};

const parseScopedRevertSessions = (value: unknown): ScopedRevertSessionTarget[] => {
  if (!Array.isArray(value)) return [];
  const sessions: ScopedRevertSessionTarget[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      sessions.push({ id: entry, targetMessageID: "" });
      continue;
    }
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    sessions.push({
      id: entry.id,
      targetMessageID: typeof entry.targetMessageID === "string" ? entry.targetMessageID : "",
    });
  }
  return sessions;
};

const SCOPED_REVERT_ENVELOPE_KEYS = new Set(["reverted", "verification", "redoAvailable", "restored"]);

const parseScopedRevertSession = (payload: Record<string, unknown>): Session | null => {
  if (isRecord(payload.session) && typeof payload.session.id === "string") {
    return payload.session as unknown as Session;
  }
  // Older shape: the session fields are spread on the top-level payload.
  if (typeof payload.id === "string") {
    const session: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (!SCOPED_REVERT_ENVELOPE_KEYS.has(key)) session[key] = value;
    }
    return session as unknown as Session;
  }
  return null;
};

async function readScopedRevertError(response: Response, fallback: string): Promise<ScopedRevertError> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const code = payload && typeof payload.code === "string" ? payload.code : undefined;
  const detail = payload && typeof payload.error === "string" && payload.error.length > 0
    ? `: ${payload.error}`
    : "";
  return new ScopedRevertError(`${fallback} (${response.status})${detail}`, {
    code,
    status: response.status,
    files: parseScopedRevertFiles(payload?.files),
    sessions: parseScopedRevertSessions(payload?.sessions),
  });
}

function buildScopedRevertUrl(baseUrl: string, sessionId: string, route: string, directory?: string): URL {
  const base = baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/openchamber/session/${encodeURIComponent(sessionId)}/${route}`);
  if (directory && directory.length > 0) {
    url.searchParams.set("directory", directory);
  }
  return url;
}

async function raceScopedRevertWatchdog<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new ScopedRevertError(timeoutMessage, { code: "SCOPED_REVERT_TIMEOUT", status: 504 });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request(controller.signal), watchdog]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function requestScopedSessionRevert({
  baseUrl,
  sessionId,
  messageId,
  directory,
  scope = "tree",
  rootSessionId,
  timeoutMs = SCOPED_REVERT_CLIENT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}: {
  baseUrl: string;
  sessionId: string;
  messageId: string;
  directory?: string;
  scope?: ScopedRevertScope;
  rootSessionId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ScopedSessionRevertResult> {
  const url = buildScopedRevertUrl(baseUrl, sessionId, "scoped-revert", directory);

  return raceScopedRevertWatchdog(async (signal) => {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messageID: messageId,
        scope,
        ...(rootSessionId ? { rootSessionID: rootSessionId, rootSessionId } : {}),
      }),
      signal,
    });

    if (!response.ok) {
      throw await readScopedRevertError(response, "Failed to revert session safely");
    }

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const session = payload ? parseScopedRevertSession(payload) : null;
    if (!payload || !session) throw new ScopedRevertError("Failed to revert session safely");

    const reverted = isRecord(payload.reverted) ? payload.reverted : {};
    const verification = isRecord(payload.verification)
      ? {
        ok: payload.verification.ok !== false,
        ...(Array.isArray(payload.verification.files)
          ? { files: parseScopedRevertFiles(payload.verification.files) }
          : {}),
      }
      : null;

    return {
      session,
      reverted: {
        files: parseScopedRevertFiles(reverted.files),
        sessions: parseScopedRevertSessions(reverted.sessions),
      },
      verification,
      redoAvailable: payload.redoAvailable === true,
    };
  }, timeoutMs, "Scoped session revert timed out");
}

export async function requestScopedSessionUnrevert({
  baseUrl,
  sessionId,
  directory,
  timeoutMs = SCOPED_REVERT_CLIENT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}: {
  baseUrl: string;
  sessionId: string;
  directory?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ScopedSessionUnrevertResult> {
  const url = buildScopedRevertUrl(baseUrl, sessionId, "scoped-unrevert", directory);

  return raceScopedRevertWatchdog(async (signal) => {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      signal,
    });

    if (!response.ok) {
      throw await readScopedRevertError(response, "Failed to restore reverted session");
    }

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const session = payload ? parseScopedRevertSession(payload) : null;
    if (!payload || !session) throw new ScopedRevertError("Failed to restore reverted session");

    return {
      session,
      restored: parseScopedRevertFiles(payload.restored),
    };
  }, timeoutMs, "Scoped session unrevert timed out");
}

const parseSessionTreeChangedFileStatus = (value: unknown): SessionTreeChangedFileStatus => {
  if (value === "added" || value === "deleted" || value === "modified" || value === "renamed") return value;
  if (value === "A" || value === "?" || value === "created") return "added";
  if (value === "D" || value === "removed") return "deleted";
  return "modified";
};

const parseCount = (value: unknown): number => (
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
);

export function parseSessionTreeChanges(payload: unknown): SessionTreeChanges {
  const record = isRecord(payload) ? payload : {};
  const files: SessionTreeChangedFile[] = [];
  if (Array.isArray(record.files)) {
    for (const entry of record.files) {
      if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0) continue;
      files.push({
        path: entry.path,
        status: parseSessionTreeChangedFileStatus(entry.status),
        additions: entry.additions === null ? null : parseCount(entry.additions ?? entry.insertions),
        deletions: entry.deletions === null ? null : parseCount(entry.deletions),
        ...(typeof entry.oldPath === "string" ? { oldPath: entry.oldPath } : {}),
        sessions: Array.isArray(entry.sessions)
          ? entry.sessions.filter((id): id is string => typeof id === "string")
          : [],
      });
    }
  }

  const sessionIds = new Set<string>();
  for (const file of files) {
    for (const id of file.sessions) sessionIds.add(id);
  }

  return {
    ...(typeof record.revision === 'string' ? {
      revision: record.revision,
      directory: typeof record.directory === 'string' ? record.directory : undefined,
      worktreeID: typeof record.worktreeID === 'string' ? record.worktreeID : undefined,
      worktreeDirectory: typeof record.worktreeDirectory === 'string' ? record.worktreeDirectory : undefined,
      undone: record.undone === true,
    } : {}),
    coverage: record.revision && record.coverage === 'complete' ? 'complete' : 'partial',
    reasons: Array.isArray(record.reasons) ? record.reasons.filter((reason): reason is string => typeof reason === 'string') : ['capture_unavailable'],
    files,
    sessionCount: typeof record.sessionCount === "number" && Number.isFinite(record.sessionCount)
      ? Math.max(0, Math.trunc(record.sessionCount))
      : sessionIds.size,
    hasUnattributedMutations: record.hasUnattributedMutations === true,
    firstUserMessageID: typeof record.firstUserMessageID === "string" && record.firstUserMessageID.length > 0
      ? record.firstUserMessageID
      : null,
    rootSessionID: typeof record.rootSessionID === "string" && record.rootSessionID.length > 0
      ? record.rootSessionID
      : null,
  };
}

export async function requestSessionTreeChanges({
  baseUrl,
  sessionId,
  directory,
  fetchImpl = globalThis.fetch,
  signal,
}: {
  baseUrl: string;
  sessionId: string;
  directory?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<SessionTreeChanges> {
  const url = buildScopedRevertUrl(baseUrl, sessionId, "changes", directory);
  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw await readScopedRevertError(response, "Failed to load session changes");
  }

  const payload = await response.json().catch(() => null);
  return parseSessionTreeChanges(payload);
}

class OpencodeService {
  private client: OpencodeClient;
  private baseUrl: string;
  private noStoreFetch: typeof fetch = createNoStoreApiFetch();
  private scopedClients: Map<string, OpencodeClient> = new Map();
  private currentDirectory: string | undefined = undefined;
  private contextModeAvailable = false;
  private directoryContextQueue: Promise<void> = Promise.resolve();
  private listDirectoryInFlight: Map<string, Promise<FilesystemEntry[]>> = new Map();
  private listDirectoryCache: Map<string, { entries: FilesystemEntry[]; expiresAt: number }> = new Map();
  private listDirectoryGeneration: Map<string, number> = new Map();

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    const desktopBase = resolveDesktopBaseUrl();
    const requestedBaseUrl = desktopBase || baseUrl;
    this.baseUrl = ensureAbsoluteBaseUrl(requestedBaseUrl);
    this.client = createOpencodeClient({ baseUrl: this.baseUrl, fetch: this.noStoreFetch });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setContextModeAvailable(value: unknown): void {
    this.contextModeAvailable = value === true;
  }

  getContextModeAvailable(): boolean {
    return this.contextModeAvailable;
  }

  setContextModeReadOnlyIndexing(value: unknown): void {
    this.setContextModeAvailable(value);
  }

  getContextModeReadOnlyIndexing(): boolean {
    return this.getContextModeAvailable();
  }

  /** Expose the raw SDK client for direct use (e.g., SyncProvider) */
  getSdkClient(): OpencodeClient {
    return this.client;
  }

  /** Get a scoped SDK client for a specific directory */
  getScopedSdkClient(directory: string): OpencodeClient {
    return this.getScopedApiClient(directory);
  }

  /**
   * Returns an SDK client scoped to a project directory.
   * Needed for worktree APIs where backend ignores per-call directory.
   */
  getScopedApiClient(directory: string): OpencodeClient {
    const normalized = this.normalizeCandidatePath(directory) ?? directory;
    const key = normalized || '';
    const existing = this.scopedClients.get(key);
    if (existing) {
      return existing;
    }
    const scoped = createOpencodeClient({
      baseUrl: this.baseUrl,
      directory: normalized,
      fetch: this.noStoreFetch,
    });
    this.scopedClients.set(key, scoped);
    return scoped;
  }

  private normalizeCandidatePath(path?: string | null): string | null {
    if (typeof path !== 'string') {
      return null;
    }

    const trimmed = path.trim();
    if (!trimmed) {
      return null;
    }

    // Normalize backslashes and uppercase the Windows drive letter so that
    // d:\MyProject and D:\MyProject resolve to the same canonical form.
    const normalized = trimmed
      .replace(/\\/g, '/')
      .replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');
    const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;

    return withoutTrailingSlash || null;
  }

  private deriveHomeDirectory(path: string): { homeDirectory: string; username?: string } {
    const windowsMatch = path.match(/^([A-Za-z]:)(?:\/|$)/);
    if (windowsMatch) {
      const drive = windowsMatch[1];
      const remainder = path.slice(drive.length + (path.charAt(drive.length) === '/' ? 1 : 0));
      const segments = remainder.split('/').filter(Boolean);

      if (segments.length >= 2) {
        const homeDirectory = `${drive}/${segments[0]}/${segments[1]}`;
        return { homeDirectory, username: segments[1] };
      }

      if (segments.length === 1) {
        const homeDirectory = `${drive}/${segments[0]}`;
        return { homeDirectory, username: segments[0] };
      }

      return { homeDirectory: drive, username: undefined };
    }

    const absolute = path.startsWith('/');
    const segments = path.split('/').filter(Boolean);

    if (segments.length >= 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
      const homeDirectory = `${absolute ? '/' : ''}${segments[0]}/${segments[1]}`;
      return { homeDirectory, username: segments[1] };
    }

    if (absolute) {
      if (segments.length === 0) {
        return { homeDirectory: '/', username: undefined };
      }
      const homeDirectory = `/${segments.join('/')}`;
      return { homeDirectory, username: segments[segments.length - 1] };
    }

    if (segments.length > 0) {
      const homeDirectory = `/${segments.join('/')}`;
      return { homeDirectory, username: segments[segments.length - 1] };
    }

    return { homeDirectory: '/', username: undefined };
  }

  // Set the current working directory for all API calls
  setDirectory(directory: string | undefined) {
    this.currentDirectory = this.normalizeCandidatePath(directory) ?? directory;
  }

  getDirectory(): string | undefined {
    return this.currentDirectory;
  }

  async withDirectory<T>(directory: string | undefined | null, fn: () => Promise<T>): Promise<T> {
    const runWithContext = async (): Promise<T> => {
      if (directory === undefined || directory === null) {
        return fn();
      }

      const previousDirectory = this.currentDirectory;
      this.currentDirectory = this.normalizeCandidatePath(directory) ?? directory;
      try {
        return await fn();
      } finally {
        this.currentDirectory = previousDirectory;
      }
    };

    const queuedRun = this.directoryContextQueue.then(runWithContext, runWithContext);
    this.directoryContextQueue = queuedRun.then(
      () => undefined,
      () => undefined,
    );

    return queuedRun;
  }

  // Get the raw API client for direct access
  getApiClient(): OpencodeClient {
    return this.client;
  }

  // Get system information including home directory
  async getSystemInfo(): Promise<{ homeDirectory: string; username?: string }> {
    const candidates = new Set<string>();
    const addCandidate = (value?: string | null) => {
      const normalized = this.normalizeCandidatePath(value);
      if (normalized) {
        candidates.add(normalized);
      }
    };

    try {
      const response = await this.client.path.get(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );
      const info = response.data;
      if (info) {
        addCandidate(info.directory);
        addCandidate(info.worktree);
        addCandidate(info.state);
      }
    } catch (error) {
      console.debug('Failed to load path info:', error);
    }

    if (!candidates.size) {
      try {
        const project = await this.client.project.current(
          this.currentDirectory ? { directory: this.currentDirectory } : undefined
        );
        addCandidate(project.data?.worktree);
      } catch (error) {
        console.debug('Failed to load project info:', error);
      }
    }

    if (!candidates.size) {
      try {
        const sessions = await this.listSessions();
        sessions.forEach((session) => addCandidate(session.directory));
      } catch (error) {
        console.debug('Failed to inspect sessions for system info:', error);
      }
    }

    addCandidate(this.currentDirectory);

    if (typeof window !== 'undefined') {
      try {
        addCandidate(getSafeStorage().getItem('lastDirectory'));
        addCandidate(getSafeStorage().getItem('homeDirectory'));
      } catch {
        // Access to storage failed (e.g. privacy mode)
      }
    }

    if (!candidates.size && typeof process !== 'undefined' && typeof process.cwd === 'function') {
      addCandidate(process.cwd());
    }

    if (!candidates.size) {
      return { homeDirectory: '/', username: undefined };
    }

    const [primary] = Array.from(candidates);
    return this.deriveHomeDirectory(primary);
  }

  /**
   * Best-effort probe whether a directory is accessible to OpenCode.
   * This is intentionally NOT the same as local filesystem access in the UI runtime.
   */
  async probeDirectory(directory: string): Promise<boolean> {
    const normalized = this.normalizeCandidatePath(directory);
    if (!normalized) {
      return false;
    }
    const response = await this.client.path.get({ directory: normalized });
    if (response.error) {
      throw createFormattedSdkError('path.get', getSdkErrorMessage(response.error), response.response?.status);
    }
    const info = response.data as { directory?: unknown } | undefined;
    const returned = typeof info?.directory === 'string' ? info.directory : null;
    return Boolean(returned && returned.trim().length > 0);
  }

  invalidateLocalDirectory(directory: string): void {
    const normalized = normalizeFsPath(directory.trim());
    if (!normalized) return;
    const prefix = `${normalized}|`;
    this.listDirectoryGeneration.set(normalized, (this.listDirectoryGeneration.get(normalized) ?? 0) + 1);
    for (const key of new Set([...this.listDirectoryCache.keys(), ...this.listDirectoryInFlight.keys()])) {
      if (!key.startsWith(prefix)) continue;
      this.listDirectoryCache.delete(key);
      this.listDirectoryInFlight.delete(key);
    }
  }

  // Session Management
  async listSessions(): Promise<Session[]> {
    const response = await this.client.session.list(
      this.currentDirectory ? { directory: this.currentDirectory } : undefined
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  async createSession(params?: { parentID?: string; title?: string }): Promise<Session> {
    const response = await this.client.session.create({
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      parentID: params?.parentID,
      title: params?.title
    });
    if (!response.data) throw new Error('Failed to create session');
    return response.data;
  }

  async prewarmCursorSession(params: {
    sessionID: string;
    directory?: string | null;
    modelID?: string | null;
    variant?: string | null;
    agent?: string | null;
  }): Promise<{ ok: boolean; agentID?: string; cacheHit?: boolean; error?: string }> {
    const sessionID = typeof params.sessionID === 'string' ? params.sessionID.trim() : '';
    if (!sessionID) {
      return { ok: false, error: 'Session ID is required.' };
    }

    const base = this.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/provider/cursor-acp/session-prewarm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sessionID,
        directory: params.directory ?? this.currentDirectory ?? null,
        modelID: params.modelID ?? null,
        variant: params.variant ?? null,
        agent: params.agent ?? null,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        error: typeof data?.error === 'string' ? data.error : `Cursor session prewarm failed (${response.status}).`,
      };
    }
    return {
      ok: data?.ok !== false,
      ...(typeof data?.agentID === 'string' && data.agentID.trim() ? { agentID: data.agentID.trim() } : {}),
      cacheHit: data?.cacheHit === true,
      ...(typeof data?.error === 'string' ? { error: data.error } : {}),
    };
  }

  async getSession(id: string, directory?: string | null): Promise<Session> {
    const targetDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const response = await this.client.session.get({
      sessionID: id,
      ...(targetDirectory ? { directory: targetDirectory } : {})
    });
    if (!response.data) throw new Error('Session not found');
    return response.data;
  }

  async deleteSession(id: string): Promise<boolean> {
    const response = await this.client.session.delete({
      sessionID: id,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {})
    });
    return response.data || false;
  }

  async updateSession(id: string, title?: string): Promise<Session> {
    const response = await this.client.session.update({
      sessionID: id,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      title
    });
    if (!response.data) throw new Error('Failed to update session');
    return response.data;
  }

  async getSessionMessages(id: string, limit?: number): Promise<{ info: Message; parts: Part[] }[]> {
    const response = await this.client.session.messages({
      sessionID: id,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
    return response.data || [];
  }

  async getSessionTodos(sessionId: string): Promise<Array<{ id: string; content: string; status: string; priority: string }>> {
    try {
      const base = this.baseUrl.replace(/\/$/, "");
      const url = new URL(`${base}/session/${encodeURIComponent(sessionId)}/todo`);

      if (this.currentDirectory && this.currentDirectory.length > 0) {
        url.searchParams.set("directory", this.currentDirectory);
      }

      const response = await this.noStoreFetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data)) {
        return [];
      }

      return data as Array<{ id: string; content: string; status: string; priority: string }>;
    } catch {
      return [];
    }
  }

  /**
   * Check if MIME type needs normalization to text/plain.
   * Some text MIME types (like text/markdown) aren't supported by AI providers.
   */
  private shouldNormalizeToTextPlain(mime: string): boolean {
    const lowerMime = normalizeMimeType(mime);
    if (!lowerMime || lowerMime === 'text/plain') return false;
    return isTextLikeMimeType(lowerMime);
  }

  private isTextLikeAttachment(file: FileInputLite): boolean {
    const fileMime = normalizeMimeType(file.mime);
    const dataMime = parseDataUrl(file.url)?.mime ?? '';
    const candidateMimes = [fileMime, dataMime].filter((mime) => mime.length > 0);

    if (candidateMimes.some(isTextLikeMimeType)) {
      return true;
    }

    const hasKnownNonTextMime = candidateMimes.some((mime) => !UNKNOWN_ATTACHMENT_MIME_TYPES.has(mime));
    if (hasKnownNonTextMime) {
      return false;
    }

    return TEXT_ATTACHMENT_EXTENSIONS.has(getFilenameExtension(file.filename));
  }

  private shouldNormalizeFileToTextPlain(file: FileInputLite): boolean {
    if (this.shouldNormalizeToTextPlain(file.mime)) {
      return true;
    }

    const dataMime = parseDataUrl(file.url)?.mime ?? '';
    if (this.shouldNormalizeToTextPlain(dataMime)) {
      return true;
    }

    const fileMime = normalizeMimeType(file.mime);
    const candidateMimes = [fileMime, dataMime].filter((mime) => mime.length > 0);
    const hasKnownNonTextMime = candidateMimes.some((mime) => !UNKNOWN_ATTACHMENT_MIME_TYPES.has(mime));
    return !hasKnownNonTextMime && TEXT_ATTACHMENT_EXTENSIONS.has(getFilenameExtension(file.filename));
  }

  private getTextAttachmentDisplayMime(file: FileInputLite): string {
    const candidates = [
      normalizeMimeType(file.mime),
      parseDataUrl(file.url)?.mime ?? '',
    ];
    const known = candidates.find((mime) => mime.length > 0 && !UNKNOWN_ATTACHMENT_MIME_TYPES.has(mime));
    return known ?? 'text/plain';
  }

  private decodeDataUrlText(url: string): string | null {
    const parsed = parseDataUrl(url);
    if (!parsed) return null;

    try {
      if (parsed.isBase64) {
        const binary = atob(parsed.payload.replace(/\s/g, ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new TextDecoder().decode(bytes);
      }

      return decodeURIComponent(parsed.payload);
    } catch (error) {
      console.warn('Failed to decode text attachment data URL:', error);
      return null;
    }
  }

  private createSyntheticTextAttachmentPart(file: FileInputLite, text: string): TextPartInput {
    const filename = file.filename?.trim() || 'attachment';
    const mime = this.getTextAttachmentDisplayMime(file);
    return {
      type: 'text',
      synthetic: true,
      text: [
        `Attached file: ${filename}`,
        `MIME type: ${mime}`,
        '',
        '<file_content>',
        text,
        '</file_content>',
      ].join('\n'),
    };
  }

  private async toPromptAttachmentPart(file: FileInputLite): Promise<TextPartInput | FilePartInput> {
    if (file.url.startsWith('data:') && this.isTextLikeAttachment(file)) {
      const text = this.decodeDataUrlText(file.url);
      if (text !== null) {
        return this.createSyntheticTextAttachmentPart(file, text);
      }
    }

    return this.toNormalizedFilePartInput(file);
  }

  private getVisibleAttachmentSummary(file: FileInputLite): string {
    return `Attached file: ${file.filename?.trim() || 'attachment'}`;
  }

  private getVisibleAttachmentSummaryKey(file: FileInputLite): string {
    return [file.filename?.trim() || '', normalizeMimeType(file.mime), file.url].join('\u0000');
  }

  /**
   * Check if MIME type is HEIC/HEIF (iPhone photo format).
   */
  private isHeicMime(mime: string): boolean {
    if (!mime) return false;
    const lowerMime = mime.toLowerCase();
    return lowerMime === 'image/heic' || lowerMime === 'image/heif';
  }

  /**
   * Convert HEIC image to JPEG.
   * Returns the original file if conversion fails.
   */
  private async convertHeicToJpeg(file: { mime: string; filename?: string; url: string }): Promise<{ mime: string; filename?: string; url: string }> {
    try {
      // Dynamic import to avoid loading heic2any unless needed
      const heic2any = (await import('heic2any')).default;
      
      // Extract base64 data from data URL
      const commaIndex = file.url.indexOf(',');
      if (commaIndex === -1) return file;
      
      const base64Data = file.url.substring(commaIndex + 1);
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const heicBlob = new Blob([bytes], { type: file.mime });
      
      // Convert to JPEG
      const jpegBlob = await heic2any({
        blob: heicBlob,
        toType: 'image/jpeg',
        quality: 0.9,
      }) as Blob;
      
      // Convert back to data URL
      const jpegDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(jpegBlob);
      });
      
      // Update filename extension
      let newFilename = file.filename;
      if (newFilename) {
        newFilename = newFilename.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
      }
      
      return {
        mime: 'image/jpeg',
        filename: newFilename,
        url: jpegDataUrl
      };
    } catch (error) {
      console.warn('Failed to convert HEIC to JPEG:', error);
      return file;
    }
  }

  /**
   * Normalize file part for sending to AI providers.
   * - Converts unsupported text MIME types to text/plain
   * - Converts HEIC/HEIF images to JPEG
   */
  private async normalizeFilePart(file: FileInputLite): Promise<{ mime: string; filename?: string; url: string }> {
    // Handle HEIC conversion
    if (this.isHeicMime(file.mime)) {
      return this.convertHeicToJpeg(file);
    }

    // Handle text MIME normalization
    if (!this.shouldNormalizeFileToTextPlain(file)) {
      return file;
    }

    let normalizedUrl = file.url;
    
    // Update MIME type in data URL if present
    // Format: data:<mime>;base64,<content> or data:<mime>,<content>
    if (file.url.startsWith('data:')) {
      const commaIndex = file.url.indexOf(',');
      if (commaIndex !== -1) {
        const meta = file.url.substring(5, commaIndex); // after "data:"
        const content = file.url.substring(commaIndex); // includes comma
        
        // Replace the MIME type in meta, preserving ;base64 if present
        const newMeta = meta.replace(/^[^;,]+/, 'text/plain');
        normalizedUrl = `data:${newMeta}${content}`;
      }
    }

    return {
      mime: 'text/plain',
      filename: file.filename,
      url: normalizedUrl
    };
  }

  private async toNormalizedFilePartInput(file: FileInputLite): Promise<FilePartInput> {
    const normalized = await this.normalizeFilePart(file);
    return {
      ...(file.id ? { id: file.id } : {}),
      type: 'file',
      mime: normalized.mime,
      filename: normalized.filename,
      url: normalized.url,
    };
  }

  async sendImmediateSubtaskPrompt(params: {
    id: string;
    text: string;
    files?: Array<FileInputLite>;
    agentMentions?: Array<ImmediateSubtaskPromptAgentMention>;
    additionalParts?: Array<ImmediateSubtaskAdditionalPart>;
    directory?: string | null;
    signal?: AbortSignal;
    beforeTransport?: () => void;
  }): Promise<void> {
    const textSegments: string[] = [];
    const visibleText = typeof params.text === 'string' ? params.text.trim() : '';
    if (visibleText.startsWith('/')) {
      throw new Error('Active subtask follow-ups do not support slash commands.');
    }
    if (visibleText) {
      textSegments.push(visibleText);
    }

    const promptFiles = [] as Array<{ uri: string; mime: string; name?: string; source?: { value: string; start: number; end: number } }>;
    const appendFile = async (file: FileInputLite) => {
      const normalized = await this.toNormalizedFilePartInput(file);
      promptFiles.push({
        uri: normalized.url,
        mime: normalized.mime,
        ...(normalized.filename ? { name: normalized.filename } : {}),
      });
    };

    if (params.files && params.files.length > 0) {
      for (const file of params.files) {
        await appendFile(file);
      }
    }

    if (params.additionalParts && params.additionalParts.length > 0) {
      for (const additional of params.additionalParts) {
        if (additional.synthetic) {
          throw new Error('Active subtask follow-ups do not support hidden synthetic text.');
        }
        const text = typeof additional.text === 'string' ? additional.text.trim() : '';
        if (text) {
          textSegments.push(text);
        }
        if (additional.files && additional.files.length > 0) {
          for (const file of additional.files) {
            await appendFile(file);
          }
        }
      }
    }

    const promptAgents = (params.agentMentions ?? [])
      .filter((mention) => typeof mention?.name === 'string' && mention.name.trim().length > 0)
      .map((mention) => ({
        name: mention.name.trim(),
        ...(mention.source ? { source: mention.source } : {}),
      }));

    const promptText = textSegments.join('\n\n').trim();
    if (!promptText && promptFiles.length === 0 && promptAgents.length === 0) {
      throw new Error('Active subtask follow-up must include text, a file, or an agent mention.');
    }

    const targetDirectory = this.normalizeCandidatePath(params.directory) ?? this.currentDirectory;
    if (targetDirectory) {
      await waitForWorktreeBootstrapForSend(targetDirectory);
    }
    if (params.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    params.beforeTransport?.();

    const base = this.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/session/${encodeURIComponent(params.id)}/prompt`);
    if (targetDirectory) {
      url.searchParams.set('directory', targetDirectory);
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        prompt: {
          text: promptText,
          ...(promptFiles.length > 0 ? { files: promptFiles } : {}),
          ...(promptAgents.length > 0 ? { agents: promptAgents } : {}),
        },
        delivery: 'immediate',
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      const suffix = detail && detail.trim().length > 0 ? `: ${detail.trim()}` : '';
      throw new Error(`Active subtask follow-up failed (${response.status})${suffix}`);
    }
  }

  async sendMessage(params: {
    id: string;
    providerID: string;
    modelID: string;
    text: string;
    prefaceText?: string;
    prefaceTextSynthetic?: boolean;
    agent?: string;
    variant?: string;
    planMode?: boolean;
    files?: Array<FileInputLite>;
    /** Additional text/file parts to include (for batch sending queued messages) */
    additionalParts?: Array<{
      text: string;
      synthetic?: boolean;
      files?: Array<FileInputLite>;
    }>;
    messageId?: string;
    agentMentions?: Array<{ name: string; source?: { value: string; start: number; end: number } }>;
    format?: {
      type: 'json_schema';
      schema: Record<string, unknown>;
      retryCount?: number;
    };
    directory?: string | null;
    signal?: AbortSignal;
    beforeTransport?: () => void;
  }): Promise<string> {
    // Reuse one client-side message ID across retries. The server accepts this
    // as the real user message ID, making ambiguous network retries idempotent.
    const messageId = params.messageId ?? ascendingId("msg");

    // Build parts array using SDK types (TextPartInput | FilePartInput) plus lightweight agent parts
    const parts: Array<TextPartInput | FilePartInput | AgentPartInputLite> = [];
    const visibleAttachmentSummaryKeys = new Set<string>();

    const appendAttachmentPart = (file: FileInputLite, part: TextPartInput | FilePartInput) => {
      if (part.type === 'text' && part.synthetic === true) {
        const summaryKey = this.getVisibleAttachmentSummaryKey(file);
        if (!visibleAttachmentSummaryKeys.has(summaryKey)) {
          visibleAttachmentSummaryKeys.add(summaryKey);
          // Text-like local attachments are sent as hidden synthetic context for
          // provider compatibility. Keep a separate visible summary so the chat
          // transcript still shows which document was attached alongside prompts.
          parts.push({
            type: 'text',
            text: this.getVisibleAttachmentSummary(file),
          });
        }
      }
      parts.push(part);
    };

    if (params.prefaceText && params.prefaceText.trim()) {
      parts.push({
        type: 'text',
        text: params.prefaceText,
        synthetic: params.prefaceTextSynthetic !== false,
      });
    }

    // Add text part if there's content
    if (params.text && params.text.trim()) {
      const textPart: TextPartInput = {
        type: 'text',
        text: params.text
      };
      parts.push(textPart);
    }

    // Attachment parts can each involve async work (reads, encoding), so build
    // them all concurrently, then append synchronously in the original order.
    const mainFileParts = params.files && params.files.length > 0
      ? await Promise.all(params.files.map((file) => this.toPromptAttachmentPart(file)))
      : [];
    const additionalFileParts = params.additionalParts && params.additionalParts.length > 0
      ? await Promise.all(params.additionalParts.map((additional) => (
        additional.files && additional.files.length > 0
          ? Promise.all(additional.files.map((file) => this.toPromptAttachmentPart(file)))
          : Promise.resolve([] as Array<TextPartInput | FilePartInput>)
      )))
      : [];

    // Add file parts if provided (normalizing MIME types for compatibility)
    if (params.files && params.files.length > 0) {
      params.files.forEach((file, index) => {
        appendAttachmentPart(file, mainFileParts[index]);
      });
    }

    // Add additional parts (for batch/queued messages)
    if (params.additionalParts && params.additionalParts.length > 0) {
      params.additionalParts.forEach((additional, additionalIndex) => {
        if (additional.text && additional.text.trim()) {
          parts.push({
            type: 'text',
            text: additional.text,
            ...(additional.synthetic ? { synthetic: true } : {}),
          });
        }
        if (additional.files && additional.files.length > 0) {
          additional.files.forEach((file, fileIndex) => {
            appendAttachmentPart(file, additionalFileParts[additionalIndex][fileIndex]);
          });
        }
      });
    }

    if (params.agentMentions && params.agentMentions.length > 0) {
      for (const mention of params.agentMentions) {
        if (!mention?.name) continue;
        parts.push({
          type: 'agent',
          name: mention.name,
          ...(mention.source ? { source: mention.source } : {}),
        });
      }
    }

    // Ensure we have at least one part
    if (parts.length === 0) {
      throw new Error('Message must have at least one part (text or file)');
    }

    const targetDirectory = this.normalizeCandidatePath(params.directory) ?? this.currentDirectory;
    const turnTimingMetadata = {
      providerID: params.providerID,
      modelID: params.modelID,
      agent: params.agent ?? null,
      variant: params.variant ?? null,
    };
    postTurnTimingMark({
      sessionId: params.id,
      messageId,
      mark: "send_started",
      directory: targetDirectory ?? null,
      metadata: turnTimingMetadata,
    });

    if (targetDirectory) {
      await waitForWorktreeBootstrapForSend(targetDirectory);
    }
    if (params.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Use async prompt endpoint so the client doesn't block waiting
    // for model work (SSE will deliver output/status).
    // This avoids 504s from proxy timeouts on long-running turns.
    const base = this.baseUrl.replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(`${base}/session/${encodeURIComponent(params.id)}/prompt_async`);
      if (targetDirectory) {
        url.searchParams.set('directory', targetDirectory);
      }
    } catch (error) {
      console.error('[git-generation][browser] failed to build prompt_async URL', {
        baseUrl: this.baseUrl,
        normalizedBase: base,
        sessionId: params.id,
        directory: targetDirectory,
        message: error instanceof Error ? error.message : String(error),
        error,
      });
      throw error;
    }

    if (params.format) {
      console.info('[git-generation][browser] send structured message', {
        sessionId: params.id,
        providerID: params.providerID,
        modelID: params.modelID,
        agent: params.agent,
        variant: params.variant,
        directory: this.currentDirectory,
        targetDirectory,
        baseUrl: this.baseUrl,
        formatType: params.format.type,
      });
    }

    assertProviderCircuitClosed(params.providerID);

    let response!: Response;
    postTurnTimingMark({
      sessionId: params.id,
      messageId,
      mark: "prompt_request_started",
      directory: targetDirectory ?? null,
      metadata: turnTimingMetadata,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        params.beforeTransport?.();
        // Resolve the capability immediately before every transport attempt.
        // Queued sends and retries must not retain a stale indexing grant.
        const tools = resolveProviderPromptTools(params.providerID, params.agent, {
          planMode: params.planMode === true,
          contextModeAvailable: this.contextModeAvailable,
        });
        response = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-openchamber-message-id': messageId,
            'x-devryan-prompt-origin': 'human',
          },
          body: JSON.stringify({
            model: {
              providerID: params.providerID,
              modelID: params.modelID,
            },
            agent: params.agent,
            variant: params.variant,
            messageID: messageId,
            ...(params.format ? { format: params.format } : {}),
            ...(tools ? { tools } : {}),
            parts,
          }),
          signal: params.signal,
        });
      } catch (error) {
        if (params.signal?.aborted) {
          throw error;
        }
        if (attempt < 2 && isRetryableFetchError(error)) {
          const delay = getRetryDelayMs(attempt);
          console.warn(
            `[prompt] fetch failed for ${params.providerID}/${params.modelID} (attempt ${attempt + 1}/3), retrying in ${delay}ms`,
            (error as Error)?.message
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        recordProviderError(params.providerID);
        throw error;
      }

      if (response.ok) {
        recordProviderSuccess(params.providerID);
        streamDebugMark("first-reply-prompt-accepted", {
          sessionId: params.id,
          messageId,
          providerID: params.providerID,
          modelID: params.modelID,
          directory: targetDirectory ?? null,
        });
        postTurnTimingMark({
          sessionId: params.id,
          messageId,
          mark: "prompt_accepted",
          directory: targetDirectory ?? null,
          metadata: {
            ...turnTimingMetadata,
          },
        });
        return messageId;
      }

      if (shouldRetry(params.providerID, response.status, attempt)) {
        const delay = getRetryDelayMs(attempt);
        console.warn(
          `[prompt] ${response.status} for ${params.providerID}/${params.modelID} (attempt ${attempt + 1}/3), retrying in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      const suffix = detail && detail.trim().length > 0 ? `: ${detail.trim()}` : '';
      const error = new Error(`Failed to send message (${response.status})${suffix}`);
      recordProviderError(params.providerID, response.status);
      throw error;
    }
    // Defensive fallback — all loop paths return/throw, but TypeScript
    // control flow analysis cannot prove exhaustiveness without this.
    throw new Error('Failed to send message after retries');
  }

  async sendCommand(params: {
    id: string;
    providerID: string;
    modelID: string;
    command: string;
    arguments?: string;
    agent?: string;
    variant?: string;
    files?: Array<FileInputLite>;
    messageId?: string;
    directory?: string | null;
    signal?: AbortSignal;
    beforeTransport?: () => void;
  }): Promise<string> {
    const tempMessageId = params.messageId ?? ascendingId("msg");

    const parts: FilePartInput[] = [];
    if (params.files && params.files.length > 0) {
      for (const file of params.files) {
        parts.push(await this.toNormalizedFilePartInput(file));
      }
    }

    const base = this.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/session/${encodeURIComponent(params.id)}/command`);
    const targetDirectory = this.normalizeCandidatePath(params.directory) ?? this.currentDirectory;
    if (targetDirectory) {
      await waitForWorktreeBootstrapForSend(targetDirectory);
      url.searchParams.set('directory', targetDirectory);
    }
    if (params.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    params.beforeTransport?.();

    const payload: Record<string, unknown> = {
      command: params.command,
      arguments: params.arguments ?? '',
      model: `${params.providerID}/${params.modelID}`,
      ...(params.agent ? { agent: params.agent } : {}),
      ...(params.variant ? { variant: params.variant } : {}),
      ...(parts.length > 0 ? { parts } : {}),
      messageID: tempMessageId,
    };

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: params.signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      const suffix = detail && detail.trim().length > 0 ? `: ${detail.trim()}` : '';
      throw new Error(`Failed to run command (${response.status})${suffix}`);
    }

    return tempMessageId;
  }

  async abortSession(id: string): Promise<boolean> {
    const response = await this.client.session.abort(
      {
        sessionID: id,
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {})
      },
      { throwOnError: true }
    );
    return Boolean(response.data);
  }

  async revertSession(sessionId: string, messageId: string, partId?: string): Promise<Session> {
    const response = await this.client.session.revert({
      sessionID: sessionId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      messageID: messageId,
      partID: partId
    });
    if (!response.data) throw new Error('Failed to revert session');
    return response.data;
  }

  /**
   * Revert the session tree (root + every sub-agent session) back to a point
   * in the chat. Returns the authoritative session plus what was reverted.
   */
  async revertSessionScoped(
    sessionId: string,
    messageId: string,
    directory?: string,
    options: { scope?: ScopedRevertScope; rootSessionId?: string } = {},
  ): Promise<ScopedSessionRevertResult> {
    const targetDirectory = directory || this.currentDirectory;
    return requestScopedSessionRevert({
      baseUrl: this.baseUrl,
      sessionId,
      messageId,
      directory: targetDirectory,
      scope: options.scope ?? "tree",
      rootSessionId: options.rootSessionId,
    });
  }

  async unrevertSessionScoped(sessionId: string, directory?: string): Promise<ScopedSessionUnrevertResult> {
    const targetDirectory = directory || this.currentDirectory;
    return requestScopedSessionUnrevert({
      baseUrl: this.baseUrl,
      sessionId,
      directory: targetDirectory,
    });
  }

  async getSessionTreeChanges(
    sessionId: string,
    directory?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionTreeChanges> {
    const targetDirectory = directory || this.currentDirectory;
    return requestSessionTreeChanges({
      baseUrl: this.baseUrl,
      sessionId,
      directory: targetDirectory,
      fetchImpl: this.noStoreFetch,
      signal: options.signal,
    });
  }

  async sessionChangesAction(sessionId: string, directory: string, revision: string, action: 'undo' | 'redo'): Promise<void> {
    const url = buildScopedRevertUrl(this.baseUrl, sessionId, `changes/${action}`, directory);
    const response = await this.noStoreFetch(url.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision }) });
    if (!response.ok) throw await readScopedRevertError(response, 'Cannot restore session changes');
  }

  async getSessionChangesDiff(sessionId: string, directory: string, revision: string, file: string, signal?: AbortSignal): Promise<string> {
    const url = buildScopedRevertUrl(this.baseUrl, sessionId, 'changes/diff', directory);
    url.searchParams.set('revision', revision);
    url.searchParams.set('file', file);
    const response = await this.noStoreFetch(url.toString(), { signal });
    if (!response.ok) throw await readScopedRevertError(response, 'Cannot load session diff');
    const body: unknown = await response.json();
    if (!isRecord(body) || body.rootSessionID !== sessionId || body.revision !== revision || body.path !== file || typeof body.patch !== 'string') throw new Error('Session diff identity mismatch');
    return body.patch;
  }

  async unrevertSession(sessionId: string): Promise<Session> {
    const response = await this.client.session.unrevert({
      sessionID: sessionId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {})
    });
    if (!response.data) throw new Error('Failed to unrevert session');
    return response.data;
  }

  async forkSession(sessionId: string, messageId?: string): Promise<Session> {
    const response = await this.client.session.fork({
      sessionID: sessionId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      messageID: messageId
    });

    if (!response.data) {
      throw new Error('Failed to fork session');
    }

    return response.data;
  }

  async getSessionStatus(): Promise<SessionStatusMap> {
    return (await this.getSessionStatusForDirectory(this.currentDirectory ?? null)) ?? {};
  }

  async getSessionStatusForDirectory(
    directory: string | null | undefined
  ): Promise<SessionStatusMap | null> {
    try {
      const base = this.baseUrl.replace(/\/$/, "");
      const url = new URL(`${base}/session/status`);

      const trimmedDirectory = typeof directory === "string" ? directory.trim() : "";
      if (trimmedDirectory.length > 0) {
        url.searchParams.set("directory", trimmedDirectory);
      }

      const response = await this.noStoreFetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json().catch(() => null);
      if (!data || typeof data !== "object") {
        return null;
      }

      return data as SessionStatusMap;
    } catch {
      return null;
    }
  }

  async getGlobalSessionStatus(): Promise<SessionStatusMap> {
    return (await this.getSessionStatusForDirectory(null)) ?? {};
  }

  /**
   * Get session activity from web server's in-memory tracking.
   * This is more reliable than getGlobalSessionStatus on visibility restore
   * because the web server tracks activity even when UI is not listening to SSE.
   */
  async getWebServerSessionActivity(): Promise<
    Record<string, { type: string }> | null
  > {
    try {
      // Web server endpoint - use relative path that works with both dev and prod
      const response = await this.noStoreFetch('/api/session-activity', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json().catch(() => null);
      if (!data || typeof data !== 'object') {
        return null;
      }

      return data as Record<string, { type: string }>;
    } catch {
      return null;
    }
  }

  // Tools
  async listToolIds(options?: { directory?: string | null }): Promise<string[]> {
    try {
      const directory = typeof options?.directory === 'string'
        ? options.directory.trim()
        : (this.currentDirectory ? this.currentDirectory.trim() : '');

      const result = await this.client.tool.ids(directory ? { directory } : undefined);
      const tools = (result.data || []) as unknown as string[];
      return tools.filter((tool) => typeof tool === 'string' && tool !== 'invalid');
    } catch {
      return [];
    }
  }

  // Permissions
  async replyToPermission(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    options?: { message?: string }
  ): Promise<boolean> {
    const result = await this.client.permission.reply({
      requestID: requestId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      reply,
      ...(options?.message ? { message: options.message } : {}),
    });
    return result.data || false;
  }

  async listPendingPermissions(options?: { directories?: Array<string | null | undefined> }): Promise<PermissionRequest[]> {
    const fetches: Array<Promise<PermissionRequest[]>> = [];

    const fetchForDirectory = async (directory?: string | null): Promise<PermissionRequest[]> => {
      const trimmed = typeof directory === 'string' ? directory.trim() : '';
      const operation = trimmed ? `permission.list (${trimmed})` : "permission.list";
      try {
        const result = await this.client.permission.list(trimmed ? { directory: trimmed } : undefined);
        return unwrapSdkData(result as SdkResult<PermissionRequest[]>, operation) as unknown as PermissionRequest[];
      } catch (error) {
        throw formatSdkError(operation, error);
      }
    };

    // Try unscoped first (server may return global pending items).
    fetches.push(fetchForDirectory(null));

    const uniqueDirectories = new Set<string>();
    for (const entry of options?.directories ?? []) {
      const normalized = this.normalizeCandidatePath(entry ?? null);
      if (normalized) {
        uniqueDirectories.add(normalized);
      }
    }

    for (const directory of uniqueDirectories) {
      fetches.push(fetchForDirectory(directory));
    }

    const results = await Promise.all(fetches);
    const merged: PermissionRequest[] = [];
    const seenIds = new Set<string>();

    for (const list of results) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(item);
      }
    }

    return merged;
  }

  // Questions ("ask" tool)
  async replyToQuestion(requestId: string, answers: string[] | string[][]): Promise<boolean> {
    const normalizedAnswers: string[][] = (() => {
      if (!Array.isArray(answers) || answers.length === 0) {
        return [];
      }
      if (Array.isArray(answers[0])) {
        return answers as string[][];
      }
      return [answers as string[]];
    })();

    const result = await this.client.question.reply({
      requestID: requestId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      answers: normalizedAnswers,
    });
    return result.data || false;
  }

  async rejectQuestion(requestId: string): Promise<boolean> {
    const result = await this.client.question.reject({
      requestID: requestId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
    });
    return result.data || false;
  }

  async listPendingQuestions(options?: { directories?: Array<string | null | undefined> }): Promise<QuestionRequest[]> {
    const fetches: Array<Promise<QuestionRequest[]>> = [];

    const fetchForDirectory = async (directory?: string | null): Promise<QuestionRequest[]> => {
      const trimmed = typeof directory === 'string' ? directory.trim() : '';
      const operation = trimmed ? `question.list (${trimmed})` : "question.list";
      try {
        const result = await this.client.question.list(trimmed ? { directory: trimmed } : undefined);
        return unwrapSdkData(result as SdkResult<QuestionRequest[]>, operation) as unknown as QuestionRequest[];
      } catch (error) {
        throw formatSdkError(operation, error);
      }
    };

    // Try unscoped first (server may return global pending items).
    fetches.push(fetchForDirectory(null));

    const uniqueDirectories = new Set<string>();
    for (const entry of options?.directories ?? []) {
      const normalized = this.normalizeCandidatePath(entry ?? null);
      if (normalized) {
        uniqueDirectories.add(normalized);
      }
    }

    for (const directory of uniqueDirectories) {
      fetches.push(fetchForDirectory(directory));
    }

    const results = await Promise.all(fetches);
    const merged: QuestionRequest[] = [];
    const seenIds = new Set<string>();

    for (const list of results) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(item);
      }
    }

    return merged;
  }

  // Configuration
  async getConfig(): Promise<Config> {
    try {
      const response = await this.client.config.get();
      return unwrapSdkData(response as SdkResult<Config>, "config.get");
    } catch (error) {
      throw formatSdkError("config.get", error);
    }
  }

  async updateConfig(config: Record<string, unknown>): Promise<Config> {
    // IMPORTANT: Do NOT pass directory parameter for config updates
    // The config should be global, not directory-specific
    const url = `${this.baseUrl}/config`;

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[OpencodeClient] Failed to update config:', response.status, errorText);
      throw new Error(`Failed to update config: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  }

  /**
   * Update config with a partial modification function.
   * This handles the GET-modify-PATCH pattern required by the upstream API.
   *
   * NOTE: This method must not be used for agent configuration.
   * DevRyan treats agents as packaged/project markdown files and exposes them read-only.
   *
   * @param modifier Function that receives current config and returns modified config
   * @returns Updated config from server
   */
  async updateConfigPartial(modifier: (config: Config) => Config): Promise<Config> {
    const currentConfig = await this.getConfig();
    const updatedConfig = modifier(currentConfig);
    const result = await this.updateConfig(updatedConfig);
    return result;
  }

  async getProviders(options?: { directory?: string | null }): Promise<{
    providers: Provider[];
    default: { [key: string]: string };
  }> {
    try {
      const hasDirectoryOverride = options !== undefined
        && Object.prototype.hasOwnProperty.call(options, 'directory');
      const directory = hasDirectoryOverride
        ? this.normalizeCandidatePath(options.directory)
        : this.currentDirectory;
      const response = await this.client.config.providers(
        directory ? { directory } : undefined
      );
      return unwrapSdkData(response as SdkResult<{
        providers: Provider[];
        default: { [key: string]: string };
      }>, "config.providers");
    } catch (error) {
      throw formatSdkError("config.providers", error);
    }
  }

  // App Management - using config endpoint since /app doesn't exist in this version
  async getApp(): Promise<App> {
    // Return basic app info from config
    const config = await this.getConfig();
    return {
      version: "0.0.3", // from the OpenAPI spec
      config
    };
  }

  async initApp(): Promise<boolean> {
    try {
      // Just check if we can connect since there's no init endpoint
      return await this.checkHealth();
    } catch {
      return false;
    }
  }

  // Agent Management
  async listAgentsStrict(): Promise<Agent[]> {
    try {
      const response = await this.client.app.agents(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );
      return unwrapSdkData(response as SdkResult<Agent[]>, "app.agents");
    } catch (error) {
      throw formatSdkError("app.agents", error);
    }
  }

  async listAgents(): Promise<Agent[]> {
    try {
      return await this.listAgentsStrict();
    } catch {
      return [];
    }
  }

  // SSE infrastructure removed — EventPipeline in sync/event-pipeline.ts handles
  // all SSE event ingestion via the SDK's global.event() async iterator.

  // File Operations
  async readFile(path: string): Promise<string> {
    try {
      // For now, we'll use a placeholder implementation
      // In a real implementation, this would call an API endpoint to read the file
      const response = await fetch(`${this.baseUrl}/files/read`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path,
          directory: this.currentDirectory
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to read file: ${response.statusText}`);
      }

      const data = await response.text();
      return data;
    } catch {
      // Return placeholder for development
      return `// Content of ${path}\n// This would be loaded from the server`;
    }
  }

  async listFiles(directory?: string): Promise<Record<string, unknown>[]> {
    try {
      const targetDir = directory || this.currentDirectory || '/';
      const response = await fetch(`${this.baseUrl}/files/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ directory: targetDir })
      });

      if (!response.ok) {
        throw new Error(`Failed to list files: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch {
      // Return mock data for development
      return [];
    }
  }

  // Command Management
  async listCommands(): Promise<Array<{ name: string; description?: string; agent?: string; model?: string }>> {
    try {
      const response = await this.client.command.list(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );
      // Return only lightweight info for autocomplete
      return (response.data || []).map((cmd: Record<string, unknown>) => ({
        name: cmd.name as string,
        description: cmd.description as string | undefined,
        agent: cmd.agent as string | undefined,
        model: cmd.model as string | undefined
        // Intentionally excluding template to keep memory usage low
      }));
    } catch {
      return [];
    }
  }

  async listCommandsWithDetails(): Promise<Array<{ name: string; description?: string; agent?: string; model?: string; template?: string }>> {
    try {
      const response = await this.client.command.list(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );
      // Return full command details including template
      return (response.data || []).map((cmd: Record<string, unknown>) => ({
        name: cmd.name as string,
        description: cmd.description as string | undefined,
        agent: cmd.agent as string | undefined,
        model: cmd.model as string | undefined,
        template: cmd.template as string | undefined,
      }));
    } catch {
      return [];
    }
  }

  async getCommandDetails(name: string): Promise<{ name: string; template: string; description?: string; agent?: string; model?: string } | null> {
    try {
      const response = await this.client.command.list(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );

      if (response.data) {
        const command = response.data.find((cmd: Record<string, unknown>) => cmd.name === name);
        if (command) {
          return {
            name: command.name as string,
            template: command.template as string,
            description: command.description as string | undefined,
            agent: command.agent as string | undefined,
            model: command.model as string | undefined
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Health Check - using /health endpoint for detailed status
  async checkHealth(): Promise<boolean> {
    try {
      // Health endpoint is at root, not under /api
      let healthUrl: string;
      const normalizedBase = this.baseUrl.endsWith('/') ? this.baseUrl.replace(/\/+$/, '') : this.baseUrl;
      if (normalizedBase === '/api') {
        healthUrl = '/health';
      } else if (normalizedBase.endsWith('/api')) {
        // Desktop: http://127.0.0.1:PORT/api -> http://127.0.0.1:PORT/health
        healthUrl = `${normalizedBase.slice(0, -4)}/health`;
      } else {
        healthUrl = `${normalizedBase}/health`;
      }
      const response = await this.noStoreFetch(healthUrl);
      if (!response.ok) {
        this.setContextModeAvailable(false);
        return false;
      }

      const healthData = await response.json();
      this.setContextModeAvailable(
        healthData?.contextModeAvailable ?? healthData?.contextModeReadOnlyIndexing,
      );

      // Check if the upstream API is ready (not just OpenChamber server)
      if (healthData.isOpenCodeReady === false) {
        return false;
      }

      return true;
    } catch {
      this.setContextModeAvailable(false);
      return false;
    }
  }

  // File System Operations
  async createDirectory(
    dirPath: string,
    options?: { allowOutsideWorkspace?: boolean }
  ): Promise<{ success: boolean; path: string }> {
    const desktopFiles = getDesktopFilesApi();
    if (desktopFiles?.createDirectory) {
      try {
        return await desktopFiles.createDirectory(dirPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message || 'Failed to create directory');
      }
    }

    const payload = {
      path: dirPath,
      ...(options?.allowOutsideWorkspace ? { allowOutsideWorkspace: true } : {}),
    };

    const response = await fetch(`${this.baseUrl}/fs/mkdir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to create directory' }));
      throw new Error(error.error || 'Failed to create directory');
    }

    const result = await response.json();
    return result;
  }

  async cloneRepository(input: { remoteUrl: string; destinationPath: string; gitIdentityId?: string | null }): Promise<{ success: boolean; path: string; output?: string }> {
    const response = await fetch(`${this.baseUrl}/fs/clone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to clone repository' }));
      throw new Error(error.error || 'Failed to clone repository');
    }

    return await response.json();
  }

  async listLocalDirectory(directoryPath: string | null | undefined, options?: { respectGitignore?: boolean }): Promise<FilesystemEntry[]> {
    const normalizedDirectoryPath = typeof directoryPath === 'string' ? normalizeFsPath(directoryPath.trim()) : '';
    const directoryGeneration = this.listDirectoryGeneration.get(normalizedDirectoryPath) ?? 0;
    const cacheKey = `${normalizedDirectoryPath}|${options?.respectGitignore ? '1' : '0'}`;
    const now = Date.now();
    const cached = this.listDirectoryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.entries;
    }

    const inFlight = this.listDirectoryInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const task = (async () => {
    const desktopFiles = getDesktopFilesApi();
    if (desktopFiles) {
      try {
        const result = await desktopFiles.listDirectory(directoryPath || '', options);
        if (!result || !Array.isArray(result.entries)) {
          return [];
        }
        const entries = result.entries.map<FilesystemEntry>((entry) => ({
          name: entry.name,
          path: normalizeFsPath(entry.path),
          isDirectory: !!entry.isDirectory,
          isFile: !entry.isDirectory,
          isSymbolicLink: false,
        }));
        if ((this.listDirectoryGeneration.get(normalizedDirectoryPath) ?? 0) === directoryGeneration) {
          this.listDirectoryCache.set(cacheKey, {
            entries,
            expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
          });
        }
        return entries;
      } catch (error) {
        console.error('Failed to list directory contents:', error);
        throw error;
      }
    }

    try {
      const params = new URLSearchParams();
      if (directoryPath && directoryPath.trim().length > 0) {
        params.set('path', directoryPath);
      }
      if (options?.respectGitignore) {
        params.set('respectGitignore', 'true');
      }
      const query = params.toString();
      const response = await this.noStoreFetch(`${this.baseUrl}/fs/list${query ? `?${query}` : ''}`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const message = typeof error.error === 'string' ? error.error : 'Failed to list directory';
        throw Object.assign(new Error(message), { status: response.status });
      }

      const result = await response.json();
      if (!result || !Array.isArray(result.entries)) {
        return [];
      }

      const entries = result.entries as FilesystemEntry[];
      if ((this.listDirectoryGeneration.get(normalizedDirectoryPath) ?? 0) === directoryGeneration) {
        this.listDirectoryCache.set(cacheKey, {
          entries,
          expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
        });
      }
      return entries;
    } catch (error) {
      console.error('Failed to list directory contents:', error);
      throw error;
    }
    })();

    const trackedTask = task.finally(() => {
      if (this.listDirectoryInFlight.get(cacheKey) === trackedTask) {
        this.listDirectoryInFlight.delete(cacheKey);
      }
    });
    this.listDirectoryInFlight.set(cacheKey, trackedTask);
    return trackedTask;
  }

  async searchFiles(
    query: string,
    options?: {
      directory?: string | null;
      limit?: number;
      includeHidden?: boolean;
      respectGitignore?: boolean;
      dirs?: boolean;
      type?: 'file' | 'directory';
    }
  ): Promise<ProjectFileSearchHit[]> {
    const directory = typeof options?.directory === 'string' && options.directory.trim().length > 0
      ? options.directory.trim()
      : this.currentDirectory;
    const normalizedDirectory = directory ? normalizeFsPath(directory) : null;
    const scopedClient = directory ? this.getScopedApiClient(directory) : this.client;

    try {
      const response = await scopedClient.find.files({
        query,
        limit: typeof options?.limit === 'number' && Number.isFinite(options.limit) ? options.limit : undefined,
        dirs: options?.dirs === false || options?.type === 'file' ? 'false' : 'true',
        type: options?.type,
      });

      const items = Array.isArray(response?.data) ? response.data : [];
      return items.map<ProjectFileSearchHit>((item) => {
        const normalizedRelativePath = normalizeFsPath(item);
        const name = normalizedRelativePath.split('/').filter(Boolean).pop() || normalizedRelativePath;
        const normalizedPath = normalizedDirectory
          ? normalizeFsPath(`${normalizedDirectory}/${normalizedRelativePath}`)
          : normalizeFsPath(normalizedRelativePath);

        return {
          name,
          path: normalizedPath,
          relativePath: normalizedRelativePath,
          extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
        };
      });
    } catch (error) {
      console.error('Failed to search files:', error);
      throw error;
    }
  }

  async getFilesystemHome(): Promise<string | null> {
    // Optimization: Check for desktop runtime first to avoid unnecessary network calls
    // and fix the "SyntaxError" warning when the endpoint is missing
    const desktopHome = await getDesktopHomeDirectory();
    if (desktopHome) {
      return desktopHome;
    }

    try {
      const response = await this.noStoreFetch(`${this.baseUrl}/fs/home`, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const message =
          typeof error.error === 'string' && error.error.length > 0
            ? error.error
            : 'Failed to resolve home directory';
        throw new Error(message);
      }

      const payload = await response.json();
      if (payload && typeof payload.home === 'string' && payload.home.length > 0) {
        return payload.home;
      }
      return null;
    } catch (error) {
      console.warn('Failed to resolve filesystem home directory:', error);
      return null;
    }
  }

  async setOpenCodeWorkingDirectory(directoryPath: string | null | undefined): Promise<DirectorySwitchResult | null> {
    if (!directoryPath || typeof directoryPath !== 'string' || !directoryPath.trim()) {
      console.warn('[OpencodeClient] setOpenCodeWorkingDirectory: invalid path', directoryPath);
      return null;
    }

    const url = `${this.baseUrl}/opencode/directory`;
    console.log('[OpencodeClient] POST', url, 'with path:', directoryPath);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: directoryPath })
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const error = payload ?? {};
        const message =
          typeof error.error === 'string' && error.error.length > 0
            ? error.error
            : 'Failed to update OpenCode working directory';
        throw new Error(message);
      }

      if (payload && typeof payload === 'object') {
        return payload as DirectorySwitchResult;
      }

      return {
        success: true,
        restarted: false,
        path: directoryPath
      };
    } catch (error) {
      console.warn('Failed to update OpenCode working directory:', error);
      throw error;
    }
  }
}

// Exported singleton instance
export const opencodeClient = new OpencodeService();

// Exported types
export type { Session, Message, Part, Provider, Config, Model };
export type { App };
