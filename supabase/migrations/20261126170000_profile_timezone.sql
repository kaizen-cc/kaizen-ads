-- Each person's own time zone (owner, Nov 24 2026): the routines (recaps, sweeps, the nightly agent) run at the
-- standard times in it. Read once from their Google Calendar setting, New York until then.
alter table public.profiles add column if not exists timezone text;
