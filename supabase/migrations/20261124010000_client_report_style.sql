-- A client's report style, versioned (owner, Nov 20 2026): whatever a buyer changes on a client's report (asks in the
-- report studio, edits by hand, the metrics they pick, custom asks in Kaizen AI or the assistant) is kept as that
-- client's report preferences, per line (ads, email, social). Every change is a new version with who taught it and
-- where; undo marks the newest version undone, so the one before is in use again. Every report drafted afterwards (the
-- Monday weekly, the monthly recap, a built report) reads the newest version not undone.
--
-- The old client_report_prefs.notes (one list for every line) seed version 1 of each client's ads style.

create table if not exists public.client_report_style (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  line text not null check (line in ('ads', 'email', 'social')),
  version integer not null,
  rules jsonb not null default '[]'::jsonb,
  change text not null default '',
  source text not null check (source in ('studio_ask', 'hand_edit', 'layout', 'kaizen_ai', 'assistant', 'undo', 'import')),
  report_id uuid references public.reports(id) on delete set null,
  taught_by uuid references public.profiles(id) on delete set null,
  taught_by_name text,
  -- A metrics change (tiles, key metrics, campaign columns): the account and its layout before, so undo puts it back
  layout_target uuid references public.kpi_targets(id) on delete set null,
  layout_before jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references public.profiles(id) on delete set null,
  unique (client_id, line, version)
);

create index if not exists client_report_style_current on public.client_report_style (client_id, line, version desc);

alter table public.client_report_style enable row level security;
-- Read by the team (the report page shows it); written only by the server after its own access checks
create policy "staff read report style" on public.client_report_style for select to authenticated using ((select private.is_staff()));

insert into public.client_report_style (client_id, line, version, rules, change, source, taught_by_name, created_at)
select p.client_id, 'ads', 1,
  (select coalesce(jsonb_agg(jsonb_build_object('text', n, 'topic', null, 'by', null, 'at', coalesce(p.updated_at, now()), 'source', 'import')), '[]'::jsonb)
     from jsonb_array_elements_text(p.notes) as n),
  'Carried over from earlier reports', 'import', null, coalesce(p.updated_at, now())
from public.client_report_prefs p
where jsonb_typeof(p.notes) = 'array' and jsonb_array_length(p.notes) > 0
on conflict (client_id, line, version) do nothing;
