create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  skill int default 3 check (skill between 1 and 5),
  created_at timestamptz default now()
);

create table if not exists venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location text
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  user_name text not null,
  skill int default 3,
  venue_id uuid references venues(id),
  venue_name text,
  status text default 'waiting',
  expires_at timestamptz default now() + interval '60 minutes',
  created_at timestamptz default now()
);

-- Enable realtime on sessions
alter publication supabase_realtime add table sessions;

-- Seed venues
insert into venues (name, location) values
  ('Student Center - Ping Pong Room', 'TTU Student Union'),
  ('Rec Center', 'TTU Recreation Center'),
  ('Library 2nd Floor', 'TTU Library')
on conflict do nothing;
