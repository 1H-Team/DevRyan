import React from 'react';
import { RiAddLine, RiDeleteBinLine, RiShieldCheckLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Textarea } from '@/components/ui/textarea';
import type { BotActionPolicyRule, BotRevisionContract } from '@/lib/botsApi';

type PolicyValue = Pick<BotRevisionContract, 'actionPolicy' | 'browserPolicy' | 'computerPolicy' | 'memoryPolicy'>;

type ArgumentPredicate = NonNullable<BotActionPolicyRule['match']['argumentPredicates']>[number];

const lines = (value: string): string[] => value
  .split('\n')
  .map((entry) => entry.trim())
  .filter(Boolean);

const joined = (value: readonly string[] | undefined): string => (value || []).join('\n');

const predicateValue = (predicate: ArgumentPredicate): string => {
  if (predicate.op === 'exists') return '';
  if (typeof predicate.value === 'string') return predicate.value;
  return JSON.stringify(predicate.value);
};

const defaultPredicateValue = (op: ArgumentPredicate['op']): unknown => {
  if (op === 'exists') return undefined;
  if (op === 'in') return [];
  if (op === 'gte' || op === 'lte') return 0;
  return '';
};

const parsePredicateValue = (
  op: ArgumentPredicate['op'],
  source: string,
): { valid: true; value?: unknown } | { valid: false; message: string } => {
  if (op === 'exists') return { valid: true };
  if (['prefix', 'suffix', 'glob'].includes(op)) return { valid: true, value: source };
  if (op === 'gte' || op === 'lte') {
    const value = Number(source);
    return Number.isFinite(value)
      ? { valid: true, value }
      : { valid: false, message: 'Enter a finite number.' };
  }
  try {
    const value: unknown = JSON.parse(source);
    if (op === 'in' && !Array.isArray(value)) {
      return { valid: false, message: 'The in operator requires a JSON array.' };
    }
    return { valid: true, value };
  } catch {
    return { valid: false, message: 'Enter a valid JSON value.' };
  }
};

