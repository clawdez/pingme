-- pingme — schools → scenes
-- Run AFTER 20260907_friends_and_schools.sql, 20260908_seed_texas_schools.sql,
-- 20260909_pending_schools.sql. Idempotent: every statement is if-not-exists /
-- create-or-replace / drop-if-exists / on-conflict, safe to re-run on a DB
-- where it already applied.
--
-- A Scene is a place-anchored notification group ("Zilker Park Pickleball",
-- "TTU Rec Center"). Users join scenes, create scenes, and ping from a scene:
-- every member of that scene (minus the sender, minus anyone who muted it)
-- gets a pings row → push. A user can be in many scenes.
--
-- 1) scenes           — replaces schools. Same slug rules, plus activity /
--                       place_hint / zip / city / region, creator, member_count
--                       (trigger-maintained) and approved_at.
-- 2) scene_members    — opt-in membership = notification subscription, with a
--                       per-scene notifications_enabled mute.
-- 3) data copy        — every schools row becomes a scenes row (same slug,
--                       display_name, color, city, pending); every
--                       profiles.school becomes a scene_members row; the
--                       school_suggestions rate-limit history carries over.
-- 4) auto-approve     — the 3rd member flips pending → false (approved_at set).
-- 5) RPCs             — create_scene / join_scene / leave_scene /
--                       set_scene_notifications / list_scenes / ping_scene /
--                       approve_scene (admin).
-- 6) aliases          — suggest_school / set_school / approve_school keep their
--                       signatures and route into scenes, so a browser that
--                       loaded the previous app.js keeps working for ONE RELEASE.
--                       Drop them together with the schools table in the
--                       follow-up PR.
--
-- DEPRECATED, kept for one release (do NOT drop here): the `schools` table and
-- `school_suggestions`. Nothing new is written to them.
--
-- profiles.school stays as a MIRROR column: the slug of the caller's most
-- recently joined scene (null when they are in none). The FK to schools(slug)
-- is dropped so the mirror can point at a scene that never was a school.
-- search_players / list_friendships / the roster read it unchanged.
--
-- Queue:    select slug, display_name, member_count, created_at from scenes where pending order by created_at desc;
-- Approve:  select approve_scene('<slug>');
--
-- Rollback (no data in schools / profiles is rewritten by this file):
--   drop trigger if exists scene_members_sync on scene_members;
--   drop function scene_members_sync(), create_scene(text,text,text,text), join_scene(text),
--     leave_scene(text), set_scene_notifications(text,boolean), ping_scene(text,text,text),
--     list_scenes(text,text), approve_scene(text), _pm_sync_primary_scene(uuid), _pm_scene_slug(text);
--   alter table pings drop column scene_id;
--   drop table scene_members, scene_suggestions, scenes, zip_prefixes;
--   drop function my_scene_ids(), is_scene_member(uuid);
--   re-run 20260907 + 20260909 (restores set_school / suggest_school / approve_school), then
--   alter table profiles add constraint profiles_school_fkey foreign key (school) references schools(slug) on delete set null;

-- ═══════════════════════════════════════════
-- SCENES
-- ═══════════════════════════════════════════

