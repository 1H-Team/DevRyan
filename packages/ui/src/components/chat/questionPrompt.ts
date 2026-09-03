/**
 * A question prompt may span several lines: line 1 is the question itself and
 * the remaining non-empty lines are an explanation block (plan-deviation
 * questions use labelled lines such as `Why:` and `For end users:`).
 */
export type QuestionPromptParts = {
  title: string;
  explanation: string[];
};

export const splitQuestionPrompt = (question: string): QuestionPromptParts => {
  const lines = (typeof question === 'string' ? question : '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const firstIndex = lines.findIndex((line) => line.length > 0);
  if (firstIndex < 0) return { title: '', explanation: [] };
  return {
    title: lines[firstIndex] ?? '',
    explanation: lines.slice(firstIndex + 1).filter((line) => line.length > 0),
  };
};
