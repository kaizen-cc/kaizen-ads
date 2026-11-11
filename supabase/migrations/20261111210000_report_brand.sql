-- The client's look on their reports (co-branding): their logo and brand colour, found once (Brand Bible, website,
-- Drive) or set on the client page (Team & setup › Report logo), and kept here so a report never waits on their website.
-- { logo: PNG data URI, light: white logo (shown on a dark chip), color: hex, source, colorSource, uploaded, colorSet,
--   checkedAt }. Idempotent.
alter table public.clients add column if not exists report_brand jsonb not null default '{}'::jsonb;

comment on column public.clients.report_brand is 'Report co-branding: the client logo (PNG data URI) and brand colour, found or uploaded; read by the weekly report PDF';
