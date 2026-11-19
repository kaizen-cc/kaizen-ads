-- Email allotments, as Kaizen sells them (owner's pricing deck and SOWs, Nov 19 2026). Four pools, each a range the
-- client is paced against at its top: campaign emails, SMS messages, flows (each flow request counts once) and the
-- emails across flows (new flow emails or flow optimization emails). Where a month's cap comes from, first that wins:
--   1. a month set by hand on the client page
--   2. the client's own Scope of Work month (onboarding differs per client)
--   3. the 3-Month Initial Setup by its start date (M1 Foundation, M2 Expansion, M3 Ongoing)
--   4. the ongoing tier (Basic, Silver, Gold)
-- Used counts everything in the production line (asked this cycle plus anything still moving), like creative.

-- ─── Packages: ranges, setup months, price, design hours ────────────────────

alter table public.email_packages add column if not exists kind text not null default 'ongoing' check (kind in ('ongoing', 'setup'));
alter table public.email_packages add column if not exists campaigns_min integer;
alter table public.email_packages add column if not exists sms integer;
alter table public.email_packages add column if not exists sms_min integer;
alter table public.email_packages add column if not exists flow_emails integer;
alter table public.email_packages add column if not exists flow_emails_min integer;
alter table public.email_packages add column if not exists price_monthly numeric;
alter table public.email_packages add column if not exists design_hours integer;
-- A setup package's months, in order: [{ label, campaigns, campaigns_min, sms, sms_min, flows, flow_emails, flow_emails_min, notes }]
alter table public.email_packages add column if not exists months jsonb;
alter table public.email_packages alter column flows drop not null;
alter table public.email_packages alter column flows drop default;

insert into public.email_packages (key, label, kind, sort_order, price_monthly, campaigns_min, campaigns, sms_min, sms, flows, flow_emails_min, flow_emails, design_hours, note, months) values
  ('setup', '3-Month Initial Setup', 'setup', 0, 1000, 0, 0, 0, 0, null, 0, 0, null, 'Month 1 Foundation, Month 2 Expansion, Month 3 Ongoing (then the ongoing tier)',
   '[{"label":"Setup month 1: Foundation","campaigns":0,"campaigns_min":0,"sms":0,"sms_min":0,"flows":3,"flow_emails":15,"flow_emails_min":15,"notes":"3 core flows (Welcome, Post-Purchase, Abandoned Cart), up to 15 flow emails, templates and copy, list segmentation, Klaviyo setup. No campaigns: warming only."},
     {"label":"Setup month 2: Expansion","campaigns":3,"campaigns_min":3,"sms":2,"sms_min":2,"flows":2,"flow_emails":10,"flow_emails_min":10,"notes":"2 more flows (Winback, Browse Abandonment or Sunset), up to 10 flow emails, 3 campaigns, 2 SMS, A/B tests on month 1 flows."},
     {"label":"Setup month 3: Ongoing","campaigns":5,"campaigns_min":5,"sms":2,"sms_min":2,"flows":1,"flow_emails":5,"flow_emails_min":5,"notes":"1 new flow or optimization of existing flows (5 emails), 5 campaigns, 2 SMS, reporting, list hygiene."}]'::jsonb),
  ('basic', 'Basic', 'ongoing', 1, 1000, 3, 5, 2, 2, null, 3, 5, 15, 'Flow optimization or new automation emails, campaigns, SMS, reporting, list hygiene. 6 to 10 emails a month.', null),
  ('silver', 'Silver', 'ongoing', 2, 1750, 7, 10, 4, 6, null, 5, 7, 30, 'Advanced A/B testing, enhanced segmentation. 10 to 15 emails a month.', null),
  ('gold', 'Gold', 'ongoing', 3, 2250, 15, 20, 6, 8, null, 5, 10, 55, 'Advanced segmentation and personalization, priority support. 20 to 30 emails a month.', null)
on conflict (key) do update set label = excluded.label, kind = excluded.kind, sort_order = excluded.sort_order, price_monthly = excluded.price_monthly,
  campaigns_min = excluded.campaigns_min, campaigns = excluded.campaigns, sms_min = excluded.sms_min, sms = excluded.sms, flows = excluded.flows,
  flow_emails_min = excluded.flow_emails_min, flow_emails = excluded.flow_emails, design_hours = excluded.design_hours, note = excluded.note, months = excluded.months, updated_at = now();

-- The client's 3-Month Setup start (the setup months follow it); email_package_key stays their ongoing tier
alter table public.clients add column if not exists email_setup_start date;

-- ─── Scope months: the same four pools, as ranges ───────────────────────────

alter table public.email_scope_months add column if not exists campaigns_min integer;
alter table public.email_scope_months add column if not exists sms integer;
alter table public.email_scope_months add column if not exists sms_min integer;
alter table public.email_scope_months add column if not exists flow_emails integer;
alter table public.email_scope_months add column if not exists flow_emails_min integer;

-- ─── Counting one request ───────────────────────────────────────────────────

drop view if exists public.client_email_allotment;
drop function if exists public.email_request_units(text, text, text);

-- What one request counts: campaign emails, SMS messages, flows and flow emails. A batch counts its sends ("(5)"), an
-- SMS batch its texts, a flow is one flow with its emails from the name ("Welcome Series (3)": 1 flow, 3 emails), "(3
-- flows)" is three flows. Not a request (an action item) or templates: nothing.
create or replace function public.email_request_units(p_name text, p_kind text, p_type text)
returns table (campaigns integer, sms integer, flows integer, flow_emails integer)
language sql immutable
set search_path = public
as $$
  with x as (
    select coalesce(p_name, '') as n, coalesce(p_type, '') as t, coalesce(p_kind, '') as k
  ), f as (
    select n, t,
      (t ~* 'flow' or (t = '' and (k = 'flow' or n ~* '\mflows?\M'))) as is_flow,
      (t ~* 'sms|text' or (t = '' and n ~* '\m(sms|texts?)\M')) as is_sms,
      (t ~* 'template' or (t = '' and n ~* '\mtemplates?\M')) as is_template,
      (t <> '' or n ~* '\m(email|sms|text)\s+(campaigns?|flows?|blasts?)\M|\mnewsletters?\M') as is_request,
      (regexp_match(n, '\((\d{1,2})\s*flows?\)', 'i'))[1]::int as flows_named,
      (regexp_match(n, '\((\d{1,2})(?:\s*(?:emails?|campaigns?|sends?|texts?|sms|messages?))?\)', 'i'))[1]::int as counted
    from x
  )
  select
    case when is_request and not is_template and not is_flow and not is_sms then greatest(1, least(50, coalesce(counted, 1))) else 0 end,
    case when is_request and not is_template and not is_flow and is_sms then greatest(1, least(50, coalesce(counted, 1))) else 0 end,
    case when is_request and not is_template and is_flow then greatest(1, least(20, coalesce(flows_named, 1))) else 0 end,
    case when is_request and not is_template and is_flow and flows_named is null then least(50, coalesce(counted, 0)) else 0 end
  from f
