export const TOOL_DIFF_PREVIEW_MAX_CHARS = 262_144;
export const TOOL_DIFF_PREVIEW_MAX_LINES = 2_000;

const previewEnd = (source: string): number | null => {
  const end = Math.min(source.length, TOOL_DIFF_PREVIEW_MAX_CHARS);
  let lines = 1;
  for (let index = 0; index < end; index += 1) {
    const unit = source.charCodeAt(index);
    if (unit !== 10 && unit !== 13) continue;
    const separator = unit === 13 && source.charCodeAt(index + 1) === 10 ? 2 : 1;
    if (index + separator < source.length && ++lines > TOOL_DIFF_PREVIEW_MAX_LINES) return index;
    if (separator === 2) index += 1;
  }
  if (end === source.length) return null;
  const last = source.charCodeAt(end - 1);
  const next = source.charCodeAt(end);
  // Do not split either a surrogate pair or a CRLF separator at the character limit.
  if ((last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) || (last === 13 && next === 10)) return end - 1;
  return end;
};

export const isToolDiffPreviewOversized = (source: string): boolean => previewEnd(source) !== null;

export const getToolDiffPreview = (source: string): { text: string; truncated: boolean } => {
  const end = previewEnd(source);
  return end === null ? { text: source, truncated: false } : { text: source.slice(0, end), truncated: true };
};

export const getPatchText = (value: unknown): string | undefined => {
  const source = typeof value === 'string' ? value
    : value && typeof value === 'object' && 'patch' in value && typeof value.patch === 'string' ? value.patch : undefined;
  if (source === undefined) return undefined;
  // Preserve raw source for download and avoid scanning an oversized string just to trim it.
  return isToolDiffPreviewOversized(source) || source.trim().length > 0 ? source : undefined;
};

export const buildWritePreviewPatch = (filePath: string | undefined, content: string): string => {
  const normalized = content.replace(/\r\n/g, '\n');
  const candidate = filePath?.trim() || 'new-file';
  const path = candidate.startsWith('/') ? candidate.slice(1) : candidate;
  const lines = normalized.split('\n');
  return ['--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, lines.map((line) => `+${line}`).join('\n')].join('\n');
};

export type WriteDiffPreview = { patch: string; truncated: boolean; getFullPatch: () => string };

export const getWriteDiffPreview = (filePath: string | undefined, content: string): WriteDiffPreview => {
  const sourcePreview = getToolDiffPreview(content);
  const getFullPatch = () => buildWritePreviewPatch(filePath, content);
  if (sourcePreview.truncated) return { patch: sourcePreview.text, truncated: true, getFullPatch };
  const patch = getFullPatch();
  const preview = getToolDiffPreview(patch);
  return { patch: preview.text, truncated: preview.truncated, getFullPatch: () => patch };
};
