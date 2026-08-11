-- Stores bounded, sanitized clipboard text separately from the metadata used by
-- analytics aggregation. These columns are intentionally nullable so existing
-- audit rows and older application versions remain compatible.
alter table public.activity_logs
  add column if not exists clipboard_text text,
  add column if not exists clipboard_text_preview text,
  add column if not exists clipboard_text_original_length integer,
  add column if not exists clipboard_text_truncated boolean,
  add column if not exists clipboard_text_redacted boolean;

alter table public.activity_logs
  drop constraint if exists activity_logs_clipboard_action_check,
  add constraint activity_logs_clipboard_action_check check (
    action = 'clipboard.copied'
    or (
      clipboard_text is null
      and clipboard_text_preview is null
      and clipboard_text_original_length is null
      and clipboard_text_truncated is null
      and clipboard_text_redacted is null
    )
  ),
  drop constraint if exists activity_logs_clipboard_text_size_check,
  add constraint activity_logs_clipboard_text_size_check check (
    clipboard_text is null or octet_length(clipboard_text) <= 65536
  ),
  drop constraint if exists activity_logs_clipboard_preview_size_check,
  add constraint activity_logs_clipboard_preview_size_check check (
    clipboard_text_preview is null or char_length(clipboard_text_preview) <= 512
  ),
  drop constraint if exists activity_logs_clipboard_original_length_check,
  add constraint activity_logs_clipboard_original_length_check check (
    clipboard_text_original_length is null
    or clipboard_text_original_length between 0 and 10000000
  );

comment on column public.activity_logs.clipboard_text is
  'Sanitized clipboard text retained for administrator-only per-user analytics, capped at 64 KiB.';
comment on column public.activity_logs.clipboard_text_preview is
  'First 512 characters of sanitized clipboard text for bounded interaction-list rendering.';
comment on column public.activity_logs.clipboard_text_original_length is
  'Original UTF-16 character count reported by the DevRyan renderer before truncation.';
comment on column public.activity_logs.clipboard_text_truncated is
  'True when the retained clipboard text does not contain the complete copied value.';
comment on column public.activity_logs.clipboard_text_redacted is
  'True when mandatory audit sanitization changed the copied value.';
