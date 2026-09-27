-- Local Bot database cluster roles. Applied once per cluster by the host
-- lifecycle as the socket-authenticated database superuser.
--
-- anon/authenticated exist only because the replayed migrations revoke
-- privileges from them. Neither can log in and PostgREST has no anonymous
-- role, so an unauthenticated request never reaches the database.
do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  -- PostgREST connects as authenticator over the private socket (peer
  -- authentication maps only the REST container's OS user to it) and can
  -- assume nothing except service_role.
  if not exists (select from pg_catalog.pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end;
$$;

grant service_role to authenticator;
revoke all on database postgres from public;
revoke all on database template1 from public;
