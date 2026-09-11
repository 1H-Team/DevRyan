const SAFE_OPERATION = /^(GET|HEAD|POST|PATCH|PUT|DELETE) (rest|rpc|auth|storage)\/[a-z][a-z0-9_/-]{0,95}$/;

// Deliberately excludes URL parameters, object paths, identities and payloads.
export function createSupabaseTraffic({ now = Date.now } = {}) {
  const startedAt = new Date(now()).toISOString();
  const operations = new Map();
  const entry = (operation) => {
    const key = SAFE_OPERATION.test(operation) ? operation : 'other';
    const boundedKey = operations.has(key) || operations.size < 128 ? key : 'other';
    if (!operations.has(boundedKey)) operations.set(boundedKey, {
      operation: boundedKey, requests: 0, responseBytes: 0, avoidedRequests: 0,
      blockedRequests: 0, failures: 0, lastStatus: null, statuses: {},
    });
    return operations.get(boundedKey);
  };
  return Object.freeze({
    requested(operation) { entry(operation).requests += 1; },
    received(operation, bytes, status) {
      const row = entry(operation);
      row.responseBytes += Math.max(0, Number(bytes) || 0);
      const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
      row.lastStatus = code;
      row.statuses[code] = (row.statuses[code] || 0) + 1;
      if (status >= 400 || status === 0) row.failures += 1;
    },
    avoided(operation, count = 1) { entry(operation).avoidedRequests += count; },
    blocked(operation) { entry(operation).blockedRequests += 1; },
    snapshot() {
      const rows = [...operations.values()].map((row) => ({ ...row, statuses: { ...row.statuses } }))
        .sort((a, b) => b.responseBytes - a.responseBytes || a.operation.localeCompare(b.operation));
      return {
        startedAt,
        measurement: 'decoded-response-body-estimate',
        requests: rows.reduce((sum, row) => sum + row.requests, 0),
        responseBytes: rows.reduce((sum, row) => sum + row.responseBytes, 0),
        avoidedRequests: rows.reduce((sum, row) => sum + row.avoidedRequests, 0),
        blockedRequests: rows.reduce((sum, row) => sum + row.blockedRequests, 0),
        operations: rows,
      };
    },
  });
}

export function supabaseTrafficOperation(pathname, method) {
  const parts = pathname.split('?')[0].split('/');
  if (parts[1] === 'rest' && parts[2] === 'v1') {
    return `${method} ${parts[3] === 'rpc' ? `rpc/${parts[4]}` : `rest/${parts[3]}`}`;
  }
  if (parts[1] === 'storage') return `${method} storage/object`;
  if (parts[1] === 'auth') {
    // Admin user URLs end in a private user ID; aggregate them together.
    const route = parts[3] === 'admin' ? `admin/${parts[4]}` : parts[3];
    return `${method} auth/${route}`;
  }
  return 'other';
}
