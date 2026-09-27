import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// After a catalog import or restore every autonomous effect waits for the
// owner: Telegram polling, inbox admission and outbox delivery, speech
// processing, routines, memory extraction and run recovery. The hold is a
// private host file so it survives restarts and crashes until an explicit
// owner resume. Restored deliveries that may already have happened are never
// replayed; the hold only defers what runs next.

const HOLD_VERSION = 1;
const REASONS = new Set(['import', 'restore', 'start_empty']);

export class BotActivationHoldError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BotActivationHoldError';
    this.code = code;
  }
}

const validate = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== HOLD_VERSION || !REASONS.has(value.reason)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.operationId)) {
    // A corrupt hold keeps everything held: failing open could replay effects.
    return Object.freeze({
      version: HOLD_VERSION,
      reason: 'restore',
      createdAt: new Date(0).toISOString(),
      operationId: '00000000-0000-4000-8000-000000000000',
      corrupt: true,
    });
  }
  return Object.freeze({
    version: HOLD_VERSION,
    reason: value.reason,
    createdAt: value.createdAt,
    operationId: value.operationId,
  });
};

export function createBotActivationHold({ dataDirectory, fsImpl = fs } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    throw new BotActivationHoldError('Bot activation hold requires an absolute data directory', 'bot_activation_hold_invalid');
  }
  const holdPath = path.join(dataDirectory, 'bots', 'runtime', 'activation-hold.v1.json');
  let current = null;
  try {
    current = validate(JSON.parse(fsImpl.readFileSync(holdPath, 'utf8')));
  } catch (error) {
    current = error?.code === 'ENOENT' ? null : validate({});
  }

  const writeAtomic = async (value) => {
    const directory = path.dirname(holdPath);
    await fsImpl.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${holdPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const handle = await fsImpl.promises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsImpl.promises.rename(temporary, holdPath);
    } catch (error) {
      await fsImpl.promises.unlink(temporary).catch(() => undefined);
      throw error;
    }
  };

  const release = async () => {
    try {
      await fsImpl.promises.unlink(holdPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    current = null;
  };

  return Object.freeze({
    path: holdPath,
    get: () => current,
    isHeld: () => current !== null,
    async hold({ reason, operationId }) {
      const next = validate({
        version: HOLD_VERSION,
        reason,
        createdAt: new Date().toISOString(),
        operationId,
      });
      if (!next || next.corrupt) {
        throw new BotActivationHoldError('Bot activation hold is invalid', 'bot_activation_hold_invalid');
      }
      await writeAtomic(next);
      current = next;
      return current;
    },
    release,
    // Puts back the hold that existed before a failed operation took its
    // own (or none): a failed restore or import never lifts an earlier hold.
    async reinstate(previous) {
      if (!previous) {
        await release();
        return null;
      }
      const next = validate({
        version: HOLD_VERSION,
        reason: previous.reason,
        createdAt: previous.createdAt,
        operationId: previous.operationId,
      });
      await writeAtomic(next);
      current = next;
      return current;
    },
  });
}
