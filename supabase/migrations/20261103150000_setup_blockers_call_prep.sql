alter table setup_help add column if not exists blocker text, add column if not exists blocker_detail text;
alter table client_onboarding add column if not exists blockers jsonb not null default '[]', add column if not exists call_prep jsonb;
