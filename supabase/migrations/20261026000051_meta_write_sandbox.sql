-- App-wide settings (execs edit). The first: Meta writes. While sandbox is on, Kaizen Ads may write to one ad
-- account only (Kaizen's own), whatever asks: the launcher, audit and sprint changes. Client accounts are refused.
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
create policy "staff read app settings" on public.app_settings for select to authenticated using (private.is_staff());
create policy "execs write app settings" on public.app_settings for all to authenticated using (private.is_exec()) with check (private.is_exec());
insert into public.app_settings (key, value) values ('meta_write', '{"sandbox": true, "sandboxAccount": "795029519154776"}') on conflict (key) do nothing;

-- Kaizen's own accounts (the sandbox): kept out of client reporting and the portal
alter table public.clients add column if not exists internal boolean not null default false;
-- Data (applied once): the "Kaizen (sandbox)" client on ad account 795029519154776, its Meta KPI row, Santi as its Meta buyer.
