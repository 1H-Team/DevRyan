-- Administrators operate directly in the registered repository for every
-- granted branch. This repairs non-default grants created by earlier hosts.
update public.user_project_branches b
set workspace_path = p.repository_path
from public.managed_projects p, public.user_profiles u
where b.project_id = p.id
  and b.user_id = u.id
  and u.role = 'admin'
  and b.workspace_path is distinct from p.repository_path;
