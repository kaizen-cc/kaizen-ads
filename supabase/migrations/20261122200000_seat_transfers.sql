-- Moving someone's accounts to someone else in one plan (a teammate leaving, changing team, out for a while): the
-- assistant finds every client seat they hold and plans each move; the Handoffs page shows them, each with the handoff
-- written for the new person, to approve, change or drop. Executives move any seat, the line heads their own line's.
-- Read and written only by the server (service role), which checks who may move what.
create table if not exists public.seat_transfers (
  id          uuid primary key default gen_random_uuid(),
  from_id     uuid references public.profiles (id) on delete set null,
  to_id       uuid references public.profiles (id) on delete set null,
  asked_by    uuid references public.profiles (id) on delete set null,
  note        text,
  status      text not null default 'open' check (status in ('open', 'done', 'dropped')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists seat_transfers_created on public.seat_transfers (created_at desc);

create table if not exists public.seat_transfer_moves (
  id           uuid primary key default gen_random_uuid(),
  transfer_id  uuid not null references public.seat_transfers (id) on delete cascade,
  client_id    uuid not null references public.clients (id) on delete cascade,
  role         text not null,
  primary_seat boolean not null default true,
  from_id      uuid references public.profiles (id) on delete set null,
  to_id        uuid references public.profiles (id) on delete set null,
  status       text not null default 'planned' check (status in ('planned', 'applying', 'applied', 'dropped', 'failed')),
  -- The handoff written for the new person before the switch (Meta buyer seats), read on the page before approving
  doc_status   text not null default 'none' check (doc_status in ('none', 'writing', 'ready', 'failed')),
  doc          jsonb,
  handoff_id   uuid references public.account_handoffs (id) on delete set null,
  error        text,
  applied_by   uuid references public.profiles (id) on delete set null,
  applied_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists seat_transfer_moves_transfer on public.seat_transfer_moves (transfer_id);
create index if not exists seat_transfer_moves_client on public.seat_transfer_moves (client_id);

alter table public.seat_transfers enable row level security;
alter table public.seat_transfer_moves enable row level security;
