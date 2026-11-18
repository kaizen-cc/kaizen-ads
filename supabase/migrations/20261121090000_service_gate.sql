-- One service gate (owner's request, Nov 18 2026): a client's services decide everywhere whether the team does anything
-- for a line. The app's gate is src/lib/service-gate.ts; this is the same for triggers, cron SQL and RPC callers.
-- Nothing is deleted or archived: the gate hides and skips, so adding the service back brings everything back.
-- Safe to run twice.

-- A line (meta, google, tiktok, creative, email, social, web, crm) as its service slug (src/lib/services.ts)
create or replace function private.line_service(p_line text) returns text language sql immutable as $$
  select case lower(coalesce(p_line, ''))
    when 'meta' then 'facebook-ads'
    when 'facebook' then 'facebook-ads'
    when 'google' then 'google-ads'
    when 'tiktok' then 'tiktok-ads'
    when 'creative' then 'creative'
    when 'email' then 'email-marketing'
    when 'klaviyo' then 'email-marketing'
    when 'social' then 'social-media'
    when 'web' then 'web-design'
    when 'crm' then 'crm'
    else null
  end
$$;

-- Whether a client buys a line: Track's services plus the added, minus the removed (private.client_services)
create or replace function public.client_has_line(p_client uuid, p_line text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select private.line_service(p_line) = any(private.client_services(c))
      from public.clients c where c.id = p_client
  ), false)
$$;
revoke all on function public.client_has_line(uuid, text) from public, anon;
grant execute on function public.client_has_line(uuid, text) to authenticated, service_role;
comment on function public.client_has_line(uuid, text) is 'The service gate (src/lib/service-gate.ts): whether the client buys this line';

-- The ids of the clients that buy a line, for cron and RPC callers (one query, no per-row checks)
create or replace function public.clients_with_line(p_line text) returns setof uuid
language sql stable security definer set search_path = public as $$
  select c.id from public.clients c where private.line_service(p_line) = any(private.client_services(c))
$$;
revoke all on function public.clients_with_line(text) from public, anon;
grant execute on function public.clients_with_line(text) to authenticated, service_role;

-- The off-target alert never fires for a line the client no longer buys (otherwise as 20261110120000_kpi_needs_target)
create or replace function private.notify_kpi() returns trigger language plpgsql security definer set search_path = '' as $$
declare t public.kpi_targets; v_client text; v_slug text; v_high boolean; p uuid;
begin
  if new.status::text = 'off' and (tg_op = 'INSERT' or old.status::text is distinct from 'off') then
    select * into t from public.kpi_targets where id = new.target_id;
    if t.id is null or not t.active or t.target is null then return new; end if;
    if not public.client_has_line(t.client_id, t.platform) then return new; end if;
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
