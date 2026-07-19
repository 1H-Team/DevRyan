import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RiInformationLine } from '@remixicon/react';
import {
  getResponseStylePresetInstructions,
  isResponseStyleLevel,
  resolveResponseStyleLevel,
  RESPONSE_STYLE_LEVELS,
  type ResponseStyleLevel,
} from '@/lib/responseStyle';
import type { DesktopSettings } from '@/lib/desktop';
import {
  isGlobalAgentsMdSaveWarning,
  loadGlobalAgentsMd,
  saveGlobalAgentsMd,
} from './globalAgentsMdApi';

const AGENTS_MD_PATH = '~/.config/opencode/AGENTS.md';

const readApiError = async (response: Response, fallback: string) => {
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error.trim() ? data.error : fallback;
};

type BehaviorSettingsState = {
  responseStyleLevel: ResponseStyleLevel;
};

const DEFAULT_BEHAVIOR_SETTINGS: BehaviorSettingsState = {
  responseStyleLevel: 'provider',
};

const RESPONSE_STYLE_OPTION_LABEL_KEYS: Record<ResponseStyleLevel, I18nKey> = {
  provider: 'settings.behavior.page.responseStyle.option.provider',
  actions: 'settings.behavior.page.responseStyle.option.actions',
  concise: 'settings.behavior.page.responseStyle.option.concise',
  detailed: 'settings.behavior.page.responseStyle.option.detailed',
};

const RESPONSE_STYLE_OPTION_DESCRIPTION_KEYS: Record<ResponseStyleLevel, I18nKey> = {
  provider: 'settings.behavior.page.responseStyle.description.provider',
  actions: 'settings.behavior.page.responseStyle.description.actions',
  concise: 'settings.behavior.page.responseStyle.description.concise',
  detailed: 'settings.behavior.page.responseStyle.description.detailed',
};

const saveBehaviorSetting = async (settings: Partial<DesktopSettings>, fallbackError: string) => {
  const response = await fetch('/api/config/settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, fallbackError));
  }
};

