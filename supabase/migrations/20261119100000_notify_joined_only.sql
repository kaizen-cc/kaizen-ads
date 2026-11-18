-- Notifications only ever reach people who use Kaizen OS: active and joined (signed in at least once). private.notify
-- already checked this, but notices written straight from the app (direction changes, owed replies, approvals, the
-- assistant) didn't, so teammates without access got bell rows and emails. A trigger now drops any notification for
-- someone who isn't active and joined, whichever path writes it. Pending ones for those people are cleared and marked
-- emailed so the email step never sends them.

create or replace function private.notifications_joined_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles p where p.id = new.profile_id and p.is_active and p.joined_at is not null) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists notifications_joined_only on public.notifications;
create trigger notifications_joined_only
  before insert on public.notifications
  for each row execute function private.notifications_joined_only();

update public.notifications n
   set cleared_at = coalesce(n.cleared_at, now()), emailed_at = coalesce(n.emailed_at, now())
 where (n.cleared_at is null or n.emailed_at is null)
   and not exists (select 1 from public.profiles p where p.id = n.profile_id and p.is_active and p.joined_at is not null);
