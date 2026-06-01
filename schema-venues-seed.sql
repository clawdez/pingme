-- pingme — verified venue seeds
-- Run AFTER schema-venues.sql. Safe to re-run (idempotent on name+city).

insert into venues (name, type, city, location, lat, lng, verified, play_count)
select * from (values
  -- ── Lubbock (TTU) ──
  ('The SUB',             'public',   'Lubbock', 'TTU Student Union Building',      33.5839, -101.8743, true, 0),
  ('TTU Rec Center',      'public',   'Lubbock', 'Texas Tech Rec Center',           33.5854, -101.8847, true, 0),
  ('Maggie Trejo',        'public',   'Lubbock', 'Maggie Trejo Supercenter',        33.5778, -101.8612, true, 0),

  -- ── Austin ──
  ('Pinballz Lake Creek', 'business', 'Austin',  '13729 Research Blvd',             30.4565, -97.7975, true, 0),
  ('Punch Bowl Social',   'business', 'Austin',  '11310 Domain Dr',                 30.4011, -97.7257, true, 0),
  ('Zilker Park',         'public',   'Austin',  '2207 Lou Neff Rd',                30.2669, -97.7729, true, 0),
  ('Austin Rec Center',   'public',   'Austin',  '1301 Shoal Creek Blvd',           30.2769, -97.7475, true, 0)
) as s(name, type, city, location, lat, lng, verified, play_count)
where not exists (
  select 1 from venues v
  where lower(v.name) = lower(s.name) and lower(coalesce(v.city,'')) = lower(coalesce(s.city,''))
);
