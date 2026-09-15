-- Email-required signup (2026-09-10): a profile inserted by an email-confirmed
-- auth user is born with email_verified = true.
--
-- Why: signup-verify (send-email edge function) confirms the auth email and
-- mints the session *before* the profile row exists (the name step creates it),
-- so its `update profiles set email_verified = true` is a no-op for brand-new
-- accounts. Deriving the flag from auth.users at insert time closes that gap
-- and also stops a client from self-flagging on insert (the value the client
-- sends is ignored). Insert-only on purpose: the link-email and sign-in paths
-- keep setting the flag by explicit update from the service role.
--
-- Reversible: drop trigger profiles_email_verified_from_auth on profiles;
--             drop function public.profiles_email_verified_from_auth();
-- No data is rewritten; existing rows are untouched.

create or replace function public.profiles_email_verified_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.email_verified := exists (
    select 1 from auth.users u
    where u.id = new.id
      and u.email_confirmed_at is not null
  );
  return new;
end;
$$;

drop trigger if exists profiles_email_verified_from_auth on profiles;
create trigger profiles_email_verified_from_auth
  before insert on profiles
  for each row execute function public.profiles_email_verified_from_auth();