$$;

-- ─── Per client, this billing cycle ─────────────────────────────────────────

create or replace view public.client_email_allotment with (security_invoker = on) as
with cycle as (
  select c.id as client_id, allotment_period_start(c.billing_day::integer) as starts, c.email_package_key, c.email_setup_start
  from clients c
  where c.archived_at is null
), cm as (
  select y.*, date_trunc('month', (y.starts at time zone 'America/New_York'))::date as month,
    case when y.email_setup_start is null then null
         else (extract(year from date_trunc('month', (y.starts at time zone 'America/New_York')))::int - extract(year from y.email_setup_start)::int) * 12
            + extract(month from date_trunc('month', (y.starts at time zone 'America/New_York')))::int - extract(month from y.email_setup_start)::int end as setup_n
  from cycle y
), units as (
  select t.client_id, u.campaigns, u.sms, u.flows, u.flow_emails, coalesce(t.asana_created_at, t.synced_at) as asked_at, t.open
  from email_asana_tasks t
  cross join lateral public.email_request_units(t.name, t.kind, t.fields ->> 'Request Type') u
  where t.client_id is not null and coalesce(t.section, '') !~* '^action items$'
  union all
  -- Kaizen OS's own email board, where a ticket isn't on Asana: a flow is one flow and its messages, a batch its sends
  select e.client_id,
    case when e.kind = 'flow' then 0 else (select count(*)::int from email_messages m where m.ticket_id = e.id and m.channel <> 'sms') end,
    case when e.kind = 'flow' then 0 else (select count(*)::int from email_messages m where m.ticket_id = e.id and m.channel = 'sms') end,
    case when e.kind = 'flow' then 1 else 0 end,
    case when e.kind = 'flow' then (select count(*)::int from email_messages m where m.ticket_id = e.id) else 0 end,
    e.created_at,
    e.stage <> 'live'
  from email_tickets e
  where e.deleted_at is null and e.asana_gid is null
    and not exists (select 1 from email_asana_tasks a where a.ticket_id = e.id)
), counted as (
  select u.client_id,
    sum(u.campaigns) filter (where u.asked_at >= y.starts or u.open) as campaigns_used,
    sum(u.sms) filter (where u.asked_at >= y.starts or u.open) as sms_used,
    sum(u.flows) filter (where u.asked_at >= y.starts or u.open) as flows_used,
    sum(u.flow_emails) filter (where u.asked_at >= y.starts or u.open) as flow_emails_used,
    sum(u.campaigns) filter (where u.open) as campaigns_progress,
    sum(u.sms) filter (where u.open) as sms_progress,
    sum(u.flows) filter (where u.open) as flows_progress,
    sum(u.flow_emails) filter (where u.open) as flow_emails_progress
  from units u join cycle y on y.client_id = u.client_id
  group by u.client_id
), cap as (
  select y.client_id, y.month, y.starts,
    p.key as package_key, p.label as package_label,
    -- The setup month (0, 1 or 2 from its start), when the client is in one
    case when y.setup_n between 0 and 2 then (select sp.months -> y.setup_n::int from email_packages sp where sp.key = 'setup') end as setup,
    s.client_id is not null as has_scope, s.source as scope_source, s.label as scope_label,
    s.campaigns as s_campaigns, s.campaigns_min as s_campaigns_min, s.sms as s_sms, s.sms_min as s_sms_min, s.flows as s_flows, s.flow_emails as s_flow_emails, s.flow_emails_min as s_flow_emails_min,
    p.campaigns as p_campaigns, p.campaigns_min as p_campaigns_min, p.sms as p_sms, p.sms_min as p_sms_min, p.flows as p_flows, p.flow_emails as p_flow_emails, p.flow_emails_min as p_flow_emails_min
  from cm y
  left join email_packages p on p.key = y.email_package_key and p.active and p.kind = 'ongoing'
  left join email_scope_months s on s.client_id = y.client_id and s.month = y.month
)
select a.client_id,
  case when a.has_scope then a.s_campaigns_min when a.setup is not null then (a.setup ->> 'campaigns_min')::int else a.p_campaigns_min end as campaigns_min,
  case when a.has_scope then a.s_campaigns when a.setup is not null then (a.setup ->> 'campaigns')::int else a.p_campaigns end as campaigns_per_month,
  case when a.has_scope then a.s_sms_min when a.setup is not null then (a.setup ->> 'sms_min')::int else a.p_sms_min end as sms_min,
  case when a.has_scope then a.s_sms when a.setup is not null then (a.setup ->> 'sms')::int else a.p_sms end as sms_per_month,
  case when a.has_scope then a.s_flows when a.setup is not null then (a.setup ->> 'flows')::int else a.p_flows end as flows_per_month,
  case when a.has_scope then a.s_flow_emails_min when a.setup is not null then (a.setup ->> 'flow_emails_min')::int else a.p_flow_emails_min end as flow_emails_min,
  case when a.has_scope then a.s_flow_emails when a.setup is not null then (a.setup ->> 'flow_emails')::int else a.p_flow_emails end as flow_emails_per_month,
  case when a.has_scope then (case when a.scope_source = 'manual' then 'manual' else 'sow' end) when a.setup is not null then 'setup' when a.package_key is not null then 'package' end as cap_source,
  case when a.has_scope then a.scope_label when a.setup is not null then a.setup ->> 'label' end as scope_label,
  case when a.setup is not null and not a.has_scope then a.setup ->> 'notes' end as scope_notes,
  a.package_key,
  a.package_label,
  coalesce(n.campaigns_used, 0)::int as campaigns_used,
  coalesce(n.sms_used, 0)::int as sms_used,
  coalesce(n.flows_used, 0)::int as flows_used,
  coalesce(n.flow_emails_used, 0)::int as flow_emails_used,
  coalesce(n.campaigns_progress, 0)::int as campaigns_progress,
  coalesce(n.sms_progress, 0)::int as sms_progress,
  coalesce(n.flows_progress, 0)::int as flows_progress,
  coalesce(n.flow_emails_progress, 0)::int as flow_emails_progress,
  (a.starts at time zone 'America/New_York')::date as period_start,
  ((a.starts at time zone 'America/New_York')::date + interval '1 month')::date as period_end