create table if not exists scenes (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null check (slug ~ '^[a-z0-9-]{2,32}$'),
  display_name text not null check (char_length(display_name) between 2 and 80),
  activity     text check (activity is null or char_length(activity) between 1 and 32),   -- 'pickleball' | 'basketball' | 'ping-pong' | free text
  place_hint   text check (place_hint is null or char_length(place_hint) <= 120),        -- 'Zilker Park, Austin TX'
  zip          text check (zip is null or zip ~ '^[0-9]{5}$'),
  city         text,                                                                     -- resolved from zip (zip_prefixes) or copied from schools.default_city
  region       text,                                                                     -- 'tx', 'oh', ...
  color        text not null default '#E8502A' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_by   uuid references auth.users(id) on delete set null,
  pending      boolean not null default true,
  member_count int not null default 0,
  approved_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists scenes_slug_idx on scenes(slug);
create index if not exists scenes_zip_idx on scenes(zip) where zip is not null;
create index if not exists scenes_city_idx on scenes(city) where city is not null;

-- ═══════════════════════════════════════════
-- SCENE MEMBERS (opt-in = notification subscription)
-- ═══════════════════════════════════════════

create table if not exists scene_members (
  scene_id              uuid not null references scenes(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  joined_at             timestamptz not null default now(),
  notifications_enabled boolean not null default true,
  primary key (scene_id, user_id)
);

create index if not exists scene_members_user_idx on scene_members(user_id);

-- ═══════════════════════════════════════════
-- CREATION LOG (rate limit + audit) — replaces school_suggestions
-- ═══════════════════════════════════════════

create table if not exists scene_suggestions (
  user_id    uuid not null references profiles(id) on delete cascade,
  slug       text not null,
  created_at timestamptz not null default now()
);

create index if not exists scene_suggestions_user_time_idx on scene_suggestions(user_id, created_at desc);

alter table scene_suggestions enable row level security;
revoke all on scene_suggestions from anon, authenticated, public;
grant select on scene_suggestions to service_role;

-- ═══════════════════════════════════════════
-- ZIP → CITY (reference data; "scenes near you" without a geo service)
-- ═══════════════════════════════════════════
-- 3-digit ZIP prefixes are USPS sectional centers: same prefix ≈ same metro.
-- Adding a city = one insert. Unknown prefixes leave city/region null.

create table if not exists zip_prefixes (
  prefix text primary key check (prefix ~ '^[0-9]{3}$'),
  city   text not null,
  region text not null
);

alter table zip_prefixes enable row level security;
drop policy if exists "Anyone can view zip prefixes" on zip_prefixes;
create policy "Anyone can view zip prefixes"
  on zip_prefixes for select using (true);
grant select on zip_prefixes to anon, authenticated;

insert into zip_prefixes (prefix, city, region) values
  ('733', 'austin', 'tx'), ('786', 'austin', 'tx'), ('787', 'austin', 'tx'),
  ('793', 'lubbock', 'tx'), ('794', 'lubbock', 'tx'),
  ('770', 'houston', 'tx'), ('771', 'houston', 'tx'), ('772', 'houston', 'tx'),
  ('750', 'dallas', 'tx'), ('751', 'dallas', 'tx'), ('752', 'dallas', 'tx'), ('753', 'dallas', 'tx'),
  ('760', 'fort worth', 'tx'), ('761', 'fort worth', 'tx'), ('762', 'fort worth', 'tx'),
  ('780', 'san antonio', 'tx'), ('781', 'san antonio', 'tx'), ('782', 'san antonio', 'tx'),
  ('778', 'college station', 'tx'),
  ('766', 'waco', 'tx'), ('767', 'waco', 'tx'),
  ('798', 'el paso', 'tx'), ('799', 'el paso', 'tx')
on conflict (prefix) do nothing;

-- ═══════════════════════════════════════════
-- PINGS: which scene a ping came from (trending + tracing)
-- ═══════════════════════════════════════════

alter table pings add column if not exists scene_id uuid references scenes(id) on delete set null;
create index if not exists pings_scene_created_idx on pings(scene_id, created_at desc) where scene_id is not null;

-- ═══════════════════════════════════════════
-- PROFILES.school → mirror column (see header)
-- ═══════════════════════════════════════════

alter table profiles drop constraint if exists profiles_school_fkey;

-- ═══════════════════════════════════════════
-- RLS helpers (security definer so the scene_members policy can look at
-- scene_members without recursing into itself)
-- ═══════════════════════════════════════════

create or replace function is_scene_member(p_scene uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from scene_members m where m.scene_id = p_scene and m.user_id = auth.uid()
  );
$$;

create or replace function my_scene_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.scene_id from scene_members m where m.user_id = auth.uid();
$$;

grant execute on function is_scene_member(uuid), my_scene_ids() to anon, authenticated;

-- ═══════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════

-- scenes: approved rows for everyone (the landing page resolves ?scene= share
-- links before sign-in, like schools did); a pending row only for its creator
-- and its members. Writes go through the RPCs below — no client policies.
alter table scenes enable row level security;
drop policy if exists "Anyone can view approved scenes" on scenes;
create policy "Anyone can view approved scenes"
  on scenes for select
  using (pending = false or created_by = auth.uid() or is_scene_member(id));
grant select on scenes to anon, authenticated;

-- scene_members: my own rows + the member list of scenes I belong to.
alter table scene_members enable row level security;
revoke all on scene_members from anon, public;
grant select on scene_members to authenticated;
drop policy if exists "Members see their scenes' members" on scene_members;
create policy "Members see their scenes' members"
  on scene_members for select
  using (user_id = auth.uid() or scene_id in (select my_scene_ids()));

-- ═══════════════════════════════════════════
-- member_count + auto-approve trigger
-- ═══════════════════════════════════════════
-- Recount (never +1/-1) so the denormalised value can't drift; the 3rd member
-- publishes the scene.

create or replace function scene_members_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := coalesce(NEW.scene_id, OLD.scene_id);
begin
  update scenes s
    set member_count = (select count(*) from scene_members m where m.scene_id = s.id)
  where s.id = sid;
  if TG_OP = 'INSERT' then
    update scenes
      set pending = false, approved_at = now()
    where id = sid and pending and member_count >= 3;
  end if;
  return null;
end;
$$;

drop trigger if exists scene_members_sync on scene_members;
create trigger scene_members_sync
  after insert or delete on scene_members
  for each row execute function scene_members_sync();

-- ═══════════════════════════════════════════
-- DATA COPY: schools → scenes, profiles.school → scene_members
-- ═══════════════════════════════════════════

insert into scenes (slug, display_name, color, city, pending, approved_at)
select s.slug, s.display_name, s.color, s.default_city, s.pending, case when s.pending then null else now() end
from schools s
on conflict (slug) do nothing;

insert into scene_members (scene_id, user_id)
select s.id, p.id
from profiles p
join scenes s on s.slug = p.school
where p.school is not null
on conflict do nothing;

insert into scene_suggestions (user_id, slug, created_at)
select s.user_id, s.slug, s.created_at
from school_suggestions s
where not exists (
  select 1 from scene_suggestions t
  where t.user_id = s.user_id and t.slug = s.slug and t.created_at = s.created_at
);

-- ═══════════════════════════════════════════
-- internal helpers
-- ═══════════════════════════════════════════

-- Name → slug. Lower-cased, [a-z0-9] kept, runs of anything else → '-', outer
-- dashes stripped, capped to the 32 chars scenes.slug allows (long names like
-- "University of Texas at San Antonio Rec Center" must still work), dashes
-- stripped again after the cut. The slug is the join key: two people creating
-- the same place land on the same row.
create or replace function _pm_scene_slug(p_name text)
returns text
language plpgsql
immutable
as $$
declare
  s text;
begin
  s := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-');
  s := btrim(left(s, 32), '-');
  if s !~ '^[a-z0-9-]{2,32}$' then raise exception 'invalid scene name'; end if;
  if s in ('other', 'none', 'admin', 'test', 'scenes', 'scene') then raise exception 'invalid scene name'; end if;
  return s;
end;
$$;

-- profiles.school mirror = most recently joined scene (null when none).
-- Joins stamp clock_timestamp() (not the transaction's now()) so two joins in
-- one transaction still order correctly.
create or replace function _pm_sync_primary_scene(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles p
    set school = (
      select s.slug
      from scene_members m
      join scenes s on s.id = m.scene_id
      where m.user_id = p_uid
      order by m.joined_at desc, s.slug
      limit 1
    )
  where p.id = p_uid;
end;
$$;

revoke all on function _pm_scene_slug(text), _pm_sync_primary_scene(uuid) from public, anon, authenticated;

-- ═══════════════════════════════════════════
-- RPC: create_scene(name, activity?, place_hint?, zip?) → slug
-- ═══════════════════════════════════════════
-- New slug → pending row owned by the caller, caller auto-joined. Existing
-- slug (approved or pending) → just join it. 3 calls per user per 24h.

create or replace function create_scene(p_name text, p_activity text default null, p_place_hint text default null, p_zip text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me         uuid := auth.uid();
  name_in    text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  act        text := nullif(left(regexp_replace(lower(trim(coalesce(p_activity, ''))), '\s+', ' ', 'g'), 32), '');
  place      text := nullif(left(regexp_replace(trim(coalesce(p_place_hint, '')), '\s+', ' ', 'g'), 120), '');
  zip_in     text := nullif(trim(coalesce(p_zip, '')), '');
  city_out   text;
  region_out text;
  slug_out   text;
  sid        uuid;
  recent     int;
begin
  if me is null then raise exception 'sign in first'; end if;
  if char_length(name_in) not between 2 and 80 then
    raise exception 'scene name must be 2-80 characters';
  end if;
  slug_out := _pm_scene_slug(name_in);
  if zip_in is not null and zip_in !~ '^[0-9]{5}$' then raise exception 'zip must be 5 digits'; end if;
  if zip_in is not null then
    select z.city, z.region into city_out, region_out from zip_prefixes z where z.prefix = left(zip_in, 3);
  end if;

  select count(*) into recent
  from scene_suggestions
  where user_id = me and created_at > now() - interval '24 hours';
  if recent >= 3 then raise exception 'rate limit exceeded - try again tomorrow'; end if;

  insert into scenes (slug, display_name, activity, place_hint, zip, city, region, created_by, pending)
  values (slug_out, name_in, act, place, zip_in, city_out, region_out, me, true)
  on conflict (slug) do nothing;

  insert into scene_suggestions (user_id, slug) values (me, slug_out);

  select id into sid from scenes where slug = slug_out;
  insert into scene_members (scene_id, user_id, joined_at) values (sid, me, clock_timestamp()) on conflict do nothing;
  perform _pm_sync_primary_scene(me);
  return slug_out;
end;
$$;

revoke all on function create_scene(text, text, text, text) from public, anon;
grant  execute on function create_scene(text, text, text, text) to authenticated;

-- ═══════════════════════════════════════════
-- RPC: join_scene(slug) / leave_scene(slug)
-- ═══════════════════════════════════════════
-- Joining by slug works for pending scenes too — the slug is the share link,
-- and the 3rd member is what approves the scene.

create or replace function join_scene(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me  uuid := auth.uid();
  sid uuid;
begin
  if me is null then raise exception 'sign in first'; end if;
  select id into sid from scenes where slug = lower(trim(coalesce(p_slug, '')));
  if sid is null then raise exception 'unknown scene'; end if;
  insert into scene_members (scene_id, user_id, joined_at) values (sid, me, clock_timestamp()) on conflict do nothing;
  perform _pm_sync_primary_scene(me);
end;
$$;

revoke all on function join_scene(text) from public, anon;
grant  execute on function join_scene(text) to authenticated;

create or replace function leave_scene(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first'; end if;
  delete from scene_members m
  using scenes s
  where s.id = m.scene_id
    and s.slug = lower(trim(coalesce(p_slug, '')))
    and m.user_id = me;
  perform _pm_sync_primary_scene(me);
end;
$$;

revoke all on function leave_scene(text) from public, anon;
grant  execute on function leave_scene(text) to authenticated;

-- ═══════════════════════════════════════════
-- RPC: set_scene_notifications(slug, enabled) — per-scene mute
-- ═══════════════════════════════════════════

create or replace function set_scene_notifications(p_slug text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first'; end if;
  update scene_members m
    set notifications_enabled = coalesce(p_enabled, true)
  from scenes s
  where s.id = m.scene_id
    and s.slug = lower(trim(coalesce(p_slug, '')))
    and m.user_id = me;
  if not found then raise exception 'not a member'; end if;
end;
$$;

revoke all on function set_scene_notifications(text, boolean) from public, anon;
grant  execute on function set_scene_notifications(text, boolean) to authenticated;

-- ═══════════════════════════════════════════
-- RPC: list_scenes(zip?, q?) — everything the picker / browse view needs
-- ═══════════════════════════════════════════
-- Visibility rule applied inside (approved, or pending + creator/member).
-- joined / notifications_enabled / joined_at are the caller's membership.
-- pings_24h counts ping batches (one per sender+timestamp) from the scene in
-- the last 24h → "trending". near_rank (only when a zip is given): 0 same zip,
-- 1 same 3-digit prefix, 2 same city, 3 elsewhere. Ordered nearest → biggest.

create or replace function list_scenes(p_zip text default null, p_q text default null)
returns table (
  id                    uuid,
  slug                  text,
  display_name          text,
  activity              text,
  place_hint            text,
  zip                   text,
  city                  text,
  region                text,
  color                 text,
  pending               boolean,
  member_count          int,
  approved_at           timestamptz,
  created_at            timestamptz,
  joined                boolean,
  notifications_enabled boolean,
  joined_at             timestamptz,
  pings_24h             int,
  last_ping_at          timestamptz,
  near_rank             int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  z     text := nullif(trim(coalesce(p_zip, '')), '');
  zcity text;
  q     text := lower(trim(coalesce(p_q, '')));
  pat   text;
begin
  if z is not null and z !~ '^[0-9]{5}$' then z := null; end if;
  if z is not null then
    select zp.city into zcity from zip_prefixes zp where zp.prefix = left(z, 3);
  end if;
  if q <> '' then
    pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
  select s.id, s.slug, s.display_name, s.activity, s.place_hint, s.zip, s.city, s.region, s.color,
         s.pending, s.member_count, s.approved_at, s.created_at,
         (m.user_id is not null)                       as joined,
         coalesce(m.notifications_enabled, true)       as notifications_enabled,
         m.joined_at,
         coalesce(pg.n, 0)::int                        as pings_24h,
         pg.last_at                                    as last_ping_at,
         case when z is null then null
              when s.zip = z then 0
              when left(s.zip, 3) = left(z, 3) then 1
              when zcity is not null and s.city = zcity then 2
              else 3 end                               as near_rank
  from scenes s
  left join scene_members m on m.scene_id = s.id and m.user_id = auth.uid()
  left join lateral (
    select count(*)::int as n, max(b.created_at) as last_at
    from (
      select distinct p.from_id, p.created_at
      from pings p
      where p.scene_id = s.id and p.created_at > now() - interval '24 hours'
    ) b
  ) pg on true
  where (s.pending = false or s.created_by = auth.uid() or m.user_id is not null)
    and (pat is null or s.display_name ilike pat or s.slug ilike pat or coalesce(s.city, '') ilike pat)
  order by 19 nulls last, s.member_count desc, s.display_name;
end;
$$;

revoke all on function list_scenes(text, text) from public;
grant  execute on function list_scenes(text, text) to anon, authenticated;

-- ═══════════════════════════════════════════
-- RPC: ping_scene(slug, msg?, verb?) → recipients
-- ═══════════════════════════════════════════
-- One pings row per member (minus the sender, minus muted) stamped with
-- scene_id; the existing ping_push_trigger turns each row into a push. Uses
-- the same transaction-local bypass of the 5/60s per-row limit as
-- ping_friends. Throttle: one ping per scene per sender per 10 minutes —
-- inside the window it returns 0 (no-op, not an error).

create or replace function ping_scene(p_slug text, p_msg text default null, p_verb text default 'is playing')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me      uuid := auth.uid();
  s       scenes%rowtype;
  me_name text;
  msg     text;
  sent    int;
begin
  if me is null then raise exception 'sign in first'; end if;
  if p_verb is null or p_verb not in ('is playing', 'is down to play') then raise exception 'invalid verb'; end if;
  select * into s from scenes where slug = lower(trim(coalesce(p_slug, '')));
  if not found then raise exception 'unknown scene'; end if;
  if not exists (select 1 from scene_members m where m.scene_id = s.id and m.user_id = me) then
    raise exception 'join the scene first';
  end if;
  if exists (
    select 1 from pings p
    where p.from_id = me and p.scene_id = s.id and p.created_at > now() - interval '10 minutes'
  ) then
    return 0;
  end if;

  select name into me_name from profiles where id = me;
  msg := nullif(left(trim(coalesce(p_msg, '')), 120), '');
  if msg is null then
    msg := coalesce(me_name, 'someone') || ' ' || p_verb || ' at ' || s.display_name;
  end if;

  perform set_config('pingme.skip_rate_limit', '1', true);

  insert into pings (from_id, to_id, verb, msg, unread, scene_id)
  select me, m.user_id, p_verb, msg, true, s.id
  from scene_members m
  where m.scene_id = s.id
    and m.user_id <> me
    and m.notifications_enabled
  limit 500;
  get diagnostics sent = row_count;
  return sent;
end;
$$;

revoke all on function ping_scene(text, text, text) from public, anon;
grant  execute on function ping_scene(text, text, text) to authenticated;

-- ═══════════════════════════════════════════
-- RPC: approve_scene(slug) — admin only
-- ═══════════════════════════════════════════
-- Same rule as approve_school: a service_role JWT, or a session with no JWT
-- that connected as postgres/supabase_admin (dashboard SQL editor, Management
-- API). session_user, not current_user (the definer), is what to check.

create or replace function approve_scene(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (
    auth.role() = 'service_role'
    or (auth.role() is null and session_user in ('postgres', 'supabase_admin'))
  ) then
    raise exception 'approve_scene: admin only';
  end if;

  update scenes set pending = false, approved_at = coalesce(approved_at, now()) where slug = lower(trim(coalesce(p_slug, '')));
  if not found then raise exception 'unknown scene'; end if;
end;
$$;

revoke all on function approve_scene(text) from public, anon, authenticated;
grant  execute on function approve_scene(text) to service_role;

-- ═══════════════════════════════════════════
-- ALIASES — one release only (see header)
-- ═══════════════════════════════════════════
-- Signatures unchanged from 20260907 / 20260909 so `create or replace` is
-- enough and a mid-flight browser client never sees a 404/500.

create or replace function suggest_school(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  return create_scene(p_name);
end;
$$;

revoke all on function suggest_school(text) from public, anon;
grant  execute on function suggest_school(text) to authenticated;

create or replace function set_school(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me  uuid := auth.uid();
  cur text;
begin
  if me is null then return; end if;
  if p_slug is null or trim(p_slug) = '' then
    select school into cur from profiles where id = me;
    if cur is not null then perform leave_scene(cur); end if;
    return;
  end if;
  perform join_scene(p_slug);
  -- Old-client semantics: "set my school" makes that slug the current one even
  -- when the caller was already a member (join_scene alone keeps the latest join).
  update profiles set school = lower(trim(p_slug)) where id = me;
end;
$$;

revoke all on function set_school(text) from public, anon;
grant  execute on function set_school(text) to authenticated;

create or replace function approve_school(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform approve_scene(p_slug);
  update schools set pending = false where slug = lower(trim(coalesce(p_slug, '')));
end;
$$;

revoke all on function approve_school(text) from public, anon, authenticated;
grant  execute on function approve_school(text) to service_role;
