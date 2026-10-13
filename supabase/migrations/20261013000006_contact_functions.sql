-- Kaizen Ads — add/remove a client contact.
-- A contact can belong to several brands, and the same email may already exist for another brand
-- the caller can't see, so linking goes through these checked functions instead of raw inserts.
-- Allowed: execs, leads, the coordinator and the copywriter (people who work across every client).

create function public.add_client_contact(p_client uuid, p_email text, p_name text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_id    uuid;
begin
  if not private.sees_all_clients() then
    raise exception 'Only execs, leads, the coordinator or the copywriter can add client contacts';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if v_email like '%@kaizenmarketing.agency' then
    raise exception 'Kaizen team members are added on the Team page, not as client contacts';
  end if;
  if not exists (select 1 from public.clients where id = p_client) then
    raise exception 'Client not found';
  end if;

  insert into public.contacts (email, full_name)
  values (v_email, nullif(trim(p_name), ''))
  on conflict (email) do update
    set full_name = coalesce(public.contacts.full_name, excluded.full_name),
        is_active = true
  returning id into v_id;

  insert into public.contact_clients (contact_id, client_id, is_primary)
  values (v_id, p_client, not exists (select 1 from public.contact_clients where client_id = p_client))
  on conflict do nothing;

  return v_id;
end $$;

create function public.remove_client_contact(p_client uuid, p_contact uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.sees_all_clients() then
    raise exception 'Only execs, leads, the coordinator or the copywriter can remove client contacts';
  end if;
  delete from public.contact_clients where client_id = p_client and contact_id = p_contact;
end $$;

revoke execute on function public.add_client_contact(uuid, text, text) from public, anon;
revoke execute on function public.remove_client_contact(uuid, uuid) from public, anon;
grant execute on function public.add_client_contact(uuid, text, text) to authenticated;
grant execute on function public.remove_client_contact(uuid, uuid) to authenticated;
