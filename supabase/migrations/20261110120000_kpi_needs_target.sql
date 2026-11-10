-- Every client running ads has a real KPI card (owner's request, Nov 10 2026). A client with the Meta (facebook-ads)
-- or Google (google-ads) service and no active KPI on that platform gets one: no target and no budget yet, owned by
-- the primary buyer on that seat, and marked needs_target. The card shows every number, chart and campaign like any
-- other, only neutral (no colors, no "off target", no audits) until someone sets the KPI, which clears the mark.
-- TikTok cards come from linking the advertiser (src/lib/tiktok/store.ts), so they're covered once linked.
-- Safe to run twice.

alter table public.kpi_targets add column if not exists needs_target boolean not null default false;
comment on column public.kpi_targets.needs_target is 'Made automatically for a client running ads with no KPI; cleared when a target is set';

-- A client's services as the app reads them (src/lib/services.ts servicesOf): Track's plus the added, minus the removed
create or replace function private.client_services(c public.clients) returns text[] language sql immutable as $$
  select coalesce(array(
    select s from unnest(coalesce(c.services, '{}') || coalesce(c.services_extra, '{}')) s
    except
    select r from unnest(coalesce(c.services_removed, '{}')) r
  ), '{}')
$$;

-- The KPI cards a client is missing: one per ad platform it buys with no active KPI there. Idempotent.
create or replace function private.ensure_client_kpis(p_client uuid) returns integer language plpgsql security definer set search_path = public as $$
declare c public.clients; svc text[]; n integer := 0; k integer;
begin
  select * into c from public.clients where id = p_client;
  if c.id is null or c.archived_at is not null or c.status::text not in ('active', 'onboarding') then return 0; end if;
  svc := private.client_services(c);

  if 'facebook-ads' = any(svc) then
    insert into public.kpi_targets (client_id, platform, ad_account_id, conversion, target, monthly_budget, owner_id, source, needs_target)
    select c.id, 'meta', private.digits(c.meta_ad_account_id), 'campaign_goal', null, null,
           (select a.profile_id from public.client_assignments a
             where a.client_id = c.id and a.role::text = 'meta_buyer' order by a.is_primary desc, a.created_at limit 1),
           'strategy', true
     where not exists (select 1 from public.kpi_targets t where t.client_id = c.id and t.platform = 'meta' and t.active);
    get diagnostics k = row_count; n := n + k;
  end if;

  if 'google-ads' = any(svc) then
    insert into public.kpi_targets (client_id, platform, ad_account_id, conversion, target, monthly_budget, owner_id, source, needs_target)
    select c.id, 'google',
           -- The Google customer ID we already know from an old KPI, else none yet
           (select t.ad_account_id from public.kpi_targets t
             where t.client_id = c.id and t.platform = 'google' and private.digits(t.ad_account_id) is not null
             order by t.updated_at desc limit 1),
           'campaign_goal', null, null,
           (select a.profile_id from public.client_assignments a
             where a.client_id = c.id and a.role::text = 'google_buyer' order by a.is_primary desc, a.created_at limit 1),
           'strategy', true
     where not exists (select 1 from public.kpi_targets t where t.client_id = c.id and t.platform = 'google' and t.active);
    get diagnostics k = row_count; n := n + k;
  end if;

  return n;
end $$;
revoke all on function private.ensure_client_kpis(uuid) from public, anon;

-- Going forward: whenever a client gains a service, becomes active or onboarding, or comes back from the archive
create or replace function private.client_kpis_on_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform private.ensure_client_kpis(new.id);
  return new;
end $$;

drop trigger if exists clients_ensure_kpis on public.clients;
create trigger clients_ensure_kpis after insert or update of services, services_extra, services_removed, status, archived_at on public.clients
  for each row execute function private.client_kpis_on_change();

-- Setting a target clears the mark, from wherever it's saved
create or replace function private.kpi_target_set() returns trigger language plpgsql as $$
begin
  if new.target is not null then new.needs_target := false; end if;
  return new;
end $$;

drop trigger if exists kpi_targets_target_set on public.kpi_targets;
create trigger kpi_targets_target_set before insert or update of target on public.kpi_targets
  for each row execute function private.kpi_target_set();

-- Once, for everyone today
select private.ensure_client_kpis(c.id) from public.clients c where c.archived_at is null and c.status::text in ('active', 'onboarding');

-- A KPI with no target is never judged: no colors from the industry benchmark, never "off target"
update public.kpi_snapshots s
   set status = 'unset', deviation = null
  from public.kpi_targets t
 where t.id = s.target_id and t.target is null and coalesce(s.status, '') not in ('setup', 'unset');

-- And the off-target alert never fires for one
create or replace function private.notify_kpi() returns trigger language plpgsql security definer set search_path = '' as $$
declare t public.kpi_targets; v_client text; v_slug text; v_high boolean; p uuid;
begin
  if new.status::text = 'off' and (tg_op = 'INSERT' or old.status::text is distinct from 'off') then
    select * into t from public.kpi_targets where id = new.target_id;
    if t.id is null or not t.active or t.target is null then return new; end if;
    select name, slug into v_client, v_slug from public.clients where id = t.client_id;
    v_high := lower(coalesce(t.sheet->>'priority', '')) = 'high';
    if t.owner_id is not null then
      for p in select t.owner_id union select * from private.secondary_buyers(t.client_id, t.platform) loop
        perform private.notify(p, 'kpi', format('%s went off target', v_client), format('%s%% off its KPI target. Worth a look before it slides further.', round(coalesce(new.deviation, 0) * 100)),
          format('/kpis?client=%s', v_slug), t.client_id, format('off:%s:%s', t.id, to_char(now(), 'YYYY-MM-DD')), case when v_high then 'critical' else 'normal' end);
      end loop;
    end if;
    if v_high then
      for p in select * from private.managers() loop
        perform private.notify(p, 'kpi', format('%s (high priority) went off target', v_client), format('%s%% off its KPI target.', round(coalesce(new.deviation, 0) * 100)),
          format('/kpis?client=%s', v_slug), t.client_id, format('off:%s:%s', t.id, to_char(now(), 'YYYY-MM-DD')), 'critical');
      end loop;
    end if;
  end if;
  return new;
end $$;
