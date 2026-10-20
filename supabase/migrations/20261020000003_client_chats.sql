-- The AI chat on each client page: one thread per person per client (a private soundboard), written by the server.
create table public.client_chats (
  client_id uuid not null references public.clients(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  turns jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (client_id, profile_id)
);
alter table public.client_chats enable row level security;
create policy client_chats_own on public.client_chats for select to authenticated
  using (profile_id = private.current_profile_id());
