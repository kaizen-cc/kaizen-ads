-- An ad's video (to play it from a preview) and where it sends people (to open it), read from Meta and kept
alter table public.ad_media add column if not exists video_id text;
alter table public.ad_media add column if not exists link text;
alter table public.ad_media add column if not exists info_at timestamptz;
