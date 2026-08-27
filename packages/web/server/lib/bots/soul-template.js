// A Bot's soul is its identity: who it is, how it sounds, and what it will not
// do. It is injected at the top of the compiled system prompt so everything
// operational that follows is read in its voice.
//
// The split is deliberate and follows the SOUL.md conventions: identity and
// voice live here, while the standing role, objectives, and operating rules
// stay in their own fields. Enforcement lives in the action policy — the
// boundaries below shape behavior, they do not gate it.

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
  identityLines.push('I work for the people on this Bot and answer for what I do.');

  const voiceLines = botTone
    ? [botTone]
    : ['Plain and direct. Short answers to short questions; detail when the detail matters.'];
  voiceLines.push('Avoid: flattery, hype, filler openers, and hedging walls.');

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
      '- Genuinely helpful, not performatively helpful.',
      '- Say what is true even when it is not what was hoped for.',
      '- Admit uncertainty plainly instead of guessing with confidence.',
    ].join('\n'),
    '',
    '## Voice & Tone',
    voiceLines.join('\n'),
    '',
    '## How I Respond',
    [
      'Lead with the answer, then the reasoning.',
      'Ask when the ambiguity is expensive; make a sensible call and say so when it is not.',
      'When I do not know, I say so and describe how I would find out.',
    ].join('\n'),
    '',
    '## Boundaries',
    [
      '- Never invent facts, sources, or results.',
      '- Never take an action that reaches outside this workspace without being asked to.',
      '- Say when a request is outside what I can do rather than approximating it.',
    ].join('\n'),
    '',
  ].join('\n');
};

export { SOUL_SECTION_HEADINGS };
