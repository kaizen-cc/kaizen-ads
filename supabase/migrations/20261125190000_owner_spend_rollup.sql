-- Settings › Calls & usage, Daily AI spend (the owner only, Nov 25 2026, docs/API-COST.md): every AI run by New York
-- day, agent, place in the app (the label with client names and ids taken out) and model, rolled up in the database so
-- the page and the hourly spend check never read a month of raw runs. Read through the server after the owner check.
create or replace function public.owner_spend_rollup(p_from timestamptz, p_to timestamptz)
returns table (day date, agent_key text, place text, model text, auto boolean, runs bigint, input bigint, output bigint, cache_w bigint, cache_r bigint, searches bigint)
language sql stable security definer set search_path = public as $$
  select (r.created_at at time zone 'America/New_York')::date,
         coalesce(r.agent_key, 'other'),
         left(regexp_replace(
           regexp_replace(coalesce(r.label, ''), '^(audit|sprint check|brand bible research|brand bible|gtm|playbook|google policy check) .*?( · \w+)?$', '\1\2'),
           '[0-9a-f]{8}-[0-9a-f-]{27,}|\d+', '#', 'g'), 60),
         r.model,
         r.actor is distinct from 'person',
         count(*), coalesce(sum(r.input_tokens), 0), coalesce(sum(r.output_tokens), 0), coalesce(sum(r.cache_write_tokens), 0), coalesce(sum(r.cache_read_tokens), 0), coalesce(sum(r.searches), 0)
  from public.ai_runs r
  where r.created_at >= p_from and r.created_at < p_to and r.model in ('opus', 'sonnet', 'haiku')
  group by 1, 2, 3, 4, 5
$$;
revoke all on function public.owner_spend_rollup(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.owner_spend_rollup(timestamptz, timestamptz) to service_role;
