-- The report builder: a report built for a client, for one or more date ranges and one or more services. Each service
-- is a part written for (and approved by) its buyer; the person who built it approves the Slack message. A report on
-- one service goes out as its buyer; a joint one goes out once, from the Kaizen app: one message and one PDF.
alter table public.report_bundles drop constraint if exists report_bundles_kind_check;
alter table public.report_bundles add constraint report_bundles_kind_check check (kind in ('monthly', 'built'));
alter table public.report_bundles drop constraint if exists report_bundles_status_check;
alter table public.report_bundles add constraint report_bundles_status_check check (status in ('collecting', 'waiting', 'sending', 'sent', 'failed'));
alter table public.report_bundles
  add column if not exists ranges jsonb, -- [{ key, label, start, end }], the first is the main one
  add column if not exists services text[],
  add column if not exists created_by uuid references public.profiles(id) on delete set null,
  add column if not exists message text, -- the Slack message (the parts' messages, combined for a joint report)
  add column if not exists message_approved_at timestamptz,
  add column if not exists message_approved_by uuid references public.profiles(id) on delete set null;

alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports add constraint reports_kind_check check (kind in ('weekly', 'monthly', 'custom', 'built'));
-- The numbers for the other date ranges of a built report (the first range is in metrics)
alter table public.reports add column if not exists extra_metrics jsonb;
