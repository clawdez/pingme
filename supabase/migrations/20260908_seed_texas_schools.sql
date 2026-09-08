-- pingme — Texas launch cohort (university seed)
-- Run AFTER 20260907_friends_and_schools.sql (creates `schools`). Idempotent:
-- `on conflict (slug) do nothing`, safe to run twice. Reference data only —
-- no DDL. The ttu row is repeated so this file is standalone; it is a no-op
-- against the row seeded by 20260907.
--
-- Share link per campus: https://pingme.app/?school=<slug>

insert into schools (slug, display_name, color, default_city) values
  ('ttu',       'Texas Tech University',         '#CC0000', 'lubbock'),
  ('ut-austin', 'University of Texas at Austin', '#BF5700', 'austin'),
  ('texas-am',  'Texas A&M University',          '#500000', 'college station'),
  ('uh',        'University of Houston',         '#C8102E', 'houston'),
  ('baylor',    'Baylor University',             '#154734', 'waco')
on conflict (slug) do nothing;
