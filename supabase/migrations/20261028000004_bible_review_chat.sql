-- The Brand Bible review chat: the team clarifies open questions with the strategist, and its answers edit the Bible
alter table public.client_brand_bibles add column if not exists review_chat jsonb not null default '[]'::jsonb;
