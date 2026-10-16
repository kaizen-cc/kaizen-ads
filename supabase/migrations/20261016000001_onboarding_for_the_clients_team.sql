-- A client's first round is for their team too: whoever works on the client (their media buyer, say) can open it,
-- edit it and send it, like execs and leads.
create policy "client team reads first round" on public.creative_suggestions for select to authenticated
  using (kind = 'onboarding' and private.staff_can_see_client(client_id));
create policy "client team edits first round" on public.creative_suggestions for update to authenticated
  using (kind = 'onboarding' and private.staff_can_see_client(client_id)) with check (kind = 'onboarding' and private.staff_can_see_client(client_id));
create policy "client team reads first round chat" on public.suggestion_messages for select to authenticated
  using (exists (select 1 from public.creative_suggestions s where s.id = suggestion_id and s.kind = 'onboarding' and private.staff_can_see_client(s.client_id)));
create policy "client team writes first round chat" on public.suggestion_messages for insert to authenticated
  with check (role = 'user' and author_id = private.current_profile_id()
    and exists (select 1 from public.creative_suggestions s where s.id = suggestion_id and s.kind = 'onboarding' and private.staff_can_see_client(s.client_id)));
