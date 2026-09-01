import React from 'react';
import {
  RiCheckLine,
  RiFolderAddLine,
  RiGithubFill,
  RiMoonLine,
  RiSettings3Line,
  RiSunLine,
} from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { GitHubAuthStatus } from '@/lib/api/types';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getAuthPrincipal } from '@/lib/authSession';
import { preloadSettingsView } from '@/components/views/settingsViewLoader';

type Props = {
  onOpenSettings: () => void;
  githubAuthStatus?: GitHubAuthStatus | null;
  isSwitchingGitHubAccount?: boolean;
  onGitHubAccountSwitch?: (accountId: string) => Promise<void> | void;
  showGitHubProfilePlaceholder?: boolean;
  showRuntimeButtons?: boolean;
  hideDirectoryControls: boolean;
  handleOpenDirectoryDialog: () => void;
};

const footerButtonClassName = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

export function GitHubProfileControl({
  githubAuthStatus,
  isSwitchingGitHubAccount = false,
  onGitHubAccountSwitch,
  showPlaceholder = false,
}: {
  githubAuthStatus?: GitHubAuthStatus | null;
  isSwitchingGitHubAccount?: boolean;
  onGitHubAccountSwitch?: (accountId: string) => Promise<void> | void;
  showPlaceholder?: boolean;
}): React.ReactNode {
  const { t } = useI18n();

  const githubAccounts = githubAuthStatus?.accounts ?? [];
  const activeAccountId = githubAuthStatus?.activeAccountId ?? null;
  const currentAccount = githubAccounts.find((account) => account.id === activeAccountId)
    ?? githubAccounts.find((account) => account.current)
    ?? githubAccounts[0]
    ?? null;
  const statusUser = githubAuthStatus?.user ?? null;
  const accountUser = currentAccount?.user ?? null;
  const statusMatchesAccount = Boolean(statusUser && accountUser && (
    (typeof statusUser.id === 'number' && typeof accountUser.id === 'number' && statusUser.id === accountUser.id)
    || (statusUser.login && accountUser.login && statusUser.login.toLowerCase() === accountUser.login.toLowerCase())
  ));
  const githubUser = accountUser
    ? (statusMatchesAccount ? { ...accountUser, ...statusUser } : accountUser)
    : statusUser;
  const githubAvatarUrl = githubUser?.avatarUrl ?? null;
  const githubLogin = githubUser?.login ?? null;
  const [avatarFailed, setAvatarFailed] = React.useState(false);

  React.useEffect(() => {
    setAvatarFailed(false);
  }, [githubAvatarUrl]);

  if (!githubAuthStatus?.connected && !githubUser && !showPlaceholder) {
    return null;
  }
  const title = githubAuthStatus?.connected
    ? (githubLogin ? t('header.github.connectedWithLogin', { login: githubLogin }) : t('header.github.connected'))
    : (githubLogin ? `GitHub @${githubLogin}` : 'GitHub');

  const avatar = githubAvatarUrl && !avatarFailed ? (
    <img
      src={githubAvatarUrl}
      alt={githubLogin ? t('header.github.avatarWithLogin', { login: githubLogin }) : t('header.github.avatar')}
      className="h-full w-full object-cover"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setAvatarFailed(true)}
    />
  ) : (
    <RiGithubFill className="h-3.5 w-3.5 text-foreground" />
  );

  if (githubAccounts.length > 1 && onGitHubAccountSwitch) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-muted/80 p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:pointer-events-none disabled:opacity-50"
            title={title}
            aria-label={title}
            disabled={isSwitchingGitHubAccount}
          >
            {avatar}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
            {t('header.github.accountsTitle')}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {githubAccounts.map((account) => {
            const accountUser = account.user;
            const isCurrent = activeAccountId ? account.id === activeAccountId : Boolean(account.current);
            return (
              <DropdownMenuItem
                key={account.id}
                className="gap-2"
                disabled={isCurrent || isSwitchingGitHubAccount}
                onSelect={() => {
                  if (!isCurrent) {
                    void onGitHubAccountSwitch(account.id);
                  }
                }}
              >
                {accountUser?.avatarUrl ? (
                  <div className="relative flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-muted">
                    <RiGithubFill className="h-3 w-3 text-muted-foreground" />
                    <img
                      src={accountUser.avatarUrl}
                      alt={accountUser.login ? t('header.github.avatarWithLogin', { login: accountUser.login }) : t('header.github.avatar')}
                      className="absolute inset-0 h-full w-full rounded-full bg-muted object-cover"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(event) => { event.currentTarget.style.display = 'none'; }}
                    />
                  </div>
                ) : (
                  <div className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-muted">
                    <RiGithubFill className="h-3 w-3 text-muted-foreground" />
                  </div>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate typography-ui-label text-foreground">
                    {accountUser?.name?.trim() || accountUser?.login || 'GitHub'}
                  </span>
                  {accountUser?.login ? (
                    <span className="truncate typography-micro text-muted-foreground">
                      {accountUser.login}
                    </span>
                  ) : null}
                </span>
                {isCurrent ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-muted/80"
      title={title}
      aria-label={title}
    >
      {avatar}
    </div>
  );
}

export function SidebarFooter({
  onOpenSettings,
  githubAuthStatus,
  isSwitchingGitHubAccount = false,
  onGitHubAccountSwitch,
  showGitHubProfilePlaceholder = false,
  showRuntimeButtons = true,
  hideDirectoryControls,
  handleOpenDirectoryDialog,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const { currentTheme, setThemeMode } = useThemeSystem();
  const preloadSettings = React.useCallback(() => {
    const principal = getAuthPrincipal();
    const useManagedView = principal.scope === 'managed' && principal.role !== 'admin';
    void preloadSettingsView(useManagedView).catch(() => undefined);
  }, []);
  const isDarkMode = currentTheme.metadata.variant === 'dark';
  const themeToggleLabel = isDarkMode
    ? t('sessions.sidebar.footer.actions.switchToLightMode')
    : t('sessions.sidebar.footer.actions.switchToDarkMode');

  const handleThemeToggle = React.useCallback(() => {
    setThemeMode(isDarkMode ? 'light' : 'dark');
  }, [isDarkMode, setThemeMode]);

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 px-2.5 py-2',
        showRuntimeButtons && 'border-t border-border',
      )}
    >
      {showRuntimeButtons ? (
        <>
          <GitHubProfileControl
            githubAuthStatus={githubAuthStatus}
            isSwitchingGitHubAccount={isSwitchingGitHubAccount}
            onGitHubAccountSwitch={onGitHubAccountSwitch}
            showPlaceholder={showGitHubProfilePlaceholder}
          />
          {!hideDirectoryControls ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenDirectoryDialog}
                  className={footerButtonClassName}
                  aria-label={t('sessions.sidebar.header.actions.addProject')}
                >
                  {/* Use Remix line icons here so these profile-adjacent actions stay visibly outline-only. */}
                  <RiFolderAddLine className="h-4.5 w-4.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.header.actions.addProject')}</p></TooltipContent>
            </Tooltip>
          ) : null}
          <div className="min-w-0 flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={handleThemeToggle} className={footerButtonClassName} aria-label={themeToggleLabel}>
                {isDarkMode ? <RiSunLine className="h-4.5 w-4.5" /> : <RiMoonLine className="h-4.5 w-4.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{themeToggleLabel}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenSettings}
                onPointerEnter={preloadSettings}
                onPointerDown={preloadSettings}
                onFocus={preloadSettings}
                className={footerButtonClassName}
                aria-label={t('sessions.sidebar.footer.actions.settings')}
              >
                <RiSettings3Line className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.settings')}</p></TooltipContent>
          </Tooltip>
        </>
      ) : null}
    </div>
  );
}
