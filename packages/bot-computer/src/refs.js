import crypto from 'node:crypto';

const MAX_NODES = 5_000;
const REF_PATTERN = /^ref_(\d+)_([a-f0-9]{16})$/;

export class ComputerRefError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ComputerRefError';
    this.code = code;
    this.statusCode = 409;
  }
}

const fail = (message, code) => {
  throw new ComputerRefError(message, code);
};

const sanitizeNode = (node) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)
    || !Number.isInteger(node.backendNodeId) || node.backendNodeId < 1) {
    fail('Accessibility node is invalid', 'DEVRYAN_BOT_SNAPSHOT_INVALID');
  }
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  return Object.freeze({
    backendNodeId: node.backendNodeId,
    role: text(node.role, 128),
    name: text(node.name, 2_048),
    value: text(node.value, 4_096),
    disabled: node.disabled === true,
    focused: node.focused === true,
  });
};

export function createAccessibilityRefStore({ randomBytes = crypto.randomBytes } = {}) {
  let generation = 0;
  const refs = new Map();

  const beginPage = () => {
    generation += 1;
    refs.clear();
    return generation;
  };

  const recordSnapshot = (nodes) => {
    if (!Array.isArray(nodes) || nodes.length > MAX_NODES) {
      fail('Accessibility snapshot is too large', 'DEVRYAN_BOT_SNAPSHOT_INVALID');
    }
    if (generation === 0) beginPage();
    refs.clear();
    return Object.freeze(nodes.map((raw) => {
      const node = sanitizeNode(raw);
      let ref;
      do {
        ref = `ref_${generation}_${Buffer.from(randomBytes(8)).toString('hex')}`;
      } while (refs.has(ref));
      refs.set(ref, node);
      const { backendNodeId: _privateNodeId, ...publicNode } = node;
      return Object.freeze({ ref, ...publicNode });
    }));
  };

  const resolve = (ref) => {
    const match = typeof ref === 'string' ? REF_PATTERN.exec(ref) : null;
    if (!match) fail('Accessibility ref is invalid', 'DEVRYAN_BOT_REF_INVALID');
    if (Number(match[1]) !== generation) {
      fail('Accessibility ref belongs to an older page generation', 'DEVRYAN_BOT_REF_STALE');
    }
    const node = refs.get(ref);
    if (!node) fail('Accessibility ref is unknown', 'DEVRYAN_BOT_REF_UNKNOWN');
    return node;
  };

  return Object.freeze({
    beginPage,
    recordSnapshot,
    resolve,
    snapshot: () => Object.freeze({ generation, count: refs.size }),
  });
}
