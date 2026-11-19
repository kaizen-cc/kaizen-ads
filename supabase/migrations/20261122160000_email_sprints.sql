-- Email sprints (owner, Nov 19 2026): a set scope until a day (a 1-month sprint, a Klaviyo migration), set in the
-- Services panel. It's kept like Custom (email_package_key 'custom', its numbers in email_custom) with sprint_until and
-- after (the ongoing tier it rolls into, or none). The step that ends creative sprints ends these too: past its day the
-- client moves to that tier, or holds no email allotment.
create or replace function public.expire_sprint_packages()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare n int; m int;
begin
  update public.clients
  set creative_package = false
  where creative_package and creative_package_until is not null and creative_package_until < private.ny_today();
  get diagnostics n = row_count;

  update public.clients
  set email_package_key = nullif(email_custom ->> 'after', ''),
      email_custom = null,
      email_package_set_at = now()
  where email_package_key = 'custom'
    and email_custom ? 'sprint_until'
    and (email_custom ->> 'sprint_until') ~ '^\d{4}-\d{2}-\d{2}$'
    and (email_custom ->> 'sprint_until')::date < private.ny_today();
  get diagnostics m = row_count;
  return n + m;
end $function$;

grant execute on function public.expire_sprint_packages() to service_role;
