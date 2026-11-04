-- Audit items the team can question and verify.
-- 1. What each audit read (its numbers text), kept so the agent that wrote it can answer "why?" from the same numbers.
-- 2. The campaigns, ad sets and ads a sprint move names, with their real IDs, so it links straight to Ads Manager.
-- 3. "Why?" chats on each audit item and sprint move: team only (never clients), one thread per item.

alter table public.account_audits add column if not exists numbers text;
alter table public.business_audits add column if not exists numbers text;
alter table public.sprint_actions add column if not exists objects jsonb not null default '[]';

create table if not exists public.audit_item_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  -- account: account_audits.id · business: business_audits.id · sprint: sprint_actions.id
  audit_kind text not null check (audit_kind in ('account', 'business', 'sprint')),
  audit_id uuid not null,
  item_key text not null,
  role text not null check (role in ('person', 'agent')),
  body text not null,
  -- The agent's answer to someone who disagreed: the lesson it would learn, and when someone taught it
  lesson text,
  taught_at timestamptz,
  taught_by uuid references public.profiles(id) on delete set null,
  author_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists audit_item_messages_item_idx on public.audit_item_messages (audit_id, item_key, created_at);
create index if not exists audit_item_messages_client_idx on public.audit_item_messages (client_id, created_at desc);
alter table public.audit_item_messages enable row level security;

-- Staff who can see the client read and write its threads; clients never do
create policy "staff read audit why chats" on public.audit_item_messages for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff ask in audit why chats" on public.audit_item_messages for insert to authenticated with check (private.staff_can_see_client(client_id) and role = 'person' and author_id = private.current_profile_id());
