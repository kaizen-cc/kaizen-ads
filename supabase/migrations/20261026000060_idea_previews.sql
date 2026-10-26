-- Beside the request form: for each winner and market ad shown, why it suits this client and the gist of the brief
-- the strategist would write from it (kept a day, so reopening the form doesn't ask again)
create table if not exists public.idea_previews (
  client_id uuid not null references public.clients(id) on delete cascade,
  source_key text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (client_id, source_key)
);
alter table public.idea_previews enable row level security;
create policy "staff read idea previews" on public.idea_previews for select to authenticated using (private.staff_can_see_client(client_id));
