-- What a client tells any Kaizen team on a call (email, organic, web as well as ads) is remembered on their page.
alter table public.client_memory drop constraint client_memory_source_check;
alter table public.client_memory add constraint client_memory_source_check check (source = any (array['team', 'client', 'review', 'copy', 'lab', 'audit', 'sprint', 'network', 'call']));
