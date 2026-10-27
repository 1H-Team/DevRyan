import path from 'node:path';

// New daemons write only DevRyan names. An older daemon keeps owning its
// original records until it stops; renaming a live record would race cleanup.
export function daemonRecordPaths(directory, port) {
  return ['devryan', 'openchamber'].map(prefix => ({
    pid: path.join(directory, `${prefix}-${port}.pid`),
    instance: path.join(directory, `${prefix}-${port}.json`),
  }));
}

export function daemonRecordPort(filename) {
  const match = /^(?:devryan|openchamber)-(\d+)\.pid$/.exec(filename);
  const port = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function daemonLogPath(directory, port, { recordPath, exists = () => false } = {}) {
  const canonical = path.join(directory, `devryan-${port}.log`);
  const legacy = path.join(directory, `openchamber-${port}.log`);
  if (recordPath && path.basename(recordPath).startsWith('openchamber-') && exists(legacy)) return legacy;
  return exists(canonical) || !exists(legacy) ? canonical : legacy;
}
