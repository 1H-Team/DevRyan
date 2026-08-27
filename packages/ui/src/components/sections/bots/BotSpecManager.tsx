import React from 'react';
import {
  RiCheckLine,
  RiDownloadLine,
  RiFileCodeLine,
  RiFileUploadLine,
  RiLockLine,
  RiShieldCheckLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  botsApi,
  type BotRevisionDetail,
  type BotSpecImportMapping,
  type BotSpecImportPreview,
  type BotsApi,
} from '@/lib/botsApi';
import { cn } from '@/lib/utils';

const MAX_SPEC_BYTES = 512 * 1024;
const UNRESOLVED = '__unresolved__';

const mappingKey = (kind: string, logicalKey: string): string => `${kind}\u0000${logicalKey}`;
const shortHash = (value: string): string => value ? `${value.slice(0, 12)}…${value.slice(-8)}` : 'Unavailable';

export type BotSpecManagerProps = {
  botId: string;
  revisions: readonly BotRevisionDetail[];
  api?: BotsApi;
  onImported?: () => void | Promise<void>;
};

export const BotSpecManager: React.FC<BotSpecManagerProps> = ({
  botId,
  revisions,
  api = botsApi,
  onImported,
}) => {
  const published = revisions.filter((revision) => revision.activatedAt !== null);
  const [exportRevisionId, setExportRevisionId] = React.useState(
    () => published[0]?.id || '',
  );
  const [source, setSource] = React.useState('');
  const [sourceName, setSourceName] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<BotSpecImportPreview | null>(null);
  const [mappings, setMappings] = React.useState<Readonly<Record<string, string>>>({});
  const [acknowledgeUnknown, setAcknowledgeUnknown] = React.useState(false);
  const [busy, setBusy] = React.useState<'export' | 'preview' | 'trust' | 'import' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    revisionNumber: number;
    compiledHashMatches: boolean;
    unresolvedCount: number;
  } | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (published.some((revision) => revision.id === exportRevisionId)) return;
    setExportRevisionId(published[0]?.id || '');
  }, [exportRevisionId, published]);

  const selectedMappings = React.useMemo<BotSpecImportMapping[]>(() => {
    if (!preview) return [];
    return preview.requirements.flatMap((requirement) => {
      const id = mappings[mappingKey(requirement.kind, requirement.logicalKey)];
      return id && id !== UNRESOLVED ? [{
        kind: requirement.kind,
        logicalKey: requirement.logicalKey,
        localResourceId: id,
      }] : [];
    });
  }, [mappings, preview]);
  const unresolvedCount = preview
    ? preview.requirements.length - selectedMappings.length
    : 0;
  const selectedExportRevision = published.find((revision) => revision.id === exportRevisionId);

  const previewSource = async (nextSource = source) => {
    if (!nextSource) return;
    setBusy('preview');
    setError(null);
    setResult(null);
    try {
      const next = await api.previewBotSpecImport({ source: nextSource, botId });
      setPreview(next);
      setMappings({});
      setAcknowledgeUnknown(false);
    } catch (nextError) {
      setPreview(null);
      setError(nextError instanceof Error ? nextError.message : 'Unable to verify this Bot specification.');
    } finally {
      setBusy(null);
    }
  };

  const chooseFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    setResult(null);
    if (file.size > MAX_SPEC_BYTES) {
      setError('Bot specifications must be 512 KiB or smaller.');
      return;
    }
    const nextSource = await file.text();
    setSource(nextSource);
    setSourceName(file.name);
    await previewSource(nextSource);
  };

  const exportRevision = async () => {
    if (!exportRevisionId) return;
    setBusy('export');
    setError(null);
    try {
      const exported = await api.exportBotSpec(botId, exportRevisionId);
      const blob = new Blob([exported.source], { type: 'application/vnd.devryan.bot-revision+json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = exported.filename;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to export this Bot revision.');
    } finally {
      setBusy(null);
    }
  };

  const trustSigner = async () => {
    if (!preview) return;
    setBusy('trust');
    setError(null);
    try {
      await api.setBotSignerTrust({
        scope: 'bot',
        botId,
        signerKeyId: preview.signer.keyId,
        signerPublicKey: preview.signer.publicKey,
        status: 'trusted',
      });
      await previewSource();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to trust this signer.');
      setBusy(null);
    }
  };

  const importDraft = async () => {
    if (!preview || !source) return;
    setBusy('import');
    setError(null);
    try {
      const imported = await api.importBotSpecDraft({
        source,
        botId,
        mappings: selectedMappings,
        ...(preview.signer.status === 'unknown' && acknowledgeUnknown
          ? { acknowledgeUnknownSigner: true as const }
          : {}),
      });
      setResult({
        revisionNumber: imported.revision.revisionNumber,
        compiledHashMatches: imported.compiledHashMatches,
        unresolvedCount: imported.unresolvedBindings.length,
      });
      await onImported?.();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to import this Bot specification.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border/70 p-4" aria-labelledby="bot-spec-manager-heading">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-[var(--surface-elevated)] text-muted-foreground">
          <RiFileCodeLine className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h3 id="bot-spec-manager-heading" className="typography-ui-header font-semibold text-foreground">Bot as code</h3>
          <p className="typography-ui text-muted-foreground">Export a signed, reviewable revision or import one as a new draft. Import never publishes directly.</p>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-3 rounded-lg border border-border/70 bg-[var(--surface-elevated)]/30 p-3">
          <div>
            <h4 className="typography-ui-label font-semibold text-foreground">Export published revision</h4>
            <p className="typography-micro text-muted-foreground">Deterministic JSON, Ed25519-signed, with no local IDs or secrets.</p>
          </div>
          {published.length > 0 ? (
            <>
              <Select value={exportRevisionId} onValueChange={setExportRevisionId}>
                <SelectTrigger size="lg" className="min-w-0 max-w-full">
                  <SelectValue>
                    {selectedExportRevision
                      ? `Published Revision ${selectedExportRevision.revisionNumber}`
                      : 'Select Published Revision'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {published.map((revision) => (
                    <SelectItem key={revision.id} value={revision.id}>Published Revision {revision.revisionNumber}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void exportRevision()}>
                <RiDownloadLine className="h-4 w-4" aria-hidden /> {busy === 'export' ? 'Signing…' : 'Export Signed JSON'}
              </Button>
            </>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-3 typography-ui text-muted-foreground">Publish a revision before exporting it.</p>
          )}
        </div>

        <div className="min-w-0 space-y-3 rounded-lg border border-border/70 bg-[var(--surface-elevated)]/30 p-3">
          <div>
            <h4 className="typography-ui-label font-semibold text-foreground">Import into this Bot</h4>
            <p className="typography-micro text-muted-foreground">Verification runs before any mapping or draft is created.</p>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".devryan-bot.json,application/json,application/vnd.devryan.bot-revision+json"
            className="sr-only"
            onChange={(event) => void chooseFile(event.target.files?.[0] || null)}
          />
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
            <RiFileUploadLine className="h-4 w-4" aria-hidden /> Choose Signed Specification
          </Button>
          {sourceName ? <p className="max-w-full truncate typography-micro text-muted-foreground">{sourceName}</p> : null}
          {busy === 'preview' ? <p role="status" className="typography-ui text-muted-foreground">Verifying signature and portable bindings…</p> : null}
        </div>
      </div>

      {error ? <p role="alert" className="rounded-lg border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 p-3 typography-ui text-foreground">{error}</p> : null}

      {preview ? (
        <div className="min-w-0 space-y-4 rounded-xl border border-border/70 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="typography-ui-label font-semibold text-foreground">{preview.metadata.name} · revision {preview.metadata.revision}</h4>
              <p className="mt-1 break-words font-mono typography-micro text-muted-foreground">Portable {shortHash(preview.specHash)} · Source compiled {shortHash(preview.sourceCompiledHash)}</p>
            </div>
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 typography-micro',
              preview.signer.status === 'trusted'
                ? 'border-[var(--status-success)]/35 bg-[var(--status-success)]/10 text-[var(--status-success)]'
                : 'border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 text-foreground',
            )}>
              {preview.signer.status === 'trusted' ? <RiShieldCheckLine className="h-3.5 w-3.5" aria-hidden /> : <RiLockLine className="h-3.5 w-3.5" aria-hidden />}
              {preview.signer.status === 'trusted' ? 'Trusted signer' : 'Valid unknown signer'}
            </span>
          </div>

          {preview.signer.status === 'unknown' ? (
            <div className="space-y-2 rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/8 p-3">
              <p className="typography-ui text-foreground">The signature is valid, but this signer is not trusted for this Bot. Trust affects future recognition only; it never bypasses authorization or publication health.</p>
              <p className="font-mono typography-micro text-muted-foreground">{preview.signer.keyId}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={() => void trustSigner()}>{busy === 'trust' ? 'Trusting…' : 'Trust for This Bot'}</Button>
                <label className="inline-flex items-center gap-2 typography-ui-label text-foreground">
                  <Checkbox checked={acknowledgeUnknown} onChange={(checked) => setAcknowledgeUnknown(checked === true)} />
                  Import Once Without Trusting
                </label>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <div>
              <h5 className="typography-ui-label font-medium text-foreground">Local binding resolution</h5>
              <p className="typography-micro text-muted-foreground">Only exact immutable digests are offered. Unresolved items remain failed publication gates and are never installed automatically.</p>
            </div>
            {preview.requirements.length === 0 ? (
              <p className="rounded-lg border border-[var(--status-success)]/30 bg-[var(--status-success)]/8 p-3 typography-ui text-foreground">No local bindings are required.</p>
            ) : preview.requirements.map((requirement) => {
              const key = mappingKey(requirement.kind, requirement.logicalKey);
              const selected = mappings[key] || UNRESOLVED;
              const selectedCandidate = requirement.candidates.find((candidate) => candidate.id === selected);
              return (
                <div key={key} className="grid gap-2 rounded-lg border border-border/60 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,1fr)] sm:items-center">
                  <div className="min-w-0">
                    <p className="typography-ui-label font-medium text-foreground">{requirement.logicalKey}</p>
                    <p className="typography-micro capitalize text-muted-foreground">{requirement.kind.replace('_', ' ')} · {shortHash(requirement.portableDigest)}</p>
                  </div>
                  <Select value={selected} onValueChange={(id) => setMappings((current) => ({ ...current, [key]: id }))}>
                    <SelectTrigger size="lg" className="min-w-0 max-w-full">
                      <SelectValue>
                        {selectedCandidate ? `${selectedCandidate.label} · Exact Digest` : 'Keep Unresolved'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNRESOLVED}>Keep Unresolved</SelectItem>
                      {requirement.candidates.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.label} · Exact Digest</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="typography-micro text-muted-foreground">{unresolvedCount === 0 ? 'All portable bindings mapped.' : `${unresolvedCount} binding${unresolvedCount === 1 ? '' : 's'} will remain unresolved.`}</p>
            <Button
              type="button"
              size="sm"
              disabled={busy !== null || (preview.signer.status === 'unknown' && !acknowledgeUnknown)}
              onClick={() => void importDraft()}
            >
              <RiFileUploadLine className="h-4 w-4" aria-hidden /> {busy === 'import' ? 'Creating Draft…' : 'Import as Draft'}
            </Button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-[var(--status-success)]/35 bg-[var(--status-success)]/8 p-3">
          <RiCheckLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-success)]" aria-hidden />
          <p className="typography-ui text-foreground">
            Draft revision {result.revisionNumber} created. {result.compiledHashMatches ? 'Its compiled hash matches the source environment.' : 'Its portable spec hash matches; local binding resolution produced an expected compiled-hash difference.'} {result.unresolvedCount > 0 ? `${result.unresolvedCount} publication gate${result.unresolvedCount === 1 ? '' : 's'} still need binding resolution.` : 'It is ready for the ordinary publication checks.'}
          </p>
        </div>
      ) : null}
    </section>
  );
};
