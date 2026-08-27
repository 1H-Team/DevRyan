import React from 'react';
import { RiDeleteBinLine, RiImageAddLine, RiSaveLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BotSummary } from '@/lib/botsApi';
import { BotAvatar } from '@/components/bots/BotAvatar';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type BotProfileSaveRequest = {
  name: string;
  title: string;
  summary: string;
  avatar?: null | { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string };
};

export type BotProfileEdit = {
  request: BotProfileSaveRequest;
  dirty: boolean;
  valid: boolean;
};

type BotDetailsProps = {
  bot: BotSummary;
  readOnly?: boolean;
  saving?: boolean;
  error?: string | null;
  focusNameSignal?: number;
  showSaveAction?: boolean;
  onEditChange?: (edit: BotProfileEdit) => void;
  onSave?: (request: BotProfileSaveRequest) => void;
};

const formatDate = (value: string | null): string => (
  value ? new Date(value).toLocaleString() : '—'
);

export const BotStatusSummary: React.FC<{ bot: BotSummary }> = ({ bot }) => (
  <dl className="grid gap-px overflow-hidden rounded-xl border border-border/70 bg-border/70 sm:grid-cols-3">
    {[
      ['Status', bot.activeRevisionId ? bot.lifecycle : 'Setup Incomplete'],
      ['Created', formatDate(bot.createdAt)],
      ['Updated', formatDate(bot.updatedAt)],
    ].map(([label, value]) => (
      <div key={label} className="bg-background px-3 py-2.5">
        <dt className="typography-micro text-muted-foreground">{label}</dt>
        <dd className="mt-0.5 truncate typography-ui-label capitalize text-foreground">{value}</dd>
      </div>
    ))}
  </dl>
);

export const BotDetails: React.FC<BotDetailsProps> = ({
  bot,
  readOnly = false,
  saving = false,
  error = null,
  focusNameSignal = 0,
  showSaveAction = true,
  onEditChange,
  onSave,
}) => {
  const [name, setName] = React.useState(bot.name);
  const [title, setTitle] = React.useState(bot.title);
  const [avatar, setAvatar] = React.useState<BotProfileSaveRequest['avatar'] | undefined>();
  const [avatarPreview, setAvatarPreview] = React.useState<string | null>(null);
  const [avatarError, setAvatarError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const nameRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setName(bot.name);
    setTitle(bot.title);
    setAvatar(undefined);
    setAvatarPreview(null);
    setAvatarError(null);
  }, [bot.avatarFallback, bot.avatarUrl, bot.id, bot.name, bot.summary, bot.title]);

  React.useEffect(() => {
    if (focusNameSignal > 0) nameRef.current?.focus();
  }, [focusNameSignal]);

  const dirty = name.trim() !== bot.name
    || title.trim() !== bot.title
    || avatar !== undefined;
  const valid = name.trim().length > 0
    && name.trim().length <= 120
    && title.trim().length > 0
    && title.trim().length <= 160
    && !avatarError;
  const request = React.useMemo<BotProfileSaveRequest>(() => ({
    name: name.trim(),
    title: title.trim(),
    // Summary is retained for old clients and migrated records, but is no
    // longer a second user-authored description layer.
    summary: bot.summary,
    ...(avatar === undefined ? {} : { avatar }),
  }), [avatar, bot.summary, name, title]);

  React.useEffect(() => {
    onEditChange?.({ request, dirty, valid });
  }, [dirty, onEditChange, request, valid]);

  const selectAvatar = async (file: File | undefined) => {
    if (!file) return;
    if (!AVATAR_TYPES.has(file.type)) {
      setAvatarError('Choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError('Avatar images must be 5 MiB or smaller.');
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid image'));
      reader.onerror = () => reject(reader.error || new Error('Image could not be read'));
      reader.readAsDataURL(file);
    }).catch(() => '');
    const separator = dataUrl.indexOf(',');
    if (separator < 0) {
      setAvatarError('The selected image could not be read.');
      return;
    }
    setAvatar({
      contentType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
      dataBase64: dataUrl.slice(separator + 1),
    });
    setAvatarPreview(dataUrl);
    setAvatarError(null);
  };

  return (
    <section className="space-y-6" aria-labelledby="bot-overview-profile-heading">
      <div>
        <h3 id="bot-overview-profile-heading" className="typography-ui-header font-semibold text-foreground">Profile</h3>
        <p className="typography-ui text-muted-foreground">Set the identity people see in the catalog and chat.</p>
      </div>

      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!readOnly && dirty && valid) onSave?.(request);
        }}
      >
        <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="space-y-3">
            <BotAvatar
              bot={bot}
              imageUrl={avatar === null ? null : (avatarPreview ?? undefined)}
              className="h-40 w-40 rounded-2xl text-4xl shadow-[0_12px_36px_color-mix(in_srgb,var(--foreground)_8%,transparent)]"
            />
            {!readOnly ? (
              <div className="flex flex-wrap gap-2">
                <input
                  ref={inputRef}
                  type="file"
                  className="sr-only"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    void selectAvatar(file);
                  }}
                />
                <Button type="button" size="xs" variant="outline" onClick={() => inputRef.current?.click()}>
                  <RiImageAddLine className="h-3.5 w-3.5" aria-hidden />
                  {bot.avatarUrl || avatarPreview ? 'Replace' : 'Upload'}
                </Button>
                {bot.avatarUrl || avatarPreview ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setAvatar(null);
                      setAvatarPreview(null);
                      setAvatarError(null);
                      if (inputRef.current) inputRef.current.value = '';
                    }}
                  >
                    <RiDeleteBinLine className="h-3.5 w-3.5" aria-hidden /> Remove
                  </Button>
                ) : null}
              </div>
            ) : null}
            <p className="typography-micro text-muted-foreground">PNG, JPEG, or WebP · 5 MiB maximum · cover positioning</p>
            {avatarError ? <p role="alert" className="typography-micro text-[var(--status-error)]">{avatarError}</p> : null}
          </div>

          <fieldset disabled={readOnly} className="grid content-start gap-4">
            <div className="space-y-1.5 typography-meta text-muted-foreground">
              <label htmlFor="bot-profile-name">Name</label>
              <Input id="bot-profile-name" ref={nameRef} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
              <p className="typography-micro">Catalog and administrative identifier.</p>
            </div>
            <div className="space-y-1.5 typography-meta text-muted-foreground">
              <label htmlFor="bot-profile-description">Description</label>
              <Input id="bot-profile-description" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
              <p className="typography-micro">A short explanation of what this Bot does.</p>
            </div>
          </fieldset>
        </div>

        {error ? <p role="alert" className="typography-ui text-[var(--status-error)]">{error}</p> : null}
        {!readOnly && showSaveAction ? (
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!dirty || !valid || saving}>
              <RiSaveLine className="h-4 w-4" aria-hidden /> {saving ? 'Saving…' : 'Save Overview'}
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  );
};
