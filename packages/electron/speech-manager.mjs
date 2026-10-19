import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SPEECH_EVENT = 'devryan:macos-speech';
const HELPER_NAME = 'macos-speech-helper';
const HELPER_STOP_COMMAND = 'stop\n';
const GRACEFUL_STOP_TIMEOUT_MS = 800;
const FORCE_STOP_TIMEOUT_MS = 1_500;

const normalizeLanguage = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw || null;
};

const addLocaleArg = (args, language) => {
  const normalized = normalizeLanguage(language);
  if (normalized) {
    args.push('--locale', normalized);
  }
  return normalized;
};

const normalizeFiniteNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const parseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const parseFirstPayload = (stdout, type) => stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map(parseJsonLine)
  .find((item) => item?.type === type);

export class MacosSpeechManager {
  constructor({ baseDir, isPackaged, resourcesPath, emit, log }) {
    this.baseDir = baseDir;
    this.isPackaged = Boolean(isPackaged);
    this.resourcesPath = resourcesPath;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.log = log ?? console;
    this.child = null;
    this.sessionId = 0;
    this.stopTimers = new Map();
  }

  get helperPath() {
    if (this.isPackaged && this.resourcesPath) {
      return path.join(this.resourcesPath, 'native', HELPER_NAME);
    }
    return path.join(this.baseDir, 'resources', 'native', HELPER_NAME);
  }

  async getCapability({ language } = {}) {
    if (process.platform !== 'darwin') {
      return this.#unavailable('platform_unsupported');
    }

    const helperPath = this.helperPath;
    if (!fs.existsSync(helperPath)) {
      return this.#unavailable('helper_missing');
    }

    try {
      const args = ['--capability'];
      const requestedLocale = addLocaleArg(args, language);
      const { stdout } = await execFileAsync(helperPath, args, {
        timeout: 3_000,
        maxBuffer: 1024 * 64,
      });
      const payload = parseFirstPayload(stdout, 'capability');

      if (!payload) {
        return this.#unavailable('invalid_helper_response');
      }

      return {
        available: Boolean(payload.available),
        platform: 'darwin',
        reason: typeof payload.reason === 'string' ? payload.reason : null,
        locale: typeof payload.locale === 'string' ? payload.locale : requestedLocale,
        speechAuthorization: typeof payload.speechAuthorization === 'string' ? payload.speechAuthorization : 'unknown',
        microphoneAuthorization: typeof payload.microphoneAuthorization === 'string' ? payload.microphoneAuthorization : 'unknown',
        supportsOnDeviceRecognition: Boolean(payload.supportsOnDeviceRecognition),
      };
    } catch (error) {
      this.log.warn?.('[speech] capability check failed:', error);
      return this.#unavailable('capability_check_failed');
    }
  }

  async requestAuthorization({ language } = {}) {
    if (process.platform !== 'darwin') {
      return this.#unavailable('platform_unsupported');
    }

    const helperPath = this.helperPath;
    if (!fs.existsSync(helperPath)) {
      return this.#unavailable('helper_missing');
    }

    try {
      const args = ['--authorize'];
      addLocaleArg(args, language);
      const { stdout } = await execFileAsync(helperPath, args, {
        timeout: 30_000,
        maxBuffer: 1024 * 64,
      });
      const payload = parseFirstPayload(stdout, 'capability');
      if (!payload) {
        return this.#unavailable('invalid_helper_response');
      }
      return {
        available: Boolean(payload.available),
        platform: 'darwin',
        reason: typeof payload.reason === 'string' ? payload.reason : null,
        locale: typeof payload.locale === 'string' ? payload.locale : null,
        speechAuthorization: typeof payload.speechAuthorization === 'string' ? payload.speechAuthorization : 'unknown',
        microphoneAuthorization: typeof payload.microphoneAuthorization === 'string' ? payload.microphoneAuthorization : 'unknown',
        supportsOnDeviceRecognition: Boolean(payload.supportsOnDeviceRecognition),
      };
    } catch (error) {
      this.log.warn?.('[speech] authorization request failed:', error);
      return this.#unavailable('authorization_failed');
    }
  }

  async getInputDevices() {
    if (process.platform !== 'darwin') {
      return [];
    }

    const helperPath = this.helperPath;
    if (!fs.existsSync(helperPath)) {
      return [];
    }

    try {
      const { stdout } = await execFileAsync(helperPath, ['--devices'], {
        timeout: 3_000,
        maxBuffer: 1024 * 128,
      });
      const payload = parseFirstPayload(stdout, 'devices');
      const devices = Array.isArray(payload?.devices) ? payload.devices : [];
      return devices
        .map((device) => ({
          id: typeof device?.id === 'string' ? device.id : '',
          name: typeof device?.name === 'string' ? device.name : '',
          isDefault: device?.isDefault === true,
        }))
        .filter((device) => device.id && device.name);
    } catch (error) {
      this.log.warn?.('[speech] device enumeration failed:', error);
      return [];
    }
  }

