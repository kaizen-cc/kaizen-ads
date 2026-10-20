-- A note true as of a date (a month's results, an event, a promotion): kept and shown, and agents read it as background
-- from that date rather than as a standing rule. Nothing is archived for being old.
alter table public.client_memory add column if not exists dated date;
