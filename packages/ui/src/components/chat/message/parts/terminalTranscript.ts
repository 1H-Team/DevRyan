export const TERMINAL_TRANSCRIPT_TRUNCATION_MARKER = '[... earlier terminal output truncated ...]';

export interface TerminalTranscriptLimits {
  rawTailBytes?: number;
  renderedBytes?: number;
  renderedLines?: number;
  tabWidth?: number;
}

export interface TerminalTranscriptSnapshot {
  text: string;
  truncated: boolean;
  rawLength: number;
  renderedBytes: number;
  renderedLines: number;
}

export interface TerminalTranscriptParser {
  update(rawOutput: string): TerminalTranscriptSnapshot;
  reset(): void;
}

const DEFAULT_LIMITS = Object.freeze({
  rawTailBytes: 1024 * 1024,
  renderedBytes: 256 * 1024,
  renderedLines: 5_000,
  tabWidth: 8,
});

const utf8Encoder = new TextEncoder();
const utf8ByteLength = (value: string) => utf8Encoder.encode(value).byteLength;

type ParserMode = 'text' | 'escape' | 'csi' | 'csiDiscard' | 'osc' | 'oscEscape';

type DisplayState = {
  lines: string[][];
  row: number;
  column: number;
  savedRow: number;
  savedColumn: number;
  mode: ParserMode;
  csi: string;
  oscLength: number;
  truncated: boolean;
};

const positiveInteger = (value: number | undefined, fallback: number) => (
  Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback
);

const resolveLimits = (limits: TerminalTranscriptLimits) => ({
  rawTailBytes: positiveInteger(limits.rawTailBytes, DEFAULT_LIMITS.rawTailBytes),
  renderedBytes: positiveInteger(limits.renderedBytes, DEFAULT_LIMITS.renderedBytes),
  renderedLines: positiveInteger(limits.renderedLines, DEFAULT_LIMITS.renderedLines),
  tabWidth: positiveInteger(limits.tabWidth, DEFAULT_LIMITS.tabWidth),
});

const createDisplayState = (): DisplayState => ({
  lines: [[]],
  row: 0,
  column: 0,
  savedRow: 0,
  savedColumn: 0,
  mode: 'text',
  csi: '',
  oscLength: 0,
  truncated: false,
});

const ensureRow = (state: DisplayState, row = state.row) => {
  while (state.lines.length <= row) state.lines.push([]);
};

const writeCharacter = (state: DisplayState, value: string) => {
  ensureRow(state);
  const line = state.lines[state.row];
  while (line.length < state.column) line.push(' ');
  line[state.column] = value;
  state.column += 1;
};

const parseCsiNumber = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const eraseLine = (state: DisplayState, mode: number) => {
  ensureRow(state);
  const line = state.lines[state.row];
  if (mode === 2) {
    state.lines[state.row] = [];
    return;
  }
  if (mode === 1) {
    while (line.length <= state.column) line.push(' ');
    for (let index = 0; index <= state.column; index += 1) line[index] = ' ';
    return;
  }
  line.splice(state.column);
};

const eraseDisplay = (state: DisplayState, mode: number) => {
  ensureRow(state);
  if (mode === 2 || mode === 3) {
    state.lines = state.lines.map(() => []);
    ensureRow(state);
    return;
  }
  if (mode === 1) {
    for (let row = 0; row < state.row; row += 1) state.lines[row] = [];
    eraseLine(state, 1);
    return;
  }
  eraseLine(state, 0);
  state.lines.length = state.row + 1;
};

