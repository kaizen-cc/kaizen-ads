-- Each person's board shows only their clients: the Asana mirror follows the same rule as tickets (execs, leads, the
-- coordinator and the copywriter see everything; everyone else their assigned clients, plus any Asana task assigned to
-- them). Google buyers get their own per-client slot, filled from the Account Overview sheet's Google tab.
alter type public.assignment_role add value if not exists 'google_buyer';

drop policy "staff read asana mirror" on public.asana_tasks;
create policy "staff read asana tasks for their clients" on public.asana_tasks for select to authenticated
  using (private.is_staff() and (private.sees_all_clients() or (client_id is not null and private.can_see_client(client_id)) or profile_id = private.current_profile_id()));
