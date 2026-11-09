-- Reports: one period per report, a history of every send, and email as a way to send.
--
-- 1. reports.period_key: the preset the buyer picked for the report's dates (lastWeek, last7, last14, last30, thisMonth,
--    lastMonth, custom). period_start and period_end stay the dates themselves; every page of the report is drawn for
--    them, and changing them redraws every page with fresh numbers.
-- 2. report_sends: every time a report went to a client (and every resend): who sent it, when, which channels and
--    recipients, the period, the message and a frozen copy of the PDF that went (in the private report-sends bucket),
--    so a sent report can always be opened, reviewed and sent again. Nothing here is ever deleted by the app.
-- 3. How each client gets their reports: Slack, email or both, and who the email goes to (remembered per client, picked
--    from their contacts or typed in), on client_report_prefs. A built report keeps the choice made when its message
--    was approved (report_bundles.delivery), for when its last part comes in.

alter table public.reports add column if not exists period_key text;

alter table public.report_bundles add column if not exists delivery jsonb; -- { channels: ['slack','email'], recipients: [{ email, name }] }

alter table public.client_report_prefs
  add column if not exists channels text[] not null default '{slack}',
  add column if not exists recipients jsonb not null default '[]'::jsonb, -- [{ email, name }]
  add column if not exists delivery_updated_by uuid references public.profiles(id) on delete set null,
  add column if not exists delivery_updated_at timestamptz;

create table if not exists public.report_sends (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  report_id uuid references public.reports(id) on delete set null,
  bundle_id uuid references public.report_bundles(id) on delete set null,
  kind text not null default 'weekly', -- the report's kind: weekly, monthly, custom, built
  platform text, -- meta, google, or null for a joint report
  period_start date,
  period_end date,
  period_label text,
  sent_by uuid references public.profiles(id) on delete set null,
  sent_at timestamptz not null default now(),
  channels text[] not null default '{}', -- where it actually went: slack, email
  slack jsonb, -- { channel, ts, as } or { error }
  email jsonb, -- { to: [], failed: [{ email, error }], subject, reply_to }
  status text not null default 'sent' check (status in ('sent', 'partial', 'failed')),
  message text, -- the Slack message (or the email's summary) as it went
  snapshot jsonb, -- the report as it went: headline, summary, key numbers
  pdf_path text, -- the frozen PDF in the report-sends bucket
  file_name text,
  resend_of uuid references public.report_sends(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists report_sends_client on public.report_sends (client_id, sent_at desc);
create index if not exists report_sends_sent on public.report_sends (sent_at desc);
create index if not exists report_sends_report on public.report_sends (report_id);
create index if not exists report_sends_bundle on public.report_sends (bundle_id);

alter table public.report_sends enable row level security;
drop policy if exists "staff read report sends" on public.report_sends;
create policy "staff read report sends" on public.report_sends for select to authenticated using (private.is_staff());

-- The frozen PDFs (server only: read through /api/reports/sends/<id>/pdf)
insert into storage.buckets (id, name, public, file_size_limit) values ('report-sends', 'report-sends', false, 52428800) on conflict (id) do nothing;

-- What went out before this: the reports already sent, so the history starts complete. Their PDF is drawn from the
-- report as it is (a sent report can't be edited), so there's no frozen file for them.
insert into public.report_sends (client_id, report_id, kind, platform, period_start, period_end, sent_by, sent_at, channels, slack, status, message, snapshot)
select r.client_id, r.id, r.kind, r.platform, r.period_start, r.period_end, r.posted_by, coalesce(r.posted_at, r.updated_at), '{slack}',
       case when r.slack_ts is not null then jsonb_build_object('channel', r.slack_channel, 'ts', r.slack_ts) else null end,
       'sent', r.message, jsonb_build_object('headline', r.sections->>'headline', 'summary', r.sections->>'summary', 'legacy', true)
from public.reports r
where r.status = 'posted' and r.bundle_id is null
  and not exists (select 1 from public.report_sends s where s.report_id = r.id);

insert into public.report_sends (client_id, bundle_id, kind, period_start, period_end, period_label, sent_by, sent_at, channels, slack, email, status, message, snapshot)
select b.client_id, b.id, b.kind, b.period_start, b.period_end,
       case when b.kind = 'built' then (select string_agg(x->>'label', ' + ') from jsonb_array_elements(coalesce(b.ranges, '[]'::jsonb)) x) else null end,
       coalesce(b.message_approved_by, b.created_by), coalesce(b.sent_at, b.created_at),
       array_remove(array[case when b.delivered ? 'slack' then 'slack' end, case when jsonb_array_length(coalesce(b.delivered->'email', '[]'::jsonb)) > 0 then 'email' end], null),
       b.delivered->'slack',
       case when b.delivered ? 'email' then jsonb_build_object('to', b.delivered->'email') else null end,
       'sent', b.message, jsonb_build_object('legacy', true)
from public.report_bundles b
where b.status = 'sent'
  and not exists (select 1 from public.report_sends s where s.bundle_id = b.id);
