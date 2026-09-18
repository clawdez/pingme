-- email_otps: custom 6-digit OTP storage for email verification.
-- Used by the send-email Edge Function (Resend). Exists in the live DB
-- but was never captured as a migration — a db reset would break all login.

create table if not exists public.email_otps (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  code text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.email_otps enable row level security;

-- Only the service role (edge functions) should read/write OTPs.
-- No anon or authenticated access.
revoke all on public.email_otps from anon, authenticated;
grant select, insert, update, delete on public.email_otps to service_role;