from cap a
left join counted n on n.client_id = a.client_id;

grant select on public.client_email_allotment to authenticated;

-- ─── Custom and strategy only (owner, Nov 19 2026) ──────────────────────────
-- Every service's tier is set in one place, the Services panel. Custom: the client's own numbers per pool
-- (email_custom). Strategy only: the line is bought for strategy, no copy or design, so it holds no allotment: no pace
-- or behind alerts, no gaps, not listed for briefs or requests, no meter (clients.strategy_only lists those services).
insert into public.email_packages (key, label, kind, sort_order, note) values ('custom', 'Custom', 'ongoing', 9, 'This client''s own numbers, set on the client page')
on conflict (key) do nothing;
alter table public.clients add column if not exists email_custom jsonb;
alter table public.clients add column if not exists strategy_only text[] not null default '{}';

create or replace view public.client_email_allotment with (security_invoker = on) as
with cycle as (
  select c.id as client_id, allotment_period_start(c.billing_day::integer) as starts, c.email_package_key, c.email_setup_start, c.email_custom,
    'email-marketing' = any (c.strategy_only) as strategy
  from clients c
  where c.archived_at is null
), cm as (
  select y.*, date_trunc('month', (y.starts at time zone 'America/New_York'))::date as month,
    case when y.email_setup_start is null then null
         else (extract(year from date_trunc('month', (y.starts at time zone 'America/New_York')))::int - extract(year from y.email_setup_start)::int) * 12
            + extract(month from date_trunc('month', (y.starts at time zone 'America/New_York')))::int - extract(month from y.email_setup_start)::int end as setup_n
  from cycle y
), units as (
  select t.client_id, u.campaigns, u.sms, u.flows, u.flow_emails, coalesce(t.asana_created_at, t.synced_at) as asked_at, t.open
  from email_asana_tasks t
  cross join lateral public.email_request_units(t.name, t.kind, t.fields ->> 'Request Type') u
  where t.client_id is not null and coalesce(t.section, '') !~* '^action items$'
  union all
  -- Kaizen OS's own email board, where a ticket isn't on Asana: a flow is one flow and its messages, a batch its sends
  select e.client_id,
    case when e.kind = 'flow' then 0 else (select count(*)::int from email_messages m where m.ticket_id = e.id and m.channel <> 'sms') end,
    case when e.kind = 'flow' then 0 else (select count(*)::int from email_messages m where m.ticket_id = e.id and m.channel = 'sms') end,
    case when e.kind = 'flow' then 1 else 0 end,
    case when e.kind = 'flow' then (select count(*)::int from email_messages m where m.ticket_id = e.id) else 0 end,
    e.created_at,
    e.stage <> 'live'
  from email_tickets e
  where e.deleted_at is null and e.asana_gid is null
    and not exists (select 1 from email_asana_tasks a where a.ticket_id = e.id)
), counted as (
  select u.client_id,
    sum(u.campaigns) filter (where u.asked_at >= y.starts or u.open) as campaigns_used,
    sum(u.sms) filter (where u.asked_at >= y.starts or u.open) as sms_used,
    sum(u.flows) filter (where u.asked_at >= y.starts or u.open) as flows_used,
    sum(u.flow_emails) filter (where u.asked_at >= y.starts or u.open) as flow_emails_used,
    sum(u.campaigns) filter (where u.open) as campaigns_progress,
    sum(u.sms) filter (where u.open) as sms_progress,
    sum(u.flows) filter (where u.open) as flows_progress,
    sum(u.flow_emails) filter (where u.open) as flow_emails_progress
  from units u join cycle y on y.client_id = u.client_id
  group by u.client_id
), cap0 as (
  select y.client_id, y.month, y.starts,
    y.strategy, p.key as package_key, p.label as package_label,
    -- The setup month (0, 1 or 2 from its start), when the client is in one
    case when y.setup_n between 0 and 2 then (select sp.months -> y.setup_n::int from email_packages sp where sp.key = 'setup') end as setup,
    s.client_id is not null as has_scope, s.source as scope_source, s.label as scope_label,
    s.campaigns as s_campaigns, s.campaigns_min as s_campaigns_min, s.sms as s_sms, s.sms_min as s_sms_min, s.flows as s_flows, s.flow_emails as s_flow_emails, s.flow_emails_min as s_flow_emails_min,
    -- Custom: the client's own numbers
    case when p.key = 'custom' then (y.email_custom ->> 'campaigns')::int else p.campaigns end as p_campaigns,
    case when p.key = 'custom' then (y.email_custom ->> 'campaigns_min')::int else p.campaigns_min end as p_campaigns_min,
    case when p.key = 'custom' then (y.email_custom ->> 'sms')::int else p.sms end as p_sms,
    case when p.key = 'custom' then (y.email_custom ->> 'sms_min')::int else p.sms_min end as p_sms_min,
    case when p.key = 'custom' then (y.email_custom ->> 'flows')::int else p.flows end as p_flows,
    case when p.key = 'custom' then (y.email_custom ->> 'flow_emails')::int else p.flow_emails end as p_flow_emails,
    case when p.key = 'custom' then (y.email_custom ->> 'flow_emails_min')::int else p.flow_emails_min end as p_flow_emails_min
  from cm y
  left join email_packages p on p.key = y.email_package_key and p.active and p.kind = 'ongoing'
  left join email_scope_months s on s.client_id = y.client_id and s.month = y.month
), cap as (
  -- Strategy only: no allotment at all
  select c0.client_id, c0.month, c0.starts, c0.strategy, c0.package_key, c0.package_label,
    case when c0.strategy then null else c0.setup end as setup,
    c0.has_scope and not c0.strategy as has_scope, c0.scope_source, c0.scope_label,
    c0.s_campaigns, c0.s_campaigns_min, c0.s_sms, c0.s_sms_min, c0.s_flows, c0.s_flow_emails, c0.s_flow_emails_min,
    case when c0.strategy then null else c0.p_campaigns end as p_campaigns, case when c0.strategy then null else c0.p_campaigns_min end as p_campaigns_min,
    case when c0.strategy then null else c0.p_sms end as p_sms, case when c0.strategy then null else c0.p_sms_min end as p_sms_min,
    case when c0.strategy then null else c0.p_flows end as p_flows, case when c0.strategy then null else c0.p_flow_emails end as p_flow_emails,
    case when c0.strategy then null else c0.p_flow_emails_min end as p_flow_emails_min
  from cap0 c0
)
select a.client_id,
  case when a.has_scope then a.s_campaigns_min when a.setup is not null then (a.setup ->> 'campaigns_min')::int else a.p_campaigns_min end as campaigns_min,
  case when a.has_scope then a.s_campaigns when a.setup is not null then (a.setup ->> 'campaigns')::int else a.p_campaigns end as campaigns_per_month,
  case when a.has_scope then a.s_sms_min when a.setup is not null then (a.setup ->> 'sms_min')::int else a.p_sms_min end as sms_min,
  case when a.has_scope then a.s_sms when a.setup is not null then (a.setup ->> 'sms')::int else a.p_sms end as sms_per_month,
  case when a.has_scope then a.s_flows when a.setup is not null then (a.setup ->> 'flows')::int else a.p_flows end as flows_per_month,
  case when a.has_scope then a.s_flow_emails_min when a.setup is not null then (a.setup ->> 'flow_emails_min')::int else a.p_flow_emails_min end as flow_emails_min,
  case when a.has_scope then a.s_flow_emails when a.setup is not null then (a.setup ->> 'flow_emails')::int else a.p_flow_emails end as flow_emails_per_month,
  case when a.strategy then 'strategy' when a.has_scope then (case when a.scope_source = 'manual' then 'manual' else 'sow' end) when a.setup is not null then 'setup' when a.package_key is not null then 'package' end as cap_source,
  case when a.has_scope then a.scope_label when a.setup is not null then a.setup ->> 'label' end as scope_label,
  case when a.setup is not null and not a.has_scope then a.setup ->> 'notes' end as scope_notes,
  a.package_key,
  a.package_label,
  coalesce(n.campaigns_used, 0)::int as campaigns_used,
  coalesce(n.sms_used, 0)::int as sms_used,
  coalesce(n.flows_used, 0)::int as flows_used,
  coalesce(n.flow_emails_used, 0)::int as flow_emails_used,
  coalesce(n.campaigns_progress, 0)::int as campaigns_progress,
  coalesce(n.sms_progress, 0)::int as sms_progress,
  coalesce(n.flows_progress, 0)::int as flows_progress,
  coalesce(n.flow_emails_progress, 0)::int as flow_emails_progress,
  (a.starts at time zone 'America/New_York')::date as period_start,
  ((a.starts at time zone 'America/New_York')::date + interval '1 month')::date as period_end
from cap a
left join counted n on n.client_id = a.client_id;

grant select on public.client_email_allotment to authenticated;
