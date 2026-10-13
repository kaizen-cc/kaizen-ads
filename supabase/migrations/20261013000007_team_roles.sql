-- Kaizen Ads — one role per person, three access tiers.
--   Executives:  executive
--   Leaders:     head_of_meta, head_of_creative, head_of_google
--   Team:        media_buyer, google_buyer, graphic_designer, video_editor, copywriter, customer_success
-- The old checkbox flags become columns computed from the role, so every access rule keeps working.

create type public.team_role as enum (
  'executive',
  'head_of_meta', 'head_of_creative', 'head_of_google',
  'media_buyer', 'google_buyer', 'graphic_designer', 'video_editor', 'copywriter', 'customer_success'
);

alter table public.profiles add column role public.team_role;

update public.profiles set role = case
  when is_exec then 'executive'
  when is_lead and is_creative then 'head_of_creative'
  when is_lead then 'head_of_meta'
  when is_copywriter then 'copywriter'
  when is_coordinator then 'customer_success'
  when is_buyer then 'media_buyer'
  when email in ('jazem@kaizenmarketing.agency', 'mira@kaizenmarketing.agency', 'daniel@kaizenmarketing.agency') then 'video_editor'
  when is_creative then 'graphic_designer'
  else 'customer_success'
end::public.team_role;

alter table public.profiles alter column role set not null;
alter table public.profiles alter column role set default 'media_buyer';

alter table public.profiles
  drop column is_exec, drop column is_lead, drop column is_creative,
  drop column is_buyer, drop column is_copywriter, drop column is_coordinator;

alter table public.profiles
  add column is_exec        boolean generated always as (role = 'executive') stored,
  add column is_lead        boolean generated always as (role in ('head_of_meta', 'head_of_creative', 'head_of_google')) stored,
  add column is_creative    boolean generated always as (role in ('graphic_designer', 'video_editor', 'head_of_creative')) stored,
  add column is_buyer       boolean generated always as (role in ('media_buyer', 'head_of_meta')) stored,
  add column is_copywriter  boolean generated always as (role = 'copywriter') stored,
  add column is_coordinator boolean generated always as (role = 'customer_success') stored;

-- Leaders (Head of Meta / Creative / Google) can assign and reassign people on clients, not just execs.
drop policy "execs manage assignments" on public.client_assignments;
create policy "execs and leaders manage assignments" on public.client_assignments for all to authenticated
  using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());

-- Dipesh leads Meta buying (Track: Meta Buyer lead)
update public.profiles set role = 'head_of_meta' where email = 'dipesh@kaizenmarketing.agency';
