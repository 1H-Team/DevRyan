// Node-only: imports node:fs, node:crypto and adm-zip. Browser code must not import it.
import type { SharedQuotaFetch } from '../index.js';

export interface ArchiveLimits {
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxPathBytes?: number;
  maxDepth?: number;
}

export type ArchiveRejectionCode =
  | 'ARCHIVE_DOWNLOAD_TOO_LARGE'
  | 'ARCHIVE_ENTRY_LIMIT'
  | 'ARCHIVE_INVALID_PATH'
  | 'ARCHIVE_PATH_COLLISION'
  | 'ARCHIVE_UNSAFE_ENTRY'
  | 'ARCHIVE_SIZE_LIMIT'
  | 'ARCHIVE_CORRUPT'
  | 'ARCHIVE_MISSING_SKILL_FILE'
  | 'ARCHIVE_DOWNLOAD_TIMEOUT';

export class ArchiveRejectionError extends Error {
  readonly code: ArchiveRejectionCode;
  constructor(code: ArchiveRejectionCode, message: string, options?: { cause?: unknown });
}

export function isArchiveRejectionError(error: unknown): error is ArchiveRejectionError;

export interface SafeArchiveEntry {
  name: string;
  isDirectory: boolean;
  declaredSize: number;
}

export interface SafeArchivePlan {
  archive: unknown;
  entries: SafeArchiveEntry[];
  totalDeclaredBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<Required<ArchiveLimits>>;

export function downloadArchive(
  url: string | URL,
  options?: {
    fetchImpl?: SharedQuotaFetch;
    headers?: HeadersInit;
    allowedOrigins?: Iterable<string>;
    timeoutMs?: number;
    maxRedirects?: number;
    maxArchiveBytes?: number;
    signal?: AbortSignal;
  },
): Promise<Buffer>;

export function preflightSkillArchive(
  archiveBuffer: Buffer | Uint8Array | ArrayBuffer,
  limits?: ArchiveLimits,
): SafeArchivePlan;

export function installSkillArchive(options: {
  archiveBuffer: Buffer | Uint8Array | ArrayBuffer;
  targetDir: string;
  replace?: boolean;
  limits?: ArchiveLimits;
  requiredRootFile?: string;
  fsOps?: Record<string, unknown>;
}): Promise<{ installedPath: string; files: number; bytes: number }>;
