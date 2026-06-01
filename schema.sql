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
  phone text check (phone is null or char_length(phone) >= 10),
  color text not null default '#E8502A',
  status text not null default 'off' check (status in ('off', 'down', 'playing')),
  venue text,
  duration int check (duration is null or duration > 0),  -- minutes (for 'down' status)
  started_at timestamptz,    -- when user went down/playing
  ambient text,              -- flavor text ("played 3x this week")
  referred_by uuid references profiles(id) on delete set null,
  referral_count int not null default 0,
  play_count int not null default 0,
  -- #10: gate leaderboard / future trusted actions to email-linked accounts
  email_verified boolean not null default false,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Backfill column for existing deployments (idempotent)
alter table profiles add column if not exists email_verified boolean not null default false;

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

-- #4: in-app DMs were removed from MVP — SMS deep-links from the player sheet
-- replace them. The table is dropped here to shrink the attack surface (RLS no
-- longer matters if there's nothing to read). If we ever ship DMs again it will
-- live on the `dev` branch behind a feature flag, not in this schema.
drop table if exists messages cascade;

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
create index if not exists idx_email_otps_user on email_otps(user_id);
create index if not exists idx_pings_from_created on pings(from_id, created_at desc);

-- ═══════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════

alter table profiles enable row level security;
alter table pings enable row level security;
alter table push_subscriptions enable row level security;
alter table email_otps enable row level security;
alter table venues enable row level security;

-- #1: phone is no longer world-readable. Revoke direct column access for anon/authenticated;
-- clients must call get_player_contact() RPC (security definer, rate-limited by Supabase).
revoke select (phone) on profiles from anon, authenticated;
grant  select (
  id, name, color, status, venue, duration, started_at, ambient,
  referred_by, referral_count, play_count, email_verified, updated_at, created_at
) on profiles to anon, authenticated;

-- Profiles: anyone can read the public columns, users manage their own
create policy "Anyone can view profiles"
  on profiles for select using (true);
create policy "Users can create own profile"
  on profiles for insert with check (auth.uid() = id);
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);
create policy "Users can delete own profile"
  on profiles for delete using (auth.uid() = id);

-- Pings: users can read own + broadcasts, send as self, update own received
create policy "Users can read own pings and broadcasts"
  on pings for select using (
    to_id = auth.uid() or to_id is null or from_id = auth.uid()
  );
-- #9: clients must not be able to insert verb='system' — those are server-only notices
-- (e.g. the email-link nudge). Without this gate, any anon user could spoof a system ping.
create policy "Authenticated users can send pings"
  on pings for insert with check (
    auth.uid() = from_id and (verb is null or verb <> 'system')
  );
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

-- (messages table dropped — see #4 above)

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

create or replace function increment_play_count(player_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  update profiles set play_count = play_count + 1
  where id = player_id;
end;
$$;

-- #1: contact lookup RPC. Phone is no longer in the world-readable SELECT —
-- clients call this to get a single target's phone for the SMS deep link.
-- Anonymous callers get null; authenticated callers get the phone if it's set.
create or replace function get_player_contact(target_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  result text;
begin
  if auth.uid() is null then
    return null;
  end if;
  select phone into result from profiles where id = target_id;
  return result;
end;
$$;

revoke all on function get_player_contact(uuid) from public, anon;
grant  execute on function get_player_contact(uuid) to authenticated;

-- ═══════════════════════════════════════════
-- SCHEDULED JOBS (#2: auto-schedule via pg_cron — falls back to a no-op if extension missing)
-- ═══════════════════════════════════════════
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- Unschedule the same job name first so re-running this file is safe
    begin
      perform cron.unschedule('expire-stale-profiles');
    exception when others then null;
    end;
    perform cron.schedule('expire-stale-profiles', '*/2 * * * *', $job$select expire_stale_profiles()$job$);
  else
    raise notice 'pg_cron not available — enable it in Dashboard > Database > Extensions, then re-run this file';
  end if;
end $$;

-- ═══════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════

insert into venues (name, location) values
  ('The Sub', 'TTU Student Union'),
  ('Rec Center', 'TTU Recreation Center'),
  ('Maggie Trejo', 'Supercenter')
on conflict do nothing;
