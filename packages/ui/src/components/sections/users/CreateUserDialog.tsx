import * as React from 'react';
import { RiAddLine } from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  requestJson,
  selectClassName,
  formatBranchOption,
  type BranchInventoryResponse,
  type BranchOption,
  type GitHubAccountRow,
  type ProjectRow,
  type Role,
} from './types';

interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectRow[];
  githubAccounts: GitHubAccountRow[];
  onCreated: (temporaryPassword: string) => Promise<void> | void;
}

const emptyDraft = {
  email: '', displayName: '', role: 'developer' as Role, password: '', projectId: '', branchName: '', githubAccountId: '',
};

export const CreateUserDialog: React.FC<CreateUserDialogProps> = ({
  open,
  onOpenChange,
  projects,
  githubAccounts,
  onCreated,
}) => {
  const [draft, setDraft] = React.useState(emptyDraft);
  const [branches, setBranches] = React.useState<BranchOption[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) setDraft(emptyDraft);
  }, [open]);

  React.useEffect(() => {
    if (!open || !draft.projectId) {
      setBranches([]);
      return;
    }
    void requestJson<BranchInventoryResponse>(
      `/api/admin/projects/${encodeURIComponent(draft.projectId)}/branches`,
    ).then((payload) => {
      const options = payload.branchOptions?.length
        ? payload.branchOptions
        : (payload.branches || []).map((name) => ({ name, local: true, remoteRefs: [], preferredRef: name }));
      setBranches(options);
      setDraft((current) => ({
        ...current,
        branchName: current.branchName || payload.defaultBranch || options[0]?.name || '',
      }));
    }).catch((error) => toast.error(error instanceof Error ? error.message : 'Failed to load branches'));
  }, [open, draft.projectId]);

  const create = async () => {
    setBusy(true);
    try {
      const payload = await requestJson<{ user: { temporaryPassword: string } }>('/api/admin/users', {
        method: 'POST', body: JSON.stringify(draft),
      });
      await onCreated(payload.user.temporaryPassword);
      onOpenChange(false);
      toast.success('User created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create user');
    } finally { setBusy(false); }
  };

  const missingAssignment = draft.role !== 'admin' && (!draft.projectId || !draft.branchName);
  const invalidPassword = draft.password.length > 0 && draft.password.length < 6;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create User</DialogTitle>
          <DialogDescription>
            Non-admin accounts remain suspended until a project and branch are assigned.
            Admin default-branch assignments use the repository root directly.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 typography-meta text-foreground">
            <span>Email</span>
            <Input placeholder="user@example.com" type="email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} />
          </label>
          <label className="space-y-1 typography-meta text-foreground">
            <span>Display Name</span>
            <Input placeholder="Display Name" value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} />
          </label>
          <label className="space-y-1 typography-meta text-foreground">
            <span>Role</span>
            <select aria-label="New User Role" className={selectClassName} value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value as Role }))}>
              <option value="developer">Developer</option>
              <option value="senior_developer">Senior Developer</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="space-y-1 typography-meta text-foreground">
            <span>Password (Optional)</span>
            <Input placeholder="At least 6 characters; auto-generated if empty" type="password" minLength={6} value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} />
          </label>
          <label className="space-y-1 typography-meta text-foreground">
            <span>Initial Project{draft.role === 'admin' ? ' (Optional)' : ''}</span>
            <select aria-label="Initial Project" className={selectClassName} value={draft.projectId} onChange={(event) => setDraft((current) => ({ ...current, projectId: event.target.value, branchName: '' }))}>
              <option value="">No Project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
            </select>
          </label>
          <label className="space-y-1 typography-meta text-foreground">
            <span>Initial Branch{draft.role === 'admin' ? ' (Optional)' : ''}</span>
            <select aria-label="Initial Branch" className={selectClassName} value={draft.branchName} onChange={(event) => setDraft((current) => ({ ...current, branchName: event.target.value }))} disabled={!draft.projectId}>
              <option value="">No Branch</option>
              {branches.map((branch) => <option key={branch.name} value={branch.name}>{formatBranchOption(branch)}</option>)}
            </select>
          </label>
          <label className="space-y-1 typography-meta text-foreground sm:col-span-2">
            <span>Profile GitHub Account</span>
            <select aria-label="Profile GitHub Account" className={selectClassName} value={draft.githubAccountId} onChange={(event) => setDraft((current) => ({ ...current, githubAccountId: event.target.value }))}>
              <option value="">No GitHub Account</option>
              {githubAccounts.map((account) => (
                <option key={account.id} value={account.id} disabled={Boolean(account.assignedUser)}>
                  {account.user?.login || account.id}{account.assignedUser ? ` — assigned to ${account.assignedUser.displayName}` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void create()} disabled={busy || !draft.email || !draft.displayName || missingAssignment || invalidPassword}>
            <RiAddLine className="h-4 w-4" /> Create User
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
