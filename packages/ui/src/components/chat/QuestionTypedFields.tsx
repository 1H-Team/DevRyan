import React from 'react';
import { RiCheckLine, RiExternalLinkLine } from '@remixicon/react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { QuestionInfo, QuestionInputHint } from '@/types/question';
import { questionInputType, questionLink } from './questionCardInputs';

interface QuestionTypedInputProps {
  input: QuestionInputHint;
  label: string;
  value: string;
  required: boolean;
  disabled: boolean;
  autoFocus: boolean;
  error: string | null;
  placeholder: string;
  inputRef: React.Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** One typed answer field: native input type, bounds and an inline error. */
export const QuestionTypedInput: React.FC<QuestionTypedInputProps> = ({
  input, label, value, required, disabled, autoFocus, error, placeholder, inputRef, onChange, onKeyDown,
}) => {
  const errorId = React.useId();
  const numeric = input.kind === 'number' || input.kind === 'integer';
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
      <Input
        ref={inputRef}
        type={questionInputType(input.kind)}
        value={value}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={input.placeholder ?? placeholder}
        aria-label={label}
        aria-required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        {...(numeric ? {
          inputMode: input.kind === 'integer' ? 'numeric' as const : 'decimal' as const,
          step: input.kind === 'integer' ? 1 : 'any',
          ...(input.minimum === undefined ? {} : { min: input.minimum }),
          ...(input.maximum === undefined ? {} : { max: input.maximum }),
        } : {
          ...(input.minLength === undefined ? {} : { minLength: input.minLength }),
          ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
        })}
        className="h-8"
      />
      {error ? (
        <div id={errorId} className="typography-micro text-[var(--status-error)]" role="alert">{error}</div>
      ) : null}
    </div>
  );
};

interface QuestionLinkCardProps {
  question: QuestionInfo;
  completed: boolean;
  disabled: boolean;
  openLabel: string;
  completedLabel: string;
  hint: string;
  onOpen: (href: string) => void;
  onToggleCompleted: () => void;
}

/** An http(s) page to complete elsewhere. It opens only on an explicit click. */
export const QuestionLinkCard: React.FC<QuestionLinkCardProps> = ({
  question, completed, disabled, openLabel, completedLabel, hint, onOpen, onToggleCompleted,
}) => {
  const link = question.external ? questionLink(question.external.url) : null;
  if (!link) return null;
  const hostAt = link.href.indexOf(link.host);
  return (
    <div className="space-y-2" data-question-link="true">
      <div className="rounded-md border border-border/40 bg-muted/20 px-2 py-1.5 typography-meta font-mono break-all text-muted-foreground">
        {hostAt >= 0 ? (
          <>
            {link.href.slice(0, hostAt)}
            <span className="font-semibold text-foreground">{link.host}</span>
            {link.href.slice(hostAt + link.host.length)}
          </>
        ) : link.href}
      </div>
      <div className="typography-micro text-muted-foreground">{hint}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onOpen(link.href)}
          disabled={disabled}
          className={cn(
            'flex items-center gap-1 rounded-full px-2 py-0.5 typography-meta font-medium transition-colors',
            'text-primary hover:bg-interactive-hover/20 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <RiExternalLinkLine aria-hidden="true" className="h-3 w-3" />
          {openLabel}
        </button>
        <button
          type="button"
          onClick={onToggleCompleted}
          disabled={disabled}
          aria-pressed={completed}
          className={cn(
            'flex items-center gap-1 rounded-full px-2 py-0.5 typography-meta font-medium transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            completed
              ? 'bg-[rgb(var(--status-success)/0.1)] text-[var(--status-success)]'
              : 'text-muted-foreground hover:bg-interactive-hover/20 hover:text-foreground',
          )}
        >
          <RiCheckLine aria-hidden="true" className="h-3 w-3" />
          {completedLabel}
        </button>
      </div>
    </div>
  );
};
