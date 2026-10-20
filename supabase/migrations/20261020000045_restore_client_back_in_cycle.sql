-- Archiving remembers whether the client portal was on; restoring always lands on a live status (a client archived
-- while paused comes back active) and turns back on every KPI target any archive set aside, and the portal.
-- Applied via MCP; see private.archive_client / private.restore_client in the database for the full bodies.
create or replace function private.restore_client(p_client uuid, p_status client_status, p_by uuid)
 returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_portal boolean;
begin
  if not exists (select 1 from public.clients where id = p_client and archived_at is not null) then return; end if;
  update public.clients
  set status = coalesce(p_status, case when archived_from in ('active', 'onboarding') then archived_from else 'active'::public.client_status end),
      archived_at = null, archived_by = null, archive_reason = null, archived_from = null, archive_source = null
  where id = p_client;
  update public.kpi_targets set active = true, updated_at = now()
  where client_id = p_client and not active and id in (
    select (jsonb_array_elements_text(set_aside -> 'kpi_targets'))::uuid from public.client_archive_events
    where client_id = p_client and action = 'archived' and jsonb_typeof(set_aside -> 'kpi_targets') = 'array');
  select (set_aside ->> 'portal_live')::boolean into v_portal from public.client_archive_events
  where client_id = p_client and action = 'archived' order by at desc limit 1;
  if v_portal then update public.clients set portal_live = true where id = p_client; end if;
  insert into public.client_archive_events (client_id, action, by_id, source)
  values (p_client, 'restored', p_by, case when p_by is null then 'system' else 'team' end);
end $function$;
