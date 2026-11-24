-- Settings › Calls & usage (the owner only, Nov 24 2026): who uses the agents most and what it costs, per person and
-- per day, rolled up in the database so the page never reads a month of raw AI runs (35k+ rows). Read through the
-- server after the owner check (src/lib/calls-usage.ts); nobody signed in can call these directly.

-- Every AI run this period by person, New York day, model and what it was: a call (voice or the assistant's text
-- chat answered on the call pipeline), a chat (Kaizen AI, an agent chat) or other work they set off (reports, briefs).
-- profile_id is null for the background runs nobody started (and the few older person runs never tied to anyone).
create or replace function public.owner_usage_rollup(p_from timestamptz, p_to timestamptz)
returns table (profile_id uuid, day date, model text, kind text, runs bigint, input bigint, output bigint, cache_w bigint, cache_r bigint, searches bigint, characters bigint, audio_seconds bigint)
language sql stable security definer set search_path = public as $$
  select r.profile_id,
         (r.created_at at time zone 'America/New_York')::date as day,
         r.model,
         case
           when r.agent_key = 'assistant_talk' or r.label ilike 'agent call%' or r.label ilike 'assistant call%' or r.label ilike 'call upload%' or r.label ilike 'assistant memory%' then 'call'
           when r.label ilike 'kaizen ai%' or r.label ilike 'agent chat%' then 'chat'
           else 'other'
         end as kind,
         count(*), coalesce(sum(r.input_tokens), 0), coalesce(sum(r.output_tokens), 0), coalesce(sum(r.cache_write_tokens), 0), coalesce(sum(r.cache_read_tokens), 0),
         coalesce(sum(r.searches), 0), coalesce(sum(r.characters), 0), coalesce(sum(r.audio_seconds), 0)
  from public.ai_runs r
  where r.created_at >= p_from and r.created_at < p_to
  group by 1, 2, 3, 4
$$;

-- Each Kaizen AI chat with messages this period: the person's messages, all messages, and the first and last
create or replace function public.owner_thread_counts(p_from timestamptz, p_to timestamptz)
returns table (thread_id uuid, profile_id uuid, user_messages bigint, messages bigint, first_at timestamptz, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.thread_id, t.profile_id, count(*) filter (where m.role = 'user'), count(*), min(m.created_at), max(m.created_at)
  from public.ai_messages m join public.ai_threads t on t.id = m.thread_id
  where m.created_at >= p_from and m.created_at < p_to
  group by 1, 2
$$;

revoke all on function public.owner_usage_rollup(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.owner_thread_counts(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.owner_usage_rollup(timestamptz, timestamptz) to service_role;
grant execute on function public.owner_thread_counts(timestamptz, timestamptz) to service_role;
