-- pingme — matches, ELO, access codes migration
-- Run AFTER schema.sql. Safe to re-run (idempotent).

-- ═══════════════════════════════════════════
-- PROFILES: add ELO + W/L + access code linkage
-- ═══════════════════════════════════════════

alter table profiles add column if not exists elo int not null default 1200;
alter table profiles add column if not exists wins int not null default 0;
alter table profiles add column if not exists losses int not null default 0;
alter table profiles add column if not exists invited_via text;  -- 'code:XXXX' or 'ref:<uuid>' or 'open'

create index if not exists idx_profiles_elo on profiles(elo desc);

-- ═══════════════════════════════════════════
-- MATCHES
-- ═══════════════════════════════════════════

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  venue text,
  p1_id uuid not null references profiles(id) on delete cascade,
  p2_id uuid not null references profiles(id) on delete cascade,
  p1_score int not null default 0 check (p1_score >= 0 and p1_score <= 50),
  p2_score int not null default 0 check (p2_score >= 0 and p2_score <= 50),
  winner_id uuid references profiles(id) on delete set null,
  status text not null default 'live' check (status in ('live', 'done', 'abandoned')),
  p1_elo_before int,
  p2_elo_before int,
  p1_elo_after int,
  p2_elo_after int,
  scoring_mode text default 'tap' check (scoring_mode in ('tap', 'voice', 'mixed')),
  started_at timestamptz default now(),
  ended_at timestamptz,
  created_at timestamptz default now(),
  check (p1_id <> p2_id)
);

create index if not exists idx_matches_p1 on matches(p1_id, created_at desc);
create index if not exists idx_matches_p2 on matches(p2_id, created_at desc);
create index if not exists idx_matches_live on matches(status) where status = 'live';

-- ═══════════════════════════════════════════
-- ACCESS CODES
-- ═══════════════════════════════════════════

create table if not exists access_codes (
  code text primary key check (char_length(code) between 4 and 16),
  created_by uuid references profiles(id) on delete set null,
  note text,
  max_uses int not null default 1 check (max_uses > 0),
  use_count int not null default 0,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists access_code_uses (
  id uuid primary key default gen_random_uuid(),
  code text not null references access_codes(code) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  used_at timestamptz default now(),
  unique(code, user_id)
);

create index if not exists idx_access_uses_user on access_code_uses(user_id);

-- ═══════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════

alter table matches enable row level security;
alter table access_codes enable row level security;
alter table access_code_uses enable row level security;

drop policy if exists "Anyone can view matches" on matches;
create policy "Anyone can view matches"
  on matches for select using (true);

drop policy if exists "Participants can create matches" on matches;
create policy "Participants can create matches"
  on matches for insert with check (auth.uid() = p1_id or auth.uid() = p2_id);

drop policy if exists "Participants can update matches" on matches;
create policy "Participants can update matches"
  on matches for update using (auth.uid() = p1_id or auth.uid() = p2_id);

drop policy if exists "Anyone can verify a code" on access_codes;
create policy "Anyone can verify a code"
  on access_codes for select using (true);

drop policy if exists "Users can create access codes" on access_codes;
create policy "Users can create access codes"
  on access_codes for insert with check (auth.uid() = created_by);

drop policy if exists "Users can see their own redemption" on access_code_uses;
create policy "Users can see their own redemption"
  on access_code_uses for select using (auth.uid() = user_id);

-- ═══════════════════════════════════════════
-- REALTIME
-- ═══════════════════════════════════════════

alter publication supabase_realtime add table matches;

-- ═══════════════════════════════════════════
-- ELO + MATCH FINALIZATION
-- ═══════════════════════════════════════════

-- Standard ELO: K=32, expected = 1 / (1 + 10^((Rb - Ra)/400))
create or replace function finalize_match(match_id uuid)
returns matches
language plpgsql
security definer
as $$
declare
  m matches%rowtype;
  p1 profiles%rowtype;
  p2 profiles%rowtype;
  exp1 float;
  exp2 float;
  s1 float;
  s2 float;
  k int := 32;
  new_e1 int;
  new_e2 int;
  win_id uuid;
begin
  select * into m from matches where id = match_id;
  if not found then raise exception 'match not found'; end if;
  if m.status = 'done' then return m; end if;
  if m.p1_score = m.p2_score then
    raise exception 'cannot finalize a tied match';
  end if;

  select * into p1 from profiles where id = m.p1_id;
  select * into p2 from profiles where id = m.p2_id;

  exp1 := 1.0 / (1.0 + power(10.0, (p2.elo - p1.elo)::float / 400.0));
  exp2 := 1.0 - exp1;

  if m.p1_score > m.p2_score then
    s1 := 1; s2 := 0; win_id := m.p1_id;
  else
    s1 := 0; s2 := 1; win_id := m.p2_id;
  end if;

  new_e1 := round(p1.elo + k * (s1 - exp1));
  new_e2 := round(p2.elo + k * (s2 - exp2));

  update profiles set
    elo = new_e1,
    wins = wins + (case when win_id = m.p1_id then 1 else 0 end),
    losses = losses + (case when win_id = m.p1_id then 0 else 1 end),
    play_count = play_count + 1,
    updated_at = now()
  where id = m.p1_id;

  update profiles set
    elo = new_e2,
    wins = wins + (case when win_id = m.p2_id then 1 else 0 end),
    losses = losses + (case when win_id = m.p2_id then 0 else 1 end),
    play_count = play_count + 1,
    updated_at = now()
  where id = m.p2_id;

  update matches set
    status = 'done',
    winner_id = win_id,
    p1_elo_before = p1.elo,
    p2_elo_before = p2.elo,
    p1_elo_after = new_e1,
    p2_elo_after = new_e2,
    ended_at = now()
  where id = match_id
  returning * into m;

  return m;
end;
$$;

-- ═══════════════════════════════════════════
-- ACCESS CODE REDEMPTION
-- ═══════════════════════════════════════════

create or replace function claim_access_code(p_code text, p_user uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  c access_codes%rowtype;
begin
  select * into c from access_codes where code = upper(p_code);
  if not found then return false; end if;
  if c.expires_at is not null and c.expires_at < now() then return false; end if;
  if c.use_count >= c.max_uses then return false; end if;

  insert into access_code_uses (code, user_id) values (c.code, p_user)
    on conflict do nothing;

  update access_codes set use_count = use_count + 1 where code = c.code;
  update profiles set invited_via = 'code:' || c.code where id = p_user;
  return true;
end;
$$;

-- Seed one open invite code for bootstrapping (use_count is 0 so it's fresh)
insert into access_codes (code, note, max_uses)
values ('PINGME', 'public bootstrap code', 999999)
on conflict do nothing;
