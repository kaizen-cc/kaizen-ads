-- Several agents on one call, working a job together.
-- 1. A call can have more than one specialist on the line (guest_roles, up to three), on a call with the assistant or
--    with an agent called directly. guest_role stays (the first one on the line) so older code keeps reading it.
-- 2. The job the agents are working on (job): what it is (launching ads, an email request, a creative brief, an
--    audit and sprint, a report), the client and platform, the steps done and left, what was made (copy, briefs,
--    tickets, launches, reports, with their ids) and short decision notes by agent. Every agent on the call reads it.
-- No new policies: the call's row is already the caller's own (ai_role_calls' existing policies), and the server
-- writes these columns with the service key.

alter table public.ai_role_calls
  add column if not exists guest_roles text[] not null default '{}',
  add column if not exists job jsonb;

-- The one specialist kept before there could be several
update public.ai_role_calls set guest_roles = array[guest_role] where guest_role is not null and guest_roles = '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_role_calls_guest_roles_few') then
    alter table public.ai_role_calls add constraint ai_role_calls_guest_roles_few check (coalesce(array_length(guest_roles, 1), 0) <= 3);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_role_calls_job_is_object') then
    alter table public.ai_role_calls add constraint ai_role_calls_job_is_object check (job is null or (jsonb_typeof(job) = 'object' and pg_column_size(job) <= 65536));
  end if;
end $$;
