// A quick-reply question a Bot shows inside its own message bubble. Tapping an
// option sends an ordinary reply; nothing pauses, nothing needs approval.
const MAX_QUESTION_CHARS = 500;
const MAX_OPTIONS = 6;
const MAX_LABEL_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;

export class BotQuestionError extends Error {
  constructor(message, code = 'bot_question_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotQuestionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message) => {
  throw new BotQuestionError(message);
};

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanText = (value, maximum, label) => {
  if (typeof value !== 'string') fail(`Bot question ${label} must be text`);
  const text = value.replace(/\s+/gu, ' ').trim();
  if (!text) fail(`Bot question ${label} is empty`);
  if (text.length > maximum) fail(`Bot question ${label} is too long`);
  return text;
};

export const normalizeBotQuestion = (value) => {
  if (!isRecord(value)) fail('Bot question must be an object');
  const unknownKeys = Object.keys(value).filter((key) => (
    !['version', 'prompt', 'question', 'options', 'multiple', 'allowFreeText'].includes(key)
  ));
  if (unknownKeys.length > 0) fail('Bot question has unsupported fields');
  const prompt = cleanText(value.prompt ?? value.question, MAX_QUESTION_CHARS, 'prompt');
  if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > MAX_OPTIONS) {
    fail(`Bot question needs between 1 and ${MAX_OPTIONS} options`);
  }
  const seen = new Set();
  const options = value.options.map((option) => {
    const raw = typeof option === 'string' ? { label: option } : option;
    if (!isRecord(raw)) fail('Bot question option is invalid');
    const label = cleanText(raw.label, MAX_LABEL_CHARS, 'option label');
    const key = label.toLowerCase();
    if (seen.has(key)) fail('Bot question options must be distinct');
    seen.add(key);
    const description = raw.description === undefined || raw.description === null || raw.description === ''
      ? null
      : cleanText(raw.description, MAX_DESCRIPTION_CHARS, 'option description');
    return Object.freeze({ label, description });
  });
  for (const flag of ['multiple', 'allowFreeText']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') fail(`Bot question ${flag} must be boolean`);
  }
  return Object.freeze({
    version: 1,
    prompt,
    options: Object.freeze(options),
    multiple: value.multiple === true,
    allowFreeText: value.allowFreeText !== false,
  });
};

// How the question reads back to the model in later context, so it remembers
// what it asked without the durable body carrying any transcript prose.
export const botQuestionContextText = (question) => {
  if (!isRecord(question)) return '';
  const options = Array.isArray(question.options)
    ? question.options.map((option) => option?.label).filter((label) => typeof label === 'string')
    : [];
  return `${question.prompt}\n(Quick replies offered: ${options.join(' | ')})`;
};
