-- Promises and owed replies can be closed from the notice itself ("It's handled", "Add context", a reply to the
-- email): what the team told us is kept on the item and read by the follow-through. Promises said with no client
-- are matched again each pass against today's clients; how it was matched is kept.

alter table public.message_promises
  add column if not exists team_context jsonb not null default '[]'::jsonb,
  add column if not exists client_match text,          -- name | ai | person
  add column if not exists client_matched_at timestamptz;

alter table public.owed_replies
  add column if not exists team_context jsonb not null default '[]'::jsonb;

-- The Crust pilot promise (Nov 2, by email) was said an hour before the client "Crust Pizza - Gleannloch Farms" was
-- added, as "Glenlock Farms". The new matcher finds it; set here so the next pass reads its onboarding at once.
update public.message_promises p
   set client_id = c.id, client_match = 'name', client_matched_at = now()
  from public.clients c
 where p.id = '332c31bf-a2ae-43e0-829e-03fe58c5ed16'
   and p.client_id is null
   and c.name = 'Crust Pizza - Gleannloch Farms'
   and c.archived_at is null;
