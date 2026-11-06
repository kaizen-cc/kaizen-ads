-- Ad Creative in the client's Drive, organized by avatar then angle (Nov 6 2026):
-- Ad Creative / <Avatar> / <Angle> / <YYYY-MM Concept> / <Client> - <Concept> - V2 - 4x5.png
-- (no avatar: "_Not tied to an avatar"; an avatar under test: "_Avatar tests / <Avatar>"; no angle: "_No angle";
-- format and size live in the file name; "_Replaced" stays inside the concept folder).
--
-- drive_path is the concept folder (under Ad Creative) a synced file sits in. Null means "check where it is": every file
-- synced under the first layout (Year / Month / Concept / Format) starts null, and editing a ticket's avatar, angle or
-- title (or renaming its angle) sets it back to null, so the creative_drive cron step moves the file (never re-uploads
-- or deletes it). Empty string: no ticket to place it by, left where it is.

alter table public.creative_drive_files add column if not exists drive_path text;
comment on column public.creative_drive_files.drive_path is 'The concept folder path under Ad Creative this Drive file sits in (avatar/angle/YYYY-MM concept); null until checked or after the ticket''s avatar, angle or title changed';

create index if not exists creative_drive_files_relayout on public.creative_drive_files (updated_at)
  where drive_path is null and drive_file_id is not null and status in ('synced', 'retired');

create or replace function private.creative_drive_relayout_request()
 returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.avatar is distinct from old.avatar
    or new.avatar_test is distinct from old.avatar_test
    or new.angle_id is distinct from old.angle_id
    or new.title is distinct from old.title then
    update public.creative_drive_files set drive_path = null
     where request_id = new.id and drive_path is not null and drive_file_id is not null;
  end if;
  return new;
end $$;

drop trigger if exists creative_drive_relayout on public.requests;
create trigger creative_drive_relayout after update of avatar, avatar_test, angle_id, title on public.requests
  for each row execute function private.creative_drive_relayout_request();

create or replace function private.creative_drive_relayout_angle()
 returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.name is distinct from old.name then
    update public.creative_drive_files f set drive_path = null
      from public.requests r
     where r.angle_id = new.id and f.request_id = r.id and f.drive_path is not null and f.drive_file_id is not null;
  end if;
  return new;
end $$;

drop trigger if exists creative_drive_relayout on public.angles;
create trigger creative_drive_relayout after update of name on public.angles
  for each row execute function private.creative_drive_relayout_angle();

revoke all on function private.creative_drive_relayout_request() from public, anon, authenticated;
revoke all on function private.creative_drive_relayout_angle() from public, anon, authenticated;
