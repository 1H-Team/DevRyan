import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ALLOWED_STATES = new Set([
  'enabled',
  'requires_approval',
  'not_registered',
  'not_found',
  'unknown',
]);
const ALLOWED_CODES = new Set([
  null,
  'smappservice_unavailable',
  'smappservice_registration_failed',
  'smappservice_unregistration_failed',
]);

const validateResult = (value) => {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.ok !== 'boolean'
    || !ALLOWED_STATES.has(value.state)
    || !ALLOWED_CODES.has(value.code ?? null)) {
    const error = new Error('Background runtime native bridge returned an invalid result');
    error.code = 'runtime_service_native_bridge_invalid';
    throw error;
  }
  return Object.freeze({ ok: value.ok, state: value.state, code: value.code ?? null });
};

export const createRuntimeServiceNativeControl = ({
  resourcesPath,
  platform = process.platform,
  load = require,
  exists = fs.existsSync,
} = {}) => {
  if (platform !== 'darwin') return null;
  const modulePath = typeof resourcesPath === 'string' && path.isAbsolute(resourcesPath)
    ? path.join(resourcesPath, 'native', 'DevRyanRuntimeServiceControl.node')
    : '';
  if (!modulePath || !exists(modulePath)) {
    const error = new Error('This DevRyan build is missing the background runtime native bridge');
    error.code = 'runtime_service_native_bridge_missing';
    throw error;
  }

  let binding;
  try {
    binding = load(modulePath);
  } catch {
    const error = new Error('The background runtime native bridge could not be loaded');
    error.code = 'runtime_service_native_bridge_load_failed';
    throw error;
  }
  if (!binding
    || typeof binding.status !== 'function'
    || typeof binding.register !== 'function'
    || typeof binding.unregister !== 'function') {
    const error = new Error('The background runtime native bridge is invalid');
    error.code = 'runtime_service_native_bridge_invalid';
    throw error;
  }

  return Object.freeze({
    status: async () => validateResult(binding.status()),
    register: async () => validateResult(binding.register()),
    unregister: async () => validateResult(binding.unregister()),
    modulePath,
  });
};
