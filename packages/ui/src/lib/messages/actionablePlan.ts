import type { Message, Part } from '@opencode-ai/sdk/v2/client';

type TextLikePart = Part & { text?: string; content?: string; value?: string; synthetic?: boolean };
type MessageWithPlanModeMetadata = Message & {
  mode?: unknown;
  metadata?: { openchamberPlanMode?: unknown };
};

export const PLAN_MODE_INSTRUCTION_PREFIX = 'User has requested to enter plan mode';
export const PLAN_IMPLEMENTATION_REQUEST_PREFIX = '[openchamber-plan-action:v1] ';

export type PlanImplementationRequest = {
  action: 'implement';
  sourceSessionId: string;
  sourceMessageId: string;
  planIndex: number;
};

const PLAN_MODE_SECTION_HEADINGS = new Set([
  'context',
  'critical files',
  'implementation',
  'visual details',
  'verification',
]);

const MARKDOWN_HEADING_LINE = /^\s{0,3}(#{1,2})\s+(.+?)\s*$/;

/**
 * Sentinel the agent must emit on its own line immediately before the final
 * structured plan output. The chat UI uses this marker to know when to mount
 * the plan card (so preamble/reasoning text before the marker streams in the
 * normal chat flow). The marker is an HTML comment so the markdown renderer
 * drops it from the visible output even if it is left in the text.
 */
export const PLAN_CARD_SENTINEL = '<!--plan-->';

/**
 * Returns the index of the sentinel in the given text, or -1 if absent.
 * Tolerates surrounding whitespace on either side of the marker.
 */
export const findPlanCardSentinel = (text: string): number => {
  if (typeof text !== 'string' || text.length === 0) return -1;
  return text.indexOf(PLAN_CARD_SENTINEL);
};

/**
 * Strips the sentinel (and the surrounding blank line, if present) from a
 * piece of plan text so it doesn't leak into the implement-prompt body or
 * the rendered markdown.
 */
export const stripPlanCardSentinel = (text: string): string => {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(new RegExp(`\\s*${PLAN_CARD_SENTINEL}\\s*`), '\n');
};

export type PlanCardSource = 'sentinel' | 'structured' | 'reasoning';

export type PlanCardSentinelSplit = {
  preambleText: string;
  planText: string;
  source: PlanCardSource;
};

const PLAN_CARD_SENTINEL_LINE_PATTERN = /(^|[\r\n])([ \t]*<!--plan-->[ \t]*)(?:\r?\n|$)/;

export const splitPlanCardSentinel = (text: string): PlanCardSentinelSplit | null => {
  if (typeof text !== 'string' || text.length === 0) return null;

  const match = PLAN_CARD_SENTINEL_LINE_PATTERN.exec(text);
  if (!match || match.index < 0) return null;

  const linePrefix = match[1] ?? '';
  const sentinelStart = match.index + linePrefix.length;
  const preambleText = text.slice(0, sentinelStart);
  const planText = text.slice(match.index + match[0].length);

  return { preambleText, planText, source: 'sentinel' };
};

const getPartText = (part: Part): string => {
  const textPart = part as TextLikePart;
  const rawText = typeof textPart.text === 'string' ? textPart.text : '';
  const contentText = typeof textPart.content === 'string' ? textPart.content : '';
  const valueText = typeof textPart.value === 'string' ? textPart.value : '';
  return [rawText, contentText, valueText].reduce((best, candidate) => (
    candidate.length > best.length ? candidate : best
  ), '');
};

export const buildPlanImplementationRequestMarker = ({
  sourceSessionId,
  sourceMessageId,
  planIndex,
}: Omit<PlanImplementationRequest, 'action'>): string => {
  return `${PLAN_IMPLEMENTATION_REQUEST_PREFIX}${JSON.stringify({
    action: 'implement',
    sourceSessionId,
    sourceMessageId,
    planIndex,
  })}`;
};

export const parsePlanImplementationRequestPart = (
  part: Part | undefined,
): PlanImplementationRequest | null => {
  if (!part || part.type !== 'text') return null;
  const textPart = part as TextLikePart;
  if (textPart.synthetic !== true) return null;

  const text = getPartText(part).trim();
  if (!text.startsWith(PLAN_IMPLEMENTATION_REQUEST_PREFIX)) return null;

  try {
    const parsed = JSON.parse(text.slice(PLAN_IMPLEMENTATION_REQUEST_PREFIX.length)) as {
      action?: unknown;
      sourceSessionId?: unknown;
      sourceMessageId?: unknown;
      planIndex?: unknown;
    };
    if (parsed.action !== 'implement') return null;
    if (typeof parsed.sourceSessionId !== 'string' || parsed.sourceSessionId.trim().length === 0) {
      return null;
    }
    if (typeof parsed.sourceMessageId !== 'string' || parsed.sourceMessageId.trim().length === 0) {
      return null;
    }
    if (!Number.isSafeInteger(parsed.planIndex) || (parsed.planIndex as number) < 0) return null;

    return {
      action: 'implement',
      sourceSessionId: parsed.sourceSessionId,
      sourceMessageId: parsed.sourceMessageId,
      planIndex: parsed.planIndex as number,
    };
  } catch {
    return null;
  }
};

export const getPlanBlockId = (assistantMessageId: string, planIndex: number): string => {
  return `${assistantMessageId}:plan:${planIndex}`;
};

export const getPlanImplementationKey = (sessionId: string, planBlockId: string): string => {
  return `${sessionId}:${planBlockId}`;
};

export const isPlanModeInstructionPart = (part: Part): boolean => {
  const textPart = part as TextLikePart;
  if (textPart.synthetic !== true) return false;
  return getPartText(part).trim().startsWith(PLAN_MODE_INSTRUCTION_PREFIX);
};

const isPlanModeMetadata = (message: Message): boolean => {
  const candidate = message as MessageWithPlanModeMetadata;
  const mode = candidate.mode;
  if (typeof mode === 'string' && mode.trim().toLowerCase() === 'plan') return true;
  return candidate.metadata?.openchamberPlanMode === true;
};

/**
 * Returns true when the given user message was sent in plan mode. Reads from
 * three signals in priority order:
 *   1. `recordedPlanMode` — caller-supplied flag from `useSessionUIStore.planModeUserMessages`
 *      (locally persisted, the most reliable signal).
 *   2. Message metadata (`mode === 'plan'` or `metadata.openchamberPlanMode === true`)
 *      — fallback for sessions where the local flag is missing (e.g. cleared storage,
 *      remote/migrated sessions).
 *   3. Synthetic plan-mode instruction part (the "User has requested to enter plan mode" prefix).
 */
export const isPlanModeUserMessage = (
  message: Message | undefined,
  parts: readonly Part[] | undefined,
  recordedPlanMode: boolean,
): boolean => {
  if (!message || message.role !== 'user') return false;
  if (recordedPlanMode) return true;
  if (isPlanModeMetadata(message)) return true;
  return (parts ?? []).some(isPlanModeInstructionPart);
};

export const collectAssistantTextParts = (parts: readonly Part[]): string[] => {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part.type !== 'text') continue;
    const text = getPartText(part).trim();
    if (text.length > 0) textParts.push(text);
  }
  return textParts;
};

