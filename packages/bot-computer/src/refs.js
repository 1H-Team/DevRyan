import crypto from 'node:crypto';

const MAX_NODES = 5_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_PAGE_BYTES = 96 * 1024;
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
    ...((node.textTruncated === true || node.name?.length > 2_048 || node.value?.length > 4_096)
      ? { textTruncated: true } : {}),
  });
};

export function createAccessibilityRefStore({ randomBytes = crypto.randomBytes } = {}) {
  let generation = 0;
  const refs = new Map();
  let captured = null;
  let snapshotSequence = 0;

  const beginPage = () => {
    generation += 1;
    refs.clear();
    captured = null;
    return generation;
  };

  const recordSnapshot = (nodes) => {
    if (!Array.isArray(nodes) || nodes.length > MAX_NODES) {
      fail('Accessibility snapshot is too large', 'DEVRYAN_BOT_SNAPSHOT_INVALID');
    }
    if (generation === 0) beginPage();
    captured = null;
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

  const pageSnapshot = ({ snapshotId, offset = 0 } = {}) => {
    if (!captured || snapshotId !== captured.snapshotId) {
      fail('Snapshot expired; take a new snapshot with empty args', 'DEVRYAN_BOT_SNAPSHOT_STALE');
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > captured.nodes.length) {
      fail('Snapshot offset is invalid', 'DEVRYAN_BOT_SNAPSHOT_INVALID');
    }
    const nodes = [];
    let bytes = 0;
    for (let index = offset; index < captured.nodes.length; index += 1) {
      const node = captured.nodes[index];
      const size = Buffer.byteLength(JSON.stringify(node), 'utf8') + 1;
      if (bytes + size > SNAPSHOT_PAGE_BYTES) break;
      nodes.push(node);
      bytes += size;
    }
    const nextOffset = offset + nodes.length;
    const hasMore = nextOffset < captured.nodes.length;
    return Object.freeze({
      nodes: Object.freeze(nodes), generation, count: nodes.length,
      snapshotId, offset, totalNodes: captured.totalNodes,
      omittedNodes: captured.totalNodes - captured.nodes.length,
      nextOffset: hasMore ? nextOffset : null,
      ...(hasMore ? { continuation: 'Call snapshot with args { snapshotId, offset: nextOffset } to read the next page. Refs from all pages remain valid until a new snapshot or navigation.' } : {}),
    });
  };

  const captureSnapshot = (nodes) => {
    if (!Array.isArray(nodes)) fail('Snapshot is invalid', 'DEVRYAN_BOT_SNAPSHOT_INVALID');
    const bounded = [];
    let bytes = 0;
    for (const raw of nodes) {
      const node = sanitizeNode(raw);
      bytes += Buffer.byteLength(JSON.stringify(node), 'utf8') + 128;
      if (bounded.length >= MAX_NODES || bytes > MAX_SNAPSHOT_BYTES) break;
      bounded.push(node);
    }
    const publicNodes = recordSnapshot(bounded);
    captured = {
      snapshotId: `snapshot_${generation}_${++snapshotSequence}`,
      nodes: publicNodes, totalNodes: nodes.length,
    };
    return pageSnapshot({ snapshotId: captured.snapshotId });
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
    captureSnapshot,
    pageSnapshot,
    resolve,
    snapshot: () => Object.freeze({ generation, count: refs.size }),
  });
}
