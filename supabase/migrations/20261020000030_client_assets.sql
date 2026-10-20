-- Every photo, video and design file in a client's Drive folder (raw footage, product shots, logos, past creative),
-- so briefs are written from what we actually have and a shot list asks the client for what we don't.
create table public.client_assets (
  file_id text primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  mime text not null,
  kind text not null check (kind in ('image', 'video', 'design', 'other')),
  folder text,
  url text,
  created_at timestamptz,
  seen_at timestamptz not null default now()
);
create index client_assets_client on public.client_assets (client_id, created_at desc);
alter table public.client_assets enable row level security;
create policy "staff read client assets" on public.client_assets for select to authenticated using (private.is_staff());
