export const CURSOR_SDK_MIN_NODE_VERSION = '22.13.0';

const parseVersion = (value) => {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map((entry) => Number.parseInt(entry, 10));
};

export const isCursorSdkNodeVersionSupported = (value) => {
  const current = parseVersion(value);
  const minimum = parseVersion(CURSOR_SDK_MIN_NODE_VERSION);
  if (!current || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
};

export const assertCursorSdkNodeCompatibility = (value = process.versions?.node) => {
  if (isCursorSdkNodeVersionSupported(value)) return;
  const detected = String(value ?? '').trim() || 'unknown';
  const error = new Error(
    `Cursor SDK requires Node.js ${CURSOR_SDK_MIN_NODE_VERSION} or newer; detected ${detected}.`,
  );
  error.code = 'CURSOR_SDK_NODE_UNSUPPORTED';
  throw error;
};
