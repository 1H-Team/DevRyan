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
  // Synonyms models reach for when they are not echoing the plan template
  // verbatim. Only consulted for plan-mode turns, and two of them are still
  // required, so the false-positive surface stays small.
  'steps',
  'implementation steps',
  'approach',
  'files to change',
  'testing',
  'verification steps',
  'risks',
]);

// Accepts `#` through `####`. Restricting this to `#`/`##` silently dropped any
// plan written with `### Context` / `### Implementation` out of plan detection,
// which sent it to the justification bucket and rendered it as a thought.
// Note the level-1 shortcut below still only applies to a single `#`, so
// widening this does not make arbitrary `###` subheadings start a plan.
const MARKDOWN_HEADING_LINE = /^\s{0,3}(#{1,4})\s+(.+?)\s*$/;

/**
 * Sentinel the agent must emit on its own line immediately before the final
 * structured plan output. The chat UI uses this marker to know when to mount
 * the plan card (so preamble/reasoning text before the marker streams in the
 * normal chat flow). The marker is an HTML comment so the markdown renderer
 * drops it from the visible output even if it is left in the text.
 */
export const PLAN_CARD_SENTINEL = '<!--plan-->';

/**
 * Tolerant form of the sentinel token: models (Grok especially) echo the
 * marker with inline-code backticks or internal spaces, and a miss is silent
 * because the markdown renderer strips HTML comments from the visible output.
 * Detection and stripping share this source so they always agree.
 */
const PLAN_CARD_SENTINEL_TOKEN_SOURCE = '`{0,3}<!--\\s*plan\\s*-->`{0,3}';

/**
 * Returns the index of the sentinel in the given text, or -1 if absent.
 * Tolerates surrounding whitespace, backticks, and internal spaces.
 */
export const findPlanCardSentinel = (text: string): number => {
  if (typeof text !== 'string' || text.length === 0) return -1;
  const match = new RegExp(PLAN_CARD_SENTINEL_TOKEN_SOURCE).exec(text);
  return match ? match.index : -1;
};

/**
 * Strips the sentinel (and the surrounding blank line, if present) from a
 * piece of plan text so it doesn't leak into the implement-prompt body or
 * the rendered markdown.
 */
export const stripPlanCardSentinel = (text: string): string => {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(new RegExp(`\\s*${PLAN_CARD_SENTINEL_TOKEN_SOURCE}\\s*`), '\n');
};

export type PlanCardSource = 'sentinel' | 'structured' | 'reasoning';

export type PlanCardSentinelSplit = {
  preambleText: string;
  planText: string;
  source: PlanCardSource;
};

const PLAN_CARD_SENTINEL_LINE_PATTERN = new RegExp(
  `(^|[\\r\\n])([ \\t]*${PLAN_CARD_SENTINEL_TOKEN_SOURCE}[ \\t]*)(?:\\r?\\n|$)`,
);

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

/**
 * True when the text contains a structured plan body (a recognized plan
 * heading followed by at least two plan-mode section headings). Used by turn
 * activity projection to keep plan-bearing text out of the justification
 * bucket so it reaches the plan-card branch.
 */
export const hasStructuredPlanBody = (text: string): boolean => (
  splitStructuredPlanFallback(text) !== null
);

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

/**
 * Splits a single reasoning part's own text into its pre-plan preamble and the
 * plan body it carries. Sentinel-first — Grok emits the `<!--plan-->` marker on
 * the reasoning channel too — with the structured-headings fallback behind it.
 * The result is always reasoning-sourced so consumers can tell the plan came
 * from the thought stream. Shared by plan resolution and the MessageBody
 * reasoning branch so both slice the part at the same seam.
 */
export const splitReasoningPartPlan = (text: string): PlanCardSentinelSplit | null => {
  if (typeof text !== 'string' || text.length === 0) return null;
  const sentinelSplit = splitPlanCardSentinel(text);
  if (sentinelSplit?.planText.trim()) return { ...sentinelSplit, source: 'reasoning' };
  return splitStructuredPlanFallback(text, 'reasoning');
};

type MessagePlanCardResolution = {
  split: PlanCardSentinelSplit;
  /** Index in `parts` of the reasoning part hosting the plan card, or -1 when text-sourced. */
  reasoningPartIndex: number;
};

const buildReasoningPlanPreamble = (
  parts: readonly Part[],
  reasoningPartIndex: number,
  includeAllText: boolean,
): string => {
  const textScope = includeAllText ? parts : parts.slice(0, reasoningPartIndex);
  const chunks = [...collectAssistantTextParts(textScope)];
  for (let index = 0; index < reasoningPartIndex; index += 1) {
    const part = parts[index];
    if (part?.type !== 'reasoning') continue;
    const text = getPartText(part).trim();
    if (text.length > 0) chunks.push(text);
  }
  const preamble = chunks.filter((chunk) => chunk.trim().length > 0).join('\n');
  return preamble.length > 0 ? `${preamble}\n` : '';
};

/**
 * A plan that STARTS in a reasoning part and CONTINUES in later text parts
 * (Grok switches channels mid-plan). Neither half resolves cleanly on its own:
 * the text-only split drops the plan head into the thought block, and the
 * whole-reasoning fallback never runs because the text half already yields a
 * plan. Joining the two halves fixes both — guarded so it never displaces a
 * self-contained text plan:
 *   - the text tail must itself carry at least one plan heading (a narration
 *     tail after a mid-turn reasoning plan fragment must not be glued into the
 *     card);
 *   - any text-only split must be a suffix of the combined plan (the straddle
 *     must strictly extend it, never replace it).
 */
const resolveReasoningStraddlePlan = (
  parts: readonly Part[],
  textSplit: PlanCardSentinelSplit | null,
): MessagePlanCardResolution | null => {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== 'reasoning') continue;
    const text = getPartText(part).trim();
    if (text.length === 0) continue;
    const reasoningSplit = splitReasoningPartPlan(text);
    if (!reasoningSplit?.planText.trim()) continue;

    const textTail = collectAssistantTextParts(parts.slice(index + 1)).join('\n');
    if (textTail.trim().length === 0) return null;
    if (countPlanModeSectionHeadings(textTail) < 1) return null;

    const combined = `${reasoningSplit.planText}\n${textTail}`;
    if (countPlanModeSectionHeadings(combined) < 2) return null;
    if (textSplit?.planText.trim()) {
      if (!combined.trimEnd().endsWith(textSplit.planText.trim())) return null;
      // A text plan that opens with its own level-1 title is self-contained;
      // a genuine continuation tail starts mid-plan (a `##` section or prose).
      const textPlanFirstLine = textSplit.planText.trimStart().split(/\r?\n/, 1)[0] ?? '';
      const headingMatch = MARKDOWN_HEADING_LINE.exec(textPlanFirstLine);
      if (headingMatch && (headingMatch[1]?.length ?? 0) === 1) return null;
    }

    return {
      split: {
        preambleText: buildReasoningPlanPreamble(parts, index, false),
        planText: combined,
        source: 'reasoning',
      },
      reasoningPartIndex: index,
    };
  }
  return null;
};

