-- Kaizen Ads — every client has an industry
-- So what works for one client can inform another in the same industry: the AI suggests winners from similar clients
-- when a request is written. The AI detects the industry from what we know about the client; the team can change it,
-- and a team-set industry is never overwritten by the AI.
alter table public.clients
  add column industry         text,   -- one of the list in src/lib/industry.ts
  add column industry_detail  text,   -- more specific: "Pizza restaurant", "Kitchen remodeling"
  add column industry_source  text check (industry_source in ('ai', 'team')),
  add column industry_set_at  timestamptz;
create index on public.clients (industry) where industry is not null;
