-- Email (Klaviyo) and organic social client reports, in the same report studio as the ads reports.
--
-- A channel report is a row in public.reports with platform 'klaviyo' (email) or 'social' (organic Facebook and
-- Instagram). Everything else about a report keeps working as it does for ads: status, message, sections, qa, chat,
-- history (report_sends), the PDF and the sent copy. What differs:
--
--   1. No ad account. reports.target_id (the KPI behind an ads report) is optional now; a channel report has none.
--      The ads unique key (target_id, kind, period_start) can't see a channel report (nulls are distinct), so a
--      channel report has its own: one per client, platform, kind and period.
--   2. A share link. The /r/<token> page for ads belongs to a monthly bundle; a channel report is sent on its own, so it
--      carries its own token (reports.share_token). The page only opens once the report went to the client.
--   3. Weekly is optional per client. A client's report preferences (client_report_prefs.channel_weekly) hold the
--      lines ('email', 'social') that also get a Monday weekly; the monthly (first business days, for the month just
--      over) is always drafted for every connected client.
--   4. Who reads them. The six email and social positions are denied the paid-ads tables by private.sees_paid_ads(),
--      and "staff read reports" used it, so they could never read a report. The rule is now: ad people read every
--      report as before; a channel position reads only the reports of platform klaviyo or social on a client it can see
--      (private.staff_can_see_client: the Head of Email and Head of Organic Social for clients with their service,
--      everyone else for the clients they hold a seat on). Ads reports stay invisible to them. The app narrows it
--      further to the person's own line (email people see email reports, social people social reports) and the admin
--      client the server uses for writing re-checks the same thing in code (src/lib/channel-reports/access.ts).
--
-- Additive and idempotent: safe to run more than once. Nothing is deleted.

-- 1. A report without an ad account
alter table public.reports alter column target_id drop not null;

create unique index if not exists reports_channel_period
  on public.reports (client_id, platform, kind, period_start)
  where target_id is null;
create index if not exists reports_channel_platform
  on public.reports (platform, period_start desc)
  where target_id is null;

-- 2. Its own share link
alter table public.reports add column if not exists share_token text;
update public.reports set share_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') where share_token is null and target_id is null;
create unique index if not exists reports_share_token on public.reports (share_token) where share_token is not null;
alter table public.reports alter column share_token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

-- 3. Weekly per client, optional
alter table public.client_report_prefs add column if not exists channel_weekly text[] not null default '{}';
comment on column public.client_report_prefs.channel_weekly is 'The channel lines (email, social) that also get a Monday weekly report for this client; the monthly is always drafted';

-- 4. Who reads them
drop policy if exists "staff read reports" on public.reports;
create policy "staff read reports" on public.reports for select to authenticated
  using (
    (private.is_staff())
    and (
      (select private.sees_paid_ads())
      or (platform in ('klaviyo', 'social') and private.staff_can_see_client(client_id))
    )
  );

comment on column public.reports.platform is 'meta, google or tiktok (an ads report, with a target_id) · klaviyo (email) or social (organic Facebook and Instagram), with no target_id';
