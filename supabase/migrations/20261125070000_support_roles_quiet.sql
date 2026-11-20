-- The support positions (Client Success Coordinator, Onboarding Specialist, Tracking Specialist): nothing creative
-- reaches them, and Brand Bible notices and approvals stay dormant for them until onboarding runs through Kaizen OS
-- (app_settings.onboarding_in_os). A critical notice still rings their assistant, unless it's one of those.
insert into public.app_settings (key, value) values ('onboarding_in_os', '{"on": false}'::jsonb) on conflict (key) do nothing;

create or replace function private.heads_up_from_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if new.read_at is null and (new.priority = 'critical' or new.kind = 'direction') then
    select role::text into v_role from public.profiles where id = new.profile_id;
    if v_role in ('customer_success', 'onboarding_specialist', 'tracking_specialist')
       and (new.kind in ('direction', 'fatigue', 'ticket', 'bible') or coalesce(new.key, '') like 'bible%' or coalesce(new.key, '') like 'guideline-gap:%') then
      return new;
    end if;
    perform private.queue_heads_up(new.profile_id, 'n:' || new.key, new.title, new.body, new.href, new.client_id);
  end if;
  return new;
end $$;
