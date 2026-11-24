-- The safety review recalibrated (the owner, Nov 24 2026): low is logged only, medium and high alert only after a
-- second check, and every older flag is re-scored. What a flag was before its re-score is kept here.
alter table public.call_safety_reviews add column if not exists recalibrated jsonb;
