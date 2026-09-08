-- Behavioural checks for 20260909_pending_schools.sql. Runs as superuser and
-- switches role with a simulated JWT so auth.uid()/auth.role() and RLS behave
-- exactly like PostgREST calls. Any failed assertion raises → psql exits
-- non-zero (ON_ERROR_STOP). Standalone: re-creates the role helpers.
\set ON_ERROR_STOP on

create or replace function _t_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';
end $$;
create or replace function _t_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  execute 'set local role anon';
end $$;
create or replace function _t_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  execute 'set local role service_role';
end $$;
create or replace function _t_reset() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
end $$;
grant execute on function _t_as(uuid), _t_anon(), _t_service(), _t_reset() to public;

-- ── users: E1 (submitter), E2 (same school, different spelling), E3 (rate limit), E4 (bystander) ──
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000e1'), ('00000000-0000-0000-0000-0000000000e2'),
  ('00000000-0000-0000-0000-0000000000e3'), ('00000000-0000-0000-0000-0000000000e4')
on conflict do nothing;
insert into profiles (id, name, color, school, home_city) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1', '#000000', null, null),
  ('00000000-0000-0000-0000-0000000000e2', 'e2', '#000000', null, null),
  ('00000000-0000-0000-0000-0000000000e3', 'e3', '#000000', null, null),
  ('00000000-0000-0000-0000-0000000000e4', 'e4', '#000000', 'ttu', null)
on conflict (id) do nothing;

-- ── 0. existing rows are approved ──
do $$
declare n int;
begin
  select count(*) into n from schools where pending;
  if n <> 0 then raise exception 'TESTFAIL 0: seeded schools must not be pending (got % pending)', n; end if;
  raise notice 'ok: 0 seeded schools all approved';
end $$;

-- ── 1. suggest: creates a pending row, assigns caller, returns slug ──
do $$
declare s text; p boolean; sch text; n int;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000e1');
  s := suggest_school('  Rice   University Test ');
  if s <> 'rice-university-test' then raise exception 'TESTFAIL 1a: slug %', s; end if;
  perform _t_reset();
  select pending into p from schools where slug = 'rice-university-test';
  if p is distinct from true then raise exception 'TESTFAIL 1b: new school should be pending'; end if;
  select display_name into sch from schools where slug = 'rice-university-test';
  if sch <> 'Rice University Test' then raise exception 'TESTFAIL 1c: display_name keeps casing, collapses whitespace: %', sch; end if;
  select school into sch from profiles where id = '00000000-0000-0000-0000-0000000000e1';
  if sch <> 'rice-university-test' then raise exception 'TESTFAIL 1d: caller not assigned (%)', sch; end if;
  select count(*) into n from school_suggestions where user_id = '00000000-0000-0000-0000-0000000000e1';
  if n <> 1 then raise exception 'TESTFAIL 1e: audit row count %', n; end if;
  raise notice 'ok: 1 suggest creates pending row + assigns caller';
end $$;

-- ── 2. same school, different spelling → same slug, no duplicate row ──
do $$
declare s text; n int; sch text;
begin
  select count(*) into n from schools;
  perform _t_as('00000000-0000-0000-0000-0000000000e2');
  s := suggest_school('RICE UNIVERSITY TEST');
  if s <> 'rice-university-test' then raise exception 'TESTFAIL 2a: slug %', s; end if;
  perform _t_reset();
  if (select count(*) from schools) <> n then raise exception 'TESTFAIL 2b: duplicate school row created'; end if;
  select school into sch from profiles where id = '00000000-0000-0000-0000-0000000000e2';
  if sch <> 'rice-university-test' then raise exception 'TESTFAIL 2c: second user not grouped'; end if;
  raise notice 'ok: 2 second user grouped under the same pending slug';
end $$;

-- ── 3. RLS: approved rows for all; own pending row only for its members ──
do $$
declare n int; approved int;
begin
  select count(*) into approved from schools where not pending;
  perform _t_as('00000000-0000-0000-0000-0000000000e1');
  select count(*) into n from schools;
  if n <> approved + 1 then raise exception 'TESTFAIL 3a: submitter sees % rows, expected %', n, approved + 1; end if;
  if not exists (select 1 from schools where slug = 'rice-university-test') then raise exception 'TESTFAIL 3b: submitter cannot see own pending school'; end if;
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-0000000000e4');
  select count(*) into n from schools;
  if n <> approved then raise exception 'TESTFAIL 3c: bystander sees % rows, expected %', n, approved; end if;
  perform _t_reset();
  perform _t_anon();
  select count(*) into n from schools;
  if n <> approved then raise exception 'TESTFAIL 3d: anon sees % rows, expected %', n, approved; end if;
  perform _t_reset();
  raise notice 'ok: 3 RLS hides pending rows from everyone but their members';
end $$;

-- ── 4. validation: reserved, too short/long, no alphanumerics ──
do $$
declare bad text; ok boolean;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000e4');
  foreach bad in array array['other', 'None', ' ADMIN ', 'test', 'x', '!!!', '---', repeat('a', 81), '', null] loop
    ok := false;
    begin
      perform suggest_school(bad);
    exception when others then
      ok := true;
    end;
    if not ok then raise exception 'TESTFAIL 4: % was accepted', coalesce(bad, '<null>'); end if;
  end loop;
  perform _t_reset();
  if exists (select 1 from schools where slug in ('other', 'none', 'admin', 'test', 'x')) then
    raise exception 'TESTFAIL 4b: reserved/invalid slug was inserted';
  end if;
  raise notice 'ok: 4 reserved and malformed names rejected';
