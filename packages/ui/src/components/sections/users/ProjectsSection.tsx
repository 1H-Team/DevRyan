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
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { requestJson, type ProjectRow } from './types';

interface ProjectsSectionProps {
  projects: ProjectRow[];
  onChanged: () => Promise<void> | void;
}

const emptyProject = { label: '', repositoryPath: '', remoteUrl: '', defaultBranch: '' };

export const ProjectsSection: React.FC<ProjectsSectionProps> = ({ projects, onChanged }) => {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(emptyProject);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!dialogOpen) setDraft(emptyProject);
  }, [dialogOpen]);

  const create = async () => {
    setBusy(true);
    try {
      await requestJson('/api/admin/projects', { method: 'POST', body: JSON.stringify(draft) });
      await onChanged();
      setDialogOpen(false);
      toast.success('Managed project registered');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create project');
    } finally { setBusy(false); }
  };

  return (
    <SettingsSection
      title="Managed Projects"
      description="Repository paths stay server-side; developers receive only opaque project aliases."
      divider
    >
      <div className="space-y-3">
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
          <RiAddLine className="h-4 w-4" /> Register Project
        </Button>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Default Branch</TableHead>
              <TableHead>Repository Path</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">No managed projects registered.</TableCell>
              </TableRow>
            )}
            {projects.map((project) => (
              <TableRow key={project.id}>
                <TableCell className="font-medium">{project.label}</TableCell>
                <TableCell>{project.default_branch}</TableCell>
                <TableCell className="typography-meta text-muted-foreground break-all">{project.repository_path}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Register Managed Project</DialogTitle>
            <DialogDescription>Register a repository by its absolute path on the host.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="space-y-1 typography-meta text-foreground">
              <span>Project Label</span>
              <Input placeholder="My Project" value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} />
            </label>
            <label className="space-y-1 typography-meta text-foreground">
              <span>Absolute Repository Path</span>
              <Input placeholder="/path/to/repository" value={draft.repositoryPath} onChange={(event) => setDraft((current) => ({ ...current, repositoryPath: event.target.value }))} />
            </label>
            <label className="space-y-1 typography-meta text-foreground">
              <span>Remote URL</span>
              <Input placeholder="https://github.com/org/repo.git" value={draft.remoteUrl} onChange={(event) => setDraft((current) => ({ ...current, remoteUrl: event.target.value }))} />
            </label>
            <label className="space-y-1 typography-meta text-foreground">
              <span>Default Branch</span>
              <Input placeholder="main" value={draft.defaultBranch} onChange={(event) => setDraft((current) => ({ ...current, defaultBranch: event.target.value }))} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void create()} disabled={busy || !draft.repositoryPath || !draft.defaultBranch}>
              <RiAddLine className="h-4 w-4" /> Register Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};
