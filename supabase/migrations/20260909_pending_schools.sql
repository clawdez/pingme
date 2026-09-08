-- pingme — "Other → type your school": user-suggested schools + approval
-- Run AFTER 20260907_friends_and_schools.sql and 20260908_seed_texas_schools.sql.
-- Idempotent: every statement is if-not-exists / create-or-replace /
-- drop-if-exists / on-conflict, safe to re-run on a DB where it already applied.
--
-- 1) schools.pending — rows users type in start pending=true; the seeded
--    launch cohort stays approved (default false). Pending rows are hidden
--    from everyone except the users grouped under them, so two people typing
--    the same school are already in the same cohort before approval.
-- 2) school_suggestions — audit + rate-limit log (3 per user per 24h).
-- 3) suggest_school(name) — authenticated RPC: normalise → slug, insert a
--    pending row (or join the existing slug), assign the caller, return slug.
-- 4) approve_school(slug) — admin knob. Works with a service_role JWT or from
--    the dashboard SQL editor / Management API (postgres session, no JWT).
--
--    Queue:    select slug, display_name, created_at from schools where pending order by created_at desc;
--    Approve:  select approve_school('<slug>');

-- ═══════════════════════════════════════════
-- SCHOOLS: pending flag + scoped read policy
-- ═══════════════════════════════════════════

alter table schools add column if not exists pending boolean not null default false;

-- Table-level select was granted in 20260907 (covers new columns); the
-- column grant makes the intent explicit.
grant select (pending) on schools to anon, authenticated;

-- Everyone reads approved rows. A pending row is readable only by users whose
-- profile already points at it (the submitter and anyone who typed the same
-- school). profiles.school is client-readable, so the subquery is fine under
-- the caller's role.
drop policy if exists "Anyone can view schools" on schools;
create policy "Anyone can view schools"
  on schools for select
  using (
    pending = false
    or slug = (select p.school from profiles p where p.id = auth.uid())
  );

-- ═══════════════════════════════════════════
-- SUGGESTION LOG (rate limit + audit)
-- ═══════════════════════════════════════════

create table if not exists school_suggestions (
  user_id    uuid not null references profiles(id) on delete cascade,
  slug       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_school_suggestions_user_time on school_suggestions(user_id, created_at desc);

alter table school_suggestions enable row level security;

-- Written only by suggest_school (security definer). Nobody but the service
-- role reads it; no policies on purpose.
revoke all on school_suggestions from anon, authenticated, public;
grant select on school_suggestions to service_role;

-- ═══════════════════════════════════════════
-- RPC: suggest_school(name) → slug
-- ═══════════════════════════════════════════
-- Name: trimmed, whitespace collapsed, casing kept for display (2–80 chars).
-- Slug: lower-cased, [a-z0-9] kept, runs of anything else → '-', outer dashes
-- stripped, capped to the 32 chars schools.slug allows (long official names
-- like "University of Texas at San Antonio" must still work). The slug is the
-- join key: a second user typing the same school lands on the same row.
create or replace function suggest_school(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me       uuid := auth.uid();
  name_in  text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  slug_out text;
  recent   int;
begin
  if me is null then raise exception 'sign in first'; end if;
  if char_length(name_in) not between 2 and 80 then
    raise exception 'school name must be 2-80 characters';
  end if;

  slug_out := btrim(regexp_replace(lower(name_in), '[^a-z0-9]+', '-', 'g'), '-');
  slug_out := btrim(left(slug_out, 32), '-');
  if slug_out !~ '^[a-z0-9-]{2,32}$' then raise exception 'invalid school name'; end if;
  if slug_out in ('other', 'none', 'admin', 'test') then raise exception 'invalid school name'; end if;

  select count(*) into recent
  from school_suggestions
  where user_id = me and created_at > now() - interval '24 hours';
  if recent >= 3 then raise exception 'rate limit exceeded - try again tomorrow'; end if;

  -- New school → pending. Existing slug (approved or pending) → just join it.
  insert into schools (slug, display_name, pending)
  values (slug_out, name_in, true)
  on conflict (slug) do nothing;

  insert into school_suggestions (user_id, slug) values (me, slug_out);

  -- Pending rows have no default_city, so there is nothing to backfill.
  update profiles
    set school = slug_out
  where id = me;

  return slug_out;
end;
$$;

revoke all on function suggest_school(text) from public, anon;
grant  execute on function suggest_school(text) to authenticated;

-- ═══════════════════════════════════════════
-- RPC: approve_school(slug) — admin only
-- ═══════════════════════════════════════════
-- Allowed callers: a service_role JWT (PostgREST), or a session with no JWT
-- at all that connected as postgres/supabase_admin (dashboard SQL editor,
-- Management API). Inside a security-definer body the effective user is the
-- owner, so the connection role is checked via session_user. Any other JWT
-- role (authenticated, anon) is refused even though execute is also revoked.
create or replace function approve_school(p_slug text)
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
    raise exception 'approve_school: admin only';
  end if;

  update schools set pending = false where slug = lower(trim(coalesce(p_slug, '')));
  if not found then raise exception 'unknown school'; end if;
end;
$$;

revoke all on function approve_school(text) from public, anon, authenticated;
grant  execute on function approve_school(text) to service_role;
