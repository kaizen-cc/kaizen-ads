-- The AI review leaves its notes on the creative itself, as comments (pinned to the spot, boxed, or at a moment in a
-- video), kept with every other comment; a later run checks earlier ones and resolves what was fixed.
alter table public.review_comments add column if not exists ai_review_id uuid references public.creative_ai_reviews(id) on delete set null,
  add column if not exists severity text check (severity in ('fix', 'watch')),
  add column if not exists area text,
  add column if not exists resolved_by_ai boolean not null default false;

-- Videos are reviewed as a timeline: frames sampled through the whole video (dense over the hook, one a second after,
-- plus scene cuts) captured in the browser, and the audio, transcribed with timings.
alter table public.design_files add column if not exists frames jsonb, -- [{ ms, path }]
  add column if not exists audio_path text,
  add column if not exists transcript jsonb, -- [{ ms, endMs, text }]
  add column if not exists transcript_status text; -- done, silent, failed: <why>
