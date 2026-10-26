-- A client's own UTM parameters for launched ads, over Kaizen's template
alter table public.clients add column if not exists url_tags text;
comment on column public.clients.url_tags is 'This client''s own UTM parameters for launched ads; empty: Kaizen''s template (Settings → Sync health)';
