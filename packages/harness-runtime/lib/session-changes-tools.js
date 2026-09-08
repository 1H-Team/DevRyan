// Capture and history use the same classification. Only known tool identities
// are aliases; arbitrary MCP suffixes must never inherit native-tool authority.
export const SESSION_CHANGE_READ_ONLY_TOOLS = Object.freeze([
  'read', 'oc_read', 'glob', 'oc_glob', 'grep', 'oc_grep', 'list', 'ls', 'oc_ls', 'stat', 'oc_stat',
  'webfetch', 'websearch', 'todowrite', 'todoread', 'question', 'skill',
  'task', 'devryan_task', 'council_session', 'ctx_search', 'ctx_stats',
]);
const READ_ONLY = new Set(SESSION_CHANGE_READ_ONLY_TOOLS);
const FILE_TOOLS = new Set(['edit', 'write', 'apply_patch', 'multiedit', 'create', 'file_write', 'str_replace', 'str_replace_based_edit_tool']);
const ALIASES = new Map([
  ['multi_edit', 'multiedit'], ['oc_edit', 'edit'], ['oc_write', 'write'], ['oc_apply_patch', 'apply_patch'], ['oc_multiedit', 'multiedit'],
  ['edit_file', 'edit'], ['file_edit', 'edit'], ['write_file', 'write'], ['create_file', 'create'],
  ['applypatch', 'apply_patch'], ['patch', 'apply_patch'], ['apply_diff', 'apply_patch'], ['file_patch', 'apply_patch'],
]);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0 ? value : null;

export function normalizeSessionChangeTool(value) {
  if (typeof value !== 'string') return '';
  const name = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase().replace(/_?tool_?call$/, '');
  return ALIASES.get(name) ?? name;
}

export function classifySessionChangeTool(value) {
  const name = normalizeSessionChangeTool(value);
  if (READ_ONLY.has(name)) return 'read-only';
  return FILE_TOOLS.has(name) ? 'file' : 'execution';
}

export const isSyntheticSessionChange = (part) => part?.state?.metadata?.syntheticWorkspacePatch === true
  || part?.metadata?.syntheticWorkspacePatch === true;

const filePath = (value) => object(value) ? text(value.filePath) ?? text(value.file_path) ?? text(value.path)
  ?? text(value.file) ?? text(value.relativePath) : null;

export function sessionChangeCapturePaths(part) {
  if (classifySessionChangeTool(part?.tool) !== 'file') return null;
  const input = part.state?.input ?? part.input;
  const file = filePath(input);
  // A declared target narrows observation cost, but is not an edit receipt.
  if (file && !['apply_patch', 'multiedit'].includes(normalizeSessionChangeTool(part.tool))) return [file];
  if (normalizeSessionChangeTool(part.tool) === 'multiedit' && file) return [file];
  return null;
}

