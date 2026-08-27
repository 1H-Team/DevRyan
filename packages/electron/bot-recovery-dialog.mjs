import crypto from 'node:crypto';
import fs, { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BUNDLE_CONTENT_TYPE = 'application/vnd.devryan.bot-recovery';
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BotRecoveryDialogError extends Error {
  constructor(message, code = 'bot_recovery_native_invalid') {
    super(message);
    this.name = 'BotRecoveryDialogError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotRecoveryDialogError(message, code);
};

const validateContext = ({ origin, session }) => {
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail('Local Bot recovery server is unavailable', 'bot_recovery_native_unavailable');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || typeof session?.fetch !== 'function') {
    fail('Authenticated Bot recovery session is unavailable', 'bot_recovery_native_unavailable');
  }
  return url.origin;
};

const responseError = async (response, fallback) => {
  const payload = await response.clone?.().json?.().catch(() => null);
  const message = typeof payload?.error === 'string'
    ? payload.error
    : await response.text?.().catch(() => '');
  const error = new BotRecoveryDialogError(message || fallback, payload?.code || 'bot_recovery_failed');
  error.statusCode = response.status;
  throw error;
};

const fsyncParent = async (filePath, fsPromises) => {
  const handle = await fsPromises.open(path.dirname(filePath), 'r').catch(() => null);
  try {
    await handle?.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const boundedTransform = (maximumBytes) => {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        callback(new BotRecoveryDialogError(
          'Encrypted Bot recovery bundle is too large',
          'bot_recovery_native_too_large',
        ));
        return;
      }
      callback(null, chunk);
    },
  });
};

export function createBotRecoveryDialog({
  dialog,
  fsPromises = fsp,
  createWriteStream = fs.createWriteStream,
  readableFromWeb = Readable.fromWeb,
  pipelineImpl = pipeline,
  randomUUID = crypto.randomUUID,
  now = () => new Date(),
  maximumBundleBytes = MAX_BUNDLE_BYTES,
} = {}) {
  if (!dialog || typeof dialog.showSaveDialog !== 'function'
    || typeof dialog.showOpenDialog !== 'function'
    || typeof fsPromises?.open !== 'function' || typeof createWriteStream !== 'function'
    || typeof readableFromWeb !== 'function' || typeof pipelineImpl !== 'function'
    || typeof randomUUID !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(maximumBundleBytes) || maximumBundleBytes < 1024) {
    throw new TypeError('Bot recovery native dialog is misconfigured');
  }

  const exportBundle = async ({ window, origin, session, botId, request }) => {
    if (typeof botId !== 'string' || !UUID_PATTERN.test(botId)
      || !request || typeof request !== 'object' || Array.isArray(request)) {
      fail('Bot recovery export request is invalid');
    }
    const localOrigin = validateContext({ origin, session });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const defaultFileName = `DevRyan-Bot-Recovery-${botId}-${stamp}.drbr`;
    const selection = await dialog.showSaveDialog(window || undefined, {
      title: 'Export Bot Recovery Bundle',
      defaultPath: defaultFileName,
      filters: [{ name: 'DevRyan Bot recovery', extensions: ['drbr'] }],
    });
    if (selection.canceled || !selection.filePath) {
      return Object.freeze({ cancelled: true, fileName: defaultFileName });
    }
    const response = await session.fetch(
      `${localOrigin}/api/bots/${botId}/recovery/export`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: BUNDLE_CONTENT_TYPE,
          'Content-Type': 'application/json',
          'X-DevRyan-CSRF': '1',
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok || !response.body) {
      await responseError(response, `Bot recovery export failed (${response.status})`);
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && (declared < 1 || declared > maximumBundleBytes)) {
      fail('Encrypted Bot recovery bundle is too large', 'bot_recovery_native_too_large');
    }
    const temporaryPath = path.join(
      path.dirname(selection.filePath),
      `.${path.basename(selection.filePath)}.recovery-${randomUUID()}.tmp`,
    );
    try {
      await pipelineImpl(
        readableFromWeb(response.body),
        boundedTransform(maximumBundleBytes),
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
      );
      const handle = await fsPromises.open(temporaryPath, 'r+');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > maximumBundleBytes) {
          fail('Encrypted Bot recovery bundle is invalid', 'bot_recovery_native_invalid');
        }
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsPromises.rename(temporaryPath, selection.filePath);
      await fsyncParent(selection.filePath, fsPromises);
    } catch (error) {
      await fsPromises.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return Object.freeze({ cancelled: false, fileName: path.basename(selection.filePath) });
  };

  const restoreBundle = async ({ window, origin, session, passphrase, mode }) => {
    const localOrigin = validateContext({ origin, session });
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024
      || /[\u0000\r\n]/u.test(passphrase)
      || !['empty', 'merge'].includes(mode)) {
      fail('Bot recovery restore request is invalid');
    }
    const selection = await dialog.showOpenDialog(window || undefined, {
      title: 'Restore Bot Recovery Bundle',
      properties: ['openFile'],
      filters: [{ name: 'DevRyan Bot recovery', extensions: ['drbr'] }],
    });
    if (selection.canceled || !selection.filePaths?.[0]) {
      return Object.freeze({ cancelled: true });
    }
    const filePath = selection.filePaths[0];
    const linkStat = await fsPromises.lstat(filePath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()
      || linkStat.size < 1 || linkStat.size > maximumBundleBytes) {
      fail('Encrypted Bot recovery bundle is invalid', 'bot_recovery_native_invalid');
    }
    const handle = await fsPromises.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    let bundle;
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size !== linkStat.size) {
        fail('Encrypted Bot recovery bundle changed while opening', 'bot_recovery_native_invalid');
      }
      bundle = await handle.readFile();
    } finally {
      await handle.close();
    }
    try {
      const response = await session.fetch(`${localOrigin}/api/bots/recovery/restore`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': BUNDLE_CONTENT_TYPE,
          'X-DevRyan-CSRF': '1',
          'X-DevRyan-Recovery-Passphrase': passphrase,
          'X-DevRyan-Recovery-Mode': mode,
        },
        body: bundle,
      });
      if (!response.ok) {
        await responseError(response, `Bot recovery restore failed (${response.status})`);
      }
      const payload = await response.json();
      return Object.freeze({
        cancelled: false,
        restored: payload?.restored === true,
        bot: payload?.bot || null,
        mode: payload?.mode || mode,
        result: payload?.result || {},
      });
    } finally {
      bundle.fill(0);
    }
  };

  return Object.freeze({ exportBundle, restoreBundle });
}
