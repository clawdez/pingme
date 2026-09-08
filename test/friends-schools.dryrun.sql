-- Behavioural checks for 20260907_friends_and_schools.sql. Runs as superuser
-- and switches to `authenticated` with a simulated JWT so auth.uid() and RLS
-- behave exactly like PostgREST calls. Any failed assertion raises → psql
-- exits non-zero (ON_ERROR_STOP).
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
  execute 'set local role anon';
end $$;
create or replace function _t_reset() returns void language plpgsql as $$
begin execute 'reset role'; end $$;
grant execute on function _t_as(uuid), _t_anon(), _t_reset() to public;

-- ── seed users: A (ez), B (bob, ttu), C (bobby, no school), D1..D7 (batch) ──
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-00000000000c'),
  ('00000000-0000-0000-0000-0000000000d1'), ('00000000-0000-0000-0000-0000000000d2'),
  ('00000000-0000-0000-0000-0000000000d3'), ('00000000-0000-0000-0000-0000000000d4'),
  ('00000000-0000-0000-0000-0000000000d5'), ('00000000-0000-0000-0000-0000000000d6'),
  ('00000000-0000-0000-0000-0000000000d7')
on conflict do nothing;

insert into profiles (id, name, color, school, home_city) values
  ('00000000-0000-0000-0000-00000000000a', 'ez',    '#E8502A', null,  null),
  ('00000000-0000-0000-0000-00000000000b', 'bob',   '#2544D6', 'ttu', 'austin'),
  ('00000000-0000-0000-0000-00000000000c', 'bobby', '#000000', null,  null),
  ('00000000-0000-0000-0000-0000000000d1', 'd1', '#000000', 'ttu', null),
  ('00000000-0000-0000-0000-0000000000d2', 'd2', '#000000', 'ttu', null),
  ('00000000-0000-0000-0000-0000000000d3', 'd3', '#000000', 'ttu', null),
  ('00000000-0000-0000-0000-0000000000d4', 'd4', '#000000', 'ttu', null),
  ('00000000-0000-0000-0000-0000000000d5', 'd5', '#000000', 'ttu', null),
  ('00000000-0000-0000-0000-0000000000d6', 'd6', '#000000', 'ttu', null),
  ('00000000-0000-0000-0000-0000000000d7', 'd7', '#000000', 'ttu', null)
on conflict (id) do nothing;

-- ── 1. request: A → B ──
do $$
declare r text; n int; inc boolean;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  r := send_friend_request('00000000-0000-0000-0000-00000000000b');
  if r <> 'pending' then raise exception 'TESTFAIL 1a: expected pending, got %', r; end if;
  r := send_friend_request('00000000-0000-0000-0000-00000000000b');
  if r <> 'pending' then raise exception 'TESTFAIL 1b: duplicate request should be idempotent, got %', r; end if;
  select count(*) into n from list_friendships() where status = 'pending' and incoming = false;
  if n <> 1 then raise exception 'TESTFAIL 1c: A should see 1 outgoing pending, got %', n; end if;
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-00000000000b');
  select incoming into inc from list_friendships() where other_id = '00000000-0000-0000-0000-00000000000a';
  if inc is distinct from true then raise exception 'TESTFAIL 1d: B should see the request as incoming'; end if;
  perform _t_reset();
  raise notice 'ok: 1 friend request A→B pending, visible to both';
end $$;

-- ── 2. requester cannot accept own request; outsiders see nothing ──
do $$
declare n int;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  update friendships set status = 'accepted';   -- RLS: requester excluded from update
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'TESTFAIL 2a: requester managed to accept own request'; end if;
  begin
    perform respond_friend_request('00000000-0000-0000-0000-00000000000b', true);
    raise exception 'TESTFAIL 2b: requester accepted via RPC';
  exception when others then
    if sqlerrm like 'TESTFAIL%' then raise; end if;
  end;
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-00000000000c');
  select count(*) into n from friendships;
  if n <> 0 then raise exception 'TESTFAIL 2c: outsider can read friendships (%)', n; end if;
  perform _t_reset();
  raise notice 'ok: 2 only recipient can accept; outsiders read nothing';
end $$;

-- ── 3. recipient cannot forge the pair; parties are immutable ──
do $$
begin
  perform _t_as('00000000-0000-0000-0000-00000000000b');
  begin
    update friendships set user_b = '00000000-0000-0000-0000-00000000000c', requested_by = '00000000-0000-0000-0000-00000000000c', status = 'accepted';
    raise exception 'TESTFAIL 3a: recipient rewrote the pair';
  exception when others then
    if sqlerrm like 'TESTFAIL%' then raise; end if;
  end;
  perform _t_reset();
  begin
    update friendships set user_b = '00000000-0000-0000-0000-00000000000c';  -- even superuser: trigger
    raise exception 'TESTFAIL 3b: party columns not frozen';
  exception when others then
    if sqlerrm like 'TESTFAIL%' then raise; end if;
    if sqlerrm not like '%immutable%' then raise exception 'TESTFAIL 3c: unexpected error %', sqlerrm; end if;
  end;
  raise notice 'ok: 3 pair columns cannot be rewritten';
