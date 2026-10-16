-- Archiving a client sets aside everything tied to them, and every archive and restore is logged (who, when, why,
-- what was set aside), so the client page can be looked at later and the client restored exactly as they were.

create table public.client_archive_events (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  action       text not null check (action in ('archived', 'restored')),
  reason       text,
  source       text,                -- team, track, zapier
  by_id        uuid references public.profiles(id) on delete set null,
  from_status  text,                -- the status before archiving (what restoring returns to)
  set_aside    jsonb not null default '{}', -- { kpi_targets: [ids], commitments: n, suggestions: n, fatigue: n }
  at           timestamptz not null default now()
);
create index client_archive_events_client on public.client_archive_events (client_id, at desc);
alter table public.client_archive_events enable row level security;
create policy "staff read archive log" on public.client_archive_events for select to authenticated
  using (private.is_exec_or_lead() or private.staff_can_see_client(client_id));

create or replace function private.archive_client(p_client uuid, p_reason text, p_source text, p_by uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_kpis uuid[];
  v_sugg int;
  v_fat int;
  v_prom int;
begin
  select status::text into v_from from public.clients where id = p_client and archived_at is null;
  if not found then return; end if; -- already archived
  update public.clients
  set archived_from = status, status = 'offboarded', archived_at = now(), archived_by = p_by,
      archive_reason = nullif(trim(coalesce(p_reason, '')), ''), archive_source = p_source,
      portal_live = false -- their contacts lose access; restoring doesn't switch it back on by itself
  where id = p_client;
  -- Set aside, not deleted: KPI targets stop tracking, open briefs and promises close, the watch list clears
  with k as (update public.kpi_targets set active = false, updated_at = now() where client_id = p_client and active returning id)
  select coalesce(array_agg(id), '{}') into v_kpis from k;
  with s as (update public.creative_suggestions set status = 'expired', updated_at = now() where client_id = p_client and status = 'open' returning 1)
  select count(*) into v_sugg from s;
  with f as (update public.ad_fatigue set state = 'dismissed', dismiss_reason = 'Client archived', updated_at = now() where client_id = p_client and state in ('open', 'refreshing') returning 1)
  select count(*) into v_fat from f;
  with c as (update public.call_commitments set status = 'dismissed', dismiss_reason = 'Client archived' where client_id = p_client and status in ('open', 'briefed') returning 1)
  select count(*) into v_prom from c;
  update public.client_gtm_strategies set status = case when markdown <> '' then 'draft' else 'waiting' end where client_id = p_client and status = 'building';
  insert into public.client_archive_events (client_id, action, reason, source, by_id, from_status, set_aside)
  values (p_client, 'archived', nullif(trim(coalesce(p_reason, '')), ''), p_source, p_by, v_from,
          jsonb_build_object('kpi_targets', to_jsonb(v_kpis), 'suggestions', v_sugg, 'fatigue', v_fat, 'commitments', v_prom));
end $$;

drop function if exists public.restore_client(uuid);
drop function if exists public.system_restore_client(uuid, public.client_status);
drop function if exists private.restore_client(uuid, public.client_status);

create function private.restore_client(p_client uuid, p_status public.client_status, p_by uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_kpis jsonb;
begin
  if not exists (select 1 from public.clients where id = p_client and archived_at is not null) then return; end if;
  update public.clients
  set status = coalesce(p_status, archived_from, 'active'), archived_at = null, archived_by = null, archive_reason = null,
      archived_from = null, archive_source = null
  where id = p_client;
  -- The KPI targets that were tracking when they were archived track again
  select set_aside -> 'kpi_targets' into v_kpis from public.client_archive_events
  where client_id = p_client and action = 'archived' order by at desc limit 1;
  if v_kpis is not null then
    update public.kpi_targets set active = true, updated_at = now()
    where client_id = p_client and id in (select (jsonb_array_elements_text(v_kpis))::uuid);
  end if;
  insert into public.client_archive_events (client_id, action, by_id, source)
  values (p_client, 'restored', p_by, case when p_by is null then 'system' else 'team' end);
end $$;

create function public.restore_client(p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_exec_or_lead() then raise exception 'Only execs and leads can restore a client'; end if;
  perform private.restore_client(p_client, null, private.current_profile_id());
end $$;
create function public.system_restore_client(p_client uuid, p_status public.client_status) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.restore_client(p_client, p_status, null);
end $$;
revoke execute on function private.restore_client(uuid, public.client_status, uuid) from public, anon, authenticated;
revoke execute on function public.restore_client(uuid) from public, anon;
grant execute on function public.restore_client(uuid) to authenticated;
revoke execute on function public.system_restore_client(uuid, public.client_status) from public, anon, authenticated;
grant execute on function public.system_restore_client(uuid, public.client_status) to service_role;

-- Clients archived before this: their archive goes in the log, and anything still running for them is set aside
insert into public.client_archive_events (client_id, action, reason, source, by_id, from_status, at, set_aside)
select c.id, 'archived', c.archive_reason, c.archive_source, c.archived_by, c.archived_from::text, c.archived_at,
       jsonb_build_object('kpi_targets', coalesce((select jsonb_agg(k.id) from public.kpi_targets k where k.client_id = c.id and k.active), '[]'::jsonb))
from public.clients c where c.archived_at is not null;
update public.kpi_targets k set active = false, updated_at = now() from public.clients c where c.id = k.client_id and c.archived_at is not null and k.active;
update public.call_commitments m set status = 'dismissed', dismiss_reason = 'Client archived' from public.clients c where c.id = m.client_id and c.archived_at is not null and m.status in ('open', 'briefed');
update public.ad_fatigue f set state = 'dismissed', dismiss_reason = 'Client archived', updated_at = now() from public.clients c where c.id = f.client_id and c.archived_at is not null and f.state in ('open', 'refreshing');
