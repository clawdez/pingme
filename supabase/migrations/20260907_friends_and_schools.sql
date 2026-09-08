-- pingme — friends graph + school cohorts
-- Run AFTER schema.sql (profiles, pings, check_ping_rate_limit). Idempotent:
-- every statement is `if not exists` / `create or replace` / `on conflict`.
--
-- 1) schools: reference table (one row per campus). Adding a school = one
--    insert, no code change.
-- 2) profiles.school: cohort layer above home_city. Roster/search prefer a
--    school match, falling back to city when school is null.
-- 3) friendships: persistent mutual friend graph, one canonical row per pair
--    (user_a < user_b). Only the recipient can accept.
-- 4) RPCs: friend requests, friend search, group "ping to play", throttled
--    "I'm playing" broadcast to friends.

-- Defensive: this migration touches home_city; make sure it exists even if
-- schema-city-scope.sql was never applied on this instance.
alter table profiles add column if not exists home_city text;

-- ═══════════════════════════════════════════
-- SCHOOLS (reference data)
-- ═══════════════════════════════════════════

create table if not exists schools (
  slug         text primary key check (slug ~ '^[a-z0-9-]{2,32}$'),
  display_name text not null check (char_length(display_name) between 2 and 80),
  color        text not null default '#E8502A' check (color ~ '^#[0-9a-fA-F]{6}$'),
  default_city text,            -- lower-cased city slug used to backfill home_city
  created_at   timestamptz not null default now()
);

alter table schools enable row level security;

-- Public reference data: readable by everyone, writable by nobody but the
-- service role (no insert/update/delete policies on purpose).
drop policy if exists "Anyone can view schools" on schools;
create policy "Anyone can view schools"
  on schools for select using (true);

grant select on schools to anon, authenticated;

-- Launch cohort. More schools = more rows here.
insert into schools (slug, display_name, color, default_city) values
  ('ttu', 'Texas Tech University', '#CC0000', 'lubbock')
on conflict (slug) do nothing;

-- ═══════════════════════════════════════════
-- PROFILES: school cohort + broadcast throttle
-- ═══════════════════════════════════════════

alter table profiles add column if not exists school text references schools(slug) on delete set null;
alter table profiles add column if not exists last_friend_broadcast_at timestamptz;

create index if not exists idx_profiles_school on profiles(school);

-- Other clients need to read school to scope their roster (mirrors home_city).
grant select (school) on profiles to anon, authenticated;

