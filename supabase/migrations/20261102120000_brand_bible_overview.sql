alter table public.client_brand_bibles add column if not exists overview jsonb;
comment on column public.client_brand_bibles.overview is 'The cover: core statement, mission, vision and the client''s stated goal, each with its source';
alter table public.client_brand_bibles add column if not exists build_stage text;
comment on column public.client_brand_bibles.build_stage is 'While building: research (reading the web) or write (writing the Bible, in its own run)';
