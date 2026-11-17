-- The other teams someone works on, as badges on the Team page (Nov 2026), instead of one "also works on" switch per
-- position. Their own team comes from their role; these are the extra ones (ads, email, social), each letting them
-- hold that team's seats that fit their craft (src/lib/roles.ts canHold). The old switches stay in step for anything
-- still reading them: social on = also_social, email on = also_designs_email. Additive: nobody loses a seat.

alter table public.profiles add column if not exists teams text[] not null default '{}';

do $$ begin
  alter table public.profiles add constraint profiles_teams_check check (teams <@ array['ads', 'email', 'social']::text[]);
exception when duplicate_object then null; end $$;

comment on column public.profiles.teams is 'The teams someone also works on beyond their role''s own (ads, email, social), shown as badges on the Team page';

update public.profiles
   set teams = array(select distinct t from unnest(teams || case when also_social then array['social'] else array[]::text[] end || case when also_designs_email then array['email'] else array[]::text[] end) t order by t)
 where also_social or also_designs_email;
