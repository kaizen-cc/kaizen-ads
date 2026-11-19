-- The learning loop on request copy (owner, Nov 19 2026): every edit a strategist makes to the copywriter's lines and
-- every comment on them is kept here and becomes a lesson for the email copywriter (src/lib/learnings.ts, source
-- copy_feedback): about this client's brand or offer, it stays with the client; about the craft (subject lines, length,
-- the hook, the CTA), it reaches every client's copy at once, like brief corrections.
create table if not exists public.copy_feedback (
  id          uuid primary key default gen_random_uuid(),
  copy_doc_id uuid not null references public.copy_docs(id) on delete cascade,
  client_id   uuid references public.clients(id) on delete cascade,
  kind        text not null check (kind in ('comment', 'edit')),
  anchor      text,
  before      text,
  after       text,
  text        text,
  profile_id  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists copy_feedback_doc on public.copy_feedback (copy_doc_id, created_at);
alter table public.copy_feedback enable row level security;
drop policy if exists "staff read copy feedback" on public.copy_feedback;
create policy "staff read copy feedback" on public.copy_feedback for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

-- Where a copy document came from: { "kind": "request_form" | "sow", "month": "YYYY-MM-01", "priority": "...", "plan": [...] }
alter table public.copy_docs add column if not exists origin jsonb;
