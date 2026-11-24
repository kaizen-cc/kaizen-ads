-- Each person's own Overview widgets (owner, Nov 24 2026): an ordered list of widget ids from the gallery
-- (src/lib/widgets-core.ts). Saved by the server for the signed-in person only.
alter table public.profiles add column if not exists overview_widgets jsonb not null default '[]'::jsonb;