-- Set (or clear) the caller's school. Validates the slug and backfills
-- home_city from the school's default city when the user has none yet.
create or replace function set_school(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s schools%rowtype;
begin
  if auth.uid() is null then return; end if;
  if p_slug is null or trim(p_slug) = '' then
    update profiles set school = null where id = auth.uid();
    return;
  end if;
  select * into s from schools where slug = lower(trim(p_slug));
  if not found then
    raise exception 'unknown school';
  end if;
  update profiles
    set school = s.slug,
        home_city = coalesce(home_city, nullif(lower(trim(coalesce(s.default_city, ''))), ''))
  where id = auth.uid();
end;
$$;

revoke all on function set_school(text) from public, anon;
grant  execute on function set_school(text) to authenticated;

-- ═══════════════════════════════════════════
-- FRIENDSHIPS
-- ═══════════════════════════════════════════
-- Canonical storage: user_a is always the smaller uuid, so a pair is one row.
-- requested_by records who sent the request; the other party is the only one
-- who can accept (enforced in RLS *and* in respond_friend_request).

create table if not exists friendships (
  user_a       uuid not null references profiles(id) on delete cascade,
  user_b       uuid not null references profiles(id) on delete cascade,
  requested_by uuid not null references profiles(id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'blocked')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_canonical_order check (user_a < user_b),
  constraint friendships_requester_is_party check (requested_by = user_a or requested_by = user_b)
);

create index if not exists idx_friendships_user_b on friendships(user_b);
create index if not exists idx_friendships_status on friendships(status);

alter table friendships enable row level security;

-- Supabase default privileges hand anon table access; the friend graph is
-- signed-in only, so take it back explicitly (RLS would return 0 rows anyway).
revoke all on friendships from anon, public;
grant select, insert, update, delete on friendships to authenticated;

-- Read: only the two parties.
drop policy if exists "Parties can read their friendship" on friendships;
create policy "Parties can read their friendship"
  on friendships for select
  using (auth.uid() = user_a or auth.uid() = user_b);

-- Insert: you can only request as yourself, and only a pending row.
drop policy if exists "Users can send friend requests" on friendships;
create policy "Users can send friend requests"
  on friendships for insert
  with check (
    auth.uid() = requested_by
    and (auth.uid() = user_a or auth.uid() = user_b)
    and status = 'pending'
  );

-- Update: only the recipient (not the requester) may change status, and only
-- to accepted/blocked. Party columns are frozen by the trigger below.
drop policy if exists "Recipient can respond to friend request" on friendships;
create policy "Recipient can respond to friend request"
  on friendships for update
  using (
    (auth.uid() = user_a or auth.uid() = user_b)
    and auth.uid() <> requested_by
  )
  with check (
    (auth.uid() = user_a or auth.uid() = user_b)
    and auth.uid() <> requested_by
    and status in ('accepted', 'blocked')
  );

-- Delete: either party can unfriend / decline / cancel — except a requester
-- who has been blocked cannot clear the block and re-request.
drop policy if exists "Parties can remove their friendship" on friendships;
create policy "Parties can remove their friendship"
  on friendships for delete
  using (
    (auth.uid() = user_a or auth.uid() = user_b)
    and (status <> 'blocked' or auth.uid() <> requested_by)
  );

-- Party columns are immutable once a row exists (closes the RLS gap where a
-- recipient could rewrite user_b/requested_by to forge a friendship).
create or replace function friendships_freeze_parties()
returns trigger
language plpgsql
as $$
begin
  if NEW.user_a <> OLD.user_a or NEW.user_b <> OLD.user_b or NEW.requested_by <> OLD.requested_by then
    raise exception 'friendship parties are immutable';
  end if;
  NEW.updated_at := now();
  return NEW;
end;
$$;

drop trigger if exists friendships_freeze_parties on friendships;
create trigger friendships_freeze_parties
  before update on friendships
  for each row execute function friendships_freeze_parties();

-- ── helpers ──

-- Canonical (a, b) ordering for a pair.
create or replace function _pm_pair(p_x uuid, p_y uuid, out a uuid, out b uuid)
language sql
immutable
as $$
  select least(p_x, p_y), greatest(p_x, p_y);
$$;

-- True when the two users are accepted friends.
create or replace function are_friends(p_x uuid, p_y uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from friendships f
    where f.user_a = least(p_x, p_y) and f.user_b = greatest(p_x, p_y)
      and f.status = 'accepted'
  );
$$;

revoke all on function are_friends(uuid, uuid) from public, anon;
grant  execute on function are_friends(uuid, uuid) to authenticated;

-- ── send a friend request ──
-- Returns the resulting status: 'pending' (request sent), 'accepted' (the
-- other side had already requested you → auto-accept), or the existing status.
create or replace function send_friend_request(p_target uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  a uuid; b uuid;
  f friendships%rowtype;
begin
  if me is null then raise exception 'sign in first'; end if;
  if p_target is null or p_target = me then raise exception 'invalid target'; end if;
  if not exists (select 1 from profiles where id = p_target and coalesce(name, '') <> '') then
    raise exception 'player not found';
  end if;

  select * into a, b from _pm_pair(me, p_target);
  select * into f from friendships where user_a = a and user_b = b;

  if found then
    -- They already asked us: accepting beats a duplicate request.
    if f.status = 'pending' and f.requested_by = p_target then
      update friendships set status = 'accepted' where user_a = a and user_b = b;
      return 'accepted';
    end if;
    -- Don't leak blocks: a blocked requester just sees "pending".
    if f.status = 'blocked' and f.requested_by = me then return 'pending'; end if;
    return f.status;
  end if;

  insert into friendships (user_a, user_b, requested_by, status)
  values (a, b, me, 'pending');
  return 'pending';
end;
$$;

revoke all on function send_friend_request(uuid) from public, anon;
grant  execute on function send_friend_request(uuid) to authenticated;

-- ── respond to a request ──
-- Only the recipient may call this. accept=true → accepted; accept=false →
-- the row is deleted (decline) or kept as 'blocked' when p_block is set.
create or replace function respond_friend_request(p_from uuid, p_accept boolean, p_block boolean default false)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  a uuid; b uuid;
  f friendships%rowtype;
begin
  if me is null then raise exception 'sign in first'; end if;
  select * into a, b from _pm_pair(me, p_from);
  select * into f from friendships where user_a = a and user_b = b;
  if not found or f.requested_by <> p_from or f.status <> 'pending' then
    raise exception 'no pending request from that player';
  end if;
  if p_accept then
    update friendships set status = 'accepted' where user_a = a and user_b = b;
    return 'accepted';
  elsif p_block then
    update friendships set status = 'blocked' where user_a = a and user_b = b;
    return 'blocked';
  else
    delete from friendships where user_a = a and user_b = b;
    return 'declined';
  end if;
end;
$$;

revoke all on function respond_friend_request(uuid, boolean, boolean) from public, anon;
grant  execute on function respond_friend_request(uuid, boolean, boolean) to authenticated;

-- ── unfriend / cancel an outgoing request ──
create or replace function remove_friend(p_other uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  a uuid; b uuid;
begin
  if me is null then raise exception 'sign in first'; end if;
  select * into a, b from _pm_pair(me, p_other);
  delete from friendships
  where user_a = a and user_b = b
    and (status <> 'blocked' or requested_by <> me);
end;
$$;

revoke all on function remove_friend(uuid) from public, anon;
grant  execute on function remove_friend(uuid) to authenticated;

-- ── my friends + requests, flattened for the client ──
-- status as seen by the caller: 'accepted' | 'pending' | 'blocked'.
-- incoming = true when the other user sent the request (I can accept it).
-- A requester who was blocked sees the row as an ordinary outgoing 'pending'.
create or replace function list_friendships()
returns table (
  other_id   uuid,
  name       text,
  color      text,
  school     text,
  status     text,
  incoming   boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    case when f.user_a = auth.uid() then f.user_b else f.user_a end as other_id,
    p.name, p.color, p.school,
    case when f.status = 'blocked' and f.requested_by = auth.uid() then 'pending' else f.status end as status,
    (f.requested_by <> auth.uid()) as incoming,
    f.created_at
  from friendships f
  join profiles p on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where auth.uid() is not null
    and (f.user_a = auth.uid() or f.user_b = auth.uid())
  order by f.status = 'pending' desc, p.name;
$$;

revoke all on function list_friendships() from public, anon;
grant  execute on function list_friendships() to authenticated;

-- ── search players to add ──
-- Case-insensitive substring match on name. p_school scopes the search to a
-- cohort ('ttu'); null = all schools. Never returns the caller or nameless rows.
create or replace function search_players(p_q text, p_school text default null, p_limit int default 20)
returns table (id uuid, name text, color text, school text, home_city text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := lower(trim(coalesce(p_q, '')));
  pat text;
begin
  if auth.uid() is null then return; end if;
  if char_length(q) < 1 then return; end if;
  -- escape ilike wildcards so "50%" searches literally
  pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    select p.id, p.name, p.color, p.school, p.home_city
    from profiles p
    where p.id <> auth.uid()
      and coalesce(p.name, '') <> '' and p.name <> 'anon'
      and p.name ilike pat
      and (p_school is null or p.school = lower(trim(p_school)))
    order by (p.name ilike (substr(pat, 2))) desc, p.name
    limit greatest(1, least(coalesce(p_limit, 20), 50));
end;
$$;

revoke all on function search_players(text, text, int) from public, anon;
grant  execute on function search_players(text, text, int) to authenticated;

-- ═══════════════════════════════════════════
-- PINGS: friend batch sends
-- ═══════════════════════════════════════════
-- The per-row rate limit (5 / 60s, schema.sql) would reject a group ping to
-- more than 5 friends. The friend RPCs below set a transaction-local flag the
-- trigger honours, and apply their own batch-level throttle instead. Only
-- security-definer RPCs can set the flag — it is not reachable from PostgREST.

create or replace function check_ping_rate_limit()
returns trigger
language plpgsql
security definer
as $$
declare
  recent_count int;
begin
  if current_setting('pingme.skip_rate_limit', true) = '1' then
    return NEW;
  end if;

  select count(*) into recent_count
  from pings
  where from_id = NEW.from_id
    and created_at > now() - interval '60 seconds';

  if recent_count >= 5 then
    raise exception 'Rate limit exceeded: too many pings';
  end if;

  return NEW;
end;
$$;

-- ── group ping: "hey i want to play" to N accepted friends in one insert ──
-- Returns the number of pings sent. Non-friends in p_to are silently dropped.
-- Throttle: at most 3 batches per 60s per sender (a batch shares created_at).
create or replace function ping_friends(p_to uuid[], p_msg text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  msg text := nullif(left(trim(coalesce(p_msg, '')), 120), '');
  batches int;
  sent int;
begin
  if me is null then raise exception 'sign in first'; end if;
  if p_to is null or cardinality(p_to) = 0 then return 0; end if;
  if cardinality(p_to) > 50 then raise exception 'too many friends in one ping'; end if;

  select count(distinct created_at) into batches
  from pings where from_id = me and created_at > now() - interval '60 seconds';
  if batches >= 3 then raise exception 'slow down — too many group pings'; end if;

  perform set_config('pingme.skip_rate_limit', '1', true);

  insert into pings (from_id, to_id, verb, msg, unread)
  select me, t.id, 'wants to play', coalesce(msg, 'hey i want to play'), true
  from (select distinct unnest(p_to) as id) t
  where t.id <> me
    and are_friends(me, t.id);
  get diagnostics sent = row_count;
  return sent;
end;
$$;

revoke all on function ping_friends(uuid[], text) from public, anon;
grant  execute on function ping_friends(uuid[], text) to authenticated;

-- ── "I'm playing" broadcast to every accepted friend ──
-- Throttled server-side to once per hour per user (returns 0 when throttled,
-- so duplicate calls inside the window are no-ops, not errors).
create or replace function broadcast_playing(p_msg text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  p profiles%rowtype;
  msg text;
  sent int;
begin
  if me is null then raise exception 'sign in first'; end if;
  select * into p from profiles where id = me;
  if not found then raise exception 'no profile'; end if;
  if p.last_friend_broadcast_at is not null and p.last_friend_broadcast_at > now() - interval '1 hour' then
    return 0;
  end if;

  msg := nullif(left(trim(coalesce(p_msg, '')), 120), '');
  if msg is null then
    msg := p.name || ' is playing' || case when coalesce(p.venue, '') <> '' then ' at ' || p.venue else '' end;
  end if;

  perform set_config('pingme.skip_rate_limit', '1', true);

  insert into pings (from_id, to_id, verb, msg, unread)
  select me, case when f.user_a = me then f.user_b else f.user_a end, 'is playing', msg, true
  from friendships f
  where f.status = 'accepted' and (f.user_a = me or f.user_b = me);
  get diagnostics sent = row_count;

  update profiles set last_friend_broadcast_at = now() where id = me;
  return sent;
end;
$$;

revoke all on function broadcast_playing(text) from public, anon;
grant  execute on function broadcast_playing(text) to authenticated;
