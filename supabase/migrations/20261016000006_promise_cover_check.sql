-- When a promise was last checked against new requests (so any request that covers it clears its alert)
alter table public.call_commitments add column if not exists cover_checked_at timestamptz;
