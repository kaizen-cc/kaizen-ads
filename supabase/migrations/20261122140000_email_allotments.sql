-- Email allotments (owner, Nov 19 2026). A client on email gets a monthly allotment like the creative side's: a number
-- of campaigns (email and SMS sends) and a number of flows (each flow request counts once, whatever its message count:
-- building a fresh one or optimizing one). It comes from:
--   1. the month's scope from the client's Scope of Work (onboarding months differ per client, so a SOW month wins), or
--   2. the client's email package (email_packages: the tiers, editable; the owner adds them).
-- "Used" counts everything in the production line, the same rule as creative: what was asked this cycle (delivered or
-- not) plus whatever is still moving from earlier cycles. A batched Asana task counts its emails from its name
-- ("KZN x Crust Pizza Co. | Email Campaign - December (5)" is 5 campaigns); a flow task is one flow ("Email Flow -
-- Welcome Series (3)" is 1), unless the name counts flows ("(3 flows)" is 3). Same rule in TS: src/lib/email-allotment-core.ts.

-- ─── Packages ────────────────────────────────────────────────────────────────

create table if not exists public.email_packages (
  key         text primary key,
  label       text not null,
  campaigns   integer not null default 0 check (campaigns >= 0),
  flows       integer not null default 0 check (flows >= 0),
  note        text,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);
alter table public.email_packages enable row level security;
drop policy if exists "staff read email packages" on public.email_packages;
create policy "staff read email packages" on public.email_packages for select to authenticated using ((select private.is_staff()));

alter table public.clients add column if not exists email_package_key text references public.email_packages(key) on update cascade on delete set null;
alter table public.clients add column if not exists email_package_set_by uuid references public.profiles(id) on delete set null;
alter table public.clients add column if not exists email_package_set_at timestamptz;

-- ─── Scopes of Work ──────────────────────────────────────────────────────────

-- The client's SOW for a line: found in what Kaizen already reads (Drive, Gmail, the client's documents, a SOW the
-- assistant drew) or uploaded on the client page, and what the AI read from it (the email scope per month). A new one
-- replaces the old (kept, marked replaced): nothing is deleted.
create table if not exists public.client_sows (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  line         text not null default 'email',
  source       text not null check (source in ('found', 'upload')),
  found_in     text,
  external_id  text,
  name         text not null,
  url          text,
  bucket       text,
  path         text,
  mime         text,
  text         text,
  -- What the AI read: { summary, email_in_scope, start, months: [{ month: "YYYY-MM", label, campaigns, flows, notes }], ongoing: { campaigns, flows } | null }
  scope        jsonb not null default '{}',
  status       text not null default 'active' check (status in ('active', 'replaced', 'unreadable')),
  note         text,
  read_at      timestamptz,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  replaced_at  timestamptz
);
create index if not exists client_sows_client on public.client_sows (client_id, line, created_at desc);
alter table public.client_sows enable row level security;
drop policy if exists "staff read sows" on public.client_sows;
create policy "staff read sows" on public.client_sows for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

-- The allotment for one month of one client, from its SOW (or set by hand on the client page). Keyed by the month the
-- billing cycle starts in. drafted_at: the month's requests were drafted for the strategist from it.
create table if not exists public.email_scope_months (
  client_id   uuid not null references public.clients(id) on delete cascade,
  month       date not null check (extract(day from month) = 1),
  campaigns   integer not null default 0 check (campaigns >= 0),
  flows       integer not null default 0 check (flows >= 0),
  label       text,
  notes       text,
  source      text not null default 'sow' check (source in ('sow', 'manual')),
  sow_id      uuid references public.client_sows(id) on delete set null,
  drafted_at  timestamptz,
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (client_id, month)
);
alter table public.email_scope_months enable row level security;
drop policy if exists "staff read email scope" on public.email_scope_months;
create policy "staff read email scope" on public.email_scope_months for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

-- ─── Counting ────────────────────────────────────────────────────────────────

