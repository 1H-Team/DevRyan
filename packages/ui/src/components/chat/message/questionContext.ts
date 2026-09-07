import type { Part } from '@opencode-ai/sdk/v2';

/** Only the canonical tool identifies a question; status/finish may not have arrived yet. */
export const hasQuestionTool = (parts: readonly Part[]): boolean => (
  parts.some((part) => part.type === 'tool' && part.tool === 'question')
);
