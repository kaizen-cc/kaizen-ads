-- A video ad's length in seconds, read from Meta once and kept, so average watch time can be shown as a share of the
-- video ("watched 4.1s of 12s, 34%"). video_seconds_at: when it was read (null and an attempt time = Meta didn't say).
alter table public.ad_media add column if not exists video_seconds numeric;
alter table public.ad_media add column if not exists video_seconds_at timestamptz;