export const BehaviorPage: React.FC = () => {
  const { t } = useI18n();
  const [prompt, setPrompt] = React.useState('');
  const [responseStyleLevel, setResponseStyleLevel] = React.useState<ResponseStyleLevel>(DEFAULT_BEHAVIOR_SETTINGS.responseStyleLevel);
  const [isPromptLoading, setIsPromptLoading] = React.useState(true);
  const [isResponseStyleLoading, setIsResponseStyleLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [initialPrompt, setInitialPrompt] = React.useState('');
  const [promptEditable, setPromptEditable] = React.useState(false);
  const [promptLoadError, setPromptLoadError] = React.useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = React.useState<string | null>(null);
  const lastSavedResponseStyleRef = React.useRef<{
    level: ResponseStyleLevel;
  } | null>(null);

  const loadPrompt = React.useCallback(async (signal?: AbortSignal) => {
    setIsPromptLoading(true);
    setPromptLoadError(null);

    try {
      const document = await loadGlobalAgentsMd({ signal });
      if (signal?.aborted) return;
      setPrompt(document.content);
      setInitialPrompt(document.content);
      setPromptEditable(document.editable);
      setUnavailableReason(document.unavailableReason ?? null);
    } catch (error) {
      if (signal?.aborted || (error as Error).name === 'AbortError') return;
      console.warn('Failed to load global AGENTS.md:', error);
      setPromptEditable(false);
      setUnavailableReason(null);
      setPromptLoadError(error instanceof Error ? error.message : t('settings.behavior.page.loadFailed'));
    } finally {
      if (!signal?.aborted) {
        setIsPromptLoading(false);
      }
    }
  }, [t]);

  React.useEffect(() => {
    const abort = new AbortController();
    void loadPrompt(abort.signal);
    return () => abort.abort();
  }, [loadPrompt]);

  React.useEffect(() => {
    const abort = new AbortController();

    const loadResponseStyle = async () => {
      let nextSettings: BehaviorSettingsState = DEFAULT_BEHAVIOR_SETTINGS;
      try {
        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(await readApiError(response, t('settings.behavior.page.toast.loadResponseStyleFailed')));
        }

        const data = await response.json();
        nextSettings = {
          responseStyleLevel: resolveResponseStyleLevel(data),
        };
      } catch (error) {
        if (abort.signal.aborted || (error as Error).name === 'AbortError') return;
        console.warn('Failed to load response style settings:', error);
      } finally {
        if (!abort.signal.aborted) {
          setResponseStyleLevel(nextSettings.responseStyleLevel);
          lastSavedResponseStyleRef.current = {
            level: nextSettings.responseStyleLevel,
          };
          setIsResponseStyleLoading(false);
        }
      }
    };

    void loadResponseStyle();
    return () => abort.abort();
  }, [t]);

  React.useEffect(() => {
    if (isResponseStyleLoading) return;
    const last = lastSavedResponseStyleRef.current;
    if (last?.level === responseStyleLevel) {
      return;
    }

    const next = { level: responseStyleLevel };

    const timer = setTimeout(async () => {
      try {
        await saveBehaviorSetting({
          responseStyleEnabled: next.level !== 'provider',
          responseStylePreset: next.level === 'provider' ? 'concise' : next.level,
        }, t('settings.behavior.page.toast.saveFailed'));
        lastSavedResponseStyleRef.current = next;
      } catch (error) {
        const message = error instanceof Error ? error.message : t('settings.behavior.page.toast.saveFailed');
        toast.error(message);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [responseStyleLevel, isResponseStyleLoading, t]);

  const isPromptDirty = prompt !== initialPrompt;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const result = await saveGlobalAgentsMd(prompt);
      setPrompt(result.content);
      setInitialPrompt(result.content);
      setPromptEditable(result.editable);
      setUnavailableReason(result.unavailableReason ?? null);
      if (isGlobalAgentsMdSaveWarning(result)) {
        toast.warning(t('settings.behavior.page.toast.savedRuntimeWarning'), {
          description: result.warning,
        });
      } else {
        toast.success(t('settings.behavior.page.toast.saved'));
      }
    } catch (error) {
      console.error('Failed to save global AGENTS.md:', error);
      const message = error instanceof Error ? error.message : t('settings.behavior.page.toast.saveFailed');
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8 space-y-6">
        <div className="space-y-1">
          <h2 className="typography-ui-header font-semibold text-foreground">
            {t('settings.behavior.page.title')}
          </h2>
        </div>

        <div>
          <div className="mb-1 px-1">
            <div className="flex items-center gap-1.5">
              <h3 className="typography-ui-header font-medium text-foreground">
                {t('settings.behavior.page.section.systemPrompt')}
              </h3>
              <Tooltip>
                <TooltipTrigger asChild>
                  <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      {t('settings.behavior.page.warning.title')}
                    </p>
                    <p>
                      {t('settings.behavior.page.warning.description', { path: AGENTS_MD_PATH })}
                    </p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-3">
            {promptLoadError && (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="typography-ui-label text-foreground">
                    {t('settings.behavior.page.loadFailed')}
                  </p>
                  <p className="typography-meta break-words text-muted-foreground">
                    {promptLoadError}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0 !font-normal"
                  onClick={() => void loadPrompt()}
                  disabled={isPromptLoading}
                >
                  {t('settings.behavior.page.actions.retry')}
                </Button>
              </div>
            )}
            {!promptLoadError && !isPromptLoading && !promptEditable && unavailableReason && (
              <div
                role="status"
                className="rounded-md border border-border bg-[var(--surface-muted)] px-3 py-2"
              >
                <p className="typography-ui-label text-foreground">
                  {t('settings.behavior.page.unavailable.title')}
                </p>
                <p className="typography-meta text-muted-foreground">
                  {unavailableReason}
                </p>
              </div>
            )}
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('settings.behavior.page.field.systemPromptPlaceholder')}
              rows={12}
              disabled={isPromptLoading || !promptEditable || Boolean(promptLoadError)}
              outerClassName="min-h-[160px] max-h-[70vh]"
              className="w-full font-mono typography-meta bg-transparent"
            />
            <Button
              onClick={handleSave}
              disabled={isSaving || !isPromptDirty || isPromptLoading || !promptEditable || Boolean(promptLoadError)}
              size="xs"
              className="!font-normal"
            >
              {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
            </Button>
          </section>
        </div>

        <div>
          <div className="mb-1 px-1">
            <div className="flex items-center gap-1.5">
              <h3 className="typography-ui-header font-medium text-foreground">
                {t('settings.behavior.page.section.responseStyle')}
              </h3>
              <Tooltip>
                <TooltipTrigger asChild>
                  <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {t('settings.behavior.page.responseStyle.tooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-3">
            <Select<ResponseStyleLevel>
              value={responseStyleLevel}
              onValueChange={setResponseStyleLevel}
              disabled={isResponseStyleLoading}
            >
              <SelectTrigger className="w-full" size="lg" aria-label={t('settings.behavior.page.responseStyle.preset')}>
                <SelectValue>
                  {(value) => isResponseStyleLevel(value) ? t(RESPONSE_STYLE_OPTION_LABEL_KEYS[value]) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RESPONSE_STYLE_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(RESPONSE_STYLE_OPTION_LABEL_KEYS[level])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="rounded-md border border-border/70 bg-[var(--surface-muted)] px-3 py-2.5">
              <p className="typography-ui-label text-foreground">
                {t(RESPONSE_STYLE_OPTION_LABEL_KEYS[responseStyleLevel])}
              </p>
              <p className="typography-meta mt-0.5 text-muted-foreground">
                {t(RESPONSE_STYLE_OPTION_DESCRIPTION_KEYS[responseStyleLevel])}
              </p>
              {responseStyleLevel !== 'provider' ? (
                <p className="typography-meta mt-2 border-t border-border/60 pt-2 text-muted-foreground/80">
                  {getResponseStylePresetInstructions(responseStyleLevel)}
                </p>
              ) : null}
            </div>
          </section>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
