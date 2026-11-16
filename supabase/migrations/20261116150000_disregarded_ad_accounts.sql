-- Ad accounts shared with Kaizen that belong to no current client (a past client's, a test account): an exec disregards
-- them so the KPI board stops asking whose they are. Nothing is deleted; bringing one back removes its row here.
create table if not exists public.disregarded_ad_accounts (
  platform       text not null default 'meta' check (platform in ('meta', 'google', 'tiktok')),
  ad_account_id  text not null,
  name           text,
  disregarded_by uuid references public.profiles (id) on delete set null,
  disregarded_at timestamptz not null default now(),
  primary key (platform, ad_account_id)
);
alter table public.disregarded_ad_accounts enable row level security;
drop policy if exists "execs read disregarded ad accounts" on public.disregarded_ad_accounts;
create policy "execs read disregarded ad accounts" on public.disregarded_ad_accounts for select to authenticated using (private.is_exec());
-- Writes are the server's (an exec-only action)
