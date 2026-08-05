-- Admin default-branch assignments live at the real repository root, not a
-- managed worktree. Repairs rows created before assignProject learned to do
-- this (idempotent; no-op for rows already pointing at the repo root).
update public.user_project_branches b
set workspace_path = p.repository_path
from public.managed_projects p, public.user_profiles u
where b.project_id = p.id
  and b.user_id = u.id
  and u.role = 'admin'
  and b.branch_name = p.default_branch
  and b.workspace_path is distinct from p.repository_path;
