-- What clients (and the team, in shared client channels and email) said that changes the work (Nov 25 2026 safety
-- check of the OS against an exec's Claude runs): a cancellation kills the related reminders, drafts and promises and
-- creates the work it implies; a client ask with a date becomes a task with that deadline for the line owner; a hold
-- or crisis pauses automated client sends; a recurring reporting commitment becomes the owner's item each day it's due.
-- One row per message read (src/lib/client-signals.ts), so each is read once. Server-only: no policies.
create table if not exists public.client_signals (
  id uuid primary key default gen_random_uuid(),
  context_item_id uuid not null unique references public.context_items(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  said_at timestamptz not null,
  -- none | cancel | dated_request | hold | resume | recurring (the message's main one; every one is in signals)
  kind text not null default 'none',
  signals jsonb not null default '[]'::jsonb,
  -- What it did: items closed, items made
  outcome jsonb,
  created_at timestamptz not null default now()
);
create index if not exists client_signals_client_kind on public.client_signals (client_id, kind, said_at desc);
alter table public.client_signals enable row level security;
