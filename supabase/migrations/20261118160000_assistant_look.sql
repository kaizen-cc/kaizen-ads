-- Each person's own assistant: the voice it speaks in and its color, chosen on the Assistant page. Only ever theirs:
-- it never changes anyone else's assistant, or the voice set for the assistant on the AI agents page (the fallback).
-- Written only by the server actions on the Assistant page, for the signed-in person's own row (the same way the
-- theme is saved): no new policies, and the person's session still can't update profiles directly (execs manage the
-- team as before). Reading them is covered by the existing "staff read team" policy.
-- assistant_voice: an ElevenLabs voice id (null: the assistant's voice for everyone).
-- assistant_color: one of the Assistant page's swatches as a lowercase hex (null: the default orchid).

alter table public.profiles
  add column if not exists assistant_voice text check (assistant_voice is null or assistant_voice ~ '^[A-Za-z0-9]{8,40}$'),
  add column if not exists assistant_color text check (assistant_color is null or assistant_color ~ '^#[0-9a-f]{6}$');