const ruleSummary = (rule: BotActionPolicyRule): string => {
  const dimensions = [
    rule.match.tool ? `tool ${rule.match.tool}` : null,
    rule.match.actions?.length ? `${rule.match.actions.length} action${rule.match.actions.length === 1 ? '' : 's'}` : null,
    rule.match.origins?.length ? `${rule.match.origins.length} origin${rule.match.origins.length === 1 ? '' : 's'}` : null,
    rule.match.actorRoles?.length ? `roles ${rule.match.actorRoles.join(' or ')}` : null,
    rule.match.urlPathGlobs?.length ? `${rule.match.urlPathGlobs.length} URL path glob${rule.match.urlPathGlobs.length === 1 ? '' : 's'}` : null,
    rule.match.filePaths?.globs.length ? `${rule.match.filePaths.quantifier} file path` : null,
    rule.match.argumentPredicates?.length ? `${rule.match.argumentPredicates.length} argument predicate${rule.match.argumentPredicates.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const quota = rule.quota
    ? `; at most ${rule.quota.limit} per ${rule.quota.windowSeconds}s by ${rule.quota.scope}`
    : '';
  return `${rule.effect.toUpperCase()} ${dimensions.join(' + ') || 'every action'}${quota}.`;
};

const PredicateEditor: React.FC<{
  value: ArgumentPredicate;
  readOnly: boolean;
  onChange: (value: ArgumentPredicate) => void;
  onRemove: () => void;
}> = ({ value, readOnly, onChange, onRemove }) => {
  const [source, setSource] = React.useState(() => predicateValue(value));
  const parsed = parsePredicateValue(value.op, source);

  React.useEffect(() => setSource(predicateValue(value)), [value]);

  const commit = () => {
    if (!parsed.valid) return;
    onChange({
      pointer: value.pointer,
      op: value.op,
      ...(value.op === 'exists' ? {} : { value: parsed.value }),
    });
  };

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-background/55 p-2 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1.2fr)_auto] sm:items-start">
      <label className="space-y-1 typography-meta text-muted-foreground">
        <span>JSON Pointer</span>
        <Input value={value.pointer} placeholder="/recipient/email" onChange={(event) => onChange({ ...value, pointer: event.target.value })} />
      </label>
      <label className="space-y-1 typography-meta text-muted-foreground">
        <span>Operator</span>
        <select
          value={value.op}
          disabled={readOnly}
          onChange={(event) => {
            const op = event.target.value as ArgumentPredicate['op'];
            const nextValue = defaultPredicateValue(op);
            const next = { pointer: value.pointer, op, ...(op === 'exists' ? {} : { value: nextValue }) };
            setSource(predicateValue(next));
            onChange(next);
          }}
          className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
        >
          {(['exists', 'eq', 'in', 'prefix', 'suffix', 'glob', 'gte', 'lte', 'arrayContains'] as const).map((op) => <option key={op} value={op}>{op}</option>)}
        </select>
      </label>
      {value.op === 'exists' ? (
        <p className="pt-6 typography-micro text-muted-foreground">No comparison value.</p>
      ) : (
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>{['prefix', 'suffix', 'glob'].includes(value.op) ? 'Text Value' : 'JSON Value'}</span>
          <Input
            value={source}
            aria-invalid={!parsed.valid}
            onChange={(event) => setSource(event.target.value)}
            onBlur={commit}
          />
          {!parsed.valid ? <span className="block typography-micro text-[var(--status-error)]">{parsed.message}</span> : null}
        </label>
      )}
      {!readOnly ? (
        <Button type="button" size="icon" variant="ghost" className="mt-5 h-8 w-8 text-[var(--status-error)]" aria-label="Remove Argument Predicate" onClick={onRemove}>
          <RiDeleteBinLine className="h-3.5 w-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
};

const defaultRule = (index: number): BotActionPolicyRule => ({
  id: `rule.${index + 1}`,
  effect: 'prompt',
  risk: 'sensitive',
  match: { operationKinds: ['write'] },
  retainEvidence: false,
  ttlSeconds: 900,
});

export type BotPolicyEditorProps = {
  value: PolicyValue;
  readOnly?: boolean;
  onChange: (value: PolicyValue) => void;
};

export const BotPolicyEditor: React.FC<BotPolicyEditorProps> = ({
  value,
  readOnly = false,
  onChange,
}) => {
  const matcherV2 = value.actionPolicy.matcherVersion === 2;
  const updateActionPolicy = (changes: Partial<PolicyValue['actionPolicy']>) => {
    onChange({ ...value, actionPolicy: { ...value.actionPolicy, ...changes } });
  };
  const setMatcherV2 = (enabled: boolean) => {
    if (enabled) {
      updateActionPolicy({ matcherVersion: 2 });
      return;
    }
    const rules = value.actionPolicy.rules.map((rule) => {
      const {
        actorRoles,
        urlPathGlobs,
        filePaths,
        argumentPredicates,
        ...legacyMatch
      } = rule.match;
      void actorRoles;
      void urlPathGlobs;
      void filePaths;
      void argumentPredicates;
      const { quota, ...legacyRule } = rule;
      void quota;
      return { ...legacyRule, match: legacyMatch };
    });
    const { matcherVersion, ...legacyPolicy } = value.actionPolicy;
    void matcherVersion;
    onChange({ ...value, actionPolicy: { ...legacyPolicy, rules } });
  };
  const updateRule = (index: number, rule: BotActionPolicyRule) => {
    const rules = [...value.actionPolicy.rules];
    rules[index] = rule;
    updateActionPolicy({ rules });
  };
  const memory = value.memoryPolicy as {
    retrievalLimit?: number;
    automaticExtraction?: boolean;
  };
  const networkAccess = value.browserPolicy.networkAccess || { mode: 'public_only' as const, hosts: [] };
  const isolationTier = value.computerPolicy?.isolationTier || 'standard';

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-[var(--surface-subtle)]/35 p-3">
        <RiShieldCheckLine className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <h4 className="typography-ui-label font-medium text-foreground">Guarded action policy</h4>
          <p className="typography-micro text-muted-foreground">
            Ordinary bounded actions follow your default. Hard safety rules still deny unbounded work and prompt for critical irreversible actions.
          </p>
        </div>
      </div>

      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>Default Action</span>
          <select
            value={value.actionPolicy.defaultEffect}
            onChange={(event) => updateActionPolicy({
              defaultEffect: event.target.value as PolicyValue['actionPolicy']['defaultEffect'],
            })}
            className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
          >
            <option value="deny">Deny</option>
            <option value="prompt">Prompt</option>
            <option value="allow">Allow</option>
          </select>
        </label>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>Default Risk</span>
          <select
            value={value.actionPolicy.defaultRisk}
            onChange={(event) => updateActionPolicy({
              defaultRisk: event.target.value as PolicyValue['actionPolicy']['defaultRisk'],
            })}
            className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
          >
            <option value="low">Low</option>
            <option value="sensitive">Sensitive</option>
            <option value="critical">Critical</option>
          </select>
        </label>
      </fieldset>
      <fieldset disabled={readOnly} className="rounded-lg border border-border/70 p-3">
        <label className="inline-flex items-start gap-2 text-foreground">
          <Checkbox checked={matcherV2} onChange={(checked) => setMatcherV2(checked === true)} />
          <span>
            <span className="block typography-ui-label font-medium">Structured Matcher v2</span>
            <span className="block typography-micro text-muted-foreground">Adds Bounded Role, URL Path, File Path, Argument, and Quota Conditions. No Expressions or Executable Policy.</span>
          </span>
        </label>
      </fieldset>
      {value.actionPolicy.defaultEffect === 'allow' ? (
        <p className="rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 p-3 typography-ui text-foreground">
          Broad Allow lets ordinary bounded actions run automatically. Critical payments, destructive changes, credential export, access changes, and production publication still require review.
        </p>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="typography-ui-label font-medium text-foreground">Reviewed action rules</h4>
            <p className="typography-micro text-muted-foreground">Rules bind tool, operation, origin, risk, and evidence.</p>
          </div>
          {!readOnly ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => updateActionPolicy({
                rules: [...value.actionPolicy.rules, defaultRule(value.actionPolicy.rules.length)],
              })}
            >
              <RiAddLine className="h-3.5 w-3.5" aria-hidden /> Add Rule
            </Button>
          ) : null}
        </div>
        {value.actionPolicy.rules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 typography-ui text-muted-foreground">
            No explicit rules. The default decision applies to every action.
          </p>
        ) : value.actionPolicy.rules.map((rule, index) => (
          <fieldset
            key={`${rule.id}-${index}`}
            disabled={readOnly}
            className="grid gap-2 rounded-lg border border-border/70 p-3 sm:grid-cols-2"
          >
            <p className="rounded-md bg-[var(--surface-subtle)] px-2 py-1.5 font-mono typography-micro text-foreground sm:col-span-2">
              {ruleSummary(rule)}
            </p>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Rule ID</span>
              <Input
                value={rule.id}
                onChange={(event) => updateRule(index, { ...rule, id: event.target.value })}
              />
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Tool</span>
              <Input
                value={rule.match.tool || ''}
                placeholder="browser"
                onChange={(event) => updateRule(index, {
                  ...rule,
                  match: { ...rule.match, tool: event.target.value || undefined },
                })}
              />
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Decision</span>
              <select
                value={rule.effect}
                onChange={(event) => updateRule(index, {
                  ...rule,
                  effect: event.target.value as BotActionPolicyRule['effect'],
                })}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
              >
                <option value="deny">Deny</option>
                <option value="prompt">Prompt</option>
                <option value="allow">Allow</option>
              </select>
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Risk</span>
              <select
                value={rule.risk}
                onChange={(event) => updateRule(index, {
                  ...rule,
                  risk: event.target.value as BotActionPolicyRule['risk'],
                })}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
              >
                <option value="low">Low</option>
                <option value="sensitive">Sensitive</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Actions · One per Line</span>
              <Textarea
                rows={3}
                value={joined(rule.match.actions)}
                onChange={(event) => updateRule(index, {
                  ...rule,
                  match: { ...rule.match, actions: lines(event.target.value) },
                })}
              />
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Origins · One per Line</span>
              <Textarea
                rows={3}
                value={joined(rule.match.origins)}
                onChange={(event) => updateRule(index, {
                  ...rule,
                  match: { ...rule.match, origins: lines(event.target.value) },
                })}
              />
            </label>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
              {(['read', 'write'] as const).map((kind) => (
                <label key={kind} className="inline-flex items-center gap-2 typography-ui-label text-foreground">
                  <Checkbox
                    checked={rule.match.operationKinds?.includes(kind) || false}
                    onChange={(checked) => {
                      const current = new Set(rule.match.operationKinds || []);
                      if (checked) current.add(kind); else current.delete(kind);
                      updateRule(index, {
                        ...rule,
                        match: { ...rule.match, operationKinds: [...current] },
                      });
                    }}
                  />
                  {kind} Operations
                </label>
              ))}
              <label className="inline-flex items-center gap-2 typography-ui-label text-foreground">
                <Checkbox
                  checked={rule.retainEvidence === true}
                  onChange={(checked) => updateRule(index, {
                    ...rule,
                    retainEvidence: checked === true,
                  })}
                />
                Retain Bounded Evidence
              </label>
              {!readOnly ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="ml-auto text-[var(--status-error)]"
                  onClick={() => updateActionPolicy({
                    rules: value.actionPolicy.rules.filter((_, rowIndex) => rowIndex !== index),
                  })}
                >
                  <RiDeleteBinLine className="h-3.5 w-3.5" aria-hidden /> Remove
                </Button>
              ) : null}
            </div>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Approval Lifetime · Seconds</span>
              <NumberInput
                min={30}
                max={86_400}
                value={rule.ttlSeconds || 900}
                onValueChange={(ttlSeconds) => updateRule(index, { ...rule, ttlSeconds })}
              />
            </label>
            {matcherV2 ? (
              <div className="space-y-3 rounded-lg border border-border/60 bg-[var(--surface-subtle)]/25 p-3 sm:col-span-2">
                <div>
                  <h5 className="typography-ui-label font-medium text-foreground">Structured conditions</h5>
                  <p className="typography-micro text-muted-foreground">Every populated dimension must match. Entries within one list are alternatives.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <fieldset className="space-y-2 rounded-lg border border-border/60 p-2">
                    <legend className="px-1 typography-meta text-muted-foreground">Actor roles</legend>
                    <div className="flex flex-wrap gap-3">
                      {(['member', 'operator', 'manager'] as const).map((role) => (
                        <label key={role} className="inline-flex items-center gap-2 typography-ui-label capitalize text-foreground">
                          <Checkbox
                            checked={rule.match.actorRoles?.includes(role) || false}
                            onChange={(checked) => {
                              const roles = new Set(rule.match.actorRoles || []);
                              if (checked) roles.add(role); else roles.delete(role);
                              updateRule(index, { ...rule, match: { ...rule.match, actorRoles: [...roles] } });
                            }}
                          />
                          {role}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="space-y-1 typography-meta text-muted-foreground">
                    <span>URL Path Globs · One per Line</span>
                    <Textarea
                      rows={3}
                      placeholder={'/billing/**\n/reports/????'}
                      value={joined(rule.match.urlPathGlobs)}
                      onChange={(event) => updateRule(index, {
                        ...rule,
                        match: { ...rule.match, urlPathGlobs: lines(event.target.value) },
                      })}
                    />
                  </label>
                  <div className="grid gap-2 rounded-lg border border-border/60 p-2 sm:grid-cols-[8rem_1fr]">
                    <label className="space-y-1 typography-meta text-muted-foreground">
                      <span>File Match</span>
                      <select
                        value={rule.match.filePaths?.quantifier || 'any'}
                        onChange={(event) => updateRule(index, {
                          ...rule,
                          match: {
                            ...rule.match,
                            filePaths: {
                              quantifier: event.target.value as 'any' | 'all',
                              globs: rule.match.filePaths?.globs || [],
                            },
                          },
                        })}
                        className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
                      >
                        <option value="any">Any File</option>
                        <option value="all">All Files</option>
                      </select>
                    </label>
                    <label className="space-y-1 typography-meta text-muted-foreground">
                      <span>Virtual File Globs · One per Line</span>
                      <Textarea
                        rows={3}
                        placeholder={'/workspace/docs/**\n/computer/exports/*.pdf'}
                        value={joined(rule.match.filePaths?.globs)}
                        onChange={(event) => {
                          const globs = lines(event.target.value);
                          const nextMatch = { ...rule.match };
                          if (globs.length === 0) delete nextMatch.filePaths;
                          else nextMatch.filePaths = {
                            quantifier: rule.match.filePaths?.quantifier || 'any',
                            globs,
                          };
                          updateRule(index, { ...rule, match: nextMatch });
                        }}
                      />
                    </label>
                  </div>
                  <fieldset className="grid gap-2 rounded-lg border border-border/60 p-2 sm:grid-cols-3">
                    <legend className="px-1 typography-meta text-muted-foreground">Per-rule hard quota</legend>
                    <label className="inline-flex items-center gap-2 typography-ui-label text-foreground sm:col-span-3">
                      <Checkbox
                        checked={Boolean(rule.quota)}
                        onChange={(checked) => {
                          if (checked) updateRule(index, { ...rule, quota: { scope: 'actor', limit: 10, windowSeconds: 3_600 } });
                          else {
                            const { quota, ...withoutQuota } = rule;
                            void quota;
                            updateRule(index, withoutQuota);
                          }
                        }}
                      />
                      Reserve and Consume Quota Before Execution
                    </label>
                    {rule.quota ? (
                      <>
                        <label className="space-y-1 typography-meta text-muted-foreground">
                          <span>Scope</span>
                          <select
                            value={rule.quota.scope}
                            onChange={(event) => updateRule(index, { ...rule, quota: { ...rule.quota!, scope: event.target.value as 'actor' | 'bot' } })}
                            className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
                          >
                            <option value="actor">Per Actor</option>
                            <option value="bot">Whole Bot</option>
                          </select>
                        </label>
                        <label className="space-y-1 typography-meta text-muted-foreground">
                          <span>Limit</span>
                          <NumberInput min={1} max={100_000} value={rule.quota.limit} onValueChange={(limit) => updateRule(index, { ...rule, quota: { ...rule.quota!, limit } })} />
                        </label>
                        <label className="space-y-1 typography-meta text-muted-foreground">
                          <span>Window · Seconds</span>
                          <NumberInput min={1} max={2_592_000} value={rule.quota.windowSeconds} onValueChange={(windowSeconds) => updateRule(index, { ...rule, quota: { ...rule.quota!, windowSeconds } })} />
                        </label>
                      </>
                    ) : null}
                  </fieldset>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h5 className="typography-ui-label font-medium text-foreground">Argument predicates</h5>
                    {!readOnly ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => updateRule(index, {
                          ...rule,
                          match: {
                            ...rule.match,
                            argumentPredicates: [...(rule.match.argumentPredicates || []), { pointer: '', op: 'exists' }],
                          },
                        })}
                      >
                        <RiAddLine className="h-3.5 w-3.5" aria-hidden /> Add Predicate
                      </Button>
                    ) : null}
                  </div>
                  {(rule.match.argumentPredicates || []).map((predicate, predicateIndex) => (
                    <PredicateEditor
                      key={`${predicate.pointer}-${predicateIndex}`}
                      value={predicate}
                      readOnly={readOnly}
                      onChange={(nextPredicate) => {
                        const argumentPredicates = [...(rule.match.argumentPredicates || [])];
                        argumentPredicates[predicateIndex] = nextPredicate;
                        updateRule(index, { ...rule, match: { ...rule.match, argumentPredicates } });
                      }}
                      onRemove={() => {
                        const argumentPredicates = (rule.match.argumentPredicates || []).filter((_, rowIndex) => rowIndex !== predicateIndex);
                        const nextMatch = { ...rule.match };
                        if (argumentPredicates.length === 0) delete nextMatch.argumentPredicates;
                        else nextMatch.argumentPredicates = argumentPredicates;
                        updateRule(index, { ...rule, match: nextMatch });
                      }}
                    />
                  ))}
                  {!rule.match.argumentPredicates?.length ? <p className="typography-micro text-muted-foreground">No argument predicates. Connector schema validation still runs first.</p> : null}
                </div>
              </div>
            ) : null}
          </fieldset>
        ))}
      </div>

      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="block space-y-1 typography-meta text-muted-foreground">
            <span>Allowed Browser Origins · Exact, One per Line</span>
            <Textarea
              rows={4}
              value={joined(value.browserPolicy.allowedOrigins)}
              onChange={(event) => onChange({
                ...value,
                browserPolicy: { ...value.browserPolicy, allowedOrigins: lines(event.target.value) },
              })}
            />
          </label>
          <p className="typography-micro text-muted-foreground">Leave empty to allow any valid HTTP(S) origin. Denied origins always win.</p>
        </div>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>Denied Browser Origins · Exact, One per Line</span>
          <Textarea
            rows={4}
            value={joined(value.browserPolicy.deniedOrigins)}
            onChange={(event) => onChange({
              ...value,
              browserPolicy: { ...value.browserPolicy, deniedOrigins: lines(event.target.value) },
            })}
          />
        </label>
      </fieldset>

      <fieldset disabled={readOnly} className="grid gap-3 rounded-lg border border-border/70 p-3 sm:grid-cols-2">
        <legend className="px-1 typography-ui-label font-medium text-foreground">Computer network and isolation</legend>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>Browser Network Access</span>
          <select
            value={networkAccess.mode}
            onChange={(event) => {
              const mode = event.target.value as 'public_only' | 'allowlist';
              onChange({
                ...value,
                browserPolicy: {
                  ...value.browserPolicy,
                  networkAccess: {
                    mode,
                    hosts: mode === 'public_only' ? [] : networkAccess.hosts,
                  },
                },
              });
            }}
            className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
          >
            <option value="public_only">Public Internet</option>
            <option value="allowlist">Exact Public Host Allowlist</option>
          </select>
          <span className="block typography-micro text-muted-foreground">Private, Loopback, Link-Local, Metadata, and Intranet Destinations Are Always Blocked.</span>
        </label>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>Computer Isolation</span>
          <select
            value={isolationTier}
            onChange={(event) => onChange({
              ...value,
              computerPolicy: { isolationTier: event.target.value as 'standard' | 'runsc' },
            })}
            className="h-8 w-full rounded-lg border border-input bg-background px-2 typography-ui-label text-foreground"
          >
            <option value="standard">Standard Container Boundary</option>
            <option value="runsc">Hardened runsc Boundary</option>
          </select>
          <span className="block typography-micro text-muted-foreground">Hardened Mode Must Pass a Local Runtime Smoke Test. It Never Falls Back to Standard.</span>
        </label>
        {networkAccess.mode === 'allowlist' ? (
          <label className="space-y-1 typography-meta text-muted-foreground sm:col-span-2">
            <span>Allowed Public Hosts · Exact, One per Line</span>
            <Textarea
              rows={4}
              placeholder={'example.com\napi.example.com:443'}
              value={joined(networkAccess.hosts)}
              onChange={(event) => onChange({
                ...value,
                browserPolicy: {
                  ...value.browserPolicy,
                  networkAccess: { mode: 'allowlist', hosts: lines(event.target.value) },
                },
              })}
            />
            <span className="block typography-micro text-muted-foreground">Wildcards and Paths Are Not Accepted; an Empty Allowlist Fails Publication.</span>
          </label>
        ) : null}
        {isolationTier === 'runsc' ? (
          <p className="rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/8 p-3 typography-micro text-foreground sm:col-span-2">
            Publishing drains and replaces the current computer under runsc while preserving its profile volume. Runtime unavailability blocks startup visibly.
          </p>
        ) : null}
      </fieldset>

      {/* A Bot keeps one memory that every member shares, so the only choices
          left are whether it learns on its own and how much it recalls. */}
      <fieldset disabled={readOnly} className="grid gap-3 rounded-lg border border-border/70 p-3 sm:grid-cols-2">
        <legend className="px-1 typography-ui-label font-medium text-foreground">Memory</legend>
        <label className="inline-flex items-center gap-2 typography-ui-label text-foreground">
          <Checkbox
            checked={memory.automaticExtraction !== false}
            onChange={(checked) => onChange({
              ...value,
              memoryPolicy: { ...memory, automaticExtraction: checked === true },
            })}
          />
          Learn from Conversations
        </label>
        <label className="space-y-1 typography-meta text-muted-foreground">
          <span>Memories Recalled per Reply</span>
          <NumberInput
            min={1}
            max={50}
            value={Number(memory.retrievalLimit || 12)}
            onValueChange={(next) => onChange({
              ...value,
              memoryPolicy: { ...memory, retrievalLimit: next },
            })}
          />
        </label>
      </fieldset>

    </div>
  );
};
