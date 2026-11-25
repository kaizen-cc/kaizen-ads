-- Every sample insert failed: the trim trigger named its subquery "old", which clashes with the trigger's OLD record
-- ("column reference old.id is ambiguous"), so agent tests had no real calls to replay. Renamed.
create or replace function public.trim_agent_samples() returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.agent_samples s using (
    select id from (select id, row_number() over (order by created_at desc) rn from public.agent_samples where agent_key = new.agent_key and moment = new.moment) x where x.rn > 30
  ) stale where s.id = stale.id;
  return null;
end $$;
