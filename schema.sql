-- pingme production schema — run in Supabase SQL Editor
-- Prerequisites:
--   1. Enable "Anonymous Sign-Ins" in Auth > Providers
--   2. Enable "Google" OAuth in Auth > Providers (optional)
--   3. Run this entire file in SQL Editor

-- ═══════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════

-- Profiles: one row per user, includes presence status
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  color text not null default '#E8502A',
  status text not null default 'off' check (status in ('off', 'down', 'playing')),
  venue text,
  duration int,              -- minutes (for 'down' status)
  started_at timestamptz,    -- when user went down/playing
  ambient text,              -- flavor text ("played 3x this week")
  referred_by uuid references profiles(id) on delete set null,
  referral_count int not null default 0,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Pings: notifications between users
create table if not exists pings (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references profiles(id) on delete cascade,
  to_id uuid references profiles(id) on delete cascade, -- null = broadcast
  verb text,                -- "is playing at the sub", "is down to play"
  msg text,                 -- free text message
  unread boolean default true,
  action_taken text,        -- "on my way", "maybe", etc.
  created_at timestamptz default now()
);

-- Push subscriptions: one per user for Web Push notifications
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  endpoint text not null,
  keys_p256dh text not null,
  keys_auth text not null,
  created_at timestamptz default now(),
  unique(user_id)
);

-- Venues (reference data)
create table if not exists venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location text
);

-- ═══════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════

create index if not exists idx_profiles_status on profiles(status);
create index if not exists idx_profiles_updated on profiles(updated_at desc);
create index if not exists idx_pings_to_id on pings(to_id);
create index if not exists idx_pings_created on pings(created_at desc);
create index if not exists idx_push_subs_user on push_subscriptions(user_id);

-- ═══════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════

alter table profiles enable row level security;
alter table pings enable row level security;
alter table push_subscriptions enable row level security;
alter table venues enable row level security;

-- Profiles: anyone can read, users manage their own
create policy "Anyone can view profiles"
  on profiles for select using (true);
create policy "Users can create own profile"
  on profiles for insert with check (auth.uid() = id);
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

-- Pings: users can read own + broadcasts, send as self, update own received
create policy "Users can read own pings and broadcasts"
  on pings for select using (
    to_id = auth.uid() or to_id is null or from_id = auth.uid()
  );
create policy "Authenticated users can send pings"
  on pings for insert with check (auth.uid() = from_id);
create policy "Users can update own received pings"
  on pings for update using (to_id = auth.uid());

-- Push subscriptions: users manage their own
create policy "Users can view own push subscription"
  on push_subscriptions for select using (auth.uid() = user_id);
create policy "Users can insert own push subscription"
  on push_subscriptions for insert with check (auth.uid() = user_id);
create policy "Users can update own push subscription"
  on push_subscriptions for update using (auth.uid() = user_id);
create policy "Users can delete own push subscription"
  on push_subscriptions for delete using (auth.uid() = user_id);

-- Venues: public read
create policy "Anyone can view venues"
  on venues for select using (true);

-- ═══════════════════════════════════════════
-- REALTIME
-- ═══════════════════════════════════════════

alter publication supabase_realtime add table profiles;
alter publication supabase_realtime add table pings;

-- ═══════════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════════

-- Auto-expire stale sessions (down users past duration, playing users past 90 min)
create or replace function expire_stale_profiles()
returns void
language plpgsql
security definer
as $$
begin
  -- Expire 'down' users whose duration has elapsed
  update profiles
  set status = 'off', venue = null, duration = null, started_at = null,
      updated_at = now()
  where status = 'down'
    and started_at is not null
    and duration is not null
    and started_at + (duration || ' minutes')::interval < now();

  -- Expire 'playing' users after 90 minutes
  update profiles
  set status = 'off', venue = null, duration = null, started_at = null,
      updated_at = now()
  where status = 'playing'
    and started_at is not null
    and started_at + interval '90 minutes' < now();
end;
$$;

-- Increment referral count atomically
create or replace function increment_referral(referrer_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  update profiles set referral_count = referral_count + 1
  where id = referrer_id;
end;
$$;

-- ═══════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════

insert into venues (name, location) values
  ('The Sub', 'TTU Student Union'),
  ('Rec Center', 'TTU Recreation Center'),
  ('Library 2nd Floor', 'TTU Library')
on conflict do nothing;