end $$;

-- ── 4. B accepts ──
do $$
declare r text; st text;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000b');
  r := respond_friend_request('00000000-0000-0000-0000-00000000000a', true);
  if r <> 'accepted' then raise exception 'TESTFAIL 4a: got %', r; end if;
  if not are_friends('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b') then
    raise exception 'TESTFAIL 4b: are_friends false after accept';
  end if;
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  select status into st from list_friendships() where other_id = '00000000-0000-0000-0000-00000000000b';
  if st <> 'accepted' then raise exception 'TESTFAIL 4c: A sees %', st; end if;
  perform _t_reset();
  raise notice 'ok: 4 accept → mutual friendship';
end $$;

-- ── 5. decline, block, block is invisible to the blocked requester ──
do $$
declare r text; n int; st text;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000c');
  perform send_friend_request('00000000-0000-0000-0000-00000000000a');
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  r := respond_friend_request('00000000-0000-0000-0000-00000000000c', false);
  if r <> 'declined' then raise exception 'TESTFAIL 5a: got %', r; end if;
  select count(*) into n from list_friendships() where other_id = '00000000-0000-0000-0000-00000000000c';
  if n <> 0 then raise exception 'TESTFAIL 5b: declined row still visible'; end if;
  perform _t_reset();

  perform _t_as('00000000-0000-0000-0000-00000000000c');
  perform send_friend_request('00000000-0000-0000-0000-00000000000a');
  perform _t_reset();
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  r := respond_friend_request('00000000-0000-0000-0000-00000000000c', false, true);
  if r <> 'blocked' then raise exception 'TESTFAIL 5c: got %', r; end if;
  perform _t_reset();

  perform _t_as('00000000-0000-0000-0000-00000000000c');
  select status into st from list_friendships() where other_id = '00000000-0000-0000-0000-00000000000a';
  if st <> 'pending' then raise exception 'TESTFAIL 5d: blocked requester sees %', st; end if;
  perform remove_friend('00000000-0000-0000-0000-00000000000a');           -- cannot clear a block
  delete from friendships;                                                  -- nor via RLS
  r := send_friend_request('00000000-0000-0000-0000-00000000000a');
  if r <> 'pending' then raise exception 'TESTFAIL 5e: got %', r; end if;
  perform _t_reset();
  select count(*) into n from friendships where status = 'blocked';
  if n <> 1 then raise exception 'TESTFAIL 5f: block row lost'; end if;
  raise notice 'ok: 5 decline deletes; block sticks and stays hidden';
end $$;

-- ── 6. group ping only reaches friends; default + custom line ──
do $$
declare n int; m text;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  n := ping_friends(array['00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000c']::uuid[]);
  if n <> 1 then raise exception 'TESTFAIL 6a: expected 1 sent (non-friend dropped), got %', n; end if;
  perform _t_reset();
  select msg into m from pings where to_id = '00000000-0000-0000-0000-00000000000b' and verb = 'wants to play';
  if m <> 'hey i want to play' then raise exception 'TESTFAIL 6b: default line was %', m; end if;
  select count(*) into n from pings where to_id = '00000000-0000-0000-0000-00000000000c';
  if n <> 0 then raise exception 'TESTFAIL 6c: non-friend got pinged'; end if;
  raise notice 'ok: 6a group ping drops non-friends, default line';
end $$;
do $$
declare n int;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  n := ping_friends(array['00000000-0000-0000-0000-00000000000b']::uuid[], '  table 3, come thru  ');
  perform _t_reset();
  select count(*) into n from pings where to_id = '00000000-0000-0000-0000-00000000000b' and msg = 'table 3, come thru';
  if n <> 1 then raise exception 'TESTFAIL 6d: custom line not stored trimmed'; end if;
  raise notice 'ok: 6b custom line';
end $$;

-- ── 7. batch of 7 friends in one insert (would trip the 5/min row trigger) ──
insert into friendships (user_a, user_b, requested_by, status)
select least(a, d), greatest(a, d), a, 'accepted'
from (select '00000000-0000-0000-0000-00000000000a'::uuid a) x,
     unnest(array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000d3',
                  '00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000d5','00000000-0000-0000-0000-0000000000d6',
                  '00000000-0000-0000-0000-0000000000d7']::uuid[]) d
on conflict do nothing;
do $$
declare n int;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  n := ping_friends((select array_agg(id) from profiles where name like 'd_'));
  if n <> 7 then raise exception 'TESTFAIL 7a: expected 7, got %', n; end if;
  perform _t_reset();
  raise notice 'ok: 7a 7-friend batch bypasses per-row limit';
