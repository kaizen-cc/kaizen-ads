-- YouTube videos shared in Slack become agent knowledge (owner, Nov 24 2026): whenever anyone on the team shares a
-- YouTube link in a team channel the bot is in (#facebook, a line channel), a client channel, or their own DMs when
-- they've connected Slack reading, Kaizen OS reads the video like the channels it studies. One video is processed
-- once however many times it's shared; every share is kept and linked.
--
-- youtube_shares: each share: where (channel, client), who (their profile when known), the sharer's comment (never for
--   a DM: only that it came from a direct message), its permalink, and the priority the comment and the sharer's role
--   give it (an exec saying "great" raises it). attached_at: when it was filed to that client's knowledge.
-- youtube_videos.lines: the lines a video shared outside a studied channel teaches (from the channel and the sharer)
-- youtube_videos.priority: the highest share priority (read first; shown on the card)
-- youtube_videos.shared_note: the credit shown with it ("Shared by the paid-ads exec in #facebook: …")

alter table public.youtube_videos add column if not exists lines text[] not null default '{}';
alter table public.youtube_videos add column if not exists priority integer not null default 0;
alter table public.youtube_videos add column if not exists shared_note text;

create table if not exists public.youtube_shares (
  id              uuid primary key default gen_random_uuid(),
  video_row       uuid not null references public.youtube_videos(id) on delete cascade,
  source          text not null default 'slack' check (source in ('slack', 'slack_dm')),
  channel_id      text not null,
  channel_name    text,
  client_id       uuid references public.clients(id) on delete set null,
  message_ts      text not null,
  permalink       text,
  shared_by       uuid references public.profiles(id) on delete set null,
  shared_by_name  text,
  comment         text,
  priority        integer not null default 0,
  shared_at       timestamptz not null default now(),
  attached_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (video_row, channel_id, message_ts)
);
create index if not exists youtube_shares_video on public.youtube_shares (video_row);
create index if not exists youtube_shares_client on public.youtube_shares (client_id) where client_id is not null and attached_at is null;
alter table public.youtube_shares enable row level security;
-- Team-channel and client-channel shares are readable by staff; a DM share only by the person whose DMs it came from
drop policy if exists "staff read youtube shares" on public.youtube_shares;
create policy "staff read youtube shares" on public.youtube_shares for select to authenticated
  using ((select private.is_staff()) and (source <> 'slack_dm' or shared_by = (select private.current_profile_id())));
grant select on public.youtube_shares to authenticated;

-- The worker reads the most-flagged videos first (an exec's "must watch" before a plain upload)
create or replace function public.claim_youtube_video()
returns setof public.youtube_videos language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.youtube_videos v set status = 'reading', attempts = v.attempts + 1, updated_at = now()
   where v.id = (
     select id from public.youtube_videos
      where (status = 'queued' and next_at <= now()) or (status = 'reading' and updated_at < now() - interval '20 minutes')
      order by priority desc, next_at
      limit 1
      for update skip locked)
  returning v.*;
end $$;
revoke execute on function public.claim_youtube_video() from public, anon, authenticated;
