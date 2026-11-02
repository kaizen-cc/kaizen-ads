-- Execs only: put a client on an ongoing creative package (no end date) from the client page, with its allotment
create or replace function public.set_ongoing_package(p_client uuid, p_package text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_pkg public.creative_packages;
begin
  if not private.is_exec() then raise exception 'Only an exec can change a client''s creative package'; end if;
  select * into v_pkg from public.creative_packages where key = p_package;
  if v_pkg.key is null then raise exception 'Unknown package'; end if;
  update public.clients
  set creative_package = true,
      creative_package_until = null,
      creative_package_key = v_pkg.key,
      creative_package_note = null,
      creative_package_set_by = private.current_profile_id(),
      creative_package_set_at = now()
  where id = p_client;
  insert into public.client_allotments (client_id, images_per_month, videos_per_month, updated_by, updated_at)
  values (p_client, greatest(coalesce(v_pkg.images, 0), 0), greatest(coalesce(v_pkg.videos, 0), 0), private.current_profile_id(), now())
  on conflict (client_id) do update
  set images_per_month = excluded.images_per_month, videos_per_month = excluded.videos_per_month, updated_by = excluded.updated_by, updated_at = now();
end $$;
revoke execute on function public.set_ongoing_package(uuid, text) from public, anon;
grant execute on function public.set_ongoing_package(uuid, text) to authenticated;
