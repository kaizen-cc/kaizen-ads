-- Email allotments follow the Asana Email Marketing board's moves (owner, Nov 19 2026): every request counts once,
-- against the client's billing cycle (allotment_period_start(billing_day), the Stripe billing day, like creative).
-- In progress: requested, copy, design, review, with the client, revisions (open and not built and ready). Done:
-- completed, or built and ready to send, scheduled or sent. Work still moving from last cycle counts against this one
-- until it's delivered. Each pool shows used / cap, N in progress and N done.

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
  -- In motion: open on the board and not yet built and ready (Ready To Send, Scheduled, sent): requested, copy, design,
  -- review, with the client, revisions. Done: completed, or built and ready to send or scheduled.
  select t.client_id, u.campaigns, u.sms, u.flows, u.flow_emails, coalesce(t.asana_created_at, t.synced_at) as asked_at,
    t.open and coalesce(t.stage, '') not in ('ready_to_send', 'scheduled', 'sent', 'live') and coalesce(t.section, '') !~* '^\s*(ready to send|scheduled|sent|done|completed?|live)\s*$' as open
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
    e.stage not in ('live', 'ready_to_send', 'scheduled')
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
    sum(u.flow_emails) filter (where u.open) as flow_emails_progress,
    -- Done this cycle (asked this cycle and delivered)
    sum(u.campaigns) filter (where u.asked_at >= y.starts and not u.open) as campaigns_done,
    sum(u.sms) filter (where u.asked_at >= y.starts and not u.open) as sms_done,
    sum(u.flows) filter (where u.asked_at >= y.starts and not u.open) as flows_done,
    sum(u.flow_emails) filter (where u.asked_at >= y.starts and not u.open) as flow_emails_done
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
  ((a.starts at time zone 'America/New_York')::date + interval '1 month')::date as period_end,
  coalesce(n.campaigns_done, 0)::int as campaigns_done,
  coalesce(n.sms_done, 0)::int as sms_done,
  coalesce(n.flows_done, 0)::int as flows_done,
  coalesce(n.flow_emails_done, 0)::int as flow_emails_done
from cap a
left join counted n on n.client_id = a.client_id;

grant select on public.client_email_allotment to authenticated;
