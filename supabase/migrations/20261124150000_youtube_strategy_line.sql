-- YouTube learning gains a "Marketing & strategy" line (owner's exec call, Nov 24 2026): full-funnel and offer creators
-- (Alex Hormozi, Sabri Suby, Russell Brunson) teach the Strategist and go to the execs rather than one platform's team.
-- youtube_sources.backfill: how many of a channel's latest videos its first check reads (the RSS feed gives 15 at
-- most; the YouTube Data API key, more). New channels from the call read their latest 20.
alter table public.youtube_sources add column if not exists backfill integer not null default 5 check (backfill between 0 and 50);
