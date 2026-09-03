import React from 'react';

import { cn } from '@/lib/utils';

/**
 * A question prompt may span several lines: line 1 is the question itself and
 * the remaining non-empty lines are an explanation block (plan-deviation
 * questions use labelled lines such as `Why:` and `For end users:`).
 */
export type QuestionPromptParts = {
  title: string;
  explanation: string[];
};

const EXPLANATION_LABEL_LINE = /^([A-Z][^:]{1,40}):\s(.*)$/;

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

type QuestionExplanationProps = {
  lines: string[];
  className?: string;
};

export const QuestionExplanation: React.FC<QuestionExplanationProps> = ({ lines, className }) => {
  if (lines.length === 0) return null;
  return (
    <div className={cn('typography-micro text-muted-foreground whitespace-pre-wrap', className)}>
      {lines.map((line, index) => {
        const match = EXPLANATION_LABEL_LINE.exec(line);
        return (
          <div key={`${index}:${line}`}>
            {match ? (
              <>
                <span className="font-medium text-foreground">{match[1]}:</span>{' '}
                {match[2]}
              </>
            ) : (
              line
            )}
          </div>
        );
      })}
    </div>
  );
};
