-- "Start a request from this" in the winners library: the strategist writes a full brief for the client someone
-- picks, as a suggestion only they (and execs and leads) see, to edit, talk through and send to production.
alter table public.creative_suggestions drop constraint creative_suggestions_kind_check;
alter table public.creative_suggestions add constraint creative_suggestions_kind_check check (kind in ('fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab', 'winner'));
alter table public.creative_suggestions add column created_by uuid references public.profiles (id);
alter table public.creative_suggestions add column source jsonb; -- the winning ad it came from

drop index public.creative_suggestions_one_open;
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id) where status = 'open' and kind not in ('lab', 'winner');

create policy "makers read own suggestions" on public.creative_suggestions for select to authenticated using (created_by = private.current_profile_id());
create policy "makers update own suggestions" on public.creative_suggestions for update to authenticated using (created_by = private.current_profile_id()) with check (created_by = private.current_profile_id());
create policy "makers read own suggestion chat" on public.suggestion_messages for select to authenticated
  using (exists (select 1 from public.creative_suggestions s where s.id = suggestion_id and s.created_by = private.current_profile_id()));
create policy "makers write own suggestion chat" on public.suggestion_messages for insert to authenticated
  with check (role = 'user' and author_id = private.current_profile_id()
    and exists (select 1 from public.creative_suggestions s where s.id = suggestion_id and s.created_by = private.current_profile_id()));
