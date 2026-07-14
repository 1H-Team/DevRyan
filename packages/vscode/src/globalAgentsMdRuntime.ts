import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_GLOBAL_AGENTS_MD_BYTES = 1024 * 1024;

export const GLOBAL_AGENTS_MD_UNAVAILABLE_REASON =
  'Global AGENTS.md can only be edited for a locally managed OpenCode runtime.';

export type GlobalAgentsMdReadResult = {
  content: string;
  exists: boolean;
  editable: boolean;
  unavailableReason?: string;
};

export type GlobalAgentsMdSaveResult = GlobalAgentsMdReadResult & {
  success: true;
  runtimeApplied: boolean;
  warning?: string;
};

export type GlobalAgentsMdRuntime = {
  read: () => Promise<GlobalAgentsMdReadResult>;
  save: (content: unknown) => Promise<GlobalAgentsMdSaveResult>;
};

type GlobalAgentsMdRuntimeOptions = {
  agentsMdPath: string;
  refreshRuntime: () => Promise<unknown>;
  isEditable: () => boolean;
  unavailableReason?: string;
};

const createHttpError = (message: string, statusCode: number): Error & { statusCode: number } => (
  Object.assign(new Error(message), { statusCode })
);

const normalizeContent = (content: unknown): string => {
  const value = typeof content === 'string' ? content : '';
  if (!value.trim()) return '';
  return value.endsWith('\n') ? value : `${value}\n`;
};

const formatErrorMessage = (error: unknown): string => (
  error instanceof Error && error.message.trim() ? error.message.trim() : 'unknown refresh error'
);

export const createGlobalAgentsMdRuntime = ({
  agentsMdPath,
  refreshRuntime,
  isEditable,
  unavailableReason = GLOBAL_AGENTS_MD_UNAVAILABLE_REASON,
}: GlobalAgentsMdRuntimeOptions): GlobalAgentsMdRuntime => {
  if (!agentsMdPath.trim()) {
    throw new Error('agentsMdPath is required');
  }

  const read = async (): Promise<GlobalAgentsMdReadResult> => {
    if (!isEditable()) {
      return {
        content: '',
        exists: false,
        editable: false,
        unavailableReason,
      };
    }

    try {
      const content = await fs.readFile(agentsMdPath, 'utf8');
      return { content, exists: true, editable: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { content: '', exists: false, editable: true };
      }
      throw error;
    }
  };

  const save = async (content: unknown): Promise<GlobalAgentsMdSaveResult> => {
    if (!isEditable()) {
      throw createHttpError(unavailableReason, 409);
    }

    const normalizedContent = normalizeContent(content);
    if (Buffer.byteLength(normalizedContent, 'utf8') > MAX_GLOBAL_AGENTS_MD_BYTES) {
      throw createHttpError(
        `Content exceeds maximum size of ${MAX_GLOBAL_AGENTS_MD_BYTES} bytes`,
        413,
      );
    }

    if (normalizedContent) {
      await fs.mkdir(path.dirname(agentsMdPath), { recursive: true });
      await fs.writeFile(agentsMdPath, normalizedContent, 'utf8');
    } else {
      await fs.rm(agentsMdPath, { force: true });
    }

    const result: GlobalAgentsMdSaveResult = {
      success: true,
      content: normalizedContent,
      exists: Boolean(normalizedContent),
      editable: true,
      runtimeApplied: true,
    };

    try {
      await refreshRuntime();
      return result;
    } catch (error) {
      return {
        ...result,
        runtimeApplied: false,
        warning: `Global AGENTS.md was saved, but OpenCode could not reload it automatically: ${formatErrorMessage(error)}`,
      };
    }
  };

  return { read, save };
};
