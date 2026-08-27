import React from 'react';
import {
  RiCalendarScheduleLine,
  RiDatabase2Line,
  RiFolder3Line,
  RiPauseCircleLine,
  RiRobot2Line,
  RiTeamLine,
} from '@remixicon/react';

import { BotAvatar } from '@/components/bots/BotAvatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  BotActivationGate,
  BotActivationHealth,
  BotCompleteDeleteRequest,
  BotCredentialMetadata,
  BotManagedMembership,
  BotManagementDetail,
  BotMembershipRole,
  BotModelOptions,
  BotPurgeExecutionResult,
  BotRevisionContract,
  BotRevisionDetail,
} from '@/lib/botsApi';
import { cn } from '@/lib/utils';
import { BotComputerFiles } from './BotComputerFiles';
import { BotCredentials, type SaveBotCredentialInput } from './BotCredentials';
import {
  BotDetails,
  type BotProfileEdit,
  type BotProfileSaveRequest,
  BotStatusSummary,
} from './BotDetails';
import { BotEnvironmentSecrets } from './BotEnvironmentSecrets';
import { BotLifecycleActions } from './BotLifecycleActions';
import { BotMemberships } from './BotMemberships';
import { BotMemoryConsole } from './BotMemoryConsole';
import { BotRoutines } from './BotRoutines';
import { BotSkills } from './BotSkills';
import { validateBotRevisionConfiguration } from './botManagementPresentation';

type EditorTab = 'overview' | 'resources' | 'memory' | 'membership' | 'routines' | 'lifecycle';

const tabs: readonly { id: EditorTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: RiRobot2Line },
  { id: 'resources', label: 'Resources', icon: RiFolder3Line },
  { id: 'memory', label: 'Memory', icon: RiDatabase2Line },
  { id: 'membership', label: 'Members', icon: RiTeamLine },
  { id: 'routines', label: 'Routines', icon: RiCalendarScheduleLine },
  { id: 'lifecycle', label: 'Lifecycle', icon: RiPauseCircleLine },
];

const isRevisionDetail = (revision: BotManagementDetail['revisions'][number]): revision is BotRevisionDetail => (
  Object.hasOwn(revision, 'contract') && Object.hasOwn(revision, 'updatedAt')
);

type MutationResult = boolean | void | Promise<boolean | void>;

export type BotEditorProps = {
  detail: BotManagementDetail;
  activationHealth: BotActivationHealth | null;
  purgeResult?: BotPurgeExecutionResult | null;
  busyAction?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  noticeMessage?: string | null;
  modelOptions?: BotModelOptions | null;
  focusNameSignal?: number;
  onSaveProfile?: (request: BotProfileSaveRequest) => void;
  onPublishRevision?: (
    revision: BotRevisionDetail,
    contract: BotRevisionContract,
    profile: BotProfileSaveRequest,
  ) => void;
  runtimeRecoveryKind?: 'setup' | 'repair' | 'update' | null;
  runtimeRecoveryPending?: boolean;
  runtimeRecoveryProgressLabel?: string;
  runtimeRecoveryError?: string | null;
  onRecoverRuntime?: (revision: BotRevisionDetail) => void;
  onAssignMembership: (input: {
    userId: string;
    role: BotMembershipRole;
    expectedUpdatedAt?: string;
  }) => void;
  onRevokeMembership: (membership: BotManagedMembership) => void;
  onSaveCredential: (input: SaveBotCredentialInput) => MutationResult;
  onRotateCredential?: (credential: BotCredentialMetadata, secret: string) => MutationResult;
  onTransition: (lifecycle: 'active' | 'paused' | 'retired') => void;
  onDeleteCompletely?: (request: BotCompleteDeleteRequest) => void;
  onRetryPurge?: (resourceIds: readonly string[]) => void;
  onResourcesChanged?: () => void | Promise<void>;
};

const gateDestination = (gate: BotActivationGate): EditorTab | null => {
  if (['models', 'egress', 'tools', 'policy', 'library', 'skills'].includes(gate.id)) return 'resources';
  return null;
};

