import React from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type ProviderFormValue = string | boolean;
export type ProviderFormAnswer = Readonly<Record<string, ProviderFormValue>>;

interface ProviderFormOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** A connect-method field as the native runtime describes it (see the facade's `toBrowserForm`). */
export interface ProviderFormField {
  readonly key: string;
  readonly type: 'string' | 'boolean';
  readonly title?: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly hidden?: boolean;
  readonly options?: readonly ProviderFormOption[];
  readonly when?: readonly { readonly key: string; readonly op: 'eq' | 'neq'; readonly value: unknown }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseOption = (value: unknown): ProviderFormOption | null => {
  if (!isRecord(value) || typeof value.value !== 'string' || typeof value.label !== 'string') return null;
  return { value: value.value, label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) };
};

/** Reads a method's `fields`; anything malformed leaves the method without a form. */
export const parseProviderFormFields = (value: unknown): ProviderFormField[] => {
  if (!Array.isArray(value)) return [];
  const fields: ProviderFormField[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || (entry.type !== 'string' && entry.type !== 'boolean')) return [];
    const options = Array.isArray(entry.options) ? entry.options.map(parseOption) : undefined;
    if (options?.some((option) => option === null)) return [];
    const when = Array.isArray(entry.when) ? entry.when.filter(isRecord).flatMap((rule): NonNullable<ProviderFormField['when']>[number][] => {
      const op = rule.op === 'eq' || rule.op === 'neq' ? rule.op : null;
      return typeof rule.key === 'string' && op ? [{ key: rule.key, op, value: rule.value }] : [];
    }) : undefined;
    fields.push({
      key: entry.key,
      type: entry.type,
      ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(typeof entry.placeholder === 'string' ? { placeholder: entry.placeholder } : {}),
      ...(entry.required === true ? { required: true } : {}),
      ...(entry.hidden === true ? { hidden: true } : {}),
      ...(options ? { options: options.filter((option): option is ProviderFormOption => option !== null) } : {}),
      ...(when ? { when } : {}),
    });
  }
  return fields;
};

const isActive = (field: ProviderFormField, answer: ProviderFormAnswer) => (field.when ?? [])
  .every((rule) => (rule.op === 'eq') === (answer[rule.key] === rule.value));

/** The answer to send: only fields still shown by earlier answers, without blanks. */
export const providerFormAnswer = (fields: readonly ProviderFormField[], answer: ProviderFormAnswer): Record<string, ProviderFormValue> | undefined => {
  if (fields.length === 0) return undefined;
  const result: Record<string, ProviderFormValue> = {};
  for (const field of fields) {
    const value = answer[field.key];
    if (!isActive(field, answer) || value === undefined || (typeof value === 'string' && !value.trim())) continue;
    result[field.key] = typeof value === 'string' ? value.trim() : value;
  }
  return result;
};

/** Every required field the current answers show is filled in. */
export const providerFormComplete = (fields: readonly ProviderFormField[], answer: ProviderFormAnswer) => {
  const sent = providerFormAnswer(fields, answer) ?? {};
  return fields.every((field) => !field.required || !isActive(field, answer) || sent[field.key] !== undefined);
};

export const ProviderMethodFields: React.FC<{
  fields: readonly ProviderFormField[];
  answer: ProviderFormAnswer;
  onChange: (next: ProviderFormAnswer) => void;
  disabled?: boolean;
}> = ({ fields, answer, onChange, disabled = false }) => {
  const visible = fields.filter((field) => !field.hidden && isActive(field, answer));
  if (visible.length === 0) return null;
  const set = (key: string, value: ProviderFormValue) => onChange({ ...answer, [key]: value });
  return (
    <div className="space-y-2">
      {visible.map((field) => {
        const label = field.title || field.key;
        const value = answer[field.key];
        return (
          <div key={field.key} className="space-y-1">
            {field.type === 'boolean' ? (
              <label className="typography-meta text-foreground flex items-center gap-2">
                <Checkbox checked={value === true} onChange={(checked) => set(field.key, checked)} disabled={disabled} ariaLabel={label} />
                {label}
              </label>
            ) : (
              <>
                <div className="typography-meta text-foreground">{label}{field.required ? ' *' : ''}</div>
                {field.options ? (
                  <Select value={typeof value === 'string' ? value : ''} onValueChange={(next) => set(field.key, String(next))} disabled={disabled}>
                    <SelectTrigger className="h-7 w-fit min-w-[200px]">
                      <SelectValue placeholder={field.placeholder ?? label}>
                        {(selected: string | undefined) => field.options?.find((option) => option.value === selected)?.label ?? field.placeholder ?? label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={typeof value === 'string' ? value : ''}
                    onChange={(event) => set(field.key, event.target.value)}
                    placeholder={field.placeholder}
                    disabled={disabled}
                    className="font-mono text-xs"
                  />
                )}
              </>
            )}
            {field.description && <div className="typography-meta text-muted-foreground">{field.description}</div>}
          </div>
        );
      })}
    </div>
  );
};
