-- One Meta ad account per client, the same everywhere: the client page (clients.meta_ad_account_id) and the KPI board
-- (kpi_targets.ad_account_id for Meta) kept each other's copy, saved from different screens, and drifted apart (a KPI
-- "needs the ad account" while Team & setup showed it). Now whichever is set, the other follows:
-- - the client's account set or changed: Meta KPIs with no account, or with the old one, take the new one;
-- - a Meta KPI's account set or changed: the client takes it when it had none, or had the old one.
-- A client with several Meta KPIs on different accounts keeps them (only empty or matching ones follow).

create or replace function private.digits(t text) returns text language sql immutable as $$ select nullif(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '') $$;

create or replace function private.sync_client_meta_account() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if private.digits(new.meta_ad_account_id) is not null and private.digits(new.meta_ad_account_id) is distinct from private.digits(old.meta_ad_account_id) then
    update public.kpi_targets t
       set ad_account_id = private.digits(new.meta_ad_account_id)
     where t.client_id = new.id and t.platform = 'meta'
       and (private.digits(t.ad_account_id) is null or private.digits(t.ad_account_id) = private.digits(old.meta_ad_account_id));
  end if;
  return new;
end $$;

drop trigger if exists clients_meta_account_sync on public.clients;
create trigger clients_meta_account_sync after update of meta_ad_account_id on public.clients
  for each row execute function private.sync_client_meta_account();

create or replace function private.sync_kpi_meta_account() returns trigger language plpgsql security definer set search_path = public as $$
declare was text := case when tg_op = 'UPDATE' then private.digits(old.ad_account_id) else null end;
begin
  if new.platform = 'meta' and private.digits(new.ad_account_id) is not null and private.digits(new.ad_account_id) is distinct from was then
    update public.clients c
       set meta_ad_account_id = private.digits(new.ad_account_id)
     where c.id = new.client_id
       and (private.digits(c.meta_ad_account_id) is null or private.digits(c.meta_ad_account_id) = was);
  end if;
  return new;
end $$;

drop trigger if exists kpi_targets_meta_account_sync on public.kpi_targets;
create trigger kpi_targets_meta_account_sync after insert or update of ad_account_id on public.kpi_targets
  for each row execute function private.sync_kpi_meta_account();

-- What's out of step today
update public.kpi_targets t
   set ad_account_id = private.digits(c.meta_ad_account_id)
  from public.clients c
 where c.id = t.client_id and t.platform = 'meta' and private.digits(t.ad_account_id) is null and private.digits(c.meta_ad_account_id) is not null;

update public.clients c
   set meta_ad_account_id = x.acct
  from (select distinct on (client_id) client_id, private.digits(ad_account_id) as acct from public.kpi_targets
         where platform = 'meta' and active and private.digits(ad_account_id) is not null order by client_id, created_at) x
 where x.client_id = c.id and private.digits(c.meta_ad_account_id) is null;
