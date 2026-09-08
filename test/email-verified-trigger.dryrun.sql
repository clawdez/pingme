-- Behavioural checks for 20260910_profiles_email_verified_from_auth.sql.
-- Inserts profiles as the `authenticated` role with a simulated JWT (exactly
-- what PostgREST does) and asserts the trigger derives email_verified from
-- auth.users.email_confirmed_at. Any failure raises → psql exits non-zero.
\set ON_ERROR_STOP on

create or replace function _t_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';
end $$;
create or replace function _t_reset() returns void language plpgsql as $$
begin execute 'reset role'; end $$;
grant execute on function _t_as(uuid), _t_reset() to public;

-- Note: the throwaway image ships a minimal auth.users without
-- email_confirmed_at (GoTrue adds it on a real project — verified live on
-- yuqahobbcwibekzvitec); test/sql-dryrun.sh adds it as supabase_admin first.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000f1', 'ev-confirmed@test.local', now()),
  ('00000000-0000-0000-0000-0000000000f2', 'ev-unconfirmed@test.local', null),
  ('00000000-0000-0000-0000-0000000000f3', null, null)
on conflict do nothing;

do $$
declare v boolean;
begin
  -- 1. confirmed auth user → profile born verified (client sends no flag)
  perform _t_as('00000000-0000-0000-0000-0000000000f1');
  insert into profiles (id, name, color) values ('00000000-0000-0000-0000-0000000000f1', 'ev1', '#000000');
  perform _t_reset();
  select email_verified into v from profiles where id = '00000000-0000-0000-0000-0000000000f1';
  if not v then raise exception 'FAIL 1: confirmed user profile not verified'; end if;
  raise notice 'PASSED 1: confirmed auth user -> profile born email_verified';

  -- 2. unconfirmed user cannot self-flag on insert
  perform _t_as('00000000-0000-0000-0000-0000000000f2');
  insert into profiles (id, name, color, email_verified) values ('00000000-0000-0000-0000-0000000000f2', 'ev2', '#000000', true);
  perform _t_reset();
  select email_verified into v from profiles where id = '00000000-0000-0000-0000-0000000000f2';
  if v then raise exception 'FAIL 2: unconfirmed user self-flagged email_verified'; end if;
  raise notice 'PASSED 2: unconfirmed user cannot self-flag on insert';

  -- 3. anonymous-style user (no email) → not verified
  perform _t_as('00000000-0000-0000-0000-0000000000f3');
  insert into profiles (id, name, color) values ('00000000-0000-0000-0000-0000000000f3', 'ev3', '#000000');
  perform _t_reset();
  select email_verified into v from profiles where id = '00000000-0000-0000-0000-0000000000f3';
  if v then raise exception 'FAIL 3: anonymous profile verified'; end if;
  raise notice 'PASSED 3: anonymous user profile not verified';

  -- 4. explicit update (link-email / sign-in path, service role) still works
  update profiles set email_verified = true where id = '00000000-0000-0000-0000-0000000000f2';
  select email_verified into v from profiles where id = '00000000-0000-0000-0000-0000000000f2';
  if not v then raise exception 'FAIL 4: explicit update blocked'; end if;
  raise notice 'PASSED 4: explicit update after verification still sets the flag';

  raise notice 'EMAIL-VERIFIED-TRIGGER DRY-RUN PASSED';
end $$;

delete from profiles where id in ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000f3');
delete from auth.users where id in ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000f3');
