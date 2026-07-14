import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Checkbox } from '@/components/ui/checkbox';
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
  isResponseStylePreset,
  RESPONSE_STYLE_PRESETS,
  type ResponseStylePreset,
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

type ResponseStyleValue = ResponseStylePreset | 'custom';

type BehaviorSettingsState = {
  responseStyleEnabled: boolean;
  responseStylePreset: ResponseStyleValue;
  responseStyleCustomInstructions: string;
};

const DEFAULT_BEHAVIOR_SETTINGS: BehaviorSettingsState = {
  responseStyleEnabled: false,
  responseStylePreset: 'concise',
  responseStyleCustomInstructions: '',
};

const getResponseStylePreview = (preset: ResponseStyleValue, customInstructions: string) => {
  return preset === 'custom' ? customInstructions : getResponseStylePresetInstructions(preset);
};

const sanitizeResponseStylePreset = (value: unknown): ResponseStyleValue => {
  if (value === 'custom') return 'custom';
  return isResponseStylePreset(value) ? value : 'concise';
};

const RESPONSE_STYLE_OPTION_LABEL_KEYS: Record<ResponseStylePreset, I18nKey> = {
  concise: 'settings.behavior.page.responseStyle.option.concise',
  detailed: 'settings.behavior.page.responseStyle.option.detailed',
  mentor: 'settings.behavior.page.responseStyle.option.mentor',
  pushback: 'settings.behavior.page.responseStyle.option.pushback',
  noFiller: 'settings.behavior.page.responseStyle.option.noFiller',
  matchEnergy: 'settings.behavior.page.responseStyle.option.matchEnergy',
  warmPeer: 'settings.behavior.page.responseStyle.option.warmPeer',
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
  const [responseStyleEnabled, setResponseStyleEnabled] = React.useState(DEFAULT_BEHAVIOR_SETTINGS.responseStyleEnabled);
  const [responseStylePreset, setResponseStylePreset] = React.useState<ResponseStyleValue>(DEFAULT_BEHAVIOR_SETTINGS.responseStylePreset);
  const [responseStyleCustomInstructions, setResponseStyleCustomInstructions] = React.useState(DEFAULT_BEHAVIOR_SETTINGS.responseStyleCustomInstructions);
  const [isPromptLoading, setIsPromptLoading] = React.useState(true);
  const [isResponseStyleLoading, setIsResponseStyleLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [initialPrompt, setInitialPrompt] = React.useState('');
  const [promptEditable, setPromptEditable] = React.useState(false);
  const [promptLoadError, setPromptLoadError] = React.useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = React.useState<string | null>(null);
  const lastSavedResponseStyleRef = React.useRef<{
    enabled: boolean;
    preset: ResponseStyleValue;
    custom: string;
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
          responseStyleEnabled: data.responseStyleEnabled === true,
          responseStylePreset: sanitizeResponseStylePreset(data.responseStylePreset),
          responseStyleCustomInstructions: typeof data.responseStyleCustomInstructions === 'string'
            ? data.responseStyleCustomInstructions
            : '',
        };
      } catch (error) {
        if (abort.signal.aborted || (error as Error).name === 'AbortError') return;
        console.warn('Failed to load response style settings:', error);
      } finally {
        if (!abort.signal.aborted) {
          setResponseStyleEnabled(nextSettings.responseStyleEnabled);
          setResponseStylePreset(nextSettings.responseStylePreset);
          setResponseStyleCustomInstructions(nextSettings.responseStyleCustomInstructions);
          lastSavedResponseStyleRef.current = {
            enabled: nextSettings.responseStyleEnabled,
            preset: nextSettings.responseStylePreset,
            custom: nextSettings.responseStyleCustomInstructions,
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
    if (
      last &&
      last.enabled === responseStyleEnabled &&
      last.preset === responseStylePreset &&
      last.custom === responseStyleCustomInstructions
    ) {
      return;
    }

    const next = {
      enabled: responseStyleEnabled,
      preset: responseStylePreset,
      custom: responseStyleCustomInstructions,
    };

    const timer = setTimeout(async () => {
      try {
        await saveBehaviorSetting({
          responseStyleEnabled: next.enabled,
          responseStylePreset: next.preset,
          responseStyleCustomInstructions: next.custom,
        }, t('settings.behavior.page.toast.saveFailed'));
        lastSavedResponseStyleRef.current = next;
      } catch (error) {
        const message = error instanceof Error ? error.message : t('settings.behavior.page.toast.saveFailed');
        toast.error(message);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [responseStyleEnabled, responseStylePreset, responseStyleCustomInstructions, isResponseStyleLoading, t]);

  const responseStylePreview = getResponseStylePreview(responseStylePreset, responseStyleCustomInstructions);
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
            <label className="flex items-center gap-2 typography-ui-label text-foreground">
              <Checkbox
                checked={responseStyleEnabled}
                onChange={setResponseStyleEnabled}
                disabled={isResponseStyleLoading}
                ariaLabel={t('settings.behavior.page.responseStyle.enableAria')}
              />
              {t('settings.behavior.page.responseStyle.enable')}
            </label>

            <Select<ResponseStyleValue>
              value={responseStylePreset}
              onValueChange={(value) => setResponseStylePreset(value)}
              disabled={isResponseStyleLoading || !responseStyleEnabled}
            >
              <SelectTrigger className="w-full sm:w-56" size="lg">
                <SelectValue>
                  {(value) => {
                    if (value === 'custom') return t('settings.behavior.page.responseStyle.option.custom');
                    if (isResponseStylePreset(value)) return t(RESPONSE_STYLE_OPTION_LABEL_KEYS[value]);
                    return null;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RESPONSE_STYLE_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {t(RESPONSE_STYLE_OPTION_LABEL_KEYS[preset])}
                  </SelectItem>
                ))}
                <SelectItem value="custom">
                  {t('settings.behavior.page.responseStyle.option.custom')}
                </SelectItem>
              </SelectContent>
            </Select>

            <Textarea
              value={responseStylePreview}
              onChange={(event) => setResponseStyleCustomInstructions(event.target.value)}
              placeholder={t('settings.behavior.page.responseStyle.customPlaceholder')}
              rows={5}
              disabled={isResponseStyleLoading || !responseStyleEnabled || responseStylePreset !== 'custom'}
              outerClassName="min-h-[120px]"
              className="w-full font-mono typography-meta bg-transparent"
            />
          </section>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
