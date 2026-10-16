-- What a market ad needs to show as it runs, and the AI's read of it (applied with a refill of the ads already pulled)
alter table public.market_ads
  add column if not exists library_url text,
  add column if not exists page_name text,
  add column if not exists rank int,
  add column if not exists observation text,
  add column if not exists takeaways text[] not null default '{}';

-- Brands found by name from a client's intake form are checked before they count (a local competitor's name often
-- matches an unrelated national brand). Rejected ones are hidden and not synced.
alter table public.market_brands
  add column if not exists matched_query text,
  add column if not exists checked_at timestamptz,
  add column if not exists rejected boolean not null default false,
  add column if not exists reject_reason text;