end $$;
-- 4th batch inside 60s → batch throttle
do $$
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  begin
    perform ping_friends(array['00000000-0000-0000-0000-00000000000b']::uuid[]);
    raise exception 'TESTFAIL 7b: 4th batch in a minute was not throttled';
  exception when others then
    if sqlerrm like 'TESTFAIL%' then raise; end if;
    if sqlerrm not like '%slow down%' then raise exception 'TESTFAIL 7c: unexpected %', sqlerrm; end if;
  end;
  perform _t_reset();
  raise notice 'ok: 7b batch throttle';
end $$;

-- ── 8. plain client inserts are still rate limited (flag is RPC-only) ──
do $$
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  begin
    insert into pings (from_id, to_id, verb, msg) values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'wants to play', 'x');
    raise exception 'TESTFAIL 8a: per-row rate limit no longer enforced';
  exception when others then
    if sqlerrm like 'TESTFAIL%' then raise; end if;
    if sqlerrm not like '%Rate limit%' then raise exception 'TESTFAIL 8b: unexpected %', sqlerrm; end if;
  end;
  perform _t_reset();
  raise notice 'ok: 8 direct inserts still rate limited';
end $$;

-- ── 9. broadcast to all friends, throttled to 1/hour ──
do $$
declare n int;
begin
  update profiles set venue = 'The SUB' where id = '00000000-0000-0000-0000-00000000000a';
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  n := broadcast_playing();
  if n <> 8 then raise exception 'TESTFAIL 9a: expected 8 friends, got %', n; end if;
  n := broadcast_playing();
  if n <> 0 then raise exception 'TESTFAIL 9b: second broadcast inside an hour sent %', n; end if;
  perform _t_reset();
  select count(*) into n from pings where verb = 'is playing' and msg = 'ez is playing at The SUB';
  if n <> 8 then raise exception 'TESTFAIL 9c: broadcast message wrong (%)', n; end if;
  raise notice 'ok: 9 broadcast fans out once per hour';
end $$;

-- ── 10. set_school validates + backfills home_city ──
do $$
declare s text; c text;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  perform set_school('TTU ');
  perform _t_reset();
  select school, home_city into s, c from profiles where id = '00000000-0000-0000-0000-00000000000a';
  if s <> 'ttu' or c <> 'lubbock' then raise exception 'TESTFAIL 10a: % / %', s, c; end if;
  perform _t_as('00000000-0000-0000-0000-00000000000b');
  perform set_school('ttu');
  begin
    perform set_school('nope');
    raise exception 'TESTFAIL 10b: unknown school accepted';
  exception when others then
    if sqlerrm like 'TESTFAIL%' then raise; end if;
  end;
  perform _t_reset();
  select home_city into c from profiles where id = '00000000-0000-0000-0000-00000000000b';
  if c <> 'austin' then raise exception 'TESTFAIL 10c: existing home_city overwritten'; end if;
  perform _t_as('00000000-0000-0000-0000-00000000000c');
  perform set_school(null);
  perform _t_reset();
  raise notice 'ok: 10 set_school';
end $$;

-- ── 11. search scoped by school, wildcard-safe, excludes self ──
do $$
declare n int;
begin
  perform _t_as('00000000-0000-0000-0000-00000000000a');
  select count(*) into n from search_players('bo', 'ttu');
  if n <> 1 then raise exception 'TESTFAIL 11a: school-scoped search got %', n; end if;
  select count(*) into n from search_players('BO');
  if n <> 2 then raise exception 'TESTFAIL 11b: unscoped search got %', n; end if;
  select count(*) into n from search_players('ez');
  if n <> 0 then raise exception 'TESTFAIL 11c: search returned the caller'; end if;
  select count(*) into n from search_players('%');
  if n <> 0 then raise exception 'TESTFAIL 11d: wildcard not escaped (%)', n; end if;
  perform _t_reset();
  raise notice 'ok: 11 search';
end $$;

-- ── 12. anon: can read schools, cannot touch friendships or friend RPCs ──
do $$
declare n int;
begin
  perform _t_anon();
  select count(*) into n from schools where slug = 'ttu';
  if n <> 1 then raise exception 'TESTFAIL 12a: anon cannot read schools'; end if;
  begin
    select count(*) into n from friendships;
    raise exception 'TESTFAIL 12b: anon can read friendships';
  exception when others then
    if sqlerrm like 'TESTFAIL%' then raise; end if;
  end;
  begin
    perform ping_friends(array['00000000-0000-0000-0000-00000000000b']::uuid[]);
    raise exception 'TESTFAIL 12c: anon can call ping_friends';
  exception when others then
    if sqlerrm like 'TESTFAIL%' then raise; end if;
  end;
  perform _t_reset();
  raise notice 'ok: 12 anon surface';
end $$;

select 'ALL BEHAVIOURAL CHECKS PASSED' as result;