end $$;

-- ── 5. long real-world names still produce a valid slug ──
do $$
declare s text;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000e4');
  s := suggest_school('University of Texas at San Antonio');
  perform _t_reset();
  if s !~ '^[a-z0-9-]{2,32}$' then raise exception 'TESTFAIL 5a: slug % violates schools.slug check', s; end if;
  if s not like 'university-of-texas-at-san-%' then raise exception 'TESTFAIL 5b: unexpected slug %', s; end if;
  if s like '%-' then raise exception 'TESTFAIL 5c: trailing dash in %', s; end if;
  raise notice 'ok: 5 long name → % (fits slug check)', s;
end $$;

-- ── 6. typing an already-approved slug just joins it ──
do $$
declare s text; p boolean; sch text;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000e4');
  s := suggest_school('TTU');
  perform _t_reset();
  if s <> 'ttu' then raise exception 'TESTFAIL 6a: %', s; end if;
  select pending into p from schools where slug = 'ttu';
  if p then raise exception 'TESTFAIL 6b: approved school flipped to pending'; end if;
  select school into sch from profiles where id = '00000000-0000-0000-0000-0000000000e4';
  if sch <> 'ttu' then raise exception 'TESTFAIL 6c: not assigned'; end if;
  raise notice 'ok: 6 existing approved slug is joined, not re-created';
end $$;

-- ── 7. rate limit: 3 per 24h, 4th raises ──
do $$
declare i int; ok boolean; msg text;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000e3');
  for i in 1..3 loop
    perform suggest_school('Rate Limit School ' || i);
  end loop;
  ok := false;
  begin
    perform suggest_school('Rate Limit School 4');
  exception when others then
    ok := true; msg := sqlerrm;
  end;
  perform _t_reset();
  if not ok then raise exception 'TESTFAIL 7a: 4th suggestion was accepted'; end if;
  if msg not ilike '%rate limit%' then raise exception 'TESTFAIL 7b: wrong error: %', msg; end if;
  if exists (select 1 from schools where slug = 'rate-limit-school-4') then raise exception 'TESTFAIL 7c: 4th row inserted'; end if;
  raise notice 'ok: 7 rate limit (3/24h) enforced: %', msg;
end $$;

-- ── 8. anon cannot suggest ──
do $$
declare ok boolean := false;
begin
  perform _t_anon();
  begin
    perform suggest_school('Anon School');
  exception when others then ok := true;
  end;
  perform _t_reset();
  if not ok then raise exception 'TESTFAIL 8: anon suggested a school'; end if;
  if exists (select 1 from schools where slug = 'anon-school') then raise exception 'TESTFAIL 8b: anon row inserted'; end if;
  raise notice 'ok: 8 anon rejected';
end $$;

-- ── 9. approve: authenticated cannot; service_role can; unknown slug raises; anon then sees it ──
do $$
declare ok boolean := false; p boolean; n int; approved int;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000e1');
  begin
    perform approve_school('rice-university-test');
  exception when others then ok := true;
  end;
  perform _t_reset();
  if not ok then raise exception 'TESTFAIL 9a: authenticated user approved a school'; end if;
  if (select pending from schools where slug = 'rice-university-test') is distinct from true then
    raise exception 'TESTFAIL 9b: flipped without authority';
  end if;

  perform _t_service();
  perform approve_school('rice-university-test');
  perform _t_reset();
  select pending into p from schools where slug = 'rice-university-test';
  if p then raise exception 'TESTFAIL 9c: still pending after service_role approve'; end if;

  ok := false;
  perform _t_service();
  begin
    perform approve_school('no-such-school-xyz');
  exception when others then ok := true;
  end;
  perform _t_reset();
  if not ok then raise exception 'TESTFAIL 9d: approving an unknown slug did not raise'; end if;

  select count(*) into approved from schools where not pending;
  perform _t_anon();
  select count(*) into n from schools;
  if n <> approved then raise exception 'TESTFAIL 9e: anon sees % rows, expected %', n, approved; end if;
  if not exists (select 1 from schools where slug = 'rice-university-test') then raise exception 'TESTFAIL 9f: anon cannot see approved school'; end if;
  perform _t_reset();
  raise notice 'ok: 9 approve_school is admin-only and publishes the row';
end $$;

-- ── 10. approve from the SQL editor (postgres session, no JWT) — Ez's path ──
do $$
declare p boolean;
begin
  perform _t_reset();
  perform approve_school('university-of-texas-at-san-anton');
  select pending into p from schools where slug = 'university-of-texas-at-san-anton';
  if p then raise exception 'TESTFAIL 10: postgres session could not approve'; end if;
  raise notice 'ok: 10 approve works from a plain postgres session (SQL editor)';
end $$;

-- ── 11. authenticated cannot read the audit table; service_role can ──
do $$
declare n int; ok boolean := false;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000e3');
  begin
    select count(*) into n from school_suggestions;
    if n <> 0 then raise exception 'TESTFAIL 11a: authenticated read % audit rows', n; end if;
  exception when insufficient_privilege then ok := true;
  end;
  perform _t_reset();
  perform _t_service();
  select count(*) into n from school_suggestions;
  perform _t_reset();
  if n < 5 then raise exception 'TESTFAIL 11b: service_role sees % audit rows', n; end if;
  raise notice 'ok: 11 audit table hidden from clients (service_role sees % rows)', n;
end $$;

select 'PENDING-SCHOOLS DRY-RUN PASSED' as result;
