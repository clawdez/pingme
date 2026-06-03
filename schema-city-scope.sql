-- pingme — city scoping migration
-- Run AFTER schema.sql, schema-matches.sql, schema-venues.sql. Idempotent.
-- Goal: Lubbock users don't get pinged by Austin users (and vice-versa) once
-- we start scaling outside the original campus seed.

-- ═══════════════════════════════════════════
-- PROFILES: home_city
-- ═══════════════════════════════════════════
-- A user's home_city is auto-set the first time they pick a venue with a city.
-- Empty/null = "no preference" → user sees everyone (legacy behavior, doesn't
-- break existing accounts).

alter table profiles add column if not exists home_city text;

create index if not exists idx_profiles_home_city on profiles(home_city);

-- Allow public read so other clients can scope their roster
grant select (home_city) on profiles to anon, authenticated;

-- ═══════════════════════════════════════════
-- RPC: set_home_city
-- ═══════════════════════════════════════════
-- Called from the client after a venue pick. Trims + lower-cases for stable
-- equality. Caller can only set their own row.

create or replace function set_home_city(p_city text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  update profiles
    set home_city = nullif(trim(lower(coalesce(p_city, ''))), '')
  where id = auth.uid();
end;
$$;

revoke all on function set_home_city(text) from public, anon;
grant  execute on function set_home_city(text) to authenticated;
