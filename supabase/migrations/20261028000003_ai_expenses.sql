-- AI expenses: who set each AI call off (a person, or Kaizen Ads on its own schedule) and how many web searches it
-- ran, and a rollup the Expenses page reads: tokens by day, skill, model, kind of call and person, as one JSON value
-- (so a year of it isn't cut off by the row limit). Execs only, through ai_runs' own policy.

alter table public.ai_runs
  add column if not exists profile_id uuid references public.profiles(id) on delete set null,
  add column if not exists actor text check (actor in ('person', 'auto')),
  add column if not exists searches integer not null default 0;
create index if not exists ai_runs_created_at_idx on public.ai_runs (created_at);

create or replace function public.ai_cost_rollup(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
  from (
    select
      (created_at at time zone 'America/New_York')::date as day,
      agent_key as agent,
      model,
      -- What kind of call it was: the label up to the first name or number in it (client names, ticket numbers)
      lower(trim(regexp_replace(coalesce(label, ''), '\s+[A-Z0-9#(].*$', ''))) as kind,
      profile_id as person,
      actor,
      count(*) as runs,
      count(*) filter (where not ok) as failed,
      coalesce(sum(input_tokens), 0) as input,
      coalesce(sum(output_tokens), 0) as output,
      coalesce(sum(cache_write_tokens), 0) as cache_w,
      coalesce(sum(cache_read_tokens), 0) as cache_r,
      coalesce(sum(searches), 0) as searches
    from public.ai_runs
    where created_at >= p_from and created_at < p_to
    group by 1, 2, 3, 4, 5, 6
  ) g;
$$;
grant execute on function public.ai_cost_rollup(timestamptz, timestamptz) to authenticated;