const applyCsi = (state: DisplayState, parameters: string, command: string) => {
  if (parameters.startsWith('?') && (command === 'h' || command === 'l')) return;
  if (command === 'm') return;

  const values = parameters.replace(/^[?>!]/, '').split(';');
  const first = parseCsiNumber(values[0], 1);

  switch (command) {
    case 'A':
      state.row = Math.max(0, state.row - Math.max(1, first));
      ensureRow(state);
      break;
    case 'B':
      state.row += Math.max(1, first);
      ensureRow(state);
      break;
    case 'C':
      state.column += Math.max(1, first);
      break;
    case 'D':
      state.column = Math.max(0, state.column - Math.max(1, first));
      break;
    case 'E':
      state.row += Math.max(1, first);
      state.column = 0;
      ensureRow(state);
      break;
    case 'F':
      state.row = Math.max(0, state.row - Math.max(1, first));
      state.column = 0;
      ensureRow(state);
      break;
    case 'G':
      state.column = Math.max(0, first - 1);
      break;
    case 'H':
    case 'f': {
      const targetRow = parseCsiNumber(values[0], 1);
      const targetColumn = parseCsiNumber(values[1], 1);
      state.row = Math.max(0, targetRow - 1);
      state.column = Math.max(0, targetColumn - 1);
      ensureRow(state);
      break;
    }
    case 'J':
      eraseDisplay(state, parseCsiNumber(values[0], 0));
      break;
    case 'K':
      eraseLine(state, parseCsiNumber(values[0], 0));
      break;
    case 's':
      state.savedRow = state.row;
      state.savedColumn = state.column;
      break;
    case 'u':
      state.row = Math.max(0, state.savedRow);
      state.column = Math.max(0, state.savedColumn);
      ensureRow(state);
      break;
    default:
      break;
  }
};

const consumeText = (state: DisplayState, chunk: string, tabWidth: number) => {
  for (const value of chunk) {
    if (state.mode === 'osc') {
      if (value === '\x07') {
        state.mode = 'text';
        state.oscLength = 0;
      } else if (value === '\x1b') {
        state.mode = 'oscEscape';
      } else {
        state.oscLength += 1;
        if (state.oscLength > 8_192) {
          state.mode = 'text';
          state.oscLength = 0;
        }
      }
      continue;
    }

    if (state.mode === 'oscEscape') {
      if (value === '\\' || value === '\x07') {
        state.mode = 'text';
        state.oscLength = 0;
      } else if (value !== '\x1b') {
        state.mode = 'osc';
        state.oscLength += 1;
      }
      continue;
    }

    if (state.mode === 'csiDiscard') {
      const code = value.codePointAt(0) ?? 0;
      if (code >= 0x40 && code <= 0x7e) state.mode = 'text';
      continue;
    }

    if (state.mode === 'csi') {
      const code = value.codePointAt(0) ?? 0;
      if (code >= 0x40 && code <= 0x7e) {
        applyCsi(state, state.csi, value);
        state.csi = '';
        state.mode = 'text';
      } else if (code >= 0x20 && code <= 0x3f) {
        if (state.csi.length < 128) state.csi += value;
        else {
          state.csi = '';
          state.mode = 'csiDiscard';
        }
      } else {
        state.csi = '';
        state.mode = 'text';
      }
      continue;
    }

    if (state.mode === 'escape') {
      state.mode = 'text';
      if (value === '[') {
        state.mode = 'csi';
        state.csi = '';
      } else if (value === ']') {
        state.mode = 'osc';
        state.oscLength = 0;
      } else if (value === '7') {
        state.savedRow = state.row;
        state.savedColumn = state.column;
      } else if (value === '8') {
        state.row = Math.max(0, state.savedRow);
        state.column = Math.max(0, state.savedColumn);
        ensureRow(state);
      }
      continue;
    }

    if (value === '\x1b') {
      state.mode = 'escape';
    } else if (value === '\r') {
      ensureRow(state);
      state.lines[state.row] = [];
      state.column = 0;
    } else if (value === '\n') {
      state.row += 1;
      state.column = 0;
      ensureRow(state);
    } else if (value === '\b') {
      state.column = Math.max(0, state.column - 1);
    } else if (value === '\t') {
      const nextStop = (Math.floor(state.column / tabWidth) + 1) * tabWidth;
      while (state.column < nextStop) writeCharacter(state, ' ');
    } else {
      const code = value.codePointAt(0) ?? 0;
      if (code >= 0x20 && code !== 0x7f) writeCharacter(state, value);
    }
  }
};

const takeUtf8Tail = (value: string, maxBytes: number) => {
  // Bound reconciliation work even when the provider replaces output with a
  // very large string. UTF-8 uses at least one byte per UTF-16 code unit for
  // ASCII and more for non-ASCII, so the final maxBytes code units contain
  // every possible maxBytes-byte suffix we may retain.
  const candidateStart = Math.max(0, value.length - maxBytes);
  let candidate = value.slice(candidateStart);
  const firstCodeUnit = candidate.charCodeAt(0);
  if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) {
    candidate = candidate.slice(1);
  }
  if (utf8ByteLength(candidate) <= maxBytes) return candidate;
  const characters = Array.from(candidate);
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const nextBytes = utf8ByteLength(characters[start - 1]);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    start -= 1;
  }
  return characters.slice(start).join('');
};

