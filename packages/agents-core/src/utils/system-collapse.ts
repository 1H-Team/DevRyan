/**
 * Collapse a system message array into a single element by joining all
 * entries with double-newline separators. Mutates the array in-place so
 * that callers holding a reference to the original array see the change.
 */
export function collapseSystemInPlace(system: string[]): void {
  if (system.length === 0) {
    return;
  }

  if (system.length === 1) {
    if (system[0]) {
      return;
    }
    system.length = 0;
    return;
  }

  const joined = system.join('\n\n');
  system.length = 0;
  if (joined) {
    system.push(joined);
  }
}

/** Prompt-cache marker on a native system part (OpenCode `CacheHint`). */
export interface SystemCacheMarker {
  readonly type: string;
  readonly ttlSeconds?: number;
}

/** Native v2 `SystemPart` fields the collapse reads and carries. */
export interface CollapsibleSystemPart {
  type: 'text';
  text: string;
  cache?: SystemCacheMarker;
  metadata?: Record<string, unknown>;
}

function sameCacheMarker(
  left: SystemCacheMarker | undefined,
  right: SystemCacheMarker | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.type === right.type && left.ttlSeconds === right.ttlSeconds;
}

/**
 * Cache-preserving form of `collapseSystemInPlace` for native system parts.
 * Only neighbouring parts with the same cache marker are joined, so a
 * cache-marked part is never folded into a volatile one and each breakpoint
 * keeps its exact prefix. A joined run keeps its marker (the first part's
 * instance) and the shallow merge of its parts' metadata, later parts
 * winning. A run whose joined text is empty is dropped. With no markers this
 * yields exactly what `collapseSystemInPlace` yields for the texts. Mutates
 * the array in place.
 */
export function collapseSystemPartsInPlace<P extends CollapsibleSystemPart>(
  parts: P[],
): void {
  const collapsed: P[] = [];
  let start = 0;
  while (start < parts.length) {
    const first = parts[start];
    let end = start + 1;
    while (
      end < parts.length &&
      sameCacheMarker(first.cache, parts[end].cache)
    ) {
      end++;
    }
    const run = parts.slice(start, end);
    start = end;
    const text = run.map((part) => part.text).join('\n\n');
    if (!text) {
      continue;
    }
    if (run.length === 1) {
      collapsed.push(first);
      continue;
    }
    let metadata: Record<string, unknown> | undefined;
    for (const part of run) {
      if (part.metadata) {
        metadata = { ...metadata, ...part.metadata };
      }
    }
    collapsed.push({ ...first, text, ...(metadata ? { metadata } : {}) });
  }
  parts.splice(0, parts.length, ...collapsed);
}

/**
 * Heuristic for v1 hosts, where the system transform only receives the
 * sessionID: the session's tracked agent says "orchestrator" but auxiliary
 * LLM requests (title generation, compaction) run in the SAME session
 * under their own agent. Those requests are built with `system: []` and
 * never include the core's environment block, while every main chat
 * request does (the core prepends it to the request system). Structured
 * signal, not message text. Degradation if upstream renames both
 * markers: main-chat requests stop matching and the fallback stops
 * injecting there (missing serve-mode prompt) — auxiliaries were never
 * injected, so they cannot regress. A custom auxiliary prompt
 * CONTAINING these strings would false-positive; accepted as bounded
 * compatibility with this core.
 */
export function looksLikeMainChatRequest(system: string[]): boolean {
  return system.some(
    (entry) =>
      typeof entry === 'string' &&
      (entry.includes('<env>') || entry.includes('You are powered by')),
  );
}