export const collectAssistantReasoningParts = (parts: readonly Part[]): string[] => {
  const reasoningParts: string[] = [];
  for (const part of parts) {
    if (part.type !== 'reasoning') continue;
    const text = getPartText(part).trim();
    if (text.length > 0) reasoningParts.push(text);
  }
  return reasoningParts;
};

const normalizePlanSectionHeading = (heading: string): string => (
  heading.trim().toLowerCase().replace(/\s+/g, ' ')
);

const countPlanModeSectionHeadings = (text: string): number => {
  if (typeof text !== 'string' || text.length === 0) return 0;

  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = MARKDOWN_HEADING_LINE.exec(line);
    if (!match) continue;
    const level = match[1]?.length ?? 0;
    const heading = normalizePlanSectionHeading(match[2] ?? '');
    if (level === 1 || PLAN_MODE_SECTION_HEADINGS.has(heading)) {
      count += 1;
    }
  }
  return count;
};

const findStructuredPlanStartIndex = (text: string): number => {
  if (typeof text !== 'string' || text.length === 0) return -1;

  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const match = MARKDOWN_HEADING_LINE.exec(line);
    if (match) {
      const level = match[1]?.length ?? 0;
      const heading = normalizePlanSectionHeading(match[2] ?? '');
      if (level === 1 || PLAN_MODE_SECTION_HEADINGS.has(heading)) {
        return offset;
      }
    }
    offset += line.length + 1;
  }
  return -1;
};

const splitStructuredPlanFallback = (
  text: string,
  source: Exclude<PlanCardSource, 'sentinel'> = 'structured',
): PlanCardSentinelSplit | null => {
  const planStart = findStructuredPlanStartIndex(text);
  if (planStart < 0) return null;

  const planText = text.slice(planStart);
  if (countPlanModeSectionHeadings(planText) < 2) return null;

  return {
    preambleText: text.slice(0, planStart),
    planText,
    source,
  };
};

export type ResolvePlanCardSplitOptions = {
  isPlanModeSource?: boolean;
};

export const resolvePlanCardSplit = (
  text: string,
  options: ResolvePlanCardSplitOptions = {},
): PlanCardSentinelSplit | null => {
  const sentinelSplit = splitPlanCardSentinel(text);
  if (sentinelSplit) return sentinelSplit;
  if (options.isPlanModeSource !== true) return null;
  return splitStructuredPlanFallback(text);
};

export type ResolveMessagePlanCardOptions = {
  isPlanModeSource?: boolean;
};

export const resolveMessagePlanCard = (
  parts: readonly Part[],
  options: ResolveMessagePlanCardOptions = {},
): PlanCardSentinelSplit | null => {
  const textParts = collectAssistantTextParts(parts);
  if (textParts.length === 0 && options.isPlanModeSource !== true) return null;

  const joinedText = textParts.join('\n');
  const textSplit = resolvePlanCardSplit(joinedText, options);
  if (textSplit?.planText.trim()) return textSplit;

  if (options.isPlanModeSource !== true) return null;

  const reasoningParts = collectAssistantReasoningParts(parts);
  if (reasoningParts.length === 0) return textSplit?.planText.trim() ? textSplit : null;

  for (let index = reasoningParts.length - 1; index >= 0; index -= 1) {
    const reasoningSplit = splitStructuredPlanFallback(reasoningParts[index] ?? '', 'reasoning');
    if (!reasoningSplit?.planText.trim()) continue;

    const preambleText = [
      joinedText,
      ...reasoningParts.slice(0, index),
    ].filter((chunk) => chunk.trim().length > 0).join('\n');

    return {
      preambleText: preambleText.length > 0 ? `${preambleText}\n` : '',
      planText: reasoningSplit.planText,
      source: 'reasoning',
    };
  }

  return textSplit?.planText.trim() ? textSplit : null;
};

export const joinAssistantTextParts = (parts: readonly Part[]): string => (
  collectAssistantTextParts(parts).join('\n')
);
