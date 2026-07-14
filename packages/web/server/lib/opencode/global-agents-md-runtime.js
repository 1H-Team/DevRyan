import fs from 'node:fs';
import path from 'node:path';

export const MAX_GLOBAL_AGENTS_MD_BYTES = 1024 * 1024;

export const GLOBAL_AGENTS_MD_UNAVAILABLE_REASON =
  'Global AGENTS.md can only be edited for a locally managed OpenCode runtime.';

const createHttpError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

const normalizeContent = (content) => {
  const value = typeof content === 'string' ? content : '';
  if (!value.trim()) return '';
  return value.endsWith('\n') ? value : `${value}\n`;
};

const formatErrorMessage = (error) => (
  error instanceof Error && error.message.trim() ? error.message.trim() : 'unknown refresh error'
);

export const createGlobalAgentsMdRuntime = ({
  agentsMdPath,
  fileSystem = fs.promises,
  refreshRuntime,
  isEditable,
  unavailableReason = GLOBAL_AGENTS_MD_UNAVAILABLE_REASON,
}) => {
  if (typeof agentsMdPath !== 'string' || !agentsMdPath.trim()) {
    throw new Error('agentsMdPath is required');
  }

  const canEdit = () => (typeof isEditable === 'function' ? isEditable() === true : true);

  const read = async () => {
    if (!canEdit()) {
      return {
        content: '',
        exists: false,
        editable: false,
        unavailableReason,
      };
    }

    try {
      const content = await fileSystem.readFile(agentsMdPath, 'utf8');
      return { content, exists: true, editable: true };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { content: '', exists: false, editable: true };
      }
      throw error;
    }
  };

  const save = async (content) => {
    if (!canEdit()) {
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
      await fileSystem.mkdir(path.dirname(agentsMdPath), { recursive: true });
      await fileSystem.writeFile(agentsMdPath, normalizedContent, 'utf8');
    } else {
      await fileSystem.rm(agentsMdPath, { force: true });
    }

    const result = {
      success: true,
      content: normalizedContent,
      exists: Boolean(normalizedContent),
      editable: true,
      runtimeApplied: true,
    };

    try {
      await refreshRuntime?.();
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
