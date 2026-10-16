-- Refresh briefs are written ahead for every ad on the watch list: the client's team reads and works them, like first rounds and call briefs
drop policy "client team reads team briefs" on public.creative_suggestions;
drop policy "client team edits team briefs" on public.creative_suggestions;
drop policy "client team reads team brief chat" on public.suggestion_messages;
drop policy "client team writes team brief chat" on public.suggestion_messages;
create policy "client team reads team briefs" on public.creative_suggestions for select to authenticated
  using (kind in ('onboarding', 'call', 'refresh') and private.staff_can_see_client(client_id));
create policy "client team edits team briefs" on public.creative_suggestions for update to authenticated
  using (kind in ('onboarding', 'call', 'refresh') and private.staff_can_see_client(client_id)) with check (kind in ('onboarding', 'call', 'refresh') and private.staff_can_see_client(client_id));
create policy "client team reads team brief chat" on public.suggestion_messages for select to authenticated
  using (exists (select 1 from public.creative_suggestions s where s.id = suggestion_id and s.kind in ('onboarding', 'call', 'refresh') and private.staff_can_see_client(s.client_id)));
create policy "client team writes team brief chat" on public.suggestion_messages for insert to authenticated
  with check (role = 'user' and author_id = private.current_profile_id()
    and exists (select 1 from public.creative_suggestions s where s.id = suggestion_id and s.kind in ('onboarding', 'call', 'refresh') and private.staff_can_see_client(s.client_id)));