const trimDisplay = (
  state: DisplayState,
  limits: ReturnType<typeof resolveLimits>,
) => {
  const markerBytes = utf8ByteLength(`${TERMINAL_TRANSCRIPT_TRUNCATION_MARKER}\n`);
  const markTruncated = () => {
    state.truncated = true;
  };
  const contentLineLimit = () => Math.max(1, limits.renderedLines - (state.truncated ? 1 : 0));

  if (state.lines.length > limits.renderedLines) markTruncated();
  while (state.lines.length > contentLineLimit()) {
    state.lines.shift();
    state.row = Math.max(0, state.row - 1);
    state.savedRow = Math.max(0, state.savedRow - 1);
  }

  const contentBudget = () => Math.max(0, limits.renderedBytes - (state.truncated ? markerBytes : 0));
  const lineBytes = () => state.lines.map((line, index) => (
    utf8ByteLength(line.join('')) + (index < state.lines.length - 1 ? 1 : 0)
  ));
  const sizes = lineBytes();
  let total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > limits.renderedBytes) {
    markTruncated();
    while (state.lines.length > 1 && total > contentBudget()) {
      total -= sizes.shift() ?? 0;
      state.lines.shift();
      state.row = Math.max(0, state.row - 1);
      state.savedRow = Math.max(0, state.savedRow - 1);
    }
  }

  if (state.lines.length === 1 && total > contentBudget()) {
    const original = state.lines[0];
    const tail = takeUtf8Tail(original.join(''), contentBudget());
    const next = Array.from(tail);
    const removed = Math.max(0, original.length - next.length);
    state.lines[0] = next;
    state.column = Math.max(0, state.column - removed);
    state.savedColumn = Math.max(0, state.savedColumn - removed);
  }

  while (state.lines.length > contentLineLimit()) {
    state.lines.shift();
    state.row = Math.max(0, state.row - 1);
    state.savedRow = Math.max(0, state.savedRow - 1);
  }
  ensureRow(state);
};

const renderSnapshot = (
  state: DisplayState,
  rawLength: number,
): TerminalTranscriptSnapshot => {
  const content = state.lines.map((line) => line.join('').replace(/ +$/u, '')).join('\n');
  const text = state.truncated
    ? `${TERMINAL_TRANSCRIPT_TRUNCATION_MARKER}\n${content}`
    : content;
  return {
    text,
    truncated: state.truncated,
    rawLength,
    renderedBytes: utf8ByteLength(text),
    renderedLines: text.length === 0 ? 1 : text.split('\n').length,
  };
};

export const createTerminalTranscriptParser = (
  limitOverrides: TerminalTranscriptLimits = {},
): TerminalTranscriptParser => {
  const limits = resolveLimits(limitOverrides);
  let state = createDisplayState();
  let rawLength = 0;
  let rawTail = '';
  let rawTailStart = 0;
  let snapshot = renderSnapshot(state, 0);

  const reset = () => {
    state = createDisplayState();
    rawLength = 0;
    rawTail = '';
    rawTailStart = 0;
    snapshot = renderSnapshot(state, 0);
  };

  return {
    reset,
    update(rawOutput) {
      const raw = typeof rawOutput === 'string' ? rawOutput : '';
      if (raw === '' && rawLength === 0) return snapshot;

      const isAppend = raw.length >= rawLength
        && raw.slice(rawTailStart, rawLength) === rawTail;
      if (!isAppend) reset();

      const suffix = raw.slice(rawLength);
      if (suffix.length > 0) {
        consumeText(state, suffix, limits.tabWidth);
        trimDisplay(state, limits);
      }

      rawLength = raw.length;
      rawTail = takeUtf8Tail(raw, limits.rawTailBytes);
      rawTailStart = raw.length - rawTail.length;
      snapshot = renderSnapshot(state, rawLength);
      return snapshot;
    },
  };
};
