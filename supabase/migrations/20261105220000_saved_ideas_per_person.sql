-- Saved for later, per person (owner, Nov 2026): a star saves an idea for one client FOR THE PERSON who starred it, so
-- each person keeps their own "Things you've saved" in the new request flow. Several people can save the same idea for
-- the same client; once anyone briefs it (a ticket or an Asana task), every person's save of it is marked used, with who
-- and where (used_by, used_href), and the others are told once on the bell. They can dismiss the notice (dismissed_at).
-- Existing rows keep their saved_by. Stars now exist wherever a brief is offered, so more kinds of source are allowed.

alter table public.client_saved_references drop constraint if exists client_saved_references_client_id_source_ref_id_key;
alter table public.client_saved_references drop constraint if exists client_saved_references_person_key;
alter table public.client_saved_references add constraint client_saved_references_person_key unique nulls not distinct (client_id, source, ref_id, saved_by);

alter table public.client_saved_references drop constraint if exists client_saved_references_source_check;
alter table public.client_saved_references add constraint client_saved_references_source_check
  check (source in ('market', 'winner', 'pattern', 'brief', 'fatigue', 'promise', 'audit_idea', 'ai', 'idea'));

-- Who briefed it, and where the ticket (or Asana task) is
alter table public.client_saved_references add column if not exists used_by uuid references public.profiles(id) on delete set null;
alter table public.client_saved_references add column if not exists used_href text;
-- The saver closed the "already in motion" notice
alter table public.client_saved_references add column if not exists dismissed_at timestamptz;

create index if not exists client_saved_references_idea on public.client_saved_references (client_id, source, ref_id);
create index if not exists client_saved_references_mine on public.client_saved_references (saved_by, created_at desc) where dismissed_at is null;

-- A person adds and removes only their own saves; marking an idea used touches everyone's (staff who see the client)
drop policy if exists "saved references: staff add" on public.client_saved_references;
create policy "saved references: staff add" on public.client_saved_references for insert to authenticated
  with check (private.staff_can_see_client(client_id) and saved_by = private.current_profile_id());
drop policy if exists "saved references: staff remove" on public.client_saved_references;
create policy "saved references: staff remove" on public.client_saved_references for delete to authenticated
  using (private.staff_can_see_client(client_id) and used_at is null and saved_by = private.current_profile_id());

-- The bell: "An idea you saved is in motion" is an alert for the person who saved it
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;
