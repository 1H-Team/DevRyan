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

/** Which starter sections the current text still contains, for editor hints. */
export const missingBotSoulSections = (value: string): readonly string[] => (
  BOT_SOUL_SECTIONS.filter((section) => !value.includes(`## ${section}`))
);
