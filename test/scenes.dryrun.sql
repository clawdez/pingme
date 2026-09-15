-- Behavioural checks for 20260911_scenes_from_schools.sql. Runs as superuser
-- and switches role with a simulated JWT so auth.uid()/auth.role() and RLS
-- behave exactly like PostgREST calls. Any failed assertion raises → psql
-- exits non-zero (ON_ERROR_STOP). Runs AFTER the friends / pending-schools
-- dry-runs, so schools + profiles.school already hold real-looking data that
-- the migration must have copied. Standalone: re-creates the role helpers.
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

-- ── users: C1 creator, C2/C3/C4 joiners, C5 rate-limit + pending owner, C6 bystander ──
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000c1'), ('00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-0000000000c3'), ('00000000-0000-0000-0000-0000000000c4'),
  ('00000000-0000-0000-0000-0000000000c5'), ('00000000-0000-0000-0000-0000000000c6')
on conflict do nothing;
insert into profiles (id, name, color, school, home_city) values
  ('00000000-0000-0000-0000-0000000000c1', 'c1', '#000000', null, null),
  ('00000000-0000-0000-0000-0000000000c2', 'c2', '#000000', null, null),
  ('00000000-0000-0000-0000-0000000000c3', 'c3', '#000000', null, null),
  ('00000000-0000-0000-0000-0000000000c4', 'c4', '#000000', null, null),
  ('00000000-0000-0000-0000-0000000000c5', 'c5', '#000000', null, null),
  ('00000000-0000-0000-0000-0000000000c6', 'c6', '#000000', null, null)
on conflict (id) do nothing;

-- ── 0. migration: every school is a scene (same slug + pending), every profile.school is a membership ──
do $$
declare missing int; wrong int; members int; expected int; n int;
begin
  select count(*) into missing from schools sc where not exists (select 1 from scenes s where s.slug = sc.slug);
  if missing <> 0 then raise exception 'TESTFAIL 0a: % schools rows missing from scenes', missing; end if;
  select count(*) into wrong from schools sc join scenes s on s.slug = sc.slug
    where s.pending <> sc.pending or s.display_name <> sc.display_name or s.color <> sc.color
       or s.city is distinct from sc.default_city;
  if wrong <> 0 then raise exception 'TESTFAIL 0b: % scenes differ from their school row', wrong; end if;
  select count(*) into wrong from schools sc join scenes s on s.slug = sc.slug where not sc.pending and s.approved_at is null;
  if wrong <> 0 then raise exception 'TESTFAIL 0c: % approved schools copied without approved_at', wrong; end if;
  select count(*) into expected from profiles where school is not null;
  select count(*) into members from profiles p join scenes s on s.slug = p.school
    join scene_members m on m.scene_id = s.id and m.user_id = p.id where p.school is not null;
  if members <> expected then raise exception 'TESTFAIL 0d: % of % school memberships copied', members, expected; end if;
  select count(*) into wrong from scenes s where s.member_count <> (select count(*) from scene_members m where m.scene_id = s.id);
  if wrong <> 0 then raise exception 'TESTFAIL 0e: % scenes with a stale member_count after migration', wrong; end if;
  select count(*) into n from scene_suggestions;
  if n < (select count(*) from school_suggestions) then raise exception 'TESTFAIL 0f: suggestion history not carried over'; end if;
  if exists (select 1 from pg_constraint where conname = 'profiles_school_fkey') then
    raise exception 'TESTFAIL 0g: profiles.school FK to schools still present';
  end if;
  raise notice 'ok: 0 migration copied % schools and % memberships', (select count(*) from schools), members;
end $$;

