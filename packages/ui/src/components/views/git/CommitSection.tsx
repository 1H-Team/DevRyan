import {
  RiArrowDownSLine,
  RiCheckLine,
  RiLoader4Line,
  RiEmotionHappyLine,
  RiSparklingLine,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CommitInput } from './CommitInput';
import type { SyncAction } from './SyncActions';
import { useDeviceInfo } from '@/lib/device';
import type { GitRemote } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';

type CommitAction = 'commit' | 'commitAmend' | 'commitAndPush' | 'commitAndSync' | null;

interface CommitSectionProps {
  selectedCount: number;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  onCommitAmend: () => void;
  onCommitAndPush: () => void;
  onCommitAndSync: () => void;
  onGenerateCommitMessage: () => void;
  commitAction: CommitAction;
  isGeneratingCommitMessage: boolean;
  commitGenerationDisabled: boolean;
  gitmojiEnabled: boolean;
  onOpenGitmojiPicker: () => void;
  syncAction: SyncAction;
  remotes: GitRemote[];
  onSync: (remote: GitRemote) => void;
  syncDisabled: boolean;
  aheadCount?: number;
  behindCount?: number;
  trackingRemoteName?: string;
  hasUncommittedChanges?: boolean;
}

export const CommitSection: React.FC<CommitSectionProps> = ({
  selectedCount,
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onCommitAmend,
  onCommitAndPush,
  onCommitAndSync,
  onGenerateCommitMessage,
  commitAction,
  isGeneratingCommitMessage,
  commitGenerationDisabled,
  gitmojiEnabled,
  onOpenGitmojiPicker,
}) => {
  const { t } = useI18n();
  const hasScopedChanges = selectedCount > 0;
  const canStartCommitAction = hasScopedChanges && commitAction === null;
  const { isMobile, hasTouchInput } = useDeviceInfo();

  const containerClassName = 'border-0 bg-transparent rounded-none';
  const contentClassName = 'flex flex-col gap-2 px-0 pt-0 pb-0';

  return (
    <section className={containerClassName}>
      <div className={contentClassName}>
        <CommitInput
          value={commitMessage}
          onChange={onCommitMessageChange}
          placeholder={t('gitView.commit.messagePlaceholder')}
          disabled={commitAction !== null}
          hasTouchInput={hasTouchInput}
          isMobile={isMobile}
          trailingAction={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={onGenerateCommitMessage}
                  disabled={commitGenerationDisabled}
                  className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                  aria-label={t('gitView.commit.generateAria')}
                >
                  {isGeneratingCommitMessage ? (
                    <RiLoader4Line className="size-4 animate-spin" />
                  ) : (
                    <RiSparklingLine className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={8}>
                {isGeneratingCommitMessage
                  ? t('gitView.commit.generateLoading')
                  : t('gitView.commit.generateTooltip')}
              </TooltipContent>
            </Tooltip>
          }
        />

        {gitmojiEnabled && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenGitmojiPicker}
            className="w-fit"
            type="button"
          >
            <RiEmotionHappyLine className="size-4" />
            {t('gitView.commit.addGitmoji')}
          </Button>
        )}

        <div className="flex min-w-0 items-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] overflow-hidden">
          <Button
            size="default"
            variant="default"
            onClick={() => {
              onCommit();
            }}
            disabled={!canStartCommitAction}
            className="h-8 min-w-0 flex-1 rounded-none gap-1.5 whitespace-nowrap normal-case"
            aria-label={t('gitView.commit.commitAria')}
          >
            {commitAction === 'commit' ? (
              <>
                <RiLoader4Line className="size-4 animate-spin" />
                <span className="truncate">{t('gitView.commit.committing')}</span>
              </>
            ) : (
              <>
                <RiCheckLine className="size-4" />
                <span className="truncate">{t('gitView.commit.commit')}</span>
              </>
            )}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="default"
                disabled={!canStartCommitAction}
                className="h-8 w-8 rounded-none border-l border-[color-mix(in_oklab,var(--primary-foreground)_35%,transparent)]"
                aria-label={t('gitView.commit.moreActionsAria')}
              >
                {commitAction && commitAction !== 'commit' ? (
                  <RiLoader4Line className="size-4 animate-spin" />
                ) : (
                  <RiArrowDownSLine className="size-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={onCommitAmend}>
                {t('gitView.commit.amend')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onCommitAndPush}>
                {t('gitView.commit.commitPush')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onCommitAndSync}>
                {t('gitView.commit.commitSync')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </section>
  );
};
