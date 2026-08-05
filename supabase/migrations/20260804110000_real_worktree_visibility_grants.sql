-- Branch grants are visibility rows only. Every role operates in the real
-- repository checkout and its shared OpenCode-managed git worktrees.
update public.user_project_branches branch_grant
set workspace_path = project.repository_path
from public.managed_projects project
where project.id = branch_grant.project_id
  and branch_grant.workspace_path is distinct from project.repository_path;
