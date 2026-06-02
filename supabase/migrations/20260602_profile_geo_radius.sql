-- pingme — per-profile location + notify radius (city-scoped pings)
-- Lets push notifications skip users far from the playing venue.

alter table profiles add column if not exists last_lat double precision;
alter table profiles add column if not exists last_lng double precision;
alter table profiles add column if not exists last_loc_at timestamptz;
alter table profiles add column if not exists notify_radius_km integer
  not null default 80; -- ~50 mi default; 0 = global, NULL treated as default