  async start({ language, inputDeviceId, silenceThresholdDb, silenceHoldMs } = {}) {
    if (process.platform !== 'darwin') {
      throw new Error('Native macOS speech input is only supported on macOS');
    }

    const helperPath = this.helperPath;
    if (!fs.existsSync(helperPath)) {
      throw new Error('macOS speech helper is not available. Rebuild the Electron app.');
    }

    this.stop();
    const sessionId = this.sessionId + 1;
    this.sessionId = sessionId;

    const args = ['--recognize'];
    addLocaleArg(args, language);
    const normalizedInputDeviceId = normalizeLanguage(inputDeviceId);
    if (normalizedInputDeviceId) {
      args.push('--input-device-id', normalizedInputDeviceId);
    }
    args.push(
      '--silence-threshold-db', String(normalizeFiniteNumber(silenceThresholdDb, -42, -80, -10)),
      '--silence-hold-ms', String(Math.round(normalizeFiniteNumber(silenceHoldMs, 1200, 300, 5000))),
    );

    const child = spawn(helperPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child = child;

    let stdoutBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        this.#handleHelperLine(sessionId, line);
      }
    });

    let stderrBuffer = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.log.warn?.('[speech] helper stderr:', line.trim());
      }
    });

    child.on('error', (error) => {
      if (this.child !== child) return;
      this.emit(SPEECH_EVENT, {
        type: 'error',
        provider: 'macos',
        code: 'helper_start_failed',
        message: error.message,
      });
    });

    child.on('exit', (code, signal) => {
      this.#clearStopTimers(child);
      if (this.child === child) {
        this.child = null;
      }
      if (code && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        this.emit(SPEECH_EVENT, {
          type: 'error',
          provider: 'macos',
          code: 'helper_exited',
          message: `macOS speech helper exited with code ${code}`,
        });
      }
      this.emit(SPEECH_EVENT, { type: 'stopped', provider: 'macos' });
    });

    return { started: true };
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return { stopped: true };
    }

    if (!this.#requestGracefulStop(child)) {
      this.#sendSignal(child, 'SIGTERM');
    }
    this.#scheduleStopFallback(child);
    return { stopped: true };
  }

  cancel() {
    return this.stop();
  }

  shutdown() {
    this.stop();
  }

  #handleHelperLine(sessionId, line) {
    if (sessionId !== this.sessionId) return;
    const payload = parseJsonLine(line.trim());
    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'transcript') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) return;
      this.emit(SPEECH_EVENT, {
        type: 'transcript',
        provider: 'macos',
        text,
        isFinal: payload.isFinal === true,
        ...(typeof payload.finalReason === 'string' ? { finalReason: payload.finalReason } : {}),
      });
      return;
    }

    if (payload.type === 'level') {
      const level = Number(payload.level);
      if (!Number.isFinite(level)) return;
      this.emit(SPEECH_EVENT, {
        type: 'level',
        provider: 'macos',
        level: Math.max(0, Math.min(1, level)),
      });
      return;
    }

    if (payload.type === 'error') {
      this.emit(SPEECH_EVENT, {
        type: 'error',
        provider: 'macos',
        code: typeof payload.code === 'string' ? payload.code : 'recognition_failed',
        message: typeof payload.message === 'string' ? payload.message : 'macOS speech recognition failed',
      });
      return;
    }

    if (payload.type === 'started' || payload.type === 'stopped') {
      this.emit(SPEECH_EVENT, { ...payload, provider: 'macos' });
    }
  }

  #unavailable(reason) {
    return {
      available: false,
      platform: process.platform,
      reason,
      locale: null,
      speechAuthorization: 'unknown',
      microphoneAuthorization: 'unknown',
      supportsOnDeviceRecognition: false,
    };
  }

  #requestGracefulStop(child) {
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writable === false) {
      return false;
    }

    try {
      stdin.write(HELPER_STOP_COMMAND);
      stdin.end();
      return true;
    } catch {
      return false;
    }
  }

  #scheduleStopFallback(child) {
    this.#clearStopTimers(child);

    const sigtermTimer = setTimeout(() => {
      if (!this.#isChildAlive(child)) return;
      this.#sendSignal(child, 'SIGTERM');

      const sigkillTimer = setTimeout(() => {
        if (this.#isChildAlive(child)) {
          this.#sendSignal(child, 'SIGKILL');
        }
      }, FORCE_STOP_TIMEOUT_MS);
      sigkillTimer.unref?.();

      const timers = this.stopTimers.get(child);
      if (timers) {
        timers.sigkillTimer = sigkillTimer;
      }
    }, GRACEFUL_STOP_TIMEOUT_MS);
    sigtermTimer.unref?.();

    this.stopTimers.set(child, { sigtermTimer, sigkillTimer: null });
  }

  #clearStopTimers(child) {
    const timers = this.stopTimers.get(child);
    if (!timers) return;
    clearTimeout(timers.sigtermTimer);
    if (timers.sigkillTimer) {
      clearTimeout(timers.sigkillTimer);
    }
    this.stopTimers.delete(child);
  }

  #isChildAlive(child) {
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  #sendSignal(child, signal) {
    try {
      child.kill(signal);
    } catch {
    }
  }
}
