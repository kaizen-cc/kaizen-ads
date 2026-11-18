-- Profiles for everyone on the team, and each person's own name for their assistant.
-- Written only by server actions for the signed-in person's own row (the same way the theme and the assistant's voice
-- and color are saved): no new policies on profiles. Reading is covered by the existing "staff read team" policy, so
-- teammates see each other's names, pictures, titles and bios (profiles are staff-wide, not client data).
--   display_name        what they go by (null: their full name)
--   title               their job title
--   bio                 a few lines about them
--   start_date          the day they started at Kaizen (tenure is worked out from it)
--   avatar_url          already there: now the public URL of their picture in the 'avatars' bucket
--   profile_seeded_at   when the first import from Slack ran. Set once; after it Slack is never read to fill or
--                       overwrite anything unless the person presses "Import from Slack" on one field
--   slack_user_id       their Slack user, found at the seed (used by the per-field re-import)
--   assistant_name      what they call their assistant (null: "Assistant")

alter table public.profiles
  add column if not exists display_name text check (display_name is null or char_length(display_name) <= 60),
  add column if not exists title text check (title is null or char_length(title) <= 80),
  add column if not exists bio text check (bio is null or char_length(bio) <= 500),
  add column if not exists start_date date,
  add column if not exists profile_seeded_at timestamptz,
  add column if not exists slack_user_id text,
  add column if not exists assistant_name text check (assistant_name is null or char_length(assistant_name) between 1 and 24);

-- Profile pictures: public read (shown in lists), written only through the server (the service role)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- A short spoken sample for each voice that has none of its own (made once, kept here so it costs once): private,
-- read and written only by the server
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-samples', 'voice-samples', false, 1048576, array['audio/mpeg'])
on conflict (id) do nothing;
