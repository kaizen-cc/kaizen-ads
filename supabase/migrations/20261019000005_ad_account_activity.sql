-- The last changes people made in each ad account (from Meta's activity log), read with every KPI sync, so the KPI
-- board shows whether someone is working on an account that's off target.
create table public.ad_account_activity (
  ad_account_id  text primary key,
  last_change_at timestamptz,
  last_change    jsonb,                 -- { at, who, what, object }
  recent         jsonb not null default '[]',
  error          text,
  checked_at     timestamptz not null default now()
);
alter table public.ad_account_activity enable row level security;
create policy "staff read account activity" on public.ad_account_activity for select to authenticated using (private.is_staff());
