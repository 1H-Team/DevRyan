import * as React from 'react';
import {
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiGitBranchLine,
  RiKey2Line,
  RiLink,
} from '@remixicon/react';
import { Tabs } from '@base-ui/react/tabs';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  fullSettingsPermissions,
  mergeSettingsPermissionOverrides,
  type SettingsPermissionOverrides,
  type SettingsPermissions,
} from '@/lib/settings/permissions';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { SettingsPermissionOverrideMatrix } from './SettingsPermissionMatrix';
import { UserAnalytics } from './UserAnalytics';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import {
  capabilityLabels,
  capabilityKeys,
  formatBranchOption,
  requestJson,
  roleLabel,
  selectClassName,
  type ActivityRow,
  type BranchInventoryResponse,
  type BranchOption,
  type CapabilityKey,
  type CapabilityOverride,
  type GitHubAccountRow,
  type McpPolicyOverride,
  type ProjectRow,
  type Role,
  type UserPolicyPayload,
  type UserRow,
  type UserStatus,
} from './types';

interface UserDetailProps {
  user: UserRow;
  isAdmin: boolean;
  canViewDetailedAnalytics: boolean;
  projects: ProjectRow[];
  githubAccounts: GitHubAccountRow[];
  activity: ActivityRow[];
  onBack: () => void;
  onUsersChanged: () => Promise<void> | void;
  onTemporaryPassword: (password: string) => void;
}

interface BranchPreviewDraft {
  previewUrl: string;
  clientId: string;
  clientSecret: string;
  serviceTokenConfigured: boolean;
  savedPreviewUrl: string;
}

