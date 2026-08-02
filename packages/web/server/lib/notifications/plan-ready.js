const PLAN_CARD_SENTINEL = '<!--plan-->';
const PLAN_MODE_INSTRUCTION_PREFIX = 'User has requested to enter plan mode';
const PLAN_IMPLEMENTATION_REQUEST_PREFIX = '[openchamber-plan-action:v1] ';
const COMPACT_COMMAND_TEXT = '/compact';

const PLAN_MODE_SECTION_HEADINGS = new Set([
  'context',
  'critical files',
  'implementation',
  'visual details',
  'verification',
]);

const MARKDOWN_HEADING_LINE = /^\s{0,3}(#{1,2})\s+(.+?)\s*$/;
const PLAN_CARD_SENTINEL_LINE_PATTERN = /(^|[\r\n])([ \t]*<!--plan-->[ \t]*)(?:\r?\n|$)/;

const getPartText = (part) => {
  if (!part || typeof part !== 'object') return '';
  const candidates = [part.text, part.content, part.value]
    .filter((value) => typeof value === 'string');
  return candidates.reduce((best, value) => value.length > best.length ? value : best, '');
};

const collectPartText = (parts, type) => {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((part) => part?.type === type)
    .map(getPartText)
    .map((text) => text.trim())
    .filter(Boolean);
};

const normalizePlanSectionHeading = (heading) => heading.trim().toLowerCase().replace(/\s+/g, ' ');

const countPlanModeSectionHeadings = (text) => {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = MARKDOWN_HEADING_LINE.exec(line);
    if (!match) continue;
    const level = match[1]?.length ?? 0;
    const heading = normalizePlanSectionHeading(match[2] ?? '');
    if (level === 1 || PLAN_MODE_SECTION_HEADINGS.has(heading)) count += 1;
  }
  return count;
};

const findStructuredPlan = (text) => {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const match = MARKDOWN_HEADING_LINE.exec(line);
    if (match) {
      const level = match[1]?.length ?? 0;
      const heading = normalizePlanSectionHeading(match[2] ?? '');
      if (level === 1 || PLAN_MODE_SECTION_HEADINGS.has(heading)) {
        const planText = text.slice(offset);
        return countPlanModeSectionHeadings(planText) >= 2 ? planText : null;
      }
    }
    offset += line.length + 1;
  }
  return null;
};

const findSentinelPlan = (text) => {
  if (typeof text !== 'string' || text.length === 0) return null;
  const match = PLAN_CARD_SENTINEL_LINE_PATTERN.exec(text);
  if (!match) return null;
  const planText = text.slice(match.index + match[0].length);
  return planText.trim() ? planText : null;
};

const resolveMessagePlan = (parts, isPlanModeSource) => {
  const text = collectPartText(parts, 'text').join('\n');
  const sentinelPlan = findSentinelPlan(text);
  if (sentinelPlan) return sentinelPlan;
  if (!isPlanModeSource) return null;

  const structuredTextPlan = findStructuredPlan(text);
  if (structuredTextPlan?.trim()) return structuredTextPlan;

  const reasoningParts = collectPartText(parts, 'reasoning');
  for (let index = reasoningParts.length - 1; index >= 0; index -= 1) {
    const reasoningPlan = findStructuredPlan(reasoningParts[index]);
    if (reasoningPlan?.trim()) return reasoningPlan;
  }
  return null;
};

const isPlanModeUserMessage = (message) => {
  const info = message?.info;
  if (!info || info.role !== 'user') return false;
  if (typeof info.mode === 'string' && info.mode.trim().toLowerCase() === 'plan') return true;
  if (info.metadata?.openchamberPlanMode === true) return true;
  return Array.isArray(message.parts) && message.parts.some((part) => (
    part?.synthetic === true
    && getPartText(part).trim().startsWith(PLAN_MODE_INSTRUCTION_PREFIX)
  ));
};

const isImplementationRequest = (message) => Array.isArray(message?.parts)
  && message.parts.some((part) => (
    part?.type === 'text'
    && part?.synthetic === true
    && getPartText(part).trim().startsWith(PLAN_IMPLEMENTATION_REQUEST_PREFIX)
  ));

