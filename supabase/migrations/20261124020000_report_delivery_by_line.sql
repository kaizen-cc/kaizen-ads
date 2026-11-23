-- Who a report's email goes to, per service line: the email team sends a client's report to Juan, Eddie and Lino while
-- the ads team sends theirs to Juan alone. { "<line>": { channels, recipients (To), cc, at, by } }. The client-wide
-- channels/recipients stay as they were (the default for a line with no choice yet).
alter table public.client_report_prefs add column if not exists delivery_by_line jsonb not null default '{}'::jsonb;
