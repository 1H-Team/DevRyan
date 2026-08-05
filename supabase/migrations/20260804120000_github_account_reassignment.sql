-- Move one connected GitHub credential between DevRyan profiles atomically.
-- Authorization remains in the server route; only the server's service role
-- may execute this function through PostgREST.

create or replace function public.devryan_reassign_github_account(
  p_account_id text,
  p_target_user_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_account_id text := nullif(trim(p_account_id), '');
  previous_profile public.user_profiles%rowtype;
  target_profile public.user_profiles%rowtype;
begin
  if normalized_account_id is null then
    raise exception 'GitHub account id is required'
      using errcode = '22023', detail = 'GITHUB_ACCOUNT_ID_REQUIRED';
  end if;

  -- Lock both rows in UUID order so concurrent account moves cannot create a
  -- partial transfer or deadlock while the unique profile association is held.
  perform profile.id
  from public.user_profiles profile
  where profile.github_account_id = normalized_account_id
     or profile.id = p_target_user_id
  order by profile.id
  for update;

  select profile.*
  into previous_profile
  from public.user_profiles profile
  where profile.github_account_id = normalized_account_id
  limit 1;

  if p_target_user_id is not null then
    select profile.*
    into target_profile
    from public.user_profiles profile
    where profile.id = p_target_user_id;

    if not found then
      raise exception 'GitHub assignment target was not found'
        using errcode = 'P0002', detail = 'GITHUB_ASSIGNMENT_TARGET_NOT_FOUND';
    end if;

    if target_profile.github_account_id is not null
       and target_profile.github_account_id <> normalized_account_id then
      raise exception 'GitHub assignment target already has another account'
        using errcode = 'P0001', detail = 'GITHUB_ASSIGNMENT_TARGET_CONFLICT';
    end if;
  end if;

  if previous_profile.id is not null
     and previous_profile.id is distinct from p_target_user_id then
    update public.user_profiles
    set github_account_id = null
    where id = previous_profile.id;
  end if;

  if p_target_user_id is not null
     and previous_profile.id is distinct from p_target_user_id then
    update public.user_profiles
    set github_account_id = normalized_account_id
    where id = p_target_user_id
    returning * into target_profile;
  elsif p_target_user_id is not null then
    target_profile := previous_profile;
  end if;

  return jsonb_build_object(
    'accountId', normalized_account_id,
    'previousAssignedUser', case
      when previous_profile.id is null then null
      else jsonb_build_object(
        'id', previous_profile.id,
        'email', previous_profile.email,
        'displayName', previous_profile.display_name
      )
    end,
    'assignedUser', case
      when p_target_user_id is null then null
      else jsonb_build_object(
        'id', target_profile.id,
        'email', target_profile.email,
        'displayName', target_profile.display_name
      )
    end
  );
end;
$$;

revoke all on function public.devryan_reassign_github_account(text, uuid)
  from public, anon, authenticated;
grant execute on function public.devryan_reassign_github_account(text, uuid)
  to service_role;

comment on function public.devryan_reassign_github_account(text, uuid) is
  'Atomically reassigns one host GitHub credential; callable only by DevRyan server credentials.';
