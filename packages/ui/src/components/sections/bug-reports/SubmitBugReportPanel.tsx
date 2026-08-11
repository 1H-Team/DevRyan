import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea, TextareaCharCounter } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

import { submitBugReport } from './api';

const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 20_000;

const newSubmissionId = (): string => crypto.randomUUID();

export const SubmitBugReportPanel: React.FC = () => {
  const { t } = useI18n();
  const [submissionId, setSubmissionId] = React.useState(newSubmissionId);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await submitBugReport({ id: submissionId, title, description });
        setTitle('');
        setDescription('');
        setSubmissionId(newSubmissionId());
        toast.success(t('settings.bugReports.submit.success'));
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        setError(message);
        toast.error(message);
      } finally {
        setSubmitting(false);
      }
    },
    [description, submissionId, submitting, t, title],
  );

  return (
    <section aria-labelledby="submit-bug-report-heading" className="space-y-5">
      <div className="space-y-1">
        <h2 id="submit-bug-report-heading" className="typography-ui-header font-semibold text-foreground">
          {t('settings.bugReports.submit.title')}
        </h2>
        <p className="typography-meta text-muted-foreground">{t('settings.bugReports.submit.description')}</p>
      </div>

      <form className="space-y-5" onSubmit={(event) => void submit(event)}>
        <label className="block space-y-2 typography-meta text-foreground">
          <span>{t('settings.bugReports.submit.field.title')}</span>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('settings.bugReports.submit.field.titlePlaceholder')}
            maxLength={TITLE_LIMIT}
            required
            disabled={submitting}
            aria-invalid={error ? true : undefined}
          />
          <span className="block text-right typography-micro text-muted-foreground">
            {t('settings.bugReports.submit.characterCount', { count: title.length, maximum: TITLE_LIMIT })}
          </span>
        </label>

        <label className="block space-y-2 typography-meta text-foreground">
          <span>{t('settings.bugReports.submit.field.description')}</span>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('settings.bugReports.submit.field.descriptionPlaceholder')}
            maxLength={DESCRIPTION_LIMIT}
            required
            disabled={submitting}
            hasError={Boolean(error)}
            outerClassName="min-h-44"
            endSlot={<TextareaCharCounter current={description.length} max={DESCRIPTION_LIMIT} />}
          />
        </label>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)]"
          >
            {error}
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={submitting || !title.trim() || !description.trim()}>
            {submitting ? t('settings.bugReports.submit.submitting') : t('settings.bugReports.submit.action')}
          </Button>
        </div>
      </form>
    </section>
  );
};
