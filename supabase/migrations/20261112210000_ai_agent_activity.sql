-- Settings › AI agents: each skill's activity rolled up in the database (runs this week, the last time each place in
-- the app called it, the average time) instead of reading every call of the last 30 days (24k+ rows, cut at 5,000,
-- which undercounted). Read by the server only, through a short shared cache.
create or replace function public.ai_agent_activity(p_week timestamptz)
returns jsonb
language sql
stable
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
  from (
    select agent_key as agent, label,
      count(*) filter (where created_at >= p_week) as runs7,
      count(*) filter (where created_at >= p_week and not ok) as failed7,
      coalesce(sum(input_tokens) filter (where created_at >= p_week), 0) as in7,
      coalesce(sum(output_tokens) filter (where created_at >= p_week), 0) as out7,
      coalesce(sum(ms) filter (where created_at >= p_week and ok and ms is not null), 0) as ms_sum,
      count(*) filter (where created_at >= p_week and ok and ms is not null) as ms_n,
      max(created_at) as last_at
    from public.ai_runs
    where created_at >= now() - interval '30 days'
    group by 1, 2
  ) g;
$$;

-- When each skill last ran at all (for the ones quiet this month)
create or replace function public.ai_agent_last_runs()
returns jsonb
language sql
stable
set search_path to 'public'
as $$
  select coalesce(jsonb_object_agg(a.key, l.at), '{}'::jsonb)
  from public.ai_agents a
  cross join lateral (select max(created_at) as at from public.ai_runs r where r.agent_key = a.key) l
  where l.at is not null;
$$;

revoke execute on function public.ai_agent_activity(timestamptz) from public, anon, authenticated;
revoke execute on function public.ai_agent_last_runs() from public, anon, authenticated;
grant execute on function public.ai_agent_activity(timestamptz) to service_role;
grant execute on function public.ai_agent_last_runs() to service_role;
