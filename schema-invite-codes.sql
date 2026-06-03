-- pingme — per-player invite codes
-- Run AFTER schema-matches.sql. Idempotent.
--
-- Goal: every player gets 3 single-use invite codes auto-issued on first call.
-- The master code (PINGME) stays as the public bootstrap. Ez can rotate / add
-- new master codes by inserting rows manually.
--
-- When someone redeems a player's code, that player's referral_count is bumped
-- so the existing leaderboard "invites" tab reflects it.

-- ═══════════════════════════════════════════
-- Helpers
-- ═══════════════════════════════════════════

create or replace function _pm_random_code(p_len int default 6)
returns text
language plpgsql
as $$
declare
  -- No I/O/0/1 to avoid scan confusion
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out text := '';
  i int;
begin
  for i in 1..p_len loop
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return out;
end;
$$;

-- ═══════════════════════════════════════════
-- Issue codes for the caller
-- ═══════════════════════════════════════════
-- Returns the user's full code set (existing + newly minted) so the client can
-- render them immediately. Idempotent: only mints up to p_total codes total.

create or replace function issue_my_invite_codes(p_total int default 3)
returns table(code text, use_count int, max_uses int)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  existing int;
  need int;
  fresh text;
  tries int;
begin
  if me is null then return; end if;

  select count(*) into existing from access_codes where created_by = me;
  need := greatest(0, p_total - existing);

  while need > 0 loop
    tries := 0;
    loop
      fresh := _pm_random_code(6);
      begin
        insert into access_codes (code, created_by, note, max_uses)
          values (fresh, me, 'player-issued', 1);
        exit;
      exception when unique_violation then
        tries := tries + 1;
        if tries > 8 then exit; end if;
      end;
    end loop;
    need := need - 1;
  end loop;

  return query
    select c.code, c.use_count, c.max_uses
      from access_codes c
     where c.created_by = me
     order by c.created_at asc;
end;
$$;

revoke all on function issue_my_invite_codes(int) from public, anon;
grant  execute on function issue_my_invite_codes(int) to authenticated;

-- ═══════════════════════════════════════════
-- claim_access_code: bump referrer's count
-- ═══════════════════════════════════════════
-- Replaces the original (schema-matches.sql) to credit the code's owner with a
-- referral when it gets redeemed. Master codes (created_by null, e.g. PINGME)
-- don't credit anyone.

create or replace function claim_access_code(p_code text, p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c access_codes%rowtype;
begin
  select * into c from access_codes where code = upper(p_code);
  if not found then return false; end if;
  if c.expires_at is not null and c.expires_at < now() then return false; end if;
  if c.use_count >= c.max_uses then return false; end if;
  if c.created_by is not null and c.created_by = p_user then return false; end if;

  insert into access_code_uses (code, user_id) values (c.code, p_user)
    on conflict do nothing;

  update access_codes set use_count = use_count + 1 where code = c.code;
  update profiles set invited_via = 'code:' || c.code, referred_by = c.created_by
    where id = p_user and invited_via is null;

  if c.created_by is not null then
    update profiles
       set referral_count = coalesce(referral_count, 0) + 1,
           updated_at = now()
     where id = c.created_by;
  end if;

  return true;
end;
$$;

-- Allow players to read their own access_codes rows (for the profile sheet)
drop policy if exists "Users can read their own codes" on access_codes;
create policy "Users can read their own codes"
  on access_codes for select
  using (created_by = auth.uid() or created_by is null);
