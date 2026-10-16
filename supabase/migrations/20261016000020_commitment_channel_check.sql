-- When a promise was re-checked against its whole call (paid ads, or another Kaizen service)
alter table public.call_commitments add column if not exists channel_checked_at timestamptz;
