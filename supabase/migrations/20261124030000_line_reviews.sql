-- The weekly account review (src/lib/line-review): one review per client per line it buys, drafted Monday morning
-- (New York) for the line's head (Head of Meta for Meta + TikTok, Google, Email, Organic Social). The head edits,
-- approves and sends it (posted as them to the client's INTERNAL Slack channel only) or skips it. Execs see every
-- review and the company-wide rollup. Written only by the server (admin client) after the rights are checked.

create table if not exists public.line_reviews (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  line        text not null check (line in ('meta', 'google', 'email', 'social')),
  week_start  date not null,
  head_role   text not null check (head_role in ('head_of_meta', 'head_of_google', 'head_of_email', 'head_of_social')),
  status      text not null default 'draft' check (status in ('draft', 'sent', 'skipped')),
  review      jsonb not null default '{}'::jsonb,
  message     text not null default '',
  risk        integer not null default 0,
  drafted_at  timestamptz not null default now(),
  edited_by   uuid references public.profiles(id),
  edited_at   timestamptz,
  sent_by     uuid references public.profiles(id),
  sent_at     timestamptz,
  slack_channel text,
  slack_ts    text,
  permalink   text,
  skipped_by  uuid references public.profiles(id),
  skipped_at  timestamptz,
  skip_reason text,
  error       text,
  unique (client_id, line, week_start)
);

create index if not exists line_reviews_week on public.line_reviews (week_start, line, risk desc);

alter table public.line_reviews enable row level security;

-- Execs see every review; a head sees their own line's. One check per query (the role is read once, not per row).
drop policy if exists "execs and heads read line reviews" on public.line_reviews;
create policy "execs and heads read line reviews" on public.line_reviews for select to authenticated
  using (
    (select private.is_exec())
    or head_role = (select p.role::text from public.profiles p where p.id = (select private.current_profile_id()) and p.is_active)
  );
