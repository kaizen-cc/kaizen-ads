-- Each client's workspace in Kaizen's Motion (matched by name; the team can correct it). Its tracked competitors are that client's.
alter table public.clients add column if not exists motion_workspace_id text;
