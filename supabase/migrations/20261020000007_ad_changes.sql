-- Changes made to an ad account from Kaizen Ads: an audit action or a sprint move turned into specific changes (pause
-- a campaign, a budget, a target CPA or ROAS, negative keywords), checked with the platform first, applied only when
-- someone allowed confirms. Every one is kept: what, from what to what, who planned it, who applied it, what came back.
create table public.ad_changes (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.kpi_targets(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  platform text not null,
  account text not null,
  source text not null check (source in ('audit', 'sprint')),
  audit_id uuid references public.account_audits(id) on delete set null,
  action_index int,
  sprint_action_id uuid references public.sprint_actions(id) on delete set null,
  title text not null,
  status text not null default 'planning' check (status in ('planning', 'ready', 'nothing', 'applying', 'applied', 'partial', 'failed', 'discarded')),
  ops jsonb not null default '[]'::jsonb,
  note text,
  error text,
  planned_by uuid references public.profiles(id),
  applied_by uuid references public.profiles(id),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ad_changes_audit on public.ad_changes (audit_id, action_index);
create index ad_changes_sprint on public.ad_changes (sprint_action_id);
alter table public.ad_changes enable row level security;
create policy "staff read ad changes" on public.ad_changes for select to authenticated using (private.is_staff());
