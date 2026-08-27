// Mirrors packages/web/server/lib/bots/soul-template.js. The server is the
// authority — it seeds and backfills souls — but the editor needs the same
// starter text so a new Bot shows its soul before the first save round-trips.

export const BOT_SOUL_SECTIONS = Object.freeze([
  'Core Identity',
  'Personality & Values',
  'Voice & Tone',
  'How I Respond',
  'Boundaries',
]);

export const BOT_SOUL_MAX_BYTES = 16 * 1024;

const trimmed = (value: string | undefined | null): string => (
  typeof value === 'string' ? value.trim() : ''
);

const sentenceEnd = (value: string): string => (/[.!?]$/.test(value) ? value : `${value}.`);

export const buildStarterBotSoul = ({
  name,
  title,
  summary,
  tone,
}: {
  name?: string | null;
  title?: string | null;
  summary?: string | null;
  tone?: string | null;
} = {}): string => {
  const botName = trimmed(name) || 'This Bot';
  const botTitle = trimmed(title);
  const botSummary = trimmed(summary);
  const botTone = trimmed(tone);

  const essence = botTitle ? `${botName} — ${sentenceEnd(botTitle)}` : `${botName}.`;

  const identityLines = [botTitle ? `I am ${botName}, ${botTitle}.` : `I am ${botName}.`];
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

/** Which starter sections the current text still contains, for editor hints. */
export const missingBotSoulSections = (value: string): readonly string[] => (
  BOT_SOUL_SECTIONS.filter((section) => !value.includes(`## ${section}`))
);
