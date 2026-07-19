import fs from 'node:fs';
import path from 'node:path';

const COMPATIBILITY_WRITE_TOOLS = new Set(['oc_write']);
const MAX_PENDING_WRITES = 256;

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const getWritePath = (args) => {
  if (!isRecord(args)) return '';
  for (const candidate of [args.path, args.filePath, args.file_path, args.file, args.filename]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
};

const getCallKey = (input) => {
  const sessionID = typeof input?.sessionID === 'string' ? input.sessionID.trim() : '';
  const callID = typeof input?.callID === 'string' ? input.callID.trim() : '';
  return sessionID && callID ? `${sessionID}\u0000${callID}` : '';
};

export const DevRyanFileWriteMetadataPlugin = async ({ directory } = {}) => {
  const pendingWrites = new Map();
  const baseDirectory = typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : process.cwd();

  const rememberWrite = (key, exists) => {
    if (!pendingWrites.has(key) && pendingWrites.size >= MAX_PENDING_WRITES) {
      const oldestKey = pendingWrites.keys().next().value;
      if (oldestKey !== undefined) pendingWrites.delete(oldestKey);
    }
    pendingWrites.set(key, { exists });
  };

  return {
    'tool.execute.before': async (input, output) => {
      if (!COMPATIBILITY_WRITE_TOOLS.has(input?.tool)) return;
      const key = getCallKey(input);
      const targetPath = getWritePath(output?.args);
      if (!key || !targetPath) return;

      const absolutePath = path.isAbsolute(targetPath)
        ? path.normalize(targetPath)
        : path.resolve(baseDirectory, targetPath);
      rememberWrite(key, fs.existsSync(absolutePath));
    },
    'tool.execute.after': async (input, output) => {
      if (!COMPATIBILITY_WRITE_TOOLS.has(input?.tool)) return;
      const key = getCallKey(input);
      if (!key) return;

      const pending = pendingWrites.get(key);
      pendingWrites.delete(key);
      if (!pending || !output) return;

      const metadata = isRecord(output.metadata) ? output.metadata : {};
      if (typeof metadata.exists === 'boolean') return;
      output.metadata = {
        ...metadata,
        exists: pending.exists,
      };
    },
  };
};

export default DevRyanFileWriteMetadataPlugin;
