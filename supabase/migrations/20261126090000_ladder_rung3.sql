-- The escalation ladder's third rung (owner, Nov 23 2026): owner at once, the line's lead after 48 hours without
-- movement (a drafted nudge, rung 2), and an exec only after another 48 hours without the lead moving it (rung 3).
-- Any touch on the item (a comment, a reply, a ticket moved, a status change, the lead's nudge sent) resets the clock;
-- "waiting on client" pauses it. An exec can take an escalated item (it lands in their "Needs me") or nudge the lead.

alter table public.ladder_nudges
  add column if not exists exec_at timestamptz,
  add column if not exists moved_at timestamptz,
  add column if not exists taken_by uuid references public.profiles (id) on delete set null,
  add column if not exists taken_at timestamptz,
  add column if not exists exec_nudged_at timestamptz,
  add column if not exists exec_nudged_by uuid references public.profiles (id) on delete set null;

comment on column public.ladder_nudges.exec_at is 'Reached an exec (rung 3): 48h after reaching the lead with nothing moving; cleared when it moves again';
comment on column public.ladder_nudges.moved_at is 'The last touch on the item seen by the ladder (comment, reply, ticket moved, status change)';
comment on column public.ladder_nudges.taken_by is 'An exec who took the item over from Escalated';

create index if not exists ladder_nudges_exec_idx on public.ladder_nudges (exec_at) where exec_at is not null and status in ('open', 'sent');
create index if not exists ladder_nudges_taken_idx on public.ladder_nudges (taken_by) where taken_by is not null;
