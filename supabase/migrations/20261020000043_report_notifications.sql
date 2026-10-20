-- A buyer hears when their report draft is ready (it's work on them), through the same notifications and prefs
create or replace function private.notice_group(p_kind text)
 returns text language sql immutable as $$
  select case
    when p_kind in ('assigned', 'handoff', 'client', 'report') then 'on_you'
    when p_kind = 'ticket' then 'work'
    when p_kind in ('promise', 'fatigue', 'kpi', 'sprint') then 'clients'
    when p_kind in ('onboarding', 'newclient') then 'leadership'
    when p_kind = 'recap' then 'recap'
    else 'work' end
$$;

create or replace function private.on_report_ready() returns trigger
 language plpgsql security definer set search_path to '' as $$
declare v_client text;
begin
  if new.status = 'draft' and old.status is distinct from 'draft' and new.owner_id is not null and new.posted_at is null then
    select name into v_client from public.clients where id = new.client_id;
    perform private.notify(
      new.owner_id, 'report',
      case when new.kind = 'weekly' then v_client || ': your weekly report is drafted' else v_client || ': your part of the monthly recap is drafted' end,
      case when coalesce(new.qa->>'verdict', 'clean') = 'fix' then 'The QA found something to fix before it goes out.' when coalesce(new.qa->>'verdict', 'clean') = 'check' then 'Read it over: the QA flagged a few things to check.' else 'Read it over, tweak it if you like, and post it.' end,
      '/reports/' || new.id, new.client_id, 'report:' || new.id,
      case when new.kind = 'monthly' then 'critical' else 'normal' end);
  end if;
  return new;
end $$;
create trigger report_ready after update of status on public.reports for each row execute function private.on_report_ready();
