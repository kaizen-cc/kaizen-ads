-- The assistant's hello mentions a broken personal connection (Slack connected for posting only, or expired) once per
-- person and problem: told_at records that it was said. Server only.
create table if not exists public.connection_notices (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  service text not null,
  state text not null,
  told_at timestamptz not null default now(),
  primary key (profile_id, service, state)
);
alter table public.connection_notices enable row level security;
