-- Copy documents: campaign, flow and SMS copy the specialists write for the email team on a call or in the chat
-- (create_copy_doc). Read and commented on line by line in the document view (/copy/<id>), revised live, approved into
-- a Google Doc in the client's headquarters Drive folder ("Email Marketing"), then requested in Asana's Email Marketing
-- project. Every version is kept (versions), comments point at a line (anchor) and are resolved, never deleted.
--
-- Reads: the person who made it, or staff who can see the client (the access checked once per query). Writes: only the
-- server (actions check who's asking, then write with the service role). Additive and idempotent.

create table if not exists public.copy_docs (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid references public.clients (id) on delete cascade,
  created_by   uuid not null references public.profiles (id) on delete cascade,
  kind         text not null default 'campaign' check (kind in ('campaign', 'flow', 'sms')),
  title        text not null,
  -- { kind, title, shortName, emails: [{ name, subject, preview, sections, cta, designNotes, timing }], brief }
  content      jsonb not null default '{}',
  version      integer not null default 1,
  -- Earlier versions, oldest first: [{ version, content, at, by, why }]
  versions     jsonb not null default '[]',
  -- [{ id, anchor, quote, text, by, byName, at, resolved }]
  comments     jsonb not null default '[]',
  status       text not null default 'draft' check (status in ('draft', 'approved', 'requested')),
  approved_by  uuid references public.profiles (id) on delete set null,
  approved_at  timestamptz,
  doc_id       text,
  doc_url      text,
  folder_id    text,
  asana_gid    text,
  asana_url    text,
  call_id      uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists copy_docs_client on public.copy_docs (client_id, created_at desc);
create index if not exists copy_docs_mine on public.copy_docs (created_by, created_at desc);
alter table public.copy_docs enable row level security;
drop policy if exists "staff read copy docs" on public.copy_docs;
create policy "staff read copy docs" on public.copy_docs for select to authenticated
  using (created_by = (select private.current_profile_id())
    or (client_id is not null and ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false))));

-- An Asana email task made from Kaizen OS (a copy document's request) is on the Email Board mirror straight away
alter table public.email_asana_tasks add column if not exists copy_doc_id uuid references public.copy_docs (id) on delete set null;

comment on table public.copy_docs is 'Campaign, flow and SMS copy written by the specialists, reviewed line by line, approved into a Google Doc and requested in Asana';

-- The conversational deliverable flow (src/lib/deliverables): one run per call and line, its state read by every agent
-- on the call each turn (type, count, topics agreed, the writer on, the draft and its approvals, the requests made)
create table if not exists public.deliverable_runs (
  id          uuid primary key default gen_random_uuid(),
  call_id     uuid,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  line        text not null,
  client_id   uuid references public.clients (id) on delete cascade,
  state       jsonb not null default '{}',
  doc_id      uuid references public.copy_docs (id) on delete set null,
  open        boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists deliverable_runs_call on public.deliverable_runs (call_id, open, updated_at desc);
alter table public.deliverable_runs enable row level security;
drop policy if exists "own deliverable runs" on public.deliverable_runs;
create policy "own deliverable runs" on public.deliverable_runs for select to authenticated
  using (profile_id = (select private.current_profile_id()));
