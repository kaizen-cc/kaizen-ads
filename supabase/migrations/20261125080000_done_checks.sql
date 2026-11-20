-- The general done-check (Nov 20 2026): items on anyone's Today or Overview close themselves when Slack, Gmail or call
-- and Gemini notes show they're done. One row per item key: the last verdict (done, moving, nothing), the quote and
-- where it was said, when it closed (and the source written back, with what it was before, for a one-tap reopen).
create table if not exists public.done_checks (
  key text primary key,
  kind text not null,
  client_id uuid references public.clients(id) on delete cascade,
  client_name text,
  owner_id uuid references public.profiles(id) on delete set null,
  title text not null default '',
  state text not null default 'nothing' check (state in ('done', 'moving', 'nothing')),
  quote text not null default '',
  source text,
  link text,
  said_at timestamptz,
  checked_at timestamptz,
  due boolean not null default true,
  closed_at timestamptz,
  reopened_at timestamptz,
  reopened_by uuid references public.profiles(id) on delete set null,
  prev jsonb
);
create index if not exists done_checks_client_idx on public.done_checks (client_id) where closed_at is null;
create index if not exists done_checks_closed_idx on public.done_checks (closed_at desc) where closed_at is not null and reopened_at is null;
alter table public.done_checks enable row level security;
drop policy if exists "staff read done checks" on public.done_checks;
create policy "staff read done checks" on public.done_checks for select to authenticated
  using ((select private.is_staff()) and (client_id is null or (select private.staff_sees_all()) or client_id = any ((select private.staff_client_ids())::uuid[])));
