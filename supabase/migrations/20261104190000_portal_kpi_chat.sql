-- The client confirmed this KPI target in their plan review ("Here's how we'll measure success"): it's theirs, and the
-- Account Overview sheet no longer overwrites it (the team changes it in Kaizen Ads)
alter table public.kpi_targets add column if not exists client_confirmed_at timestamptz;

-- Portal chat: each message's emoji reactions as Slack has them ([{ name, count, users }])
alter table public.portal_chat_messages add column if not exists reactions jsonb not null default '[]'::jsonb;
