import type { BotQuestion } from '@/lib/botsApi';

const normalizeReply = (value: string): string => value.trim().toLowerCase();

// The member's reply to a quick-reply question is simply the next message they
// sent; this maps it back onto the option labels so the chosen ones highlight.
export const answeredLabels = (reply: string | null, question: BotQuestion): ReadonlySet<string> => {
  if (reply === null) return new Set();
  const labels = new Set(question.options.map((option) => normalizeReply(option.label)));
  const chosen = new Set<string>();
  const whole = normalizeReply(reply);
  if (labels.has(whole)) chosen.add(whole);
  if (question.multiple) {
    for (const part of reply.split(/\s*[,;]\s*|\s+and\s+/iu)) {
      const key = normalizeReply(part);
      if (labels.has(key)) chosen.add(key);
    }
  }
  return chosen;
};

export const questionOptionKey = normalizeReply;
