-- Enable pg_net for HTTP calls from triggers
create extension if not exists pg_net with schema extensions;

-- Trigger function: when a ping is inserted, call send-push edge function server-side
-- This ensures push notifications fire even when the sender's app is closed
create or replace function handle_ping_push()
returns trigger
language plpgsql
security definer
as $$
declare
  service_key text;
  project_url text := 'https://jjgamvhvdqqjcizvpowk.supabase.co';
begin
  -- Skip self-pings and system pings
  if NEW.to_id is null or NEW.to_id = NEW.from_id or NEW.verb = 'system' then
    return NEW;
  end if;

  -- Get the service role key from vault — MUST be configured
  service_key := current_setting('app.settings.service_role_key', true);
  if service_key is null or service_key = '' then
    raise warning 'app.settings.service_role_key not set — push notification skipped';
    return NEW;
  end if;

  -- Fire async HTTP POST to send-push edge function
  perform net.http_post(
    url := project_url || '/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'to_id', NEW.to_id,
        'from_id', NEW.from_id,
        'msg', NEW.msg,
        'verb', NEW.verb
      )
    )
  );

  return NEW;
end;
$$;

-- Drop old trigger if exists, create new one
drop trigger if exists on_ping_inserted on pings;
drop trigger if exists ping_push_trigger on pings;
create trigger ping_push_trigger
  after insert on pings
  for each row execute function handle_ping_push();
