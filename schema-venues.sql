-- pingme — generalized venues migration
-- Run AFTER schema.sql and schema-matches.sql. Safe to re-run (idempotent).
-- Generalizes the venues table from "TTU-only" to "any place with a ping pong table"
-- across public spots, businesses, and private spaces.

-- ═══════════════════════════════════════════
-- VENUES: type, geo, attribution
-- ═══════════════════════════════════════════

alter table venues add column if not exists type text
  not null default 'public'
  check (type in ('public', 'business', 'private'));
alter table venues add column if not exists city text;
alter table venues add column if not exists lat double precision;
alter table venues add column if not exists lng double precision;
alter table venues add column if not exists added_by uuid references profiles(id) on delete set null;
alter table venues add column if not exists verified boolean not null default false;
alter table venues add column if not exists play_count int not null default 0;
alter table venues add column if not exists created_at timestamptz default now();

create index if not exists idx_venues_type on venues(type);
create index if not exists idx_venues_city on venues(city);
create index if not exists idx_venues_play_count on venues(play_count desc);

-- ═══════════════════════════════════════════
-- RLS: anyone signed in can add a venue
-- ═══════════════════════════════════════════

drop policy if exists "Authenticated users can add venues" on venues;
create policy "Authenticated users can add venues"
  on venues for insert with check (auth.uid() is not null and added_by = auth.uid());

drop policy if exists "Adder can edit own venue" on venues;
create policy "Adder can edit own venue"
  on venues for update using (added_by = auth.uid());

-- ═══════════════════════════════════════════
-- TTU seed cleanup — strip campus-specific defaults so the venue list starts open.
-- Keeps any user-added rows intact; only removes the original three seed rows that
-- have no added_by (they were inserted by schema.sql before this migration existed).
-- ═══════════════════════════════════════════

delete from venues
where added_by is null
  and name in ('The Sub', 'Rec Center', 'Maggie Trejo');

-- ═══════════════════════════════════════════
-- RPC: add a venue and return it
-- ═══════════════════════════════════════════

create or replace function add_venue(
  p_name text,
  p_type text,
  p_city text default null,
  p_location text default null,
  p_lat double precision default null,
  p_lng double precision default null
) returns venues
language plpgsql
security definer
set search_path = public
as $$
declare
  v venues%rowtype;
begin
  if auth.uid() is null then
    raise exception 'sign in to add a venue';
  end if;
  if p_name is null or char_length(trim(p_name)) < 2 then
    raise exception 'venue name too short';
  end if;
  if p_type not in ('public', 'business', 'private') then
    raise exception 'invalid venue type';
  end if;

  insert into venues (name, type, city, location, lat, lng, added_by)
  values (trim(p_name), p_type, nullif(trim(coalesce(p_city, '')), ''),
          nullif(trim(coalesce(p_location, '')), ''),
          p_lat, p_lng, auth.uid())
  returning * into v;

  return v;
end;
$$;

revoke all on function add_venue(text, text, text, text, double precision, double precision) from public, anon;
grant  execute on function add_venue(text, text, text, text, double precision, double precision) to authenticated;

-- Bump play_count whenever someone reports playing at a venue (called from app on status='playing')
create or replace function bump_venue_play(p_venue uuid)
returns void
language plpgsql
security definer
as $$
begin
  update venues set play_count = play_count + 1 where id = p_venue;
end;
$$;

grant execute on function bump_venue_play(uuid) to authenticated;
