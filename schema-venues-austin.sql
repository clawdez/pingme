-- pingme — Austin venue seed (Ez's GTM kickoff)
-- Run in Supabase SQL Editor. Idempotent — re-running won't dup rows.
-- These are inserted with added_by = null so they show as "official" seeds
-- and don't count against any user's contribution. Mark verified = true so
-- they float to the top of the picker.

insert into venues (name, type, city, location, lat, lng, verified)
select * from (values
  ('UT Union Underground',        'public',   'Austin', '2247 Guadalupe St',         30.2862, -97.7411, true),
  ('Gregory Gym',                 'public',   'Austin', 'UT campus',                 30.2849, -97.7363, true),
  ('Buford''s Beer Garden',       'business', 'Austin', '2009 E Cesar Chavez',       30.2575, -97.7196, true),
  ('Easy Tiger (East 6th)',       'business', 'Austin', '1501 E 7th St',             30.2647, -97.7281, true),
  ('Hopfields',                   'business', 'Austin', '3110 Guadalupe St',         30.2962, -97.7415, true),
  ('Kinda Tropical',              'business', 'Austin', '3501 E 7th St',             30.2625, -97.7050, true),
  ('Cosmic Coffee + Beer Garden', 'business', 'Austin', '121 Pickle Rd',             30.2237, -97.7787, true),
  ('Lala''s Little Nugget',       'business', 'Austin', '2207 Justin Ln',            30.3266, -97.7297, true),
  ('Domain NORTHSIDE Lawn',       'public',   'Austin', '11506 Century Oaks Ter',    30.4017, -97.7253, true),
  ('Zilker Park Pavilion',        'public',   'Austin', '2207 Lou Neff Rd',          30.2669, -97.7729, true)
) as v(name, type, city, location, lat, lng, verified)
where not exists (
  select 1 from venues
  where lower(venues.name) = lower(v.name)
    and lower(coalesce(venues.city, '')) = lower(v.city)
);
