-- Comments on every Overview and Today item (Nov 20 2026, the creative team): anyone the item reaches adds context
-- ("waiting on the client's answer") and everyone it reaches reads the same thread, keyed by the item's stable key
-- (src/lib/today-counts.ts stableKeyOf), so the same alert seen by different people shares one thread. A "waiting on
-- client" mark pauses that item's reminders and escalations until something new happens (a new message, a new asset,
-- or its due date passing): one place that says it's in hand, so several people don't chase the same thing.

create table if not exists public.item_threads (
  key text primary key,
  client_id uuid references public.clients(id) on delete cascade,
  title text,
  waiting_on_client boolean not null default false,
  waiting_since timestamptz,
  waiting_by uuid references public.profiles(id) on delete set null,
  -- The item's due date when it was marked: passing it ends the pause
  due_at timestamptz,
  comments int not null default 0,
  last_comment_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.item_comments (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  client_id uuid references public.clients(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null default '',
  -- comment: a note; waiting: marked waiting on the client; resumed: the pause ended (by hand or by something new)
  kind text not null default 'comment' check (kind in ('comment', 'waiting', 'resumed')),
  created_at timestamptz not null default now()
);
create index if not exists item_comments_key_idx on public.item_comments (key, created_at);
create index if not exists item_threads_waiting_idx on public.item_threads (waiting_on_client) where waiting_on_client;

alter table public.item_threads enable row level security;
alter table public.item_comments enable row level security;

-- Staff read the threads on the clients they can see (client access checked once per query); writes go through the server
drop policy if exists "staff read item threads" on public.item_threads;
create policy "staff read item threads" on public.item_threads for select to authenticated
  using ((select private.is_staff()) and (client_id is null or (select private.staff_sees_all()) or client_id = any ((select private.staff_client_ids())::uuid[])));
drop policy if exists "staff read item comments" on public.item_comments;
create policy "staff read item comments" on public.item_comments for select to authenticated
  using ((select private.is_staff()) and (client_id is null or (select private.staff_sees_all()) or client_id = any ((select private.staff_client_ids())::uuid[])));