/**
 * Single source of truth for which part hosts the plan card.
 * `resolveMessagePlanCard` and `findPlanCardReasoningPartIndex` are both thin
 * wrappers over this, so the render layer and the turn-activity projection can
 * never disagree about where the plan lives.
 */
const resolveMessagePlanCardResolution = (
  parts: readonly Part[],
  options: ResolveMessagePlanCardOptions = {},
): MessagePlanCardResolution | null => {
  const textParts = collectAssistantTextParts(parts);
  if (textParts.length === 0 && options.isPlanModeSource !== true) return null;

  const joinedText = textParts.join('\n');
  const textSplit = resolvePlanCardSplit(joinedText, options);
  // A sentinel in the text parts is an exact author-placed marker and wins outright.
  if (textSplit?.planText.trim() && textSplit.source === 'sentinel') {
    return { split: textSplit, reasoningPartIndex: -1 };
  }
  if (options.isPlanModeSource !== true) {
    return textSplit?.planText.trim() ? { split: textSplit, reasoningPartIndex: -1 } : null;
  }

  const straddle = resolveReasoningStraddlePlan(parts, textSplit);
  if (straddle) return straddle;

  if (textSplit?.planText.trim()) return { split: textSplit, reasoningPartIndex: -1 };

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== 'reasoning') continue;
    const text = getPartText(part).trim();
    if (text.length === 0) continue;
    const reasoningSplit = splitReasoningPartPlan(text);
    if (!reasoningSplit?.planText.trim()) continue;
    return {
      split: {
        preambleText: buildReasoningPlanPreamble(parts, index, true),
        planText: reasoningSplit.planText,
        source: 'reasoning',
      },
      reasoningPartIndex: index,
    };
  }

  return null;
};

export const resolveMessagePlanCard = (
  parts: readonly Part[],
  options: ResolveMessagePlanCardOptions = {},
): PlanCardSentinelSplit | null => (
  resolveMessagePlanCardResolution(parts, options)?.split ?? null
);

export const joinAssistantTextParts = (parts: readonly Part[]): string => (
  collectAssistantTextParts(parts).join('\n')
);

/**
 * Index (within `parts`) of the reasoning part that `resolveMessagePlanCard`
 * would mount the plan card from, or -1 when the card comes from text parts (or
 * there is no card at all).
 *
 * The turn-activity projection needs this because it classifies every reasoning
 * part with text as `kind: 'reasoning'`. When the card is sourced from a
 * reasoning part, that renders the very same plan twice — once inside the
 * thought-style block and once in the card. Both layers must agree on which
 * part is the plan, so the selection logic lives here and is mirrored from
 * resolveMessagePlanCard rather than reimplemented at the call site.
 */
export const findPlanCardReasoningPartIndex = (
  parts: readonly Part[],
  options: ResolveMessagePlanCardOptions = {},
): number => {
  if (options.isPlanModeSource !== true) return -1;
  return resolveMessagePlanCardResolution(parts, options)?.reasoningPartIndex ?? -1;
};
