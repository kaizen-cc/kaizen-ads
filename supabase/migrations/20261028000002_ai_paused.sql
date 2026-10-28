-- While the AI is paused (usage limit), playbook changes it couldn't write up yet are kept here and written into the
-- Brand Bible's learnings once it's back.
alter table public.client_brand_bibles add column if not exists pending_learnings jsonb not null default '[]'::jsonb;
