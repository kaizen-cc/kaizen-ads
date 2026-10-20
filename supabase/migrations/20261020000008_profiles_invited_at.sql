-- When someone was last emailed their invite (sent by an exec from the team list)
alter table public.profiles add column if not exists invited_at timestamptz;