export const BotEditor: React.FC<BotEditorProps> = ({
  detail,
  activationHealth,
  purgeResult = null,
  busyAction = null,
  errorCode = null,
  errorMessage = null,
  noticeMessage = null,
  modelOptions = null,
  focusNameSignal = 0,
  onSaveProfile,
  onPublishRevision,
  runtimeRecoveryKind = null,
  runtimeRecoveryPending = false,
  runtimeRecoveryProgressLabel = 'Working…',
  runtimeRecoveryError = null,
  onRecoverRuntime,
  onAssignMembership,
  onRevokeMembership,
  onSaveCredential,
  onRotateCredential,
  onTransition,
  onDeleteCompletely,
  onRetryPurge,
  onResourcesChanged,
}) => {
  const [tab, setTab] = React.useState<EditorTab>('overview');
  const [activateConfirmOpen, setActivateConfirmOpen] = React.useState(false);
  const [readinessDismissed, setReadinessDismissed] = React.useState(false);
  const revisions = React.useMemo(
    () => detail.revisions.filter(isRevisionDetail).sort((left, right) => right.revisionNumber - left.revisionNumber),
    [detail.revisions],
  );
  const workingRevision = revisions.find((revision) => revision.activatedAt === null) || null;
  const activeRevision = revisions.find((revision) => revision.id === detail.bot.activeRevisionId) || null;
  const selectedRevision = workingRevision || activeRevision || revisions[0] || null;
  const contract = selectedRevision?.contract || null;
  const [profileEdit, setProfileEdit] = React.useState<BotProfileEdit>(() => ({
    request: { name: detail.bot.name, title: detail.bot.title, summary: detail.bot.summary },
    dirty: false,
    valid: true,
  }));

  React.useEffect(() => setTab('overview'), [detail.bot.id]);
  React.useEffect(() => {
    setProfileEdit({
      request: { name: detail.bot.name, title: detail.bot.title, summary: detail.bot.summary },
      dirty: false,
      valid: true,
    });
  }, [detail.bot.avatarFallback, detail.bot.avatarUrl, detail.bot.id, detail.bot.name, detail.bot.summary, detail.bot.title]);
  React.useEffect(() => setReadinessDismissed(false), [activationHealth, errorCode]);
  React.useEffect(() => {
    if (!detail.canManage && ['resources', 'memory', 'routines', 'lifecycle'].includes(tab)) setTab('overview');
  }, [detail.canManage, tab]);

  const readOnly = !detail.canManage;
  const canActivate = Boolean(
    workingRevision
    && contract
    && validateBotRevisionConfiguration(contract).valid
    && profileEdit.valid
    && onPublishRevision,
  );
  const readinessOpen = errorCode === 'bot_activation_blocked' && Boolean(activationHealth) && !readinessDismissed;
  const failedReadinessGates = activationHealth?.gates.filter((gate) => gate.status === 'fail') || [];

  const runtimeGateAction = (gate: BotActivationGate): boolean => (
    gate.id === 'images'
    && runtimeRecoveryKind !== null
    && Boolean(onRecoverRuntime)
    && Boolean(selectedRevision)
  );

  const actionBar = detail.canManage && (workingRevision || profileEdit.dirty) ? (
    <div className={cn(
      'sticky bottom-0 z-10 -mx-4 mt-7 flex items-center justify-end gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-sm',
      'supports-[backdrop-filter]:bg-background/85',
    )}>
      {workingRevision ? (
        <Button type="button" size="sm" disabled={!canActivate || busyAction !== null} onClick={() => setActivateConfirmOpen(true)}>
          {busyAction === 'publish-revision' ? 'Activating…' : detail.bot.activeRevisionId ? 'Apply Changes' : 'Activate Bot'}
        </Button>
      ) : (
        <Button type="button" size="sm" disabled={!profileEdit.dirty || !profileEdit.valid || busyAction !== null || !onSaveProfile} onClick={() => onSaveProfile?.(profileEdit.request)}>
          {busyAction === 'save-profile' ? 'Saving…' : 'Save Changes'}
        </Button>
      )}
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header className="app-region-no-drag shrink-0 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          <BotAvatar bot={detail.bot} className="h-11 w-11 text-lg" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate typography-ui-header font-semibold text-foreground">{detail.bot.name}</h2>
              <span className="rounded-full border border-border px-2 py-0.5 typography-micro text-muted-foreground">
                {detail.bot.activeRevisionId ? (detail.bot.lifecycle === 'active' ? 'Active' : 'Paused') : 'Setup incomplete'}
              </span>
            </div>
            <p className="truncate typography-ui text-muted-foreground">{detail.bot.title}</p>
          </div>
        </div>

        <nav className="mt-3 flex gap-1 overflow-x-auto" aria-label="Bot Settings">
          {tabs.filter((item) => !['resources', 'memory', 'routines', 'lifecycle'].includes(item.id) || detail.canManage).map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={tab === item.id ? 'page' : undefined}
                onClick={() => setTab(item.id)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 typography-ui-label text-muted-foreground transition-colors',
                  'hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                  tab === item.id && 'bg-interactive-active text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden /> {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6">
          {noticeMessage ? <p role="status" className="mb-4 rounded-lg border border-[var(--status-success)]/35 bg-[var(--status-success)]/10 p-3 typography-ui text-foreground">{noticeMessage}</p> : null}
          {errorMessage ? <p role="alert" className="mb-4 rounded-lg border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 p-3 typography-ui text-foreground">{errorMessage}</p> : null}

          <div hidden={tab !== 'overview'} className="space-y-7">
            <BotDetails
              bot={detail.bot}
              readOnly={readOnly}
              saving={busyAction === 'save-profile'}
              error={errorCode === 'bot_revision_conflict' ? errorMessage : null}
              focusNameSignal={focusNameSignal}
              showSaveAction={false}
              onEditChange={setProfileEdit}
            />
            <BotStatusSummary bot={detail.bot} />
            {!contract ? <p className="rounded-xl border border-border/70 p-4 typography-ui text-muted-foreground">This Bot does not have a saved configuration.</p> : null}
            {actionBar}
          </div>

          {tab === 'resources' && detail.canManage ? (
            <div className="space-y-7">
              <section className="rounded-xl border border-border/70 bg-[var(--surface-subtle)]/25 p-4" aria-labelledby="bot-built-in-access-heading">
                <h3 id="bot-built-in-access-heading" className="typography-ui-label font-semibold text-foreground">Built-in access</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {['Public internet', 'Create and edit files', 'Remote computer', 'Persistent browser session'].map((label) => (
                    <span key={label} className="rounded-full border border-border/70 bg-background px-2.5 py-1 typography-micro text-muted-foreground">{label}</span>
                  ))}
                </div>
              </section>
              <BotComputerFiles botId={detail.bot.id} />
              <BotSkills detail={detail} onChanged={onResourcesChanged} />
              <BotCredentials
                credentials={detail.credentials}
                providers={modelOptions?.providers ?? []}
                readOnly={readOnly}
                busy={busyAction === 'credential'}
                onSave={onSaveCredential}
                onRotate={onRotateCredential}
              />
              <BotEnvironmentSecrets botId={detail.bot.id} readOnly={readOnly} />
            </div>
          ) : null}

          {tab === 'memory' && detail.canManage ? <BotMemoryConsole botId={detail.bot.id} /> : null}
          {tab === 'membership' ? <BotMemberships botId={detail.bot.id} memberships={detail.memberships} readOnly={readOnly} busyUserId={busyAction?.startsWith('membership:') ? busyAction.slice('membership:'.length) : null} error={errorMessage} onAssign={onAssignMembership} onRevoke={onRevokeMembership} /> : null}
          {tab === 'routines' && detail.canManage ? <BotRoutines botId={detail.bot.id} /> : null}
          {tab === 'lifecycle' && detail.canManage ? (
            <BotLifecycleActions
              bot={detail.bot}
              purgeResult={purgeResult}
              readOnly={readOnly}
              busyAction={busyAction}
              error={errorMessage}
              onTransition={onTransition}
              onDeleteCompletely={onDeleteCompletely}
              onRetryPurge={onRetryPurge}
            />
          ) : null}
        </div>
      </div>

      <Dialog open={activateConfirmOpen} onOpenChange={setActivateConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail.bot.activeRevisionId ? 'Apply Changes?' : 'Activate Bot?'}</DialogTitle>
            <DialogDescription>DevRyan will save the latest settings, verify the local runtime, and use them for future messages. Work already in progress is not interrupted.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setActivateConfirmOpen(false)}>Cancel</Button>
            <Button
              type="button"
              disabled={!workingRevision || !contract || !canActivate || busyAction !== null}
              onClick={() => {
                if (!workingRevision || !contract || !onPublishRevision) return;
                setActivateConfirmOpen(false);
                onPublishRevision(workingRevision, contract, profileEdit.request);
              }}
            >{detail.bot.activeRevisionId ? 'Apply Changes' : 'Activate Bot'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={readinessOpen} onOpenChange={(open) => !open && setReadinessDismissed(true)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Setup incomplete</DialogTitle>
            <DialogDescription>DevRyan completed everything it could automatically. Resolve the remaining items below.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {failedReadinessGates.map((gate) => {
              const destination = gateDestination(gate);
              return (
                <div key={gate.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/70 p-3">
                  <div>
                    <p className="typography-ui-label font-medium text-foreground">{gate.label}</p>
                    <p className="typography-micro text-muted-foreground">{gate.detail}</p>
                  </div>
                  {runtimeGateAction(gate) || destination ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={runtimeGateAction(gate) && runtimeRecoveryPending}
                      onClick={() => {
                        if (runtimeGateAction(gate) && selectedRevision && onRecoverRuntime) {
                          onRecoverRuntime(selectedRevision);
                          return;
                        }
                        if (destination) setTab(destination);
                        setReadinessDismissed(true);
                      }}
                    >
                      {runtimeGateAction(gate)
                        ? runtimeRecoveryPending ? runtimeRecoveryProgressLabel : 'Prepare Runtime'
                        : 'Open Resources'}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {runtimeRecoveryError ? <p role="alert" className="rounded-lg border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 p-3 typography-ui text-foreground">{runtimeRecoveryError}</p> : null}
          <DialogFooter><Button type="button" variant="ghost" onClick={() => setReadinessDismissed(true)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
