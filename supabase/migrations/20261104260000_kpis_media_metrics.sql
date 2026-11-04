-- Ad pictures that don't expire: Meta's image links (fbcdn) die after a while, so each ad's picture is fetched once
-- from the ad itself and kept in storage, served through /api/ad-media/<ad id>. Staff only (the route checks).
insert into storage.buckets (id, name, public) values ('ad-media', 'ad-media', false) on conflict (id) do nothing;

create table if not exists public.ad_media (
  ad_id text primary key,
  path text,
  mime text,
  source text,
  error text,
  fetched_at timestamptz not null default now()
);
alter table public.ad_media enable row level security;
-- No policies: only the server (service role) reads and writes it

-- Asana due-date changes are now read from each task's stories (who pushed a due date back): read the last 100 days again
update public.asana_tasks set history_read_at = null where asana_modified_at > now() - interval '100 days';
