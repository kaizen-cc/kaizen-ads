-- Bell notices whose thing is already closed are read on their own (owner, Nov 24 2026: "Review 61 new notifications"
-- next to a 6-thing day read as chaos). A notice is read once what it's about is: a reply owed answered or set aside,
-- a promise done or dropped, a task asked through an assistant closed, a ladder nudge resolved, a report posted or
-- skipped (superseded), or a day's recap or report reminder from an earlier day (today's took its place). Runs from
-- the owed-replies schedule; returns how many it read.
create or replace function public.sweep_closed_notices() returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  m integer;
  today date := (now() at time zone 'America/New_York')::date;
begin
  update notifications x set read_at = now()
  from owed_replies o
  where x.read_at is null and x.key ~ '^(owed|owed2|owed-lead):[0-9a-f-]{36}$'
    and o.id = split_part(x.key, ':', 2)::uuid and o.status not in ('watching', 'nudged', 'escalated');
  get diagnostics m = row_count; n := n + m;

  update notifications x set read_at = now()
  from message_promises p
  where x.read_at is null and x.key ~ '^(said|said2|said-lead|said-moving):[0-9a-f-]{36}$'
    and p.id = split_part(x.key, ':', 2)::uuid and p.status not in ('open', 'overdue', 'escalated', 'in_motion');
  get diagnostics m = row_count; n := n + m;

  update notifications x set read_at = now()
  from agent_asks a
  where x.read_at is null and x.key ~ '^agent-ask:[0-9a-f-]{36}$'
    and a.id = split_part(x.key, ':', 2)::uuid and a.status <> 'open';
  get diagnostics m = row_count; n := n + m;

  update notifications x set read_at = now()
  from ladder_nudges l
  where x.read_at is null and x.key ~ '^nudge:[0-9a-f-]{36}$'
    and l.id = split_part(x.key, ':', 2)::uuid and l.status not in ('open', 'sent');
  get diagnostics m = row_count; n := n + m;

  update notifications x set read_at = now()
  from reports r
  where x.read_at is null and x.key ~ '^(report|report-remind):[0-9a-f-]{36}'
    and r.id = split_part(x.key, ':', 2)::uuid and r.status in ('posted', 'skipped');
  get diagnostics m = row_count; n := n + m;

  -- An earlier day's recap or report reminder: today's took its place
  update notifications x set read_at = now()
  where x.read_at is null and (
    (x.key ~ '^recap:\d{4}-\d{2}-\d{2}' and split_part(x.key, ':', 2)::date < today)
    or (x.key ~ '^report-remind:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$' and split_part(x.key, ':', 3)::date < today)
  );
  get diagnostics m = row_count; n := n + m;
  return n;
end $$;

revoke all on function public.sweep_closed_notices() from public, anon, authenticated;
