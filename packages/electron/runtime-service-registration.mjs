import fs from 'node:fs/promises';
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
  nativeControl = null,
  nativeControlErrorCode = null,
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
  const legacyPath = path.join(homeDirectory, 'Library', 'LaunchAgents', `${LABEL}.legacy.plist`);
  const bundledPlistPath = typeof resourcesPath === 'string' && path.isAbsolute(resourcesPath)
    ? path.resolve(resourcesPath, '..', 'Library', 'LaunchAgents', `${LABEL}.plist`)
    : null;
  let activeMode = modern ? 'smappservice' : 'legacy';

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

  const callNativeControl = async (command) => {
    if (!modern) fail('SMAppService is unavailable', 'smappservice_unavailable');
    if (!nativeControl) {
      const code = typeof nativeControlErrorCode === 'string'
        ? nativeControlErrorCode
        : 'runtime_service_native_bridge_missing';
      const message = code === 'runtime_service_native_bridge_missing'
        ? 'This DevRyan build is missing the background runtime native bridge'
        : 'The background runtime native bridge could not be loaded';
      fail(message, code);
    }
    if (typeof nativeControl[command] !== 'function') {
      fail('The background runtime native bridge is invalid', 'runtime_service_native_bridge_invalid');
    }
    let result;
    try {
      result = await nativeControl[command]();
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code.startsWith('runtime_service_')
        ? error.code
        : 'runtime_service_native_bridge_failed';
      fail('Background runtime control failed', code);
    }
    const code = result?.code ?? null;
    if (!result
      || typeof result !== 'object'
      || typeof result.ok !== 'boolean'
      || !ALLOWED_STATES.has(result.state)
      || (code !== null && typeof code !== 'string')) {
      fail('The background runtime native bridge returned an invalid result', 'runtime_service_native_bridge_invalid');
    }
    return Object.freeze({ ok: result.ok, state: result.state, code });
  };

  const modernStatus = async () => {
    try {
      return await callNativeControl('status');
    } catch (error) {
      if (error instanceof RuntimeServiceRegistrationError) {
        return Object.freeze({ ok: false, state: 'unavailable', code: error.code });
      }
      throw error;
    }
  };

  const registerModern = async () => {
    const result = await callNativeControl('register');
    if (!result.ok && result.state !== 'not_found') {
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

  const bundledDefinitionExists = async () => (
    bundledPlistPath !== null
      && await fsPromises.stat(bundledPlistPath).then((entry) => entry.isFile(), () => false)
  );

  const selectModernMode = async () => {
    const legacy = await legacyStatus();
    if (legacy.state === 'enabled') {
      activeMode = 'legacy';
      return Object.freeze({ mode: activeMode, status: legacy });
    }

    const current = await modernStatus();
    if (current.state === 'not_found' && await bundledDefinitionExists()) {
      activeMode = 'legacy';
      return Object.freeze({ mode: activeMode, status: legacy });
    }

    activeMode = 'smappservice';
    return Object.freeze({ mode: activeMode, status: current });
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
    status: async () => {
      if (!modern) return legacyStatus();
      return (await selectModernMode()).status;
    },
    register: async (options) => {
      if (!modern) return registerLegacy(options);
      const selected = await selectModernMode();
      if (selected.mode === 'legacy') return registerLegacy(options);
      const registered = await registerModern();
      if (registered.state === 'not_found' && await bundledDefinitionExists()) {
        activeMode = 'legacy';
        return registerLegacy(options);
      }
      return registered;
    },
    unregister: async () => {
      if (!modern) return unregisterLegacy();
      const legacy = await legacyStatus();
      if (activeMode === 'legacy' || legacy.state === 'enabled') {
        activeMode = 'legacy';
        return unregisterLegacy();
      }
      activeMode = 'smappservice';
      return callNativeControl('unregister');
    },
    get settingsUrl() {
      return activeMode === 'smappservice'
        ? 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
        : null;
    },
    get mode() {
      return activeMode;
    },
    legacyPath,
  });
};
