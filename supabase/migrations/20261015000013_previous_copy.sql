-- Kaizen Ads — revised copy keeps what the client saw before, so they can compare
alter table public.copy_sets add column previous_ads jsonb;  -- the set as the client last reviewed it
