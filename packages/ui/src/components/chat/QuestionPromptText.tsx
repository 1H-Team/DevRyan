import React from 'react';

import { cn } from '@/lib/utils';

const EXPLANATION_LABEL_LINE = /^([A-Z][^:]{1,40}):\s(.*)$/;

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
