-- Every change people made to an ad account (Meta's activity log, Google's change history), kept as it's read so the
-- log grows past what the platforms keep (Google: 30 days). The KPI board shows the last 10, the client page the last 30.
create table public.ad_account_changes (
  key text primary key,
  ad_account_id text not null,
  platform text not null,
  at timestamptz not null,
  who text,
  what text not null,
  object text,
  object_type text,
  created_at timestamptz not null default now()
);
create index ad_account_changes_account_at on public.ad_account_changes (ad_account_id, at desc);
alter table public.ad_account_changes enable row level security;
create policy "staff read account changes" on public.ad_account_changes for select to authenticated using (private.is_staff());
