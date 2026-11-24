-- The safety review's rule version (Nov 24 2026: distress needs a high-confidence read or two separate moments, and
-- background media, quotes, jokes and small talk never count). Flags from an older rule in the last three days are
-- re-scored by the safety sweep, and the ones that no longer hold are resolved (src/lib/agent-call/safety.ts).
alter table public.call_safety_reviews add column if not exists rule_version integer not null default 1;
