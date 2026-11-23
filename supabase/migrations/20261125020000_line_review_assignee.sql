-- A flagged account in the execs' "Flagged this week" list can be put on someone else, with a due date, by an exec
-- (src/lib/stepins/flagged.ts). The seat holder stays the owner otherwise. Written by the server after the check.
alter table public.line_reviews add column if not exists assignee_id uuid references public.profiles(id);
alter table public.line_reviews add column if not exists due_on date;
