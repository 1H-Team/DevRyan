const INTERNAL_BLOCK_NAMES = [
  'analysis',
  'thinking',
  'reasoning',
  'tool_call',
  'tool_result',
  'function_call',
  'function_result',
  'agent_action',
  'agentic_action',
];

const INTERNAL_BLOCK_PATTERN = new RegExp(
  `<(?:${INTERNAL_BLOCK_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?<\\/(?:${INTERNAL_BLOCK_NAMES.join('|')})\\s*>`,
  'giu',
);

const MARKDOWN_FENCE = '`'.repeat(3);
const INTERNAL_FENCE_PATTERN = new RegExp(
  `${MARKDOWN_FENCE}(?:${INTERNAL_BLOCK_NAMES.join('|')}|tool|function)\\b[^\\n]*\\n[\\s\\S]*?${MARKDOWN_FENCE}`,
  'giu',
);

const STATUS_VERBS = Object.freeze([
  'analyzing',
  'browsing',
  'building',
  'calling',
  'checking',
  'composing',
  'confirming',
  'crafting',
  'drafting',
  'executing',
  'fetching',
  'formulating',
  'generating',
  'inspecting',
  'navigating',
  'planning',
  'preparing',
  'reading',
  'reviewing',
  'running',
  'searching',
  'thinking',
  'updating',
  'using',
  'working',
  'writing',
]);

const STATUS_PREFIX_PATTERN = new RegExp(
  `^(?:now\\s+)?(?:${STATUS_VERBS.join('|')})\\b`,
  'iu',
);

const normalizeStatusLabel = (value) => value
  .replace(/^[\s*_`~:[({-]+/gu, '')
  .replace(/[\s*_`~:.)\]}!-]+$/gu, '')
  .trim();

const isAgenticStatusLabel = (value) => {
  const label = normalizeStatusLabel(value);
  if (!label || label.length > 160 || label.split(/\s+/u).length > 18) return false;
  return STATUS_PREFIX_PATTERN.test(label);
};

const stripLeadingStatusLabel = (value) => {
  const bold = value.match(/^\s*(\*\*|__)([^\n]{1,160})\1[ \t]*(?:\n[ \t]*)*/u);
  if (bold && isAgenticStatusLabel(bold[2])) return value.slice(bold[0].length);

  const heading = value.match(/^\s*#{1,6}[ \t]+([^\n]{1,160})(?:\n+|$)/u);
  if (heading && isAgenticStatusLabel(heading[1])) return value.slice(heading[0].length);

  const line = value.match(/^\s*([^\n]{1,160})\n+/u);
  if (line && isAgenticStatusLabel(line[1])) return value.slice(line[0].length);

  return value;
};

const isIncompleteLeadingStatusLabel = (value) => {
  const leading = value.trimStart();
  const marker = leading.startsWith('**') ? '**' : leading.startsWith('__') ? '__' : null;
  if (marker) {
    const remainder = leading.slice(marker.length);
    if (remainder.includes(marker) || remainder.includes('\n') || remainder.length > 160) return false;
    const label = normalizeStatusLabel(remainder);
    if (!label) return true;
    const normalized = label.toLocaleLowerCase('en-US');
    return STATUS_VERBS.some((verb) => verb.startsWith(normalized) || normalized.startsWith(verb));
  }

  const heading = leading.match(/^#{1,6}[ \t]+([^\n]{0,160})$/u);
  if (!heading) return false;
  const label = normalizeStatusLabel(heading[1]).toLocaleLowerCase('en-US');
  return !label || STATUS_VERBS.some((verb) => verb.startsWith(label) || label.startsWith(verb));
};

const stripInternalBlocks = (value) => value
  .replace(INTERNAL_BLOCK_PATTERN, '')
  .replace(INTERNAL_FENCE_PATTERN, '');

const hasIncompleteLeadingInternalBlock = (value) => {
  const leading = value.trimStart().toLocaleLowerCase('en-US');
  const blockName = INTERNAL_BLOCK_NAMES.find((name) => (
    leading.startsWith(`<${name}`)
  ));
  if (blockName && !leading.includes(`</${blockName}>`)) return true;
  if (!leading.startsWith(MARKDOWN_FENCE)) return false;
  const fenceLabel = leading.slice(MARKDOWN_FENCE.length).split(/[\s\n]/u, 1)[0];
  const internalFence = INTERNAL_BLOCK_NAMES.includes(fenceLabel)
    || fenceLabel === 'tool'
    || fenceLabel === 'function';
  return internalFence && leading.indexOf(MARKDOWN_FENCE, MARKDOWN_FENCE.length) < 0;
};

export const isPublicBotAssistantTextPart = (part) => (
  part?.type === 'text'
  && typeof part.text === 'string'
  && part.synthetic !== true
  && part.ignored !== true
);

export const sanitizeBotConversationalText = (value) => {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (hasIncompleteLeadingInternalBlock(value)) return '';
  let sanitized = stripInternalBlocks(value);
  let previous;
  do {
    previous = sanitized;
    sanitized = stripLeadingStatusLabel(sanitized);
  } while (sanitized !== previous);

  if (isIncompleteLeadingStatusLabel(sanitized)) return '';
  return sanitized.trimStart();
};
