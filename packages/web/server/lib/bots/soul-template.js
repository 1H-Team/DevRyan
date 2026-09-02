// A Bot's soul is its identity: who it is, how it sounds, and what it will not
// do. It is injected at the top of the compiled system prompt so everything
// operational that follows is read in its voice.
//
// The split is deliberate and follows the SOUL.md conventions: identity and
// voice live here, while the standing role, objectives, and operating rules
// stay in their own fields. Enforcement lives in the action policy — the
// boundaries below shape behavior, they do not gate it. The starter reads
// like a person describing themselves, because that is the register we want
// back: short lines, contractions, no assistant-speak.

const SOUL_SECTION_HEADINGS = Object.freeze([
  'Core Identity',
  'Personality & Values',
  'Voice & Tone',
  'How I Respond',
  'Boundaries',
]);

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

const sentenceEnd = (value) => (/[.!?]$/.test(value) ? value : `${value}.`);

/**
 * Builds a starter soul for a Bot from whatever profile it already has.
 * Seeded once at creation and backfilled once for Bots that predate souls;
 * after that it belongs to whoever edits it.
 */
export const buildStarterSoul = ({
  name,
  title,
  summary,
  tone,
} = {}) => {
  const botName = trimmed(name) || 'This Bot';
  const botTitle = trimmed(title);
  const botSummary = trimmed(summary);
  const botTone = trimmed(tone);

  const essence = botTitle
    ? `${botName} — ${sentenceEnd(botTitle)}`
    : `${botName}.`;

  const identityLines = [];
  if (botTitle) identityLines.push(`I am ${botName}, ${botTitle}.`);
  else identityLines.push(`I am ${botName}.`);
  if (botSummary) identityLines.push(botSummary);
  identityLines.push('I\'m here for the people on this Bot, more teammate than tool, and I own what I do.');

  const voiceLines = botTone
    ? [botTone]
    : ['I talk like a person in a chat: short lines, contractions, a little dry humor when it fits. Short question, short answer; detail only when the detail matters.'];
  voiceLines.push('Avoid: assistant-speak (“Certainly!”, “Great question”), bullet dumps, restating the question, apologizing more than once, and closing offers like “let me know if you need anything else”.');

  return [
    '# Soul',
    '',
    essence,
    '',
    '## Core Identity',
    identityLines.join('\n'),
    '',
    '## Personality & Values',
    [
      '- Warm and quick; I care how things land, not just whether they were said.',
      '- I say what\'s true, even when it\'s not what someone hoped for.',
      '- I\'d rather admit I don\'t know than bluff.',
    ].join('\n'),
    '',
    '## Voice & Tone',
    voiceLines.join('\n'),
    '',
    '## How I Respond',
    [
      'Answer first, reasoning second, and only as much as the question needs.',
      'When a request is genuinely ambiguous I ask one short question; otherwise I make a sensible call and say what I assumed.',
      'When something fails I say so plainly and say what I\'ll try next.',
    ].join('\n'),
    '',
    '## Boundaries',
    [
      '- I never invent facts, sources, or results.',
      '- I don\'t reach outside this workspace unless I\'m asked to.',
      '- If something is outside what I can do, I say so instead of faking it.',
    ].join('\n'),
    '',
  ].join('\n');
};

export { SOUL_SECTION_HEADINGS };
