-- Prompt caching: what each AI call wrote to and read from the cache, so costs can be read off ai_runs. Brand Bible
-- research kept with its date, so a retry or an update within the month reuses it.
alter table public.ai_runs add column if not exists cache_write_tokens integer not null default 0, add column if not exists cache_read_tokens integer not null default 0;
alter table public.client_brand_bibles add column if not exists researched_at timestamptz;