const patchPath = (header) => {
  let value = header.slice(4).split('\t')[0];
  if (value.startsWith('"')) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (value === '/dev/null') return null;
  return value.replace(/^[ab]\//, '');
};

/** Validate hunk lengths and count actual changed lines, never patch headers.
 * Patch-only receipts remain review segments; they do not invent whole files. */
export function sessionChangePatchFiles(patch, fallbackPath = null) {
  if (typeof patch !== 'string' || !patch) return [];
  const lines = patch.split('\n');
  const files = [];
  let current = null, oldRemaining = 0, newRemaining = 0, inHunk = false;
  const flush = () => {
    if (!current) return true;
    if (oldRemaining || newRemaining || !current.hunks || !current.path) return false;
    files.push({ path: current.path, oldPath: current.oldPath && current.oldPath !== current.path ? current.oldPath : null,
      status: !current.oldPath ? 'added' : current.deleted ? 'deleted' : current.oldPath !== current.path ? 'renamed' : 'modified',
      patch: current.lines.join('\n') + '\n', additions: current.additions, deletions: current.deletions });
    return true;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inHunk && (oldRemaining || newRemaining)) {
      if (line.startsWith(' ')) { oldRemaining--; newRemaining--; }
      else if (line.startsWith('-')) { oldRemaining--; current.deletions++; }
      else if (line.startsWith('+')) { newRemaining--; current.additions++; }
      else if (line !== '\\ No newline at end of file') return [];
      if (oldRemaining < 0 || newRemaining < 0) return [];
      current.lines.push(line); continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      if (!flush()) return [];
      const oldPath = patchPath(line), nextLine = lines[++i], nextPath = patchPath(nextLine);
      if ((!oldPath && line.slice(4) !== '/dev/null') || (!nextPath && nextLine.slice(4) !== '/dev/null')) return [];
      current = { path: nextPath ?? oldPath, oldPath, deleted: nextPath === null,
        lines: [line, nextLine], hunks: 0, additions: 0, deletions: 0 };
      inHunk = false; continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (hunk) {
      if (!current && fallbackPath) current = { path: fallbackPath, oldPath: fallbackPath, deleted: false,
        lines: [], hunks: 0, additions: 0, deletions: 0 };
      if (!current) return [];
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      if (![Number(hunk[1]), Number(hunk[3]), oldRemaining, newRemaining].every(Number.isSafeInteger)) return [];
      current.hunks++; current.lines.push(line); inHunk = true; continue;
    }
    if (line === '\\ No newline at end of file' && current && inHunk) { current.lines.push(line); continue; }
    // A truncated or unexpected line inside a patch cannot establish receipt fidelity.
    if (line && !line.startsWith('diff --git ') && !line.startsWith('index ') && !line.startsWith('Index: ')
      && !/^=+$/.test(line) && !/^(?:new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to) /.test(line)) return [];
  }
  return flush() ? files : [];
}

/** Read only canonical tool result metadata, never requested patch input,
 * prose output, or a synthesized workspace diff. Identity is verified by host. */
export function sessionChangeReceipt(part) {
  if (isSyntheticSessionChange(part) || classifySessionChangeTool(part?.tool) !== 'file'
    || !['completed', 'error'].includes(part.state?.status)) return null;
  const metadata = part.state.metadata;
  if (!object(metadata)) return null;
  const fallback = filePath(part.state.input ?? part.input);
  const diffs = object(metadata.filediff) ? [metadata.filediff] : Array.isArray(metadata.files) ? metadata.files
    : Array.isArray(metadata.results) ? metadata.results.map(result => object(result) ? result.filediff : null) : [];
  const files = [];
  for (const diff of diffs) {
    if (!object(diff)) return null;
    const file = filePath(diff) ?? (diffs.length === 1 ? fallback : null);
    if (!file) return null;
    if ((typeof diff.before === 'string' || diff.before === null) && (typeof diff.after === 'string' || diff.after === null)) {
      const moved = text(diff.movePath);
      files.push({ path: moved ?? file, oldPath: moved && moved !== file ? file : null,
        before: metadata.exists === false || diff.type === 'added' ? null : diff.before,
        after: diff.type === 'deleted' ? null : diff.after });
    } else {
      const patches = sessionChangePatchFiles(diff.patch ?? diff.diff, file);
      if (!patches.length) return null;
      files.push(...patches);
    }
  }
  if (!files.length) files.push(...sessionChangePatchFiles(metadata.diff, fallback));
  // MultiEdit can report successive full-file results under one canonical call.
  // Fold only byte-contiguous results; interrupted or ambiguous results cannot
  // masquerade as one complete execution receipt.
  const merged = new Map();
  for (const file of files) {
    const previous = merged.get(file.path);
    if (!previous) { merged.set(file.path, file); continue; }
    if (previous.patch || file.patch || previous.oldPath || file.oldPath || previous.after !== file.before) return null;
    merged.set(file.path, { ...previous, after: file.after });
  }
  return merged.size ? { files: [...merged.values()], complete: part.state.status === 'completed', tool: normalizeSessionChangeTool(part.tool) } : null;
}
