create or replace function private.sees_all_clients()
 returns boolean language sql stable security definer set search_path to ''
as $function$
  select coalesce((
    select is_exec or is_lead or is_coordinator or is_copywriter or role::text in ('onboarding_specialist', 'tracking_specialist')
    from public.profiles where id = private.current_profile_id()
  ), false)
$function$;
