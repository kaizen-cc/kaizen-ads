-- Who is always copied on a client's report email (weekly reports and recaps), besides the media buyers on the account.
-- Execs edit it in Settings > Team: app_settings key 'report_cc', value {"profileIds": [...]}.
-- Seeded with the active staff whose first name is Kyle, Ryan or Santi (matched by name, not by id).
insert into public.app_settings (key, value, updated_at)
select 'report_cc', jsonb_build_object('profileIds', coalesce(jsonb_agg(p.id order by p.full_name), '[]'::jsonb)), now()
from public.profiles p
where p.is_active
  and (p.full_name ilike 'Kyle%' or p.full_name ilike 'Ryan%' or p.full_name ilike 'Santi%')
on conflict (key) do nothing;