const isContinuationUserMessage = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  if (parts.some((part) => part?.type === 'compaction')) return true;
  if (parts.some((part) => part?.type === 'text' && getPartText(part).trim() === COMPACT_COMMAND_TEXT)) return true;
  return parts.length > 0 && parts.every((part) => part?.synthetic === true);
};

const isAssistantComplete = (info) => {
  if (!info || info.role !== 'assistant' || info.streaming === true) return false;
  if (typeof info.status === 'string') {
    const status = info.status.trim().toLowerCase();
    if (status === 'running' || status === 'pending' || status === 'streaming') return false;
    if (status === 'complete' || status === 'completed' || status === 'done') return true;
  }
  return typeof info.time?.completed === 'number' && info.time.completed > 0;
};

const hasRunningTool = (parts) => Array.isArray(parts) && parts.some((part) => (
  part?.type === 'tool'
  && (part.state?.status === 'pending' || part.state?.status === 'running')
));

const buildTurns = (messages) => {
  const turns = [];
  const byUserMessageId = new Map();
  for (const message of messages) {
    const info = message?.info;
    if (!info || typeof info.id !== 'string') continue;
    if (info.role === 'user') {
      const turn = { user: message, assistants: [] };
      turns.push(turn);
      byUserMessageId.set(info.id, turn);
      continue;
    }
    if (info.role !== 'assistant') continue;
    const target = (typeof info.parentID === 'string' ? byUserMessageId.get(info.parentID) : null)
      ?? turns[turns.length - 1];
    target?.assistants.push(message);
  }
  return turns;
};

const groupTurns = (turns) => {
  const groups = [];
  for (const turn of turns) {
    const openGroup = groups[groups.length - 1];
    if (openGroup && !isPlanModeUserMessage(turn.user) && isContinuationUserMessage(turn.user)) {
      openGroup.push(turn);
    } else {
      groups.push([turn]);
    }
  }
  return groups;
};

/**
 * Returns the canonical plan revision that is actionable at the live session
 * tail. This mirrors the UI's plan-card/yellow-indicator contract while using
 * the authoritative message list available to the server notification owner.
 */
export const detectPlanReadyRevision = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const normalized = messages.filter((message) => message?.info && Array.isArray(message.parts));
  const tail = normalized[normalized.length - 1];
  if (!tail || tail.info?.role !== 'assistant' || !isAssistantComplete(tail.info)) return null;

  // A terminal event can carry the complete assistant parts before the
  // authoritative history endpoint exposes its parent user message. The
  // sentinel is an explicit plan contract, so it remains independently
  // classifiable from that one-message snapshot.
  const tailSentinelPlan = findSentinelPlan(collectPartText(tail.parts, 'text').join('\n'));
  if (tailSentinelPlan?.trim() && !hasRunningTool(tail.parts)) {
    return {
      sourceMessageId: tail.info.id,
      sourceParentMessageId: typeof tail.info.parentID === 'string' ? tail.info.parentID : null,
      planText: tailSentinelPlan,
    };
  }

  const groups = groupTurns(buildTurns(normalized));
  const group = groups[groups.length - 1];
  if (!group || group.length === 0) return null;
  if (isImplementationRequest(group[group.length - 1]?.user)) return null;

  const isPlanModeRevision = isPlanModeUserMessage(group[0].user);
  let source = null;
  let planText = null;
  for (const turn of group) {
    for (const assistant of turn.assistants) {
      if (!isAssistantComplete(assistant.info) || hasRunningTool(assistant.parts)) return null;
      const resolvedPlan = resolveMessagePlan(assistant.parts, isPlanModeRevision);
      if (resolvedPlan?.trim()) {
        source = assistant;
        planText = resolvedPlan;
      }
    }
  }

  if (!source || !planText?.trim()) return null;
  return {
    sourceMessageId: source.info.id,
    sourceParentMessageId: typeof source.info.parentID === 'string' ? source.info.parentID : null,
    planText,
  };
};

export const PLAN_READY_DEFAULT_TEMPLATE = {
  title: 'Plan ready',
  message: 'A plan is ready for review',
};

export const PLAN_CARD_SENTINEL_TEXT = PLAN_CARD_SENTINEL;
