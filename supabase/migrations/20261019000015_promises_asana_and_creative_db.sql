-- A promise from a call is in motion when a task on Asana's creative board covers it (the team is still moving over),
-- not only a Kaizen Ads ticket. And each client's Creative Database sheet in Drive (what was delivered, ready for the
-- client: new creatives and variations) is read as a cross-check on the allotment count.
alter table public.call_commitments add column asana_gids text[] not null default '{}';
alter table public.clients add column creative_db jsonb;
