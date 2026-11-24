-- Undo for applying a client's feedback (Nov 24 2026): what each applied task had done to it (the Asana comment and
-- attachment ids Kaizen OS posted, the stage it was in), so the person who applied it can take it back for an hour.
alter table public.direction_change_tasks add column if not exists undo jsonb;
