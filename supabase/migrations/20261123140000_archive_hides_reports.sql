-- Archiving a client also sets aside its unsent reports (Nov 23 2026: Nectr archived, its TikTok weekly still waiting
-- for review). Hidden, never deleted, and marked so restoring the client brings exactly those back. Sent reports stay.
alter table public.reports add column if not exists archive_hidden boolean not null default false;
alter table public.report_bundles add column if not exists archive_hidden boolean not null default false;

create or replace function private.archive_client(p_client uuid, p_reason text, p_source text, p_by uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_portal boolean;
  v_kpis uuid[];
  v_sugg int;
  v_fat int;
  v_prom int;
  v_reports int;
begin
  select status::text, portal_live into v_from, v_portal from public.clients where id = p_client and archived_at is null;
  if not found then return; end if;
  update public.clients
  set archived_from = status, status = 'offboarded', archived_at = now(), archived_by = p_by,
      archive_reason = nullif(trim(coalesce(p_reason, '')), ''), archive_source = p_source,
      portal_live = false
  where id = p_client;
  with k as (update public.kpi_targets set active = false, updated_at = now() where client_id = p_client and active returning id)
  select coalesce(array_agg(id), '{}') into v_kpis from k;
  with s as (update public.creative_suggestions set status = 'expired', updated_at = now() where client_id = p_client and status = 'open' returning 1)
  select count(*) into v_sugg from s;
  with f as (update public.ad_fatigue set state = 'dismissed', dismiss_reason = 'Client archived', updated_at = now() where client_id = p_client and state in ('open', 'refreshing') returning 1)
  select count(*) into v_fat from f;
  with c as (update public.call_commitments set status = 'dismissed', dismiss_reason = 'Client archived' where client_id = p_client and status in ('open', 'briefed') returning 1)
  select count(*) into v_prom from c;
  update public.client_gtm_strategies set status = case when markdown <> '' then 'draft' else 'waiting' end where client_id = p_client and status = 'building';
  -- Reports not sent yet (any line) and built bundles still collecting
  with r as (update public.reports set hidden_at = now(), archive_hidden = true where client_id = p_client and hidden_at is null and status not in ('posted', 'submitted') returning 1)
  select count(*) into v_reports from r;
  update public.report_bundles set hidden_at = now(), archive_hidden = true where client_id = p_client and hidden_at is null and status <> 'sent';
  insert into public.client_archive_events (client_id, action, reason, source, by_id, from_status, set_aside)
  values (p_client, 'archived', nullif(trim(coalesce(p_reason, '')), ''), p_source, p_by, v_from,
          jsonb_build_object('kpi_targets', to_jsonb(v_kpis), 'suggestions', v_sugg, 'fatigue', v_fat, 'commitments', v_prom, 'reports', v_reports, 'portal_live', coalesce(v_portal, false)));
end $$;

create or replace function private.restore_client(p_client uuid, p_status public.client_status, p_by uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_portal boolean;
begin
  if not exists (select 1 from public.clients where id = p_client and archived_at is not null) then return; end if;
  update public.clients
  set status = coalesce(p_status, case when archived_from in ('active', 'onboarding') then archived_from else 'active'::public.client_status end),
      archived_at = null, archived_by = null, archive_reason = null, archived_from = null, archive_source = null,
      reactivated_at = now(), reactivated_by = p_by
  where id = p_client;
  update public.kpi_targets set active = true, updated_at = now()
  where client_id = p_client and not active and id in (
    select (jsonb_array_elements_text(set_aside -> 'kpi_targets'))::uuid from public.client_archive_events
    where client_id = p_client and action = 'archived' and jsonb_typeof(set_aside -> 'kpi_targets') = 'array');
  -- The reports archiving set aside come back (anything hidden by hand stays hidden)
  update public.reports set hidden_at = null, archive_hidden = false where client_id = p_client and archive_hidden;
  update public.report_bundles set hidden_at = null, archive_hidden = false where client_id = p_client and archive_hidden;
  select (set_aside ->> 'portal_live')::boolean into v_portal from public.client_archive_events
  where client_id = p_client and action = 'archived' order by at desc limit 1;
  if v_portal then update public.clients set portal_live = true where id = p_client; end if;
  insert into public.client_archive_events (client_id, action, by_id, source)
  values (p_client, 'restored', p_by, case when p_by is null then 'system' else 'team' end);
end $$;

-- Clients already archived: their unsent reports set aside now
update public.reports r set hidden_at = now(), archive_hidden = true
from public.clients c where c.id = r.client_id and c.archived_at is not null and r.hidden_at is null and r.status not in ('posted', 'submitted');
update public.report_bundles b set hidden_at = now(), archive_hidden = true
from public.clients c where c.id = b.client_id and c.archived_at is not null and b.hidden_at is null and b.status <> 'sent';
