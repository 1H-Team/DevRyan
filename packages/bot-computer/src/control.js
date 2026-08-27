import crypto from 'node:crypto';

const ACTOR_TYPES = new Set(['user', 'admin']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ComputerControlError extends Error {
  constructor(message, code, statusCode = 409) {
    super(message);
    this.name = 'ComputerControlError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new ComputerControlError(message, code, statusCode);
};

const validateActor = (actor) => {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)
    || Object.keys(actor).sort().join('\0') !== 'actorId\0actorType'
    || !ID_PATTERN.test(actor.actorId) || !ACTOR_TYPES.has(actor.actorType)) {
    fail('Control actor is invalid', 'DEVRYAN_BOT_CONTROL_ACTOR_INVALID', 400);
  }
  return Object.freeze({ actorId: actor.actorId, actorType: actor.actorType });
};

export function createControlLeaseManager({
  ttlMs = 30_000,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  onEvent = () => undefined,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000
    || typeof now !== 'function' || typeof randomBytes !== 'function' || typeof onEvent !== 'function') {
    fail('Control lease configuration is invalid', 'DEVRYAN_BOT_CONTROL_CONFIG_INVALID', 500);
  }
  let lease = null;
  const waiters = new Set();

  const notifyAgentWaiters = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  const expire = () => {
    if (lease && lease.expiresAt <= now()) {
      const expired = lease;
      lease = null;
      onEvent(Object.freeze({ type: 'expired', ...expired }));
      notifyAgentWaiters();
    }
  };

  const publicLease = () => {
    expire();
    return lease ? Object.freeze({ ...lease }) : null;
  };

  const take = (actorInput) => {
    const actor = validateActor(actorInput);
    expire();
    if (lease && (lease.actorId !== actor.actorId || lease.actorType !== actor.actorType)) {
      fail('Another person holds computer control', 'DEVRYAN_BOT_CONTROL_CONFLICT');
    }
    const timestamp = now();
    lease = Object.freeze({
      leaseId: lease?.leaseId || `control_${Buffer.from(randomBytes(18)).toString('base64url')}`,
      ...actor,
      takenAt: lease?.takenAt || timestamp,
      expiresAt: timestamp + ttlMs,
    });
    onEvent(Object.freeze({ type: 'taken', ...lease }));
    return lease;
  };

  const requireOwnedLease = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join('\0') !== 'actorId\0actorType\0leaseId') {
      fail('Control lease request is invalid', 'DEVRYAN_BOT_CONTROL_ACTOR_INVALID', 400);
    }
    const actor = validateActor({ actorId: input.actorId, actorType: input.actorType });
    expire();
    if (!lease || lease.leaseId !== input.leaseId
      || lease.actorId !== actor.actorId || lease.actorType !== actor.actorType) {
      fail('Control lease is not owned by this actor', 'DEVRYAN_BOT_CONTROL_NOT_OWNER');
    }
    return actor;
  };

  const heartbeat = (input) => {
    const actor = requireOwnedLease(input);
    lease = Object.freeze({ ...lease, ...actor, expiresAt: now() + ttlMs });
    onEvent(Object.freeze({ type: 'heartbeat', ...lease }));
    return lease;
  };

  const returnControl = (input) => {
    requireOwnedLease(input);
    const returned = lease;
    lease = null;
    onEvent(Object.freeze({ type: 'returned', ...returned, returnedAt: now() }));
    notifyAgentWaiters();
    return Object.freeze({ returned: true });
  };

  const waitForAgent = ({ signal, timeoutMs = 120_000 } = {}) => {
    expire();
    if (!lease) return Promise.resolve();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      fail('Agent wait timeout is invalid', 'DEVRYAN_BOT_CONTROL_WAIT_INVALID', 400);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        waiters.delete(onRelease);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onRelease = () => finish();
      const onAbort = () => finish(new ComputerControlError(
        'Agent command was aborted while human control was active',
        'DEVRYAN_BOT_COMMAND_ABORTED',
        499,
      ));
      const timer = setTimeout(() => {
        expire();
        if (!lease) finish();
        else finish(new ComputerControlError(
          'Agent command remained paused while human control was active',
          'DEVRYAN_BOT_CONTROL_HELD',
        ));
      }, Math.min(timeoutMs, Math.max(1, lease.expiresAt - now())));
      waiters.add(onRelease);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };

  return Object.freeze({
    take,
    heartbeat,
    returnControl,
    waitForAgent,
    assertOwner: (input) => Object.freeze({ ...lease, ...requireOwnedLease(input) }),
    snapshot: publicLease,
  });
}
