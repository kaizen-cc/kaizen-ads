-- Up to 5 variations per ticket; anything beyond that should be its own design.
alter table public.requests add constraint requests_variation_cap check (variation_count <= 5) not valid;
alter table public.requests validate constraint requests_variation_cap;
