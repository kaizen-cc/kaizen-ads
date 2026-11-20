-- Tracking watchdogs (src/lib/watchdogs): an audit that found tracking problems, platform conversions vs the store's
-- orders, and conversion rate dropping abnormally. They also reach the tracking specialists.
alter table public.watch_flags drop constraint if exists watch_flags_kind_check;
alter table public.watch_flags add constraint watch_flags_kind_check check (kind in (
  'idle', 'neglected', 'overtouched', 'spend_spike', 'spend_drop', 'spend_stopped', 'overspend', 'creative_behind', 'creative_quiet', 'creative_sprint', 'unrecognized',
  'client_changed', 'admin_removal', 'unapproved_change', 'over_budget', 'zero_results', 'past_event', 'special_category', 'lead_no_crm', 'access_lost',
  'integration_auth', 'payment_issue', 'delivery_issue', 'quiet_channel', 'creative_stuck', 'big_date', 'site_down', 'site_check',
  'tracking_audit', 'tracking_mismatch', 'cvr_drop'
));
