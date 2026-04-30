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
  name text not null check (char_length(name) >= 1 and char_length(name) <= 30),
  color text not null default '#E8502A',
  status text not null default 'off' check (status in ('off', 'down', 'playing')),
  venue text,
  duration int check (duration is null or duration > 0),  -- minutes (for 'down' status)
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

-- Messages: 1:1 chat between users
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  sender_id uuid not null references profiles(id) on delete cascade,
  receiver_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) >= 1 and char_length(body) <= 200),
  created_at timestamptz default now()
);

-- Email OTPs: verification codes for email linking + sign-in
create table if not exists email_otps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  code text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
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
create index if not exists idx_messages_room on messages(room_id, created_at desc);
create index if not exists idx_email_otps_user on email_otps(user_id);
create index if not exists idx_pings_from_created on pings(from_id, created_at desc);

-- ═══════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════

alter table profiles enable row level security;
alter table pings enable row level security;
alter table push_subscriptions enable row level security;
alter table messages enable row level security;
alter table email_otps enable row level security;
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

-- Messages: users can read their own conversations, send as self
create policy "Users can read own messages"
  on messages for select using (
    sender_id = auth.uid() or receiver_id = auth.uid()
  );
create policy "Users can send messages as self"
  on messages for insert with check (auth.uid() = sender_id);

-- Email OTPs: service role only (edge functions use service key)
-- No user-facing policies needed — edge functions use service role

-- Venues: public read
create policy "Anyone can view venues"
  on venues for select using (true);

-- ═══════════════════════════════════════════
-- REALTIME
-- ═══════════════════════════════════════════

alter publication supabase_realtime add table profiles;
alter publication supabase_realtime add table pings;
alter publication supabase_realtime add table messages;

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

-- Rate-limit pings: max 5 pings per user per 60 seconds (DB-enforced)
create or replace function check_ping_rate_limit()
returns trigger
language plpgsql
security definer
as $$
declare
  recent_count int;
begin
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

drop trigger if exists ping_rate_limit on pings;
create trigger ping_rate_limit
  before insert on pings
  for each row execute function check_ping_rate_limit();

-- Auto-send push notification when a ping is inserted (server-side, works when app is closed)
-- This replaces client-side push — the DB triggers it so notifications arrive even if sender closes the app
create or replace function notify_ping_inserted()
returns trigger
language plpgsql
security definer
as $$
declare
  sub_record record;
  sender_name text;
  payload text;
begin
  -- Skip broadcast pings (to_id is null) and self-pings
  if NEW.to_id is null or NEW.to_id = NEW.from_id then
    return NEW;
  end if;

  -- Get push subscription for recipient
  select * into sub_record from push_subscriptions where user_id = NEW.to_id;
  if not found then
    return NEW;
  end if;

  -- Get sender name
  select name into sender_name from profiles where id = NEW.from_id;

  -- Call the send-push edge function via pg_net (if available) or just let the webhook handle it
  -- For now, rely on Supabase Database Webhooks configured in the dashboard
  -- pointing to: /functions/v1/send-push
  return NEW;
end;
$$;

drop trigger if exists on_ping_inserted on pings;
create trigger on_ping_inserted
  after insert on pings
  for each row execute function notify_ping_inserted();

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
  ('Maggie Trejo', 'Supercenter')
on conflict do nothing;
