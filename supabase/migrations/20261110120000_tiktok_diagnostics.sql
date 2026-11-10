-- TikTok's tracking and delivery checks, one row per advertiser, refreshed once a day by the TikTok sync: the pixels on
-- the ad account and their events over the last 7 days (/pixel/list/, /pixel/event/stats/), and the warnings on its
-- ad groups and ads (TikTok's own diagnosis from /tool/diagnosis/get/, plus ad groups stuck learning and ads rejected,
-- from their secondary status). Kept compact: only what the client's TikTok tab and the TikTok audit show.
--   pixels:   [{ id, name, status, lastActive, events: [{ name, count }] }]
--   warnings: [{ kind, level, id, name, text }]   kind: learning | rejected | tracking | budget | creative | delivery | other
--   errors:   the checks TikTok refused this time (its code and message), so a partial read says so
-- Read only, like the rest of TikTok. Additive and idempotent: safe to run more than once.

create table if not exists public.tiktok_diagnostics (
  advertiser_id text primary key references public.tiktok_advertisers (advertiser_id) on delete cascade,
  pixels        jsonb not null default '[]',
  warnings      jsonb not null default '[]',
  errors        jsonb not null default '[]',
  checked_at    timestamptz,
  updated_at    timestamptz not null default now()
);
alter table public.tiktok_diagnostics enable row level security;
drop policy if exists "staff read tiktok diagnostics" on public.tiktok_diagnostics;
create policy "staff read tiktok diagnostics" on public.tiktok_diagnostics for select to authenticated using (private.is_staff());

comment on table public.tiktok_diagnostics is 'TikTok pixels and their events, and delivery warnings (diagnosis, learning, rejected), per advertiser, refreshed daily';
