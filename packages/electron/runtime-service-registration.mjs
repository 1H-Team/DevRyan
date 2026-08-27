import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileDefault = promisify(execFileCallback);
const LABEL = 'dev.openchamber.desktop.runtime-service';
const MAX_OUTPUT_BYTES = 32 * 1_024;
const ALLOWED_STATES = new Set([
  'enabled',
  'requires_approval',
  'not_registered',
  'not_found',
  'unknown',
  'unavailable',
  'legacy_required',
  'invalid',
]);

export class RuntimeServiceRegistrationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RuntimeServiceRegistrationError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new RuntimeServiceRegistrationError(message, code);
};

const escapeXml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const atomicWrite = async (target, contents, fsPromises) => {
  const directory = path.dirname(target);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fsPromises.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await fsPromises.rename(temporary, target);
    await fsPromises.chmod(target, 0o600);
  } finally {
    await fsPromises.unlink(temporary).catch(() => undefined);
  }
};

const legacyPlist = ({ executablePath, dataDirectory }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(executablePath)}</string><string>--runtime-service</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(path.join(dataDirectory, 'runtime-service', 'stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(dataDirectory, 'runtime-service', 'stderr.log'))}</string>
</dict>
</plist>
`;

const parseHelperOutput = (stdout) => {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
    fail('Runtime service control returned invalid output', 'runtime_service_control_invalid');
  }
  let payload;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    fail('Runtime service control returned invalid output', 'runtime_service_control_invalid');
  }
  const code = payload?.code ?? null;
  if (!payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || typeof payload.ok !== 'boolean'
    || !ALLOWED_STATES.has(payload.state)
    || (code !== null && typeof code !== 'string')) {
    fail('Runtime service control returned invalid output', 'runtime_service_control_invalid');
  }
  return Object.freeze({ ok: payload.ok, state: payload.state, code });
};

export const createRuntimeServiceRegistration = ({
  platform = process.platform,
  macosMajor,
  isPackaged,
  executablePath = process.execPath,
  resourcesPath,
  dataDirectory,
  homeDirectory = os.homedir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  fsPromises = fs,
  execFile = execFileDefault,
  developmentMode = false,
} = {}) => {
  if (platform !== 'darwin') {
    return Object.freeze({
      status: async () => ({ ok: false, state: 'unsupported', code: 'runtime_service_platform_unsupported' }),
      register: async () => fail('Background Bots require macOS', 'runtime_service_platform_unsupported'),
      unregister: async () => ({ ok: true, state: 'not_registered', code: null }),
      settingsUrl: null,
      mode: 'unsupported',
    });
  }
  if (!Number.isSafeInteger(macosMajor) || macosMajor < 1
    || typeof executablePath !== 'string' || !path.isAbsolute(executablePath)
    || typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    fail('Runtime service registration configuration is invalid', 'runtime_service_registration_invalid');
  }

  const modern = macosMajor >= 13 && isPackaged === true;
  const helper = resourcesPath
    ? path.join(resourcesPath, 'native', 'DevRyanRuntimeServiceControl')
    : '';
  const legacyPath = path.join(homeDirectory, 'Library', 'LaunchAgents', `${LABEL}.legacy.plist`);

  if (developmentMode === true) {
    return Object.freeze({
      status: async () => ({
        ok: false,
        state: 'unavailable',
        code: 'runtime_service_packaged_build_required',
      }),
      register: async () => fail(
        'Background Bots require an installed packaged DevRyan build',
        'runtime_service_packaged_build_required',
      ),
      unregister: async () => ({ ok: true, state: 'not_registered', code: null }),
      settingsUrl: null,
      mode: 'unavailable',
      legacyPath,
    });
  }

  const preflightHelper = async () => {
    let entry;
    try {
      entry = await fsPromises.stat(helper);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        fail(
          'This DevRyan build is missing the signed background runtime helper',
          'runtime_service_helper_missing',
        );
      }
      fail(
        'The signed background runtime helper could not be inspected',
        'runtime_service_helper_unreadable',
      );
    }
    if (!entry.isFile()) {
      fail(
        'The signed background runtime helper is invalid',
        'runtime_service_helper_invalid',
      );
    }
    try {
      await fsPromises.access(helper, fsConstants.X_OK);
    } catch {
      fail(
        'The signed background runtime helper is not executable',
        'runtime_service_helper_not_executable',
      );
    }
  };

  const callHelper = async (command) => {
    if (!modern || !helper) fail('SMAppService is unavailable', 'smappservice_unavailable');
    await preflightHelper();
    let result;
    try {
      result = await execFile(helper, [command], {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: 15_000,
      });
    } catch (error) {
      if (typeof error?.stdout === 'string' && error.stdout.trim()) return parseHelperOutput(error.stdout);
      if (error?.code === 'ENOENT') {
        fail(
          'This DevRyan build is missing the signed background runtime helper',
          'runtime_service_helper_missing',
        );
      }
      if (error?.code === 'EACCES') {
        fail(
          'The signed background runtime helper is not executable',
          'runtime_service_helper_not_executable',
        );
      }
      if (error?.killed === true || error?.code === 'ETIMEDOUT') {
        fail('Background runtime control timed out', 'runtime_service_control_timeout');
      }
      if (/bad cpu type|wrong architecture/i.test(String(error?.stderr || error?.message || ''))) {
        fail(
          'The signed background runtime helper does not support this Mac',
          'runtime_service_helper_wrong_arch',
        );
      }
      fail('Background runtime control could not start', 'runtime_service_control_launch_failed');
    }
    return parseHelperOutput(result.stdout);
  };

  const modernStatus = async () => {
    try {
      return await callHelper('status');
    } catch (error) {
      if (error instanceof RuntimeServiceRegistrationError) {
        return Object.freeze({ ok: false, state: 'unavailable', code: error.code });
      }
      throw error;
    }
  };

  const registerModern = async () => {
    const result = await callHelper('register');
    if (!result.ok) {
      fail(
        'macOS could not register the signed background runtime',
        result.code || 'smappservice_registration_failed',
      );
    }
    return result;
  };

  const legacyStatus = async () => {
    const exists = await fsPromises.stat(legacyPath).then((entry) => entry.isFile(), () => false);
    return Object.freeze({ ok: true, state: exists ? 'enabled' : 'not_registered', code: null });
  };

  const registerLegacy = async ({ allowLegacy = false } = {}) => {
    if (!allowLegacy) {
      fail(
        'Legacy LaunchAgent registration requires explicit consent',
        'runtime_service_legacy_consent_required',
      );
    }
    if (!Number.isSafeInteger(uid) || uid < 0) {
      fail('The current macOS user could not be identified', 'runtime_service_registration_invalid');
    }
    await atomicWrite(legacyPath, legacyPlist({ executablePath, dataDirectory }), fsPromises);
    try {
      await execFile('/bin/launchctl', ['bootstrap', `gui/${uid}`, legacyPath], {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: 15_000,
      });
    } catch {
      await fsPromises.unlink(legacyPath).catch(() => undefined);
      fail('Legacy LaunchAgent registration failed', 'runtime_service_registration_failed');
    }
    return Object.freeze({ ok: true, state: 'enabled', code: null });
  };

  const unregisterLegacy = async () => {
    if (Number.isSafeInteger(uid) && uid >= 0) {
      await execFile('/bin/launchctl', ['bootout', `gui/${uid}`, legacyPath], {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: 15_000,
      }).catch(() => undefined);
    }
    await fsPromises.unlink(legacyPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return Object.freeze({ ok: true, state: 'not_registered', code: null });
  };

  return Object.freeze({
    status: () => (modern ? modernStatus() : legacyStatus()),
    register: (options) => (modern ? registerModern() : registerLegacy(options)),
    unregister: () => (modern ? callHelper('unregister') : unregisterLegacy()),
    settingsUrl: modern
      ? 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
      : null,
    mode: modern ? 'smappservice' : 'legacy',
    legacyPath,
  });
};
