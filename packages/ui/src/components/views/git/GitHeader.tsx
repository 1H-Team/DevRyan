import React from 'react';
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiLoader4Line,
  RiGitBranchLine,
  RiBriefcaseLine,
  RiHomeLine,
  RiGraduationCapLine,
  RiCodeLine,
  RiHeartLine,
  RiUser3Line,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BranchSelector } from './BranchSelector';
import { WorktreeBranchDisplay } from './WorktreeBranchDisplay';
import type { GitStatus, GitIdentityProfile, GitRemote } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

interface GitHeaderProps {
  status: GitStatus | null;
  localBranches: string[];
  remoteBranches: string[];
  worktreeBranches?: ReadonlySet<string>;
  branchInfo: Record<string, { ahead?: number; behind?: number }> | undefined;
  remotes: GitRemote[];
  onCheckoutBranch: (branch: string) => void;
  onCreateBranch?: (name: string, remote?: GitRemote) => Promise<void>;
  onRenameBranch?: (oldName: string, newName: string) => Promise<void>;
  activeIdentityProfile: GitIdentityProfile | null;
  availableIdentities: GitIdentityProfile[];
  onSelectIdentity: (profile: GitIdentityProfile) => void;
  isApplyingIdentity: boolean;
  isWorktreeMode: boolean;
  actionTabItems?: SortableTabsStripItem[];
  activeActionTab?: string;
  onSelectActionTab?: (tabID: string) => void;
}

const IDENTITY_ICON_MAP: Record<
  string,
  React.ComponentType<React.ComponentProps<typeof RiGitBranchLine>>
> = {
  branch: RiGitBranchLine,
  briefcase: RiBriefcaseLine,
  house: RiHomeLine,
  graduation: RiGraduationCapLine,
  code: RiCodeLine,
  heart: RiHeartLine,
  user: RiUser3Line,
};

const IDENTITY_COLOR_MAP: Record<string, string> = {
  keyword: 'var(--syntax-keyword)',
  error: 'var(--status-error)',
  string: 'var(--syntax-string)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
  success: 'var(--status-success)',
  info: 'var(--status-info)',
  warning: 'var(--status-warning)',
};

function getIdentityColor(token?: string | null) {
  if (!token) {
    return 'var(--primary)';
  }
  return IDENTITY_COLOR_MAP[token] || 'var(--primary)';
}

interface IdentityIconProps {
  icon?: string | null;
  className?: string;
  colorToken?: string | null;
}

const IdentityIcon: React.FC<IdentityIconProps> = ({ icon, className, colorToken }) => {
  const IconComponent = IDENTITY_ICON_MAP[icon ?? 'branch'] ?? RiUser3Line;
  return (
    <IconComponent
      className={className}
      style={{ color: getIdentityColor(colorToken) }}
    />
  );
};

interface IdentityDropdownProps {
  activeProfile: GitIdentityProfile | null;
  identities: GitIdentityProfile[];
  onSelect: (profile: GitIdentityProfile) => void;
  isApplying: boolean;
  iconOnly?: boolean;
}

export const IdentityDropdown: React.FC<IdentityDropdownProps> = ({
  activeProfile,
  identities,
  onSelect,
  isApplying,
  iconOnly = false,
}) => {
  const { t } = useI18n();
  const isDisabled = isApplying || identities.length === 0;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 min-w-0 max-w-[15rem] justify-start gap-1.5 px-2 py-1 typography-ui-label"
              style={{ color: getIdentityColor(activeProfile?.color) }}
              disabled={isDisabled}
            >
              {isApplying ? (
                <RiLoader4Line className="size-4 animate-spin" />
              ) : (
                <IdentityIcon
                  icon={activeProfile?.icon}
                  colorToken={activeProfile?.color}
                  className="size-4"
                />
              )}
              {!iconOnly && (
                <span className="git-identity-label min-w-0 flex-1 truncate text-left">
                  {activeProfile?.name || t('gitView.header.noIdentity')}
                </span>
              )}
              <RiArrowDownSLine className="size-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>{t('gitView.header.identityTooltip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        {identities.length === 0 ? (
          <div className="px-2 py-1.5">
            <p className="typography-meta text-muted-foreground">
              {t('gitView.header.noProfiles')}
            </p>
          </div>
        ) : (
          identities.map((profile) => {
            const isSelected = activeProfile?.id === profile.id;
            return (
              <DropdownMenuItem key={profile.id} onSelect={() => onSelect(profile)}>
                <span className="flex items-center gap-2">
                  <IdentityIcon
                    icon={profile.icon}
                    colorToken={profile.color}
                    className="size-4"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="typography-ui-label text-foreground">
                      {profile.name}
                    </span>
                    <span className="typography-meta text-muted-foreground">
                      {profile.userEmail}
                    </span>
                  </span>
                  {isSelected ? (
                    <RiCheckLine className="ml-auto size-4 text-foreground" />
                  ) : null}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const GitHeader: React.FC<GitHeaderProps> = ({
  status,
  localBranches,
  remoteBranches,
  worktreeBranches,
  branchInfo,
  remotes,
  onCheckoutBranch,
  onCreateBranch,
  onRenameBranch,
  activeIdentityProfile,
  availableIdentities,
  onSelectIdentity,
  isApplyingIdentity,
  isWorktreeMode,
  actionTabItems,
  activeActionTab,
  onSelectActionTab,
}) => {
  if (!status) {
    return null;
  }

  const identityControl = (
    <IdentityDropdown
      activeProfile={activeIdentityProfile}
      identities={availableIdentities}
      onSelect={onSelectIdentity}
      isApplying={isApplyingIdentity}
      iconOnly={true}
    />
  );

  return (
    <header className="@container/git-header px-3 py-2 bg-transparent">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          {isWorktreeMode ? (
            <WorktreeBranchDisplay
              currentBranch={status.current}
              onRename={onRenameBranch}
            />
          ) : (
            <BranchSelector
              currentBranch={status.current}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              worktreeBranches={worktreeBranches}
              branchInfo={branchInfo}
              onCheckout={onCheckoutBranch}
              onCreate={onCreateBranch}
              remotes={remotes}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {identityControl}
        </div>
      </div>

      {actionTabItems && activeActionTab && onSelectActionTab ? (
        <div className="mt-2 flex h-6 min-w-0 items-center">
          <div className="min-w-0 flex-1">
            <SortableTabsStrip
              items={actionTabItems}
              activeId={activeActionTab}
              onSelect={onSelectActionTab}
              layoutMode="fit"
              variant="active-pill"
              iconOnlyActiveTab={true}
              activePillButtonClassName="h-5 !px-2 text-[11px] leading-none"
              activePillLowercase={false}
              className="h-full"
            />
          </div>
        </div>
      ) : null}
    </header>
  );
};