-- One request's pool and how many it counts: 'campaigns', 'flows', or null (not a request: an action item, templates)
create or replace function public.email_request_units(p_name text, p_kind text, p_type text)
returns table (pool text, units integer)
language sql immutable
set search_path = public
as $$
  with x as (
    select coalesce(p_name, '') as n, coalesce(p_type, '') as t, coalesce(p_kind, '') as k
  ), f as (
    select n, t,
      (t ~* 'flow' or (t = '' and (k = 'flow' or n ~* '\mflows?\M'))) as is_flow,
      (t ~* 'template' or (t = '' and n ~* '\mtemplates?\M')) as is_template,
      (t <> '' or n ~* '\m(email|sms|text)\s+(campaigns?|flows?|blasts?)\M|\mnewsletters?\M') as is_request
    from x
  )
  select
    case when not is_request or is_template then null when is_flow then 'flows' else 'campaigns' end,
    greatest(1, least(50, coalesce(
      case when is_flow then (regexp_match(n, '\((\d{1,2})\s*flows?\)', 'i'))[1]::int
           else (regexp_match(n, '\((\d{1,2})(?:\s*(?:emails?|campaigns?|sends?|texts?|sms|messages?))?\)', 'i'))[1]::int end,
      1)))
  from f
$$;

-- Per client, this billing cycle: the cap (the SOW's month, else the package) and what's used and in motion
create or replace view public.client_email_allotment with (security_invoker = on) as
with cycle as (
  select c.id as client_id, allotment_period_start(c.billing_day::integer) as starts, c.email_package_key
  from clients c
  where c.archived_at is null
), units as (
  -- Asana's Email Marketing board (the mirror), each task counted by its name
  select t.client_id, u.pool, u.units, coalesce(t.asana_created_at, t.synced_at) as asked_at, t.open
  from email_asana_tasks t
  cross join lateral public.email_request_units(t.name, t.kind, t.fields ->> 'Request Type') u
  where t.client_id is not null and u.pool is not null and coalesce(t.section, '') !~* '^action items$'
  union all
  -- Kaizen OS's own email board, where a ticket isn't on Asana: a flow is one, a batch its messages
  select e.client_id,
    case when e.kind = 'flow' then 'flows' else 'campaigns' end,
    case when e.kind = 'flow' then 1 else greatest(1, (select count(*)::int from email_messages m where m.ticket_id = e.id)) end,
    e.created_at,
    e.stage <> 'live'
  from email_tickets e
  where e.deleted_at is null and e.asana_gid is null
    and not exists (select 1 from email_asana_tasks a where a.ticket_id = e.id)
), counted as (
  select u.client_id,
    sum(u.units) filter (where u.pool = 'campaigns' and (u.asked_at >= y.starts or u.open)) as campaigns_used,
    sum(u.units) filter (where u.pool = 'flows' and (u.asked_at >= y.starts or u.open)) as flows_used,
    sum(u.units) filter (where u.pool = 'campaigns' and u.open) as campaigns_progress,
    sum(u.units) filter (where u.pool = 'flows' and u.open) as flows_progress
  from units u join cycle y on y.client_id = u.client_id
  group by u.client_id
)
select y.client_id,
  coalesce(s.campaigns, p.campaigns) as campaigns_per_month,
  coalesce(s.flows, p.flows) as flows_per_month,
  case when s.client_id is not null then (case when s.source = 'manual' then 'manual' else 'sow' end) when p.key is not null then 'package' end as cap_source,
  s.label as scope_label,
  p.key as package_key,
  p.label as package_label,
  coalesce(n.campaigns_used, 0)::int as campaigns_used,
  coalesce(n.flows_used, 0)::int as flows_used,
  coalesce(n.campaigns_progress, 0)::int as campaigns_progress,
  coalesce(n.flows_progress, 0)::int as flows_progress,
  (y.starts at time zone 'America/New_York')::date as period_start,
  ((y.starts at time zone 'America/New_York')::date + interval '1 month')::date as period_end
from cycle y
left join email_packages p on p.key = y.email_package_key and p.active
left join email_scope_months s on s.client_id = y.client_id and s.month = date_trunc('month', (y.starts at time zone 'America/New_York'))::date
left join counted n on n.client_id = y.client_id;

grant select on public.client_email_allotment to authenticated;