-- ── 1. create: pending row, creator auto-joined, zip → city, mirror set, slug returned ──
do $$
declare s text; r scenes%rowtype; sch text; n int;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c1');
  s := create_scene('  Zilker   Park Pickleball ', 'Pickleball', 'Zilker Park, Austin TX', '78704');
  if s <> 'zilker-park-pickleball' then raise exception 'TESTFAIL 1a: slug %', s; end if;
  perform _t_reset();
  select * into r from scenes where slug = s;
  if r.pending is distinct from true then raise exception 'TESTFAIL 1b: new scene should be pending'; end if;
  if r.display_name <> 'Zilker Park Pickleball' then raise exception 'TESTFAIL 1c: display_name %', r.display_name; end if;
  if r.activity <> 'pickleball' then raise exception 'TESTFAIL 1d: activity %', r.activity; end if;
  if r.zip <> '78704' or r.city <> 'austin' or r.region <> 'tx' then raise exception 'TESTFAIL 1e: zip/city/region % % %', r.zip, r.city, r.region; end if;
  if r.created_by <> '00000000-0000-0000-0000-0000000000c1' then raise exception 'TESTFAIL 1f: created_by'; end if;
  if r.member_count <> 1 then raise exception 'TESTFAIL 1g: member_count % (creator auto-join)', r.member_count; end if;
  if not exists (select 1 from scene_members where scene_id = r.id and user_id = '00000000-0000-0000-0000-0000000000c1') then
    raise exception 'TESTFAIL 1h: creator not a member';
  end if;
  select school into sch from profiles where id = '00000000-0000-0000-0000-0000000000c1';
  if sch <> s then raise exception 'TESTFAIL 1i: profiles.school mirror % (expected %)', sch, s; end if;
  select count(*) into n from scene_suggestions where user_id = '00000000-0000-0000-0000-0000000000c1';
  if n <> 1 then raise exception 'TESTFAIL 1j: audit rows %', n; end if;
  raise notice 'ok: 1 create_scene → pending, creator joined, zip resolved, mirror set';
end $$;

-- ── 2. join: member_count increments; 3rd member auto-approves ──
do $$
declare r scenes%rowtype;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c2');
  perform join_scene('zilker-park-pickleball');
  perform join_scene('zilker-park-pickleball');   -- idempotent
  perform _t_reset();
  select * into r from scenes where slug = 'zilker-park-pickleball';
  if r.member_count <> 2 then raise exception 'TESTFAIL 2a: member_count % after 2nd join', r.member_count; end if;
  if not r.pending then raise exception 'TESTFAIL 2b: approved too early'; end if;
  perform _t_as('00000000-0000-0000-0000-0000000000c3');
  perform join_scene('zilker-park-pickleball');
  perform _t_reset();
  select * into r from scenes where slug = 'zilker-park-pickleball';
  if r.member_count <> 3 then raise exception 'TESTFAIL 2c: member_count %', r.member_count; end if;
  if r.pending then raise exception 'TESTFAIL 2d: 3rd member should auto-approve'; end if;
  if r.approved_at is null then raise exception 'TESTFAIL 2e: approved_at not set'; end if;
  raise notice 'ok: 2 join increments; 3rd join → pending=false, approved_at set';
end $$;

-- ── 3. leave: member_count decrements, approval sticks, mirror cleared ──
do $$
declare r scenes%rowtype; sch text;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c3');
  perform leave_scene('zilker-park-pickleball');
  perform _t_reset();
  select * into r from scenes where slug = 'zilker-park-pickleball';
  if r.member_count <> 2 then raise exception 'TESTFAIL 3a: member_count % after leave', r.member_count; end if;
  if r.pending then raise exception 'TESTFAIL 3b: leaving must not un-approve'; end if;
  select school into sch from profiles where id = '00000000-0000-0000-0000-0000000000c3';
  if sch is not null then raise exception 'TESTFAIL 3c: mirror still % after leaving last scene', sch; end if;
  raise notice 'ok: 3 leave decrements and clears the mirror';
end $$;