export const UserDetail: React.FC<UserDetailProps> = ({
  user,
  isAdmin,
  canViewDetailedAnalytics,
  projects,
  githubAccounts,
  activity,
  onBack,
  onUsersChanged,
  onTemporaryPassword,
}) => {
  const [busy, setBusy] = React.useState(false);
  const [resetPasswordOpen, setResetPasswordOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'core' | 'policy' | 'analytics'>('core');
  const [settingsPolicyOpen, setSettingsPolicyOpen] = React.useState(true);
  const [capabilityPolicyOpen, setCapabilityPolicyOpen] = React.useState(true);
  const [agentsPolicyOpen, setAgentsPolicyOpen] = React.useState(false);
  const [sourcePolicyOpen, setSourcePolicyOpen] = React.useState(false);
  const [mcpPolicyOpen, setMcpPolicyOpen] = React.useState(false);
  const [advancedPolicyOpen, setAdvancedPolicyOpen] = React.useState(false);
  const [mcpServerNames, setMcpServerNames] = React.useState<string[] | null>(null);

  const userActivity = React.useMemo(
    () => activity.filter((row) => row.target_id === user.id),
    [activity, user.id],
  );

  // --- Profile ---------------------------------------------------------------

  const [profileDraft, setProfileDraft] = React.useState({
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    githubAccountId: user.github_account_id || '',
  });

  React.useEffect(() => {
    setProfileDraft({
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      githubAccountId: user.github_account_id || '',
    });
  }, [user.display_name, user.github_account_id, user.id, user.role, user.status]);

  const normalizedDisplayName = profileDraft.displayName.trim();
  const profileDirty = normalizedDisplayName !== user.display_name
    || profileDraft.role !== user.role
    || profileDraft.status !== user.status
    || profileDraft.githubAccountId !== (user.github_account_id || '');

  const saveProfile = async () => {
    setBusy(true);
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: normalizedDisplayName,
          role: profileDraft.role,
          status: profileDraft.status,
          githubAccountId: profileDraft.githubAccountId || null,
        }),
      });
      await onUsersChanged();
      toast.success('Profile saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save profile');
    } finally { setBusy(false); }
  };

  // --- Policy overrides ------------------------------------------------------

  const [policyLoading, setPolicyLoading] = React.useState(false);
  const [policyResetOpen, setPolicyResetOpen] = React.useState(false);
  const [policyDraft, setPolicyDraft] = React.useState<{
    permissionOverrides: SettingsPermissionOverrides;
    inheritedPermissions: SettingsPermissions;
    inheritedCapabilities: Record<CapabilityKey, boolean>;
    capabilities: Record<CapabilityKey, CapabilityOverride>;
    settingsOverrides: string;
    agentsHidePermissionsUi: boolean;
    inheritedAgentsHideGlobalBehaviorUi: boolean;
    agentsHideGlobalBehaviorUi: boolean;
    inheritedSourceHideUpdateTab: boolean;
    sourceHideUpdateTab: boolean;
    mcpOverrides: Record<string, McpPolicyOverride>;
  }>({
    permissionOverrides: {},
    inheritedPermissions: fullSettingsPermissions(),
    inheritedCapabilities: Object.fromEntries(capabilityKeys.map((key) => [key, false])) as Record<CapabilityKey, boolean>,
    capabilities: Object.fromEntries(capabilityKeys.map((key) => [key, 'inherit'])) as Record<CapabilityKey, CapabilityOverride>,
    settingsOverrides: '{}',
    agentsHidePermissionsUi: false,
    inheritedAgentsHideGlobalBehaviorUi: false,
    agentsHideGlobalBehaviorUi: false,
    inheritedSourceHideUpdateTab: false,
    sourceHideUpdateTab: false,
    mcpOverrides: {},
  });
  const effectivePermissions = React.useMemo(() => mergeSettingsPermissionOverrides(
    policyDraft.inheritedPermissions,
    policyDraft.permissionOverrides,
  ), [policyDraft.inheritedPermissions, policyDraft.permissionOverrides]);

  const loadPolicy = React.useCallback(async () => {
    setPolicyLoading(true);
    try {
      const payload = await requestJson<UserPolicyPayload>(`/api/admin/users/${encodeURIComponent(user.id)}/policy`);
      const capabilities = Object.fromEntries(capabilityKeys.map((key) => {
        const value = payload.policy.capabilities?.[key];
        return [key, value === true ? 'on' : value === false ? 'off' : 'inherit'];
      })) as Record<CapabilityKey, CapabilityOverride>;
      const featureOverrides = payload.policy.feature_overrides || {};
      const inheritedAgentsHideGlobalBehaviorUi = payload.inheritedPolicy.featureOverrides?.agents?.hideGlobalBehaviorUi === true;
      const rawAgentsHideGlobalBehaviorUi = featureOverrides.agents?.hideGlobalBehaviorUi;
      const inheritedSourceHideUpdateTab = payload.inheritedPolicy.featureOverrides?.source?.hideUpdateTab === true;
      const rawSourceHideUpdateTab = featureOverrides.source?.hideUpdateTab;
      setPolicyDraft({
        permissionOverrides: payload.policy.settings_permission_overrides || {},
        inheritedPermissions: payload.inheritedPolicy.settingsPermissions,
        inheritedCapabilities: Object.fromEntries(capabilityKeys.map((key) => [key, payload.inheritedPolicy[key] === true])) as Record<CapabilityKey, boolean>,
        capabilities,
        settingsOverrides: JSON.stringify(payload.policy.settings_overrides || {}, null, 2),
        agentsHidePermissionsUi: featureOverrides.agents?.hidePermissionsUi === true,
        inheritedAgentsHideGlobalBehaviorUi,
        agentsHideGlobalBehaviorUi: typeof rawAgentsHideGlobalBehaviorUi === 'boolean'
          ? rawAgentsHideGlobalBehaviorUi
          : inheritedAgentsHideGlobalBehaviorUi,
        inheritedSourceHideUpdateTab,
        sourceHideUpdateTab: typeof rawSourceHideUpdateTab === 'boolean'
          ? rawSourceHideUpdateTab
          : inheritedSourceHideUpdateTab,
        mcpOverrides: Object.fromEntries(Object.entries(featureOverrides.mcp || {})
          .filter(([, state]) => state === 'on' || state === 'off')),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load user policy');
    } finally {
      setPolicyLoading(false);
    }
  }, [user.id]);

  React.useEffect(() => { void loadPolicy(); }, [loadPolicy]);

  React.useEffect(() => {
    if (activeTab !== 'policy' || mcpServerNames !== null) return;
    void requestJson<Array<{ name?: string }>>('/api/config/mcp')
      .then((servers) => {
        setMcpServerNames((Array.isArray(servers) ? servers : [])
          .map((server) => String(server?.name || '').trim())
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right)));
      })
      .catch(() => setMcpServerNames([]));
  }, [activeTab, mcpServerNames]);

  const saveUserPolicy = async () => {
    setBusy(true);
    try {
      const settingsOverrides = JSON.parse(policyDraft.settingsOverrides) as unknown;
      if (!settingsOverrides || typeof settingsOverrides !== 'object' || Array.isArray(settingsOverrides)) {
        throw new Error('Settings overrides must be a JSON object');
      }
      const capabilities = Object.fromEntries(Object.entries(policyDraft.capabilities)
        .filter(([, value]) => value !== 'inherit')
        .map(([key, value]) => [key, value === 'on']));
      const mcpFeatureOverrides = Object.fromEntries(Object.entries(policyDraft.mcpOverrides)
        .filter(([, state]) => state === 'on' || state === 'off'));
      const agentFeatureOverrides = {
        ...(policyDraft.agentsHidePermissionsUi ? { hidePermissionsUi: true } : {}),
        ...(policyDraft.agentsHideGlobalBehaviorUi !== policyDraft.inheritedAgentsHideGlobalBehaviorUi
          ? { hideGlobalBehaviorUi: policyDraft.agentsHideGlobalBehaviorUi }
          : {}),
      };
      const sourceFeatureOverrides = {
        ...(policyDraft.sourceHideUpdateTab !== policyDraft.inheritedSourceHideUpdateTab
          ? { hideUpdateTab: policyDraft.sourceHideUpdateTab }
          : {}),
      };
      await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}/policy`, {
        method: 'PUT',
        body: JSON.stringify({
          settingsPermissionOverrides: policyDraft.permissionOverrides,
          capabilities,
          settingsOverrides,
          featureOverrides: {
            ...(Object.keys(agentFeatureOverrides).length > 0 ? { agents: agentFeatureOverrides } : {}),
            ...(Object.keys(sourceFeatureOverrides).length > 0 ? { source: sourceFeatureOverrides } : {}),
            ...(Object.keys(mcpFeatureOverrides).length > 0 ? { mcp: mcpFeatureOverrides } : {}),
          },
        }),
      });
      await loadPolicy();
      toast.success('User policy saved; active sessions were revoked');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save user policy');
    } finally { setBusy(false); }
  };

  const resetUserPolicy = async () => {
    setBusy(true);
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}/policy`, { method: 'DELETE' });
      await loadPolicy();
      setPolicyResetOpen(false);
      toast.success('User policy reset');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset user policy');
    } finally { setBusy(false); }
  };

  // --- Projects & branches ---------------------------------------------------

  const [assignment, setAssignment] = React.useState({
    projectId: '', branches: [] as string[], defaultBranch: '',
  });
  const [assignmentBranches, setAssignmentBranches] = React.useState<string[]>([]);
  const [assignmentBranchOptions, setAssignmentBranchOptions] = React.useState<BranchOption[]>([]);
  const [assignmentExists, setAssignmentExists] = React.useState(false);
  const [persistedAssignmentBranches, setPersistedAssignmentBranches] = React.useState<string[]>([]);
  const [branchPreviewDrafts, setBranchPreviewDrafts] = React.useState<Record<string, BranchPreviewDraft>>({});
  const [openBranchPreviews, setOpenBranchPreviews] = React.useState<Record<string, boolean>>({});
  const [previewBusyBranch, setPreviewBusyBranch] = React.useState<string | null>(null);
  const [removePreviewBranch, setRemovePreviewBranch] = React.useState<string | null>(null);
  const [removeAccessOpen, setRemoveAccessOpen] = React.useState(false);

  React.useEffect(() => {
    setAssignment((current) => ({ ...current, projectId: current.projectId || projects[0]?.id || '' }));
  }, [projects]);

  React.useEffect(() => {
    if (!assignment.projectId) {
      setAssignmentBranches([]);
      setAssignmentBranchOptions([]);
      setAssignmentExists(false);
      setPersistedAssignmentBranches([]);
      setBranchPreviewDrafts({});
      return;
    }
    void Promise.all([
      requestJson<BranchInventoryResponse>(
        `/api/admin/projects/${encodeURIComponent(assignment.projectId)}/branches`,
      ),
      requestJson<{
        access: { is_default: boolean } | null;
        branches: Array<{
          branch_name: string;
          is_default: boolean;
          preview?: {
            previewUrl: string;
            serviceTokenConfigured: boolean;
          } | null;
        }>;
      }>(`/api/admin/users/${encodeURIComponent(user.id)}/projects/${encodeURIComponent(assignment.projectId)}`),
    ]).then(([available, currentAccess]) => {
      const options = available.branchOptions?.length
        ? available.branchOptions
        : (available.branches || []).map((name) => ({ name, local: true, remoteRefs: [], preferredRef: name }));
      setAssignmentBranches(options.map((option) => option.name));
      setAssignmentBranchOptions(options);
      setAssignmentExists(Boolean(currentAccess.access));
      const assignedBranches = (currentAccess.branches || [])
        .map((row) => row.branch_name)
        .filter((branch) => available.branches.includes(branch));
      const assignedDefault = currentAccess.branches.find((row) => row.is_default)?.branch_name || '';
      const fallback = available.defaultBranch || available.branches?.[0] || '';
      setPersistedAssignmentBranches(assignedBranches);
      setBranchPreviewDrafts(Object.fromEntries(options.map((option) => {
        const preview = currentAccess.branches.find((row) => row.branch_name === option.name)?.preview;
        return [option.name, {
          previewUrl: preview?.previewUrl || '',
          clientId: '',
          clientSecret: '',
          serviceTokenConfigured: preview?.serviceTokenConfigured === true,
          savedPreviewUrl: preview?.previewUrl || '',
        } satisfies BranchPreviewDraft];
      })));
      setAssignment((current) => ({
        ...current,
        branches: assignedBranches.length > 0 ? assignedBranches : fallback ? [fallback] : [],
        defaultBranch: assignedDefault || fallback,
      }));
    }).catch((error) => toast.error(error instanceof Error ? error.message : 'Failed to load branches'));
  }, [assignment.projectId, user.id]);

  const assignmentBranchLabel = React.useCallback((branchName: string) => {
    const option = assignmentBranchOptions.find((entry) => entry.name === branchName);
    return option ? formatBranchOption(option) : branchName;
  }, [assignmentBranchOptions]);

  const saveBranchAccess = async () => {
    if (!assignment.projectId || assignment.branches.length === 0 || !assignment.defaultBranch) return;
    setBusy(true);
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}/projects/${encodeURIComponent(assignment.projectId)}/branches`, {
        method: 'PUT',
        body: JSON.stringify({
          branches: assignment.branches,
          defaultBranch: assignment.defaultBranch,
        }),
      });
      setAssignmentExists(true);
      setPersistedAssignmentBranches(assignment.branches);
      setBranchPreviewDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([branchName]) => assignment.branches.includes(branchName)),
      ));
      await onUsersChanged();
      toast.success('Project and branch assigned');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to assign project');
    } finally { setBusy(false); }
  };

  const branchPreviewEndpoint = React.useCallback((branchName: string) => (
    `/api/admin/users/${encodeURIComponent(user.id)}/projects/${encodeURIComponent(assignment.projectId)}/branches/${encodeURIComponent(branchName)}/preview`
  ), [assignment.projectId, user.id]);

  const updateBranchPreviewDraft = (branchName: string, changes: Partial<BranchPreviewDraft>) => {
    setBranchPreviewDrafts((current) => {
      const previous = current[branchName] || {
        previewUrl: '',
        clientId: '',
        clientSecret: '',
        serviceTokenConfigured: false,
        savedPreviewUrl: '',
      };
      return {
        ...current,
        [branchName]: {
          ...previous,
          ...changes,
        },
      };
    });
  };

  const branchPreviewServiceToken = (draft: BranchPreviewDraft) => {
    const clientId = draft.clientId.trim();
    const clientSecret = draft.clientSecret.trim();
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      throw new Error('Enter both Client ID and Client Secret to replace the service token');
    }
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };

  const saveBranchPreview = async (branchName: string) => {
    const draft = branchPreviewDrafts[branchName];
    if (!draft?.previewUrl.trim()) return;
    setPreviewBusyBranch(branchName);
    try {
      const serviceToken = branchPreviewServiceToken(draft);
      const payload = await requestJson<{ preview: {
        previewUrl: string;
        serviceTokenConfigured: boolean;
      } }>(branchPreviewEndpoint(branchName), {
        method: 'PUT',
        body: JSON.stringify({
          previewUrl: draft.previewUrl.trim(),
          ...(serviceToken ? { serviceToken } : {}),
        }),
      });
      updateBranchPreviewDraft(branchName, {
        previewUrl: payload.preview.previewUrl,
        savedPreviewUrl: payload.preview.previewUrl,
        serviceTokenConfigured: payload.preview.serviceTokenConfigured,
        clientId: '',
        clientSecret: '',
      });
      toast.success(`Preview saved and verified for ${branchName}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save branch preview');
    } finally {
      setPreviewBusyBranch(null);
    }
  };

  const testBranchPreview = async (branchName: string) => {
    const draft = branchPreviewDrafts[branchName];
    if (!draft?.previewUrl.trim()) return;
    setPreviewBusyBranch(branchName);
    try {
      const serviceToken = branchPreviewServiceToken(draft);
      await requestJson(branchPreviewEndpoint(branchName) + '/test', {
        method: 'POST',
        body: JSON.stringify({
          previewUrl: draft.previewUrl.trim(),
          ...(serviceToken ? { serviceToken } : {}),
        }),
      });
      toast.success(`Connection to ${branchName} preview succeeded`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Branch preview connection failed');
    } finally {
      setPreviewBusyBranch(null);
    }
  };

  const removeBranchPreview = async () => {
    const branchName = removePreviewBranch;
    if (!branchName) return;
    setPreviewBusyBranch(branchName);
    try {
      await requestJson(branchPreviewEndpoint(branchName), { method: 'DELETE' });
      updateBranchPreviewDraft(branchName, {
        previewUrl: '',
        savedPreviewUrl: '',
        serviceTokenConfigured: false,
        clientId: '',
        clientSecret: '',
      });
      setRemovePreviewBranch(null);
      toast.success(`Preview removed for ${branchName}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove branch preview');
    } finally {
      setPreviewBusyBranch(null);
    }
  };

  const removeProjectAccess = async () => {
    if (!assignment.projectId) return;
    setBusy(true);
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}/projects/${encodeURIComponent(assignment.projectId)}`, {
        method: 'DELETE',
      });
      setAssignmentExists(false);
      setPersistedAssignmentBranches([]);
      setBranchPreviewDrafts({});
      setAssignment((current) => ({ ...current, branches: [], defaultBranch: '' }));
      setRemoveAccessOpen(false);
      await onUsersChanged();
      toast.success('Project access removed and worktrees archived');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove project access');
    } finally { setBusy(false); }
  };

  const selectedProject = projects.find((project) => project.id === assignment.projectId) || null;
  const permissionOverrideCount = React.useMemo(() => Object.values(policyDraft.permissionOverrides)
    .reduce((total, permission) => total + Object.values(permission || {}).filter((value) => typeof value === 'boolean').length, 0), [policyDraft.permissionOverrides]);
  const capabilityOverrideCount = React.useMemo(() => capabilityLabels
    .filter(([key]) => policyDraft.capabilities[key] !== 'inherit').length, [policyDraft.capabilities]);
  const botsAccessAllowed = policyDraft.capabilities.bots === 'inherit'
    ? policyDraft.inheritedCapabilities.bots
    : policyDraft.capabilities.bots === 'on';
  const mcpOverrideCount = React.useMemo(
    () => Object.values(policyDraft.mcpOverrides).filter((value) => value === 'on' || value === 'off').length,
    [policyDraft.mcpOverrides],
  );
  const mcpPolicyRows = React.useMemo(() => {
    const names = new Set(mcpServerNames || []);
    for (const name of Object.keys(policyDraft.mcpOverrides)) names.add(name);
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [mcpServerNames, policyDraft.mcpOverrides]);
  const advancedOverrideCount = React.useMemo(() => {
    try {
      const value = JSON.parse(policyDraft.settingsOverrides) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0;
    } catch {
      return 1;
    }
  }, [policyDraft.settingsOverrides]);

  const tabClassName = 'relative shrink-0 rounded-lg px-3 py-2 typography-ui-label font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] data-[active]:bg-[var(--surface-elevated)] data-[active]:text-foreground data-[active]:shadow-sm';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onBack} aria-label="Back to User Management">
          <RiArrowLeftLine className="h-4 w-4" /> Back
        </Button>
        <div className="min-w-0">
          <h2 className="typography-ui-header font-semibold text-foreground truncate">{user.display_name}</h2>
          <p className="typography-meta text-muted-foreground truncate">{user.email} · <span className="capitalize">{roleLabel(user.role)}</span> · <span className="capitalize">{user.status}</span></p>
        </div>
      </div>

      <Tabs.Root
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as 'core' | 'policy' | 'analytics')}
        className="space-y-6"
      >
        <div className="flex justify-center">
          <div className="inline-flex max-w-full overflow-x-auto rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 p-1">
            <Tabs.List className="flex items-center gap-1" aria-label={`Details for ${user.display_name}`}>
              <Tabs.Tab className={tabClassName} value="core">Core Details</Tabs.Tab>
              <Tabs.Tab className={tabClassName} value="policy">Policy Overrides</Tabs.Tab>
              <Tabs.Tab className={tabClassName} value="analytics">Analytics</Tabs.Tab>
            </Tabs.List>
          </div>
        </div>

        <Tabs.Panel value="core" keepMounted className="max-w-4xl space-y-6 [[hidden]]:hidden">

      <SettingsSection
        title="Profile"
        description={isAdmin ? 'Save display name, role, status, and the user-wide GitHub association together.' : 'Profile details are read-only for senior developers.'}
      >
        <div className="space-y-3">
          {isAdmin && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 typography-meta text-foreground sm:col-span-2">
                <span>Display Name</span>
                <Input
                  aria-label={`Display Name for ${user.email}`}
                  value={profileDraft.displayName}
                  maxLength={120}
                  onChange={(event) => setProfileDraft((current) => ({ ...current, displayName: event.target.value }))}
                  disabled={busy}
                />
              </label>
              <label className="space-y-1 typography-meta text-foreground">
                <span>Role</span>
                <select aria-label={`Role for ${user.email}`} className={selectClassName} value={profileDraft.role} onChange={(event) => setProfileDraft((current) => ({ ...current, role: event.target.value as Role }))} disabled={busy}>
                  <option value="developer">Developer</option>
                  <option value="senior_developer">Senior Developer</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <label className="space-y-1 typography-meta text-foreground">
                <span>Status</span>
                <select aria-label={`Status for ${user.email}`} className={selectClassName} value={profileDraft.status} onChange={(event) => setProfileDraft((current) => ({ ...current, status: event.target.value as UserStatus }))} disabled={busy}>
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
              <label className="space-y-1 typography-meta text-foreground sm:col-span-2">
                <span>GitHub Account</span>
                <select aria-label={`GitHub Account for ${user.email}`} className={selectClassName} value={profileDraft.githubAccountId} onChange={(event) => setProfileDraft((current) => ({ ...current, githubAccountId: event.target.value }))} disabled={busy}>
                  <option value="">No GitHub Account</option>
                  {githubAccounts.map((account) => {
                    const assignedElsewhere = Boolean(account.assignedUser && account.assignedUser.id !== user.id);
                    return (
                      <option key={account.id} value={account.id} disabled={assignedElsewhere}>
                        {account.user?.login || account.id}{assignedElsewhere ? ` — assigned to ${account.assignedUser?.displayName}` : ''}
                      </option>
                    );
                  })}
                </select>
              </label>
            </div>
          )}
          {!isAdmin && (
            <dl className="grid gap-2 sm:grid-cols-2">
              {[
                ['Display Name', user.display_name],
                ['Role', roleLabel(user.role)],
                ['Status', user.status],
                ['GitHub Account', user.github_account_id || 'Not assigned'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-2">
                  <dt className="typography-micro text-muted-foreground">{label}</dt>
                  <dd className="mt-0.5 typography-ui-label capitalize text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <Button size="sm" onClick={() => void saveProfile()} disabled={busy || !profileDirty || !normalizedDisplayName}>
                Save Profile
              </Button>
            )}
            {isAdmin && (
              <Button variant="outline" size="sm" onClick={() => setResetPasswordOpen(true)} disabled={busy}>
                <RiKey2Line className="h-4 w-4" /> Reset Password
              </Button>
            )}
          </div>
        </div>
      </SettingsSection>

      <ResetPasswordDialog
        user={user}
        open={resetPasswordOpen}
        onOpenChange={setResetPasswordOpen}
        onTemporaryPassword={onTemporaryPassword}
      />

      <SettingsSection
          title="Projects & Branches"
          description={isAdmin
            ? "Choose which shared worktree branches are visible in this user's sidebar and dropdowns, plus one default branch."
            : "Browse this user's project and branch grants. These values are read-only."}
          divider
        >
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 typography-meta text-foreground">
                <span>Project</span>
                <select aria-label="Assigned Project" className={selectClassName} value={assignment.projectId} onChange={(event) => setAssignment((current) => ({ ...current, projectId: event.target.value, branches: [], defaultBranch: '' }))}>
                  <option value="">Select Project</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
                </select>
              </label>
              <label className="space-y-1 typography-meta text-foreground">
                <span>Default Branch</span>
                <select aria-label="Default Branch" className={selectClassName} value={assignment.defaultBranch} disabled={!isAdmin} onChange={(event) => setAssignment((current) => ({
                  ...current,
                  defaultBranch: event.target.value,
                  branches: current.branches.includes(event.target.value) ? current.branches : [...current.branches, event.target.value],
                }))}>
                  <option value="">Select Default Branch</option>
                  {assignmentBranches.map((branch) => <option key={branch} value={branch}>{assignmentBranchLabel(branch)}</option>)}
                </select>
              </label>
            </div>
            <div className="grid gap-2">
              {assignmentBranches.map((branch) => {
                const checked = assignment.branches.includes(branch);
                const persisted = persistedAssignmentBranches.includes(branch);
                const previewOpen = openBranchPreviews[branch] === true;
                const draft = branchPreviewDrafts[branch] || {
                  previewUrl: '',
                  clientId: '',
                  clientSecret: '',
                  serviceTokenConfigured: false,
                  savedPreviewUrl: '',
                };
                const previewBusy = previewBusyBranch === branch;
                const hasPreview = Boolean(draft.savedPreviewUrl);
                return (
                  <div key={branch} className="overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)]">
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <label className="flex min-w-0 items-center gap-2 typography-meta text-foreground">
                        <Checkbox
                          checked={checked}
                          disabled={!isAdmin}
                          onChange={(nextChecked) => setAssignment((current) => ({
                            ...current,
                            branches: nextChecked ? [...new Set([...current.branches, branch])] : current.branches.filter((value) => value !== branch),
                            defaultBranch: !nextChecked && current.defaultBranch === branch ? '' : current.defaultBranch,
                          }))}
                          ariaLabel={`Show ${branch}`}
                          className="size-4"
                          iconClassName="size-4"
                        />
                        <span className="truncate">{assignmentBranchLabel(branch)}</span>
                        {assignment.defaultBranch === branch ? (
                          <span className="rounded-full bg-[var(--interactive-primary)]/10 px-2 py-0.5 typography-micro text-[var(--interactive-primary)]">Default</span>
                        ) : null}
                      </label>
                      {checked ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          onClick={() => setOpenBranchPreviews((current) => ({ ...current, [branch]: !previewOpen }))}
                          aria-expanded={previewOpen}
                          aria-controls={`branch-preview-${branch}`}
                        >
                          <RiLink className="h-4 w-4" />
                          {hasPreview ? 'Preview Configured' : 'Add Preview'}
                          <RiArrowDownSLine className={`h-4 w-4 transition-transform ${previewOpen ? 'rotate-180' : ''}`} />
                        </Button>
                      ) : null}
                    </div>
                    {checked && previewOpen ? (
                      <div id={`branch-preview-${branch}`} className="space-y-3 border-t border-border/60 bg-[var(--surface-subtle)]/30 p-3">
                        {!persisted ? (
                          <p className="typography-meta text-[var(--status-warning)]">Save branch visibility before configuring its preview.</p>
                        ) : null}
                        <label className="block space-y-1 typography-meta text-foreground">
                          <span>Preview URL</span>
                          <Input
                            aria-label={`Preview URL for ${branch}`}
                            value={draft.previewUrl}
                            placeholder="https://preview.example.com"
                            disabled={!isAdmin || previewBusy}
                            onChange={(event) => updateBranchPreviewDraft(branch, { previewUrl: event.target.value })}
                          />
                        </label>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="space-y-1 typography-meta text-foreground">
                            <span>Client ID</span>
                            <Input
                              aria-label={`Preview Client ID for ${branch}`}
                              value={draft.clientId}
                              placeholder={draft.serviceTokenConfigured ? 'Enter to replace token' : 'Cloudflare Access Client ID'}
                              autoComplete="off"
                              disabled={!isAdmin || previewBusy}
                              onChange={(event) => updateBranchPreviewDraft(branch, { clientId: event.target.value })}
                            />
                          </label>
                          <label className="space-y-1 typography-meta text-foreground">
                            <span>Client Secret</span>
                            <Input
                              type="password"
                              aria-label={`Preview Client Secret for ${branch}`}
                              value={draft.clientSecret}
                              placeholder={draft.serviceTokenConfigured ? 'Enter to replace token' : 'Cloudflare Access Client Secret'}
                              autoComplete="new-password"
                              disabled={!isAdmin || previewBusy}
                              onChange={(event) => updateBranchPreviewDraft(branch, { clientSecret: event.target.value })}
                            />
                          </label>
                        </div>
                        {draft.serviceTokenConfigured ? (
                          <p className="flex items-center gap-2 typography-meta text-[var(--status-success)]">
                            <RiKey2Line className="h-4 w-4" /> Service token configured. Saved credentials remain write-only.
                          </p>
                        ) : null}
                        {isAdmin ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void testBranchPreview(branch)}
                              disabled={!persisted || previewBusy || !draft.previewUrl.trim()}
                            >
                              Test Connection
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => void saveBranchPreview(branch)}
                              disabled={!persisted || previewBusy || !draft.previewUrl.trim()}
                            >
                              {draft.serviceTokenConfigured ? 'Save / Replace Token' : 'Save Preview'}
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => setRemovePreviewBranch(branch)}
                              disabled={previewBusy || !hasPreview}
                            >
                              <RiDeleteBinLine className="h-4 w-4" /> Remove
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {isAdmin ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveBranchAccess()} disabled={busy || !assignment.projectId || assignment.branches.length === 0 || !assignment.defaultBranch}>
                  <RiGitBranchLine className="h-4 w-4" /> Save Branch Visibility
                </Button>
                <Button variant="destructive" onClick={() => setRemoveAccessOpen(true)} disabled={busy || !assignmentExists}>
                  <RiDeleteBinLine className="h-4 w-4" /> Remove Project Access
                </Button>
              </div>
            ) : null}
          </div>
        </SettingsSection>
        </Tabs.Panel>

        <Tabs.Panel value="policy" keepMounted className="max-w-4xl [[hidden]]:hidden">

      <SettingsSection
          title="Policy Overrides"
          description={isAdmin
            ? 'Override Settings access, core capabilities, and advanced user-scoped settings independently.'
            : 'Review inherited and explicit Read and Edit policy values for this user.'}
        >
          <div className="space-y-4">
            <Collapsible open={settingsPolicyOpen} onOpenChange={setSettingsPolicyOpen}>
              <div className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25">
                <CollapsibleTrigger className="rounded-xl px-3 py-3">
                  <span className="min-w-0">
                    <span className="block typography-ui-label font-semibold text-foreground">Settings Access Overrides</span>
                    <span className="block typography-micro text-muted-foreground">Read and Edit Access per Settings Section.</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-muted-foreground">{permissionOverrideCount} Overrides</span>
                    {settingsPolicyOpen ? <RiArrowDownSLine className="h-4 w-4" /> : <RiArrowRightSLine className="h-4 w-4" />}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pb-3">
                  {user.role === 'admin' ? (
                    <div className="mb-3 rounded-lg border border-border/60 bg-[var(--surface-subtle)]/35 px-3 py-2 typography-meta text-muted-foreground">
                      Administrator Settings access is fixed at full Read and Edit.
                    </div>
                  ) : null}
                  <SettingsPermissionOverrideMatrix
                    overrides={policyDraft.permissionOverrides}
                    inherited={policyDraft.inheritedPermissions}
                    effective={effectivePermissions}
                    disabled={!isAdmin || policyLoading || busy || user.role === 'admin'}
                    onChange={(permissionOverrides) => setPolicyDraft((current) => ({ ...current, permissionOverrides }))}
                  />
                </CollapsibleContent>
              </div>
            </Collapsible>

            <label className="flex items-start gap-2 rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25 px-3 py-3 typography-meta text-foreground">
              <Checkbox
                checked={botsAccessAllowed}
                disabled={!isAdmin || policyLoading || busy || user.role === 'admin'}
                onChange={(checked) => setPolicyDraft((current) => ({
                  ...current,
                  capabilities: {
                    ...current.capabilities,
                    bots: checked === current.inheritedCapabilities.bots
                      ? 'inherit'
                      : checked ? 'on' : 'off',
                  },
                }))}
                ariaLabel="Allow Bots Access"
                className="mt-0.5 size-4"
                iconClassName="size-4"
              />
              <span>
                <span className="block typography-ui-label font-semibold text-foreground">Allow Bots Access</span>
                <span className="block typography-micro text-muted-foreground">
                  When Off, This User Has an Agents-Only Interface and Cannot Access Bot Settings, Conversations, Streams, or APIs.
                  {' '}Inherited: {policyDraft.inheritedCapabilities.bots ? 'On' : 'Off'}.
                </span>
              </span>
            </label>

            <Collapsible open={capabilityPolicyOpen} onOpenChange={setCapabilityPolicyOpen}>
              <div className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25">
                <CollapsibleTrigger className="rounded-xl px-3 py-3">
                  <span className="min-w-0">
                    <span className="block typography-ui-label font-semibold text-foreground">Core Capability Overrides</span>
                    <span className="block typography-micro text-muted-foreground">Independent Access to Browser, Files, Terminal, Branch Creation, Git, GitHub, and Administration.</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-muted-foreground">{capabilityOverrideCount} Overrides</span>
                    {capabilityPolicyOpen ? <RiArrowDownSLine className="h-4 w-4" /> : <RiArrowRightSLine className="h-4 w-4" />}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pb-3">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {capabilityLabels.map(([key, label]) => {
                      const inheritedLabel = `Inherit (${policyDraft.inheritedCapabilities[key] ? 'On' : 'Off'})`;
                      return (
                        <label key={key} className="space-y-1 typography-meta text-foreground">
                          <span>{label}</span>
                          <select
                            aria-label={`${label} override: ${inheritedLabel}`}
                            className={selectClassName}
                            value={policyDraft.capabilities[key]}
                            onChange={(event) => setPolicyDraft((current) => ({
                              ...current,
                              capabilities: { ...current.capabilities, [key]: event.target.value as CapabilityOverride },
                            }))}
                            disabled={!isAdmin || policyLoading || user.role === 'admin'}
                          >
                            <option value="inherit">{inheritedLabel}</option>
                            <option value="on">On</option>
                            <option value="off">Off</option>
                          </select>
                        </label>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <Collapsible open={agentsPolicyOpen} onOpenChange={setAgentsPolicyOpen}>
              <div className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25">
                <CollapsibleTrigger className="rounded-xl px-3 py-3">
                  <span className="min-w-0">
                    <span className="block typography-ui-label font-semibold text-foreground">Agent Overrides</span>
                    <span className="block typography-micro text-muted-foreground">Control Which Agent Settings This User Can See.</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-muted-foreground">{
                      Number(policyDraft.agentsHidePermissionsUi)
                      + Number(policyDraft.agentsHideGlobalBehaviorUi !== policyDraft.inheritedAgentsHideGlobalBehaviorUi)
                    } Overrides</span>
                    {agentsPolicyOpen ? <RiArrowDownSLine className="h-4 w-4" /> : <RiArrowRightSLine className="h-4 w-4" />}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pb-3">
                  <label className="flex items-start gap-2 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-foreground">
                    <Checkbox
                      checked={policyDraft.agentsHidePermissionsUi}
                      disabled={!isAdmin || policyLoading || busy || user.role === 'admin'}
                      onChange={(checked) => setPolicyDraft((current) => ({ ...current, agentsHidePermissionsUi: checked }))}
                      ariaLabel="Hide Agent Permission Controls"
                      className="mt-0.5 size-4"
                      iconClassName="size-4"
                    />
                    <span>
                      <span className="block typography-ui-label text-foreground">Hide Agent Permission Controls</span>
                      <span className="block typography-micro text-muted-foreground">
                        The Tool Permission Summary and Advanced Allow/Ask/Deny Editor Disappear from This User's Agents Page. Agents Stay Usable.
                      </span>
                    </span>
                  </label>
                  <label className="mt-2 flex items-start gap-2 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-foreground">
                    <Checkbox
                      checked={policyDraft.agentsHideGlobalBehaviorUi}
                      disabled={!isAdmin || policyLoading || busy || user.role === 'admin'}
                      onChange={(checked) => setPolicyDraft((current) => ({ ...current, agentsHideGlobalBehaviorUi: checked }))}
                      ariaLabel="Hide Global Agent Behavior"
                      className="mt-0.5 size-4"
                      iconClassName="size-4"
                    />
                    <span>
                      <span className="block typography-ui-label text-foreground">Hide Global Agent Behavior</span>
                      <span className="block typography-micro text-muted-foreground">
                        The Global Behavior Item and Its Agent Instructions and Response-Style Settings Disappear from This User's Agents Page.
                        {' '}Inherited: {policyDraft.inheritedAgentsHideGlobalBehaviorUi ? 'On' : 'Off'}.
                      </span>
                    </span>
                  </label>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <Collapsible open={sourcePolicyOpen} onOpenChange={setSourcePolicyOpen}>
              <div className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25">
                <CollapsibleTrigger className="rounded-xl px-3 py-3">
                  <span className="min-w-0">
                    <span className="block typography-ui-label font-semibold text-foreground">Source Overrides</span>
                    <span className="block typography-micro text-muted-foreground">Control Which Source Actions This User Can See in the Right Sidebar.</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-muted-foreground">
                      {Number(policyDraft.sourceHideUpdateTab !== policyDraft.inheritedSourceHideUpdateTab)} Overrides
                    </span>
                    {sourcePolicyOpen ? <RiArrowDownSLine className="h-4 w-4" /> : <RiArrowRightSLine className="h-4 w-4" />}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pb-3">
                  <label className="flex items-start gap-2 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-foreground">
                    <Checkbox
                      checked={policyDraft.sourceHideUpdateTab}
                      disabled={!isAdmin || policyLoading || busy || user.role === 'admin'}
                      onChange={(checked) => setPolicyDraft((current) => ({ ...current, sourceHideUpdateTab: checked }))}
                      ariaLabel="Hide Source Update Tab"
                      className="mt-0.5 size-4"
                      iconClassName="size-4"
                    />
                    <span>
                      <span className="block typography-ui-label text-foreground">Hide Update Tab</span>
                      <span className="block typography-micro text-muted-foreground">
                        Removes the Update Tab from Source in the Right Sidebar for This User.
                        {' '}Inherited: {policyDraft.inheritedSourceHideUpdateTab ? 'On' : 'Off'}.
                      </span>
                    </span>
                  </label>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <Collapsible open={mcpPolicyOpen} onOpenChange={setMcpPolicyOpen}>
              <div className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25">
                <CollapsibleTrigger className="rounded-xl px-3 py-3">
                  <span className="min-w-0">
                    <span className="block typography-ui-label font-semibold text-foreground">MCP Server Overrides</span>
                    <span className="block typography-micro text-muted-foreground">Force Individual MCP Servers Enabled or Disabled for This User.</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-muted-foreground">{mcpOverrideCount} Overrides</span>
                    {mcpPolicyOpen ? <RiArrowDownSLine className="h-4 w-4" /> : <RiArrowRightSLine className="h-4 w-4" />}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pb-3">
                  {mcpServerNames === null ? (
                    <p className="typography-meta text-muted-foreground">Loading MCP servers…</p>
                  ) : mcpPolicyRows.length === 0 ? (
                    <p className="typography-meta text-muted-foreground">No MCP servers are configured on this installation.</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {mcpPolicyRows.map((serverName) => {
                        const value = policyDraft.mcpOverrides[serverName] || 'inherit';
                        return (
                          <label key={serverName} className="space-y-1 typography-meta text-foreground">
                            <span className="block truncate" title={serverName}>{serverName}</span>
                            <select
                              aria-label={`MCP Override for ${serverName}`}
                              className={selectClassName}
                              value={value}
                              onChange={(event) => setPolicyDraft((current) => {
                                const nextValue = event.target.value as McpPolicyOverride;
                                const mcpOverrides = { ...current.mcpOverrides };
                                if (nextValue === 'inherit') delete mcpOverrides[serverName];
                                else mcpOverrides[serverName] = nextValue;
                                return { ...current, mcpOverrides };
                              })}
                              disabled={!isAdmin || policyLoading || busy || user.role === 'admin'}
                            >
                              <option value="inherit">Inherit</option>
                              <option value="on">Force On</option>
                              <option value="off">Force Off</option>
                            </select>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p className="mt-2 typography-micro text-muted-foreground">
                    Forced servers cannot be toggled by this user. Their own toggles never affect other accounts.
                  </p>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <Collapsible open={advancedPolicyOpen} onOpenChange={setAdvancedPolicyOpen}>
              <div className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25">
                <CollapsibleTrigger className="rounded-xl px-3 py-3">
                  <span className="min-w-0">
                    <span className="block typography-ui-label font-semibold text-foreground">Advanced Settings Overrides</span>
                    <span className="block typography-micro text-muted-foreground">User-Scoped JSON Values; Sensitive Values Stay Redacted in Audit Details.</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-muted-foreground">{advancedOverrideCount} Keys</span>
                    {advancedPolicyOpen ? <RiArrowDownSLine className="h-4 w-4" /> : <RiArrowRightSLine className="h-4 w-4" />}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pb-3">
                  <label className="block space-y-1 typography-meta text-foreground">
                    <span>User-Scoped Settings Overrides (JSON)</span>
                    <textarea
                      aria-label="User Settings Overrides JSON"
                      className="min-h-32 w-full resize-y rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-[var(--interactive-focus-ring)]"
                      value={policyDraft.settingsOverrides}
                      onChange={(event) => setPolicyDraft((current) => ({ ...current, settingsOverrides: event.target.value }))}
                      spellCheck={false}
                      disabled={!isAdmin || policyLoading}
                    />
                  </label>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {isAdmin ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveUserPolicy()} disabled={busy || policyLoading}>Save User Policy</Button>
                <Button variant="outline" onClick={() => setPolicyResetOpen(true)} disabled={busy || policyLoading}>Reset to Inherited</Button>
              </div>
            ) : null}
          </div>
        </SettingsSection>
        </Tabs.Panel>

        <Tabs.Panel value="analytics" keepMounted className="[[hidden]]:hidden">
          <UserAnalytics
            user={user}
            active={activeTab === 'analytics'}
            canViewDetailed={canViewDetailedAnalytics}
            fallbackActivity={userActivity}
          />
        </Tabs.Panel>
      </Tabs.Root>

      <ConfirmActionDialog
        open={removeAccessOpen}
        onOpenChange={setRemoveAccessOpen}
        title="Remove Project Access"
        description={`Remove ${selectedProject?.label || 'this project'} from ${user.display_name} and archive all assigned worktrees?`}
        confirmLabel="Remove Access"
        destructive
        busy={busy}
        onConfirm={() => void removeProjectAccess()}
      />
      <ConfirmActionDialog
        open={policyResetOpen}
        onOpenChange={setPolicyResetOpen}
        title="Reset User Policy"
        description="Reset all per-user policy and settings overrides to inherited defaults?"
        confirmLabel="Reset Policy"
        destructive
        busy={busy}
        onConfirm={() => void resetUserPolicy()}
      />
      <ConfirmActionDialog
        open={removePreviewBranch !== null}
        onOpenChange={(open) => { if (!open) setRemovePreviewBranch(null); }}
        title="Remove Branch Preview"
        description={`Remove the preview URL and stored service token for ${removePreviewBranch || 'this branch'}?`}
        confirmLabel="Remove Preview"
        destructive
        busy={removePreviewBranch ? previewBusyBranch === removePreviewBranch : false}
        onConfirm={() => void removeBranchPreview()}
      />
    </div>
  );
};
