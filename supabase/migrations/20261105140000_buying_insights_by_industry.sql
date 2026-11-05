-- The senior buyer's teachings, attributed to where they came from: the platform (already there) and the industry, as
-- our own taxonomy (a sub-vertical, or a vertical when that's all that's clear), plus the business model (ecommerce,
-- lead gen, local, events, app). Scope says whether a point holds for any account (general: taught to every buyer
-- agent in its skills) or only makes sense for that kind of business (industry: never taught globally, only handed to
-- an agent working on an account in that sub-vertical, vertical or business model). Nothing existing changes meaning:
-- every item starts general, as it was taught until now.
alter table public.media_buying_insights
  add column if not exists vertical_id uuid references public.verticals(id) on delete set null,
  add column if not exists business_model text,
  add column if not exists scope text not null default 'general',
  -- When the industry and business model were worked out, and when the scope was (null: still to do, the backfill resumes)
  add column if not exists attributed_at timestamptz,
  add column if not exists scoped_at timestamptz;
alter table public.media_buying_insights drop constraint if exists media_buying_insights_scope_check;
alter table public.media_buying_insights add constraint media_buying_insights_scope_check check (scope in ('general', 'industry'));
create index if not exists media_buying_insights_platform_vertical on public.media_buying_insights (platform, vertical_id) where merged_into is null and not excluded;
create index if not exists media_buying_insights_unattributed on public.media_buying_insights (created_at) where attributed_at is null;
create index if not exists media_buying_insights_unscoped on public.media_buying_insights (created_at) where scoped_at is null and merged_into is null and not excluded;

-- A free-text industry the senior buyer named ("restaurant (pizza)", "medical (mental health)") placed in our taxonomy
-- once, so it's never asked again. vertical_id null: asked, and nothing fits.
create table if not exists public.media_buying_industry_map (
  key         text primary key,
  label       text not null,
  vertical_id uuid references public.verticals(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.media_buying_industry_map enable row level security;
drop policy if exists "staff read buying industry map" on public.media_buying_industry_map;
create policy "staff read buying industry map" on public.media_buying_industry_map for select to authenticated using (private.is_staff());

-- What Settings shows: live points by platform, industry and scope
create or replace function public.buying_insight_counts()
returns table (platform text, vertical_id uuid, scope text, attributed boolean, scoped boolean, n bigint)
language sql stable set search_path = public as $$
  select platform, vertical_id, scope, attributed_at is not null, scoped_at is not null, count(*)
  from public.media_buying_insights where merged_into is null and not excluded group by 1, 2, 3, 4, 5;
$$;
revoke all on function public.buying_insight_counts() from public, anon, authenticated;
grant execute on function public.buying_insight_counts() to service_role;