-- ── 4. ping from a scene: members minus sender minus muted; scene_id stamped; throttled ──
do $$
declare sent int; n int; sid uuid; ok boolean := false;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c4');
  perform join_scene('zilker-park-pickleball');
  perform set_scene_notifications('zilker-park-pickleball', false);
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-0000000000c1');
  sent := ping_scene('zilker-park-pickleball', 'c1 is at the courts', 'is playing');
  perform _t_reset();
  if sent <> 1 then raise exception 'TESTFAIL 4a: sent % (expected 1: c2 only — c1 sender, c3 left, c4 muted)', sent; end if;
  select id into sid from scenes where slug = 'zilker-park-pickleball';
  select count(*) into n from pings where from_id = '00000000-0000-0000-0000-0000000000c1' and scene_id = sid;
  if n <> 1 then raise exception 'TESTFAIL 4b: % pings rows stamped with scene_id', n; end if;
  if not exists (select 1 from pings where scene_id = sid and to_id = '00000000-0000-0000-0000-0000000000c2' and verb = 'is playing' and msg = 'c1 is at the courts') then
    raise exception 'TESTFAIL 4c: c2 did not get the scene ping';
  end if;
  if exists (select 1 from pings where scene_id = sid and to_id in ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c4')) then
    raise exception 'TESTFAIL 4d: sender / ex-member / muted member was pinged';
  end if;
  perform _t_as('00000000-0000-0000-0000-0000000000c1');
  sent := ping_scene('zilker-park-pickleball');
  perform _t_reset();
  if sent <> 0 then raise exception 'TESTFAIL 4e: second ping inside 10 minutes sent %', sent; end if;
  -- non-member cannot ping; bad verb rejected
  perform _t_as('00000000-0000-0000-0000-0000000000c3');
  begin
    perform ping_scene('zilker-park-pickleball');
  exception when others then ok := true;
  end;
  perform _t_reset();
  if not ok then raise exception 'TESTFAIL 4f: non-member pinged the scene'; end if;
  ok := false;
  perform _t_as('00000000-0000-0000-0000-0000000000c2');
  begin
    perform ping_scene('zilker-park-pickleball', null, 'system');
  exception when others then ok := true;
  end;
  perform _t_reset();
  if not ok then raise exception 'TESTFAIL 4g: system verb accepted'; end if;
  raise notice 'ok: 4 ping_scene → members minus sender minus muted, scene_id stamped, throttled';
end $$;

-- ── 5. validation: reserved / short / long / junk names; long names truncate to a valid slug ──
do $$
declare bad text; ok boolean; s text;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c6');
  foreach bad in array array['other', 'None', ' ADMIN ', 'test', 'scenes', 'x', '!!!', '---', repeat('a', 81), '', null] loop
    ok := false;
    begin
      perform create_scene(bad);
    exception when others then ok := true;
    end;
    if not ok then raise exception 'TESTFAIL 5a: % was accepted', coalesce(bad, '<null>'); end if;
  end loop;
  s := create_scene('University of Texas at San Antonio Rec Center Courts');
  perform _t_reset();
  if s !~ '^[a-z0-9-]{2,32}$' then raise exception 'TESTFAIL 5b: slug % violates check', s; end if;
  if char_length(s) > 32 or s like '%-' then raise exception 'TESTFAIL 5c: slug % not truncated/trimmed', s; end if;
  if exists (select 1 from scenes where slug in ('other', 'none', 'admin', 'test', 'scenes', 'x')) then
    raise exception 'TESTFAIL 5d: reserved slug inserted';
  end if;
  raise notice 'ok: 5 reserved/malformed rejected; long name → %', s;
end $$;

-- ── 6. rate limit: 3 creates per user per 24h; joining an existing slug via create still counts ──
do $$
declare i int; ok boolean := false; msg text;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c5');
  for i in 1..3 loop
    perform create_scene('Rate Limit Scene ' || i);
  end loop;
  begin
    perform create_scene('Rate Limit Scene 4');
  exception when others then ok := true; msg := sqlerrm;
  end;
  perform _t_reset();
  if not ok then raise exception 'TESTFAIL 6a: 4th create accepted'; end if;
  if msg not ilike '%rate limit%' then raise exception 'TESTFAIL 6b: wrong error %', msg; end if;
  if exists (select 1 from scenes where slug = 'rate-limit-scene-4') then raise exception 'TESTFAIL 6c: 4th row inserted'; end if;
  raise notice 'ok: 6 rate limit (3/24h): %', msg;
end $$;

-- ── 7. RLS: pending scene invisible to non-member/non-creator and anon; visible to creator; visible after joining ──
do $$
declare n int;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c6');
  select count(*) into n from scenes where slug = 'rate-limit-scene-1';
  if n <> 0 then raise exception 'TESTFAIL 7a: bystander sees a pending scene'; end if;
  select count(*) into n from list_scenes() where slug = 'rate-limit-scene-1';
  if n <> 0 then raise exception 'TESTFAIL 7b: list_scenes leaks a pending scene'; end if;
  perform _t_reset();
  perform _t_anon();
  select count(*) into n from scenes where slug = 'rate-limit-scene-1';
  if n <> 0 then raise exception 'TESTFAIL 7c: anon sees a pending scene'; end if;
  select count(*) into n from scenes where slug = 'zilker-park-pickleball';
  if n <> 1 then raise exception 'TESTFAIL 7d: anon cannot see an approved scene'; end if;
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-0000000000c5');
  select count(*) into n from scenes where slug = 'rate-limit-scene-1';
  if n <> 1 then raise exception 'TESTFAIL 7e: creator cannot see own pending scene'; end if;
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-0000000000c6');
  perform join_scene('rate-limit-scene-1');   -- share-link join of a pending scene
  select count(*) into n from scenes where slug = 'rate-limit-scene-1';
  if n <> 1 then raise exception 'TESTFAIL 7f: member cannot see the pending scene'; end if;
  perform _t_reset();
  raise notice 'ok: 7 pending scenes hidden from everyone but creator + members';
end $$;

-- ── 8. scene_members RLS: own rows + members of my scenes; nothing else; anon nothing ──
do $$
declare n int; ok boolean := false;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c2');
  select count(*) into n from scene_members m join scenes s on s.id = m.scene_id where s.slug = 'zilker-park-pickleball';
  if n <> 3 then raise exception 'TESTFAIL 8a: member sees % zilker rows (expected 3: c1, c2, c4)', n; end if;
  select count(*) into n from scene_members m join scenes s on s.id = m.scene_id where s.slug = 'rate-limit-scene-1';
  if n <> 0 then raise exception 'TESTFAIL 8b: sees members of a scene they are not in'; end if;
  perform _t_reset();
  perform _t_anon();
  begin
    select count(*) into n from scene_members;
    if n <> 0 then raise exception 'TESTFAIL 8c: anon read % membership rows', n; end if;
  exception when insufficient_privilege then ok := true;
  end;
  perform _t_reset();
  raise notice 'ok: 8 scene_members scoped to my scenes';
end $$;

-- ── 9. list_scenes: joined/mute flags, 24h ping count, zip proximity ordering ──
do $$
declare r record; first_slug text;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c4');
  select * into r from list_scenes() where slug = 'zilker-park-pickleball';
  if r.joined is distinct from true then raise exception 'TESTFAIL 9a: joined flag'; end if;
  if r.notifications_enabled is distinct from false then raise exception 'TESTFAIL 9b: mute flag'; end if;
  if r.pings_24h <> 1 then raise exception 'TESTFAIL 9c: pings_24h %', r.pings_24h; end if;
  if r.last_ping_at is null then raise exception 'TESTFAIL 9d: last_ping_at'; end if;
  if r.member_count <> 3 then raise exception 'TESTFAIL 9e: member_count %', r.member_count; end if;
  select slug into first_slug from list_scenes('78701') limit 1;
  if first_slug <> 'zilker-park-pickleball' then raise exception 'TESTFAIL 9f: zip 78701 should rank the 787 scene first, got %', first_slug; end if;
  select * into r from list_scenes('78701') where slug = 'zilker-park-pickleball';
  if r.near_rank <> 1 then raise exception 'TESTFAIL 9g: near_rank % (expected 1 = same zip3)', r.near_rank; end if;
  select * into r from list_scenes('78704') where slug = 'zilker-park-pickleball';
  if r.near_rank <> 0 then raise exception 'TESTFAIL 9h: near_rank % (expected 0 = same zip)', r.near_rank; end if;
  select count(*) into r from list_scenes(null, 'zilker');
  if r.count <> 1 then raise exception 'TESTFAIL 9i: name search'; end if;
  perform _t_reset();
  raise notice 'ok: 9 list_scenes flags, trending count and zip ranking';
end $$;

-- ── 10. anon cannot create/join/ping ──
do $$
declare ok boolean := false;
begin
  perform _t_anon();
  begin perform create_scene('Anon Scene'); exception when others then ok := true; end;
  if not ok then raise exception 'TESTFAIL 10a: anon created a scene'; end if;
  ok := false;
  begin perform join_scene('zilker-park-pickleball'); exception when others then ok := true; end;
  if not ok then raise exception 'TESTFAIL 10b: anon joined a scene'; end if;
  perform _t_reset();
  if exists (select 1 from scenes where slug = 'anon-scene') then raise exception 'TESTFAIL 10c: anon row inserted'; end if;
  raise notice 'ok: 10 anon rejected';
end $$;

-- ── 11. approve_scene: authenticated cannot; service_role can; postgres session can; unknown raises ──
do $$
declare ok boolean := false; r scenes%rowtype;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c5');
  begin perform approve_scene('rate-limit-scene-2'); exception when others then ok := true; end;
  perform _t_reset();
  if not ok then raise exception 'TESTFAIL 11a: authenticated approved a scene'; end if;
  perform _t_service();
  perform approve_scene('rate-limit-scene-2');
  perform _t_reset();
  select * into r from scenes where slug = 'rate-limit-scene-2';
  if r.pending or r.approved_at is null then raise exception 'TESTFAIL 11b: service_role approve did not stick'; end if;
  perform approve_scene('rate-limit-scene-3');   -- plain postgres session (SQL editor)
  select * into r from scenes where slug = 'rate-limit-scene-3';
  if r.pending then raise exception 'TESTFAIL 11c: postgres session could not approve'; end if;
  ok := false;
  begin perform approve_scene('no-such-scene'); exception when others then ok := true; end;
  if not ok then raise exception 'TESTFAIL 11d: unknown slug did not raise'; end if;
  raise notice 'ok: 11 approve_scene admin-only';
end $$;

-- ── 12. aliases: suggest_school / set_school / approve_school keep an old client working ──
do $$
declare s text; sch text; n int; p boolean;
begin
  perform _t_as('00000000-0000-0000-0000-0000000000c3');
  s := suggest_school('Alias Park Courts');
  if s <> 'alias-park-courts' then raise exception 'TESTFAIL 12a: %', s; end if;
  perform _t_reset();
  if not exists (select 1 from scenes where slug = 'alias-park-courts' and pending) then raise exception 'TESTFAIL 12b: alias did not insert into scenes'; end if;
  if exists (select 1 from schools where slug = 'alias-park-courts') then raise exception 'TESTFAIL 12c: alias wrote to schools'; end if;
  select school into sch from profiles where id = '00000000-0000-0000-0000-0000000000c3';
  if sch <> 'alias-park-courts' then raise exception 'TESTFAIL 12d: mirror %', sch; end if;
  perform _t_as('00000000-0000-0000-0000-0000000000c3');
  perform set_school('zilker-park-pickleball');
  perform _t_reset();
  select count(*) into n from scene_members m join scenes sc on sc.id = m.scene_id where m.user_id = '00000000-0000-0000-0000-0000000000c3' and sc.slug = 'zilker-park-pickleball';
  if n <> 1 then raise exception 'TESTFAIL 12e: set_school did not join'; end if;
  select school into sch from profiles where id = '00000000-0000-0000-0000-0000000000c3';
  if sch <> 'zilker-park-pickleball' then raise exception 'TESTFAIL 12f: mirror follows latest join, got %', sch; end if;
  perform _t_as('00000000-0000-0000-0000-0000000000c3');
  perform set_school(null);
  perform _t_reset();
  select count(*) into n from scene_members m join scenes sc on sc.id = m.scene_id where m.user_id = '00000000-0000-0000-0000-0000000000c3' and sc.slug = 'zilker-park-pickleball';
  if n <> 0 then raise exception 'TESTFAIL 12g: set_school(null) did not leave the mirrored scene'; end if;
  select school into sch from profiles where id = '00000000-0000-0000-0000-0000000000c3';
  if sch <> 'alias-park-courts' then raise exception 'TESTFAIL 12h: mirror should fall back to the remaining scene, got %', sch; end if;
  perform _t_service();
  perform approve_school('alias-park-courts');
  perform _t_reset();
  select pending into p from scenes where slug = 'alias-park-courts';
  if p then raise exception 'TESTFAIL 12i: approve_school alias did not approve the scene'; end if;
  raise notice 'ok: 12 legacy RPC names route into scenes';
end $$;

-- ── 13. legacy reads still work: schools table untouched, old policy intact ──
do $$
declare n int;
begin
  select count(*) into n from schools where slug in ('ttu', 'ut-austin', 'texas-am', 'uh', 'baylor');
  if n <> 5 then raise exception 'TESTFAIL 13a: seeded schools gone (%)', n; end if;
  perform _t_anon();
  select count(*) into n from schools where not pending;
  if n < 5 then raise exception 'TESTFAIL 13b: anon lost read access to schools'; end if;
  perform _t_reset();
  raise notice 'ok: 13 schools table kept for one release';
end $$;

select 'SCENES DRY-RUN PASSED' as result;
