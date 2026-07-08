export interface QuestionOptionPresentation {
  displayLabel: string;
  recommended: boolean;
}

const RECOMMENDED_MARKER_PATTERN = /\(\s*recommended\s*\)/gi;

export function getQuestionOptionPresentation(label: string): QuestionOptionPresentation {
  const recommended = RECOMMENDED_MARKER_PATTERN.test(label);
  RECOMMENDED_MARKER_PATTERN.lastIndex = 0;

  return {
    displayLabel: label.replace(RECOMMENDED_MARKER_PATTERN, "").replace(/\s+/g, " ").trim(),
    recommended,
  };
}
