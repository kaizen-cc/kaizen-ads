-- Reminders that are one checklist, not ten reminders: related things said on one call with an agent land on ONE
-- reminder, its items ticked off one by one in Next for me. A reminder can also carry the call's transcript (a
-- download button on it), when the person asked for the transcript with it.
-- No new policies: the owner already reads and updates their own asks (agent_asks' existing policies).

alter table public.agent_asks
  add column if not exists checklist jsonb not null default '[]'::jsonb,
  add column if not exists with_transcript boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_asks_checklist_is_list') then
    alter table public.agent_asks add constraint agent_asks_checklist_is_list check (jsonb_typeof(checklist) = 'array' and jsonb_array_length(checklist) <= 40);
  end if;
end $$;
