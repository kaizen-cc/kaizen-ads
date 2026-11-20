-- YouTube learning, transcripts from Google Gemini (the owner's choice, Nov 20 2026): a video with no captions track a
-- server can read is transcribed by Gemini from its public URL (GEMINI_API_KEY), within a per-run cap.
-- allow_long:       read it even past an hour (added on purpose: a single video by link, or summarized on demand)
-- blocked:          why it's waiting: 'key' (no Gemini key yet; re-queued once one is set), 'unavailable' (private,
--                   removed or age-restricted), 'long' (over an hour from a channel; add it by link to read it anyway)
-- transcript_via:   where the transcript came from: captions, gemini, service or paste
-- duration_seconds: the video's length, when YouTube said

alter table public.youtube_videos add column if not exists allow_long boolean not null default false;
alter table public.youtube_videos add column if not exists blocked text check (blocked in ('key', 'unavailable', 'long'));
alter table public.youtube_videos add column if not exists transcript_via text check (transcript_via in ('captions', 'gemini', 'service', 'paste'));
alter table public.youtube_videos add column if not exists duration_seconds integer;
create index if not exists youtube_videos_blocked on public.youtube_videos (blocked) where blocked is not null;
