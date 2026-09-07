import type { Part } from '@opencode-ai/sdk/v2';

type CopyTextPart = Part & {
  text?: string;
  content?: string;
  shellAction?: { output?: unknown; command?: unknown };
};

const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const joinText = (values: unknown[]): string => values.filter(nonblank).join('\n\n');

/** Clipboard-only: do not use this projection to extract or implement plans. */
export function getMessageCopyText(parts: readonly Part[], role: 'user' | 'assistant'): string {
  const texts = parts.filter((part): part is CopyTextPart => part.type === 'text');
  if (role === 'user') {
    const outputs = joinText(texts.map((part) => part.shellAction?.output));
    if (outputs) return outputs;
    const commands = joinText(texts.map((part) => part.shellAction?.command));
    if (commands) return commands;
  }
  return joinText(texts.map((part) => part.text || part.content || ''));
}
